// Agent records and badges. One Durable Object holds every wallet's record.
//
// Identity is the wallet that paid for a seat (verified by the x402 paywall), so no accounts are needed.
// Any agent can look up a counterparty's record before trusting it. A wallet can make its record private
// by joining a paid match with "private_record": true (and public again with false).
import type { DOState, Env } from "./types.ts";

export const LEDGER_SHARDS = 16;

/** Which ledger object holds a caller's daily counters: one of 16 shards by the caller hash's first hex digit.
 * Without a caller (no IP header: local tests) the global ledger is used. */
export function ledgerShardName(caller?: string): string {
  if (!caller) return "global";
  const n = parseInt(caller[0], 16);
  return `shard-${(Number.isFinite(n) ? n : caller.charCodeAt(0)) % LEDGER_SHARDS}`;
}

/** A global daily ceiling split across the shards, rounding down so the shards together never allow more than the total. */
export function shardLimit(v: string | undefined, fallback: number): number {
  const total = Number(v || fallback);
  return Math.floor((Number.isFinite(total) ? total : fallback) / LEDGER_SHARDS);
}

export type Outcome = "win" | "loss" | "completed" | "forfeit";
export type Kind = "judge" | "luck";

export type AgentRecord = {
  wallet: string;
  judge_wins: number;
  judge_losses: number;
  luck_wins: number;
  luck_losses: number;
  completed: number; // matches finished without forfeiting
  forfeits: number;
  current_win_streak: number;
  best_win_streak: number;
  current_loss_streak: number;
  best_loss_streak: number;
  private: boolean;
  first_seen: string;
  updated_at: string;
};

export type RecordUpdate = { wallet: string; kind: Kind; outcome: Outcome };

export type Badge = { id: string; name: string; why: string };

export function badgesFor(r: AgentRecord): Badge[] {
  const out: Badge[] = [];
  const judgeTotal = r.judge_wins + r.judge_losses;
  const reliability = r.completed + r.forfeits ? r.completed / (r.completed + r.forfeits) : 0;
  if (judgeTotal >= 10 && r.judge_wins / judgeTotal >= 0.7)
    out.push({ id: "sharp-judge", name: "Sharp Arguer", why: "Won 70%+ of 10 or more AI-judged rulings" });
  if (r.completed >= 20 && reliability >= 0.95)
    out.push({ id: "reliable", name: "Reliable", why: "Finished 95%+ of the 20+ matches it joined without forfeiting" });
  if (r.best_win_streak >= 5) out.push({ id: "hot-streak", name: "Hot Streak", why: `Won ${r.best_win_streak} in a row` });
  if (r.best_loss_streak >= 5)
    out.push({ id: "good-sport", name: "Good Sport", why: `Kept playing through ${r.best_loss_streak} losses in a row` });
  if (r.completed >= 100) out.push({ id: "veteran", name: "Veteran", why: "Completed 100+ matches" });
  return out;
}

