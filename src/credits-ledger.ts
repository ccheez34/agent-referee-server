// Credit packs: the balances, in the one dedicated Ledger object named "credits" (spec v2 §3,
// research\specs\credit-packs\credit-packs-spec.md). Every balance change runs through that object's serialized chain
// (Ledger.fetch), so each action here is one read-check-write that nothing can interleave.
//
// The core money rule (spec §3, "Reservations"): credits never reset, so a lost reservation would take a buyer's money
// for nothing. A review's price moves from balance to held under a token the Worker made; success commits it, anything
// else releases it, and the alarm releases any hold older than 10 minutes. A release that arrives before its reserve
// leaves a tombstone, so the late reserve is refused.
//
// Amounts are integers in micro-USD at list price: $1 = 1,000,000 micro-credits, one cent = 10,000. No floats are
// stored. Nothing here talks to Stripe: the Worker verifies events and passes the parts that matter.
import type { DOStorage } from "./types.ts";
import { stripeKeyKind } from "./stripe.ts";

export const MICRO_PER_USD = 1_000_000;
export const MICRO_PER_CENT = 10_000;
/** A hold older than this is released by the alarm (a review never takes this long; the worst case is a few minutes). */
export const HOLD_MAX_MS = 10 * 60_000;
/** Released and committed markers (and tombstones) are kept this long, then deleted by the alarm. */
export const MARKER_KEEP_MS = 60 * 60_000;
/** A claim code (lost key) works once, for this long. */
export const CLAIM_TTL_MS = 24 * 60 * 60_000;
/** Open checkouts are cleared this long after Stripe's own expiry (clock differences). */
const PENDING_GRACE_MS = 60_000;
/** Most due entries one alarm run settles; more makes it run again a second later. */
export const SWEEP_LIMIT = 2_000;

// ---------- configuration (read from the Ledger's env, never from a request) ----------

export type CreditsMode = "off" | "test" | "live" | "misconfigured";

export type CreditsConfig = {
  enabled: boolean;
  live: boolean;
  mode: CreditsMode;
  /** Why the mode is "misconfigured" (for logs and the operator; never includes a key). */
  problem?: string;
  /** Pack name -> price in cents. Price and credit value are identical: no bonus credits in v1. */
  packs: Map<string, number>;
  maxBalanceMicro: number;
  maxDailyMicro: number;
  maxOpenPerIp: number;
};

type CreditsEnv = {
  CREDITS_ENABLED?: string;
  CREDITS_LIVE?: string;
  CREDITS_PACKS?: string;
  CREDITS_MAX_BALANCE_USD?: string;
  CREDITS_MAX_DAILY_USD?: string;
  STRIPE_SECRET_KEY?: string;
};

export const DEFAULT_PACKS = "small=10,medium=25,large=100";

/** "small=10,medium=25,large=100" (USD, up to 2 decimals) -> name -> cents. Bad entries are skipped. */
export function parsePacks(v: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  const raw = String(v ?? "").trim() || DEFAULT_PACKS;
  for (const part of raw.split(",")) {
    const m = part.trim().match(/^([a-z0-9_-]{1,20})=(\d{1,5}(?:\.\d{1,2})?)$/);
    if (!m || out.has(m[1])) continue;
    const cents = Math.round(Number(m[2]) * 100);
    if (cents >= 100) out.set(m[1], cents); // at least $1
  }
  return out;
}

