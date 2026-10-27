// Health Durable Object (one instance, "global"): operator pause switches, rare failure events (payment facilitator,
// ledger, provider errors), and the list of paid judge matches that couldn't be judged (to refund by hand).
// Only rare things are written here, so it never becomes a hot spot: pause state is cached per isolate for 15 s.
import type { DOState, Env } from "./types.ts";

export type HealthEventKind = "settle_failure" | "facilitator_problem" | "credit_problem" | "ledger_error" | "provider_errors";
export type HealthEvent = { kind: HealthEventKind; at: number; detail: string };
export type Pause = { paid: boolean; reviews: boolean };
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
        if (body?.scope === "paid" || body?.scope === "reviews") p[body.scope as keyof Pause] = !!body.on;
        await st.put("pause", p);
        return json(200, p);
      }
      return json(200, { paid: false, reviews: false, ...((await st.get<Pause>("pause")) ?? {}) });
    }
    if (action === "event") {
      const kinds: HealthEventKind[] = ["settle_failure", "facilitator_problem", "credit_problem", "ledger_error", "provider_errors"];
      if (!kinds.includes(body?.kind)) return json(400, { error: "Unknown event kind." });
      const events = (await st.get<HealthEvent[]>("events")) ?? [];
      events.push({ kind: body.kind, at: this.now(), detail: String(body.detail ?? "").slice(0, 300) });
      await st.put("events", events.slice(-MAX_EVENTS));
      return json(200, { ok: true });
    }
    if (action === "events") return json(200, (await st.get<HealthEvent[]>("events")) ?? []);
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
  if ((input.unjudgedOpen ?? 0) > 0) warnings.push(`unjudged_to_refund:${input.unjudgedOpen}`);
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

/** Tests only. */
export function _resetHealthCaches() {
  pauseCache = null;
  lastEvent.clear();
}
