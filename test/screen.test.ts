// The content screen, layer 2a (src/screen.ts): secrets in customer text are refused before any AI provider sees
// them and before any payment settles; placeholders and ordinary code (hashes, base64, the word "token") pass; the
// patterns stay equal to find's (a vendored copy of find/lib/scrub.mjs, the locked v1 build); nothing logs the text.
// Fake secrets are built at run time so no scanner mistakes this file for a leak.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { INTAKE_PATTERNS, intakeCheck, screenMode, REFUSAL_RECEIPT_FORMAT, REQUEST_RULE, SUBMIT_RULE } from "../src/screen.ts";
import { verifyReceipt } from "../src/receipt.ts";
import { scrubText } from "./fixtures/find-scrub-v1.mjs";
import { Gate } from "../src/gate.ts";
import { Health, _resetHealthCaches } from "../src/health.ts";
import { Ledger } from "../src/ledger.ts";
import { MatchRoom } from "../src/match.ts";
import { _clearSnapshots } from "../src/gateclient.ts";

const FIXTURE = new URL("./fixtures/find-scrub-v1.mjs", import.meta.url);
// find/lib/scrub.mjs as locked in SKILLS.lock 1a284b76b663 (skills/find/lib/scrub.mjs). A new find build changes this
// on purpose: re-vendor it, then this test says whether the server's patterns still match.
const FIND_SCRUB_SHA256 = "e004d981f9686b94ad991ad86995a480d7059a4836dbac836f9f5a7a8302f4a1";

const fake = {
  openai: "sk-" + "proj" + "Q7xT2mK9vB4nL8pR3sW6".repeat(2),
  stripe: "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  aws: "AKIA" + "Q3XZ7TK2MRB5VWNP",
  github: "gh" + "p_" + "Rk7Lm2Qx9Tz4Wv8Bn3Jc6Hd1Fs5Gy0Pa2Me7",
  slack: "xo" + "xb-" + "2048-7731-Qw8eR4tY",
  google: "AI" + "za" + "SyD4k9Lm2Nq7Rt3Vw8Xz1Bc6Fg0Hj5Kp4Ms",
  pem: "-----BEGIN " + "RSA PRIVATE KEY-----",
  url: "postgres://admin:" + "Tr0ub4dor3xQ" + "@db.internal:5432/app",
  bearer: "Authorization: Bearer " + "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.Qm9va3M",
};

// ---------- the check itself ----------

test("each kind of secret is found, by field and line, never echoing the text", () => {
  const cases: Array<[string, string]> = [
    [fake.openai, "api_key"], [fake.stripe, "api_key"], [fake.aws, "api_key"], [fake.github, "api_key"], [fake.slack, "api_key"],
    [fake.google, "api_key"], [fake.pem, "private_key"], [fake.url, "url_credentials"], [fake.bearer, "bearer_token"],
  ];
  for (const [secret, kind] of cases) {
    const hits = intakeCheck({ task: "Review this config file for mistakes.", output: `line one\nconst x = 1;\n${secret}\n` });
    assert.deepEqual(hits, [{ field: "output", line: 3, kind }], secret.slice(0, 6));
    assert.ok(!JSON.stringify(hits).includes(secret.slice(4, 14)), "the hit holds no part of the secret");
  }
  // Nested fields: pieces, criteria, rules.
  assert.deepEqual(intakeCheck({ pieces: [{ text: "ok" }, { name: "env", text: `a\nb\n${fake.github}` }] }), [{ field: "pieces[1].text", line: 3, kind: "api_key" }]);
  assert.deepEqual(intakeCheck({ rules: `Judge fairly.\n${fake.stripe}` }), [{ field: "rules", line: 2, kind: "api_key" }]);
});

test("a zero-width character can't split a key past the check", () => {
  const split = fake.github.slice(0, 10) + "​" + fake.github.slice(10);
  assert.equal(intakeCheck({ output: split })[0]?.kind, "api_key");
});

