-- ═══ تحدي الريمونتادا v2: بلا شروط هامش + حد 40 ═══

-- 1) توسيع قيد العمود إلى 40
ALTER TABLE public.predictions DROP CONSTRAINT IF EXISTS predictions_challenge_points_check;
ALTER TABLE public.predictions ADD CONSTRAINT predictions_challenge_points_check CHECK (challenge_points BETWEEN 0 AND 40);

-- 2) إعادة بناء save_prediction: بلا فحص هامش، الحد 40، مع بقاء القفل وحدود الجوكر
DROP FUNCTION IF EXISTS public.save_prediction(integer,integer,integer,boolean,integer);

CREATE OR REPLACE FUNCTION public.save_prediction(
  p_match_id integer, p_pred_team1 integer, p_pred_team2 integer,
  p_joker boolean DEFAULT false, p_challenge integer DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_kick timestamptz; v_approved boolean; v_stage text; v_grp text; v_limit int; v_used int;
  v_flag text; v_challenge int; v_cur_ch int;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error','يجب تسجيل الدخول'); END IF;

  SELECT approved INTO v_approved FROM public.profiles WHERE id = v_uid;
  IF COALESCE(v_approved,false) = false THEN RETURN jsonb_build_object('error','حسابك غير معتمد بعد'); END IF;

  SELECT match_utc, stage INTO v_kick, v_stage FROM public.matches WHERE id = p_match_id;
  IF v_kick IS NULL THEN RETURN jsonb_build_object('error','المباراة غير موجودة'); END IF;
  IF now() >= v_kick THEN RETURN jsonb_build_object('error','انتهى وقت التوقع - المباراة بدأت'); END IF;

  IF p_pred_team1 IS NULL OR p_pred_team2 IS NULL
     OR p_pred_team1 < 0 OR p_pred_team1 > 20 OR p_pred_team2 < 0 OR p_pred_team2 > 20 THEN
    RETURN jsonb_build_object('error','نتيجة غير صحيحة (0-20)');
  END IF;

  -- حدود الجوكر (كما هي)
  IF p_joker THEN
    v_grp := CASE v_stage
               WHEN 'R32' THEN 'r32' WHEN 'R16' THEN 'r16'
               WHEN 'QF' THEN 'late' WHEN 'SF' THEN 'late' WHEN 'F' THEN 'late' WHEN 'TH' THEN 'late'
               ELSE NULL END;
    IF v_grp IS NULL THEN RETURN jsonb_build_object('error','الجوكر متاح في الأدوار الإقصائية فقط'); END IF;
    v_limit := CASE v_grp WHEN 'r32' THEN 2 ELSE 1 END;
    SELECT count(*) INTO v_used
    FROM public.predictions p JOIN public.matches m ON m.id = p.match_id
    WHERE p.user_id = v_uid AND p.is_joker = true AND p.match_id <> p_match_id
      AND CASE m.stage WHEN 'R32' THEN 'r32' WHEN 'R16' THEN 'r16'
                       WHEN 'QF' THEN 'late' WHEN 'SF' THEN 'late' WHEN 'F' THEN 'late' WHEN 'TH' THEN 'late'
                       ELSE 'x' END = v_grp;
    IF v_used >= v_limit THEN
      RETURN jsonb_build_object('error','استنفدت جوكرات هذا الدور ('||v_limit||')');
    END IF;
  END IF;

  -- التحدي: NULL = أبقِ القيمة الحالية. لا فحص هامش (بلا شروط)، فقط النطاق 1-40 وتفعيل الميزة.
  SELECT challenge_points INTO v_cur_ch FROM public.predictions WHERE user_id = v_uid AND match_id = p_match_id;
  v_challenge := COALESCE(p_challenge, v_cur_ch, 0);
  IF v_challenge < 0 OR v_challenge > 40 THEN
    RETURN jsonb_build_object('error','الريمونتادا بين 1 و 40 نقطة');
  END IF;
  IF p_challenge IS NOT NULL AND v_challenge > 0 AND v_challenge <> COALESCE(v_cur_ch,0) THEN
    SELECT value INTO v_flag FROM public.app_settings WHERE key = 'challenge_enabled';
    IF COALESCE(v_flag,'false') <> 'true' THEN
      RETURN jsonb_build_object('error','تحدي الريمونتادا غير مفعل حالياً');
    END IF;
  END IF;

  INSERT INTO public.predictions (user_id, match_id, pred_team1, pred_team2, is_joker, challenge_points)
  VALUES (v_uid, p_match_id, p_pred_team1, p_pred_team2, COALESCE(p_joker,false), v_challenge)
  ON CONFLICT (user_id, match_id)
  DO UPDATE SET pred_team1 = EXCLUDED.pred_team1, pred_team2 = EXCLUDED.pred_team2,
                is_joker = EXCLUDED.is_joker, challenge_points = EXCLUDED.challenge_points;

  RETURN jsonb_build_object('success', true);
END $fn$;


SELECT (SELECT match_utc FROM public.matches WHERE id=98) AS match98_new_utc,
       (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='predictions_challenge_points_check') AS check_def;
