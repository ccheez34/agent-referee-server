// Worker side of the admission gates (see gate.ts): take slots before AI calls, give them back afterwards.
//
// Every gate call is wrapped: if a gate throws, times out or answers oddly (a restart, an eviction), the caller gets
// "busy, retry in 5 s", never a 5xx or a hang. Requests that haven't paid yet are answered from a short-lived local
// snapshot, so a burst of first calls costs the gates almost nothing.
import { allowedModels } from "./judge.ts";
import { poolOf, providerOfPool, summarize, type CallObservation, type Provider } from "./providers.ts";
import type { Env } from "./types.ts";

export const GATE_CALL_TIMEOUT_MS = 25_000;
const SNAPSHOT_MS = 2_000;

/** Concurrent calls allowed per pool, from GATE_SLOTS_<POOL> (e.g. GATE_SLOTS_OPENROUTER, GATE_SLOTS_ANTHROPIC_CLAUDE_OPUS_5_5). */
export function slotsFor(env: Env, pool: string): number {
  const name = "GATE_SLOTS_" + pool.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const v = (env as any)[name];
  if (v !== undefined && v !== "" && Number.isFinite(Number(v))) return Math.floor(Number(v));
  if (pool === "openrouter") return 20;
  if (pool.includes("opus")) return 6;
  if (pool.includes("sonnet") || pool.includes("haiku")) return 12;
  return 8;
}

export const gatesOn = (env: Env) => !!env.GATES && env.GATES_ENABLED !== "false";

