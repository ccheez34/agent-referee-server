// The Worker's routes with the Phase 1 protections: busy before payment, pause switches, fail-closed limits, admin, health.
// Needs the installed dependencies (hono, x402-hono): run with npm test on a machine where npm install has run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/gate.ts";
import { Health, _resetHealthCaches } from "../src/health.ts";
import { Ledger } from "../src/ledger.ts";
import { MatchRoom } from "../src/match.ts";
import { _clearSnapshots } from "../src/gateclient.ts";

let app: any = null;
try {
  app = (await import("../src/index.ts")).default;
} catch (e) {
  console.log(`routes tests skipped (dependencies not installed here): ${String((e as any)?.message ?? e).slice(0, 120)}`);
}
const t = app ? test : test.skip;

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };
const mem = () => {
  const d = new Map<string, unknown>();
  return { storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); }, async delete(k: any) { for (const x of [k].flat()) d.delete(x); return true; }, async list() { return new Map(); }, async deleteAll() { d.clear(); }, async setAlarm() {} } };
};
function ns<T extends { fetch(r: Request): Promise<Response> }>(make: () => T) {
  const objs = new Map<string, T>();
  const n = { objs, broken: false, idFromName: (x: string) => x, get: (id: string) => ({ fetch: async (u: string, i?: RequestInit) => { if (n.broken) throw new Error("object unavailable"); if (!objs.has(id)) objs.set(id, make()); return objs.get(id)!.fetch(new Request(u, i)); } }) };
  return n;
}
const ADMIN = "a".repeat(40);
function env(extra: Record<string, unknown> = {}) {
  _clearSnapshots();
  _resetHealthCaches();
  const e: any = {
    ...keys,
    PAY_TO: "0x0000000000000000000000000000000000000001",
    NETWORK: "base-sepolia",
    PAYMENTS_ENABLED: "false",
    STAGING: "true",
    FAKE_AI: "true",
    FAKE_AI_DELAY_MS: "1-5",
    ANTHROPIC_API_KEY: "fake",
    OPENROUTER_API_KEY: "fake",
    ADMIN_TOKEN: ADMIN,
    GATES: ns(() => new Gate(mem() as any)),
    HEALTH: ns(() => new Health(mem() as any)),
    ...extra,
  };
  e.LEDGER = e.LEDGER ?? ns(() => new Ledger(mem() as any, e));
  e.MATCHES = ns(() => new MatchRoom(mem() as any, e));
  return e;
}
const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = async (e: any, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.fetch(new Request(`https://x${path}`, body === undefined ? { headers } : { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers }, body: JSON.stringify(body) }), e, ctx);
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as any };
};
const review = { task: "Add 2 and 2 and give only the number.", output: "4" };

t("a review runs through the gate and gives its slot back", async () => {
  const e = env();
  const r = await call(e, "/review", review);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.verdict, "pass");
  const peek: any = await (await e.GATES.get("anthropic:claude-sonnet-5-5").fetch("https://gate/stats")).json();
  assert.equal(peek.inflight, 0);
  assert.equal(peek.last_15_min.ok, 1);
});

t("no capacity: 503 busy with Retry-After, before any AI call", async () => {
  const e = env({ GATE_SLOTS_ANTHROPIC_CLAUDE_SONNET_5_5: "0" });
  const r = await call(e, "/review", review);
  assert.equal(r.status, 503);
  assert.equal(r.body.busy, true);
  assert.ok(Number(r.headers.get("retry-after")) >= 1);
  assert.match(r.body.error, /Nothing was charged/);
});

t("with payments on, a full pool answers busy before the payment challenge, and the facilitator is never called", async () => {
  const e = env({ PAYMENTS_ENABLED: "true", GATE_SLOTS_ANTHROPIC_CLAUDE_SONNET_5_5: "0" });
  const orig = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => (outside++, new Response("{}"))) as any;
  try {
    const r = await call(e, "/review", review);
    assert.equal(r.status, 503);
    assert.equal(outside, 0, "no facilitator or AI call");
    const ok = await call(env({ PAYMENTS_ENABLED: "true" }), "/review", review);
    assert.equal(ok.status, 402, "with room, the normal payment challenge");
  } finally {
    globalThis.fetch = orig;
  }
});

t("bad input is refused before payment", async () => {
  const r = await call(env({ PAYMENTS_ENABLED: "true" }), "/review", { task: "short", output: "" });
  assert.equal(r.status, 400);
});

