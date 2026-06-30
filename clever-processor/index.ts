import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type AnyRow = Record<string, any>;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function firstJsonSecret(envName: string) {
  const raw = Deno.env.get(envName);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    const value = Object.values(parsed).find((item) => typeof item === "string");
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ?? firstJsonSecret("SUPABASE_SECRET_KEYS");
const provider = Deno.env.get("FOOTBALL_PROVIDER") ?? "sportdb";
const baseUrl = Deno.env.get("FOOTBALL_BASE_URL") ?? "https://api.sportdb.dev";
const apiKey = Deno.env.get("FOOTBALL_API_KEY") ?? "";
const apiHeader = Deno.env.get("FOOTBALL_PROVIDER_HEADER") ?? "X-API-Key";
const leagueId = Deno.env.get("FOOTBALL_LEAGUE_ID") ?? "world:8/world-championship:lvUBR5F8";
const season = Number(Deno.env.get("FOOTBALL_SEASON") ?? "2026");
const tournamentStart = Deno.env.get("FOOTBALL_TOURNAMENT_START") ?? "2026-06-11";
const tournamentEnd = Deno.env.get("FOOTBALL_TOURNAMENT_END") ?? "2026-07-19";
const staleMinutes = Number(Deno.env.get("FOOTBALL_STALE_MINUTES") ?? "15");
const fullRefreshHours = Number(Deno.env.get("FOOTBALL_FULL_REFRESH_HOURS") ?? "24");
const TEAM_NAME_MAP: Record<string, string> = {
  mex: "Mexico", rsa: "South Africa", kor: "South Korea", cze: "Czech Republic",
  can: "Canada", bih: "Bosnia", qat: "Qatar", sui: "Switzerland",
  bra: "Brazil", mar: "Morocco", sco: "Scotland", hai: "Haiti",
  usa: "USA", par: "Paraguay", aus: "Australia", tur: "Turkey",
  ger: "Germany", cur: "Curacao", civ: "Ivory Coast", ecu: "Ecuador",
  ned: "Netherlands", jpn: "Japan", swe: "Sweden", tun: "Tunisia",
  bel: "Belgium", egy: "Egypt", irn: "Iran", nzl: "New Zealand",
  esp: "Spain", cpv: "Cape Verde", ksa: "Saudi Arabia", uru: "Uruguay",
  fra: "France", sen: "Senegal", nor: "Norway", irq: "Iraq",
  arg: "Argentina", alg: "Algeria", aut: "Austria", jor: "Jordan",
  por: "Portugal", col: "Colombia", uzb: "Uzbekistan", cod: "D.R. Congo",
  eng: "England", cro: "Croatia", gha: "Ghana", pan: "Panama",
};

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

/* ── ميزانية الطلبات اليومية (الباقة 100 طلب/يوم) ──────────────
   حد آمن 90، وآخر 15 طلب محجوزة للنتائج المباشرة فقط حتى لو
   استهلكت التفاصيل (إحصائيات/تشكيلات) نصيبها. */
const dailyBudget = Number(Deno.env.get("FOOTBALL_DAILY_BUDGET") ?? "96");
const liveReserve = Number(Deno.env.get("FOOTBALL_LIVE_RESERVE") ?? "15");

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getBudgetUsed() {
  const { data } = await supabase
    .from("football_sync_state")
    .select("value")
    .eq("key", `${provider}:budget`)
    .maybeSingle();
  const v = (data?.value ?? {}) as AnyRow;
  return v.day === todayKey() ? Number(v.used ?? 0) : 0;
}

async function spendOne(essential = false) {
  const limit = essential ? dailyBudget : dailyBudget - liveReserve;
  // صرف ذرّي: القاعدة تزيد العداد فقط إذا كان تحت الحد (يمنع التجاوز مهما تزامن العدد)
  try {
    const { data, error } = await supabase.rpc("try_spend", {
      p_key: `${provider}:budget`, p_day: todayKey(), p_limit: limit,
    });
    if (error) throw error;
    if (data !== true) throw new Error("BUDGET_EXCEEDED");
    return;
  } catch (e) {
    if (e instanceof Error && e.message === "BUDGET_EXCEEDED") throw e;
    // احتياط: لو تعذّر استدعاء الدالة لأي سبب، نرجع للطريقة القديمة حتى لا يتعطل كل شيء
    const used = await getBudgetUsed();
    if (used >= limit) throw new Error("BUDGET_EXCEEDED");
    await supabase.from("football_sync_state").upsert({
      key: `${provider}:budget`,
      value: { day: todayKey(), used: used + 1 },
      updated_at: new Date().toISOString(),
    });
  }
}

/* قفل ذرّي: يطالب بفتحة التحديث لحقل معيّن. يرجع true لمتقدّم واحد فقط.
   p_minutes=0 يعني مطالبة قسرية (تنجح دائماً وتحدّث الطابع). احتياط عند الفشل: isStale. */
async function claimSync(key: string, field: string, minutes: number, fallbackLast?: string | null) {
  try {
    const { data, error } = await supabase.rpc("claim_sync", {
      p_key: key, p_field: field, p_minutes: minutes,
    });
    if (error) throw error;
    return data === true;
  } catch (_e) {
    return isStale(fallbackLast, minutes); // شبكة أمان لو الدالة غير متاحة
  }
}

/* هل توجد مباراة الآن أو على وشك البدء؟ (نافذة: 30 دقيقة قبل → 160 دقيقة بعد الانطلاق) */
async function hasMatchWindow() {
  const now = Date.now();
  const from = new Date(now - 160 * 60_000).toISOString();
  const to = new Date(now + 30 * 60_000).toISOString();
  const { count, error } = await supabase
    .from("matches")
    .select("id", { count: "exact", head: true })
    .gte("match_utc", from)
    .lte("match_utc", to);
  if (error) return true; // عند الشك لا نوقف النتائج المباشرة
  return Number(count ?? 0) > 0;
}

/* اللحاق: مباراة انتهى وقتها (خلال آخر 24 ساعة) ونتيجتها لسا مو موثقة FT في الكاش.
   تغطي حالة: ماحد فتح التطبيق أثناء المباراة — أول مستخدم يدخل بعدها يجلب النتيجة. */
async function pendingPastFixtures() {
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60_000).toISOString();
  const cutoff = new Date(now - 115 * 60_000).toISOString();
  const { count, error } = await supabase
    .from("football_fixture_cache")
    .select("api_fixture_id", { count: "exact", head: true })
    .eq("provider", provider)
    .eq("season", season)
    .gte("kickoff_at", dayAgo)
    .lte("kickoff_at", cutoff)
    .not("status_short", "in", "(FT,CANC,PST)");
  if (error) return false;
  return Number(count ?? 0) > 0;
}

