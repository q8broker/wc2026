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