t("review limits fail closed: a ledger outage refuses reviews and demos instead of letting them through free", async () => {
  const e = env();
  e.LEDGER.broken = true;
  const r = await call(e, "/review", review);
  assert.equal(r.status, 503);
  assert.match(r.body.error, /can't be checked/);
  const d = await call(e, "/matches", { tier: "rps", seats: ["a", "b"], demo: true });
  assert.equal(d.status, 503);
});

t("pause switches: the wrangler secret, and the phone switch with the admin token", async () => {
  assert.equal((await call(env({ REVIEWS_PAUSED: "true" }), "/review", review)).status, 503);
  const e = env();
  assert.equal((await call(e, "/admin/pause", { scope: "reviews", on: true })).status, 401, "no token");
  assert.equal((await call(e, "/admin/pause", { scope: "reviews", on: true }, { authorization: "Bearer wrong" })).status, 401);
  const p = await call(e, "/admin/pause", { scope: "reviews", on: true }, { authorization: `Bearer ${ADMIN}` });
  assert.deepEqual(p.body, { paid: false, reviews: true });
  const r = await call(e, "/review", review);
  assert.equal(r.status, 503);
  assert.match(r.body.error, /paused/);
  const h = await call(e, "/health");
  assert.equal(h.body.status, "paused");
  assert.equal(h.body.checks.reviews, "paused");
  assert.equal((await call(env({ ADMIN_TOKEN: undefined }), "/admin/pause", { scope: "paid", on: true }, { authorization: `Bearer ${ADMIN}` })).status, 404, "no token configured: no admin");
});

t("health says ok, then degraded with the reason when a provider is capped, and the operator can reopen it", async () => {
  const e = env();
  const ok = await call(e, "/health");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "ok", JSON.stringify(ok.body));
  await e.GATES.get("anthropic:claude-opus-5-5").fetch("https://gate/trip", { method: "POST", body: JSON.stringify({ reason: "provider_cap" }) });
  const reset = await call(e, "/admin/gate-reset", {}, { authorization: `Bearer ${ADMIN}` }); // also clears the 30 s cache
  assert.equal(reset.status, 200);
  await e.GATES.get("anthropic:claude-opus-5-5").fetch("https://gate/trip", { method: "POST", body: JSON.stringify({ reason: "provider_cap" }) });
  await call(e, "/admin/pause", { scope: "paid", on: false }, { authorization: `Bearer ${ADMIN}` }); // clears the cache
  const bad = await call(e, "/health");
  assert.equal(bad.body.status, "degraded");
  assert.ok(bad.body.reasons.includes("provider_cap:anthropic:claude-opus-5-5"), JSON.stringify(bad.body));
  assert.equal(bad.body.checks.providers["anthropic:claude-opus-5-5"], "capped");
});

// ---------- the real x402 paywall (x402-hono) with a stand-in facilitator ----------

const PAYEE = "0x0000000000000000000000000000000000000001";
const payHeader = (from: string, value = "50000") =>
  Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature: "0x" + "ab".repeat(65),
        authorization: { from, to: PAYEE, value, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: "0x" + "1".repeat(64) },
      },
    }),
  ).toString("base64");

/** The facilitator: verify says valid; settle does what `settle` says. Counts calls. */
function fakeFacilitator(settle: "ok" | "fail" | "down", verify: "ok" | "down" = "ok") {
  const orig = globalThis.fetch;
  const calls = { verify: 0, settle: 0 };
  globalThis.fetch = (async (u: any, init: any) => {
    const url = String(u);
    const body = init?.body ? JSON.parse(init.body) : {};
    const payer = body?.paymentPayload?.payload?.authorization?.from;
    if (url.endsWith("/verify")) {
      calls.verify++;
      if (verify === "down") throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ isValid: true, payer }), { status: 200 });
    }
    if (url.endsWith("/settle")) {
      calls.settle++;
      if (settle === "down") throw new TypeError("fetch failed");
      if (settle === "fail") return new Response(JSON.stringify({ success: false, errorReason: "insufficient_funds", transaction: "", network: "base-sepolia", payer }), { status: 200 });
      return new Response(JSON.stringify({ success: true, transaction: "0x" + "cd".repeat(32), network: "base-sepolia", payer }), { status: 200 });
    }
    return orig(u, init);
  }) as any;
  return { calls, restore: () => (globalThis.fetch = orig) };
}
const settleWait = () => new Promise((r) => setTimeout(r, 50));

