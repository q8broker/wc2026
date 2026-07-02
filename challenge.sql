-- ═══ ميزة التحدي: save_prediction v3 (5 وسائط) + leaderboard + trigger ═══

DROP FUNCTION IF EXISTS public.save_prediction(integer,integer,integer,boolean);

CREATE OR REPLACE FUNCTION public.save_prediction(
  p_match_id integer, p_pred_team1 integer, p_pred_team2 integer,
  p_joker boolean DEFAULT false, p_challenge integer DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_kick timestamptz; v_approved boolean; v_stage text; v_grp text; v_limit int; v_used int;
  v_flag text; v_pts int; v_pending int; v_avail int; v_challenge int; v_cur_ch int;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error','يجب تسجيل الدخول'); END IF;

  -- قفل استشاري لكل مستخدم: يمنع طلبين متزامنين من تجاوز هامش التحدي معاً
  PERFORM pg_advisory_xact_lock(hashtext(v_uid::text));

  SELECT approved INTO v_approved FROM public.profiles WHERE id = v_uid;
  IF COALESCE(v_approved,false) = false THEN RETURN jsonb_build_object('error','حسابك غير معتمد بعد'); END IF;

  SELECT match_utc, stage INTO v_kick, v_stage FROM public.matches WHERE id = p_match_id;
  IF v_kick IS NULL THEN RETURN jsonb_build_object('error','المباراة غير موجودة'); END IF;
  IF now() >= v_kick THEN RETURN jsonb_build_object('error','انتهى وقت التوقع - المباراة بدأت'); END IF;

  IF p_pred_team1 IS NULL OR p_pred_team2 IS NULL
     OR p_pred_team1 < 0 OR p_pred_team1 > 20 OR p_pred_team2 < 0 OR p_pred_team2 > 20 THEN
    RETURN jsonb_build_object('error','نتيجة غير صحيحة (0-20)');
  END IF;

  -- حدود الجوكر: إقصائيات فقط + سقف كل مجموعة أدوار (كما هي)
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

  -- التحدي: NULL = أبقِ القيمة الحالية كما هي (حماية من مسح غير مقصود من عملاء قدامى)
  SELECT challenge_points INTO v_cur_ch FROM public.predictions WHERE user_id = v_uid AND match_id = p_match_id;
  v_challenge := COALESCE(p_challenge, v_cur_ch, 0);
  IF v_challenge < 0 OR v_challenge > 20 THEN
    RETURN jsonb_build_object('error','التحدي بين 1 و 20 نقطة');
  END IF;

  -- الفحوص تُطبق فقط عند تغيير قيمة التحدي إلى قيمة موجبة (القيمة المحفوظة أُجيزت عند وضعها)
  IF p_challenge IS NOT NULL AND v_challenge > 0 AND v_challenge <> COALESCE(v_cur_ch,0) THEN
    SELECT value INTO v_flag FROM public.app_settings WHERE key = 'challenge_enabled';
    IF COALESCE(v_flag,'false') <> 'true' THEN
      RETURN jsonb_build_object('error','التحدي غير مفعل حالياً');
    END IF;

    -- نقاط المستخدم الحالية (نفس فورمولا leaderboard: أساس × جوكر + أثر التحدي للمباريات المنتهية)
    SELECT COALESCE(SUM(
      CASE WHEN m.status = 'finished' AND m.result_team1 IS NOT NULL THEN
        (CASE WHEN p.pred_team1 = m.result_team1 AND p.pred_team2 = m.result_team2 THEN 3
              WHEN (p.pred_team1 > p.pred_team2 AND m.result_team1 > m.result_team2)
                OR (p.pred_team1 < p.pred_team2 AND m.result_team1 < m.result_team2)
                OR (p.pred_team1 = p.pred_team2 AND m.result_team1 = m.result_team2) THEN 1
              ELSE 0 END) * (CASE WHEN p.is_joker THEN 2 ELSE 1 END)
        + (CASE WHEN p.pred_team1 = m.result_team1 AND p.pred_team2 = m.result_team2 THEN p.challenge_points
                WHEN (p.pred_team1 > p.pred_team2 AND m.result_team1 > m.result_team2)
                  OR (p.pred_team1 < p.pred_team2 AND m.result_team1 < m.result_team2)
                  OR (p.pred_team1 = p.pred_team2 AND m.result_team1 = m.result_team2) THEN 0
                ELSE -p.challenge_points END)
      ELSE 0 END), 0)::int
    INTO v_pts
    FROM public.predictions p JOIN public.matches m ON m.id = p.match_id
    WHERE p.user_id = v_uid;

    -- مكافأة البطل إن تحققت (نفس leaderboard)
    v_pts := v_pts + COALESCE((
      SELECT 15 FROM public.champion_predictions cp
      JOIN public.app_settings cw ON cw.key = 'champion_winner' AND cw.value <> '' AND cw.value = cp.team_id
      WHERE cp.user_id = v_uid LIMIT 1), 0);

    -- التحديات المعلقة على مباريات أخرى لم تنتهِ
    SELECT COALESCE(SUM(p.challenge_points),0)::int INTO v_pending
    FROM public.predictions p JOIN public.matches m ON m.id = p.match_id
    WHERE p.user_id = v_uid AND p.match_id <> p_match_id AND m.status <> 'finished';

    v_avail := LEAST(20, v_pts - 3 - v_pending);
    IF v_challenge > v_avail THEN
      RETURN jsonb_build_object('error','تجاوزت حد التحدي — المتاح لك الآن: '||GREATEST(v_avail,0)||' نقطة');
    END IF;
  END IF;

  INSERT INTO public.predictions (user_id, match_id, pred_team1, pred_team2, is_joker, challenge_points)
  VALUES (v_uid, p_match_id, p_pred_team1, p_pred_team2, COALESCE(p_joker,false), v_challenge)
  ON CONFLICT (user_id, match_id)
  DO UPDATE SET pred_team1 = EXCLUDED.pred_team1, pred_team2 = EXCLUDED.pred_team2,
                is_joker = EXCLUDED.is_joker, challenge_points = EXCLUDED.challenge_points;

  RETURN jsonb_build_object('success', true);
END $fn$;

-- ═══ leaderboard: إضافة أثر التحدي (+تحدي للمطابقة، -تحدي للخطأ، لا شيء للاتجاه الصحيح) ═══
CREATE OR REPLACE FUNCTION public.leaderboard()
RETURNS TABLE(user_id uuid, display_name text, username text, points integer, pred_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  WITH mp AS (
    SELECT p.user_id,
      (CASE WHEN m.status = 'finished' AND m.result_team1 IS NOT NULL THEN
        (CASE WHEN p.pred_team1 = m.result_team1 AND p.pred_team2 = m.result_team2 THEN 3
              WHEN (p.pred_team1 > p.pred_team2 AND m.result_team1 > m.result_team2)
                OR (p.pred_team1 < p.pred_team2 AND m.result_team1 < m.result_team2)
                OR (p.pred_team1 = p.pred_team2 AND m.result_team1 = m.result_team2) THEN 1
              ELSE 0 END) * (CASE WHEN p.is_joker THEN 2 ELSE 1 END)
        + (CASE WHEN p.pred_team1 = m.result_team1 AND p.pred_team2 = m.result_team2 THEN p.challenge_points
                WHEN (p.pred_team1 > p.pred_team2 AND m.result_team1 > m.result_team2)
                  OR (p.pred_team1 < p.pred_team2 AND m.result_team1 < m.result_team2)
                  OR (p.pred_team1 = p.pred_team2 AND m.result_team1 = m.result_team2) THEN 0
                ELSE -p.challenge_points END)
      ELSE 0 END) AS pts
    FROM public.predictions p JOIN public.matches m ON m.id = p.match_id
  ),
  agg AS (SELECT mp.user_id, COALESCE(SUM(pts),0)::int AS match_points, COUNT(*)::int AS preds FROM mp GROUP BY mp.user_id),
  champ AS (
    SELECT cp.user_id,
      CASE WHEN cw.value IS NOT NULL AND cw.value <> '' AND cp.team_id = cw.value THEN 15 ELSE 0 END AS bonus
    FROM public.champion_predictions cp
    LEFT JOIN (SELECT value FROM public.app_settings WHERE key='champion_winner') cw ON true
  )
  SELECT pr.id, pr.display_name, pr.username,
         (COALESCE(a.match_points,0) + COALESCE(c.bonus,0))::int,
         COALESCE(a.preds,0)::int
  FROM public.profiles pr
  LEFT JOIN agg a ON a.user_id = pr.id
  LEFT JOIN champ c ON c.user_id = pr.id
  WHERE pr.approved = true
  ORDER BY 4 DESC;
$fn$;

-- ═══ التريغر: يشمل challenge_points (منع أي تغيير بعد الصافرة) ═══
DROP TRIGGER IF EXISTS trg_block_late_predictions ON public.predictions;
CREATE TRIGGER trg_block_late_predictions
  BEFORE INSERT OR UPDATE OF pred_team1, pred_team2, is_joker, challenge_points
  ON public.predictions
  FOR EACH ROW EXECUTE FUNCTION public.block_late_predictions();
