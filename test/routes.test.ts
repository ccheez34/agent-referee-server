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
  return { storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); }, async delete(k: any) { for (const x of [k].flat()) d.delete(x); return true; }, async list(o: { prefix?: string } = {}) { return new Map([...d.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort().map((k) => [k, structuredClone(d.get(k))])); }, async deleteAll() { d.clear(); }, async setAlarm() {} } };
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

/** A ledger whose review-fails calls can be made to fail: "before" throws without reaching the ledger, "after" lets
 * the ledger process the call and then loses its answer, "hang" never answers. Counts every review-fails call. */
function flakyLedger(e: any) {
  const get = e.LEDGER.get;
  const f = { plan: [] as ("before" | "after" | "hang")[], calls: 0, caller: "" };
  e.LEDGER.get = (id: string) => {
    const stub = get(id);
    return {
      fetch: async (u: string, i?: RequestInit) => {
        if (!u.endsWith("/review-fails")) return stub.fetch(u, i);
        f.calls++;
        const body = JSON.parse(String(i?.body ?? "{}"));
        if (body.reserve) f.caller = body.caller;
        const mode = body.reserve ? f.plan.shift() : undefined;
        if (mode === "before") throw new Error("object unavailable");
        if (mode === "hang") return new Promise<Response>(() => {});
        const res = await stub.fetch(u, i);
        if (mode === "after") throw new Error("object unavailable");
        return res;
      },
    };
  };
  return f;
}
const inflightFor = async (e: any, caller: string) => {
  for (const o of e.LEDGER.objs.values()) {
    const r: any = await (await o.fetch(new Request("https://ledger/review-fails", { method: "POST", body: JSON.stringify({ caller, limit: 10 }) }))).json();
    if (r.inflight) return { n: r.inflight, ledger: o };
  }
  return { n: 0, ledger: undefined as any };
};