test("ordinary code and documentation pass: hashes, base64, the word token, placeholders", () => {
  const ok = [
    "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "const token = await getToken(); // the session token from the login step",
    "password = process.env.DB_PASSWORD",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "Authorization: Bearer YOUR_API_KEY_HERE",
    "Authorization: Bearer <token>",
    "Authorization: Bearer ${process.env.TOKEN}",
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx",
    "postgres://user:<password>@localhost:5432/db",
    "https://user:${PASS}@example.com",
    "-----BEGIN PUBLIC KEY-----",
    "-----BEGIN CERTIFICATE-----",
    "The skin-deep tasks: risk assessment, asking for 12 apples.",
  ];
  for (const line of ok) assert.deepEqual(intakeCheck({ output: line }), [], line);
});

test("the server's own tokens and ids are never screened as customer text", () => {
  assert.deepEqual(intakeCheck({ seat: "a", seat_token: fake.github, match_id: fake.github, key: fake.github, pieces: [{ text: "fine" }] }), []);
  // ...but only at the top level: a customer field with the same name inside the text still counts.
  assert.equal(intakeCheck({ pieces: [{ text: "x", seat_token: fake.github }] }).length, 1);
});

test("CONTENT_SCREEN: off unless shadow or enforce", () => {
  assert.equal(screenMode({}), "off");
  assert.equal(screenMode({ CONTENT_SCREEN: "on" }), "off");
  assert.equal(screenMode({ CONTENT_SCREEN: " Shadow " }), "shadow");
  assert.equal(screenMode({ CONTENT_SCREEN: "enforce" }), "enforce");
});

// ---------- agreement with find ----------

/** The regex literal assigned to `name` in scrub.mjs's source, as [source, flags]. */
function literal(src: string, name: string): [string, string] {
  const at = src.indexOf(`${name} = /`);
  assert.ok(at >= 0, `${name} not in find's scrub.mjs`);
  let i = at + name.length + 4, inClass = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) break;
  }
  const body = src.slice(at + name.length + 4, i);
  const flags = /^[a-z]*/.exec(src.slice(i + 1))![0];
  return [body, flags];
}

test("the patterns are find's own, and find hides every secret the server refuses", () => {
  const raw = readFileSync(FIXTURE);
  assert.equal(createHash("sha256").update(raw).digest("hex"), FIND_SCRUB_SHA256, "the vendored find scrub.mjs is the locked v1 build");
  const src = raw.toString("utf8");
  const ours = Object.fromEntries(INTAKE_PATTERNS.map((p) => [p.kind, p.re]));
  for (const [kind, name] of [["private_key", "PEM_BEGIN"], ["api_key", "PREFIXED"], ["url_credentials", "URLCRED"], ["bearer_token", "BEARER"]]) {
    const [source, flags] = literal(src, name);
    assert.equal(ours[kind].source, new RegExp(source).source, `${kind} = find's ${name}`);
    assert.equal(ours[kind].flags, flags, `${kind} flags = find's ${name}`);
  }
  for (const s of Object.values(fake)) assert.ok(scrubText(s, false).hidden >= 1, `find hides ${s.slice(0, 6)}`);
});

// ---------- the routes ----------

let app: any = null;
try {
  app = (await import("../src/index.ts")).default;
} catch (e) {
  console.log(`screen route tests skipped (dependencies not installed here): ${String((e as any)?.message ?? e).slice(0, 120)}`);
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
  return { objs, idFromName: (x: string) => x, get: (id: string) => ({ fetch: async (u: string, i?: RequestInit) => { if (!objs.has(id)) objs.set(id, make()); return objs.get(id)!.fetch(new Request(u, i)); } }) };
}
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
    ADMIN_TOKEN: "a".repeat(40),
    CLAUDE_JUDGES_ENABLED: "true",
    CONTENT_SCREEN: "shadow",
    CONTENT_POLICY_SHA256: "f".repeat(64),
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
  const res = await app.fetch(new Request(`https://x${path}`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers }, body: JSON.stringify(body) }), e, ctx);
  const text = await res.text();
  return { status: res.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const PAYEE = "0x0000000000000000000000000000000000000001";
const payHeader = (from: string, value = "50000") =>
  Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: { signature: "0x" + "ab".repeat(65), authorization: { from, to: PAYEE, value, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: "0x" + "1".repeat(64) } } })).toString("base64");
