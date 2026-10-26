// Agent records and badges. One Durable Object holds every wallet's record.
//
// Identity is the wallet that paid for a seat (verified by the x402 paywall), so no accounts are needed.
// Any agent can look up a counterparty's record before trusting it. A wallet can make its record private
// by joining a paid match with "private_record": true (and public again with false).
import type { DOState, Env } from "./types.ts";

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

  async fetch(req: Request): Promise<Response> {
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
      // body: { caller, limit, record? } -> counts failed paid reviews per address today (UTC). A failed review isn't
      // charged, so this stops one address from getting free AI calls by making reviews fail on purpose.
      // The caller is a daily-salted one-way hash (see index.ts); no IP address is stored.
      const day = nowIso.slice(0, 10);
      const k = `reviewfail:${day}`;
      const who = typeof body?.caller === "string" ? body.caller : "";
      const limit = Number.isFinite(body?.limit) ? body.limit : 10;
      const fails = (await this.state.storage.get<Record<string, number>>(k)) ?? {};
      const okKey = `reviewok:${day}`;
      const oks = (await this.state.storage.get<Record<string, number>>(okKey)) ?? {};
      if (body?.record_ok && who) {
        if (!Object.keys(oks).length) {
          const prev = new Date(Date.parse(day) - 86400_000).toISOString().slice(0, 10);
          await (this.state.storage as any).delete?.(`reviewok:${prev}`);
        }
        oks[who] = (oks[who] ?? 0) + 1;
        await this.state.storage.put(okKey, oks);
      }
      const totalKey = `reviewfailtotal:${day}`;
      let total = (await this.state.storage.get<number>(totalKey)) ?? 0;
      if (body?.record && who) {
        total++;
        await this.state.storage.put(totalKey, total);
        if (!Object.keys(fails).length) {
          const prev = new Date(Date.parse(day) - 86400_000).toISOString().slice(0, 10);
          await (this.state.storage as any).delete?.(`reviewfail:${prev}`);
        }
        fails[who] = (fails[who] ?? 0) + 1;
        await this.state.storage.put(k, fails);
      }
      const count = who ? (fails[who] ?? 0) : 0;
      const ok = who ? (oks[who] ?? 0) : 0;
      // Each successful (paid) review today earns one more allowed failure, so a paying user isn't locked out
      // by a bad provider hour, while free failures stay capped.
      // A ceiling on free failures across everyone (bounded by money, not by how many addresses someone controls):
      // past it, only addresses with a successful review today can keep going.
      const globalLimit = Number.isFinite(body?.global_limit) ? body.global_limit : 500;
      const overGlobal = total >= globalLimit && ok === 0;
      return json(200, { count, ok, limit, total, blocked: count >= limit + ok || overGlobal });
    }

    if (action === "demo-quota") {
      // body: { limit }  -> counts one demo match for today (UTC); refuses once today's limit is reached.
      const day = nowIso.slice(0, 10);
      const k = `demo:${day}`;
      const used = (await this.state.storage.get<number>(k)) ?? 0;
      const limit = Number.isFinite(body?.limit) ? body.limit : 2000;
      if (used >= limit) return json(429, { error: `Today's free demo matches are used up (${limit} per day). They reset at 00:00 UTC.`, limit });
      // Per-caller cap, so one script can't use up everyone's demos. The caller arrives as a one-way hash
      // that changes every day (see index.ts); no IP address is ever stored.
      const who = typeof body?.caller === "string" && body.caller ? body.caller : null;
      const perCaller = Number.isFinite(body?.per_caller) ? body.per_caller : 20;
      const ck = `demoip:${day}`;
      let callers: Record<string, number> | undefined;
      if (who) {
        callers = (await this.state.storage.get<Record<string, number>>(ck)) ?? {};
        if ((callers[who] ?? 0) >= perCaller)
          return json(429, { error: `You've used today's free demo matches (${perCaller} per day from one address). They reset at 00:00 UTC. Paid matches are not limited.`, limit: perCaller });
      }
      if (used === 0) {
        // First demo of a new day: drop yesterday's per-caller counts.
        const prev = new Date(Date.parse(day) - 86400_000).toISOString().slice(0, 10);
        await (this.state.storage as any).delete?.(`demoip:${prev}`);
      }
      await this.state.storage.put(k, used + 1);
      if (who && callers) {
        callers[who] = (callers[who] ?? 0) + 1;
        await this.state.storage.put(ck, callers);
      }
      return json(200, { ok: true, used: used + 1, limit });
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