async function gateCall(env: Env, pool: string, action: string, body?: unknown, timeoutMs = GATE_CALL_TIMEOUT_MS): Promise<any> {
  const stub = env.GATES!.get(env.GATES!.idFromName(pool));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      stub.fetch(`https://gate/${action}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("gate timed out")), timeoutMs))),
    ]);
    if (!res.ok) throw new Error(`gate answered ${res.status}`);
    return await res.json();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Per-isolate snapshot of each pool: refreshed at most every 2 s; a refusal marks the pool full for 2 s. */
const snapshots = new Map<string, { at: number; full: boolean }>();

export type Busy = { retryAfter: number; reason: string };

/** For requests that haven't paid yet: is any needed pool full or closed? Doesn't take a slot. Fails closed. */
export async function quickBusy(env: Env, models: string[]): Promise<Busy | null> {
  if (!gatesOn(env)) return null;
  const now = Date.now();
  for (const pool of new Set(models.map(poolOf))) {
    let s = snapshots.get(pool);
    if (!s || now - s.at > SNAPSHOT_MS) {
      try {
        // Sends this pool's configured slots: a gate that hasn't been told yet would otherwise judge by its default.
        const p = await gateCall(env, pool, "peek", { slots: slotsFor(env, pool) }, 5_000);
        s = { at: now, full: !!p.full };
      } catch {
        return { retryAfter: 5, reason: "gate_unavailable" };
      }
      snapshots.set(pool, s);
    }
    if (s.full) return { retryAfter: 10, reason: "busy" };
  }
  return null;
}

export type SlotLease = {
  /** Record what happened on one call for model index i (the order of the models passed to acquireSlots). */
  observe(i: number, o: CallObservation): void;
  /** Give every slot back, with outcomes. Safe to call more than once; only the first call counts. */
  release(): Promise<void>;
  /** True if any call hit a spend cap (the pools of that provider were closed). */
  capHit(): boolean;
};

const NOOP: SlotLease = { observe() {}, release: async () => {}, capHit: () => false };

/** Takes one slot per model, all or nothing, waiting up to waitMs. Never throws. */
export async function acquireSlots(env: Env, models: string[], opts: { leaseMs: number; waitMs: number }): Promise<{ ok: true; lease: SlotLease } | ({ ok: false } & Busy)> {
  if (!gatesOn(env) || !models.length) return { ok: true, lease: NOOP };
  const byPool = new Map<string, number[]>(); // pool -> model indexes
  models.forEach((m, i) => byPool.set(poolOf(m), [...(byPool.get(poolOf(m)) ?? []), i]));
  const pools = [...byPool.keys()];
  const results = await Promise.all(
    pools.map(async (pool) => {
      try {
        const r = await gateCall(env, pool, "acquire", { n: byPool.get(pool)!.length, slots: slotsFor(env, pool), lease_ms: opts.leaseMs, wait_ms: opts.waitMs });
        if (Array.isArray(r?.tokens) && r.tokens.length === byPool.get(pool)!.length) return { pool, tokens: r.tokens as string[] };
        // Only a capacity refusal says anything about the next caller (a request too big for the pool doesn't).
        if (["queue_full", "wait_timeout", "provider_cap", "closed"].includes(String(r?.reason))) snapshots.set(pool, { at: Date.now(), full: true });
        return { pool, busy: { retryAfter: Number(r?.retry_after_s) || 10, reason: String(r?.reason || "busy") } };
      } catch {
        return { pool, busy: { retryAfter: 5, reason: "gate_unavailable" } };
      }
    }),
  );
  const granted = results.filter((r): r is { pool: string; tokens: string[] } => "tokens" in r);
  const refused = results.filter((r): r is { pool: string; busy: Busy } => "busy" in r);
  const tokenOf: string[] = [];
  for (const g of granted) byPool.get(g.pool)!.forEach((modelIndex, k) => (tokenOf[modelIndex] = g.tokens[k]));
  const obs: CallObservation[][] = models.map(() => []);
  let released = false;
  let cap = false;
  const lease: SlotLease = {
    observe: (i, o) => void obs[i]?.push(o),
    capHit: () => cap,
    async release() {
      if (released) return;
      released = true;
      const capProviders = new Set<Provider>();
      // Never throws: every gate call below is caught, and a slot not given back expires with its lease.
      await Promise.all(
        granted.map((g) => {
          const entries = byPool.get(g.pool)!.map((modelIndex) => {
            const s = summarize(obs[modelIndex]);
            if (s.outcome === "cap") capProviders.add(providerOfPool(g.pool));
            return { token: tokenOf[modelIndex], outcome: s.outcome, rate: s.rate };
          });
          return gateCall(env, g.pool, "release", { slots: slotsFor(env, g.pool), entries }).catch(() => {}); // the lease expires on its own
        }),
      );
      cap = capProviders.size > 0;
      for (const p of capProviders) await tripProvider(env, p, "provider_cap").catch(() => {});
    },
  };
  if (refused.length) {
    await lease.release(); // nothing ran: give back what was taken
    const worst = refused.reduce((a, b) => (b.busy.retryAfter > a.busy.retryAfter ? b : a));
    return { ok: false, ...worst.busy };
  }
  return { ok: true, lease };
}

/** Every pool of a provider this server uses: caps are account-wide, so one cap closes them all. */
export function poolsOfProvider(env: Env, provider: Provider): string[] {
  const models = [...allowedModels(env), env.REVIEW_MODEL || "claude-sonnet-5-5", env.JUDGE_MODEL || "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
  for (const k of ["PANEL_MODELS", "PANEL_2_MODELS", "PANEL_3_MODELS", "REVIEW_3_MODELS", "JUDGE_MODEL_POOL"] as const) models.push(...String(env[k] || "").split(",").map((s) => s.trim()).filter(Boolean));
  return [...new Set(models.map(poolOf))].filter((p) => providerOfPool(p) === provider);
}

export async function tripProvider(env: Env, provider: Provider, reason: string) {
  if (!gatesOn(env)) return;
  await Promise.all(poolsOfProvider(env, provider).map((pool) => gateCall(env, pool, "trip", { reason }).catch(() => {})));
}

export async function gateStats(env: Env, pools: string[]): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  await Promise.all(
    pools.map(async (pool) => {
      try {
        out[pool] = await gateCall(env, pool, "stats", undefined, 5_000);
      } catch {
        out[pool] = { error: "unreachable" };
      }
    }),
  );
  return out;
}

export async function resetPools(env: Env, pools: string[]) {
  await Promise.all(pools.map((pool) => gateCall(env, pool, "reset", { slots: slotsFor(env, pool) }).catch(() => {})));
}

/** Tests only. */
export function _clearSnapshots() {
  snapshots.clear();
}