/** A stand-in facilitator that verifies every payment and counts verify and settle calls; also counts AI calls. */
function fakeFacilitator() {
  const orig = globalThis.fetch;
  const calls = { verify: 0, settle: 0, other: 0 };
  globalThis.fetch = (async (u: any, init: any) => {
    const url = String(u);
    const body = init?.body ? JSON.parse(init.body) : {};
    const payer = body?.paymentPayload?.payload?.authorization?.from;
    if (url.endsWith("/verify")) return calls.verify++, new Response(JSON.stringify({ isValid: true, payer }));
    if (url.endsWith("/settle")) return calls.settle++, new Response(JSON.stringify({ success: true, transaction: "0x" + "cd".repeat(32), network: "base-sepolia", payer }));
    calls.other++;
    return orig(u, init);
  }) as any;
  return { calls, restore: () => (globalThis.fetch = orig) };
}
/** Captures console output during fn, to prove the secret never reaches a log line. */
async function logsOf(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines.join("\n");
}
const withSecret = { task: "Check this deploy script for mistakes.", output: `#!/bin/sh\nexport KEY=${fake.github}\nwrangler deploy` };
const clean = { task: "Check this deploy script for mistakes.", output: "#!/bin/sh\nwrangler deploy" };

function assertRefusal(r: { status: number; text: string; body: any }, field: string, line: number) {
  assert.equal(r.status, 422, r.text);
  assert.equal(r.body.code, "secret_in_input");
  assert.match(r.body.error, new RegExp(`${field.replace(/[[\].]/g, "\\$&")} line ${line} \\(an API key or access token\\)`));
  assert.ok(!r.text.includes(fake.github.slice(4)), "the response never holds the secret");
  assert.equal(r.body.receipt.payload.receipt_format, REFUSAL_RECEIPT_FORMAT);
  assert.equal(r.body.receipt.payload.label, "secrets");
  assert.equal(r.body.receipt.payload.policy_sha256, "f".repeat(64));
}

t("off: nothing is screened (today's behaviour)", async () => {
  const r = await call(env({ CONTENT_SCREEN: "off" }), "/review", withSecret);
  assert.equal(r.status, 200, r.text);
});

t("a paid review with a secret: refused 422 with a signed refusal-v1 receipt, never settled, no AI call, nothing logged", async () => {
  const f = fakeFacilitator();
  let r: any;
  try {
    const logs = await logsOf(async () => {
      r = await call(env({ PAYMENTS_ENABLED: "true" }), "/review-3", withSecret, { "x-payment": payHeader("0x" + "a".repeat(40), "200000") });
    });
    assertRefusal(r, "output", 2);
    assert.match(r.body.error, /Nothing was charged\./);
    assert.equal(f.calls.settle, 0, "the payment never settles");
    assert.equal(f.calls.verify, 0, "refused before the paywall even verifies");
    assert.equal(f.calls.other, 0, "no AI provider was called");
    assert.ok(!logs.includes(fake.github.slice(4)), "no log line holds the secret");
    assert.match(logs, /"screen":"2a"/);
    assert.equal(await verifyReceipt(r.body.receipt, keys.PUBLIC_KEY), true, "the refusal receipt verifies");
    const p = r.body.receipt.payload;
    assert.equal(p.charged, false);
    assert.equal(p.inputs_sha256.output, createHash("sha256").update(withSecret.output).digest("hex"), "it signs the output's hash, not the output");
    assert.ok(!JSON.stringify(p).includes(fake.github.slice(4)));
  } finally {
    f.restore();
  }
});

t("the same review without the secret goes through, is delivered and settles once", async () => {
  const f = fakeFacilitator();
  try {
    const r = await call(env({ PAYMENTS_ENABLED: "true" }), "/review", clean, { "x-payment": payHeader("0x" + "a".repeat(40)) });
    assert.equal(r.status, 200, r.text);
    await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(f.calls.settle, 1);
  } finally {
    f.restore();
  }
});

