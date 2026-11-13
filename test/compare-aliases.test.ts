// The judge tiers' compare names (3.0's 1301 of Nov 9, step 2; 5.0, Nov 13, 2026): each name is its judge tier.
// The harness (env, call) is routes.test.ts's, copied.
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
    CLAUDE_JUDGES_ENABLED: "true", // the existing judge tests keep today's (Claude) defaults; judge-no-claude.test.ts covers "off"
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

import { COMPARE_ALIASES, canonicalTier, validateCreate } from "../src/logic.ts";
const from = (cc: string, ip = "203.0.113.7") => ({ "cf-ipcountry": cc, "cf-connecting-ip": ip });

test("compare names: each is its judge tier; anything else is as given", () => {
  assert.deepEqual({ ...COMPARE_ALIASES }, { compare: "judge", "compare-2": "judge-2", "compare-3": "judge-3", "compare-3x2": "judge-3x2", "compare-3x3": "judge-3x3" });
  assert.ok(Object.isFrozen(COMPARE_ALIASES));
  assert.equal(canonicalTier("compare-2"), "judge-2");
  assert.equal(canonicalTier("judge-2"), "judge-2");
  assert.equal(canonicalTier("rps"), "rps");
  for (const odd of ["compare-9", "Compare-2", "__proto__", "toString", "constructor", "hasOwnProperty"]) assert.equal(canonicalTier(odd), odd, odd);
  assert.equal(canonicalTier(undefined), undefined);
  const v = validateCreate({ tier: "compare-3", seats: ["a", "b"], rules: "Cheaper plan wins." });
  assert.ok(v.ok, JSON.stringify(v));
  assert.equal((v as any).value.tier, "judge-3", "the match holds the judge name");
  const bad = validateCreate({ tier: "compare-9", seats: ["a", "b"], rules: "x" });
  assert.equal(bad.ok, false);
  assert.match((bad as any).error, /compare-2/);
  assert.equal(validateCreate({ tier: "__proto__", seats: ["a", "b"], rules: "x" }).ok, false);
});

t("GET /compare answers as GET /judge; the root JSON lists the compare names", async () => {
  const e = env();
  const a = await call(e, "/judge");
  const b = await call(e, "/compare");
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(b.body, a.body);
  const root = await call(e, "/?format=json");
  assert.equal(root.body.compare_aliases["compare-2"], "judge-2");
  assert.equal(root.body.compare_aliases.compare, "judge");
});

t("a match made with a compare name is a judge match, and both names' join routes answer alike", async () => {
  const e = env();
  const m = await call(e, "/matches", { tier: "compare", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." }, from("US"));
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const id = m.body.match_id ?? m.body.id;
  // Hong Kong is refused for a judge match whose judges include a company with no service there: the region check
  // reads the match, so a 451 at both names shows the match is a judge match and both routes reach the same handler.
  const viaJudge = await call(e, "/join/judge", { match_id: id, seat: "alpha" }, from("HK"));
  const viaCompare = await call(e, "/join/compare", { match_id: id, seat: "alpha" }, from("HK"));
  assert.equal(viaJudge.status, 451, JSON.stringify(viaJudge.body));
  assert.equal(viaCompare.status, 451, JSON.stringify(viaCompare.body));
  // One seat joins at each name (a second join of one seat is a conflict at either): both go through alike.
  const jp1 = await call(e, "/join/judge", { match_id: id, seat: "alpha" }, from("JP"));
  const jp2 = await call(e, "/join/compare", { match_id: id, seat: "beta" }, from("JP"));
  assert.equal(jp1.status, 200, JSON.stringify(jp1.body));
  assert.equal(jp2.status, 200, JSON.stringify(jp2.body));
  assert.equal((await call(e, "/join/compare", { match_id: id, seat: "beta" }, from("JP"))).status, 409, "the seat is taken, at either name");
});

t("the multi-part compare names keep their judge tiers' guard; an unknown compare name is no route", async () => {
  const e = env();
  for (const [alias, tier] of [["compare-3x2", "judge-3x2"], ["compare-3x3", "judge-3x3"]]) {
    for (const base of ["/join/", "/host/join/"]) {
      const a = await call(e, `${base}${tier}`, { match_id: "x", seat: "a" }, from("US"));
      const b = await call(e, `${base}${alias}`, { match_id: "x", seat: "a" }, from("US"));
      assert.equal(b.status, a.status, `${base}${alias}`);
      assert.notEqual(b.status, 404, `${base}${alias}`);
    }
  }
  assert.equal((await call(e, "/join/compare-9", { match_id: "x", seat: "a" }, from("US"))).status, 404);
  assert.equal((await call(e, "/matches", { tier: "compare-9", seats: ["a", "b"], rules: "x" }, from("US"))).status, 400);
});

t("with payments on, each compare name asks the same payment as its judge name: no unpaid way in", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}")) as any; // no facilitator or AI call is made for an unpaid request
  try {
    const e = env({ PAYMENTS_ENABLED: "true" });
    for (const [alias, tier] of [["compare", "judge"], ["compare-2", "judge-2"], ["compare-3", "judge-3"]]) {
      const m = await call(e, "/matches", { tier, seats: ["alpha", "beta"], rules: "Pick the cheaper plan." }, from("US"));
      assert.equal(m.status, 201, JSON.stringify(m.body));
      const id = m.body.match_id ?? m.body.id;
      for (const base of ["/join/", "/host/join/"]) {
        const a = await call(e, `${base}${tier}`, { match_id: id, seat: "alpha" }, from("US"));
        const b = await call(e, `${base}${alias}`, { match_id: id, seat: "alpha" }, from("US"));
        assert.equal(b.status, a.status, `${base}${alias}: ${JSON.stringify(b.body).slice(0, 200)}`);
        if (base === "/join/") assert.equal(b.status, 402, `${base}${alias} must ask for payment`);
        const price = (r: any) => JSON.stringify((r.body?.accepts ?? []).map((x: any) => x.maxAmountRequired));
        assert.equal(price(b), price(a), `${base}${alias}: the same price as ${tier}`);
      }
    }
  } finally {
    globalThis.fetch = orig;
  }
});
