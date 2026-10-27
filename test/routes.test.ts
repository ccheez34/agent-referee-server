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
