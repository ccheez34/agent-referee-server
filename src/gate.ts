// Admission gate: one Durable Object per provider pool ("anthropic:<model>" or "openrouter").
//
// Each AI call holds a slot from acquire to release, so no more calls run at once than the pool allows. Extra requests
// wait (up to 20 s, at most 2 x slots of them) and are otherwise told "busy" with a retry time, which the Worker turns
// into a 503 before anyone is charged. Leases expire on their own, so a crashed Worker can't leak slots. A spend cap or
// credit error closes the pool; after an hour one probe call is let through, and success reopens it.
import type { DOState } from "./types.ts";
import type { CallKind, RateInfo } from "./providers.ts";

export const GATE_MAX_WAIT_MS = 20_000;
export const GATE_TRIP_PROBE_MS = 60 * 60_000;
const THROTTLE_MAX_MS = 60_000;
const BUCKET_MS = 60_000;
const WINDOW_MS = 15 * 60_000;

type Lease = { expires: number; probe?: boolean };
type Waiter = { n: number; leaseMs: number; resolve: (r: AcquireResult) => void; timer: ReturnType<typeof setTimeout> };
export type AcquireResult = { tokens: string[] } | { busy: true; reason: BusyReason; retry_after_s: number };
export type BusyReason = "queue_full" | "wait_timeout" | "provider_cap" | "too_large" | "closed";
type Trip = { reason: string; since: number; probe_at: number };
type Bucket = { at: number } & Partial<Record<CallKind | "busy", number>>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class Gate {
  state: DOState;
  now: () => number = () => Date.now();
  private leases = new Map<string, Lease>();
  private queue: Waiter[] = [];
  private loaded: Promise<void> | null = null;
  private trip: Trip | null = null;
  private throttleUntil = 0;
  private slots = 1; // last value the Worker sent; the Worker's setting is the source of truth
  private buckets: Bucket[] = [];
  private recent429: number[] = [];

  constructor(state: DOState, _env?: unknown) {
    this.state = state;
  }

  private load() {
    this.loaded ??= (async () => {
      const saved = await this.state.storage.get<Record<string, Lease>>("leases");
      for (const [k, v] of Object.entries(saved ?? {})) this.leases.set(k, v);
      this.trip = (await this.state.storage.get<Trip>("trip")) ?? null;
    })();
    return this.loaded;
  }

  private async saveLeases() {
    await this.state.storage.put("leases", Object.fromEntries(this.leases));
    const next = Math.min(...[...this.leases.values()].map((l) => l.expires));
    if (Number.isFinite(next)) await this.state.storage.setAlarm(next + 50);
  }

  /** Expired leases free their slots (the work behind them ended or crashed). */
  private expire() {
    const now = this.now();
    let changed = false;
    for (const [k, l] of this.leases) if (l.expires <= now) (this.leases.delete(k), (changed = true));
    return changed;
  }

  effectiveSlots(): number {
    if (this.slots <= 0) return 0;
    return this.now() < this.throttleUntil ? Math.max(1, Math.floor(this.slots / 2)) : this.slots;
  }

  async alarm() {
    await this.load();
    if (this.expire()) {
      await this.saveLeases();
      this.pump();
    } else if (this.leases.size) await this.saveLeases();
  }

  async fetch(req: Request): Promise<Response> {
    await this.load();
    const url = new URL(req.url);
    const action = url.pathname.replace(/^\//, "");
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    if (Number.isFinite(body?.slots)) this.slots = Math.floor(body.slots);
    if (this.expire()) {
      await this.saveLeases();
      this.pump();
    }

    if (action === "acquire") return json(200, await this.acquire(body));
    if (action === "release") {
      await this.release(body);
      return json(200, { ok: true });
    }
    if (action === "peek") return json(200, this.peek());
    if (action === "stats") return json(200, this.stats());
    if (action === "trip") {
      await this.setTrip(String(body?.reason || "provider_cap"));
      return json(200, { ok: true });
    }
    if (action === "reset") {
      this.trip = null;
      this.throttleUntil = 0;
      await this.state.storage.put("trip", null);
      this.pump();
      return json(200, { ok: true });
    }
    return json(404, { error: "Unknown action." });
  }

  peek() {
    const eff = this.effectiveSlots();
    const tripped = this.tripState();
    return {
      slots: this.slots,
      effective: eff,
      inflight: this.leases.size,
      queued: this.queue.length,
      tripped: tripped === "closed",
      // Full = a new request would be refused at once (closed, or the waiting line is at its cap).
      full: tripped === "closed" || eff === 0 || this.queue.length >= 2 * eff,
    };
  }

  /** "closed": refuse; "probe": let exactly one acquire through; "open": normal. */
  private tripState(): "open" | "closed" | "probe" {
    if (!this.trip) return "open";
    if (this.now() < this.trip.probe_at) return "closed";
    return [...this.leases.values()].some((l) => l.probe) ? "closed" : "probe";
  }

  private busy(reason: BusyReason, retry_after_s: number): AcquireResult {
    this.count("busy");
    return { busy: true, reason, retry_after_s: Math.max(1, Math.round(retry_after_s)) };
  }

  async acquire(body: any): Promise<AcquireResult> {
    const n = Math.max(1, Math.floor(Number(body?.n) || 1));
    const leaseMs = Math.min(Math.max(Number(body?.lease_ms) || 60_000, 1_000), 15 * 60_000);
    const waitMs = Math.min(Math.max(Number(body?.wait_ms) || 0, 0), GATE_MAX_WAIT_MS);
    const trip = this.tripState();
    if (trip === "closed") return this.busy(this.trip ? "provider_cap" : "closed", this.trip ? (this.trip.probe_at - this.now()) / 1000 : 60);
    if (trip === "probe") return this.grant(n, leaseMs, true);
    const eff = this.effectiveSlots();
    if (eff === 0) return this.busy("closed", 60);
    if (n > eff) return this.busy("too_large", 30);
    if (this.queue.length === 0 && this.leases.size + n <= eff) return this.grant(n, leaseMs);
    if (waitMs === 0 || this.queue.length >= 2 * eff) return this.busy("queue_full", 10);
    return new Promise<AcquireResult>((resolve) => {
      const w: Waiter = {
        n,
        leaseMs,
        resolve,
        timer: setTimeout(() => {
          this.queue = this.queue.filter((x) => x !== w);
          resolve(this.busy("wait_timeout", 10));
        }, waitMs),
      };
      this.queue.push(w);
    });
  }

  private async grant(n: number, leaseMs: number, probe = false): Promise<AcquireResult> {
    const tokens = Array.from({ length: n }, () => crypto.randomUUID());
    const expires = this.now() + leaseMs;
    for (const t of tokens) this.leases.set(t, { expires, ...(probe ? { probe: true } : {}) });
    await this.saveLeases();
    return { tokens };
  }

  /** Hands free slots to waiters in arrival order. */
  private pump() {
    if (this.tripState() !== "open") return;
    const eff = this.effectiveSlots();
    while (this.queue.length && this.leases.size + this.queue[0].n <= eff) {
      const w = this.queue.shift()!;
      clearTimeout(w.timer);
      const tokens = Array.from({ length: w.n }, () => crypto.randomUUID());
      const expires = this.now() + w.leaseMs;
      for (const t of tokens) this.leases.set(t, { expires });
      w.resolve({ tokens });
    }
    void this.saveLeases();
  }

  async release(body: any) {
    const entries: { token: string; outcome?: CallKind; rate?: RateInfo }[] = Array.isArray(body?.entries) ? body.entries : [];
    const now = this.now();
    let probeResult: CallKind | null = null;
    for (const e of entries) {
      const l = this.leases.get(e?.token);
      if (!l) continue; // already expired or released: a late answer isn't counted twice
      this.leases.delete(e.token);
      const outcome = (e.outcome ?? "ok") as CallKind;
      if (outcome !== "unused") this.count(outcome);
      if (l.probe) probeResult = outcome;
      if (outcome === "rate") {
        this.recent429 = [...this.recent429.filter((t) => now - t < 60_000), now];
        if (this.recent429.length >= 3) this.throttleUntil = Math.max(this.throttleUntil, now + 60_000);
      }
      const r = e.rate;
      if (r && Number.isFinite(r.remaining_frac) && r.remaining_frac < 0.1)
        this.throttleUntil = Math.max(this.throttleUntil, Math.min(Number(r.reset_at) || now + THROTTLE_MAX_MS, now + THROTTLE_MAX_MS));
    }
    if (entries.some((e) => e?.outcome === "cap")) await this.setTrip("provider_cap");
    else if (probeResult && probeResult !== "unused" && probeResult !== "cap") {
      this.trip = null; // the probe went through: the cap is lifted
      await this.state.storage.put("trip", null);
    }
    await this.saveLeases();
    this.pump();
  }

  private async setTrip(reason: string) {
    const now = this.now();
    this.trip = { reason, since: this.trip?.since ?? now, probe_at: now + GATE_TRIP_PROBE_MS };
    await this.state.storage.put("trip", this.trip);
    // Everyone waiting is told now rather than after their wait runs out.
    for (const w of this.queue.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(this.busy("provider_cap", GATE_TRIP_PROBE_MS / 1000));
    }
  }

  private count(kind: CallKind | "busy") {
    const now = this.now();
    let b = this.buckets[this.buckets.length - 1];
    if (!b || now - b.at >= BUCKET_MS) this.buckets.push((b = { at: now }));
    b[kind] = (b[kind] ?? 0) + 1;
    this.buckets = this.buckets.filter((x) => now - x.at < WINDOW_MS);
  }

  stats() {
    const now = this.now();
    const sum: Partial<Record<CallKind | "busy", number>> = {};
    for (const b of this.buckets.filter((x) => now - x.at < WINDOW_MS))
      for (const [k, v] of Object.entries(b)) if (k !== "at") sum[k as CallKind] = (sum[k as CallKind] ?? 0) + (v as number);
    const calls = (sum.ok ?? 0) + (sum.rate ?? 0) + (sum.server ?? 0) + (sum.timeout ?? 0) + (sum.network ?? 0) + (sum.cap ?? 0) + (sum.client ?? 0);
    const failed = calls - (sum.ok ?? 0) - (sum.client ?? 0);
    return {
      ...this.peek(),
      throttled_until: this.throttleUntil > now ? new Date(this.throttleUntil).toISOString() : null,
      trip: this.trip ? { reason: this.trip.reason, since: new Date(this.trip.since).toISOString(), probe_at: new Date(this.trip.probe_at).toISOString() } : null,
      last_15_min: { ...sum, calls, failure_rate: calls ? Math.round((failed / calls) * 1000) / 1000 : 0 },
    };
  }
}
