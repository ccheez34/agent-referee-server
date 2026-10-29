// One Durable Object per match: holds seats, commitments, reveals and the final signed receipt.
import {
  MEDIATOR,
  LIMITS,
  type Move,
  type Tier,
  combinedRandom,
  commitmentOf,
  drawPick,
  randomToken,
  rpsResult,
  sha256Hex,
  specFingerprint,
  specDifferences,
  validateCreate,
  validateRevealValue,
  weightedPick,
  isJudgeTier,
  canonicalJson,
  REMATCH_TIERS,
  MAX_SERIES_GAMES,
  type Criterion,
  isMultiJudgeTier,
} from "./logic.ts";
import {
  MULTI_JUDGE_LEASE_MS,
  MULTI_JUDGE_RECEIPT_FORMAT,
  MULTI_JUDGE_TIMEOUT_MS,
  multiJudgeCommitment,
  multiJudgeHow,
  piecesProof,
  sidePieceRecords,
  sidePiecesSha256,
  validateMultiSubmit,
} from "./multijudge.ts";
import { MultiClosedError } from "./multipart.ts";
import {
  judgeCommitment,
  tierCommitment,
  missingJudgeKey,
  tierModels,
  choosePanel,
  allowedModels,
  modelPool,
  PANEL_SIZE,
  runOneJudge,
  decide,
  votePick,
  JUDGE_FORMAT_VERSION_V2,
  type JudgeCommitment,
  type JudgeVote,
  type JudgeTierName,
} from "./judge.ts";
import { signReceipt, type Receipt } from "./receipt.ts";
import type { RecordUpdate } from "./ledger.ts";
import type { DOState, Env } from "./types.ts";
import { acquireSlots } from "./gateclient.ts";
import { fakeAiConfig } from "./fakeai.ts";
import { addUnjudged } from "./health.ts";
import { recordCutOff } from "./cutoffs.ts";
import { GATE_MAX_WAIT_MS } from "./gate.ts";

type Phase = "joining" | "commit" | "reveal" | "submit" | "judging" | "done" | "expired" | "error";

export type Tally = { games: number; wins: Record<string, number>; no_result: number };
/** A rematch series: each game is its own match; every receipt carries the running tally and the previous receipt's hash. */
export type SeriesInfo = { series_id: string; game: number; previous_match_id: string; previous_receipt_sha256: string; tally_before: Tally };

type Round = {
  commits: Record<string, string>;
  reveals: Record<string, { value: string; nonce: string }>;
  winner?: string | null; // rps rounds: seat, or null for a tie
  combined_hex?: string;
};

export type MatchState = {
  id: string;
  key?: string;
  tier: Tier;
  title?: string;
  created_at: number;
  expires_at: number; // unfinished matches expire here
  delete_at: number; // all data (including receipt) is deleted here
  parties: string[];
  seats: string[]; // seats that must join (parties, plus mediator for draw)
  weights?: Record<string, number>;
  options?: string[];
  rules?: string;
  judge?: JudgeCommitment; // fixed at creation; both agents see it before paying
  seat_wallets?: Record<string, string>; // optional seat locks: seat -> wallet that must pay for it
  host_pays?: string; // invite match: this seat pays for both; the other seat joins free with the invite token
  invite_hash?: string; // sha256 of the invite token (the token itself is only ever shown to the creator)
  joined: Record<string, { token_hash: string; joined_at: number; paid: boolean; paid_by?: string; payment_hash?: string }>;
  phase: Phase;
  rounds: Round[];
  reveal_deadline?: number;
  action_deadline?: number; // commit / submit step must happen before this, or the seat forfeits
  step_seconds?: number; // per-match deadline for each step (default 600)
  excluded?: string[]; // draw seats that never committed; the draw continues without them
  judging_since?: number; // if the judge call never comes back (e.g. a restart), the match becomes retryable
  submissions?: Record<string, string>; // multi-part judge tiers: each side's pieces_sha256, as the "submitted" marker
  pieces?: Record<string, string[]>; // multi-part judge tiers: each side's pieces (hidden until judging, never shown)
  criteria?: Criterion[]; // judge tiers: agreed weighted criteria; the winner is computed from the scores
  panel?: "rotate" | string[] | string[][] | { picks: Record<string, string> }; // judge-2 / judge-3: the panel request both agents agreed to (see choosePanel)
  panel_votes?: (JudgeVote | null)[]; // judge tiers: each panelist's verdict (kept across a retry, so only missing ones rerun)
  series?: SeriesInfo; // set when this match is a rematch
  tally_after?: Tally; // rematch tiers: the series tally including this match
  rematch?: { requested_by: string[]; next_match_id?: string };
  demo?: boolean; // free practice match: joined via /demo/join, receipts and acks say demo, never recorded
  result?: Record<string, unknown>;
  receipt?: Receipt;
  error?: string;
  error_code?: "judges_busy" | "judge_failed" | "unjudged"; // judge tiers: why phase is "error"
  judge_runs?: number; // judging attempts that actually called the AI (busy refusals don't count)
  retry_at?: number; // the room retries judging on its own at this time (match alarm)
  auto_retries?: number; // how many automatic retries were scheduled (sets the next wait)
  refund_listed?: boolean; // a paid match that ended unjudged was put on the operator's refund list
};

const HOUR = 3600_000;

type PendingJoin = { pending: true; seat: string; token: string; filled: Promise<boolean> };
type JudgeJob = { index: number; model: string; order: "sorted" | "reversed" };
type JudgeTask = {
  judge: true;
  jobs: JudgeJob[];
  formatVersion: string;
  rules: string;
  title?: string;
  criteria?: Criterion[];
  submissions: Record<string, string>;
  pieces?: Record<string, string[]>; // multi-part judge tiers
  maxTokens?: Record<string, number>; // multi-part judge tiers: each judge's answer room (from the commitment)
  ack?: Receipt;
};
const MAX_RPS_ROUNDS = 25;
// Judging can wait up to 20 s for a free slot, then run two 50 s tries with a short wait between: 3 minutes covers it.
const JUDGE_TIMEOUT_MS = 3 * 60_000;
/** Judging runs that actually call the AI: the first one plus 3 retries. After that the match ends unjudged. */
export const MAX_JUDGE_RUNS = 4;
/** A judge slot is held for the whole job: two 50 s calls plus a wait of up to 5 s, plus 30 s of margin. */
export const JUDGE_LEASE_MS = 140_000;
/** Waits before the room retries judging on its own: 30 s, 1, 2, 5 min, then every 10 min. */
const AUTO_RETRY_MS = [30_000, 60_000, 120_000, 300_000, 600_000];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });
const bad = (status: number, error: string, extra: Record<string, unknown> = {}) => json(status, { error, ...extra });

export class MatchRoom {
  state: DOState;
  env: Env;
  m: MatchState | undefined;
  now: () => number = () => Date.now();
  private waiters: (() => void)[] = [];

