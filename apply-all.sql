-- ════════════════════════════════════════════════════════════════
-- apply-all.sql — شغّل هذا الملف كاملاً مرة واحدة
-- Supabase → SQL Editor → الصق المحتوى → Run
-- يشمل: إصلاحات قاعدة البيانات + حماية السيرفر + تصحيح جدول المباريات
--        + إصلاح بيانات المصدر (الموسم) + توحيد مفاتيح الإعدادات
-- ════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════
-- إصلاحات قاعدة البيانات — تطبيق توقعات كأس العالم 2026
-- شغّل الملف كامل مرة واحدة في Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

-- ── 1) إصلاح حرج: نوع عمود ربط المباريات ─────────────────────────
-- المصدر (sportdb/flashscore) يرجع معرفات نصية مثل "lvUBR5F8"
-- والعمود الحالي integer، فكل محاولات الربط كانت تفشل بصمت.
ALTER TABLE public.matches
  ALTER COLUMN api_fixture_id TYPE text
  USING api_fixture_id::text;

-- ── 2) أمان: حذف مفتاح الـ API المكشوف ───────────────────────────
-- كان المفتاح يُقرأ من app_settings ويوصل لكل متصفح.
-- المفتاح الفعلي محفوظ في secrets الخاصة بالـ Edge Function ولا يحتاج هنا.
DELETE FROM public.app_settings WHERE key = 'api_football_key';

-- ── 3) خصوصية التوقعات: ما أحد يشوف توقعات غيره قبل الصافرة ───────
-- حالياً RLS يسمح بقراءة كل التوقعات، والإخفاء كان في الواجهة فقط —
-- يعني أي مشارك يفتح أدوات المتصفح يشوف توقعات الربع قبل المباراة.
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'predictions' AND cmd = 'SELECT'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.predictions', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "predictions_select_own_or_started"
ON public.predictions FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.id = predictions.match_id AND m.match_utc <= now()
  )
);

-- ── 4) خصوصية توقع البطل: يظهر للجميع بعد انطلاق دور الـ16 ────────
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'champion_predictions' AND cmd = 'SELECT'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.champion_predictions', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY "champ_select_own_or_locked"
ON public.champion_predictions FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.matches m
    WHERE m.stage = 'R16' AND m.match_utc <= now()
  )
);

-- ── 5) فهرس يسرّع قراءة التوقعات مع السياسة الجديدة ──────────────
CREATE INDEX IF NOT EXISTS idx_predictions_match_id ON public.predictions (match_id);
CREATE INDEX IF NOT EXISTS idx_matches_api_fixture ON public.matches (api_fixture_id);

-- ── تحقق سريع بعد التشغيل ────────────────────────────────────────
-- A) نوع العمود لازم يطلع text:
SELECT data_type FROM information_schema.columns
WHERE table_name = 'matches' AND column_name = 'api_fixture_id';

-- B) السياسات الجديدة:
SELECT tablename, policyname, cmd FROM pg_policies
WHERE tablename IN ('predictions', 'champion_predictions')
ORDER BY tablename;

-- ════════════════════════════════════════════════════════════════
-- settings-security.sql — السيرفر خط الدفاع الأخير
-- شغّله كامل في Supabase → SQL Editor (بعد fixes.sql)
-- ════════════════════════════════════════════════════════════════

-- ── 1) إعدادات الانتساب (يتحكم بها الأدمن من التطبيق) ────────────
INSERT INTO public.app_settings (key, value, label) VALUES
  ('registration_open', 'true',  'تفعيل التسجيل'),
  ('auto_approve',      'false', 'الانتساب التلقائي')
ON CONFLICT (key) DO NOTHING;

-- ── 2) فرض إعدادات التسجيل عند إنشاء أي بروفايل ──────────────────
-- يرفض الإنشاء لو التسجيل معطل، ويعتمد العضو تلقائياً لو القبول التلقائي مفعّل.
-- يعمل مهما كانت طريقة الإنشاء (من الواجهة أو من trigger على auth.users).
CREATE OR REPLACE FUNCTION public.enforce_registration()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  reg_open text;
  auto_ok  text;
