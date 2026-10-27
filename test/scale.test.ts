// Phase 1 scale protections: admission gates, provider caps, sharded counters, health, payment watch, fake AI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/gate.ts";
import { acquireSlots, quickBusy, slotsFor, poolsOfProvider, _clearSnapshots } from "../src/gateclient.ts";
import { classifyStatus, isSpendCap, poolOf, rateInfo, summarize, ProviderCapError } from "../src/providers.ts";
import { Health, adminOk, evaluateHealth, pauseState, recordEvent, _resetHealthCaches } from "../src/health.ts";
import { classifyPaidResponse, plausiblePayment, priceMicro } from "../src/paywatch.ts";
import { recordSettleFailure, walletBlocked } from "../src/health.ts";
import { fakeAiConfig, fakeModelResponse } from "../src/fakeai.ts";
import { Ledger, ledgerShardName, shardLimit, LEDGER_SHARDS } from "../src/ledger.ts";
import { runOneReviewer } from "../src/review.ts";
import { runOneJudge } from "../src/judge.ts";

const memStorage = (d = new Map<string, unknown>()) => ({
  async get(k: string) { return structuredClone(d.get(k)); },
  async put(k: string, v: unknown) { d.set(k, structuredClone(v)); },
  async delete(k: string | string[]) { for (const x of [k].flat()) d.delete(x); return true; },
  async list(o: { prefix?: string; limit?: number }) { return new Map([...d.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort().slice(0, o.limit ?? 1e9).map((k) => [k, d.get(k)])); },
  async deleteAll() { d.clear(); },
  async setAlarm() {},
});

/** A Durable Object namespace in memory: one instance per name, reached through fetch like the real thing. */
function namespace<T extends { fetch(r: Request): Promise<Response> }>(make: () => T) {
  const objs = new Map<string, T>();
  const ns = {
    objs,
    broken: new Set<string>(),
    idFromName: (n: string) => n,
    get(id: string) {
      if (!objs.has(id)) objs.set(id, make());
      return {
        fetch: async (u: string, i?: RequestInit) => {
          if (ns.broken.has(id)) throw new Error("Durable Object reset because its code was updated");
          return objs.get(id)!.fetch(new Request(u, i));
        },
      };
    },
  };
  return ns;
}
const gates = () => namespace(() => new Gate({ storage: memStorage() } as any));

// ---------- providers ----------

test("provider answers are classified: spend caps and credit errors are told apart from busy and broken", () => {
  assert.equal(poolOf("claude-opus-5-5"), "anthropic:claude-opus-5-5");
  assert.equal(poolOf("openai/gpt-6-luna"), "openrouter");
  const capBody = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "x", details: { error_code: "enforced_spend_limit_reached" } } });
  assert.equal(classifyStatus("claude-opus-5-5", 429, capBody), "cap");
  assert.equal(classifyStatus("claude-opus-5-5", 429, '{"error":{"message":"Number of concurrent connections has exceeded your rate limit"}}'), "rate");
  assert.equal(classifyStatus("claude-opus-5-5", 400, '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'), "cap");
  assert.equal(classifyStatus("claude-opus-5-5", 400, '{"error":{"message":"You have reached your specified API usage limits."}}'), "cap");
  assert.equal(classifyStatus("claude-opus-5-5", 400, '{"error":{"message":"max_tokens: must be at most 8192"}}'), "client");
  assert.equal(classifyStatus("openai/gpt-6-luna", 402, "{}"), "cap");
  assert.equal(classifyStatus("openai/gpt-6-luna", 529, "{}"), "server");
  assert.equal(isSpendCap("claude-opus-5-5", 500, "billing"), false, "a 5xx is never a cap");
});