  constructor(state: DOState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async load() {
    if (!this.m) this.m = await this.state.storage.get<MatchState>("m");
    return this.m;
  }
  private async save() {
    await this.state.storage.put("m", this.m);
  }

  // One request at a time per match. Cloudflare can interleave a Durable Object's requests while one
  // is awaiting crypto or a network call, which could otherwise resolve a match twice.
  private chain: Promise<unknown> = Promise.resolve();
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async alarm() {
    const task = await this.locked(async () => {
      const m = await this.load();
      const now = this.now();
      if (m && now < m.delete_at - 1000) {
        // Not time to delete yet: this alarm is a judging retry (or a stale one from before the match moved on).
        const due = m.retry_at !== undefined && now + 1000 >= m.retry_at;
        if (due && m.phase === "error" && isJudgeTier(m.tier) && m.error_code !== "unjudged") {
          m.retry_at = undefined;
          const started = await this.startJudging();
          if (!(started instanceof Response)) return started;
          await this.state.storage.setAlarm(m.delete_at);
          return null;
        }
        if (due) m.retry_at = undefined;
        await this.save();
        await this.state.storage.setAlarm(m.retry_at ? Math.min(m.retry_at, m.delete_at) : m.delete_at);
        return null;
      }
      if (m) await this.listIfUnjudged("deleted before it could be judged");
      await this.state.storage.deleteAll();
      this.m = undefined;
      return null;
    });
    if (task) await this.runJudgeTask(task);
  }

  /** Paid judge match that will never be judged: put the payers on the operator's refund list (once). */
  private async listIfUnjudged(reason: string) {
    const m = this.m;
    if (!m || m.refund_listed || m.demo || !isJudgeTier(m.tier) || m.phase === "done") return;
    if (!m.submissions || !m.parties.every((s) => m.submissions![s] !== undefined)) return; // never got to judging
    const payers = Object.entries(m.joined)
      .filter(([, j]) => j.paid)
      .map(([seat, j]) => ({ seat, wallet: j.paid_by ?? null, payment_hash: j.payment_hash }));
    if (!payers.length) return;
    m.refund_listed = true;
    await addUnjudged(this.env, { match_id: m.id, tier: m.tier, reason, payers }).catch((e) => console.error(`refund list write failed for ${m.id}: ${e}`));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const action = url.pathname.replace(/^\//, "");
    const body: any = req.method === "POST" ? await req.json().catch(() => null) : null;

    const result = await this.locked(() => this.handle(action, body));
    if (result instanceof Response) return result;

    if ("judge" in result) {
      const res = await this.runJudgeTask(result);
      if (!result.ack) return res;
      // The last submitter's request waits for the verdict; it still gets its signed acknowledgment.
      return json(res.status, { ...((await res.json()) as object), ack: result.ack });
    }

    // A paid join is waiting for the table to fill. Wait OUTSIDE the lock so other agents can join.
    const filled = await result.filled;
    return this.locked(() => this.finishWaitingJoin(result, filled));
  }

  /**
   * The AI judge calls run OUTSIDE the lock, so status checks aren't blocked while they think. Panelists run in
   * parallel and independently: none sees another's verdict. Each first takes a slot at the provider's admission
   * gate; if there's no room, nothing is called and the room retries on its own (verdicts already given are kept).
   */
  private async runJudgeTask(result: JudgeTask): Promise<Response> {
    if (!result.jobs.length) return this.locked(() => this.finishJudging([]));
    const models = result.jobs.map((j) => j.model);
    const slots = await acquireSlots(this.env, models, { leaseMs: result.pieces ? MULTI_JUDGE_LEASE_MS : JUDGE_LEASE_MS, waitMs: GATE_MAX_WAIT_MS });
    if (!slots.ok) {
      const retryAfter = slots.retryAfter;
      return this.locked(() => this.judgesBusy(retryAfter, slots.reason));
    }
    let settled: PromiseSettledResult<JudgeVote>[];
    const notes: Promise<void>[] = []; // cut-off notes (never throw)
    try {
      const keys = { ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY, OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY, fake: fakeAiConfig(this.env) };
      settled = await Promise.allSettled(
        result.jobs.map((j, i) =>
          runOneJudge({
            keys,
            model: j.model,
            formatVersion: result.formatVersion,
            panelist: j.index + 1,
            order: j.order,
            rules: result.rules,
            title: result.title,
            criteria: result.criteria,
            submissions: result.submissions,
            how: result.pieces
              ? multiJudgeHow({ model: j.model, maxTokens: result.maxTokens![j.model], rules: result.rules, pieces: result.pieces, order: j.order, title: result.title, criteria: result.criteria })
              : undefined,
            observe: (o) => slots.lease.observe(i, o),
            onCutOff: (cut) => notes.push(recordCutOff(this.env, cut)),
          }),
        ),
      );
    } finally {
      await slots.lease.release();
      await Promise.all(notes);
    }
    const outcomes = settled.map((s, i) => ({
      index: result.jobs[i].index,
      vote: s.status === "fulfilled" ? s.value : null,
      error: s.status === "rejected" ? ((s.reason as any)?.message ?? String(s.reason)) : undefined,
    }));
    return this.locked(() => this.finishJudging(outcomes));
  }

  /** Inside the lock: no judge slot was free. No AI was called, so this doesn't count against the retry limit. */
  private async judgesBusy(retryAfterS: number, reason: string): Promise<Response> {
    const m = await this.load();
    if (!m) return bad(404, "No such match. It may have expired.");
    if (m.phase !== "judging") return json(200, { ok: true, match: this.publicView() });
    m.phase = "error";
    m.error_code = "judges_busy";
    const wait = this.scheduleRetry(retryAfterS * 1000);
    m.error = `The AI judges are busy right now (${reason}); nothing was lost. The match retries judging on its own in about ${Math.round(wait / 1000)} s, or any seated party can POST /matches/${m.id}/retry-judge then.`;
    await this.save();
    return json(200, { ok: true, retry_after_s: Math.round(wait / 1000), match: this.publicView() });
  }

  /** Sets the next automatic judging retry (the match alarm) and returns the wait in ms. */
  private scheduleRetry(atLeastMs: number): number {
    const m = this.m!;
    const n = m.auto_retries ?? 0;
    const wait = Math.max(atLeastMs, AUTO_RETRY_MS[Math.min(n, AUTO_RETRY_MS.length - 1)]);
    m.auto_retries = n + 1;
    m.retry_at = this.now() + wait;
    void this.state.storage.setAlarm(Math.min(m.retry_at, m.delete_at));
    return wait;
  }

  private async handle(action: string, body: any): Promise<Response | PendingJoin | JudgeTask> {
    if (action === "create") return this.create(body);

    const m = await this.load();
    if (!m) return bad(404, "No such match. It may have expired.");
    await this.tick();

    switch (action) {
      case "status":
        return json(200, this.publicView());
      case "join":
        return this.join(body);
      case "commit":
        return this.commit(body);
      case "reveal":
        return this.reveal(body);
      case "submit":
        return this.submit(body);
      case "retry-judge":
        return this.retryJudge(body);
      case "recover":
        return this.recover(body);
      case "rematch":
        return this.requestRematch(body);
      default:
        return bad(404, "Unknown action.");
    }
  }

  // ---------- actions ----------

  private async create(body: any) {
    const v = validateCreate(body?.input);
    if (!v.ok) return bad(400, v.error);
    const input = v.value;
    const existing = await this.load();
    if (existing) {
      // Shared key: the second agent lands in the same match, but only if both asked for the same settings.
      if (input.key && existing.key === input.key) {
        await this.tick();
        if (specFingerprint({ ...existing, seats: existing.parties }) === specFingerprint(input)) return json(200, { ...this.publicView(), existing: true });
        const differences = specDifferences({ ...existing, seats: existing.parties }, input);
        return bad(409, `A match with this key already exists with different settings: ${differences.map((d) => d.field).join(", ")}. If the existing match was set up wrong (for example a mistyped wallet), use a new key; nobody has been charged.`, {
          differences, // [{ field, match_has, you_sent }] so the typo is visible at a glance
          match: this.publicView(),
        });
      }
      return bad(409, "Match already exists.");
    }
    const now = this.now();
    // Panel tiers: the agreed models (fixed, rotating, or one of several sets) are drawn now, before anyone pays.
    let judge: JudgeCommitment | undefined;
    if (isMultiJudgeTier(input.tier)) {
      // Multi-part judge tiers: the review tiers' panel rules (eligible models, three companies), drawn now.
      try {
        judge = await multiJudgeCommitment(input.tier, this.env, input.panel);
      } catch (e: any) {
        return bad(e instanceof MultiClosedError ? 503 : 400, String(e?.message ?? e));
      }
      if (missingJudgeKey(this.env, judge.panel!.map((p) => p.model))) return bad(503, "This judge tier is temporarily unavailable.");
    } else if (isJudgeTier(input.tier)) {
      const tier = input.tier as JudgeTierName;
      if (input.panel) {
        let picked;
        try {
          picked = choosePanel(input.panel, PANEL_SIZE[tier], modelPool(this.env), undefined, allowedModels(this.env));
        } catch (e: any) {
          return bad(400, String(e?.message ?? e));
        }
        const missing = missingJudgeKey(this.env, picked.models);
        if (missing) return bad(503, "This judge tier is temporarily unavailable.");
        judge = { ...(await tierCommitment(tier, picked.models)), panel_selection: picked.selection };
      } else judge = await tierCommitment(tier, tierModels(this.env, tier));
    }
    this.m = {
      id: body.id,
      key: input.key,
      tier: input.tier,
      title: input.title,
      created_at: now,
      expires_at: now + 24 * HOUR,
      delete_at: now + 7 * 24 * HOUR,
      parties: input.seats,
      seats: input.tier === "draw" ? [...input.seats, MEDIATOR] : input.seats,
      weights: input.weights,
      options: input.options,
      rules: input.rules,
      seat_wallets: input.seat_wallets,
      step_seconds: input.step_seconds,
      demo: input.demo || undefined,
      criteria: input.criteria,
      panel: input.panel,
      host_pays: input.host_pays,
      judge,
      series: body.series, // only set by an internal rematch call; the public POST /matches never passes it
      joined: {},
      phase: "joining",
      rounds: [],
    };
    // Invite match: the token goes back to the creator only, once. Whoever holds it can take the guest seat free.
    let invite: Record<string, unknown> | undefined;
    if (input.host_pays) {
      const token = randomToken();
      this.m.invite_hash = await sha256Hex(token);
      invite = { seat: input.seats.find((s) => s !== input.host_pays), invite_token: token };
    }
    await this.save();
    await this.state.storage.setAlarm(this.m.delete_at);
    return json(201, invite ? { ...this.publicView(), invite } : this.publicView());
  }

  /** body: { seat, tier, role: "party" | "mediator", paid } — tier/role come from the route that was paid. */
  private async join(body: any): Promise<Response | PendingJoin> {
    const m = this.m!;
    if (!body || (typeof body.seat !== "string" && body.role !== "guest")) return bad(400, "seat is required.");
    // Invite matches: the host pays for both seats at its own route; the guest joins free with the invite token.
    if (body.role === "guest") {
      if (!m.host_pays || !m.invite_hash) return bad(400, "This match has no invite. Join it at /join/<tier>.");
      if (typeof body.invite_token !== "string" || (await sha256Hex(body.invite_token)) !== m.invite_hash)
        return bad(403, "That invite token doesn't match this match.");
      const guest = m.parties.find((s) => s !== m.host_pays)!;
      if (body.seat !== undefined && body.seat !== guest) return bad(400, `The invite is for seat "${guest}".`);
      body = { ...body, seat: guest, tier: m.tier, demo: !!m.demo, paid: false, payer: undefined, wait: false };
    } else if (m.host_pays) {
      if (body.role !== "host" || body.seat !== m.host_pays)
        return bad(400, `This is an invite match: "${m.host_pays}" pays for both seats at /join/${m.tier}/host, and the other agent joins free at /invite/join with the invite token.`, { host_pays: m.host_pays });
    } else if (body.role === "host") {
      return bad(400, "This match isn't an invite match. Join it at /join/<tier> (create it with host_pays to invite someone).");
    }
    if (body.tier !== m.tier)
      return bad(400, `This match is tier "${m.tier}". Join it at the /join route for that tier.`, { tier: m.tier });
    // Demo and paid matches each have their own join routes. Refusing the wrong one keeps a paid match from
    // being joined for free, and keeps anyone from paying for a demo (an error here means the payment never settles).
    if (!!body.demo !== !!m.demo)
      return bad(400, m.demo ? "This is a free demo match: join it at /demo/join/<tier>." : "This is a paid match: join it at /join/<tier>.", { demo: !!m.demo });
    const seat: string = body.seat;
    if (m.tier === "draw") {
      if (body.role === "mediator" && seat !== MEDIATOR) return bad(400, `The mediator route only joins seat "${MEDIATOR}".`);
      if (body.role === "party" && seat === MEDIATOR) return bad(400, "Use the mediator route for the mediator seat.");
    }
    if (!m.seats.includes(seat)) return bad(400, `Unknown seat. Seats: ${m.seats.join(", ")}`);
    if (m.joined[seat]) return bad(409, `Seat "${seat}" is already taken.`);
    if (m.phase !== "joining") return bad(409, `Match is in phase "${m.phase}".`);
    const lock = m.seat_wallets?.[seat];
    if (lock && body.payments_enabled !== false && body.payer !== lock)
      return bad(403, `Seat "${seat}" is reserved for wallet ${lock}. Pay from that wallet to claim it.`, { reserved_for: lock });

    const token = randomToken();
    m.joined[seat] = {
      token_hash: await sha256Hex(token),
      joined_at: this.now(),
      paid: !!body.paid,
      paid_by: body.payer,
      payment_hash: typeof body.payment_hash === "string" ? body.payment_hash : undefined,
    };
    const full = m.seats.every((s) => m.joined[s]);
    if (full) this.startPlay();
    await this.save();
    if (full) this.wakeWaiters();
    // Paid seat, table not full yet: hold the request until everyone has joined. The payment only
    // settles if this request succeeds, so if the others never show up, this agent is never charged.
    // The waiter is registered here, inside the lock, so a join that fills the table a moment later can't be missed.
    else if (body.wait) return { pending: true, seat, token, filled: this.waitUntilFull(this.joinWaitMs()) };
    return this.seatResponse(seat, token);
  }

  /**
   * A signed acknowledgment of one accepted step, signed with the same key as receipts.
   * The agent keeps it: if a later receipt contradicts it (a commitment that changed, a forfeit for a step
   * the service had accepted), the two signed documents together prove it to anyone.
   */
  private stepAck(seat: string, step: "join" | "commit" | "reveal" | "submit" | "rematch", details: Record<string, unknown>) {
    const m = this.m!;
    return signReceipt(
      { type: "step-ack", service: "agent-referee", match_id: m.id, tier: m.tier, ...(m.demo ? { demo: true } : {}), seat, step, accepted_at: new Date(this.now()).toISOString(), ...details },
      this.env.SIGNING_KEY,
      this.env.PUBLIC_KEY,
    );
  }

  private async seatResponse(seat: string, token: string) {
    const j = this.m!.joined[seat];
    return json(200, {
      ack: await this.stepAck(seat, "join", { paid_by: j?.paid_by ?? null }),
      seat,
      seat_token: token,
      note: "Keep seat_token secret. It is shown only once and is required for every later step.",
      match: this.publicView(),
    });
  }

  private async finishWaitingJoin(p: PendingJoin, filled: boolean): Promise<Response> {
    const m = await this.load();
    if (!m) return bad(404, "No such match. It may have expired.");
    if (!filled && m.phase === "joining") {
      delete m.joined[p.seat];
      await this.save();
      return bad(408, "The other seat(s) weren't filled in time, so your seat was released and you were not charged. Join again to keep waiting.", {
        waiting_on: m.seats.filter((s) => !m.joined[s]),
        seat_wallets: m.seat_wallets, // if a seat is locked to a mistyped wallet, this is where you'd see it
      });
    }
    return this.seatResponse(p.seat, p.token);
  }

  private waitUntilFull(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve(false);
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(wake);
    });
  }