const usdSetting = (v: string | undefined, d: number) => {
  const s = String(v ?? "").trim();
  const n = Number(s);
  return s !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

export function creditsConfig(env: CreditsEnv): CreditsConfig {
  const enabled = env.CREDITS_ENABLED === "true";
  const live = env.CREDITS_LIVE === "true";
  const kind = stripeKeyKind(env.STRIPE_SECRET_KEY);
  // A live key without the live switch, a test key with it, or a key of no known shape: refuse rather than guess.
  const problem =
    kind === "unknown"
      ? "STRIPE_SECRET_KEY isn't a Stripe secret or restricted key"
      : kind === "live" && !live
        ? "a live Stripe key is set but CREDITS_LIVE isn't"
        : kind === "test" && live
          ? "CREDITS_LIVE is set but the Stripe key is a test key"
          : undefined;
  return {
    enabled,
    live,
    mode: problem ? "misconfigured" : !enabled ? "off" : live ? "live" : "test",
    ...(problem ? { problem } : {}),
    packs: parsePacks(env.CREDITS_PACKS),
    maxBalanceMicro: Math.round(usdSetting(env.CREDITS_MAX_BALANCE_USD, 500) * MICRO_PER_USD),
    maxDailyMicro: Math.round(usdSetting(env.CREDITS_MAX_DAILY_USD, 500) * MICRO_PER_USD),
    maxOpenPerIp: 3,
  };
}

/** The checks before any credit is added (spec §5.2 step 2). A mismatch means "held": nothing credited, fixed by hand. */
export function checkPaidSession(s: any, cfg: Pick<CreditsConfig, "packs" | "live">): { ok: true; pack: string; cents: number; credits_micro: number } | { ok: false; reason: string } {
  if (!s || typeof s !== "object") return { ok: false, reason: "no_session" };
  if (s.object !== undefined && s.object !== "checkout.session") return { ok: false, reason: "not_a_checkout_session" };
  if (s.livemode !== cfg.live) return { ok: false, reason: "livemode_mismatch" };
  if (s.mode !== "payment") return { ok: false, reason: "not_payment_mode" };
  if (s.payment_status !== "paid") return { ok: false, reason: "not_paid" };
  if (s.currency !== "usd") return { ok: false, reason: "wrong_currency" };
  const pack = s.metadata?.pack;
  if (typeof pack !== "string" || !cfg.packs.has(pack)) return { ok: false, reason: "unknown_pack" };
  const cents = cfg.packs.get(pack)!;
  if (s.amount_subtotal !== cents) return { ok: false, reason: "wrong_amount" };
  // Checkout here never allows promotion codes, but if a discount ever appears, a $10 pack must not sell for less.
  if ((Number.isFinite(s.amount_discount) && s.amount_discount > 0) || (Number.isFinite(s.amount_total) && s.amount_total < cents)) return { ok: false, reason: "discounted" };
  return { ok: true, pack, cents, credits_micro: cents * MICRO_PER_CENT };
}

// ---------- records ----------

export type CreditsAccount = {
  key_hash: string | null; // SHA-256 of the current key; null until one is revealed or claimed
  balance_micro: number;
  held_micro: number; // reserved by reviews in flight
  shortfall_micro: number; // refunded or disputed credits that were already spent; releases pay it down first
  pending_micro: number; // open checkouts for this account (counted against the caps)
  created_at: string;
  frozen: boolean;
  frozen_reason: string | null;
  total_bought_micro: number;
  total_spent_micro: number;
  bought_day: string; // the UTC day bought_day_micro counts
  bought_day_micro: number;
  reveal_closed: boolean; // set by a rotate: the purchase page can't reveal a key any more
  claim_hash: string | null; // the one live claim code's hash
  purchases: string[]; // Checkout Session ids, oldest first
};

export type CreditsSession = {
  status: "fulfilled" | "held";
  held_reason?: string;
  account_id: string | null;
  created_account: boolean;
  payment_intent: string | null;
  paid_cents: number;
  credits_micro: number;
  pack: string | null;
  fulfilled_at: string;
  key_shown: boolean;
  reveal_nonce_hash: string | null;
  refunded_cents: number;
  disputed: boolean;
  fraud_warned?: boolean;
  livemode: boolean;
};

type Pending = { account_id: string | null; credits_micro: number; expires_at: number; ip: string | null; pack: string; at: number };
type Hold = { account_id: string; amount_micro: number; at: number };
type Marker = { released: true; at: number } | { committed: true; at: number; account_id: string; amount_micro: number };
type Claim = { account_id: string; expires_at: number };

const blankAccount = (nowIso: string): CreditsAccount => ({
  key_hash: null,
  balance_micro: 0,
  held_micro: 0,
  shortfall_micro: 0,
  pending_micro: 0,
  created_at: nowIso,
  frozen: false,
  frozen_reason: null,
  total_bought_micro: 0,
  total_spent_micro: 0,
  bought_day: nowIso.slice(0, 10),
  bought_day_micro: 0,
  reveal_closed: false,
  claim_hash: null,
  purchases: [],
});

// ---------- input shapes ----------

const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{32}$/;
export const ACCOUNT_ID = /^arca_[0-9a-f]{24}$/;
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,200}$/;
const PAYMENT_INTENT = /^pi_[A-Za-z0-9_]{8,200}$/;
const IP_HASH = /^[0-9a-f]{8,64}$/;
const REF = /^[A-Za-z0-9_]{3,200}$/;

const isAmount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const str = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);