BEGIN
  SELECT value INTO reg_open FROM public.app_settings WHERE key = 'registration_open';
  SELECT value INTO auto_ok  FROM public.app_settings WHERE key = 'auto_approve';

  IF COALESCE(reg_open, 'true') = 'false' THEN
    RAISE EXCEPTION 'التسجيل مغلق حالياً' USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(auto_ok, 'false') = 'true' THEN
    NEW.approved := true;
  ELSE
    NEW.approved := COALESCE(NEW.approved, false);
  END IF;

  NEW.is_admin := COALESCE(NEW.is_admin, false); -- لا أحد يسجل نفسه أدمن
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_registration ON public.profiles;
CREATE TRIGGER trg_enforce_registration
BEFORE INSERT ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.enforce_registration();

-- ── 3) قفل التوقعات عند صافرة البداية — داخل الدالة نفسها ─────────
-- نسخة محصّنة من save_prediction: تتحقق من العضوية والاعتماد والوقت والقيم.
-- الدالة القديمة بنوع إرجاع مختلف، لذا تُحذف أولاً (سبب خطأ 42P13 السابق)
DROP FUNCTION IF EXISTS public.save_prediction(integer, integer, integer);
CREATE OR REPLACE FUNCTION public.save_prediction(
  p_match_id integer, p_pred_team1 integer, p_pred_team2 integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_kick timestamptz;
  v_approved boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'يجب تسجيل الدخول');
  END IF;

  SELECT approved INTO v_approved FROM public.profiles WHERE id = v_uid;
  IF COALESCE(v_approved, false) = false THEN
    RETURN jsonb_build_object('error', 'حسابك غير معتمد بعد');
  END IF;

  SELECT match_utc INTO v_kick FROM public.matches WHERE id = p_match_id;
  IF v_kick IS NULL THEN
    RETURN jsonb_build_object('error', 'المباراة غير موجودة');
  END IF;
  IF now() >= v_kick THEN
    RETURN jsonb_build_object('error', 'انتهى وقت التوقع — المباراة بدأت');
  END IF;

  IF p_pred_team1 IS NULL OR p_pred_team2 IS NULL
     OR p_pred_team1 < 0 OR p_pred_team1 > 20
     OR p_pred_team2 < 0 OR p_pred_team2 > 20 THEN
    RETURN jsonb_build_object('error', 'نتيجة غير صالحة (0-20)');
  END IF;

  INSERT INTO public.predictions (user_id, match_id, pred_team1, pred_team2)
  VALUES (v_uid, p_match_id, p_pred_team1, p_pred_team2)
  ON CONFLICT (user_id, match_id)
  DO UPDATE SET pred_team1 = EXCLUDED.pred_team1, pred_team2 = EXCLUDED.pred_team2;

  RETURN jsonb_build_object('success', true);
END $$;

-- حزام إضافي: حتى الكتابة المباشرة على الجدول (متجاوزة الدالة) تُرفض بعد الصافرة
CREATE OR REPLACE FUNCTION public.block_late_predictions()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_kick timestamptz;
BEGIN
  SELECT match_utc INTO v_kick FROM public.matches WHERE id = NEW.match_id;
  IF v_kick IS NOT NULL AND now() >= v_kick THEN
    RAISE EXCEPTION 'انتهى وقت التوقع — المباراة بدأت' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_block_late_predictions ON public.predictions;
CREATE TRIGGER trg_block_late_predictions
BEFORE INSERT OR UPDATE OF pred_team1, pred_team2 ON public.predictions
FOR EACH ROW EXECUTE FUNCTION public.block_late_predictions();

-- ── 4) قفل توقع البطل قبل صافرة أول مباراة في دور الـ16 ──────────
CREATE OR REPLACE FUNCTION public.block_late_champion()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_lock timestamptz;
BEGIN
  SELECT min(match_utc) INTO v_lock FROM public.matches WHERE stage = 'R16';
  v_lock := COALESCE(v_lock, '2026-07-04T17:00:00Z'::timestamptz);
  IF now() >= v_lock THEN
    RAISE EXCEPTION 'انتهى وقت اختيار البطل — بدأ دور الـ16' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_block_late_champion ON public.champion_predictions;
CREATE TRIGGER trg_block_late_champion
BEFORE INSERT OR UPDATE OF team_id ON public.champion_predictions
FOR EACH ROW EXECUTE FUNCTION public.block_late_champion();