  private wakeWaiters() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /** Short on purpose: agents sharing a key arrive within seconds. The client retries 3 times (about 1 minute). */
  private joinWaitMs() {
    const s = Number(this.env.JOIN_WAIT_SECONDS || 15);
    return (Number.isFinite(s) && s > 0 ? Math.min(s, 60) : 15) * 1000;
  }

  /** Re-issue a seat to the agent that paid for it, proven by the hash of its original payment header. */
  private async recover(body: any) {
    const m = this.m!;
    const hash = body?.payment_hash;
    const entry = Object.entries(m.joined).find(([, j]) => j.payment_hash && j.payment_hash === hash);
    if (!entry) return bad(404, "No seat in this match was paid for with that payment.");
    const [seat, j] = entry;
    if (m.phase === "done" || m.phase === "expired")
      return json(200, { seat, note: "This match is already over, so no token is needed: the result and receipt are public.", match: this.publicView() });
    const token = randomToken();
    j.token_hash = await sha256Hex(token); // the old token stops working
    await this.save();
    return json(200, {
      seat,
      seat_token: token,
      note: "Seat recovered with a new seat_token. Any earlier token for this seat no longer works.",
      match: this.publicView(),
    });
  }

  private startPlay() {
    const m = this.m!;
    if (isJudgeTier(m.tier)) {
      m.phase = "submit";
      m.submissions = {};
    } else {
      m.phase = "commit";
      m.rounds.push({ commits: {}, reveals: {} });
    }
    m.action_deadline = this.now() + this.revealWindowMs();
  }

