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