t("paid review through the real paywall: verified, delivered, settled once, with the settlement header", async () => {
  const f = fakeFacilitator("ok");
  try {
    const e = env({ PAYMENTS_ENABLED: "true" });
    const r = await call(e, "/review", review, { "x-payment": payHeader("0x" + "a".repeat(40)) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.headers.get("x-payment-response"), "the settlement is reported to the client");
    assert.deepEqual(f.calls, { verify: 1, settle: 1 });
  } finally {
    f.restore();
  }
});

t("work delivered but not settled: the wallet is blocked before paying again, and repeats pause paid routes", async () => {
  const f = fakeFacilitator("fail");
  try {
    const e = env({ PAYMENTS_ENABLED: "true", SETTLE_FAIL_PAUSE_AFTER: "2" });
    const w1 = "0x" + "b".repeat(40);
    const first = await call(e, "/review", review, { "x-payment": payHeader(w1) });
    assert.equal(first.status, 402, "settle failed: the client sees the payment error");
    await settleWait();
    const again = await call(e, "/review", review, { "x-payment": payHeader(w1) });
    assert.equal(again.status, 403);
    assert.match(again.body.error, /wallet_blocked/);
    assert.equal(f.calls.settle, 1, "the blocked wallet never got a second review");
    await call(e, "/review", review, { "x-payment": payHeader("0x" + "c".repeat(40)) });
    await settleWait();
    const paused = await call(e, "/review", review, { "x-payment": payHeader("0x" + "d".repeat(40)) });
    assert.equal(paused.status, 503, "two settle failures within the hour paused paid routes");
    assert.match(paused.body.error, /paused/);
    const h = await call(e, "/health");
    assert.equal(h.body.status, "degraded");
    assert.ok(h.body.reasons.some((x: string) => x.startsWith("auto_paused")) && h.body.reasons.includes("settle_failure"), JSON.stringify(h.body));
  } finally {
    f.restore();
  }
});

t("a facilitator that's down is uncharged for the agent and shows up in /health", async () => {
  const f = fakeFacilitator("ok", "down");
  try {
    const e = env({ PAYMENTS_ENABLED: "true" });
    for (const ch of ["1", "2", "3"]) {
      const r = await call(e, "/review", review, { "x-payment": payHeader("0x" + ch.repeat(40)) });
      assert.equal(r.status, 402, "verification failed: nothing ran, nothing charged");
      _resetHealthCaches(); // lift the 20 s per-kind write throttle so each failure is recorded
      await settleWait();
    }
    assert.equal(f.calls.settle, 0);
    const h = await call(e, "/health");
    assert.ok(h.body.reasons.includes("facilitator_down"), JSON.stringify(h.body));
  } finally {
    f.restore();
  }
});

t("one address: reviews beyond its in-flight room answer busy (503, Retry-After); failures past the allowance get the true 429", async () => {
  // Allowance 1 failure + 2 parallel room = 3 reviews at once from one address.
  const e = env({ REVIEW_FAIL_LIMIT: "1", REVIEW_PARALLEL_PER_ADDRESS: "2", FAKE_AI_DELAY_MS: "300-400" });
  const all = await Promise.all(Array.from({ length: 6 }, () => call(e, "/review", review)));
  const ok = all.filter((r) => r.status === 200);
  const busy = all.filter((r) => r.status === 503);
  assert.equal(ok.length, 3, JSON.stringify(all.map((r) => r.status)));
  assert.equal(busy.length, 3);
  for (const r of busy) {
    assert.equal(r.body.busy, true);
    assert.equal(r.headers.get("retry-after"), "10");
    assert.match(r.body.error, /running at once/);
    assert.match(r.body.error, /Nothing was charged/);
  }
  // One failed review from another address uses its whole allowance (1, no success): the next one is a 429 naming its own limit.
  const fail = { "x-test-fake-mix": "500:1", "x-test-fake-delay": "1-2", "cf-connecting-ip": "198.51.100.9" };
  await call(e, "/review", review, fail);
  const refused = await call(e, "/review", review, fail);
  assert.equal(refused.status, 429, JSON.stringify(refused.body));
  assert.equal(typeof refused.body.error, "string");
  assert.match(refused.body.error, /^review_fail_limit: /);
});

// ---------- free sealed reviews (the operator pays) ----------

const FREE = { FREE_REVIEW_DAILY_BUDGET_USD: "3.00" };

t("a free review needs no payment, even with payments on, and its signed receipt says funding: free", async () => {
  const { verifyReviewOutcome, verifySignature } = await import("agent-referee-client");
  const e = env({ ...FREE, PAYMENTS_ENABLED: "true" });
  const r = await call(e, "/free/review", review);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.receipt.payload.funding, "free");
  assert.equal(r.body.receipt.payload.payer, null);
  assert.deepEqual(r.body.free, { used_today: 1, per_day: 3, left_today: 2 });
  assert.equal(await verifySignature(r.body.receipt, [keys.PUBLIC_KEY]), true);
  assert.equal((await verifyReviewOutcome(r.body.receipt, { ...review, tier: "review" })).ok, true);
  // The paid route still asks for payment: the free route doesn't open it.
  assert.equal((await call(e, "/review", review)).status, 402);
});