  private committers(): string[] {
    const m = this.m!;
    const all = m.tier === "draw" ? m.seats : m.parties;
    return m.excluded?.length ? all.filter((s) => !m.excluded!.includes(s)) : all;
  }

  private async auth(body: any): Promise<string | Response> {
    const m = this.m!;
    if (!body || typeof body.seat !== "string" || typeof body.seat_token !== "string")
      return bad(400, "seat and seat_token are required.");
    const j = m.joined[body.seat];
    if (!j || j.token_hash !== (await sha256Hex(body.seat_token))) return bad(403, "Invalid seat or seat_token.");
    return body.seat;
  }

  private async commit(body: any) {
    const m = this.m!;
    const seat = await this.auth(body);
    if (seat instanceof Response) return seat;
    if (m.phase !== "commit") return bad(409, `Not accepting commitments (phase "${m.phase}").`);
    if (!this.committers().includes(seat)) return bad(400, "This seat does not commit in this match.");
    const c = body.commitment;
    if (typeof c !== "string" || !/^[0-9a-f]{64}$/.test(c))
      return bad(400, "commitment must be sha256_hex(value + \":\" + nonce), 64 lowercase hex chars.");
    const round = m.rounds[m.rounds.length - 1];
    if (round.commits[seat]) return bad(409, "Already committed this round.");
    round.commits[seat] = c;
    const ack = await this.stepAck(seat, "commit", { round: m.rounds.length, commitment: c });
    if (this.committers().every((s) => round.commits[s])) {
      m.phase = "reveal";
      m.action_deadline = undefined;
      m.reveal_deadline = this.now() + this.revealWindowMs();
    }
    await this.save();
    return json(200, { ok: true, ack, match: this.publicView() });
  }

  private async reveal(body: any) {
    const m = this.m!;
    const seat = await this.auth(body);
    if (seat instanceof Response) return seat;
    if (m.phase !== "reveal") return bad(409, `Not accepting reveals (phase "${m.phase}").`);
    const round = m.rounds[m.rounds.length - 1];
    if (!round.commits[seat]) return bad(400, "This seat has no commitment this round.");
    if (round.reveals[seat]) return bad(409, "Already revealed this round.");
    const err = validateRevealValue(m.tier, body.value);
    if (err) return bad(400, err);
    if (typeof body.nonce !== "string" || body.nonce.length < LIMITS.minNonce || body.nonce.length > LIMITS.maxValue)
      return bad(400, `nonce must be a string of ${LIMITS.minNonce}+ characters.`);
    if ((await commitmentOf(body.value, body.nonce)) !== round.commits[seat])
      return bad(400, "value and nonce do not match your commitment.");
    round.reveals[seat] = { value: body.value, nonce: body.nonce };
    const ack = await this.stepAck(seat, "reveal", { round: m.rounds.length, commitment: round.commits[seat], value: body.value, nonce: body.nonce });
    if (this.committers().every((s) => round.reveals[s])) await this.resolveRound([]);
    await this.save();
    return json(200, { ok: true, ack, match: this.publicView() });
  }