test("rate-limit headers are read from either provider; the lowest share left wins", () => {
  const now = Date.parse("2026-10-27T20:00:00Z");
  const h = new Headers({
    "anthropic-ratelimit-requests-remaining": "900", "anthropic-ratelimit-requests-limit": "1000", "anthropic-ratelimit-requests-reset": "2026-10-27T20:00:30Z",
    "anthropic-ratelimit-output-tokens-remaining": "4000", "anthropic-ratelimit-output-tokens-limit": "80000", "anthropic-ratelimit-output-tokens-reset": "2026-10-27T20:00:20Z",
  });
  assert.deepEqual(rateInfo(h, now), { remaining_frac: 0.05, reset_at: Date.parse("2026-10-27T20:00:20Z") });
  assert.equal(rateInfo(new Headers(), now), null);
  assert.equal(rateInfo(new Headers({ "x-ratelimit-remaining": "5", "x-ratelimit-limit": "10", "x-ratelimit-reset": String(now + 5000) }), now)!.reset_at, now + 5000);
  assert.equal(summarize([{ kind: "rate" }, { kind: "ok" }]).outcome, "rate", "a busy try that later worked still shows pressure");
  assert.equal(summarize([]).outcome, "unused");
  assert.equal(summarize([{ kind: "ok" }, { kind: "cap" }]).outcome, "cap");
});

// ---------- the gate itself ----------

async function gateCall(g: Gate, action: string, body?: object) {
  return (await g.fetch(new Request(`https://gate/${action}`, body ? { method: "POST", body: JSON.stringify(body) } : undefined))).json() as any;
}

test("a gate never lets more calls run than its slots, queues in order, and answers busy when the line is full", async () => {
  const g = new Gate({ storage: memStorage() } as any);
  const a = await gateCall(g, "acquire", { n: 1, slots: 2, lease_ms: 60_000, wait_ms: 0 });
  const b = await gateCall(g, "acquire", { n: 1, slots: 2, lease_ms: 60_000, wait_ms: 0 });
  assert.equal(a.tokens.length + b.tokens.length, 2);
  const c = await gateCall(g, "acquire", { n: 1, slots: 2, lease_ms: 60_000, wait_ms: 0 });
  assert.equal(c.busy, true, "no waiting allowed: busy at once");
  // Two waiters (2 x slots would allow 4), released in arrival order.
  const order: string[] = [];
  const w1 = gateCall(g, "acquire", { n: 1, slots: 2, lease_ms: 60_000, wait_ms: 5_000 }).then((r) => (order.push("w1"), r));
  const w2 = gateCall(g, "acquire", { n: 1, slots: 2, lease_ms: 60_000, wait_ms: 5_000 }).then((r) => (order.push("w2"), r));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await gateCall(g, "peek")).queued, 2);
  await gateCall(g, "release", { entries: [{ token: a.tokens[0], outcome: "ok" }] });
  await gateCall(g, "release", { entries: [{ token: b.tokens[0], outcome: "ok" }] });
  const [r1, r2] = await Promise.all([w1, w2]);
  assert.ok(r1.tokens && r2.tokens);
  assert.deepEqual(order, ["w1", "w2"]);
  assert.equal((await gateCall(g, "peek")).inflight, 2);
  // A release for a token that's already gone (expired, or released twice) changes nothing.
  await gateCall(g, "release", { entries: [{ token: a.tokens[0], outcome: "ok" }] });
  assert.equal((await gateCall(g, "peek")).inflight, 2);
});

test("a waiter gives up after its wait with a busy answer; the line is capped at 2 x slots", async () => {
  const g = new Gate({ storage: memStorage() } as any);
  await gateCall(g, "acquire", { n: 1, slots: 1, lease_ms: 60_000 });
  const t0 = Date.now();
  const waits = [1, 2].map(() => gateCall(g, "acquire", { n: 1, slots: 1, lease_ms: 60_000, wait_ms: 200 }));
  await new Promise((r) => setTimeout(r, 5));
  const third = await gateCall(g, "acquire", { n: 1, slots: 1, lease_ms: 60_000, wait_ms: 200 });
  assert.equal(third.reason, "queue_full");
  const res = await Promise.all(waits);
  assert.ok(res.every((r) => r.busy && r.reason === "wait_timeout" && r.retry_after_s >= 1));
  assert.ok(Date.now() - t0 >= 190);
  assert.equal((await gateCall(g, "acquire", { n: 2, slots: 1, lease_ms: 1000 })).reason, "too_large", "a request bigger than the pool is refused, not queued forever");
});

