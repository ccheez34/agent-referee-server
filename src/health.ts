// Health Durable Object (one instance, "global"): operator pause switches, rare failure events (payment facilitator,
// ledger, provider errors), and the list of paid judge matches that couldn't be judged (to refund by hand).
// Only rare things are written here, so it never becomes a hot spot: pause state is cached per isolate for 15 s.
import type { DOState, Env } from "./types.ts";

export type HealthEventKind = "settle_failure" | "facilitator_problem" | "credit_problem" | "ledger_error" | "provider_errors" | "out_of_tokens";
export type HealthEvent = { kind: HealthEventKind; at: number; detail: string };
export type Pause = { paid: boolean; reviews: boolean; auto?: string };
export type UnjudgedEntry = { match_id: string; tier: string; reason: string; at: number; payers: { seat: string; wallet: string | null; payment_hash?: string }[]; refunded?: boolean };

const MAX_EVENTS = 300;
const MAX_UNJUDGED = 500;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class Health {
  state: DOState;
  now: () => number = () => Date.now();
  constructor(state: DOState, _env?: unknown) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const action = new URL(req.url).pathname.replace(/^\//, "");
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const st = this.state.storage;
    if (action === "pause") {
      if (req.method === "POST") {
        const p: Pause = { paid: false, reviews: false, ...((await st.get<Pause>("pause")) ?? {}) };
        if (body?.scope === "paid" || body?.scope === "reviews") (p as any)[body.scope] = !!body.on;
        if (body?.scope === "paid" && !body.on) delete p.auto; // the operator looked and resumed
        await st.put("pause", p);
        return json(200, p);
      }
      return json(200, { paid: false, reviews: false, ...((await st.get<Pause>("pause")) ?? {}) });
    }
    if (action === "event") {
      const kinds: HealthEventKind[] = ["settle_failure", "facilitator_problem", "credit_problem", "ledger_error", "provider_errors", "out_of_tokens"];
      if (!kinds.includes(body?.kind)) return json(400, { error: "Unknown event kind." });
      const events = (await st.get<HealthEvent[]>("events")) ?? [];
      events.push({ kind: body.kind, at: this.now(), detail: String(body.detail ?? "").slice(0, 300) });
      await st.put("events", events.slice(-MAX_EVENTS));
      return json(200, { ok: true });
    }
    if (action === "events") return json(200, (await st.get<HealthEvent[]>("events")) ?? []);
    if (action === "settle-failure") {
      // Work was delivered but the payment didn't settle. Every one is counted (never throttled): the paying wallet
      // is refused from now on, and too many in an hour pauses paid routes until the operator looks.
      const now = this.now();
      const wallet = typeof body?.wallet === "string" && /^0x[0-9a-f]{40}$/.test(body.wallet) ? body.wallet : null;
      const blocked = (await st.get<string[]>("blocked_wallets")) ?? [];
      if (wallet && !blocked.includes(wallet)) await st.put("blocked_wallets", [...blocked, wallet].slice(-2000));
      const times = ((await st.get<number[]>("settle_failures")) ?? []).filter((t) => now - t < 3600_000);
      times.push(now);
      await st.put("settle_failures", times);
      const events = (await st.get<HealthEvent[]>("events")) ?? [];
      events.push({ kind: "settle_failure", at: now, detail: String(body?.detail ?? "").slice(0, 300) });
      await st.put("events", events.slice(-MAX_EVENTS));
      const limit = Number.isFinite(body?.pause_after) ? body.pause_after : 5;
      let paused = false;
      if (times.length >= limit) {
        const p: Pause = { paid: false, reviews: false, ...((await st.get<Pause>("pause")) ?? {}) };
        if (!p.paid) await st.put("pause", { ...p, paid: true, auto: `${times.length} payments failed to settle within an hour` });
        paused = true;
      }
      return json(200, { ok: true, recent: times.length, paused });
    }
    if (action === "blocked") return json(200, (await st.get<string[]>("blocked_wallets")) ?? []);
    if (action === "unblock") {
      // The operator looked at a wallet's unsettled payment (it was settled, refunded or written off): let it pay again.
      const wallet = typeof body?.wallet === "string" ? body.wallet.toLowerCase() : "";
      const blocked = (await st.get<string[]>("blocked_wallets")) ?? [];
      const left = blocked.filter((w) => w !== wallet);
      await st.put("blocked_wallets", left);
      return json(200, { unblocked: left.length < blocked.length, blocked: left });
    }
    if (action === "unjudged") {
      const list = (await st.get<UnjudgedEntry[]>("unjudged")) ?? [];
      if (req.method === "POST") {
        if (body?.refunded_match_id) {
          for (const e of list) if (e.match_id === body.refunded_match_id) e.refunded = true;
        } else if (body?.entry?.match_id && !list.some((e) => e.match_id === body.entry.match_id)) {
          list.push({ ...body.entry, at: this.now() });
        }
        await st.put("unjudged", list.slice(-MAX_UNJUDGED));
        return json(200, { ok: true });
      }
      return json(200, list);
    }
    return json(404, { error: "Unknown action." });
  }
}