-- ── تحقق سريع ─────────────────────────────────────────────────────
SELECT key, value FROM public.app_settings WHERE key IN ('registration_open','auto_approve');
SELECT trigger_name, event_object_table FROM information_schema.triggers
WHERE trigger_name LIKE 'trg_%' ORDER BY event_object_table;

-- ════════════════════════════════════════════════════════════════
-- ── 6) توحيد مفاتيح الإعدادات (كانت بأسماء قديمة) ────────────────
-- ينقل قيمة registration_enabled القديمة إلى registration_open الجديدة
UPDATE public.app_settings
SET value = COALESCE((SELECT value FROM public.app_settings WHERE key='registration_enabled'), value)
WHERE key = 'registration_open';
DELETE FROM public.app_settings WHERE key IN ('registration_enabled','membership_requests_enabled');

-- ── 7) إصلاح حرج: المصدر يكتب قيمة موسم خاطئة (0..71) لمباريات 2026
--       فلا يجدها الاستعلام ولا تعمل المزامنة ولا النتائج المباشرة.
--       نصحح الموجود ونضيف trigger يمنع تكرارها مع كل تحديث دوري.
UPDATE public.football_fixture_cache
SET season = 2026
WHERE kickoff_at >= '2026-06-11' AND kickoff_at < '2026-07-20' AND (season IS NULL OR season < 1900);

CREATE OR REPLACE FUNCTION public.fix_fixture_season()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kickoff_at >= '2026-06-11' AND NEW.kickoff_at < '2026-07-20'
     AND (NEW.season IS NULL OR NEW.season < 1900) THEN
    NEW.season := 2026;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_fix_fixture_season ON public.football_fixture_cache;
CREATE TRIGGER trg_fix_fixture_season
BEFORE INSERT OR UPDATE ON public.football_fixture_cache
FOR EACH ROW EXECUTE FUNCTION public.fix_fixture_season();