test("leases expire on their own (a crashed Worker can't leak slots) and survive a gate restart", async () => {
  const d = new Map();
  const g = new Gate({ storage: memStorage(d) } as any);
  let now = 1_000_000;
  g.now = () => now;
  const a = await gateCall(g, "acquire", { n: 1, slots: 1, lease_ms: 10_000 });
  assert.ok(a.tokens);
  // A new instance (restart or eviction) still counts the call in flight.
  const g2 = new Gate({ storage: memStorage(d) } as any);
  g2.now = () => now;
  assert.equal((await gateCall(g2, "acquire", { n: 1, slots: 1, lease_ms: 10_000 })).busy, true);
  now += 10_001;
  await g2.alarm();
  assert.ok((await gateCall(g2, "acquire", { n: 1, slots: 1, lease_ms: 10_000 })).tokens, "the expired lease freed its slot");
});

test("low rate-limit headroom or a burst of 429s halves the slots for a while", async () => {
  const g = new Gate({ storage: memStorage() } as any);
  let now = 5_000_000;
  g.now = () => now;
  const t = await gateCall(g, "acquire", { n: 1, slots: 4, lease_ms: 60_000 });
  await gateCall(g, "release", { entries: [{ token: t.tokens[0], outcome: "ok", rate: { remaining_frac: 0.05, reset_at: now + 20_000 } }] });
  assert.equal((await gateCall(g, "peek")).effective, 2);
  now += 20_001;
  assert.equal((await gateCall(g, "peek")).effective, 4, "back to normal after the reset time");
  for (let i = 0; i < 3; i++) {
    const x = await gateCall(g, "acquire", { n: 1, slots: 4, lease_ms: 60_000 });
    await gateCall(g, "release", { entries: [{ token: x.tokens[0], outcome: "rate" }] });
  }
  assert.equal((await gateCall(g, "peek")).effective, 2);
  const s = await gateCall(g, "stats");
  assert.equal(s.last_15_min.rate, 3);
  assert.ok(s.throttled_until);
});

test("a spend cap closes the pool; after an hour one probe goes through, and its success reopens the pool", async () => {
  const g = new Gate({ storage: memStorage() } as any);
  let now = 9_000_000;
  g.now = () => now;
  const t = await gateCall(g, "acquire", { n: 1, slots: 3, lease_ms: 60_000 });
  const waiting = gateCall(g, "acquire", { n: 3, slots: 3, lease_ms: 60_000, wait_ms: 5_000 });
  await new Promise((r) => setTimeout(r, 5));
  await gateCall(g, "release", { entries: [{ token: t.tokens[0], outcome: "cap" }] });
  assert.equal((await waiting).reason, "provider_cap", "waiters are told at once");
  const refused = await gateCall(g, "acquire", { n: 1, slots: 3, lease_ms: 60_000 });
  assert.equal(refused.reason, "provider_cap");
  assert.ok(refused.retry_after_s > 3000);
  assert.equal((await gateCall(g, "peek")).full, true);
  now += 3600_001;
  const probe = await gateCall(g, "acquire", { n: 1, slots: 3, lease_ms: 60_000 });
  assert.ok(probe.tokens, "the probe call");
  assert.equal((await gateCall(g, "acquire", { n: 1, slots: 3, lease_ms: 60_000 })).busy, true, "only one probe at a time");
  await gateCall(g, "release", { entries: [{ token: probe.tokens[0], outcome: "ok" }] });
  assert.ok((await gateCall(g, "acquire", { n: 1, slots: 3, lease_ms: 60_000 })).tokens, "reopened");
  // The operator can also reopen it directly.
  await gateCall(g, "trip", { reason: "provider_cap" });
  assert.equal((await gateCall(g, "acquire", { n: 1, slots: 3, lease_ms: 60_000 })).busy, true);
  await gateCall(g, "reset", {});
  assert.ok((await gateCall(g, "acquire", { n: 1, slots: 3, lease_ms: 60_000 })).tokens);
});