export function summarize(r: AgentRecord) {
  const judgeTotal = r.judge_wins + r.judge_losses;
  const finished = r.completed + r.forfeits;
  return {
    ...r,
    judge_win_rate: judgeTotal ? round(r.judge_wins / judgeTotal) : null,
    completion_rate: finished ? round(r.completed / finished) : null,
    badges: badgesFor(r),
    note: "Records cover matches this wallet actually joined (it paid for a seat). Matches it agreed to but never joined aren't counted, so a short record isn't proof of reliability. Judge wins reflect arguments that won under agreed rules; wins in rps, weighted and draw tiers are luck.",
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function blank(wallet: string, now: string): AgentRecord {
  return {
    wallet,
    judge_wins: 0,
    judge_losses: 0,
    luck_wins: 0,
    luck_losses: 0,
    completed: 0,
    forfeits: 0,
    current_win_streak: 0,
    best_win_streak: 0,
    current_loss_streak: 0,
    best_loss_streak: 0,
    private: false,
    first_seen: now,
    updated_at: now,
  };
}

export function applyOutcome(r: AgentRecord, kind: Kind, outcome: Outcome) {
  if (outcome === "forfeit") {
    r.forfeits++;
    r.current_win_streak = 0;
    return;
  }
  r.completed++;
  if (outcome === "win") {
    if (kind === "judge") r.judge_wins++;
    else r.luck_wins++;
    r.current_win_streak++;
    r.current_loss_streak = 0;
    r.best_win_streak = Math.max(r.best_win_streak, r.current_win_streak);
  } else if (outcome === "loss") {
    if (kind === "judge") r.judge_losses++;
    else r.luck_losses++;
    r.current_loss_streak++;
    r.current_win_streak = 0;
    r.best_loss_streak = Math.max(r.best_loss_streak, r.current_loss_streak);
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });

export class Ledger {
  state: DOState;
  env: Env;
  now: () => number = () => Date.now();

  constructor(state: DOState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private key(wallet: string) {
    return `w:${wallet}`;
  }

  async get(wallet: string): Promise<AgentRecord | undefined> {
    return this.state.storage.get<AgentRecord>(this.key(wallet));
  }

  /** First counter request of a new UTC day: schedule cleanup of older days' counters. Today's keys carry the day,
   * so an old count can never affect today even before the cleanup runs. */
  private async newDay(day: string) {
    const st = this.state.storage;
    if ((await st.get<string>("counters_day")) === day) return;
    await st.put("counters_day", day);
    await st.setAlarm(this.now() + 5_000);
  }

  /** Deletes counter keys from earlier days (and the old one-map-per-day layout), up to 5,000 per run. */
  async alarm() {
    const st = this.state.storage;
    if (!st.list || !st.delete) return;
    const today = (await st.get<string>("counters_day")) ?? new Date(this.now()).toISOString().slice(0, 10);
    let deleted = 0;
    for (const prefix of ["rf:", "ro:", "rft:", "rfi:", "dm:", "dmc:", "fr:", "frb:", "frt:", "tm:", "tt:", "tmt:", "reviewfail:", "reviewok:", "reviewfailtotal:", "demo:", "demoip:"]) {
      while (deleted < 5_000) {
        const found = await st.list({ prefix, limit: 128 });
        const old = [...found.keys()].filter((k) => !k.slice(prefix.length).startsWith(today) || prefix.startsWith("review") || prefix.startsWith("demo")).slice(0, 5_000 - deleted);
        if (!old.length) break;
        await st.delete(old);
        deleted += old.length;
        if (found.size < 128) break;
      }
    }
    // Usage counts ("st:<day>:<name>") are kept 8 days for GET /admin/stats, then deleted.
    const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - 8 * 86_400_000).toISOString().slice(0, 10);
    while (deleted < 5_000) {
      const found = await st.list({ prefix: "st:", limit: 128 });
      const old = [...found.keys()].filter((k) => k.slice(3, 13) < cutoff).slice(0, 5_000 - deleted);
      if (!old.length) break;
      await st.delete(old);
      deleted += old.length;
      if (found.size < 128) break;
    }
    if (deleted >= 5_000) await st.setAlarm(this.now() + 1_000);
  }

  // One counter request at a time: each is a read-check-write, and two interleaved ones could both pass a check.
  // (Durable Object input gates already make storage-only sequences atomic; this keeps it true whatever the code awaits.)
  private chain: Promise<unknown> = Promise.resolve();
  async fetch(req: Request): Promise<Response> {
    const run = this.chain.then(() => this.handle(req), () => this.handle(req));
    this.chain = run.catch(() => {});
    return run;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const action = url.pathname.replace(/^\//, "");
    const body: any = req.method === "POST" ? await req.json().catch(() => null) : null;
    const nowIso = new Date(this.now()).toISOString();

    if (action === "record") {
      // body: { updates: RecordUpdate[] }  -> returns summaries for the wallets touched
      const updates: RecordUpdate[] = Array.isArray(body?.updates) ? body.updates : [];
      const out: Record<string, ReturnType<typeof summarize>> = {};
      for (const u of updates) {
        const r = (await this.get(u.wallet)) ?? blank(u.wallet, nowIso);
        applyOutcome(r, u.kind, u.outcome);
        r.updated_at = nowIso;
        await this.state.storage.put(this.key(u.wallet), r);
        out[u.wallet] = summarize(r);
      }
      return json(200, { records: out });
    }

    if (action === "privacy") {
      // body: { wallet, private }  (only ever called for a wallet whose payment the paywall just verified)
      const r = (await this.get(body.wallet)) ?? blank(body.wallet, nowIso);
      r.private = !!body.private;
      r.updated_at = nowIso;
      await this.state.storage.put(this.key(r.wallet), r);
      return json(200, { ok: true, private: r.private });
    }

    if (action === "review-fails") {
      // body: { caller, limit, global_limit?, parallel?, reserve?, record?, record_ok?, release_token?, weight? } -> counts failed paid reviews per address today (UTC).
      // weight (1 to 3, default 1): a multi-part review counts as many failures, and holds as much in-flight room, as it has pieces.
      // A failed review isn't charged, so this stops one address from getting free AI calls by making reviews fail on
      // purpose. The caller is a daily-salted one-way hash (see index.ts); no IP address is stored. One small key per
      // caller per day (not one growing map), and the Worker spreads callers over 16 ledger shards.
      const day = nowIso.slice(0, 10);
      await this.newDay(day);
      const who = typeof body?.caller === "string" ? body.caller : "";
      const limit = Number.isFinite(body?.limit) ? body.limit : 10;
      const st = this.state.storage;
      // Reviews in flight for this caller count against the allowance until they're recorded, so many parallel
      // paid reviews can't all pass the check before any failure is written. A reservation left by a crashed
      // request expires after 5 minutes (longer than any review).
      const ik = `rfi:${day}:${who}`;
      const weight = Number.isInteger(body?.weight) && body.weight >= 1 && body.weight <= 3 ? (body.weight as number) : 1;
      let inflight = who ? ((await st.get<{ id: string; t: number; w?: number }[]>(ik)) ?? []).filter((r) => this.now() - r.t < 300_000) : [];
      if (typeof body?.release_token === "string" && who) {
        inflight = inflight.filter((r) => r.id !== body.release_token);
        await st.put(ik, inflight);
      }
      let ok = who ? ((await st.get<number>(`ro:${day}:${who}`)) ?? 0) : 0;
      if (body?.record_ok && who) await st.put(`ro:${day}:${who}`, ++ok);
      let total = (await st.get<number>(`rft:${day}`)) ?? 0;
      let count = who ? ((await st.get<number>(`rf:${day}:${who}`)) ?? 0) : 0;
      if (body?.record && who) {
        total += weight;
        count += weight;
        await st.put(`rft:${day}`, total);
        await st.put(`rf:${day}:${who}`, count);
      }
      // Each successful (paid) review today earns one more allowed failure, so a paying user isn't locked out
      // by a bad provider hour, while free failures stay capped.
      // A ceiling on free failures across everyone (bounded by money, not by how many addresses someone controls):
      // past it, only addresses with a successful review today can keep going.
      const globalLimit = Number.isFinite(body?.global_limit) ? body.global_limit : 500;
      const overGlobal = total >= globalLimit && ok === 0;
      // In-flight reviews mostly succeed, so they get `parallel` extra room on top of the failure allowance: an
      // address can run that many more reviews at once than it has failures left. Worst case, an address that makes
      // every review fail gets `parallel` extra free failures once, after which its recorded failures block it.
      const parallel = Number.isFinite(body?.parallel) ? Math.max(0, body.parallel) : 0;
      const failBlocked = count >= limit + ok;
      const inflightWeight = inflight.reduce((sum, r) => sum + (r.w ?? 1), 0);
      // A new reservation needs room for its own weight (a 3-piece review could become 3 failures).
      const inflightBlocked = count + inflightWeight + (body?.reserve ? weight - 1 : 0) >= limit + ok + parallel;
      const blocked = failBlocked || inflightBlocked || overGlobal;
      const reason = failBlocked ? "fail_limit" : overGlobal ? "global_ceiling" : inflightBlocked ? "too_many_in_flight" : undefined;
      let token: string | undefined;
      if (body?.reserve && who && !blocked) {
        token = crypto.randomUUID();
        inflight.push(weight > 1 ? { id: token, t: this.now(), w: weight } : { id: token, t: this.now() });
        await st.put(ik, inflight);
      }
      return json(200, { count, ok, limit, total, inflight: inflight.reduce((sum, r) => sum + (r.w ?? 1), 0), blocked, ...(reason ? { reason } : {}), ...(token ? { token } : {}) });
    }

    if (action === "demo-quota") {
      // body: { limit, per_caller?, caller? } -> counts one demo match for today (UTC); refuses once today's limit is reached.
      const day = nowIso.slice(0, 10);
      await this.newDay(day);
      const st = this.state.storage;
      const used = (await st.get<number>(`dm:${day}`)) ?? 0;
      const limit = Number.isFinite(body?.limit) ? body.limit : 2000;
      if (used >= limit) return json(429, { error: `Today's free demo matches are used up (${limit} per day). They reset at 00:00 UTC.`, limit });
      // Per-caller cap, so one script can't use up everyone's demos. The caller arrives as a one-way hash
      // that changes every day (see index.ts); no IP address is ever stored.
      const who = typeof body?.caller === "string" && body.caller ? body.caller : null;
      const perCaller = Number.isFinite(body?.per_caller) ? body.per_caller : 20;
      const mine = who ? ((await st.get<number>(`dmc:${day}:${who}`)) ?? 0) : 0;
      if (who && mine >= perCaller)
        return json(429, { error: `You've used today's free demo matches (${perCaller} per day from one address). They reset at 00:00 UTC. Paid matches are not limited.`, limit: perCaller });
      await st.put(`dm:${day}`, used + 1);
      if (who) await st.put(`dmc:${day}:${who}`, mine + 1);
      return json(200, { ok: true, used: used + 1, limit });
    }

    if (action === "free-review") {
      // body: { caller, tier, cost_micro, budget_micro, per_caller } to reserve one free review, or { release_token, refund_budget }
      // to give one back. Free reviews cost the operator real AI money, so two limits apply per UTC day: a few per
      // address (the caller is the same daily-salted one-way hash as above) and one budget across everyone, counted at
      // list price. Always called on the single "global" shard, so the budget is one counter, never split.
      // A reservation is counted immediately; it's only given back if the review didn't happen.
      const day = nowIso.slice(0, 10);
      await this.newDay(day);
      const st = this.state.storage;
      // Two separate budgets: the public one, and "ext" for reviews sent by the hosted MCP server (ChatGPT),
      // so one can't use up the other.
      const pool = body?.pool === "ext" ? "ext" : "";
      const budgetKey = (d: string, p: string) => (p ? `frb:${d}:${p}` : `frb:${d}`);
      const spentKey = budgetKey(day, pool);
      let spent = (await st.get<number>(spentKey)) ?? 0;
      if (typeof body?.release_token === "string") {
        // The token names the day it was taken on, so a review that runs past midnight gives back that day's count.
        const tday = /^\d{4}-\d{2}-\d{2}\|/.test(body.release_token) ? body.release_token.slice(0, 10) : day;
        const tk = `frt:${tday}:${body.release_token}`;
        const r = await st.get<{ who: string; tier: string; cost: number; pool?: string }>(tk);
        if (!r) return json(200, { released: false });
        const ck = `fr:${tday}:${r.tier}:${r.who}`;
        await st.put(ck, Math.max(0, ((await st.get<number>(ck)) ?? 0) - 1));
        const sk = budgetKey(tday, r.pool ?? "");
        if (body.refund_budget === true) await st.put(sk, Math.max(0, ((await st.get<number>(sk)) ?? 0) - r.cost));
        await st.put(tk, null); // the old day's cleanup deletes it
        return json(200, { released: true });
      }
      const who = typeof body?.caller === "string" ? body.caller : "";
      const tier = body?.tier === "review-3" ? "review-3" : "review";
      const cost = Number.isFinite(body?.cost_micro) ? Math.max(0, body.cost_micro) : 0;
      const budget = Number.isFinite(body?.budget_micro) ? Math.max(0, body.budget_micro) : 0;
      const limit = Number.isFinite(body?.per_caller) ? Math.max(0, body.per_caller) : 0;
      if (!who) return json(400, { error: "No caller." });
      const ck = `fr:${day}:${tier}:${who}`;
      const used = (await st.get<number>(ck)) ?? 0;
      if (used >= limit) return json(429, { reason: "per_caller", used, limit });
      if (cost <= 0 || spent + cost > budget) return json(429, { reason: "budget", spent_micro: spent, budget_micro: budget });
      const token = `${day}|${crypto.randomUUID()}`;
      await st.put(ck, used + 1);
      await st.put(spentKey, (spent += cost));
      await st.put(`frt:${day}:${token}`, { who, tier, cost, ...(pool ? { pool } : {}) });
      return json(200, { ok: true, token, used: used + 1, limit, spent_micro: spent, budget_micro: budget });
    }

    if (action === "team") {
      // The team allowance (one owner's own AI sessions): dollar budgets per member and for the whole team, per UTC day,
      // counted at list price. body: { member, cost_micro, member_budget_micro, team_budget_micro } reserves one review;
      // { release_token } gives one back (the review didn't happen or failed, so it isn't counted); { member, status: true }
      // reads today's spending. Always on the single "global" shard, so each budget is one counter.
      const day = nowIso.slice(0, 10);
      await this.newDay(day);
      const st = this.state.storage;
      const teamKey = `tt:${day}`;
      if (typeof body?.release_token === "string") {
        const tday = /^\d{4}-\d{2}-\d{2}\|/.test(body.release_token) ? body.release_token.slice(0, 10) : day;
        const tk = `tmt:${tday}:${body.release_token}`;
        const r = await st.get<{ member: string; cost: number; group?: string }>(tk);
        if (!r) return json(200, { released: false });
        if (r.group) await st.put(`tgp:${r.group}`, Math.max(0, ((await st.get<number>(`tgp:${r.group}`)) ?? 0) - r.cost));
        const mk = `tm:${tday}:${r.member}`;
        await st.put(mk, Math.max(0, ((await st.get<number>(mk)) ?? 0) - r.cost));
        await st.put(`tt:${tday}`, Math.max(0, ((await st.get<number>(`tt:${tday}`)) ?? 0) - r.cost));
        await st.put(tk, null); // the old day's cleanup deletes it
        return json(200, { released: true });
      }
      const member = typeof body?.member === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(body.member) ? body.member : "";
      if (!member) return json(400, { error: "No team member." });
      const memberKey = `tm:${day}:${member}`;
      const memberSpent = (await st.get<number>(memberKey)) ?? 0;
      const teamSpent = (await st.get<number>(teamKey)) ?? 0;
      // A group pool (for example one experiment arm's run) is a total, not daily: its key has no date and the daily
      // cleanup never deletes it. A new run uses a new group name.
      const group = typeof body?.group === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(body.group) ? body.group : "";
      const groupKey = group ? `tgp:${group}` : "";
      const groupSpent = group ? ((await st.get<number>(groupKey)) ?? 0) : 0;
      if (body?.status === true) return json(200, { ok: true, member_spent_micro: memberSpent, team_spent_micro: teamSpent, ...(group ? { group_spent_micro: groupSpent } : {}) });
      const cost = Number.isFinite(body?.cost_micro) ? Math.max(0, body.cost_micro) : 0;
      const memberBudget = Number.isFinite(body?.member_budget_micro) ? Math.max(0, body.member_budget_micro) : 0;
      const teamBudget = Number.isFinite(body?.team_budget_micro) ? Math.max(0, body.team_budget_micro) : 0;
      if (cost <= 0) return json(400, { error: "No cost." });
      if (memberSpent + cost > memberBudget) return json(429, { reason: "member", member_spent_micro: memberSpent, team_spent_micro: teamSpent, ...(group ? { group_spent_micro: groupSpent } : {}) });
      if (teamSpent + cost > teamBudget) return json(429, { reason: "team", member_spent_micro: memberSpent, team_spent_micro: teamSpent, ...(group ? { group_spent_micro: groupSpent } : {}) });
      const groupBudget = Number.isFinite(body?.group_budget_micro) ? Math.max(0, body.group_budget_micro) : 0;
      if (group && groupSpent + cost > groupBudget) return json(429, { reason: "group", member_spent_micro: memberSpent, team_spent_micro: teamSpent, group_spent_micro: groupSpent });
      const token = `${day}|${crypto.randomUUID()}`;
      await st.put(memberKey, memberSpent + cost);
      await st.put(teamKey, teamSpent + cost);
      if (group) await st.put(groupKey, groupSpent + cost);
      await st.put(`tmt:${day}:${token}`, { member, cost, ...(group ? { group } : {}) });
      return json(200, { ok: true, token, member_spent_micro: memberSpent + cost, team_spent_micro: teamSpent + cost, ...(group ? { group_spent_micro: groupSpent + cost } : {}) });
    }

    if (action === "stat") {
      // body: { name } -> adds one to today's count for that name. Counts only (never who), for GET /admin/stats.
      const name = typeof body?.name === "string" ? body.name : "";
      if (!/^[a-z0-9_-]{1,48}$/.test(name)) return json(400, { error: "Bad stat name." });
      const day = nowIso.slice(0, 10);
      await this.newDay(day);
      const k = `st:${day}:${name}`;
      await this.state.storage.put(k, ((await this.state.storage.get<number>(k)) ?? 0) + 1);
      return json(200, { ok: true });
    }

    if (action === "cutoff") {
      // body: a CutOff (cutoffs.ts) -> counts it for today ("oot_<model>") and keeps it in the last 100, newest last.
      const model = typeof body?.model === "string" && /^[\x20-\x7e]{1,120}$/.test(body.model) ? body.model : "";
      const where = body?.where === "judge" ? "judge" : body?.where === "review" ? "review" : "";
      if (!model || !where) return json(400, { error: "Bad cut-off note." });
      const n = (x: unknown) => (Number.isFinite(x) ? Math.max(0, Math.floor(x as number)) : null);
      const day = nowIso.slice(0, 10);
      await this.newDay(day);
      const k = `st:${day}:oot_${model.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 44)}`;
      await this.state.storage.put(k, ((await this.state.storage.get<number>(k)) ?? 0) + 1);
      const list = (await this.state.storage.get<unknown[]>("cutoffs")) ?? [];
      list.push({ at: nowIso, where, model, max_tokens: n(body.max_tokens), prompt_chars: n(body.prompt_chars), try_number: n(body.try_number) });
      await this.state.storage.put("cutoffs", list.slice(-100));
      return json(200, { ok: true });
    }

    if (action === "stats") {
      // -> { days: [{ day, counts }] } for the last 7 UTC days (newest first), plus today's free-review spending.
      const st = this.state.storage;
      const today = nowIso.slice(0, 10);
      const from = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
      const byDay: Record<string, Record<string, number>> = {};
      for (let i = 0; i < 7; i++) byDay[new Date(Date.parse(`${today}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10)] = {};
      // Only the 7 days shown (the alarm deletes older counts). Country counts can add a few hundred keys a day.
      const found = st.list ? await st.list<number>({ prefix: "st:", start: `st:${from}`, limit: 10_000 }) : new Map<string, number>();
      for (const [k, v] of found) {
        const day = k.slice(3, 13);
        if (day < from || day > today || !byDay[day]) continue;
        byDay[day][k.slice(14)] = v;
      }
      return json(200, {
        days: Object.entries(byDay).map(([day, counts]) => ({ day, counts })),
        free_spent_micro: { public: (await st.get<number>(`frb:${today}`)) ?? 0, ext: (await st.get<number>(`frb:${today}:ext`)) ?? 0 },
        cutoffs: (await st.get<unknown[]>("cutoffs")) ?? [],
      });
    }

    if (action === "agent") {
      const wallet = url.searchParams.get("wallet") || "";
      const r = await this.get(wallet);
      if (!r) return json(404, { error: "No matches recorded for this wallet yet." });
      if (r.private) return json(200, { wallet: r.wallet, private: true, note: "This agent keeps its record private." });
      return json(200, summarize(r));
    }

    return json(404, { error: "Unknown action." });
  }
}