function newAccountId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `arca_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** Constant-time comparison of two hex hashes. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- storage helpers ----------

type R = { status: number; body: Record<string, unknown> };
const ok = (body: Record<string, unknown>): R => ({ status: 200, body });
const no = (status: number, body: Record<string, unknown>): R => ({ status, body });

/**
 * One action's writes, applied together, so a balance never changes without its hold, session or log line (found by
 * the second fresh-agent check, Oct 30: with awaits between puts, a crash could keep some writes and lose others).
 * Reads see the action's own earlier writes. At the end, every put goes in one multi-key put, with the deletes and the
 * alarm issued right after it and nothing awaited in between: Durable Objects apply such writes as one atomic batch
 * (a multi-key put takes up to 128 keys; no action here writes more than about 12). If the action throws, nothing is
 * written.
 */
function txn(st: DOStorage) {
  const puts = new Map<string, unknown>();
  const dels = new Set<string>();
  let alarm: number | undefined;
  const view: DOStorage = {
    async get<T>(k: string): Promise<T | undefined> {
      if (dels.has(k)) return undefined;
      if (puts.has(k)) return structuredClone(puts.get(k)) as T;
      return st.get<T>(k);
    },
    async put(k: string | Record<string, unknown>, v?: unknown) {
      for (const [x, y] of typeof k === "string" ? [[k, v] as const] : Object.entries(k)) {
        dels.delete(x);
        puts.set(x, structuredClone(y));
      }
    },
    async delete(k: string | string[]) {
      for (const x of [k].flat()) {
        puts.delete(x);
        dels.add(x);
      }
      return true;
    },
    async deleteAll() {
      throw new Error("not in a credits action");
    },
    async setAlarm(t: number) {
      alarm = t; // as on a real object, a later call replaces an earlier one
    },
    ...(st.list
      ? {
          // Storage's page, with this action's own writes merged in (the export lists the log after logging itself).
          async list<T>(o: { prefix?: string; start?: string; limit?: number } = {}) {
            const found = await st.list!<T>(o);
            if (!puts.size && !dels.size) return found;
            const all = new Map<string, T>();
            for (const [k, v] of found) if (!dels.has(k)) all.set(k, v);
            for (const [k, v] of puts) if (k.startsWith(o.prefix ?? "") && (!o.start || k >= o.start)) all.set(k, structuredClone(v) as T);
            return new Map([...all.keys()].sort().slice(0, o.limit ?? Infinity).map((k) => [k, all.get(k)!] as [string, T]));
          },
        }
      : {}),
  };
  const commit = async () => {
    const keys = [...puts.keys()];
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < keys.length; i += 128) ops.push(st.put(Object.fromEntries(keys.slice(i, i + 128).map((k) => [k, puts.get(k)]))));
    if (dels.size) ops.push(st.delete ? st.delete([...dels]) : Promise.all([...dels].map((k) => st.put(k, null))));
    if (alarm !== undefined) ops.push(st.setAlarm(alarm));
    await Promise.all(ops);
  };
  return { view, commit };
}

/**
 * The alarm's work list, in due order: cx:<13-digit ms>:<kind>:<id>, where h is a hold to release at 10 minutes, m a
 * marker to delete after an hour, p an open checkout to clear, and c a claim code to expire. A commit, a release, a
 * fulfilment or a claim takes its entry off the list in the same write; anything else left there is checked when it's
 * due. The sweep reads only the entries that are due, oldest first. (It used to page through every cr: key from the
 * start each run, so more than 2,000 young markers could hide a due hold: the second fresh-agent check's finding #1.)
 */
type DueKind = "h" | "m" | "p" | "c";
const DUE_KEY = /^cx:(\d{13}):([hmpc]):([0-9a-f]{32,64})$/;
const dueKey = (at: number, kind: DueKind, id: string) => `cx:${String(Math.max(0, Math.ceil(at))).padStart(13, "0")}:${kind}:${id}`;
async function watch(st: DOStorage, nowMs: number, at: number, kind: DueKind, id: string) {
  await st.put(dueKey(at, kind, id), 1);
  await alarmBy(st, nowMs, at);
}

async function del(st: DOStorage, key: string) {
  if (st.delete) await st.delete(key);
  else await st.put(key, null);
}

async function account(st: DOStorage, id: string | null | undefined): Promise<CreditsAccount | undefined> {
  if (!id) return undefined;
  return (await st.get<CreditsAccount>(`ca:${id}`)) ?? undefined;
}

/** Appends one line to the never-deleted log (cl:<12-digit sequence>). */
async function log(st: DOStorage, nowMs: number, entry: Record<string, unknown>) {
  const seq = ((await st.get<number>("c_seq")) ?? 0) + 1;
  await st.put("c_seq", seq);
  await st.put(`cl:${String(seq).padStart(12, "0")}`, { seq, at: new Date(nowMs).toISOString(), ...entry });
}

/** Makes sure the alarm runs by `when`. The scheduled time is kept in storage (one alarm per object; setting one
 * replaces the other), so a later need never pushes an earlier alarm back. */
async function alarmBy(st: DOStorage, nowMs: number, when: number) {
  const cur = await st.get<number>("c_alarm");
  if (cur !== undefined && cur !== null && cur > nowMs && cur <= when) return;
  await st.setAlarm(when);
  await st.put("c_alarm", when);
}

/** Debits up to `target` from the balance; whatever the balance can't cover becomes shortfall. */
function take(a: CreditsAccount | undefined, target: number): { debit: number; short: number } {
  if (!a || target <= 0) return { debit: 0, short: 0 };
  const debit = Math.min(a.balance_micro, target);
  a.balance_micro -= debit;
  a.shortfall_micro += target - debit;
  return { debit, short: target - debit };
}

/** Gives a hold back: shortfall first, then balance. A frozen account stays frozen. Leaves a released marker. */
async function releaseHold(st: DOStorage, token: string, h: Hold, why: string, nowMs: number) {
  const a = await account(st, h.account_id);
  let paid = 0;
  if (a) {
    a.held_micro = Math.max(0, a.held_micro - h.amount_micro);
    paid = Math.min(h.amount_micro, a.shortfall_micro);
    a.shortfall_micro -= paid;
    a.balance_micro += h.amount_micro - paid;
    await st.put(`ca:${h.account_id}`, a);
  }
  await st.put(`cr:${token}`, { released: true, at: nowMs } satisfies Marker);
  await log(st, nowMs, { type: "release", why, account_id: h.account_id, amount_micro: h.amount_micro, ...(paid ? { shortfall_paid_micro: paid } : {}), token, balance_micro: a?.balance_micro ?? null });
  await del(st, dueKey(h.at + HOLD_MAX_MS, "h", token)); // settled: off the work list
  await watch(st, nowMs, nowMs + MARKER_KEEP_MS, "m", token);
  return { balance_micro: a?.balance_micro ?? 0, shortfall_paid_micro: paid };
}

/** Removes an open checkout: its account's pending amount and its place in the per-address count. Idempotent. */
async function clearPending(st: DOStorage, pendingId: string) {
  const p = await st.get<Pending>(`cp:${pendingId}`);
  if (!p) return false;
  await del(st, `cp:${pendingId}`);
  await del(st, dueKey(p.expires_at + PENDING_GRACE_MS, "p", pendingId)); // off the work list
  const a = await account(st, p.account_id);
  if (a) {
    a.pending_micro = Math.max(0, a.pending_micro - p.credits_micro);
    await st.put(`ca:${p.account_id}`, a);
  }
  if (p.ip) {
    const list = ((await st.get<{ id: string; exp: number }[]>(`cq:${p.ip}`)) ?? []).filter((x) => x.id !== pendingId);
    if (list.length) await st.put(`cq:${p.ip}`, list);
    else await del(st, `cq:${p.ip}`);
  }
  return true;
}

const today = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);
const boughtToday = (a: CreditsAccount, nowMs: number) => (a.bought_day === today(nowMs) ? a.bought_day_micro : 0);

/** What the account's owner and the operator may see (never the key hash or the claim hash). */
export function accountView(id: string, a: CreditsAccount) {
  return {
    account_id: id,
    balance_micro: a.balance_micro,
    held_micro: a.held_micro,
    shortfall_micro: a.shortfall_micro,
    pending_micro: a.pending_micro,
    frozen: a.frozen,
    frozen_reason: a.frozen_reason,
    total_bought_micro: a.total_bought_micro,
    total_spent_micro: a.total_spent_micro,
    created_at: a.created_at,
    has_key: a.key_hash !== null,
  };
}

/** One purchase as the operator sees it, with what could still be refunded: min(paid - refunded, balance), in cents. */
function purchaseView(id: string, s: CreditsSession, a: CreditsAccount | undefined) {
  const left = Math.max(0, s.paid_cents - s.refunded_cents);
  return {
    session_id: id,
    status: s.status,
    ...(s.held_reason ? { held_reason: s.held_reason } : {}),
    pack: s.pack,
    paid_cents: s.paid_cents,
    credits_micro: s.credits_micro,
    refunded_cents: s.refunded_cents,
    disputed: s.disputed,
    fulfilled_at: s.fulfilled_at,
    refundable_cents: s.disputed || s.status !== "fulfilled" ? 0 : Math.min(left, Math.floor((a?.balance_micro ?? 0) / MICRO_PER_CENT)),
  };
}

// ---------- the actions (called only through Ledger.fetch, one at a time) ----------

/** One credits action, its writes applied together at the end (txn above); nothing is written if it throws. */
export async function creditsAction(st: DOStorage, action: string, b: any, cfg: CreditsConfig, nowMs: number): Promise<R> {
  const t = txn(st);
  const r = await act(t.view, action, b, cfg, nowMs);
  await t.commit();
  return r;
}

async function act(st: DOStorage, action: string, b: any, cfg: CreditsConfig, nowMs: number): Promise<R> {
  const nowIso = new Date(nowMs).toISOString();
  if (!(await st.get<boolean>("c_active"))) await st.put("c_active", true); // the alarm sweeps credits only where there are any

  if (action === "credits-auth") {
    // { key_hash } -> the account a key belongs to. A replaced key's hash no longer matches the account's.
    const kh = str(b?.key_hash, HEX64);
    if (!kh) return no(400, { error: "Bad key hash." });
    const id = await st.get<string>(`ck:${kh}`);
    const a = await account(st, id);
    if (!id || !a || a.key_hash === null || !sameHash(a.key_hash, kh)) return no(401, { reason: "unknown_key" });
    return ok(accountView(id, a));
  }

  if (action === "credits-reserve") {
    // { account_id, key_hash, amount_micro, token } -> moves the price from balance to held under the Worker's token.
    const id = str(b?.account_id, ACCOUNT_ID);
    const kh = str(b?.key_hash, HEX64);
    const token = str(b?.token, TOKEN);
    if (!id || !kh || !token || !isAmount(b?.amount_micro)) return no(400, { error: "Bad reserve." });
    const amount = b.amount_micro as number;
    const seen = await st.get<Hold | Marker>(`cr:${token}`);
    // A token is used once. A tombstone means the Worker already gave up on this request: refuse, nothing used.
    if (seen) return no(409, { reason: "released" in seen ? "released" : "token_used" });
    const a = await account(st, id);
    if (!a || a.key_hash === null || !sameHash(a.key_hash, kh)) return no(401, { reason: "unknown_key" });
    if (a.frozen) return no(403, { reason: "frozen", ...accountView(id, a) });
    if (a.balance_micro < amount) return no(429, { reason: "balance", amount_micro: amount, ...accountView(id, a) });
    a.balance_micro -= amount;
    a.held_micro += amount;
    await st.put(`ca:${id}`, a);
    await st.put(`cr:${token}`, { account_id: id, amount_micro: amount, at: nowMs } satisfies Hold);
    await log(st, nowMs, { type: "reserve", account_id: id, amount_micro: amount, token, balance_micro: a.balance_micro });
    await watch(st, nowMs, nowMs + HOLD_MAX_MS, "h", token);
    return ok({ ok: true, ...accountView(id, a) });
  }

  if (action === "credits-commit") {
    // { token, review_id? } -> the review was delivered: the held amount is spent. Idempotent.
    const token = str(b?.token, TOKEN);
    if (!token) return no(400, { error: "Bad token." });
    const reviewId = typeof b?.review_id === "string" ? b.review_id.slice(0, 64) : undefined;
    const r = await st.get<Hold | Marker>(`cr:${token}`);
    if (r && "committed" in r) return ok({ committed: true, already: true });
    if (!r || "released" in r) {
      // Released already (by the alarm, after more than 10 minutes) or never reserved: the review stays free.
      await log(st, nowMs, { type: "commit_missed", why: r ? "already_released" : "not_found", token, ...(reviewId ? { review_id: reviewId } : {}) });
      return ok({ committed: false, reason: r ? "released" : "not_found" });
    }
    const a = await account(st, r.account_id);
    if (a) {
      a.held_micro = Math.max(0, a.held_micro - r.amount_micro);
      a.total_spent_micro += r.amount_micro;
      await st.put(`ca:${r.account_id}`, a);
    }
    await st.put(`cr:${token}`, { committed: true, at: nowMs, account_id: r.account_id, amount_micro: r.amount_micro } satisfies Marker);
    await log(st, nowMs, { type: "commit", account_id: r.account_id, amount_micro: r.amount_micro, token, ...(reviewId ? { review_id: reviewId } : {}), balance_micro: a?.balance_micro ?? null });
    await del(st, dueKey(r.at + HOLD_MAX_MS, "h", token)); // settled: off the work list
    await watch(st, nowMs, nowMs + MARKER_KEEP_MS, "m", token);
    return ok({ committed: true, ...(a ? accountView(r.account_id, a) : {}) });
  }

  if (action === "credits-release") {
    // { token, why? } -> the review didn't happen or failed: the hold goes back. Idempotent; a release that arrives
    // before its reserve leaves a tombstone.
    const token = str(b?.token, TOKEN);
    if (!token) return no(400, { error: "Bad token." });
    const why = typeof b?.why === "string" && /^[a-z_]{1,24}$/.test(b.why) ? b.why : "failed";
    const r = await st.get<Hold | Marker>(`cr:${token}`);
    if (!r) {
      await st.put(`cr:${token}`, { released: true, at: nowMs } satisfies Marker);
      await log(st, nowMs, { type: "tombstone", why, token });
      await watch(st, nowMs, nowMs + MARKER_KEEP_MS, "m", token);
      return ok({ released: false, tombstone: true });
    }
    if ("released" in r) return ok({ released: true, already: true });
    if ("committed" in r) return ok({ released: false, reason: "committed" });
    return ok({ released: true, ...(await releaseHold(st, token, r, why, nowMs)) });
  }

  if (action === "credits-pending-add") {
    // { pending_id, pack, expires_at, ip?, account_id?, key_hash? } -> an open checkout, checked against the caps
    // first: balance + held + pending + this pack <= max balance, and bought today + pending + this pack <= max per
    // day; at most 3 open checkouts per address. Recorded before the Stripe session is created, so two checkouts can't
    // both pass the caps. Its id goes in the session's metadata.
    const pid = str(b?.pending_id, TOKEN);
    const pack = typeof b?.pack === "string" ? b.pack : "";
    const cents = cfg.packs.get(pack);
    const exp = b?.expires_at;
    if (!pid || !cents || !Number.isSafeInteger(exp) || exp <= nowMs) return no(400, { error: "Bad checkout." });
    if (await st.get(`cp:${pid}`)) return no(409, { reason: "pending_exists" });
    const credits = cents * MICRO_PER_CENT;
    const ip = str(b?.ip, IP_HASH);
    const open = ip ? ((await st.get<{ id: string; exp: number }[]>(`cq:${ip}`)) ?? []).filter((x) => x.exp + PENDING_GRACE_MS > nowMs) : [];
    if (ip && open.length >= cfg.maxOpenPerIp) return no(429, { reason: "open_checkouts", open: open.length, limit: cfg.maxOpenPerIp });
    let id: string | null = null;
    if (b?.account_id !== undefined && b?.account_id !== null) {
      id = str(b.account_id, ACCOUNT_ID);
      const kh = str(b?.key_hash, HEX64);
      const a = await account(st, id);
      if (!id || !kh || !a || a.key_hash === null || !sameHash(a.key_hash, kh)) return no(401, { reason: "unknown_key" });
      if (a.frozen) return no(403, { reason: "frozen" });
      if (a.balance_micro + a.held_micro + a.pending_micro + credits > cfg.maxBalanceMicro)
        return no(429, { reason: "max_balance", max_micro: cfg.maxBalanceMicro, ...accountView(id, a) });
      if (boughtToday(a, nowMs) + a.pending_micro + credits > cfg.maxDailyMicro)
        return no(429, { reason: "max_daily", max_micro: cfg.maxDailyMicro, bought_today_micro: boughtToday(a, nowMs), ...accountView(id, a) });
      a.pending_micro += credits;
      await st.put(`ca:${id}`, a);
    } else {
      // A new account: only the pack counts.
      if (credits > cfg.maxBalanceMicro) return no(429, { reason: "max_balance", max_micro: cfg.maxBalanceMicro });
      if (credits > cfg.maxDailyMicro) return no(429, { reason: "max_daily", max_micro: cfg.maxDailyMicro });
    }
    await st.put(`cp:${pid}`, { account_id: id, credits_micro: credits, expires_at: exp, ip, pack, at: nowMs } satisfies Pending);
    if (ip) await st.put(`cq:${ip}`, [...open, { id: pid, exp }]);
    await watch(st, nowMs, exp + PENDING_GRACE_MS, "p", pid);
    return ok({ ok: true, credits_micro: credits });
  }

  if (action === "credits-pending-clear") {
    // { pending_id } -> the checkout couldn't be created, or Stripe expired it. Idempotent.
    const pid = str(b?.pending_id, TOKEN);
    if (!pid) return no(400, { error: "Bad pending id." });
    return ok({ cleared: await clearPending(st, pid) });
  }

  if (action === "credits-fulfill") {
    // { session } (a Checkout Session from a signed webhook event, or retrieved from Stripe by /credits/done) ->
    // credits the pack once. If cs:<id> exists it's returned as is: the same event twice, or the webhook racing /done,
    // credits once. Any failed check stores it as "held" and credits nothing.
    const s = b?.session;
    const sid = str(s?.id, SESSION_ID);
    if (!sid) return no(400, { error: "Bad session." });
    const existing = await st.get<CreditsSession>(`cs:${sid}`);
    if (existing) return ok({ already: true, status: existing.status, created_account: existing.created_account, credits_micro: existing.credits_micro });
    // Only a finished checkout is ever recorded: an open one would otherwise be stored as "held" and never credited
    // once it's paid. (The webhook's checkout.session.completed is always "complete"; /credits/done checks first.)
    if (s.status !== undefined && s.status !== "complete") return no(409, { reason: "not_complete" });
    const meta = s.metadata && typeof s.metadata === "object" ? s.metadata : {};
    const pid = str(meta.pending_id, TOKEN);
    if (pid) await clearPending(st, pid);
    const pi = str(typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id, PAYMENT_INTENT);
    const metaAccount = meta.account_id === undefined || meta.account_id === null || meta.account_id === "" ? null : str(meta.account_id, ACCOUNT_ID) ?? "bad";
    const check = checkPaidSession(s, cfg);
    let a: CreditsAccount | undefined;
    const reason = !check.ok ? check.reason : metaAccount === "bad" ? "bad_account_id" : metaAccount && !(a = await account(st, metaAccount)) ? "unknown_account" : null;
    const base = {
      payment_intent: pi,
      paid_cents: Number.isSafeInteger(s.amount_subtotal) && s.amount_subtotal > 0 ? s.amount_subtotal : 0,
      pack: typeof meta.pack === "string" ? meta.pack.slice(0, 20) : null,
      fulfilled_at: nowIso,
      key_shown: false,
      refunded_cents: 0,
      disputed: false,
      livemode: s.livemode === true,
    };
    if (reason || !check.ok) {
      const held: CreditsSession = { status: "held", held_reason: reason ?? "check_failed", account_id: metaAccount && metaAccount !== "bad" ? metaAccount : null, created_account: false, credits_micro: 0, reveal_nonce_hash: null, ...base };
      await st.put(`cs:${sid}`, held);
      if (pi) await st.put(`cpi:${pi}`, sid);
      await log(st, nowMs, { type: "held", why: held.held_reason, session_id: sid, ...(pi ? { payment_intent: pi } : {}), ...(held.account_id ? { account_id: held.account_id } : {}), paid_cents: base.paid_cents });
      return ok({ held: true, reason: held.held_reason, alert: "held" });
    }
    const created = !metaAccount;
    const id = metaAccount ?? newAccountId();
    if (!a) a = blankAccount(nowIso);
    a.balance_micro += check.credits_micro;
    a.total_bought_micro += check.credits_micro;
    if (a.bought_day !== today(nowMs)) {
      a.bought_day = today(nowMs);
      a.bought_day_micro = 0;
    }
    a.bought_day_micro += check.credits_micro;
    a.purchases.push(sid);
    // Credited even past the cap: the money was taken. Logged and alerted (spec §5.2 step 4).
    const overCap = a.balance_micro + a.held_micro + a.pending_micro > cfg.maxBalanceMicro;
    await st.put(`ca:${id}`, a);
    const nonce = str(meta.nonce_hash, HEX64);
    await st.put(`cs:${sid}`, { status: "fulfilled", account_id: id, created_account: created, credits_micro: check.credits_micro, reveal_nonce_hash: nonce, ...base, pack: check.pack } satisfies CreditsSession);
    if (pi) await st.put(`cpi:${pi}`, sid);
    await log(st, nowMs, { type: "purchase", account_id: id, amount_micro: check.credits_micro, session_id: sid, ...(pi ? { payment_intent: pi } : {}), pack: check.pack, paid_cents: check.cents, created_account: created, ...(overCap ? { over_cap: true } : {}), balance_micro: a.balance_micro });
    return ok({ fulfilled: true, created_account: created, credits_micro: check.credits_micro, balance_micro: a.balance_micro, ...(overCap ? { alert: "over_cap" } : {}) });
  }

  if (action === "credits-session") {
    // { session_id } -> what the /credits/done page shows (no account id, no hashes).
    const sid = str(b?.session_id, SESSION_ID);
    if (!sid) return no(400, { error: "Bad session id." });
    const s = await st.get<CreditsSession>(`cs:${sid}`);
    if (!s) return no(404, { reason: "not_found" });
    const a = await account(st, s.account_id);
    return ok({
      status: s.status,
      created_account: s.created_account,
      credits_micro: s.credits_micro,
      pack: s.pack,
      balance_micro: a?.balance_micro ?? null,
      key_shown: s.key_shown,
      key_available: s.status === "fulfilled" && s.created_account && !s.key_shown && !!a && a.key_hash === null && !a.reveal_closed,
    });
  }

  if (action === "credits-issue-key") {
    // { session_id, nonce_hash, key_hash } -> stores a new account's first key (its hash only), once, and only for the
    // browser that started the checkout (the nonce cookie's hash). A top-up session never issues a key.
    const sid = str(b?.session_id, SESSION_ID);
    const nh = str(b?.nonce_hash, HEX64);
    const kh = str(b?.key_hash, HEX64);
    if (!sid || !nh || !kh) return no(400, { error: "Bad reveal." });
    const s = await st.get<CreditsSession>(`cs:${sid}`);
    if (!s || s.status !== "fulfilled" || !s.created_account || !s.account_id) return no(409, { reason: "not_available" });
    if (s.key_shown) return no(409, { reason: "already_shown" });
    if (!s.reveal_nonce_hash || !sameHash(s.reveal_nonce_hash, nh)) return no(403, { reason: "wrong_browser" });
    const a = await account(st, s.account_id);
    if (!a || a.key_hash !== null || a.reveal_closed) return no(409, { reason: "not_available" });
    a.key_hash = kh;
    s.key_shown = true;
    await st.put(`ck:${kh}`, s.account_id);
    await st.put(`ca:${s.account_id}`, a);
    await st.put(`cs:${sid}`, s);
    await log(st, nowMs, { type: "key_issued", account_id: s.account_id, session_id: sid });
    return ok({ ok: true, balance_micro: a.balance_micro });
  }

  if (action === "credits-claim") {
    // { code_hash, key_hash } -> a one-time claim code (from the operator's rotate) becomes the account's new key.
    const ch = str(b?.code_hash, HEX64);
    const kh = str(b?.key_hash, HEX64);
    if (!ch || !kh) return no(400, { error: "Bad claim." });
    const c = await st.get<Claim>(`cc:${ch}`);
    if (!c) return no(404, { reason: "unknown_code" });
    if (c.expires_at <= nowMs) {
      await del(st, `cc:${ch}`);
      return no(410, { reason: "expired" });
    }
    const a = await account(st, c.account_id);
    if (!a || a.claim_hash === null || !sameHash(a.claim_hash, ch) || a.key_hash !== null) return no(409, { reason: "not_available" });
    a.key_hash = kh;
    a.claim_hash = null;
    await st.put(`ck:${kh}`, c.account_id);
    await st.put(`ca:${c.account_id}`, a);
    await del(st, `cc:${ch}`);
    await del(st, dueKey(c.expires_at, "c", ch)); // off the work list
    await log(st, nowMs, { type: "claim", account_id: c.account_id });
    return ok({ ok: true, balance_micro: a.balance_micro });
  }

  if (action === "credits-debit") {
    // { kind: "refund", payment_intent, amount_refunded (cents, cumulative), ref } | { kind: "dispute", payment_intent,
    // ref } | { kind: "fraud_warning", payment_intent, ref }. 404 when the payment isn't known yet: events can arrive
    // out of order, and the Worker answers 5xx so Stripe retries.
    const pi = str(b?.payment_intent, PAYMENT_INTENT);
    const ref = str(b?.ref, REF) ?? undefined;
    const kind = b?.kind;
    if (!pi || !["refund", "dispute", "fraud_warning"].includes(kind)) return no(400, { error: "Bad debit." });
    const sid = await st.get<string>(`cpi:${pi}`);
    const s = sid ? await st.get<CreditsSession>(`cs:${sid}`) : undefined;
    if (!sid || !s) return no(404, { reason: "unknown_payment" });
    const a = await account(st, s.account_id);
    // Credits per cent of this purchase (10,000 for every pack; 0 for a held one, which credited nothing).
    const credited = (cents: number) => (s.paid_cents > 0 ? Math.floor((cents * s.credits_micro) / s.paid_cents) : 0);
    if (kind === "refund") {
      const total = b?.amount_refunded;
      if (!Number.isSafeInteger(total) || total < 0) return no(400, { error: "Bad refund amount." });
      const fresh = total - s.refunded_cents; // charge.amount_refunded is cumulative
      if (fresh <= 0) return ok({ applied: false, reason: "already" });
      // The credits for what's newly refunded, counted cumulatively and capped at the pack's price, so a refund of a
      // charge above the subtotal (tax or a fee, if Checkout ever adds one) never takes more than the pack gave. After a
      // dispute, that purchase's remaining credits were already taken: a refund takes nothing more.
      const due = credited(Math.min(total, s.paid_cents)) - credited(Math.min(s.refunded_cents, s.paid_cents));
      const { debit, short } = take(a, s.disputed ? 0 : due);
      s.refunded_cents = total;
      await st.put(`cs:${sid}`, s);
      if (a) await st.put(`ca:${s.account_id}`, a);
      await log(st, nowMs, { type: "refund", account_id: s.account_id, session_id: sid, payment_intent: pi, refunded_cents: fresh, amount_micro: debit, ...(short ? { shortfall_micro: short } : {}), ...(ref ? { ref } : {}), balance_micro: a?.balance_micro ?? null });
      return ok({ applied: true, debit_micro: debit, shortfall_micro: short, ...(short ? { alert: "shortfall" } : {}) });
    }
    if (kind === "dispute") {
      if (s.disputed) return ok({ applied: false, reason: "already" });
      s.disputed = true;
      if (a) {
        a.frozen = true;
        a.frozen_reason = `dispute${ref ? ` ${ref}` : ""}`;
      }
      const { debit, short } = take(a, Math.max(0, s.credits_micro - credited(Math.min(s.refunded_cents, s.paid_cents))));
      await st.put(`cs:${sid}`, s);
      if (a) await st.put(`ca:${s.account_id}`, a);
      await log(st, nowMs, { type: "dispute", account_id: s.account_id, session_id: sid, payment_intent: pi, amount_micro: debit, ...(short ? { shortfall_micro: short } : {}), ...(ref ? { ref } : {}), balance_micro: a?.balance_micro ?? null });
      return ok({ applied: true, frozen: !!a, debit_micro: debit, shortfall_micro: short, alert: "dispute" });
    }
    // An early fraud warning: freeze only (a dispute fee costs more than a small pack). Unfreezing is by hand.
    if (s.fraud_warned) return ok({ applied: false, reason: "already" });
    s.fraud_warned = true;
    if (a && !a.frozen) {
      a.frozen = true;
      a.frozen_reason = `early fraud warning${ref ? ` ${ref}` : ""}`;
      await st.put(`ca:${s.account_id}`, a);
    }
    await st.put(`cs:${sid}`, s);
    await log(st, nowMs, { type: "fraud_warning", account_id: s.account_id, session_id: sid, payment_intent: pi, ...(ref ? { ref } : {}) });
    return ok({ applied: true, frozen: !!a, alert: "fraud_warning" });
  }

  if (action === "credits-view") {
    // { key_hash } (the owner) or { account_id | session_id | payment_intent } (the operator) -> the account and its
    // purchases, each with what could still be refunded.
    let id: string | null | undefined = null;
    if (b?.key_hash !== undefined) {
      const kh = str(b.key_hash, HEX64);
      id = kh ? await st.get<string>(`ck:${kh}`) : null;
      const a = await account(st, id);
      if (!id || !a || a.key_hash === null || !kh || !sameHash(a.key_hash, kh)) return no(401, { reason: "unknown_key" });
    } else if (str(b?.account_id, ACCOUNT_ID)) id = b.account_id;
    else if (str(b?.session_id, SESSION_ID)) id = (await st.get<CreditsSession>(`cs:${b.session_id}`))?.account_id;
    else if (str(b?.payment_intent, PAYMENT_INTENT)) {
      const sid = await st.get<string>(`cpi:${b.payment_intent}`);
      id = sid ? (await st.get<CreditsSession>(`cs:${sid}`))?.account_id : null;
    } else return no(400, { error: "Give an account id, a cs_ session id or a pi_ payment intent." });
    const a = await account(st, id);
    if (!id || !a) return no(404, { reason: "not_found" });
    if (b?.log_admin === true) await log(st, nowMs, { type: "admin_view", account_id: id });
    const purchases: ReturnType<typeof purchaseView>[] = [];
    for (const sid of a.purchases.slice(-200)) {
      const s = await st.get<CreditsSession>(`cs:${sid}`);
      if (s) purchases.push(purchaseView(sid, s, a));
    }
    return ok({ ...accountView(id, a), bought_today_micro: boughtToday(a, nowMs), claim_open: a.claim_hash !== null, purchases });
  }

  if (action === "credits-adjust") {
    // The operator: { account_id | create: true, amount_micro? (signed), freeze?, unfreeze?, clear_shortfall?, reason }.
    const reason = typeof b?.reason === "string" ? b.reason.trim().slice(0, 200) : "";
    if (reason.length < 3) return no(400, { error: "Give a reason (3-200 characters)." });
    const amount = b?.amount_micro ?? 0;
    if (!Number.isSafeInteger(amount)) return no(400, { error: "amount_micro must be a whole number of micro-USD." });
    if (b?.freeze === true && b?.unfreeze === true) return no(400, { error: "freeze or unfreeze, not both." });
    let id: string | null;
    let a: CreditsAccount | undefined;
    if (b?.create === true) {
      id = newAccountId();
      a = blankAccount(nowIso);
    } else {
      id = str(b?.account_id, ACCOUNT_ID);
      a = await account(st, id);
      if (!id || !a) return no(404, { reason: "not_found" });
    }
    if (amount < 0 && a.balance_micro < -amount) return no(409, { reason: "balance", ...accountView(id, a) });
    a.balance_micro += amount;
    if (b?.freeze === true) {
      a.frozen = true;
      a.frozen_reason = reason;
    }
    if (b?.unfreeze === true) {
      a.frozen = false;
      a.frozen_reason = null;
    }
    const cleared = b?.clear_shortfall === true ? a.shortfall_micro : 0;
    if (cleared) a.shortfall_micro = 0;
    await st.put(`ca:${id}`, a);
    await log(st, nowMs, { type: "adjust", account_id: id, amount_micro: amount, ...(b?.create === true ? { created_account: true } : {}), ...(b?.freeze === true ? { freeze: true } : {}), ...(b?.unfreeze === true ? { unfreeze: true } : {}), ...(cleared ? { shortfall_cleared_micro: cleared } : {}), reason, balance_micro: a.balance_micro });
    return ok(accountView(id, a));
  }

  if (action === "credits-rotate") {
    // The operator: { account_id, code_hash, reason } -> the old key stops working, the purchase page can't reveal one
    // any more, and a one-time claim code (24 h) replaces any earlier one.
    const id = str(b?.account_id, ACCOUNT_ID);
    const ch = str(b?.code_hash, HEX64);
    const reason = typeof b?.reason === "string" ? b.reason.trim().slice(0, 200) : "";
    if (!id || !ch || reason.length < 3) return no(400, { error: "Give account_id and a reason (3-200 characters)." });
    const a = await account(st, id);
    if (!a) return no(404, { reason: "not_found" });
    if (a.key_hash) await del(st, `ck:${a.key_hash}`);
    if (a.claim_hash) await del(st, `cc:${a.claim_hash}`);
    a.key_hash = null;
    a.reveal_closed = true;
    a.claim_hash = ch;
    const expires = nowMs + CLAIM_TTL_MS;
    await st.put(`cc:${ch}`, { account_id: id, expires_at: expires } satisfies Claim);
    await st.put(`ca:${id}`, a);
    await log(st, nowMs, { type: "rotate", account_id: id, reason });
    await watch(st, nowMs, expires, "c", ch);
    return ok({ ok: true, expires_at: new Date(expires).toISOString() });
  }

  if (action === "credits-export") {
    // The operator: { after?, limit? } -> log entries in order (for the CPA), up to 1,000 per call.
    const after = Number.isSafeInteger(b?.after) && b.after >= 0 ? b.after : 0;
    const limit = Number.isSafeInteger(b?.limit) && b.limit > 0 ? Math.min(b.limit, 1_000) : 1_000;
    if (!st.list) return ok({ entries: [], next: null });
    if (b?.log_admin === true) await log(st, nowMs, { type: "admin_export", after });
    const found = await st.list<Record<string, unknown>>({ prefix: "cl:", start: `cl:${String(after + 1).padStart(12, "0")}`, limit });
    const entries = [...found.values()].filter((e) => e && (e.seq as number) > after);
    const last = entries.length ? (entries[entries.length - 1].seq as number) : null;
    return ok({ entries, next: entries.length === limit ? last : null });
  }

  return no(404, { error: "Unknown credits action." });
}

/** One due entry of the work list. Anything already settled (committed, released, fulfilled, claimed) is skipped. */
async function settleDue(st: DOStorage, kind: DueKind, id: string, nowMs: number) {
  if (kind === "h" || kind === "m") {
    const r = await st.get<Hold | Marker>(`cr:${id}`);
    if (!r) return;
    if ("released" in r || "committed" in r) {
      // A marker has its own "m" entry, written with it; an "h" entry finding one has nothing to do.
      if (r.at + MARKER_KEEP_MS <= nowMs) await del(st, `cr:${id}`);
      else if (kind === "m") await watch(st, nowMs, r.at + MARKER_KEEP_MS, "m", id);
      return;
    }
    if (r.at + HOLD_MAX_MS <= nowMs) await releaseHold(st, id, r, "alarm", nowMs);
    else await watch(st, nowMs, r.at + HOLD_MAX_MS, "h", id);
    return;
  }
  if (kind === "p") {
    const p = await st.get<Pending>(`cp:${id}`);
    if (!p) return;
    if (p.expires_at + PENDING_GRACE_MS <= nowMs) await clearPending(st, id);
    else await watch(st, nowMs, p.expires_at + PENDING_GRACE_MS, "p", id);
    return;
  }
  const c = await st.get<Claim>(`cc:${id}`);
  if (!c) return;
  if (c.expires_at > nowMs) return watch(st, nowMs, c.expires_at, "c", id);
  await del(st, `cc:${id}`);
  const a = await account(st, c.account_id);
  if (a && a.claim_hash === id) {
    a.claim_hash = null;
    await st.put(`ca:${c.account_id}`, a);
  }
  await log(st, nowMs, { type: "claim_expired", account_id: c.account_id });
}

/**
 * The alarm's credits sweep, through the work list in due order: releases holds older than 10 minutes (and logs it),
 * deletes markers older than an hour, clears expired open checkouts and claim codes. Each entry is settled as one
 * atomic write, together with the deletion of its work-list entry. Stops at the first entry that isn't due and
 * returns its time; after SWEEP_LIMIT entries it returns a second from now; null when the list is empty. New entries
 * written while it runs (a released hold's marker) are due later, so they end the run when it reaches them.
 */
export async function creditsSweep(st: DOStorage, nowMs: number): Promise<number | null> {
  if (!st.list) return null;
  let start: string | undefined;
  let done = 0;
  for (;;) {
    const page = await st.list<unknown>({ prefix: "cx:", ...(start ? { start } : {}), limit: 500 });
    if (!page.size) return null;
    let last = "";
    for (const k of page.keys()) {
      last = k;
      const m = DUE_KEY.exec(k);
      const at = m ? Number(m[1]) : -1; // a malformed entry is due at once, and deleted
      if (at > nowMs) return at;
      if (done >= SWEEP_LIMIT) return nowMs + 1_000; // more than one run's worth: come back in a second
      const t = txn(st);
      await del(t.view, k);
      if (m) await settleDue(t.view, m[2] as DueKind, m[3], nowMs);
      await t.commit();
      done++;
    }
    start = `${last}\u0000`; // "start" is inclusive
  }
}