test("3,000 simultaneous callers: slots are never exceeded, the line stays capped, everyone gets a quick answer", async () => {
  const g = new Gate({ storage: memStorage() } as any);
  const slots = 20;
  let inflight = 0;
  let peak = 0;
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: 3000 }, async () => {
      const r = await gateCall(g, "acquire", { n: 1, slots, lease_ms: 60_000, wait_ms: 300 });
      if (!r.tokens) return "busy";
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((res) => setTimeout(res, 20 + Math.random() * 30));
      inflight--;
      await gateCall(g, "release", { entries: [{ token: r.tokens[0], outcome: "ok" }] });
      return "ok";
    }),
  );
  assert.ok(peak <= slots, `peak ${peak} <= ${slots}`);
  const ok = results.filter((r) => r === "ok").length;
  assert.ok(ok >= slots, `at least the first ${slots} ran (${ok})`);
  assert.equal(ok + results.filter((r) => r === "busy").length, 3000, "every caller got an answer");
  assert.ok(Date.now() - t0 < 5_000, "nobody waited longer than the wait limit plus a little");
  assert.equal((await gateCall(g, "peek")).inflight, 0);
});

// ---------- the Worker side ----------

const models3 = ["claude-opus-5-5", "openai/gpt-6-luna", "google/gemini-3.7-flash"];

test("slots are taken all-or-nothing across pools; refused requests give back what they took", async () => {
  _clearSnapshots();
  const ns = gates();
  const env: any = { GATES: ns, GATE_SLOTS_OPENROUTER: "1" };
  assert.equal(slotsFor(env, "openrouter"), 1);
  assert.equal(slotsFor({} as any, "anthropic:claude-opus-5-5"), 6);
  const r = await acquireSlots(env, models3, { leaseMs: 60_000, waitMs: 0 });
  assert.equal(r.ok, false, "two OpenRouter reviewers can't fit in one slot");
  const opus = await (ns.objs.get("anthropic:claude-opus-5-5") as Gate).fetch(new Request("https://gate/peek"));
  assert.equal(((await opus.json()) as any).inflight, 0, "the Opus slot it took was given back");
  env.GATE_SLOTS_OPENROUTER = "4";
  const ok = await acquireSlots(env, models3, { leaseMs: 60_000, waitMs: 0 });
  assert.ok(ok.ok);
  if (!ok.ok) return;
  ok.lease.observe(0, { kind: "ok" });
  ok.lease.observe(1, { kind: "rate" });
  ok.lease.observe(1, { kind: "ok" });
  await ok.lease.release();
  await ok.lease.release(); // twice is harmless
  const st: any = await (await (ns.objs.get("openrouter") as Gate).fetch(new Request("https://gate/stats"))).json();
  assert.equal(st.inflight, 0);
  assert.equal(st.last_15_min.rate, 1);
  assert.equal(st.last_15_min.unused, undefined, "an unused slot isn't counted as a call");
});

test("a gate that throws or restarts mid-request turns into busy, never an error or a hang", async () => {
  _clearSnapshots();
  const ns = gates();
  ns.broken.add("openrouter");
  const env: any = { GATES: ns };
  const r = await acquireSlots(env, models3, { leaseMs: 60_000, waitMs: 0 });
  assert.deepEqual(r, { ok: false, retryAfter: 5, reason: "gate_unavailable" });
  assert.deepEqual(await quickBusy(env, models3), { retryAfter: 5, reason: "gate_unavailable" }, "the pre-payment check fails closed too");
  // No gates bound (self-hosting, old tests): everything runs as before.
  assert.equal((await acquireSlots({} as any, models3, { leaseMs: 1, waitMs: 0 })).ok, true);
  assert.equal(await quickBusy({} as any, models3), null);
});