  private async submit(body: any): Promise<Response | JudgeTask> {
    const m = this.m!;
    const seat = await this.auth(body);
    if (seat instanceof Response) return seat;
    if (m.phase !== "submit") return bad(409, `Not accepting submissions (phase "${m.phase}").`);
    if (isMultiJudgeTier(m.tier)) {
      // Checked before anything changes: a refused submit leaves the seat free to submit again before the deadline.
      if (m.submissions![seat] !== undefined) return bad(409, "Already submitted.");
      const v = validateMultiSubmit(body, m.tier);
      if (!v.ok) return bad(400, v.error);
      const records = await sidePieceRecords(v.texts);
      const hash = await sidePiecesSha256(records);
      m.pieces ??= {};
      m.pieces[seat] = v.texts;
      m.submissions![seat] = hash;
      const ack = await this.stepAck(seat, "submit", { receipt_format: MULTI_JUDGE_RECEIPT_FORMAT, pieces: records, pieces_sha256: hash });
      return this.afterSubmit(ack);
    }
    if ("pieces" in (body ?? {})) return bad(400, `${m.tier} takes one "position" per side; pieces are for judge-3x2 and judge-3x3.`);
    const p = body.position;
    if (typeof p !== "string" || p.trim().length === 0 || p.length > LIMITS.maxPosition)
      return bad(400, `position must be 1 to ${LIMITS.maxPosition} characters.`);
    if (m.submissions![seat] !== undefined) return bad(409, "Already submitted.");
    m.submissions![seat] = p;
    const ack = await this.stepAck(seat, "submit", { position_sha256: await sha256Hex(p) });
    return this.afterSubmit(ack);
  }

  /** After an accepted submit: start judging once every side is in. */
  private async afterSubmit(ack: Receipt): Promise<Response | JudgeTask> {
    const m = this.m!;
    if (m.parties.every((s) => m.submissions![s] !== undefined)) {
      m.action_deadline = undefined;
      const started = await this.startJudging();
      if (started instanceof Response) return json(started.status, { ...((await started.json()) as object), ack });
      return { ...started, ack };
    }
    await this.save();
    return json(200, { ok: true, ack, match: this.publicView() });
  }

  private async retryJudge(body: any): Promise<Response | JudgeTask> {
    const seat = await this.auth(body);
    if (seat instanceof Response) return seat;
    const m = this.m!;
    if (m.phase !== "error" || !isJudgeTier(m.tier)) return bad(409, "Nothing to retry.");
    if (m.error_code === "unjudged")
      return bad(409, `Judging failed ${MAX_JUDGE_RUNS} times, so this match won't be retried again. The seats that paid are on the operator's refund list; contact hello@agentreferee.ai with the match id.`, { match: this.publicView() });
    return this.startJudging();
  }