-- ── 8) تصحيح جدول مباريات المجموعات حسب المصدر الرسمي ────────────
--       (30 مباراة بتوقيت خاطئ + 7 مباريات ناقصة)
-- ── تصحيح توقيتات المباريات من المصدر الرسمي ──
UPDATE public.matches SET match_utc='2026-06-28T02:00:00+00:00' WHERE stage='group' AND ((team1_id='alg' AND team2_id='aut') OR (team1_id='aut' AND team2_id='alg'));
UPDATE public.matches SET match_utc='2026-06-23T03:00:00+00:00' WHERE stage='group' AND ((team1_id='alg' AND team2_id='jor') OR (team1_id='jor' AND team2_id='alg'));
UPDATE public.matches SET match_utc='2026-06-28T02:00:00+00:00' WHERE stage='group' AND ((team1_id='arg' AND team2_id='jor') OR (team1_id='jor' AND team2_id='arg'));
UPDATE public.matches SET match_utc='2026-06-19T19:00:00+00:00' WHERE stage='group' AND ((team1_id='aus' AND team2_id='usa') OR (team1_id='usa' AND team2_id='aus'));
UPDATE public.matches SET match_utc='2026-06-12T19:00:00+00:00' WHERE stage='group' AND ((team1_id='bih' AND team2_id='can') OR (team1_id='can' AND team2_id='bih'));
UPDATE public.matches SET match_utc='2026-06-24T19:00:00+00:00' WHERE stage='group' AND ((team1_id='bih' AND team2_id='qat') OR (team1_id='qat' AND team2_id='bih'));
UPDATE public.matches SET match_utc='2026-06-18T19:00:00+00:00' WHERE stage='group' AND ((team1_id='bih' AND team2_id='sui') OR (team1_id='sui' AND team2_id='bih'));
UPDATE public.matches SET match_utc='2026-06-20T00:30:00+00:00' WHERE stage='group' AND ((team1_id='bra' AND team2_id='hai') OR (team1_id='hai' AND team2_id='bra'));
UPDATE public.matches SET match_utc='2026-06-24T22:00:00+00:00' WHERE stage='group' AND ((team1_id='bra' AND team2_id='sco') OR (team1_id='sco' AND team2_id='bra'));
UPDATE public.matches SET match_utc='2026-06-18T22:00:00+00:00' WHERE stage='group' AND ((team1_id='can' AND team2_id='qat') OR (team1_id='qat' AND team2_id='can'));
UPDATE public.matches SET match_utc='2026-06-24T19:00:00+00:00' WHERE stage='group' AND ((team1_id='can' AND team2_id='sui') OR (team1_id='sui' AND team2_id='can'));
UPDATE public.matches SET match_utc='2026-06-24T02:00:00+00:00' WHERE stage='group' AND ((team1_id='col' AND team2_id='cod') OR (team1_id='cod' AND team2_id='col'));
UPDATE public.matches SET match_utc='2026-06-27T23:30:00+00:00' WHERE stage='group' AND ((team1_id='col' AND team2_id='por') OR (team1_id='por' AND team2_id='col'));
UPDATE public.matches SET match_utc='2026-06-17T20:00:00+00:00' WHERE stage='group' AND ((team1_id='cro' AND team2_id='eng') OR (team1_id='eng' AND team2_id='cro'));
UPDATE public.matches SET match_utc='2026-06-27T21:00:00+00:00' WHERE stage='group' AND ((team1_id='cro' AND team2_id='gha') OR (team1_id='gha' AND team2_id='cro'));
UPDATE public.matches SET match_utc='2026-06-25T01:00:00+00:00' WHERE stage='group' AND ((team1_id='cze' AND team2_id='mex') OR (team1_id='mex' AND team2_id='cze'));
UPDATE public.matches SET match_utc='2026-06-17T17:00:00+00:00' WHERE stage='group' AND ((team1_id='cod' AND team2_id='por') OR (team1_id='por' AND team2_id='cod'));
UPDATE public.matches SET match_utc='2026-06-27T23:30:00+00:00' WHERE stage='group' AND ((team1_id='cod' AND team2_id='uzb') OR (team1_id='uzb' AND team2_id='cod'));
UPDATE public.matches SET match_utc='2026-06-23T20:00:00+00:00' WHERE stage='group' AND ((team1_id='eng' AND team2_id='gha') OR (team1_id='gha' AND team2_id='eng'));
UPDATE public.matches SET match_utc='2026-06-27T21:00:00+00:00' WHERE stage='group' AND ((team1_id='eng' AND team2_id='pan') OR (team1_id='pan' AND team2_id='eng'));
UPDATE public.matches SET match_utc='2026-06-17T23:00:00+00:00' WHERE stage='group' AND ((team1_id='gha' AND team2_id='pan') OR (team1_id='pan' AND team2_id='gha'));
UPDATE public.matches SET match_utc='2026-06-21T04:00:00+00:00' WHERE stage='group' AND ((team1_id='jpn' AND team2_id='tun') OR (team1_id='tun' AND team2_id='jpn'));
UPDATE public.matches SET match_utc='2026-06-19T01:00:00+00:00' WHERE stage='group' AND ((team1_id='mex' AND team2_id='kor') OR (team1_id='kor' AND team2_id='mex'));
UPDATE public.matches SET match_utc='2026-06-20T17:00:00+00:00' WHERE stage='group' AND ((team1_id='ned' AND team2_id='swe') OR (team1_id='swe' AND team2_id='ned'));
UPDATE public.matches SET match_utc='2026-06-20T03:00:00+00:00' WHERE stage='group' AND ((team1_id='par' AND team2_id='tur') OR (team1_id='tur' AND team2_id='par'));
UPDATE public.matches SET match_utc='2026-06-13T01:00:00+00:00' WHERE stage='group' AND ((team1_id='par' AND team2_id='usa') OR (team1_id='usa' AND team2_id='par'));
UPDATE public.matches SET match_utc='2026-06-23T17:00:00+00:00' WHERE stage='group' AND ((team1_id='por' AND team2_id='uzb') OR (team1_id='uzb' AND team2_id='por'));
UPDATE public.matches SET match_utc='2026-06-13T19:00:00+00:00' WHERE stage='group' AND ((team1_id='qat' AND team2_id='sui') OR (team1_id='sui' AND team2_id='qat'));
UPDATE public.matches SET match_utc='2026-06-25T01:00:00+00:00' WHERE stage='group' AND ((team1_id='rsa' AND team2_id='kor') OR (team1_id='kor' AND team2_id='rsa'));
UPDATE public.matches SET match_utc='2026-06-26T02:00:00+00:00' WHERE stage='group' AND ((team1_id='tur' AND team2_id='usa') OR (team1_id='usa' AND team2_id='tur'));