t("free reviews: 3 single and 1 review-3 per address per day; other addresses aren't affected", async () => {
  const e = env(FREE);
  for (let i = 1; i <= 3; i++) assert.equal((await call(e, "/free/review", review)).status, 200);
  const fourth = await call(e, "/free/review", review);
  assert.equal(fourth.status, 429);
  assert.match(fourth.body.error, /today's free single-reviewer reviews \(3 per day/);
  assert.equal((await call(e, "/free/review-3", review)).status, 200);
  assert.equal((await call(e, "/free/review-3", review)).status, 429);
  assert.equal((await call(e, "/free/review", review, { "cf-connecting-ip": "198.51.100.20" })).status, 200, "another address has its own allowance");
});

t("free reviews stop for everyone when the shared daily budget is used up", async () => {
  const e = env({ FREE_REVIEW_DAILY_BUDGET_USD: "0.40", FREE_REVIEW3_PER_DAY: "5" });
  assert.equal((await call(e, "/free/review-3", review, { "cf-connecting-ip": "198.51.100.30" })).status, 200);
  assert.equal((await call(e, "/free/review-3", review, { "cf-connecting-ip": "198.51.100.31" })).status, 200);
  const over = await call(e, "/free/review-3", review, { "cf-connecting-ip": "198.51.100.32" });
  assert.equal(over.status, 429);
  assert.match(over.body.error, /used up for everyone/);
});

t("free reviews are off without a budget, and the pause switches stop them", async () => {
  assert.equal((await call(env(), "/free/review", review)).status, 503, "no budget set: off");
  assert.equal((await call(env({ FREE_REVIEW_DAILY_BUDGET_USD: "0" }), "/free/review", review)).status, 503);
  assert.equal((await call(env({ ...FREE, REVIEWS_PAUSED: "true" }), "/free/review", review)).status, 503);
  assert.equal((await call(env({ ...FREE, PAID_PAUSED: "true" }), "/free/review", review)).status, 503);
});

t("a busy pool or a failed reviewer doesn't use up the free review", async () => {
  const full = env({ ...FREE, GATE_SLOTS_ANTHROPIC_CLAUDE_SONNET_5_5: "0" });
  const b = await call(full, "/free/review", review);
  assert.equal(b.status, 503);
  assert.equal(b.body.busy, true);
  assert.match(b.body.error, /wasn't used/);
  const e = env(FREE);
  const fail = { "x-test-fake-mix": "500:1", "x-test-fake-delay": "1-2" };
  for (let i = 0; i < 2; i++) {
    const f = await call(e, "/free/review", review, fail);
    assert.equal(f.status, 502, JSON.stringify(f.body));
    assert.match(f.body.error, /wasn't used/);
  }
  const ok = await call(e, "/free/review", review);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.free.used_today, 1, "the failures were given back");
});

t("bad input on the free route is refused before anything is counted", async () => {
  const e = env(FREE);
  const bad = await call(e, "/free/review", { task: "short", output: "4" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /wasn't used/);
  assert.equal((await call(e, "/free/review", review)).body.free.used_today, 1);
});

t("GET /reviewers says whether free reviews are on", async () => {
  assert.equal((await call(env(), "/reviewers")).body.free.available, false);
  const on = (await call(env(FREE), "/reviewers")).body.free;
  assert.equal(on.available, true);
  assert.deepEqual(on.per_address_per_day, { review: 3, "review-3": 1 });
});