t("a single failed ledger call is retried once, so the review goes through and health stays ok; two failures still refuse", async () => {
  const e = env();
  const f = flakyLedger(e);
  f.plan = ["before"];
  const r = await call(e, "/review", review);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(f.plan.length, 0, "the first call failed");
  assert.equal((await call(e, "/health")).body.status, "ok", "a retried blip isn't a health event");
  f.plan = ["before", "before"];
  const reserveCalls = () => f.calls;
  const before = reserveCalls();
  const r2 = await call(e, "/review", review);
  assert.equal(r2.status, 503);
  assert.match(r2.body.error, /can't be checked/);
  assert.equal(reserveCalls() - before, 2, "exactly one retry, then a refusal");
});

t("a ledger timeout isn't retried: one call, then the same refusal as before", async () => {
  const e = env({ LEDGER_TIMEOUT_MS: "50" });
  const f = flakyLedger(e);
  f.plan = ["hang"];
  const r = await call(e, "/review", review);
  assert.equal(r.status, 503);
  assert.match(r.body.error, /can't be checked/);
  assert.equal(f.calls, 1, "no second call after a timeout");
});

t("a lost ledger answer: the retry still lets the review through, and the extra reservation expires after 5 minutes", async () => {
  const e = env();
  const f = flakyLedger(e);
  f.plan = ["after"]; // the first call reserves a slot, then its answer is lost
  const r = await call(e, "/review", review);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const left = await inflightFor(e, f.caller);
  assert.equal(left.n, 1, "the lost call's reservation is still held (the retry's was released when the review was recorded)");
  const t0 = Date.now();
  left.ledger.now = () => t0 + 300_001;
  assert.equal((await inflightFor(e, f.caller)).n, 0, "and it expires on its own after 5 minutes");
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

// ---------- usage stats and the hosted MCP server's internal route ----------

const INTERNAL = "i".repeat(40);
const EXT = { INTERNAL_TOKEN: INTERNAL, EXT_FREE_DAILY_BUDGET_USD: "1.00" };
const tick = () => new Promise((r) => setTimeout(r, 20));

t("GET /admin/stats: counts of reviews done, failed and refused, and today's free budget; admin token only", async () => {
  const e = env({ ...FREE, ...EXT });
  assert.equal((await call(e, "/admin/stats")).status, 401);
  assert.equal((await call(e, "/admin/stats", undefined, { authorization: "Bearer wrong-token-wrong-token-wrong-token" })).status, 401);
  assert.equal((await call(env({ ADMIN_TOKEN: undefined }), "/admin/stats", undefined, { authorization: `Bearer ${ADMIN}` })).status, 404);
  for (let i = 0; i < 4; i++) await call(e, "/free/review", review); // 3 done, 1 refused
  await call(e, "/free/review", { task: "short", output: "4" }, { "cf-connecting-ip": "198.51.100.40" });
  await call(e, "/free/review", review, { "x-test-fake-mix": "500:1", "x-test-fake-delay": "1-2", "cf-connecting-ip": "198.51.100.41" });
  await call(e, "/internal/free/review", review, { "x-internal-auth": INTERNAL, "x-caller-id": "user-1" });
  await tick();
  const r = await call(e, "/admin/stats", undefined, { authorization: `Bearer ${ADMIN}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const today = r.body.today.counts;
  assert.equal(today.free_ok_review, 3);
  assert.equal(today.free_refused_caller, 1);
  assert.equal(today.free_bad_input, 1);
  assert.equal(today.free_failed, 1);
  assert.equal(today.ext_ok_review, 1);
  assert.equal(r.body.last_7_days.length, 7);
  assert.deepEqual(r.body.free_budget_today.public, { spent_usd: 0.2, budget_usd: 3 }, "3 done + 1 failed (a called reviewer keeps its cost)");
  assert.deepEqual(r.body.free_budget_today.ext, { spent_usd: 0.05, budget_usd: 1, note: "free reviews from the hosted MCP server (ChatGPT)" });
  assert.ok(!JSON.stringify(r.body).includes("198.51.100"), "no addresses");
  assert.ok(!JSON.stringify(r.body).includes("user-1"), "no user ids");
});

t("internal free route: 404 without INTERNAL_TOKEN, 401 with a wrong one", async () => {
  assert.equal((await call(env(FREE), "/internal/free/review", review, { "x-internal-auth": INTERNAL })).status, 404);
  const e = env({ ...FREE, ...EXT });
  assert.equal((await call(e, "/internal/free/review", review)).status, 401);
  assert.equal((await call(e, "/internal/free/review", review, { "x-internal-auth": INTERNAL + "x" })).status, 401);
  assert.equal((await call(env({ ...FREE, INTERNAL_TOKEN: "short", EXT_FREE_DAILY_BUDGET_USD: "1" }), "/internal/free/review", review, { "x-internal-auth": "short" })).status, 401, "a too-short token is never accepted");
});

t("internal free route: each hosted-server user has their own allowance, and the budget is separate from the public one", async () => {
  const e = env({ ...FREE, ...EXT });
  const as = (id?: string) => ({ "x-internal-auth": INTERNAL, ...(id ? { "x-caller-id": id } : {}) });
  for (let i = 1; i <= 3; i++) assert.equal((await call(e, "/internal/free/review", review, as("user-a"))).status, 200);
  assert.equal((await call(e, "/internal/free/review", review, as("user-a"))).status, 429);
  assert.equal((await call(e, "/internal/free/review", review, as("user-b"))).status, 200, "another user has their own allowance");
  // All ChatGPT traffic shares OpenAI's addresses: the hosted server's users don't use the public allowance of that address.
  const pub = await call(e, "/free/review", review);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.free.used_today, 1);
  // Without an id, callers share one allowance.
  for (let i = 1; i <= 3; i++) assert.equal((await call(e, "/internal/free/review", review, as())).status, 200);
  assert.equal((await call(e, "/internal/free/review", review, as())).status, 429);
  // Its own budget: $0.40 = two review-3s.
  const small = env({ ...FREE, INTERNAL_TOKEN: INTERNAL, EXT_FREE_DAILY_BUDGET_USD: "0.40" });
  assert.equal((await call(small, "/internal/free/review-3", review, as("x1"))).status, 200);
  assert.equal((await call(small, "/internal/free/review-3", review, as("x2"))).status, 200);
  const over = await call(small, "/internal/free/review-3", review, as("x3"));
  assert.equal(over.status, 429);
  assert.match(over.body.error, /used up/);
  assert.equal((await call(small, "/free/review-3", review)).status, 200, "the public budget is untouched");
  // Off when its budget isn't set, even with the token.
  assert.equal((await call(env({ ...FREE, INTERNAL_TOKEN: INTERNAL }), "/internal/free/review", review, as("u"))).status, 503);
});

// ---------- region rules (regions.ts) ----------

const from = (cc: string, ip = "203.0.113.7") => ({ "cf-ipcountry": cc, "cf-connecting-ip": ip });

t("region rules: a free review from a country a reviewer's company doesn't serve gets 451 and its allowance isn't used", async () => {
  const e = env(FREE);
  const hk = await call(e, "/free/review", review, from("HK"));
  assert.equal(hk.status, 451, JSON.stringify(hk.body));
  assert.match(hk.body.error, /^not_available_in_region: .*anthropic.*Your free review wasn't used\.$/);
  assert.equal(hk.body.region, "HK");
  assert.equal((await call(e, "/free/review-3", review, from("AF"))).status, 451, "review-3 includes Claude and Gemini");
  const jp = await call(e, "/free/review", review, from("JP"));
  assert.equal(jp.status, 200);
  assert.equal(jp.body.free.used_today, 1, "the refused ones used nothing");
  assert.equal((await call(e, "/free/review", review)).status, 200, "unknown country: allowed");
  assert.equal((await call(env({ ...FREE, REGION_BLOCK: "off" }), "/free/review", review, from("HK"))).status, 200, "REGION_BLOCK=off");
  // Sub-regions: Crimea is refused; the rest of Ukraine isn't.
  assert.equal((await call(e, "/free/review", review, { ...from("UA", "198.51.100.50"), "x-test-country": "UA-43" })).status, 451);
  assert.equal((await call(e, "/free/review", review, from("UA", "198.51.100.51"))).status, 200);
});

t("region rules: a paid review is refused before the payment challenge; the internal route isn't checked", async () => {
  const e = env({ ...FREE, ...EXT, PAYMENTS_ENABLED: "true" });
  const r = await call(e, "/review", review, from("CN"));
  assert.equal(r.status, 451);
  assert.match(r.body.error, /Nothing was charged\.$/);
  assert.equal((await call(e, "/review", review, from("US"))).status, 402);
  // The hosted MCP server calls from its own location, so the request's country isn't the person's.
  assert.equal((await call(e, "/internal/free/review", review, { ...from("HK"), "x-internal-auth": INTERNAL, "x-caller-id": "u" })).status, 200);
});

t("region rules: sanctioned locations can't create matches or take paid seats, whatever the tier", async () => {
  const e = env();
  const m = await call(e, "/matches", { tier: "rps", seats: ["a", "b"] }, from("IR"));
  assert.equal(m.status, 451);
  assert.equal(m.body.region, "IR");
  assert.equal((await call(e, "/join/rps", { match_id: "a".repeat(24), seat: "a" }, from("KP"))).status, 451);
  assert.equal((await call(e, "/matches", { tier: "rps", seats: ["a", "b"] }, from("HK"))).status, 201, "no AI in rps: only the sanctions list applies");
  assert.equal((await call(e, "/matches", { tier: "rps", seats: ["a", "b"] }, { "x-test-country": "T1" })).status, 451, "Tor, via the staging test header");
  // The test header is never read outside staging.
  assert.equal((await call(env({ STAGING: "false", FAKE_AI: undefined }), "/matches", { tier: "rps", seats: ["a", "b"] }, { "x-test-country": "IR" })).status, 201);
});

t("region rules: judge seats check the match's judges' companies", async () => {
  const e = env();
  const m = await call(e, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." }, from("US"));
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const id = m.body.match_id ?? m.body.id;
  const hk = await call(e, "/join/judge", { match_id: id, seat: "alpha" }, from("HK"));
  assert.equal(hk.status, 451, JSON.stringify(hk.body));
  assert.match(hk.body.error, /anthropic/);
  assert.notEqual((await call(e, "/join/judge", { match_id: id, seat: "alpha" }, from("JP"))).status, 451);
  // If the match can't be read, the strictest list applies (fail closed): Hong Kong is still refused.
  e.MATCHES.broken = true;
  assert.equal((await call(e, "/join/judge", { match_id: id, seat: "beta" }, from("HK"))).status, 451);
  assert.equal((await call(e, "/invite/join", { match_id: id, invite_token: "x".repeat(20) }, from("HK"))).status, 451);
  // A judge-tier match whose status shows no judges is treated as unreadable on the free invite route too.
  const odd = env();
  odd.MATCHES = { idFromName: (x: string) => x, get: () => ({ fetch: async () => new Response(JSON.stringify({ match_id: id, tier: "judge-3" }), { status: 200 }) }) };
  assert.equal((await call(odd, "/invite/join", { match_id: id, invite_token: "x".repeat(20) }, from("HK"))).status, 451);
});

t("GET /admin/stats: requests by country and region refusals, apart from the usage counts", async () => {
  const e = env(FREE);
  await call(e, "/free/review", review, from("JP"));
  await call(e, "/free/review", review, from("JP", "198.51.100.60"));
  await call(e, "/free/review", review, from("SG", "198.51.100.61"));
  await call(e, "/free/review", review, from("HK", "198.51.100.62"));
  await call(e, "/matches", { tier: "rps", seats: ["a", "b"] }, from("IR"));
  await tick();
  const r = await call(e, "/admin/stats", undefined, { authorization: `Bearer ${ADMIN}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.today.countries, { JP: 2, HK: 1, SG: 1 }, "largest first; HK was counted, then refused");
  assert.deepEqual(r.body.today.region_blocked, { HK: 1, IR: 1 });
  assert.equal(r.body.today.counts.region_blocked, 2);
  assert.equal(r.body.today.counts.free_ok_review, 3);
  assert.ok(!Object.keys(r.body.today.counts).some((k) => k.startsWith("cc_") || k.startsWith("rb_")));
  assert.deepEqual(r.body.countries_7_days, { JP: 2, HK: 1, SG: 1 });
  assert.deepEqual(r.body.region_blocked_7_days, { HK: 1, IR: 1 });
});

// ---------- answers cut off at the token limit ----------

t("an answer cut off at the token limit is noted each time: per model in /admin/stats, the details, and a /health warning", async () => {
  const e = env(FREE);
  const cut = { "x-test-fake-mix": "cut:1", "x-test-fake-delay": "1-2" };
  const f = await call(e, "/free/review", review, cut);
  assert.equal(f.status, 502, JSON.stringify(f.body));
  assert.match(f.body.error, /ran out of tokens/);
  await tick();
  const r = await call(e, "/admin/stats", undefined, { authorization: `Bearer ${ADMIN}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const per = r.body.ran_out_of_tokens_7_days;
  const [[model, n]] = Object.entries(per) as [string, number][];
  assert.match(model, /^claude-/);
  assert.equal(n, 2, "both tries were cut off, and each is noted");
  assert.deepEqual(r.body.today.ran_out_of_tokens, per);
  assert.ok(!Object.keys(r.body.today.counts).some((k) => k.startsWith("oot_")));
  const recent = r.body.ran_out_of_tokens_recent;
  assert.equal(recent.length, 2);
  assert.equal(recent[0].where, "review");
  assert.equal(recent[0].max_tokens, 8000);
  assert.ok(recent[0].prompt_chars > 0);
  assert.ok(!JSON.stringify(recent).includes(review.task), "never the prompt itself");
  const h = await call(e, "/health");
  assert.ok(h.body.warnings.includes("out_of_tokens"), JSON.stringify(h.body));
});

t("a blocked wallet can be let back in by the operator (admin token only)", async () => {
  const f = fakeFacilitator("fail");
  try {
    const e = env({ PAYMENTS_ENABLED: "true" });
    const w = "0x" + "e".repeat(40);
    await call(e, "/review", review, { "x-payment": payHeader(w) });
    await settleWait();
    assert.equal((await call(e, "/review", review, { "x-payment": payHeader(w) })).status, 403);
    const auth = { authorization: `Bearer ${ADMIN}` };
    assert.equal((await call(e, "/admin/blocked")).status, 401);
    assert.deepEqual((await call(e, "/admin/blocked", undefined, auth)).body.blocked, [w]);
    assert.equal((await call(e, "/admin/unblock", { wallet: w })).status, 401, "no token");
    assert.equal((await call(e, "/admin/unblock", { wallet: "nope" }, auth)).status, 400);
    const u = await call(e, "/admin/unblock", { wallet: w.toUpperCase().replace("0X", "0x") }, auth);
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.unblocked, true);
    assert.deepEqual(u.body.blocked, []);
    assert.notEqual((await call(e, "/review", review, { "x-payment": payHeader(w) })).status, 403, "it can pay again");
  } finally {
    f.restore();
  }
});

t("settling up: a blocked wallet pays exactly what it owes and can pay again; a second strike bans it for good", async () => {
  const fail = fakeFacilitator("fail");
  const e = env({ PAYMENTS_ENABLED: "true", SETTLE_FAIL_PAUSE_AFTER: "10" });
  const w = "0x" + "7".repeat(40);
  try {
    await call(e, "/review", review, { "x-payment": payHeader(w) });
    await settleWait();
  } finally {
    fail.restore();
  }
  // Blocked, with the amount owed and how to pay it.
  const refused = await call(e, "/review", review, { "x-payment": payHeader(w) });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /owes \$0\.05: pay it with POST .*\/settle-up/);
  assert.match(refused.body.error, /second payment that fails to settle within 180 days bans this wallet for good/);
  const st = await call(e, `/settle-up?wallet=${w}`);
  assert.equal(st.status, 200);
  assert.equal(st.body.blocked, true);
  assert.equal(st.body.owes, "$0.05");
  assert.equal(st.body.strikes, 1);
  assert.equal(st.body.can_settle_up, true);
  assert.ok(st.body.rules.banned_for_good);
  // Settling up: first the x402 challenge for exactly the amount owed, then a payment from that wallet.
  const ok = fakeFacilitator("ok");
  try {
    const challenge = await call(e, "/settle-up", { wallet: w });
    assert.equal(challenge.status, 402);
    assert.equal(challenge.body.accepts[0].maxAmountRequired, "50000");
    assert.equal((await call(e, "/settle-up", { wallet: w }, { "x-payment": payHeader("0x" + "8".repeat(40)) })).status, 400, "another wallet can't pay it");
    const paid = await call(e, "/settle-up", { wallet: w }, { "x-payment": payHeader(w) });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.unblocked, true);
    assert.ok(paid.headers.get("x-payment-response"));
    assert.notEqual((await call(e, "/review", review, { "x-payment": payHeader(w) })).status, 403, "it can pay again");
    assert.equal((await call(e, "/settle-up", { wallet: w })).status, 400, "nothing left to settle");
  } finally {
    ok.restore();
  }
  // A second strike: banned for good, and settling up is refused.
  const fail2 = fakeFacilitator("fail");
  try {
    await call(e, "/review", review, { "x-payment": payHeader(w) });
    await settleWait();
  } finally {
    fail2.restore();
  }
  const banned = await call(e, "/review", review, { "x-payment": payHeader(w) });
  assert.equal(banned.status, 403);
  assert.match(banned.body.error, /can't pay here anymore/);
  assert.equal((await call(e, `/settle-up?wallet=${w}`)).body.permanent, true);
  assert.equal((await call(e, "/settle-up", { wallet: w })).status, 403);
  // Only the operator can lift it.
  const u = await call(e, "/admin/unblock", { wallet: w, reset_strikes: true }, { authorization: `Bearer ${ADMIN}` });
  assert.equal(u.body.unblocked, true);
  assert.equal(u.body.strikes, 0);
});

t("browsers may call the public API (CORS), never the admin or internal routes", async () => {
  const e = env();
  const pre = await app.fetch(new Request("https://x/review", { method: "OPTIONS", headers: { origin: "https://example.com", "access-control-request-headers": "x-payment" } }), e, ctx);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /x-payment/);
  const h = await call(e, "/health");
  assert.equal(h.headers.get("access-control-allow-origin"), "*");
  assert.match(h.headers.get("access-control-expose-headers") ?? "", /x-payment-response/);
  assert.equal((await call(e, "/admin/stats")).headers.get("access-control-allow-origin"), null);
  const ao = await app.fetch(new Request("https://x/admin/stats", { method: "OPTIONS" }), e, ctx);
  assert.equal(ao.headers.get("access-control-allow-origin"), null);
});

t("GET /try serves the browser page with a tight CSP, and the landing page, llms.txt and root JSON link to it", async () => {
  const { TRY_HTML, TRY_SCRIPT_HASHES } = await import("../src/try-page.ts");
  const e = env();
  const res = await app.fetch(new Request("https://x/try"), e, ctx);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  const html = await res.text();
  assert.equal(html, TRY_HTML);
  assert.match(html, /<title>Agent Referee: try it<\/title>/);
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src [^;]*https:\/\/cdn\.jsdelivr\.net/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  // The inline script's hash in the CSP matches the script actually served, so the page can't silently break.
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1];
  const hash = "sha256-" + Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script))).toString("base64");
  assert.deepEqual(TRY_SCRIPT_HASHES, [hash]);
  assert.ok(csp.includes(`'${hash}'`));
  // The page only imports the client at an exact version.
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/agent-referee-client@\d+\.\d+\.\d+\//);
  const landing = await (await app.fetch(new Request("https://x/", { headers: { accept: "text/html" } }), e, ctx)).text();
  assert.match(landing, /href="https:\/\/x\/try"[^>]*>(<strong>)?Try it in your browser/);
  const llms = await (await app.fetch(new Request("https://x/llms.txt"), e, ctx)).text();
  assert.match(llms, /Try it in your browser[^\n]*https:\/\/x\/try/);
  assert.equal((await call(e, "/")).body.try_in_browser, "https://x/try");
});

// ---------- multi-part review (spec section 1) ----------

const MP = { MULTI_PART_ENABLED: "true" };
const multi = (n: number, extra: object = {}) => ({ task: "Check the handoff: every fact is right and nothing open is missing.", pieces: Array.from({ length: n }, (_, i) => ({ ...(i === 0 ? { name: "Server" } : {}), text: `Piece ${i + 1} of the handoff.` })), ...extra });

t("multi-part: off for the public until MULTI_PART_ENABLED; the operator's token opens it for testing", async () => {
  const e = env();
  const off = await call(e, "/review-3x3", multi(3));
  assert.equal(off.status, 503);
  assert.match(off.body.error, /isn't open yet\. Nothing was charged/);
  assert.equal((await call(e, "/review-3x3", multi(3), { "x-operator-token": "wrong".repeat(10) })).status, 503, "a wrong token");
  const op = await call(e, "/review-3x3", multi(3), { "x-operator-token": ADMIN });
  assert.equal(op.status, 200, JSON.stringify(op.body));
  assert.equal((await call(env(MP), "/review-3x2", multi(2))).status, 200);
  const paused = await call(env({ ...MP, REVIEWS_PAUSED: "true" }), "/review-3x2", multi(2));
  assert.equal(paused.status, 503, "the reviews pause switch stops them too");
});

t("multi-part: a completed review returns three votes and a review-multi-v1 receipt that checks out", async () => {
  const { sha256Hex, canonicalJson } = await import("../src/logic.ts");
  const { verifyReceipt } = await import("../src/receipt.ts");
  const e = env(MP);
  const body = multi(3);
  const r = await call(e, "/review-3x3", body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body.receipt.payload;
  assert.equal(p.tier, "review-3x3");
  assert.equal(p.receipt_format, "review-multi-v1");
  assert.equal(p.task_sha256, await sha256Hex(body.task));
  assert.equal(p.output_sha256, undefined);
  assert.equal(p.pieces.length, 3);
  assert.deepEqual(p.pieces.map((x: any) => x.name), ["Server", "", ""]);
  for (let i = 0; i < 3; i++) assert.equal(p.pieces[i].sha256, await sha256Hex(body.pieces[i].text));
  assert.equal(p.pieces_sha256, await sha256Hex(canonicalJson(p.pieces)));
  assert.equal(p.votes.length, 3);
  assert.ok(p.votes.every((v: any) => v.issues_dropped === 0));
  assert.equal(new Set(p.reviewers.models.map((m: string) => (m.includes("/") ? m.split("/")[0] : "anthropic"))).size, 3);
  assert.ok(!p.reviewers.models.includes("claude-haiku-5-5"));
  assert.equal(p.reviewers.format_version, "agent-referee-review-v4-multi");
  assert.equal(await verifyReceipt(r.body.receipt, e.PUBLIC_KEY), true);
});

t("multi-part: refused before payment with 400 (counts, sizes, Haiku, opt-in, one company twice) and 413 over 256 KB", async () => {
  const e = env({ ...MP, PAYMENTS_ENABLED: "true" });
  const bad = [
    ["/review-3x3", multi(2)],
    ["/review-3x2", multi(3)],
    ["/review-3x2", { ...multi(2), pieces: [{ text: "x".repeat(12_001) }, { text: "y" }] }],
    ["/review-3x2", multi(2, { panel: ["claude-haiku-5-5", "openai/gpt-6-luna", "google/gemini-4-argon"] })],
    ["/review-3x2", multi(2, { panel: ["moonshotai/kimi-k3", "openai/gpt-6-luna", "google/gemini-4-argon"] })],
    ["/review-3x2", multi(2, { panel: ["claude-opus-5-5", "claude-sonnet-5-5", "openai/gpt-6-luna"] })],
    ["/review-3x2", multi(2, { output: "x" })],
  ] as const;
  for (const [path, body] of bad) {
    const r = await call(e, path, body);
    assert.equal(r.status, 400, `${path} ${JSON.stringify(body).slice(0, 120)}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /Nothing was charged\.$/);
  }
  const huge = { ...multi(2), pieces: [{ text: "\u0001".repeat(50_000) }, { text: "y" }] }; // 300 KB escaped
  const r = await call(e, "/review-3x2", huge);
  assert.equal(r.status, 413);
  assert.equal((await call(e, "/review-3x2", multi(2))).status, 402, "a valid request gets the payment challenge");
});

t("multi-part: a company with no eligible model answers 503 before payment", async () => {
  const r = await call(env({ ...MP, PAYMENTS_ENABLED: "true", MULTI_PART_EXCLUDE: "openai/gpt-6-luna" }), "/review-3x3", multi(3));
  assert.equal(r.status, 503);
  assert.match(r.body.error, /closed for now.*openai.*Nothing was charged/);
});

t("multi-part: a failed review isn't charged and uses up as many allowed failures as it has pieces", async () => {
  const e = env({ ...MP, REVIEW_FAIL_LIMIT: "4" });
  const fail = { "x-test-fake-mix": "500:1", "x-test-fake-delay": "1-2", "cf-connecting-ip": "198.51.100.20" };
  const f1 = await call(e, "/review-3x3", multi(3), fail);
  assert.equal(f1.status, 502);
  assert.match(f1.body.error, /counts as 3 of today's allowed failures/);
  const f2 = await call(e, "/review-3x2", multi(2), fail); // 3 + 2 = 5 >= 4
  assert.equal(f2.status, 502);
  const refused = await call(e, "/review-3x2", multi(2), fail);
  assert.equal(refused.status, 429, JSON.stringify(refused.body));
  assert.match(refused.body.error, /^review_fail_limit: /);
  assert.equal((await call(e, "/review-3x2", multi(2), { "cf-connecting-ip": "198.51.100.21" })).status, 200, "another address isn't affected");
});

t("multi-part: paid through the real paywall at its own price, settled once", async () => {
  const f = fakeFacilitator("ok");
  try {
    const e = env({ ...MP, PAYMENTS_ENABLED: "true" });
    const challenge = await call(e, "/review-3x3", multi(3));
    assert.equal(challenge.status, 402);
    assert.equal(challenge.body.accepts?.[0]?.maxAmountRequired, "500000", "$0.50");
    const r = await call(e, "/review-3x3", multi(3), { "x-payment": payHeader("0x" + "c".repeat(40), "500000") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.receipt.payload.payer?.toLowerCase(), "0x" + "c".repeat(40));
    assert.deepEqual(f.calls, { verify: 1, settle: 1 });
  } finally {
    f.restore();
  }
});

t("multi-part: GET /reviewers describes the tiers, the eligible models and the prompt", async () => {
  const r = await call(env(), "/reviewers");
  const m = r.body.multi_part;
  assert.equal(m.status, "not open yet");
  assert.equal(m.tiers["review-3x3"].price, "$0.50");
  assert.ok(!m.eligible_models.includes("claude-haiku-5-5"));
  assert.equal(m.format_version, "agent-referee-review-v4-multi");
  assert.match(m.prompt_sha256, /^[0-9a-f]{64}$/);
  assert.equal((await call(env(MP), "/reviewers")).body.multi_part.status, "on");
});