test("unpaid first calls are answered from a 2-second snapshot; a refusal marks the pool full", async () => {
  _clearSnapshots();
  const ns = gates();
  const env: any = { GATES: ns, GATE_SLOTS_ANTHROPIC_CLAUDE_SONNET_5_5: "1" };
  let peeks = 0;
  const real = ns.get.bind(ns);
  ns.get = (id: string) => {
    const s = real(id);
    return { fetch: (u: string, i?: RequestInit) => (u.endsWith("/peek") && peeks++, s.fetch(u, i)) };
  };
  for (let i = 0; i < 50; i++) assert.equal(await quickBusy(env, ["claude-sonnet-5-5"]), null);
  assert.equal(peeks, 1, "50 first calls, one gate call");
  const hold = await acquireSlots(env, ["claude-sonnet-5-5"], { leaseMs: 60_000, waitMs: 0 });
  assert.ok(hold.ok);
  const refused = await acquireSlots(env, ["claude-sonnet-5-5"], { leaseMs: 60_000, waitMs: 0 });
  assert.equal(refused.ok, false);
  assert.ok(await quickBusy(env, ["claude-sonnet-5-5"]), "seen full: first calls are told busy without asking the gate");
});

test("a spend cap on one Claude model closes every Claude pool (caps are account-wide), not OpenRouter", async () => {
  _clearSnapshots();
  const ns = gates();
  const env: any = { GATES: ns };
  const pools = poolsOfProvider(env, "anthropic");
  assert.ok(pools.includes("anthropic:claude-opus-5-5") && pools.includes("anthropic:claude-haiku-5-5") && !pools.includes("openrouter"));
  const r = await acquireSlots(env, ["claude-sonnet-5-5"], { leaseMs: 60_000, waitMs: 0 });
  assert.ok(r.ok);
  if (!r.ok) return;
  r.lease.observe(0, { kind: "cap", status: 429 });
  await r.lease.release();
  assert.equal(r.lease.capHit(), true);
  _clearSnapshots();
  assert.equal((await acquireSlots(env, ["claude-haiku-5-5"], { leaseMs: 60_000, waitMs: 0 })).ok, false, "another Claude model is closed too");
  assert.equal((await acquireSlots(env, ["openai/gpt-6-luna"], { leaseMs: 60_000, waitMs: 0 })).ok, true, "OpenRouter is a different account");
});