  /**
   * Mutual rematch (random tiers): each party asks after the result; when all have asked, the next game of the series
   * is created with the same settings, and every paid seat is locked to the wallet that paid for it in this game.
   * Each game is still a normal match (joined and paid per seat). Its receipt carries the running tally and this
   * receipt's hash, so the whole series can be checked from the receipts alone.
   */
  private async requestRematch(body: any) {
    const m = this.m!;
    const seat = await this.auth(body);
    if (seat instanceof Response) return seat;
    if (!REMATCH_TIERS.includes(m.tier)) return bad(400, `Rematch is available for ${REMATCH_TIERS.join(", ")}.`);
    if (m.host_pays) return bad(400, "Rematch isn't available for invite matches yet. The host can create a new invite match.");
    if (!m.parties.includes(seat)) return bad(400, "Only the parties can ask for a rematch.");
    if (m.phase !== "done" || !m.receipt) return bad(409, "A rematch can be asked for once this match is decided.");
    const game = m.series?.game ?? 1;
    if (!m.rematch?.next_match_id && game >= MAX_SERIES_GAMES)
      return bad(409, `This series has reached ${MAX_SERIES_GAMES} games. Start a new match to keep going.`, { tally: m.tally_after });
    m.rematch ??= { requested_by: [] };
    if (!m.rematch.requested_by.includes(seat)) m.rematch.requested_by.push(seat);
    if (!m.rematch.next_match_id && m.parties.every((s) => m.rematch!.requested_by.includes(s))) {
      if (!this.env.MATCHES) return bad(503, "Rematch is not available on this server.");
      const nextId = (await sha256Hex(`agent-referee-rematch:${m.id}`)).slice(0, 24);
      // Lock the next game's seats to the wallets that paid this time, so nobody else can take them.
      const payers = m.parties.map((s) => m.joined[s]?.paid_by);
      const lock =
        m.seat_wallets ??
        (payers.every(Boolean) && new Set(payers).size === payers.length ? Object.fromEntries(m.parties.map((s, i) => [s, payers[i]!])) : undefined);
      const series: SeriesInfo = {
        series_id: m.series?.series_id ?? m.id,
        game: game + 1,
        previous_match_id: m.id,
        previous_receipt_sha256: await sha256Hex(canonicalJson(m.receipt.payload)),
        tally_before: m.tally_after!,
      };
      const input = { tier: m.tier, seats: m.parties, title: m.title, weights: m.weights, step_seconds: m.step_seconds, demo: m.demo, seat_wallets: lock };
      const stub = this.env.MATCHES.get(this.env.MATCHES.idFromName(nextId));
      const res = await stub.fetch("https://match/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: nextId, input, series }) });
      if (res.status !== 201 && res.status !== 409) return bad(502, "Couldn't create the rematch. Try again.");
      m.rematch.next_match_id = nextId;
    }
    const ack = await this.stepAck(seat, "rematch", { game, next_match_id: m.rematch.next_match_id ?? null });
    await this.save();
    return json(200, {
      ok: true,
      ack,
      rematch: {
        requested_by: m.rematch.requested_by,
        waiting_on: m.parties.filter((s) => !m.rematch!.requested_by.includes(s)),
        next_match_id: m.rematch.next_match_id,
        note: m.rematch.next_match_id ? "Join next_match_id like any match (each game is paid per seat)." : "Waiting for the other party to ask for a rematch too.",
      },
      match: this.publicView(),
    });
  }

  // ---------- resolution ----------

  /** Inside the lock: mark the match "judging" and hand back what the judge needs. */
  private async startJudging(): Promise<Response | JudgeTask> {
    const m = this.m!;
    m.error = undefined;
    m.error_code = undefined;
    m.retry_at = undefined;
    const needed = m.judge ? (m.judge.panel ?? [{ model: m.judge.model }]).map((p) => p.model) : [this.env.JUDGE_MODEL || "claude-haiku-5-5"];
    const missing = missingJudgeKey(this.env, needed);
    if (missing) {
      m.phase = "error";
      m.error = `Judge is not configured on this server (missing ${missing}).`;
      await this.save();
      return json(200, { ok: true, match: this.publicView() });
    }
    // Older matches created before judge commitments existed get one now.
    if (!m.judge) m.judge = await judgeCommitment(this.env.JUDGE_MODEL || "claude-haiku-5-5");
    const seats = m.judge.panel ?? [{ model: m.judge.model, order: "sorted" as const }];
    if (!m.panel_votes || m.panel_votes.length !== seats.length) m.panel_votes = seats.map(() => null);
    // Only panelists without a verdict run (on a retry, verdicts already given are kept, never re-rolled).
    const jobs = seats.map((p, index) => ({ index, model: p.model, order: p.order })).filter((j) => !m.panel_votes![j.index]);
    m.phase = "judging"; // duplicate or late requests see this and don't start a second judge call
    m.judging_since = this.now();
    await this.save();
    return {
      judge: true,
      jobs,
      formatVersion: m.judge.format_version,
      rules: m.rules!,
      title: m.title,
      criteria: m.judge.format_version === JUDGE_FORMAT_VERSION_V2 ? undefined : m.criteria,
      submissions: { ...m.submissions! },
      ...(isMultiJudgeTier(m.tier) ? { pieces: structuredClone(m.pieces!), maxTokens: m.judge.max_tokens } : {}),
    };
  }

  /** Inside the lock again: record each panelist's verdict (or failure), then combine them with the published rule. */
  private async finishJudging(outcomes: { index: number; vote: JudgeVote | null; error?: string }[]): Promise<Response> {
    const m = await this.load();
    if (!m) return bad(404, "No such match. It may have expired.");
    if (m.phase !== "judging") return json(200, { ok: true, match: this.publicView() });
    for (const o of outcomes) if (o.vote) m.panel_votes![o.index] = o.vote;
    if (outcomes.length) m.judge_runs = (m.judge_runs ?? 0) + 1;
    const failures = outcomes.filter((o) => !o.vote);
    if (failures.length) {
      m.phase = "error";
      const who = m.judge?.panel ? `${failures.length} of ${m.judge.panel.length} judges failed (${failures[0].error})` : `Judge failed: ${failures[0].error}`;
      if ((m.judge_runs ?? 0) >= MAX_JUDGE_RUNS) {
        m.error_code = "unjudged";
        m.retry_at = undefined;
        m.error = `${who}. Judging has failed ${m.judge_runs} times, so it won't be retried again. The seats that paid are on the operator's refund list; contact hello@agentreferee.ai with the match id.`;
        await this.listIfUnjudged(`judging failed ${m.judge_runs} times: ${String(failures[0].error).slice(0, 200)}`);
        await this.state.storage.setAlarm(m.delete_at);
      } else {
        m.error_code = "judge_failed";
        const wait = this.scheduleRetry(0);
        m.error = `${who}. The match retries judging on its own in about ${Math.round(wait / 1000)} s (${MAX_JUDGE_RUNS - (m.judge_runs ?? 0)} tries left), or any seated party can POST /matches/${m.id}/retry-judge${m.judge?.panel ? "; verdicts already given are kept" : ""}.`;
      }
      await this.save();
      return json(200, { ok: true, match: this.publicView() });
    }
    m.error_code = undefined;
    m.retry_at = undefined;
    const votes = m.panel_votes as JudgeVote[];
    const criteria = m.judge?.format_version === JUDGE_FORMAT_VERSION_V2 ? undefined : m.criteria;
    const rule = m.judge?.decision_rule ?? "single";
    const decision = decide(rule, votes.map((v) => votePick(v, criteria)), [...m.parties].sort());
    const multi = isMultiJudgeTier(m.tier);
    const subHashes: Record<string, string> = {};
    if (!multi) for (const s of m.parties) subHashes[s] = await sha256Hex(m.submissions![s]);
    const mistrial = decision.winner === null
      ? rule === "single"
        ? {
            mistrial: true,
            mistrial_reason: votes[0].mistrial_reason ?? (criteria ? "The criteria scores were tied." : decision.mistrial_reason),
            mistrial_code: votes[0].mistrial_code ?? (criteria ? "score_tie" : decision.mistrial_code),
            escalate_to_owners: true,
          }
        : { mistrial: true, mistrial_reason: decision.mistrial_reason, mistrial_code: decision.mistrial_code, escalate_to_owners: true }
      : {};
    let outcome: Record<string, unknown>;
    if (rule === "single") {
      const v = votes[0];
      outcome = {
        winner: decision.winner,
        ...mistrial,
        confidence: v.confidence,
        rule_applied: v.rule_applied,
        reasoning: v.reasoning,
        judge_model: v.model,
        ...(v.model_reported ? { judge_model_reported: v.model_reported } : {}),
        ...(v.scores ? { scores: v.scores, totals: v.totals, criteria } : {}),
      };
    } else {
      outcome = { winner: decision.winner, ...mistrial, decision_rule: rule, tally: decision.tally, votes, ...(criteria ? { criteria } : {}) };
    }
    await this.finish(outcome, {
      rules_sha256: await sha256Hex(m.rules!),
      ...(criteria ? { criteria_sha256: await sha256Hex(canonicalJson(criteria)) } : {}),
      // judge-multi-v1: each side's pieces and pieces_sha256 replace submission_sha256.
      ...(multi ? await piecesProof(m.pieces!, m.parties) : { submission_sha256: subHashes }),
      judge: m.judge, // model(s), prompt fingerprint and decision rule; full prompt at GET /judge
    });
    await this.save();
    return json(200, { ok: true, match: this.publicView() });
  }

  /** forfeited: seats that committed but never revealed before the deadline. */
  private async resolveRound(forfeited: string[]) {
    const m = this.m!;
    const r = m.rounds[m.rounds.length - 1];
    const roundNo = m.rounds.length;

    if (m.tier === "rps" || m.tier === "rps-bo3") {
      const [a, b] = m.parties;
      if (forfeited.length) {
        const winner = m.parties.find((s) => !forfeited.includes(s))!;
        r.winner = winner;
        return this.finish({ winner, by_forfeit: true, forfeited }, this.rpsProof());
      }
      const res = rpsResult(r.reveals[a].value as Move, r.reveals[b].value as Move);
      r.winner = res === -1 ? null : m.parties[res];
      const wins = this.rpsWins();
      const target = m.tier === "rps" ? 1 : 2;
      const champ = m.parties.find((s) => wins[s] >= target);
      if (champ) return this.finish({ winner: champ, score: wins, rounds_played: roundNo }, this.rpsProof());
      if (roundNo >= MAX_RPS_ROUNDS)
        return this.finish({ winner: null, no_result: "too many tied rounds", score: wins }, this.rpsProof());
      m.phase = "commit"; // tie (or bo3 not decided): next round, no extra charge
      m.reveal_deadline = undefined;
      m.action_deadline = this.now() + this.revealWindowMs();
      m.rounds.push({ commits: {}, reveals: {} });
      return;
    }

    // weighted + draw: combine every revealed seed
    const seeds: Record<string, string> = {};
    for (const s of Object.keys(r.reveals)) seeds[s] = r.reveals[s].value;

    if (m.tier === "weighted") {
      if (forfeited.length) {
        const winner = m.parties.find((s) => !forfeited.includes(s))!;
        return this.finish({ winner, by_forfeit: true, forfeited }, { commits: r.commits, reveals: r.reveals });
      }
      const { hex, value } = await combinedRandom(m.id, roundNo, seeds);
      r.combined_hex = hex;
      const winner = weightedPick(m.weights!, value);
      return this.finish(
        { winner, weights: m.weights },
        { commits: r.commits, reveals: r.reveals, combined_sha256: hex, method: "sha256(match_id|round|seat=seed|... sorted) → first 64 bits mod total weight → sorted seats" },
      );
    }

    // draw
    const { hex, value } = await combinedRandom(m.id, roundNo, seeds);
    r.combined_hex = hex;
    const idx = drawPick(m.options!, value);
    return this.finish(
      (() => {
        const all = [...(m.excluded ?? []), ...forfeited];
        return { picked_index: idx, picked_option: m.options![idx], options: m.options, ...(all.length ? { forfeited: all } : {}) };
      })(),
      { commits: r.commits, reveals: r.reveals, combined_sha256: hex, method: "sha256(match_id|round|seat=seed|... sorted) → first 64 bits mod number of options" },
    );
  }

  private rpsWins(): Record<string, number> {
    const m = this.m!;
    const wins: Record<string, number> = Object.fromEntries(m.parties.map((s) => [s, 0]));
    for (const r of m.rounds) if (r.winner) wins[r.winner]++;
    return wins;
  }

  private rpsProof() {
    return {
      rounds: this.m!.rounds.map((r, i) => ({ round: i + 1, commits: r.commits, reveals: r.reveals, winner: r.winner ?? null })),
    };
  }

  private async finish(outcome: Record<string, unknown>, proof: Record<string, unknown>) {
    const m = this.m!;
    m.phase = "done";
    m.reveal_deadline = undefined;
    m.action_deadline = undefined;
    m.result = outcome;
    if (REMATCH_TIERS.includes(m.tier)) {
      // Running tally for a rematch series (a first match is game 1 of its own series).
      const t: Tally = structuredClone(m.series?.tally_before ?? { games: 0, wins: Object.fromEntries(m.parties.map((s) => [s, 0])), no_result: 0 });
      t.games++;
      const w = outcome.winner as string | null | undefined;
      if (w && m.parties.includes(w)) t.wins[w] = (t.wins[w] ?? 0) + 1;
      else t.no_result++;
      m.tally_after = t;
    }
    const payload = {
      service: "agent-referee",
      ...(isMultiJudgeTier(m.tier) ? { receipt_format: MULTI_JUDGE_RECEIPT_FORMAT } : {}),
      match_id: m.id,
      tier: m.tier,
      title: m.title ?? null,
      demo: m.demo ? true : undefined, // signed, so a demo result can never pass for a paid one
      parties: m.parties,
      decided_at: new Date(this.now()).toISOString(),
      outcome,
      proof,
      seat_wallets: m.seat_wallets,
      host_pays: m.host_pays, // invite match: this seat's wallet paid for both seats
      paid_by: Object.fromEntries(Object.entries(m.joined).filter(([, j]) => j.paid_by).map(([seat, j]) => [seat, j.paid_by])),
      commitment_format: isJudgeTier(m.tier) ? undefined : 'sha256_hex(value + ":" + nonce)',
      series: m.tally_after
        ? m.series
          ? { series_id: m.series.series_id, game: m.series.game, previous_match_id: m.series.previous_match_id, previous_receipt_sha256: m.series.previous_receipt_sha256, tally: m.tally_after, max_games: MAX_SERIES_GAMES }
          : undefined
        : undefined,
      // Each paying agent's updated record and badges, after this match.
      standings: await this.recordOutcomes(outcome),
    };
    m.receipt = await signReceipt(payload, this.env.SIGNING_KEY, this.env.PUBLIC_KEY);
  }

  /** Who won, lost, completed or forfeited, by paying wallet. */
  private outcomeUpdates(outcome: Record<string, unknown>): RecordUpdate[] {
    const m = this.m!;
    const wallets = Object.entries(m.joined).filter(([, j]) => j.paid_by).map(([seat, j]) => [seat, j.paid_by!] as const);
    // The same wallet in two seats is playing itself: never counts toward records.
    if (new Set(wallets.map(([, w]) => w)).size !== wallets.length) return [];
    const kind = isJudgeTier(m.tier) ? "judge" : "luck";
    const forfeited = (outcome.forfeited as string[] | undefined) ?? [];
    const winner = outcome.winner as string | null | undefined;
    return wallets.map(([seat, wallet]) => ({
      wallet,
      kind,
      outcome: forfeited.includes(seat)
        ? "forfeit"
        : winner && m.parties.includes(seat)
          ? seat === winner ? "win" : "loss"
          : "completed",
    }));
  }

  private async recordOutcomes(outcome: Record<string, unknown>) {
    if (this.m?.demo) return undefined; // demo matches never touch anyone's record
    const ledger = this.env.LEDGER;
    const updates = this.outcomeUpdates(outcome);
    if (!ledger || !updates.length) return undefined;
    try {
      const res = await ledger.get(ledger.idFromName("global")).fetch("https://ledger/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const data: any = await res.json();
      // Keep receipts compact: the record counts and badge names per wallet. Private records stay out.
      return Object.fromEntries(
        Object.entries(data.records ?? {}).filter(([, r]: [string, any]) => !r.private).map(([w, r]: [string, any]) => [
          w,
          {
            judge: `${r.judge_wins}-${r.judge_losses}`,
            luck: `${r.luck_wins}-${r.luck_losses}`,
            completed: r.completed,
            forfeits: r.forfeits,
            badges: (r.badges ?? []).map((b: any) => b.name),
          },
        ]),
      );
    } catch {
      return undefined; // a ledger hiccup must never block a result
    }
  }

  /** Apply deadlines lazily whenever the match is touched. */
  private async tick() {
    const m = this.m!;
    const now = this.now();
    if (m.phase === "judging" && m.judging_since && now - m.judging_since > (isMultiJudgeTier(m.tier) ? MULTI_JUDGE_TIMEOUT_MS : JUDGE_TIMEOUT_MS)) {
      m.phase = "error";
      m.error = `The judge didn't return a verdict in time. Any seated party can POST /matches/${m.id}/retry-judge.`;
      await this.save();
      return;
    }
    if (m.phase === "reveal" && m.reveal_deadline && now > m.reveal_deadline) {
      const r = m.rounds[m.rounds.length - 1];
      const forfeited = this.committers().filter((s) => !r.reveals[s]);
      const revealed = this.committers().filter((s) => r.reveals[s]);
      const mediatorOnly = m.tier === "draw" && revealed.every((s) => s === MEDIATOR);
      if (revealed.length === 0 || mediatorOnly) {
        m.phase = "expired";
        m.error = "Nobody revealed in time.";
        await this.recordOutcomes({ forfeited });
      } else {
        await this.resolveRound(forfeited);
      }
      await this.save();
      return;
    }
    if ((m.phase === "commit" || m.phase === "submit") && m.action_deadline && now > m.action_deadline) {
      await this.actionTimeout();
      await this.save();
      return;
    }
    if (["joining", "commit", "submit"].includes(m.phase) && now > m.expires_at) {
      m.phase = "expired";
      m.error = "Match was not completed within 24 hours.";
      await this.save();
    }
  }

  /** Someone joined but never committed (or never submitted, in the judge tier) before the deadline. */
  private async actionTimeout() {
    const m = this.m!;
    m.action_deadline = undefined;
    if (m.phase === "submit") {
      const missing = m.parties.filter((s) => m.submissions![s] === undefined);
      const present = m.parties.filter((s) => m.submissions![s] !== undefined);
      if (present.length === 0) {
        m.phase = "expired";
        m.error = "Neither side submitted in time.";
        await this.recordOutcomes({ forfeited: missing });
        return;
      }
      // One side showed up and the other walked away: the side that submitted wins by forfeit.
      // Multi-part tiers: the receipt also shows the present side's pieces (so its ack can be checked against it) and
      // the agreed judges (so it says which format and panel the match was under).
      const shown = isMultiJudgeTier(m.tier) ? { ...(await piecesProof(m.pieces!, present)), judge: m.judge } : {};
      return this.finish({ winner: present[0], by_forfeit: true, forfeited: missing }, { rules_sha256: await sha256Hex(m.rules!), ...shown });
    }
    const r = m.rounds[m.rounds.length - 1];
    const missing = this.committers().filter((s) => !r.commits[s]);
    const committed = this.committers().filter((s) => r.commits[s]);
    if (m.tier === "draw") {
      const partiesLeft = committed.filter((s) => s !== MEDIATOR);
      if (partiesLeft.length === 0) {
        m.phase = "expired";
        m.error = "No party committed in time.";
        await this.recordOutcomes({ forfeited: [...(m.excluded ?? []), ...missing] });
        return;
      }
      // The draw goes on without the seats that walked away.
      m.excluded = [...(m.excluded ?? []), ...missing];
      m.phase = "reveal";
      m.reveal_deadline = this.now() + this.revealWindowMs();
      return;
    }
    if (committed.length === 0) {
      m.phase = "expired";
      m.error = "Neither side committed in time.";
      await this.recordOutcomes({ forfeited: missing });
      return;
    }
    // Two-seat tiers: the side that committed wins by forfeit.
    const winner = committed[0];
    r.winner = winner;
    const proof = m.tier === "weighted" ? { commits: r.commits, reveals: r.reveals } : this.rpsProof();
    return this.finish({ winner, by_forfeit: true, forfeited: missing }, proof);
  }

  private revealWindowMs() {
    if (this.m?.step_seconds) return this.m.step_seconds * 1000;
    const s = Number(this.env.REVEAL_WINDOW_SECONDS || 600);
    return (Number.isFinite(s) && s > 0 ? s : 600) * 1000;
  }

  /** What anyone can see: never unrevealed values or unjudged submissions. */
  publicView() {
    const m = this.m!;
    const cur = m.rounds[m.rounds.length - 1];
    const done = m.phase === "done";
    const judgeTier = isJudgeTier(m.tier);
    const committers = judgeTier ? [] : this.committers();
    return {
      match_id: m.id,
      key: m.key,
      tier: m.tier,
      title: m.title ?? null,
      demo: m.demo || undefined,
      phase: m.phase,
      seats: m.seats.map((s) => ({ seat: s, joined: !!m.joined[s] })),
      weights: m.weights,
      options: m.options,
      rules: m.rules,
      criteria: m.criteria,
      panel: m.panel, // the panel request both agents agreed to (the drawn result is judge.panel)
      judge: m.judge,
      seat_wallets: m.seat_wallets,
      host_pays: m.host_pays,
      round: judgeTier ? undefined : m.rounds.length || undefined,
      waiting_on:
        m.phase === "joining"
          ? m.seats.filter((s) => !m.joined[s])
          : m.phase === "commit"
            ? committers.filter((s) => !cur.commits[s])
            : m.phase === "reveal"
              ? committers.filter((s) => !cur.reveals[s])
              : m.phase === "submit"
                ? m.parties.filter((s) => m.submissions![s] === undefined)
                : [],
      reveal_deadline: m.reveal_deadline ? new Date(m.reveal_deadline).toISOString() : undefined,
      action_deadline: m.action_deadline ? new Date(m.action_deadline).toISOString() : undefined,
      step_seconds: m.step_seconds ?? Number(this.env.REVEAL_WINDOW_SECONDS || 600),
      excluded: m.excluded?.length ? m.excluded : undefined,
      score: m.tier === "rps-bo3" ? this.rpsWins() : undefined,
      expires_at: new Date(m.expires_at).toISOString(),
      result: done ? m.result : undefined,
      receipt: done ? m.receipt : undefined,
      series: m.series ? { series_id: m.series.series_id, game: m.series.game, previous_match_id: m.series.previous_match_id, tally_before: m.series.tally_before } : undefined,
      tally: done ? m.tally_after : undefined,
      rematch: REMATCH_TIERS.includes(m.tier)
        ? {
            available: done && !m.host_pays && (m.series?.game ?? 1) < MAX_SERIES_GAMES && !m.rematch?.next_match_id,
            requested_by: m.rematch?.requested_by ?? [],
            next_match_id: m.rematch?.next_match_id,
          }
        : undefined,
      error: m.error,
      error_code: m.error_code,
      retry_at: m.retry_at ? new Date(m.retry_at).toISOString() : undefined,
      judge_runs: judgeTier && m.judge_runs ? m.judge_runs : undefined,
    };
  }
}