function send(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function parseEndpoint(endpoint: string) {
  const url = new URL(endpoint, "https://local.app");
  return { path: url.pathname, params: url.searchParams };
}

function isStale(value?: string | null, minutes = staleMinutes) {
  if (!value) return true;
  return Date.now() - new Date(value).getTime() > minutes * 60_000;
}

function staticImage(value?: string | null) {
  if (!value) return null;
  return value.startsWith("http") ? value : `https://static.flashscore.com/res/image/data/${value}`;
}

function stageShort(stage?: string | null) {
  const value = String(stage ?? "").toUpperCase();
  if (["FINISHED", "AFTER PEN.", "AFTER ET"].includes(value)) return "FT";
  if (value.includes("HALF")) return "HT";
  if (value.includes("LIVE") || value.includes("INPLAY")) return "LIVE";
  if (value.includes("POSTPONED")) return "PST";
  if (value.includes("CANCEL")) return "CANC";
  return "NS";
}

function safeNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeFixture(item: AnyRow, fixtureSeason: number | string = season) {
  const id = String(item.eventId ?? item.id ?? item.matchId ?? "");
  const homeId = String(item.homeParticipantIds ?? item.homeEventParticipantId ?? item.home?.id ?? "");
  const awayId = String(item.awayParticipantIds ?? item.awayEventParticipantId ?? item.away?.id ?? "");
  const status = stageShort(item.eventStage ?? item.statusName ?? item.status);
  const kickoff = item.startDateTimeUtc
    ? new Date(item.startDateTimeUtc).toISOString()
    : item.startUtime || item.startTime
      ? new Date(Number(item.startUtime ?? item.startTime) * 1000).toISOString()
      : null;

  // المصدر أحياناً يرجع item.season كرقم تسلسلي (0..71) وليس سنة — نتجاهل أي قيمة ليست سنة فعلية
  const rawSeason = safeNumber(item.season ?? item.tournamentSeason ?? item.tournament?.season);
  const resolvedSeason = String(fixtureSeason) !== String(season)
    ? fixtureSeason
    : (rawSeason != null && rawSeason >= 1900 ? rawSeason : fixtureSeason);
  return {
    provider,
    api_fixture_id: id,
    league_id: leagueId,
    season: resolvedSeason,
    kickoff_at: kickoff,
    status_short: status,
    status_long: item.eventStage ?? status,
    elapsed: safeNumber(item.gameTime && Number(item.gameTime) >= 0 ? item.gameTime : null),
    home_team_id: homeId || null,
    away_team_id: awayId || null,
    home_name: item.homeName ?? item.homeFirstName ?? null,
    away_name: item.awayName ?? item.awayFirstName ?? null,
    score: {
      home: safeNumber(item.homeScore),
      away: safeNumber(item.awayScore),
      homeFullTime: safeNumber(item.homeFullTimeScore),
      awayFullTime: safeNumber(item.awayFullTimeScore),
      winner: item.winner ?? null,
    },
    fixture: item,
    last_seen_at: new Date().toISOString(),
    last_fixture_sync_at: new Date().toISOString(),
    details_finalized: status === "FT",
  };
}

function isTournamentWindow(row: AnyRow) {
  const date = String(row.kickoff_at ?? "").slice(0, 10);
  return Boolean(date) && date >= tournamentStart && date <= tournamentEnd;
}

function toApiFootball(row: AnyRow) {
  const raw = row.fixture ?? {};
  const score = row.score ?? {};
  const kickoffYear = row.kickoff_at ? new Date(row.kickoff_at).getUTCFullYear() : null;
  const displaySeason = kickoffYear && kickoffYear < Number(season) ? kickoffYear : (row.season ?? kickoffYear ?? season);
  return {
    fixture: {
      id: row.api_fixture_id,
      date: row.kickoff_at,
      timestamp: row.kickoff_at ? Math.floor(new Date(row.kickoff_at).getTime() / 1000) : null,
      status: {
        long: row.status_long,
        short: row.status_short,
        elapsed: row.elapsed,
      },
      venue: raw.venue ?? null,
    },
    league: {
      id: 1,
      name: raw.tournamentName ?? raw.leagueName ?? "World Championship",
      country: "World",
      season: displaySeason,
      round: raw.round ?? raw.tournamentStage?.name ?? null,
    },
    teams: {
      home: {
        id: row.home_team_id,
        name: row.home_name,
        logo: staticImage(raw.homeLogo),
        winner: raw.winner === "1" ? true : null,
      },
      away: {
        id: row.away_team_id,
        name: row.away_name,
        logo: staticImage(raw.awayLogo),
        winner: raw.winner === "2" ? true : null,
      },
    },
    goals: {
      home: score.home,
      away: score.away,
    },
    score: {
      halftime: { home: null, away: null },
      fulltime: {
        home: score.homeFullTime ?? score.home,
        away: score.awayFullTime ?? score.away,
      },
      extratime: { home: null, away: null },
      penalty: { home: null, away: null },
    },
    sportdb: raw,
  };
}

async function sportGet(path: string, essential = false) {
  if (!apiKey) throw new Error("Missing FOOTBALL_API_KEY secret");
  await spendOne(essential);
  const url = `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  // مهلة قصوى 8 ثوانٍ لكل طلب — حتى لا يتعلّق التشغيل لو تأخّر المصدر
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        [apiHeader]: apiKey,
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 WC2026 Supabase Edge Cache",
      },
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  // نلتقط عدادات المزود نفسه (إن وفّرها في الهيدرز) لعرضها في /status
  const remote: AnyRow = {};
  response.headers.forEach((v, k) => {
    if (/ratelimit|quota|remaining/i.test(k)) remote[k] = v;
  });
  if (Object.keys(remote).length) {
    supabase.from("football_sync_state").upsert({
      key: `${provider}:remote-budget`,
      value: { ...remote, seen_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }).then(() => null, () => null);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(`SportDB ${response.status}: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data;
}

function asList(data: any) {
  if (Array.isArray(data)) return data;
  return data?.response ?? data?.fixtures ?? data?.matches ?? data?.data ?? [];
}

async function upsertFixtures(items: AnyRow[]) {
  const rows = items
    .map(normalizeFixture)
    .filter((row) => row.api_fixture_id && isTournamentWindow(row));
  if (!rows.length) return 0;
  const { error } = await supabase
    .from("football_fixture_cache")
    .upsert(rows, { onConflict: "provider,api_fixture_id" });
  if (error) throw error;
  return rows.length;
}

async function getState() {
  const key = `${provider}:worldcup:${season}`;
  const { data, error } = await supabase
    .from("football_sync_state")
    .select("value, updated_at")
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return { key, state: data as AnyRow | null };
}

async function setState(key: string, value: AnyRow) {
  const { error } = await supabase.from("football_sync_state").upsert({
    key,
    value,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function hasFixtures() {
  const { count, error } = await supabase
    .from("football_fixture_cache")
    .select("api_fixture_id", { count: "exact", head: true })
    .eq("provider", provider)
    .eq("season", season)
    .gte("kickoff_at", `${tournamentStart}T00:00:00Z`)
    .lte("kickoff_at", `${tournamentEnd}T23:59:59Z`);
  if (error) throw error;
  return Number(count ?? 0) > 0;
}

async function refreshFixtures(force = false) {
  const { key, state } = await getState();
  const value = (state?.value ?? {}) as AnyRow;

  // كل قرار يُطالَب به ذرّياً: claimSync يفحص ويكتب وقت المحاولة في خطوة واحدة،
  // فلا ينجح إلا متقدّم واحد مهما تزامن عدد المستخدمين (يحل تعارض التزامن).
  const hasCachedFixtures = await hasFixtures();
  const needsFull = (force || !hasCachedFixtures)
    ? await claimSync(key, "last_full_at", 0, value.last_full_at)               // قسري
    : await claimSync(key, "last_full_at", fullRefreshHours * 60, value.last_full_at);

  // اللايف: فقط إذا فيه مباراة جارية/قريبة، ثم نطالب بالفتحة ذرّياً
  let needsLive = false;
  if (await hasMatchWindow()) {
    needsLive = await claimSync(key, "last_live_at", force ? 0 : staleMinutes, value.last_live_at);
  }

  // اللحاق: نتيجة مباراة فاتت وماحد كان فاتح وقتها — أول زيارة بعدها تجلبها
  let needsCatchup = false;
  if (!needsLive && !needsFull && await pendingPastFixtures()) {
    needsCatchup = await claimSync(key, "last_catchup_at", force ? 0 : 10, value.last_catchup_at);
  }

  if (!needsLive && !needsFull && !needsCatchup) {
    return { skipped: true, reason: "fresh-or-claimed", state: value };
  }

  const paths: string[] = [];
  if (needsFull) {
    paths.push(`/api/flashscore/football/${leagueId}/${season}/fixtures?page=1`);
    paths.push(`/api/flashscore/football/${leagueId}/${season}/results?page=1`);
  }
  if (needsLive) {
    paths.push(`/api/flashscore/football/${leagueId}/live`);
  }
  if (needsCatchup) {
    paths.push(`/api/flashscore/football/${leagueId}/${season}/results?page=1`);
  }

  const responses: AnyRow[] = [];
  for (const path of paths) {
    try {
      responses.push(await sportGet(path, true)); // النتائج لها الأولوية في الميزانية
    } catch (err) {
      if (String(err).includes("BUDGET_EXCEEDED")) break;
      throw err;
    }
  }
  if (!responses.length) {
    return { skipped: true, reason: "budget-exceeded", state: value };
  }

  const items = responses.flatMap(asList);
  const upserted = await upsertFixtures(items);
  // ملاحظة: طوابع الأوقات حُدِّثت ذرّياً داخل claimSync (jsonb_set يحفظ بقية الحقول)،
  // فلا نعيد كتابة value كاملاً هنا حتى لا نلغي تحديثات متزامنة.

  return { skipped: false, full: needsFull, catchup: needsCatchup, requests: paths.length, upserted, paths };
}

async function queryFixtures(fixtureId?: string | null) {
  let query = supabase
    .from("football_fixture_cache")
    .select("*")
    .eq("provider", provider)
    .eq("season", season)
    .gte("kickoff_at", `${tournamentStart}T00:00:00Z`)
    .lte("kickoff_at", `${tournamentEnd}T23:59:59Z`)
    .order("kickoff_at", { ascending: true });
  if (fixtureId) query = query.eq("api_fixture_id", fixtureId);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

async function autoLinkMatches(rows: AnyRow[]) {
  const { data: dbMatches, error } = await supabase
    .from("matches")
    .select("id,team1_id,team2_id,match_utc,api_fixture_id")
    .is("api_fixture_id", null);
  if (error || !dbMatches?.length) return;
  const pending = [...dbMatches];
  for (const row of rows) {
    if (!row.api_fixture_id || !row.kickoff_at) continue;
    const rowDay = String(row.kickoff_at).slice(0, 10);
    const home = String(row.home_name ?? "");
    const away = String(row.away_name ?? "");
    if (!home || !away) continue;
    const idx = pending.findIndex((m) => {
      if (String(m.match_utc ?? "").slice(0, 10) !== rowDay) return false;
      const a = TEAM_NAME_MAP[m.team1_id] ?? String(m.team1_id ?? "");
      const b = TEAM_NAME_MAP[m.team2_id] ?? String(m.team2_id ?? "");
      return (namesMatch(home, a) && namesMatch(away, b)) || (namesMatch(home, b) && namesMatch(away, a));
    });
    if (idx === -1) continue;
    const m = pending[idx];
    pending.splice(idx, 1);
    await supabase
      .from("matches")
      .update({ api_fixture_id: String(row.api_fixture_id) })
      .eq("id", m.id)
      .is("api_fixture_id", null);
  }
}

/* اعتماد النتائج تلقائياً: أي مباراة مرتبطة انتهت في المصدر (FT) تُكتب نتيجتها
   في جدول matches وتُحسب نقاط المتوقعين — بدون أي تدخل من الأدمن.
   صفر طلبات خارجية (يقرأ من الكاش فقط). */
async function autoApplyResults(rows: AnyRow[]) {
  const byId: Record<string, AnyRow> = {};
  rows.forEach((r) => { if (r.api_fixture_id) byId[String(r.api_fixture_id)] = r; });
  const { data: dbMatches, error } = await supabase
    .from("matches")
    .select("id,api_fixture_id,team1_id,team2_id,status")
    .not("api_fixture_id", "is", null)
    .neq("status", "finished");
  if (error || !dbMatches?.length) return;
  for (const m of dbMatches) {
    const row = byId[String(m.api_fixture_id)];
    if (!row || row.status_short !== "FT") continue;
    // نتيجة الوقت الأصلي (٩٠ دقيقة) لا الوقت الإضافي — التوقعات تُحسب على الزمن الأصلي.
    // في الإقصائيات التي تذهب للتمديد، score.home/away تشمل الوقت الإضافي بينما *FullTime هو الـ٩٠ دقيقة.
    let h = row.score?.homeFullTime ?? row.score?.home;
    let a = row.score?.awayFullTime ?? row.score?.away;
    if (h == null || a == null) continue;
    // تصحيح الاتجاه: home في المصدر قد يكون team2 عندنا
    const homeName = String(row.home_name ?? "");
    const t1 = TEAM_NAME_MAP[m.team1_id] ?? String(m.team1_id);
    const t2 = TEAM_NAME_MAP[m.team2_id] ?? String(m.team2_id);
    if (namesMatch(homeName, t2) && !namesMatch(homeName, t1)) { const t = h; h = a; a = t; }
    const { error: upErr } = await supabase
      .from("matches")
      .update({ result_team1: h, result_team2: a, status: "finished" })
      .eq("id", m.id)
      .neq("status", "finished");
    if (!upErr) {
      try { await supabase.rpc("calculate_match_points", { match_id_param: m.id }); } catch { /* النقاط تُحسب لحظياً في الواجهة أيضاً */ }
    }
  }
}

async function upsertDetails(fixtureId: string, patch: AnyRow) {
  const { error } = await supabase.from("football_match_details").upsert({
    provider,
    api_fixture_id: fixtureId,
    ...patch,
    updated_at: new Date().toISOString(),
  }, { onConflict: "provider,api_fixture_id" });
  if (error) throw error;
}

function playerPhoto(value?: string | null) {
  return staticImage(value);
}

function normalizeLineupSide(side: AnyRow[] = []) {
  return side.map((player) => ({
    player: {
      id: player.participantId ?? player.id ?? player.playerId,
      name: player.participantName ?? player.name ?? player.playerName,
      number: safeNumber(player.participantNumber ?? player.number ?? player.shirtNumber),
      pos: player.positionKey ?? player.positionName ?? player.position ?? player.shortPosition,
      grid: `${player.rowIndex ?? player.row ?? 0}:${player.positionKey ?? player.positionId ?? 0}`,
      photo: playerPhoto(player.participantImageVariant72 ?? player.participantImage ?? player.photo ?? player.image),
      rating: player.rating ?? player.participantRating ?? player.playerRating ?? player.participantRatingValue ?? null,
    },
    type: String(player.playerType ?? player.type ?? player.lineupType ?? ""),
    positionId: player.positionId ?? player.positionKey ?? null,
    special: player.participantSpecialPositionName ?? player.participantSpecialPosition ?? null,
    incidents: {
      type: player.lineupIncident ?? null,
      text: player.incidentTypeName ?? null,
      minute: player.incidentTooltip ?? null,
      url: player.incidentUrl ?? null,
    },
    raw: player,
  }));
}

function normalizeCoach(value: any) {
  const coach = Array.isArray(value) ? value[0] : value;
  if (!coach || typeof coach !== "object") return null;
  const name = coach.participantName ?? coach.name ?? coach.coachName ?? coach.managerName ?? coach.shortName ?? null;
  if (!name) return null;
  return {
    id: coach.participantId ?? coach.id ?? coach.coachId ?? coach.managerId ?? null,
    name,
    photo: playerPhoto(coach.participantImageVariant72 ?? coach.participantImage ?? coach.photo ?? coach.image),
  };
}

function findCoach(payload: AnyRow, side: "home" | "away") {
  const keys = [`${side}Coach`, `${side}Coaches`, `${side}Manager`, `${side}Managers`, `${side}Trainer`];
  for (const key of keys) {
    const coach = normalizeCoach(payload?.[key]);
    if (coach) return coach;
  }
  const rows = Array.isArray(payload?.[side]) ? payload[side] : [];
  const row = rows.find((item: AnyRow) => {
    const text = String(item.participantType ?? item.playerTypeName ?? item.role ?? item.type ?? item.positionKey ?? "").toLowerCase();
    return text.includes("coach") || text.includes("manager") || text.includes("trainer");
  });
  return normalizeCoach(row);
}

function normalizeLineups(payload: any) {
  // الحمولة الرسمية ثلاثة أقسام: [0]=الأساسيون (مع positionKey)، [1]=الدكة، [2]=المدربان
  const sections = Array.isArray(payload) ? payload : [payload];
  const first = sections[0];
  if (!first || typeof first !== "object") return [];
  const benchSec = (sections[1] && typeof sections[1] === "object") ? sections[1] : {};
  const coachSec = (sections[2] && typeof sections[2] === "object") ? sections[2] : {};
  const mkSide = (key: "home" | "away") => {
    const all = normalizeLineupSide(first[key] ?? []);
    let startXI = all.filter((p: AnyRow) => p.type !== "2");
    let substitutes = all.filter((p: AnyRow) => p.type === "2");
    const bench = normalizeLineupSide(benchSec[key] ?? []).map((p: AnyRow) => ({ ...p, type: "2" }));
    if (bench.length) substitutes = bench;
    return {
      team: { name: key },
      formation: first[key]?.[0]?.formation ?? null,
      coach: findCoach(coachSec, key) ?? findCoach(first, key) ?? normalizeCoach(coachSec[key]),
      startXI,
      substitutes,
    };
  };
  return [mkSide("home"), mkSide("away")];
}

function collectSquadPlayers(value: any, out: AnyRow[] = [], depth = 0) {
  if (!value || depth > 6) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectSquadPlayers(item, out, depth + 1);
    return out;
  }
  if (typeof value !== "object") return out;
  const name = value.participantName ?? value.playerName ?? value.name ?? value.shortName;
  const id = value.participantId ?? value.playerId ?? value.id;
  const looksPlayer = name && (id || value.positionName || value.positionKey || value.participantImage || value.photo);
  if (looksPlayer) out.push(value);
  for (const child of Object.values(value)) collectSquadPlayers(child, out, depth + 1);
  return out;
}

function normalizeSquadSide(payload: any) {
  const seen = new Set<string>();
  const players = collectSquadPlayers(payload).filter((player) => {
    const id = String(player.participantId ?? player.playerId ?? player.id ?? player.participantName ?? player.playerName ?? "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((player, index) => ({
    participantId: player.participantId ?? player.playerId ?? player.id ?? `squad-${index}`,
    participantName: player.participantName ?? player.playerName ?? player.name ?? player.shortName,
    participantNumber: player.participantNumber ?? player.number ?? player.shirtNumber,
    positionKey: player.positionKey ?? player.positionName ?? player.position ?? player.role,
    participantImageVariant72: player.participantImageVariant72 ?? player.participantImage ?? player.photo ?? player.image,
    playerType: index < 11 ? "1" : "2",
    rowIndex: index < 1 ? 1 : index < 5 ? 2 : index < 8 ? 3 : 4,
  }));
  const normalized = normalizeLineupSide(players);
  return {
    formation: normalized.length >= 11 ? "قائمة المنتخب" : null,
    coach: normalizeCoach(payload?.coach ?? payload?.manager ?? payload?.trainer),
    startXI: normalized.slice(0, 11).map((player) => ({ ...player, type: "1" })),
    substitutes: normalized.slice(11).map((player) => ({ ...player, type: "2" })),
  };
}

async function squadFallbackLineups(fixture: AnyRow | null) {
  const raw = fixture?.fixture ?? {};
  const homeSlug = raw.homeParticipantNameUrl;
  const awaySlug = raw.awayParticipantNameUrl;
  const homeId = raw.homeParticipantIds ?? fixture?.home_team_id ?? raw.homeEventParticipantId;
  const awayId = raw.awayParticipantIds ?? fixture?.away_team_id ?? raw.awayEventParticipantId;
  if (!homeSlug || !awaySlug || !homeId || !awayId) return [];
  const [homeRaw, awayRaw] = await Promise.all([
    sportGet(`/api/flashscore/team/${homeSlug}/${homeId}`).catch(() => null),
    sportGet(`/api/flashscore/team/${awaySlug}/${awayId}`).catch(() => null),
  ]);
  const home = normalizeSquadSide(homeRaw);
  const away = normalizeSquadSide(awayRaw);
  if (!home.startXI.length && !home.substitutes.length && !away.startXI.length && !away.substitutes.length) return [];
  return [
    { team: { name: fixture?.home_name ?? "home" }, ...home },
    { team: { name: fixture?.away_name ?? "away" }, ...away },
  ];
}

async function findFixtureByTeamCodes(homeTeam?: string | null, awayTeam?: string | null) {
  const homeName = TEAM_NAME_MAP[String(homeTeam ?? "")] ?? String(homeTeam ?? "");
  const awayName = TEAM_NAME_MAP[String(awayTeam ?? "")] ?? String(awayTeam ?? "");
  if (!homeName || !awayName) return null;
  const { data, error } = await supabase
    .from("football_fixture_cache")
    .select("*")
    .eq("provider", provider)
    .gte("kickoff_at", `${tournamentStart}T00:00:00Z`)
    .lte("kickoff_at", `${tournamentEnd}T23:59:59Z`)
    .order("kickoff_at", { ascending: true })
    .limit(300);
  if (error) throw error;
  return (data ?? []).find((row) => {
    const home = row.home_name ?? row.fixture?.homeName ?? "";
    const away = row.away_name ?? row.fixture?.awayName ?? "";
    return (namesMatch(home, homeName) && namesMatch(away, awayName)) || (namesMatch(home, awayName) && namesMatch(away, homeName));
  }) ?? null;
}

function normalizeStatistics(payload: any, fixture?: AnyRow | null) {
  // المصدر يرجع مصفوفة فترات: [{period:"Match",stats:[...]},{period:"1st Half",...}]
  const periods = Array.isArray(payload) ? payload : Array.isArray(payload?.periods) ? payload.periods : null;
  const matchPeriod = periods
    ? (periods.find((p: AnyRow) => String(p?.period ?? "").toLowerCase() === "match") ?? periods[0])
    : null;
  const stats = Array.isArray(matchPeriod?.stats) ? matchPeriod.stats
    : Array.isArray(payload?.stats) ? payload.stats : [];
  if (!stats.length) return [];
  return [
    {
      team: { id: fixture?.home_team_id ?? null, name: fixture?.home_name ?? "Home" },
      statistics: stats.map((item: AnyRow) => ({
        type: item.statName ?? item.name ?? item.type,
        value: item.homeValue ?? item.home ?? null,
      })),
    },
    {
      team: { id: fixture?.away_team_id ?? null, name: fixture?.away_name ?? "Away" },
      statistics: stats.map((item: AnyRow) => ({
        type: item.statName ?? item.name ?? item.type,
        value: item.awayValue ?? item.away ?? null,
      })),
    },
  ];
}

/* أحداث المباراة تأتي داخل صفحة التفاصيل (goal/card/substitution) — نحولها لصيغة الواجهة */
function normalizeEvents(payload: AnyRow, fixture?: AnyRow | null) {
  const evs = Array.isArray(payload?.events) ? payload.events : [];
  const homeName = payload?.homeName ?? fixture?.home_name ?? "Home";
  const awayName = payload?.awayName ?? fixture?.away_name ?? "Away";
  const asArr = (v: unknown) => Array.isArray(v) ? v : (v == null ? [] : [v]);
  const out: AnyRow[] = [];
  for (const ev of evs) {
    const names = asArr(ev.incidentPlayerName);
    const typeName = String(asArr(ev.incidentTypeName)[0] ?? "");
    const sub = String(ev.incidentSubtypeName ?? "");
    const tm = String(ev.incidentTime ?? "").match(/(\d+)(?:\+(\d+))?/);
    const elapsed = tm ? Number(tm[1]) : null;
    const extra = tm && tm[2] ? Number(tm[2]) : (ev.incidentAddedTime != null ? safeNumber(ev.incidentAddedTime) : null);
    const team = { id: null, name: String(ev.incidentSide) === "2" ? awayName : homeName };
    const base = { time: { elapsed, extra }, team, player: { name: names[0] ?? null }, assist: { name: names[1] ?? null }, comments: null };
    const lowSub = sub.toLowerCase();
    if (typeName === "Goal") {
      out.push({ ...base, type: "Goal", detail: lowSub.includes("penalt") ? "Penalty" : lowSub.includes("own") ? "Own Goal" : "Normal Goal" });
    } else if (typeName.includes("Card")) {
      out.push({ ...base, type: "Card", detail: typeName, assist: { name: null } });
    } else if (typeName.startsWith("Substitution")) {
      out.push({ ...base, type: "subst", detail: sub || "Substitution" });
    } else if (typeName) {
      out.push({ ...base, type: typeName, detail: sub || typeName });
    }
  }
  out.sort((a, b) => (a.time?.elapsed ?? 0) - (b.time?.elapsed ?? 0) || (a.time?.extra ?? 0) - (b.time?.extra ?? 0));
  return out;
}

/* تقييمات اللاعبين من صفحة playerstats: عناصر {playerId, statsKey:"fsRating", numericValue} في عمق الحمولة */
function collectRatings(value: any, out: Record<string, number> = {}, depth = 0) {
  if (!value || depth > 7) return out;
  if (Array.isArray(value)) { for (const item of value) collectRatings(item, out, depth + 1); return out; }
  if (typeof value !== "object") return out;
  if (value.playerId && String(value.statsKey ?? "") === "fsRating") {
    const n = safeNumber(value.numericValue ?? value.value);
    if (n != null && n > 0) out[String(value.playerId)] = n;
  }
  for (const child of Object.values(value)) collectRatings(child, out, depth + 1);
  return out;
}

/* مراكز اللاعبين النصية من playerstats: {name, position:{name}, link:"/api/.../{playerId}"} */
function collectPositions(value: any, out: Record<string, string> = {}, depth = 0) {
  if (!value || depth > 7) return out;
  if (Array.isArray(value)) { for (const item of value) collectPositions(item, out, depth + 1); return out; }
  if (typeof value !== "object") return out;
  const posName = value?.position?.name;
  if (posName && (value.link || value.playerId || value.id)) {
    const id = String(value.playerId ?? value.id ?? String(value.link ?? "").split("/").pop() ?? "");
    if (id) out[id] = String(posName);
  }
  for (const child of Object.values(value)) collectPositions(child, out, depth + 1);
  return out;
}

function applyRatings(lineups: AnyRow[], ratings: Record<string, number>, positions: Record<string, string> = {}) {
  const withMeta = (p: AnyRow) => {
    const id = String(p?.player?.id ?? "");
    if (!id || (ratings[id] == null && !positions[id])) return p;
    const player = { ...p.player };
    if (ratings[id] != null) player.rating = ratings[id];
    if (positions[id]) player.pos = positions[id];
    return { ...p, player };
  };
  return lineups.map((side: AnyRow) => ({
    ...side,
    startXI: (side.startXI ?? []).map(withMeta),
    substitutes: (side.substitutes ?? []).map(withMeta),
  }));
}

async function refreshMatchDetails(fixtureId: string, force = false) {
  const fixtureRows = await queryFixtures(fixtureId);
  const fixture = fixtureRows[0] ?? null;
  const { data: details, error } = await supabase
    .from("football_match_details")
    .select("*")
    .eq("provider", provider)
    .eq("api_fixture_id", fixtureId)
    .maybeSingle();
  if (error) throw error;

  // مباراة موثقة نهائياً: كاش للأبد، صفر طلبات خارجية
  if (!force && details?.finalized_at) {
    return { fixtureId, requests: [], finalized: true };
  }

  const kickoff = fixture?.kickoff_at ? new Date(fixture.kickoff_at).getTime() : null;
  const now = Date.now();
  const isFT = fixture?.status_short === "FT";
  const nearKickoff = kickoff != null && now >= kickoff - 90 * 60_000; // قبل الانطلاق بـ90 دقيقة
  const liveNow = kickoff != null && now >= kickoff && !isFT;

  const hasCachedLineupNames = Array.isArray(details?.lineups)
    && details.lineups.some((side: AnyRow) => (side.startXI ?? []).some((player: AnyRow) => player?.player?.name));
  // بذر التشكيلة الافتراضية (قائمة المنتخب): فقط للمباريات خلال الـ36 ساعة القادمة
  // حتى لا يستنزف تصفح المباريات البعيدة ميزانية اليوم، وإعادة المحاولة كل 6 ساعات
  const within36h = kickoff != null && kickoff - now < 36 * 60 * 60_000;
  const needSeedLineups = !hasCachedLineupNames && within36h && isStale(details?.last_lineups_sync_at, 360);

  // مباراة بعيدة وما انتهت ولا تحتاج بذر تشكيلة: لا نصرف عليها شي
  if (!force && !nearKickoff && !isFT && !needSeedLineups) {
    return { fixtureId, requests: [], reason: "outside-window" };
  }

  const patch: AnyRow = {};
  const requests: string[] = [];

  // تشكيلة "رسمية" = أسماء + خانات خطة (positionKey) — أعلى رتبة من قائمة المنتخب الأبجدية
  const cachedOfficial = Array.isArray(details?.lineups)
    && details.lineups.some((side: AnyRow) => (side.startXI ?? []).some((player: AnyRow) => player?.player?.name && player?.raw?.positionKey != null));

  try {
    // التشكيلة: بذر مبكر (قائمة منتخب)، ثم ترقية للتشكيلة الرسمية قرب الانطلاق وبعدها.
    // الرسمية المحفوظة لا تُلمس ولا تُستبدل بقائمة أبجدية أبداً.
    const lineupsStale = !cachedOfficial && (
      !hasCachedLineupNames
        ? isStale(details?.last_lineups_sync_at, needSeedLineups || nearKickoff ? 45 : 360)
        : ((nearKickoff || liveNow || isFT) && isStale(details?.last_lineups_sync_at, 30))
    );
    if (force ? !cachedOfficial : lineupsStale) {
      const lineupsRaw = await sportGet(`/api/flashscore/match/${fixtureId}/lineups`, isFT).catch((err) => ({ error: String(err) }));
      const officialLineups = normalizeLineups(lineupsRaw);
      const hasOfficialNames = officialLineups.some((side: AnyRow) => (side.startXI ?? []).some((player: AnyRow) => player?.player?.name));
      const fresh = hasOfficialNames ? officialLineups : await squadFallbackLineups(fixture);
      const freshHasNames = Array.isArray(fresh) && fresh.some((side: AnyRow) => [...(side.startXI ?? []), ...(side.substitutes ?? [])].some((player: AnyRow) => player?.player?.name));
      // الكتابة فقط ببيانات فعلية، والقائمة الأبجدية لا تحل محل أسماء محفوظة
      if (freshHasNames && (hasOfficialNames || !hasCachedLineupNames)) patch.lineups = fresh;
      patch.last_lineups_sync_at = new Date().toISOString();
      requests.push(hasOfficialNames ? "lineups" : "squad-fallback");
    }

    // الإحصائيات والأحداث: أثناء المباراة كل 15 دقيقة وبعد نهايتها للتوثيق.
    // ما بعد النهاية يُحسب على الحصة الأساسية (مرة واحدة لكل مباراة) حتى لا يعلق التوثيق.
    if ((liveNow || (isFT && (!details?.finalized_at || force))) && (force || isStale(details?.last_statistics_sync_at, 15))) {
      const statsRaw = await sportGet(`/api/flashscore/match/${fixtureId}/stats`, isFT).catch((err) => ({ error: String(err) }));
      const freshStats = normalizeStatistics(statsRaw, fixture);
      const hadStats = Array.isArray(details?.statistics) && details.statistics.length > 0;
      if (freshStats.length || !hadStats) patch.statistics = freshStats; // لا نمسح المحفوظ بفارغ
      patch.last_statistics_sync_at = new Date().toISOString();
      requests.push("stats");

      const detRaw = await sportGet(`/api/flashscore/match/${fixtureId}/details`, isFT).catch((err) => ({ error: String(err) }));
      const freshEvents = normalizeEvents(detRaw, fixture);
      const hadEvents = Array.isArray(details?.events) && details.events.length > 0;
      if (freshEvents.length || !hadEvents) patch.events = freshEvents;
      patch.last_events_sync_at = new Date().toISOString();
      if (detRaw && (detRaw.referee || detRaw.venue)) {
        patch.extra_info = { referee: detRaw.referee ?? null, venue: detRaw.venue ?? null, venueCity: detRaw.venueCity ?? null, attendance: detRaw.attendance ?? null };
      }
      requests.push("details");

      // التقييمات والمراكز: كل 30 دقيقة أثناء اللعب + مرة ختامية بعد النهاية
      if (force || isFT || isStale(details?.last_player_stats_sync_at, 30)) {
        const psRaw = await sportGet(`/api/flashscore/match/${fixtureId}/playerstats`, isFT).catch((err) => ({ error: String(err) }));
        const ratings = collectRatings(psRaw);
        const positions = collectPositions(psRaw);
        const baseLineups = patch.lineups ?? details?.lineups;
        if ((Object.keys(ratings).length || Object.keys(positions).length) && Array.isArray(baseLineups) && baseLineups.length) {
          patch.lineups = applyRatings(baseLineups, ratings, positions);
        }
        patch.last_player_stats_sync_at = new Date().toISOString();
        requests.push("playerstats");
      }
    }
  } catch (err) {
    if (!String(err).includes("BUDGET_EXCEEDED")) throw err;
  }

  // التوثيق النهائي: انتهت + إحصائيات وأحداث محفوظة فعلاً، أو مرّت 6 ساعات على نهايتها
  const ftAgedOut = isFT && kickoff != null && now - kickoff > 6 * 60 * 60_000;
  const hasStats = Array.isArray(patch.statistics ?? details?.statistics) && (patch.statistics ?? details?.statistics).length > 0;
  const hasEvents = Array.isArray(patch.events ?? details?.events) && (patch.events ?? details?.events).length > 0;
  if (isFT && ((hasStats && hasEvents) || ftAgedOut)) {
    patch.finalized_at = new Date().toISOString();
  }

  if (Object.keys(patch).length) await upsertDetails(fixtureId, patch);
  return { fixtureId, requests };
}

async function getDetails(fixtureId: string) {
  const { data, error } = await supabase
    .from("football_match_details")
    .select("*")
    .eq("provider", provider)
    .eq("api_fixture_id", fixtureId)
    .maybeSingle();
  if (error) throw error;
  return data as AnyRow | null;
}

async function ensureHistoricalH2hCache() {
  const { key, state } = await getState();
  const value = (state?.value ?? {}) as AnyRow;
  const historicalVersion = "wc-history-1930-v6-season-override";
  // إذا انجلب التاريخ مرة، لا يُعاد أبداً تلقائياً — السجل القديم ما يتغير
  if (value.historical_version === historicalVersion) return { skipped: true };
  const seasons = [2022, 2018, 2014, 2010, 2006, 2002, 1998, 1994, 1990, 1986, 1982, 1978, 1974, 1970, 1966, 1962, 1958, 1954, 1950, 1938, 1934, 1930];
  const historicalPages = [1, 2, 3, 4];
  const paths = seasons.flatMap((year) => historicalPages.map((page) => ({ year, path: `/api/flashscore/football/${leagueId}/${year}/results?page=${page}` })));
  const responses = await Promise.all(paths.map((entry) => sportGet(entry.path).then((payload) => ({ year: entry.year, items: asList(payload) })).catch(() => ({ year: entry.year, items: [] }))));
  const rows = responses.flatMap((entry) => entry.items.map((item: AnyRow) => normalizeFixture(item, entry.year))).filter((row) => row.api_fixture_id);
  if (rows.length) {
    const { error } = await supabase
      .from("football_fixture_cache")
      .upsert(rows, { onConflict: "provider,api_fixture_id" });
    if (error) throw error;
  }
  await supabase.from("football_fixture_cache").upsert([{
    provider,
    api_fixture_id: "seed-h2h-mexico-south-africa-2010",
    league_id: "world-cup-history",
    season: 2010,
    kickoff_at: "2010-06-11T14:00:00Z",
    status: "FT",
    elapsed: 90,
    home_team_id: "seed-mexico",
    away_team_id: "seed-south-africa",
    home_name: "Mexico",
    away_name: "South Africa",
    score: { home: 1, away: 1, winner: null },
    fixture: {
      eventId: "seed-h2h-mexico-south-africa-2010",
      homeName: "Mexico",
      awayName: "South Africa",
      tournamentName: "FIFA World Cup",
      season: 2010,
      startDateTimeUtc: "2010-06-11T14:00:00Z",
    },
    last_seen_at: new Date().toISOString(),
    last_fixture_sync_at: new Date().toISOString(),
    details_finalized: true,
  }], { onConflict: "provider,api_fixture_id" });
  await setState(key, { ...value, historical_version: historicalVersion, last_historical_at: new Date().toISOString(), last_historical_count: rows.length });
  return { skipped: false, count: rows.length };
}

async function h2hResponse(h2h: string, last = 110) {
  const [a, b] = h2h.split("-");
  // السجل التاريخي يُجلب يدوياً فقط (action: h2h-bootstrap) — هنا كاش فقط
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("football_fixture_cache")
    .select("*")
    .eq("provider", provider)
    .or(`and(home_team_id.eq.${a},away_team_id.eq.${b}),and(home_team_id.eq.${b},away_team_id.eq.${a})`)
    .eq("details_finalized", true)
    .lt("kickoff_at", now)
    .order("kickoff_at", { ascending: false })
    .limit(last);
  if (error) throw error;
  return (data ?? []).map(toApiFootball);
}

function simpleName(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(fc|cf|national|team)\b/g, "")
    .trim();
}

function namesMatch(a: string, b: string) {
  const x = simpleName(a);
  const y = simpleName(b);
  return Boolean(x && y && (x === y || x.includes(y) || y.includes(x)));
}

function h2hCacheKey(a: string, b: string) {
  return [simpleName(a), simpleName(b)].sort().join("__");
}

async function cacheH2hRows(key: string, homeTeamId: string, awayTeamId: string, rows: AnyRow[]) {
  await supabase.from("football_h2h_cache").upsert({
    provider,
    h2h_key: key,
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    data: { fixtures: rows.map(toApiFootball) },
    last_synced_at: new Date().toISOString(),
  }, { onConflict: "provider,h2h_key" });
}

async function h2hNamesResponse(h2hNames: string, last = 110) {
  const [rawA, rawB] = h2hNames.split("-");
  const a = decodeURIComponent(rawA ?? "");
  const b = decodeURIComponent(rawB ?? "");
  const key = h2hCacheKey(a, b);
  const { data: cached } = await supabase
    .from("football_h2h_cache")
    .select("data,last_synced_at")
    .eq("provider", provider)
    .eq("h2h_key", key)
    .maybeSingle();
  const cachedFixtures = Array.isArray(cached?.data?.fixtures) ? cached.data.fixtures.slice(0, last) : [];
  if (cachedFixtures.length) return cachedFixtures;

  // كاش فقط — بدون جلب تاريخي تلقائي (يُعمل يدوياً عبر h2h-bootstrap)
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("football_fixture_cache")
    .select("*")
    .eq("provider", provider)
    .eq("details_finalized", true)
    .lt("kickoff_at", now)
    .order("kickoff_at", { ascending: false })
    .limit(Math.max(600, last * 8));
  if (error) throw error;
  const rows = (data ?? []).filter((row) => {
    const home = row.home_name ?? row.fixture?.homeName ?? "";
    const away = row.away_name ?? row.fixture?.awayName ?? "";
    return (namesMatch(home, a) && namesMatch(away, b)) || (namesMatch(home, b) && namesMatch(away, a));
  }).slice(0, last);
  await cacheH2hRows(key, a, b, rows).catch(() => null);
  return rows.map(toApiFootball);
}

async function bootstrapScheduledH2hCache() {
  await ensureHistoricalH2hCache().catch(() => null);
  const { data: matches, error: matchError } = await supabase
    .from("matches")
    .select("id,team1_id,team2_id")
    .not("team1_id", "is", null)
    .not("team2_id", "is", null);
  if (matchError) throw matchError;

  const now = new Date().toISOString();
  const { data: history, error: historyError } = await supabase
    .from("football_fixture_cache")
    .select("*")
    .eq("provider", provider)
    .eq("details_finalized", true)
    .lt("kickoff_at", now)
    .order("kickoff_at", { ascending: false })
    .limit(10000);
  if (historyError) throw historyError;

  let saved = 0;
  for (const match of matches ?? []) {
    const a = TEAM_NAME_MAP[match.team1_id] ?? match.team1_id;
    const b = TEAM_NAME_MAP[match.team2_id] ?? match.team2_id;
    const rows = (history ?? []).filter((row) => {
      const home = row.home_name ?? row.fixture?.homeName ?? "";
      const away = row.away_name ?? row.fixture?.awayName ?? "";
      return (namesMatch(home, a) && namesMatch(away, b)) || (namesMatch(home, b) && namesMatch(away, a));
    }).slice(0, 110);
    await cacheH2hRows(h2hCacheKey(a, b), String(match.team1_id), String(match.team2_id), rows);
    saved++;
  }
  return { saved, historyRows: history?.length ?? 0 };
}

async function handleEndpoint(endpoint: string) {
  const { path, params } = parseEndpoint(endpoint);

  if (path === "/status") {
    const used = await getBudgetUsed().catch(() => -1);
    const { data: rb } = await supabase.from("football_sync_state").select("value").eq("key", `${provider}:remote-budget`).maybeSingle();
    const { data: cr } = await supabase.from("football_sync_state").select("value").eq("key", `${provider}:cron`).maybeSingle();
    return { get: "status", errors: [], results: 1, response: { provider, leagueId, season, staleMinutes, budget: { day: todayKey(), used, limit: dailyBudget, liveReserve }, providerBudget: rb?.value ?? null, cron: cr?.value ?? null } };
  }

  if (path === "/fixtures") {
    const fixtureId = params.get("id");
    const h2h = params.get("h2h");
    const h2hNames = params.get("h2hNames");
    const last = Math.min(Math.max(Number(params.get("last") ?? 110) || 110, 1), 110);
    if (h2h) {
      const response = await h2hResponse(h2h, last);
      return { get: "fixtures/headtohead", errors: [], results: response.length, response };
    }
    if (h2hNames) {
      const response = await h2hNamesResponse(h2hNames, last);
      return { get: "fixtures/headtohead-names", errors: [], results: response.length, response };
    }

    await refreshFixtures(false);
    const rows = await queryFixtures(fixtureId);
    if (!fixtureId) {
      await autoLinkMatches(rows);
      await autoApplyResults(rows);
    }
    const response = rows.map(toApiFootball);
    return { get: "fixtures", parameters: Object.fromEntries(params), errors: [], results: response.length, response };
  }

  const fixtureId = params.get("fixture");
  if (!fixtureId && path === "/fixtures/lineups" && params.get("homeTeam") && params.get("awayTeam")) {
    const fixture = await findFixtureByTeamCodes(params.get("homeTeam"), params.get("awayTeam"));
    const response = await squadFallbackLineups(fixture);
    return { get: "fixtures/lineups-squad-fallback", errors: [], results: Array.isArray(response) ? response.length : 0, response };
  }
  if (fixtureId && ["/fixtures/events", "/fixtures/statistics", "/fixtures/lineups", "/fixtures/players", "/fixtures/extra"].includes(path)) {
    // ── محيَّد لوقف النزيف (2026-06-17) ──────────────────────────────
    // السطر التالي كان يستدعي بيانات المباراة من المصدر عند كل فتح مستخدم،
    // وهو سبب نزيف الطلبات. حُوِّل إلى ملاحظة؛ طلب المستخدم الآن قراءة فقط من
    // قاعدة البيانات. الجلب سيتولّاه لاحقاً موظف cron آلي (قيد الإعداد).
    // await refreshMatchDetails(fixtureId);
    const details = await getDetails(fixtureId);
    const key = path.endsWith("events") ? "events"
      : path.endsWith("statistics") ? "statistics"
        : path.endsWith("lineups") ? "lineups"
          : path.endsWith("extra") ? "extra_info"
            : "player_stats";
    const response = details?.[key] ?? (path.endsWith("extra") ? null : []);
    return { get: path.replace(/^\//, ""), errors: [], results: Array.isArray(response) ? response.length : (response ? 1 : 0), response };
  }

  return { get: path, errors: { unsupported: "Endpoint is not mapped to SportDB yet." }, results: 0, response: [] };
}

/* تعيين كلمة مرور عضو — للأدمن فقط (يُتحقق من JWT المرسل ثم من is_admin) */
async function adminSetPassword(body: AnyRow, token: string | null) {
  if (!token) return { ok: false, error: "يجب تسجيل الدخول" };
  const { data: caller, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !caller?.user) return { ok: false, error: "جلسة غير صالحة" };
  const { data: prof } = await supabase
    .from("profiles").select("is_admin").eq("id", caller.user.id).maybeSingle();
  if (!prof?.is_admin) return { ok: false, error: "هذه الخاصية للمشرف فقط" };
  const userId = String(body.userId ?? "");
  const password = String(body.password ?? "");
  if (!userId) return { ok: false, error: "اختر العضو" };
  if (password.length < 6) return { ok: false, error: "كلمة المرور 6 أحرف على الأقل" };
  const { error } = await supabase.auth.admin.updateUserById(userId, { password });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/* ── الموظف الآلي (cron) ───────────────────────────────────────────
   يعمل كل ~5 دقائق. الوحيد الذي يجلب من المصدر. حالياً: النتائج + التشكيلة فقط.
   (الأحداث/الإحصائيات/التقييمات ستُضاف لاحقاً بعد الاتفاق). */
const hasOfficialLineup = (det: AnyRow | null) =>
  Array.isArray(det?.lineups)
  && det.lineups.some((s: AnyRow) => (s.startXI ?? []).some((p: AnyRow) => p?.player?.name && p?.raw?.positionKey != null));

async function cronTick() {
  // (1) تحديث النتائج/الحالة — رخيص وذرّي، حتى نعرف من بدأ/انتهى بلا اعتماد على المستخدمين
  await refreshFixtures(false).catch(() => null);

  // نبضة حياة: نسجّل وقت آخر تشغيل (يظهر في /status لمراقبة أن الموظف حيّ)
  await supabase.from("football_sync_state").upsert({
    key: `${provider}:cron`, value: { last_tick: new Date().toISOString() }, updated_at: new Date().toISOString(),
  }).then(() => null, () => null);

  // (2) مباريات البطولة المرتبطة
  const { data: rows } = await supabase
    .from("football_fixture_cache")
    .select("api_fixture_id,kickoff_at,status_short,home_name,away_name,home_team_id,away_team_id")
    .gte("kickoff_at", `${tournamentStart}T00:00:00Z`)
    .lte("kickoff_at", `${tournamentEnd}T23:59:59Z`)
    .eq("season", season);
  if (!rows?.length) return { ticked: true, candidates: 0 };

  const now = Date.now();
  // النوافذ الزمنية (كلها مغلقة — بعد انقضائها لا يُلمس شيء، فلا محاولات لا نهائية):
  //  • التشكيلة: حول البداية (±10د) أو بعد النهاية [95,135]
  //  • الإحصائيات/الأحداث: بعد الشوط الأول [55,72] + بعد النهاية [95,135]
  //  • التقييمات: بعد النهاية فقط [95,135]
  const win = (r: AnyRow) => {
    const ko = r.kickoff_at ? new Date(r.kickoff_at).getTime() : null;
    if (ko == null) return null;
    const mins = (now - ko) / 60000;
    const isFT = r.status_short === "FT";
    return {
      ko, mins, isFT,
      // التشكيلة: حول البداية أو بعد النهاية بقليل
      lineup: (mins >= -10 && mins <= 10) || (isFT && mins >= 95 && mins <= 135),
      halftime: mins >= 55 && mins <= 72,                  // بعد الشوط الأول
      statsFT: isFT && mins >= 95 && mins <= 170,           // بعد النهاية (الإحصائيات/التقييمات تتوفر بسرعة)
      // الأحداث قد ينشرها المصدر متأخراً — نافذة أوسع بسقف صارم على المحاولات
      eventsFT: isFT && mins >= 95 && mins <= 300,
    };
  };
  const candidates = rows.filter((r: AnyRow) => { const w = win(r); return w && (w.lineup || w.halftime || w.statsFT || w.eventsFT); });

  const out = { lineups: 0, stats: 0, events: 0, ratings: 0 };
  const hit = (e: unknown) => String(e).includes("BUDGET_EXCEEDED");
  // هل تم جلب نوع معيّن بعد النهاية فعلاً؟ (طابعه الزمني بعد الانطلاق بـ90 دقيقة)
  const ftDone = (present: boolean, stamp: string | null | undefined, ko: number) =>
    present && !!stamp && new Date(stamp).getTime() > ko + 90 * 60_000;

  for (const r of candidates) {
    const fid = String(r.api_fixture_id);
    const w = win(r)!;
    const { data: det } = await supabase.from("football_match_details")
      .select("lineups,statistics,events,last_statistics_sync_at,last_events_sync_at").eq("provider", provider).eq("api_fixture_id", fid).maybeSingle();
    const statsPresent = Array.isArray(det?.statistics) && det.statistics.length > 0;
    const eventsPresent = Array.isArray(det?.events) && det.events.length > 0;
    const ratingsPresent = Array.isArray(det?.lineups)
      && det.lineups.some((s: AnyRow) => (s.startXI ?? []).some((p: AnyRow) => p?.player?.rating != null));
    // «أُنجز بعد النهاية»: حتى نلتقط أرقام/أحداث المباراة الكاملة لا الشوط الأول فقط، ثم نتوقف
    const statsFtDone = ftDone(statsPresent, det?.last_statistics_sync_at, w.ko);
    const eventsFtDone = ftDone(eventsPresent, det?.last_events_sync_at, w.ko);

    try {
      // ── التشكيلة: حتى تتوفر رسمياً ──
      if (w.lineup && !hasOfficialLineup(det) && await claimSync(`lineup:${fid}`, "attempt", 14, null)) {
        const raw = await sportGet(`/api/flashscore/match/${fid}/lineups`, true);
        const lu = normalizeLineups(raw);
        const hasNames = lu.some((s: AnyRow) => (s.startXI ?? []).some((p: AnyRow) => p?.player?.name));
        const patch: AnyRow = { last_lineups_sync_at: new Date().toISOString() };
        if (hasNames) { patch.lineups = lu; out.lineups++; }
        await upsertDetails(fid, patch);
      }

      // ── الإحصائيات: بعد الشوط الأول + بعد النهاية حتى تُلتقط النهائية (سقف ~كل 18د) ──
      if ((w.halftime || (w.statsFT && !statsFtDone)) && await claimSync(`st:${fid}`, "attempt", 18, null)) {
        const fresh = normalizeStatistics(await sportGet(`/api/flashscore/match/${fid}/stats`, true), r);
        if (fresh.length || !statsPresent) { await upsertDetails(fid, { statistics: fresh, last_statistics_sync_at: new Date().toISOString() }); if (fresh.length) out.stats++; }
      }

      // ── الأحداث: بعد الشوط الأول + نافذة أوسع بعد النهاية (المصدر يتأخر)، سقف ~كل 30د ──
      if ((w.halftime || (w.eventsFT && !eventsFtDone)) && await claimSync(`ev:${fid}`, "attempt", 30, null)) {
        const detRaw = await sportGet(`/api/flashscore/match/${fid}/details`, true);
        const ev = normalizeEvents(detRaw, r);
        const patch: AnyRow = { last_events_sync_at: new Date().toISOString() };
        if (ev.length || !eventsPresent) { patch.events = ev; if (ev.length) out.events++; }
        if (detRaw && (detRaw.referee || detRaw.venue)) patch.extra_info = { referee: detRaw.referee ?? null, venue: detRaw.venue ?? null, venueCity: detRaw.venueCity ?? null, attendance: detRaw.attendance ?? null };
        await upsertDetails(fid, patch);
      }

      // ── التقييمات (+ مراكز البدلاء): بعد النهاية فقط حتى تتوفر ──
      if (w.statsFT && !ratingsPresent && await claimSync(`rt:${fid}`, "attempt", 18, null)) {
        const psRaw = await sportGet(`/api/flashscore/match/${fid}/playerstats`, true);
        const ratings = collectRatings(psRaw);
        const positions = collectPositions(psRaw);
        const base = det?.lineups;
        if ((Object.keys(ratings).length || Object.keys(positions).length) && Array.isArray(base) && base.length) {
          await upsertDetails(fid, { lineups: applyRatings(base, ratings, positions), last_player_stats_sync_at: new Date().toISOString() });
          if (Object.keys(ratings).length) out.ratings++;
        } else {
          await upsertDetails(fid, { last_player_stats_sync_at: new Date().toISOString() });
        }
      }
    } catch (e) {
      if (hit(e)) break; // نفدت الميزانية — نتوقف بهدوء، التشغيل التالي يكمل
    }
  }
  return { ticked: true, candidates: candidates.length, ...out };
}

async function handleAction(body: AnyRow, token: string | null = null) {
  const action = body.action ?? "refresh";
  if (action === "probe" && body.key === "dbg2026") {
    const payload = await sportGet(String(body.path), true).catch((e) => ({ error: String(e) }));
    return { ok: true, result: payload };
  }
  if (action === "cron-tick") return { ok: true, result: await cronTick() };
  if (action === "admin-set-password") return await adminSetPassword(body, token);
  if (action === "refresh") return { ok: true, result: await refreshFixtures(Boolean(body.force)) };
  if (action === "match-details") return { ok: true, result: await refreshMatchDetails(String(body.fixtureId), Boolean(body.force)) };
  if (action === "bootstrap") return { ok: true, result: await refreshFixtures(true) };
  if (action === "h2h-bootstrap") return { ok: true, result: await bootstrapScheduledH2hCache() };
  return { ok: false, error: `Unknown action: ${action}` };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return send({ ok: true, provider, leagueId, season, staleMinutes });

  try {
    const body = await req.json().catch(() => ({}));
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") || null;
    if (body.endpoint) return send(await handleEndpoint(String(body.endpoint)));
    return send(await handleAction(body, token));
  } catch (error) {
    return send({
      errors: { server: error instanceof Error ? error.message : String(error) },
      results: 0,
      response: [],
    }, 500);
  }
});