-- ── إضافة المباريات الناقصة (7 مباريات) ──
INSERT INTO public.matches (id, group_id, team1_id, team2_id, match_utc, status, stage) SELECT (SELECT COALESCE(MAX(id),0)+1 FROM public.matches), 'D', 'par', 'aus', '2026-06-26T02:00:00+00:00', 'upcoming', 'group' WHERE NOT EXISTS (SELECT 1 FROM public.matches WHERE stage='group' AND ((team1_id='par' AND team2_id='aus') OR (team1_id='aus' AND team2_id='par')));
INSERT INTO public.matches (id, group_id, team1_id, team2_id, match_utc, status, stage) SELECT (SELECT COALESCE(MAX(id),0)+1 FROM public.matches), 'L', 'pan', 'cro', '2026-06-23T23:00:00+00:00', 'upcoming', 'group' WHERE NOT EXISTS (SELECT 1 FROM public.matches WHERE stage='group' AND ((team1_id='pan' AND team2_id='cro') OR (team1_id='cro' AND team2_id='pan')));
INSERT INTO public.matches (id, group_id, team1_id, team2_id, match_utc, status, stage) SELECT (SELECT COALESCE(MAX(id),0)+1 FROM public.matches), 'E', 'ecu', 'cur', '2026-06-21T00:00:00+00:00', 'upcoming', 'group' WHERE NOT EXISTS (SELECT 1 FROM public.matches WHERE stage='group' AND ((team1_id='ecu' AND team2_id='cur') OR (team1_id='cur' AND team2_id='ecu')));
INSERT INTO public.matches (id, group_id, team1_id, team2_id, match_utc, status, stage) SELECT (SELECT COALESCE(MAX(id),0)+1 FROM public.matches), 'E', 'cur', 'civ', '2026-06-25T20:00:00+00:00', 'upcoming', 'group' WHERE NOT EXISTS (SELECT 1 FROM public.matches WHERE stage='group' AND ((team1_id='cur' AND team2_id='civ') OR (team1_id='civ' AND team2_id='cur')));
INSERT INTO public.matches (id, group_id, team1_id, team2_id, match_utc, status, stage) SELECT (SELECT COALESCE(MAX(id),0)+1 FROM public.matches), 'A', 'kor', 'cze', '2026-06-12T02:00:00+00:00', 'upcoming', 'group' WHERE NOT EXISTS (SELECT 1 FROM public.matches WHERE stage='group' AND ((team1_id='kor' AND team2_id='cze') OR (team1_id='cze' AND team2_id='kor')));
INSERT INTO public.matches (id, group_id, team1_id, team2_id, match_utc, status, stage) SELECT (SELECT COALESCE(MAX(id),0)+1 FROM public.matches), 'E', 'ecu', 'ger', '2026-06-25T20:00:00+00:00', 'upcoming', 'group' WHERE NOT EXISTS (SELECT 1 FROM public.matches WHERE stage='group' AND ((team1_id='ecu' AND team2_id='ger') OR (team1_id='ger' AND team2_id='ecu')));
INSERT INTO public.matches (id, group_id, team1_id, team2_id, match_utc, status, stage) SELECT (SELECT COALESCE(MAX(id),0)+1 FROM public.matches), 'E', 'ger', 'civ', '2026-06-20T20:00:00+00:00', 'upcoming', 'group' WHERE NOT EXISTS (SELECT 1 FROM public.matches WHERE stage='group' AND ((team1_id='ger' AND team2_id='civ') OR (team1_id='civ' AND team2_id='ger')));

-- ── 9) تحقق نهائي ────────────────────────────────────────────────
SELECT 'مباريات المجموعات' AS فحص, count(*)::text AS النتيجة FROM public.matches WHERE stage='group'
UNION ALL
SELECT 'مباريات 2026 في الكاش', count(*)::text FROM public.football_fixture_cache WHERE season=2026
UNION ALL
SELECT 'registration_open', value FROM public.app_settings WHERE key='registration_open'
UNION ALL
SELECT 'auto_approve', value FROM public.app_settings WHERE key='auto_approve';