function healthStub(env: Env) {
  return env.HEALTH!.get(env.HEALTH!.idFromName("global"));
}

async function healthCall(env: Env, action: string, body?: unknown): Promise<any> {
  const res = await healthStub(env).fetch(`https://health/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`health answered ${res.status}`);
  return res.json();
}

let pauseCache: { at: number; p: Pause } | null = null;
const PAUSE_CACHE_MS = 15_000;

/** The phone pause switches (POST /admin/pause), cached 15 s per isolate. The wrangler secrets are checked separately. */
export async function pauseState(env: Env): Promise<Pause> {
  if (!env.HEALTH) return { paid: false, reviews: false };
  const now = Date.now();
  if (pauseCache && now - pauseCache.at < PAUSE_CACHE_MS) return pauseCache.p;
  let p: Pause = pauseCache?.p ?? { paid: false, reviews: false };
  try {
    p = await healthCall(env, "pause");
  } catch {
    // Keep the last known state; the wrangler secrets (PAID_PAUSED, REVIEWS_PAUSED) still work without this.
  }
  pauseCache = { at: now, p };
  return p;
}

export async function setPause(env: Env, scope: "paid" | "reviews", on: boolean): Promise<Pause> {
  const p = await healthCall(env, "pause", { scope, on });
  pauseCache = { at: Date.now(), p };
  return p;
}

const lastEvent = new Map<string, number>();
/** Records a rare failure for /health. At most one write per kind per isolate per 20 s, and it never throws. */
export async function recordEvent(env: Env, kind: HealthEventKind, detail: string) {
  console.error(JSON.stringify({ health_event: kind, detail: detail.slice(0, 300) }));
  if (!env.HEALTH) return;
  const now = Date.now();
  if (now - (lastEvent.get(kind) ?? 0) < 20_000) return;
  lastEvent.set(kind, now);
  await healthCall(env, "event", { kind, detail }).catch(() => {});
}

/** Work delivered, payment not settled: counted every time (see the Health DO). Never throws. */
export async function recordSettleFailure(env: Env, wallet: string | undefined, detail: string) {
  console.error(JSON.stringify({ health_event: "settle_failure", wallet, detail: detail.slice(0, 300) }));
  if (!env.HEALTH) return;
  const r = await healthCall(env, "settle-failure", { wallet, detail, pause_after: Number(env.SETTLE_FAIL_PAUSE_AFTER || 5) }).catch(() => null);
  if (r?.paused) pauseCache = null;
  if (wallet) blockedCache?.set.add(wallet);
}

let blockedCache: { at: number; set: Set<string> } | null = null;
/** Wallets whose payment failed to settle after the work was done: refused before payment. Cached 30 s per isolate. */
export async function walletBlocked(env: Env, wallet: string | undefined): Promise<boolean> {
  if (!wallet || !env.HEALTH) return false;
  const now = Date.now();
  if (!blockedCache || now - blockedCache.at > 30_000) {
    try {
      blockedCache = { at: now, set: new Set(await healthCall(env, "blocked")) };
    } catch {
      blockedCache = { at: now, set: blockedCache?.set ?? new Set() };
    }
  }
  return blockedCache.set.has(wallet);
}

export const healthEvents = (env: Env): Promise<HealthEvent[]> => (env.HEALTH ? healthCall(env, "events") : Promise.resolve([]));
export const listUnjudged = (env: Env): Promise<UnjudgedEntry[]> => (env.HEALTH ? healthCall(env, "unjudged") : Promise.resolve([]));
export const addUnjudged = (env: Env, entry: Omit<UnjudgedEntry, "at">) => (env.HEALTH ? healthCall(env, "unjudged", { entry }) : Promise.resolve(null));
export const markRefunded = (env: Env, match_id: string) => healthCall(env, "unjudged", { refunded_match_id: match_id });

/** The /health verdict from gate stats, recent events and the ledger check. Pure, so each rule is tested. */
export function evaluateHealth(input: { gates: Record<string, any>; events: HealthEvent[]; ledger: "ok" | "error" | "off"; now?: number; unjudgedOpen?: number }) {
  const now = input.now ?? Date.now();
  const reasons: string[] = [];
  for (const [pool, s] of Object.entries(input.gates)) {
    if (s?.error) reasons.push(`gate_unreachable:${pool}`);
    else if (s?.tripped || s?.trip) reasons.push(`provider_cap:${pool}`);
    else if ((s?.last_15_min?.calls ?? 0) >= 10 && (s?.last_15_min?.failure_rate ?? 0) > 0.2) reasons.push(`failure_rate:${pool}`);
  }
  if (input.ledger === "error") reasons.push("ledger_error");
  const recent = input.events.filter((e) => now - e.at < 15 * 60_000);
  if (recent.some((e) => e.kind === "settle_failure")) reasons.push("settle_failure");
  if (recent.some((e) => e.kind === "credit_problem")) reasons.push("credit_problem");
  if (recent.filter((e) => e.kind === "facilitator_problem").length >= 3) reasons.push("facilitator_down");
  if (recent.some((e) => e.kind === "ledger_error")) reasons.push("ledger_error_recent");
  const warnings: string[] = [];
  if (recent.some((e) => e.kind === "provider_errors")) warnings.push("provider_errors");
  // An AI answer was cut off at its token limit: worth raising that model's limit (GET /admin/stats has the details).
  if (input.events.some((e) => e.kind === "out_of_tokens" && now - e.at < 24 * 3_600_000)) warnings.push("out_of_tokens");
  // A paid match that couldn't be judged is waiting for a refund: that needs the operator, so it alerts.
  if ((input.unjudgedOpen ?? 0) > 0) reasons.push(`unjudged_to_refund:${input.unjudgedOpen}`);
  return { degraded: reasons.length > 0, reasons: [...new Set(reasons)], warnings };
}

/** Constant-time check of the admin token (sent as "Authorization: Bearer <token>"). No token configured = no admin. */
export async function adminOk(env: Env, header: string | undefined): Promise<boolean> {
  const want = env.ADMIN_TOKEN?.trim();
  if (!want || want.length < 32 || !header?.startsWith("Bearer ")) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(header.slice(7).trim())), crypto.subtle.digest("SHA-256", enc.encode(want))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export const listBlocked = (env: Env): Promise<string[]> => healthCall(env, "blocked");

/** Let a blocked wallet pay again (admin). Clears this isolate's cache; others refresh within 30 s. */
export async function unblockWallet(env: Env, wallet: string): Promise<{ unblocked: boolean; blocked: string[] }> {
  const r = await healthCall(env, "unblock", { wallet });
  blockedCache = null;
  return r;
}

/** Tests only. */
export function _resetHealthCaches() {
  pauseCache = null;
  blockedCache = null;
  lastEvent.clear();
}