test("reviewers and judges stop at a spend cap instead of retrying into it, and report every call", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "enforced_spend_limit_reached" } }), { status: 429 });
  }) as any;
  try {
    const seen: string[] = [];
    await assert.rejects(
      runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-opus-5-5", 1, { task: "Add 2 and 2.", output: "4" }, 1000, { sleep: async () => {}, observe: (o) => seen.push(o.kind) }),
      (e: any) => e instanceof ProviderCapError && /429/.test(e.message),
    );
    assert.equal(calls, 1, "not retried");
    assert.deepEqual(seen, ["cap"]);
    calls = 0;
    await assert.rejects(
      runOneJudge({ keys: { ANTHROPIC_API_KEY: "a" }, model: "claude-haiku-5-5", formatVersion: "agent-referee-judge-v4", panelist: 1, order: "sorted", rules: "r", submissions: { a: "x", b: "y" }, sleep: async () => {} }),
      /spend or credit limit/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

// ---------- sharded counters ----------

test("callers spread over 16 ledger shards; shard ceilings add up to no more than the global ones", () => {
  assert.equal(ledgerShardName(undefined), "global");
  assert.equal(ledgerShardName("a3f0"), "shard-10");
  assert.equal(ledgerShardName("a3f0"), ledgerShardName("a3f0"), "stable");
  const seen = new Set(Array.from({ length: 16 }, (_, i) => ledgerShardName(i.toString(16) + "00")));
  assert.equal(seen.size, LEDGER_SHARDS);
  assert.equal(shardLimit(undefined, 500), 31);
  assert.ok(shardLimit(undefined, 500) * LEDGER_SHARDS <= 500);
  assert.equal(shardLimit("2000", 2000) * LEDGER_SHARDS, 2000);
});

// ---------- health, pause, admin ----------

test("health turns degraded for each reason and names it", () => {
  const now = Date.now();
  const okGate = { tripped: false, last_15_min: { calls: 50, failure_rate: 0.02 } };
  assert.deepEqual(evaluateHealth({ gates: { openrouter: okGate }, events: [], ledger: "ok", now }), { degraded: false, reasons: [], warnings: [] });
  assert.deepEqual(evaluateHealth({ gates: { openrouter: { ...okGate, tripped: true } }, events: [], ledger: "ok", now }).reasons, ["provider_cap:openrouter"]);
  assert.deepEqual(evaluateHealth({ gates: { openrouter: { last_15_min: { calls: 20, failure_rate: 0.3 } } }, events: [], ledger: "ok", now }).reasons, ["failure_rate:openrouter"]);
  assert.equal(evaluateHealth({ gates: { openrouter: { last_15_min: { calls: 3, failure_rate: 1 } } }, events: [], ledger: "ok", now }).degraded, false, "too few calls to judge");
  assert.deepEqual(evaluateHealth({ gates: { x: { error: "unreachable" } }, events: [], ledger: "ok", now }).reasons, ["gate_unreachable:x"]);
  assert.deepEqual(evaluateHealth({ gates: {}, events: [], ledger: "error", now }).reasons, ["ledger_error"]);
  assert.deepEqual(evaluateHealth({ gates: {}, events: [{ kind: "settle_failure", at: now - 60_000, detail: "" }], ledger: "ok", now }).reasons, ["settle_failure"]);
  assert.deepEqual(evaluateHealth({ gates: {}, events: [{ kind: "credit_problem", at: now, detail: "" }], ledger: "ok", now }).reasons, ["credit_problem"]);
  const fac = (n: number) => Array.from({ length: n }, () => ({ kind: "facilitator_problem" as const, at: now, detail: "" }));
  assert.equal(evaluateHealth({ gates: {}, events: fac(2), ledger: "ok", now }).degraded, false);
  assert.deepEqual(evaluateHealth({ gates: {}, events: fac(3), ledger: "ok", now }).reasons, ["facilitator_down"]);
  assert.equal(evaluateHealth({ gates: {}, events: [{ kind: "settle_failure", at: now - 16 * 60_000, detail: "" }], ledger: "ok", now }).degraded, false, "it recovers after 15 minutes");
  assert.deepEqual(evaluateHealth({ gates: {}, events: [], ledger: "ok", now, unjudgedOpen: 2 }).reasons, ["unjudged_to_refund:2"], "a refund waiting for the operator alerts");
});

test("the phone pause switch is stored, cached briefly, and survives a Health outage", async () => {
  _resetHealthCaches();
  const ns = namespace(() => new Health({ storage: memStorage() } as any));
  const env: any = { HEALTH: ns };
  assert.deepEqual(await pauseState(env), { paid: false, reviews: false });
  const { setPause } = await import("../src/health.ts");
  assert.deepEqual(await setPause(env, "reviews", true), { paid: false, reviews: true });
  assert.deepEqual(await pauseState(env), { paid: false, reviews: true });
  ns.broken.add("global");
  _resetHealthCaches();
  assert.deepEqual(await pauseState(env), { paid: false, reviews: false }, "no state known and Health down: not paused (the wrangler secrets still work)");
  ns.broken.delete("global");
  await recordEvent(env, "credit_problem", "settle: insufficient credits");
  const ev: any = await (await ns.get("global").fetch("https://health/events")).json();
  assert.equal(ev[0].kind, "credit_problem");
});

test("admin endpoints need the exact token; no token configured means no admin at all", async () => {
  const token = "t".repeat(40);
  assert.equal(await adminOk({ ADMIN_TOKEN: token } as any, `Bearer ${token}`), true);
  assert.equal(await adminOk({ ADMIN_TOKEN: token } as any, `Bearer ${token}x`), false);
  assert.equal(await adminOk({ ADMIN_TOKEN: token } as any, undefined), false);
  assert.equal(await adminOk({ ADMIN_TOKEN: "short" } as any, "Bearer short"), false, "a weak token is refused");
  assert.equal(await adminOk({} as any, "Bearer anything"), false);
});

// ---------- payment watch ----------

test("paid requests are classified from the final response: settled, refused, payer problems, facilitator problems", () => {
  assert.equal(classifyPaidResponse({ hadPayment: false, handlerRan: false, status: 402 }).kind, "challenge");
  assert.equal(classifyPaidResponse({ hadPayment: true, handlerRan: true, handlerStatus: 200, status: 200 }).kind, "settled");
  assert.equal(classifyPaidResponse({ hadPayment: true, handlerRan: true, handlerStatus: 503, status: 503 }).kind, "not_charged");
  assert.deepEqual(classifyPaidResponse({ hadPayment: true, handlerRan: false, status: 402, errorText: "insufficient_funds" }), { kind: "payer_problem", stage: "verify", detail: "insufficient_funds" });
  assert.deepEqual(classifyPaidResponse({ hadPayment: true, handlerRan: false, status: 402, errorText: "fetch failed" }), { kind: "facilitator_problem", stage: "verify", detail: "fetch failed", credit: false });
  const s = classifyPaidResponse({ hadPayment: true, handlerRan: true, handlerStatus: 200, status: 402, errorText: "Insufficient credits. Top up at merchant.payai.network" });
  assert.deepEqual(s, { kind: "facilitator_problem", stage: "settle", detail: "Insufficient credits. Top up at merchant.payai.network", credit: true });
});

// ---------- fake AI (staging only) ----------

test("fake AI only ever runs on staging, never with real money", () => {
  assert.equal(fakeAiConfig({ FAKE_AI: "true" }), null);
  assert.equal(fakeAiConfig({ FAKE_AI: "true", STAGING: "true", NETWORK: "base" }), null, "real-money network: off");
  assert.equal(fakeAiConfig({ FAKE_AI: "true", STAGING: "true" }), null, "network not set: off");
  assert.equal(fakeAiConfig({ FAKE_AI: "false", STAGING: "true", NETWORK: "base-sepolia" }), null);
  assert.deepEqual(fakeAiConfig({ FAKE_AI: "true", STAGING: "true", NETWORK: "base-sepolia", FAKE_AI_DELAY_MS: "10-20", FAKE_AI_MIX: "429:0.1,cap:0.05" }), { minMs: 10, maxMs: 20, mix: [["429", 0.1], ["cap", 0.05]] });
});

test("fake answers go through the real review and judge code paths", async () => {
  const cfg = { minMs: 1, maxMs: 2, mix: [] as [string, number][] };
  const vote = await runOneReviewer({ fake: cfg }, "claude-sonnet-5-5", 1, { task: "Add 2 and 2.", output: "4" });
  assert.equal(vote.verdict, "pass");
  const or = await runOneReviewer({ fake: cfg }, "openai/gpt-6-luna", 2, { task: "Add 2 and 2.", output: "4" });
  assert.equal(or.verdict, "pass");
  const j = await runOneJudge({ keys: { fake: cfg }, model: "claude-haiku-5-5", formatVersion: "agent-referee-judge-v4", panelist: 1, order: "sorted", rules: "Pick one.", submissions: { alpha: "x", beta: "y" } });
  assert.ok(["alpha", "beta"].includes(j.winner!));
  const cap = await fakeModelResponse({ ...cfg, mix: [["cap", 1]] }, "claude-opus-5-5", "u");
  assert.equal(classifyStatus("claude-opus-5-5", cap.status, await cap.text()), "cap");
  const orCap = await fakeModelResponse({ ...cfg, mix: [["cap", 1]] }, "openai/gpt-6-luna", "u");
  assert.equal(orCap.status, 402);
  const busy = await fakeModelResponse({ ...cfg, mix: [["429", 1]] }, "claude-opus-5-5", "u");
  assert.equal(classifyStatus("claude-opus-5-5", busy.status, await busy.text()), "rate");
  await assert.rejects(fakeModelResponse({ ...cfg, mix: [["hang", 1]] }, "claude-opus-5-5", "u", AbortSignal.timeout(20)), /abort|timeout/i);
});

// ---------- second review round (panel mode): fake payment headers, persistence, settle failures ----------

const PAY_TO = "0xF6B53AaCf822A36b7B2aF9C45BabE6E367ede4d3";
const header = (o: any = {}) =>
  btoa(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0x" + "ab".repeat(65), authorization: { from: "0x" + "1".repeat(40), to: PAY_TO.toLowerCase(), value: "50000", validAfter: "0", validBefore: String(2_000_000_000), nonce: "0x" + "0".repeat(64), ...o } } }));

test("only a payment header that claims to pay us the right amount can take gate slots before verification", () => {
  const opts = { payTo: PAY_TO, network: "base", minMicro: priceMicro("$0.05"), nowS: 1_900_000_000 };
  assert.equal(priceMicro("$0.20"), 200_000);
  assert.equal(plausiblePayment(header(), opts), true);
  assert.equal(plausiblePayment(undefined, opts), false);
  assert.equal(plausiblePayment("garbage", opts), false);
  assert.equal(plausiblePayment(btoa("{}"), opts), false);
  assert.equal(plausiblePayment(header({ to: "0x" + "9".repeat(40) }), opts), false, "paying someone else");
  assert.equal(plausiblePayment(header({ value: "10000" }), opts), false, "too little");
  assert.equal(plausiblePayment(header({ validBefore: "1" }), opts), false, "expired");
  assert.equal(plausiblePayment(header(), { ...opts, network: "base-sepolia" }), false, "wrong network");
  assert.equal(plausiblePayment(header(), { ...opts, minMicro: priceMicro("$0.20") }), false, "a $0.05 payment for a $0.20 review");
});

test("a restarted gate remembers it was throttled (and tripped)", async () => {
  const d = new Map();
  const g = new Gate({ storage: memStorage(d) } as any);
  let now = 7_000_000;
  g.now = () => now;
  const t = await gateCall(g, "acquire", { n: 1, slots: 4, lease_ms: 60_000 });
  await gateCall(g, "release", { entries: [{ token: t.tokens[0], outcome: "ok", rate: { remaining_frac: 0.01, reset_at: now + 30_000 } }] });
  const g2 = new Gate({ storage: memStorage(d) } as any);
  g2.now = () => now;
  await gateCall(g2, "acquire", { n: 1, slots: 4, lease_ms: 1000, wait_ms: 0 });
  assert.equal((await gateCall(g2, "peek")).effective, 2, "still halved after the restart");
  await gateCall(g2, "trip", { reason: "provider_cap" });
  const g3 = new Gate({ storage: memStorage(d) } as any);
  g3.now = () => now;
  assert.equal((await gateCall(g3, "acquire", { n: 1, slots: 4, lease_ms: 1000 })).reason, "provider_cap");
});

test("work delivered but not paid: the wallet is refused from then on, and repeated failures pause paid routes", async () => {
  _resetHealthCaches();
  const ns = namespace(() => new Health({ storage: memStorage() } as any));
  const env: any = { HEALTH: ns, SETTLE_FAIL_PAUSE_AFTER: "3" };
  const w = "0x" + "c".repeat(40);
  assert.equal(await walletBlocked(env, w), false);
  await recordSettleFailure(env, w, "settle: insufficient_funds");
  assert.equal(await walletBlocked(env, w), true, "refused at once in this isolate");
  _resetHealthCaches();
  assert.equal(await walletBlocked(env, w), true, "and everywhere else after the cache refresh");
  assert.equal((await pauseState(env)).paid, false, "one failure doesn't pause");
  await recordSettleFailure(env, "0x" + "d".repeat(40), "x");
  await recordSettleFailure(env, "0x" + "e".repeat(40), "x");
  _resetHealthCaches();
  const p = await pauseState(env);
  assert.equal(p.paid, true, "three within the hour pause paid routes");
  assert.match(String(p.auto), /3 payments failed to settle/);
  const { setPause } = await import("../src/health.ts");
  assert.equal((await setPause(env, "paid", false)).auto, undefined, "resuming clears the automatic pause");
});