t("enforce refuses the same way (2a is the same in shadow and enforce)", async () => {
  assertRefusal(await call(env({ CONTENT_SCREEN: "enforce" }), "/review", withSecret), "output", 2);
});

t("multi-part review, free review and match creation are screened too", async () => {
  const multi = { task: "Check the handoff: every fact is right.", pieces: [{ text: "Piece one." }, { name: "env", text: `a\n${fake.github}` }] };
  assertRefusal(await call(env({ MULTI_PART_ENABLED: "true" }), "/review-3x2", multi), "pieces[1].text", 2);
  const free = await call(env({ FREE_REVIEW_DAILY_BUDGET_USD: "3.00" }), "/free/review", withSecret);
  assertRefusal(free, "output", 2);
  assert.match(free.body.error, /Your free review wasn't used\./);
  const m = await call(env(), "/matches", { tier: "judge", rules: `Pick the better plan.\nDeploy with ${fake.github}` });
  assertRefusal(m, "rules", 2);
  assert.match(m.body.error, /No match was created and nothing was charged\./);
});

t("a refused match submission: not submitted, the forfeit rule stated, receipt says already settled", async () => {
  const r = await call(env(), `/matches/${"0".repeat(24)}/submit`, { seat: "a", seat_token: "b".repeat(64), position: `My plan.\n\nUse ${fake.github}` });
  assertRefusal(r, "position", 3);
  assert.match(r.body.error, /Nothing was submitted.*forfeits, with no refund/);
  assert.equal(r.body.receipt.payload.charged, "already_settled");
  // A clean submit goes on to the match as before (an unknown match answers as it always has, not 422).
  const ok = await call(env(), `/matches/${"0".repeat(24)}/submit`, { seat: "a", seat_token: "b".repeat(64), position: "My plan." });
  assert.notEqual(ok.status, 422);
});

const get = async (e: any, path: string) => {
  const res = await app.fetch(new Request(`https://x${path}`, { headers: { accept: "application/json", "cf-connecting-ip": "203.0.113.7" } }), e, ctx);
  const text = await res.text();
  return { status: res.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const RULES = "Pick the plan with fewer steps that still meets every requirement; on a tie, pick alpha.";

t("customers are told before they pay: the submission rule in the judge 402, every judge match view, GET /judge, GET / and /llms.txt, only while the screen is on", async () => {
  const on = env({ PAYMENTS_ENABLED: "true" });
  assert.equal((await get(on, "/judge")).body.content_rule, SUBMIT_RULE);
  const root = await get(on, "/");
  assert.ok(root.text.includes(SUBMIT_RULE) && root.text.includes(REQUEST_RULE), root.text.slice(0, 200));
  assert.ok((await get(on, "/llms.txt")).text.includes(SUBMIT_RULE));
  const c = await call(on, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: RULES });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.body.content_rule, SUBMIT_RULE, "the create answer says it");
  const id = c.body.match_id;
  assert.equal((await get(on, `/matches/${id}`)).body.content_rule, SUBMIT_RULE, "so does the match view");
  const challenge = await call(on, "/join/judge", { match_id: id, seat: "alpha" });
  assert.equal(challenge.status, 402, challenge.text);
  assert.ok(challenge.text.includes(SUBMIT_RULE), "the payment request carries it, before anyone pays");
  const rps = await call(on, "/matches", { tier: "rps", seats: ["alpha", "beta"] });
  assert.equal(rps.status, 201, rps.text);
  assert.equal(rps.body.content_rule, undefined, "not on tiers with no text");
  // Off: none of it (the 402 text is built once per process, so it's checked with the screen on only).
  const off = env({ CONTENT_SCREEN: "off" });
  assert.equal((await get(off, "/judge")).body.content_rule, undefined);
  assert.ok(!(await get(off, "/")).text.includes(SUBMIT_RULE));
  assert.ok(!(await get(off, "/llms.txt")).text.includes("Secrets in what you send"));
  const c2 = await call(off, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: RULES });
  assert.equal(c2.status, 201, c2.text);
  assert.equal(c2.body.content_rule, undefined);
});
