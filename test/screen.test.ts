// The content screen, layer 2a (src/screen.ts): secrets in customer text are refused before any AI provider sees
// them and before any payment settles; placeholders and ordinary code (hashes, base64, the word "token") pass; the
// patterns stay equal to find's (a vendored copy of find/lib/scrub.mjs, the locked v1 build); nothing logs the text.
// Fake secrets are built at run time so no scanner mistakes this file for a leak.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { BUILT_IN_POLICY, INTAKE_PATTERNS, intakeCheck, screenMode, REFUSAL_RECEIPT_FORMAT, REQUEST_RULE, SUBMIT_RULE } from "../src/screen.ts";
import { canonicalJson } from "../src/logic.ts";
import { verifyReceipt } from "../src/receipt.ts";
import { scrubText } from "./fixtures/find-scrub-r4.mjs";
import { Gate } from "../src/gate.ts";
import { Health, _resetHealthCaches } from "../src/health.ts";
import { Ledger } from "../src/ledger.ts";
import { MatchRoom } from "../src/match.ts";
import { _clearSnapshots } from "../src/gateclient.ts";

const FIXTURE = new URL("./fixtures/find-scrub-r4.mjs", import.meta.url);
// find/lib/scrub.mjs as locked in SKILLS.lock 8375f007fccd (round 4, Nov 3; skills/find/lib/scrub.mjs). A new find build
// changes this on purpose: re-vendor it, then this test says whether the server's patterns still match.
const FIND_SCRUB_SHA256 = "703911e197384903b1c29b582d9148d323671a3fbc3c74773b099a382d54f2f0";

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

const cp = (...c: number[]) => c.map((x) => String.fromCodePoint(x)).join("");
const hex64 = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const pg = "postgres" + "://", web = "https" + "://", pw = "r3al" + "PassW"; // URL fakes, built so this file holds none
const keyBody = () => Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64");

const body = keyBody();
test("each kind of secret is found, by field and line, never echoing the text", () => {
  const cases: Array<[string, string]> = [
    [fake.openai, "api_key"], [fake.stripe, "api_key"], [fake.aws, "api_key"], [fake.github, "api_key"], [fake.slack, "api_key"], [fake.google, "api_key"],
    [`${fake.pem}\n${body}\n-----END RSA PRIVATE KEY-----`, "private_key"],
    [`${fake.pem}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABCD\n\n${body}`, "private_key"],
    [`"private_key": "${fake.pem}\\n${body}\\n-----END RSA PRIVATE KEY-----\\n"`, "private_key"],
    [fake.url, "url_credentials"], ["redis://:" + "Tr0ub4dor3xQ" + "@cache:6379", "url_credentials"],
    [`{"a":"http://localhost:5173/x","b":"${pg}u:${pw}@db"}`, "url_credentials"],
    [`${pg}u:<password>@h,${pg}u:${pw}@h2`, "url_credentials"],
    [`${web}u:pa$word123@db`, "url_credentials"],
    [`${web}u:$ecretP4ss@db`, "url_credentials"], // a real password starting with "$" isn't a $VAR
    [`${pg}u:${pw}@db.example.com/app?admin=ops@corp`, "url_credentials"], // a later "@" and "example" don't hide it
    [`${pg}admin:P@ss${pw}@db.internal/app`, "url_credentials"], // a raw "@" inside the password
    [`const PEM = "${fake.pem}\\n" +\n    "${body}\\n" +\n    "-----END RSA PRIVATE KEY-----";`, "private_key"], // Java-style concatenation
    [`key = ("${fake.pem}\\n"\n       "${body}\\n")`, "private_key"], // Python implicit concatenation
    [`const lines = ["${fake.pem}",\n  "${body}",`, "private_key"], // a JS array of lines
    [`# ${fake.pem}\n# ${body}`, "private_key"], // commented out
    [`> ${fake.pem}\n> ${body}`, "private_key"], // quoted in an email
    [`public static final String PRIVATE_KEY = "0x${hex64}";`, "wallet_key"],
    [`uint256 public deployerPrivateKey = 0x${hex64};`, "wallet_key"],
    [`const w = new ethers.Wallet("0x${hex64}");`, "wallet_key"],
    [`acct = Account.from_key("0x${hex64}")`, "wallet_key"],
    [`await client.sendTransaction({ account: privateKeyToAccount("0x${hex64}") })`, "wallet_key"],
    [`DEPLOYER_KEY=0x${hex64}`, "wallet_key"],
    [`Mnemonic phrase: ${"abandon ability able about above absent absorb abstract absurd abuse access accident"}`, "seed_phrase"],
    ["client-key-data: " + Buffer.from(`${fake.pem}\n${body}${body}${body}${body}\n`).toString("base64").slice(0, 76), "encoded_private_key"], // wrapped at 76
    [fake.bearer, "bearer_token"],
    [`const PRIVATE_KEY = "0x${hex64}";`, "wallet_key"],
    [`mnemonic: "${"abandon ability able about above absent absorb abstract absurd abuse access accident"}"`, "seed_phrase"],
    ["client-key-data: " + Buffer.from(`${fake.pem}\n${body}${body}${body}${body}\n`).toString("base64"), "encoded_private_key"],
  ];
  for (const [secret, kind] of cases) {
    const hits = intakeCheck({ task: "Review this config file for mistakes.", output: `line one\nconst x = 1;\n${secret}\n` });
    assert.deepEqual(hits, [{ field: "output", line: 3, kind }], `${kind}: ${secret.slice(0, 12)}`);
    assert.ok(!JSON.stringify(hits).includes(secret.slice(4, 14)), "the hit holds no part of the secret");
  }
  // The label on the line above the words; a key header ending one piece and its body opening the next.
  assert.deepEqual(intakeCheck({ output: `Recovery phrase:\n${"abandon ability able about above absent absorb abstract absurd abuse access accident"}` }), [{ field: "output", line: 2, kind: "seed_phrase" }]);
  assert.deepEqual(intakeCheck({ pieces: [{ text: `config\n${fake.pem}` }, { text: `${body}\n-----END RSA PRIVATE KEY-----` }] }), [{ field: "pieces[0].text", line: 2, kind: "private_key" }]);
  // Nested fields: pieces, criteria names, rules.
  assert.deepEqual(intakeCheck({ pieces: [{ text: "ok" }, { name: "env", text: `a\nb\n${fake.github}` }] }), [{ field: "pieces[1].text", line: 3, kind: "api_key" }]);
  assert.deepEqual(intakeCheck({ rules: `Judge fairly.\n${fake.stripe}` }), [{ field: "rules", line: 2, kind: "api_key" }]);
  assert.deepEqual(intakeCheck({ criteria: [{ name: fake.github, weight: 1 }] }), [{ field: "criteria[0].name", line: 1, kind: "api_key" }]);
});

test("invisible characters can't split a key past the check: format characters, tags, the line separator, joiners", () => {
  for (const c of [0x200b, 0x180e, 0xe0041, 0x2028, 0x34f, 0xfe0f, 0xad, 0x2060, 0xfeff, 0x17b4, 0x17b5, 0x180b, 0x180f, 0xfff0])
    assert.equal(intakeCheck({ output: fake.github.slice(0, 10) + cp(c) + fake.github.slice(10) })[0]?.kind, "api_key", `U+${c.toString(16)}`);
});

test("ordinary code and documentation pass: hashes, base64, the word token, placeholders, headers without a key, dev URLs", () => {
  const ok = [
    "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    `tx hash 0x${hex64} (the private key signed it)`,
    `public key 0x${hex64}`,
    "const token = await getToken(); // the session token from the login step",
    "password = process.env.DB_PASSWORD",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "Authorization: Bearer YOUR_API_KEY_HERE",
    "Authorization: Bearer ACCESS_TOKEN_GOES_HERE",
    "Authorization: Bearer <token>",
    "Authorization: Bearer ${process.env.TOKEN}",
    "authorization: Bearer wrong-token-wrong-token-wrong-token",
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx",
    "postgres://user:<password>@localhost:5432/db",
    "https://user:${PASS}@example.com",
    "https://user:$DB_PASS@example.com",
    "https://user:%DB_PASS%@example.com",
    "http://localhost:5173/@vite/client",
    '{"registry":"http://localhost:4873/@scope%2fpkg","email":"a@b.c"}',
    'const pemHeader = "-----BEGIN PRIVATE KEY-----";\nconst pemFooter = "-----END PRIVATE KEY-----";',
    "-----BEGIN RSA PRIVATE KEY-----\nXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\n-----END RSA PRIVATE KEY-----",
    "-----BEGIN PUBLIC KEY-----\n" + keyBody(),
    "-----BEGIN CERTIFICATE-----",
    'mnemonic = "test test test test test test test test test test test junk"',
    'mnemonic: "candy maple cake sugar pudding cream honey rich smooth crumble sweet treat"',
    'mnemonic: "myth like bonus scare over problem client lizard pioneer submit female collect"',
    'mnemonic = "legal winner thank year wave sausage worth useful legal winner thank yellow"',
    `const PRIVATE_KEY = "0x${"ac0974be" + "c39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"}"; // Hardhat account #0`,
    `DATABASE_URL: ${pg}postgres:postgres@localhost:5432/app_test`,
    `const url = "amqp://guest:guest@localhost:5672/";`,
    `mysql://root:root@127.0.0.1:3306/db`,
    `redis://:foobared@localhost:6379/0`,
    `${pg}app:${pw}@localhost:5432/dev`,
    "OPENAI_API_KEY=sk-abcdef1234567890abcdef", // a typed run: a docs fake
    "const tx = await wallet.sendTransaction(tx); // hash 0x" + "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
    "The skin-deep tasks: risk assessment, asking for 12 apples.",
  ];
  for (const line of ok) assert.deepEqual(intakeCheck({ output: line }), [], line);
});

test("a crafted long line costs milliseconds, not seconds, at the field limit", () => {
  const shapes = ["a://b:".repeat(2000), "x@" + "a://b:".repeat(2000), "a://b:".repeat(1999) + "c@", "a.".repeat(6000), "sk-".repeat(4000), "xoxb-".repeat(2400), "redis://:".repeat(1333)];
  for (const line of shapes) {
    const t0 = Date.now();
    intakeCheck({ output: line.slice(0, 12000) }); // 12,000 characters, the longest validated field
    assert.ok(Date.now() - t0 < 150, `${line.slice(0, 12)}: ${Date.now() - t0} ms`);
  }
  // The shapes that made every start position scan the line (a URL start with no "@" after it in its word): warm, each
  // costs a few milliseconds, not the tens a scan per start costs (the review-3x3's point 6, Nov 3).
  const quadratic = ["a://b:".repeat(2000), "x@" + "a://b:".repeat(1999), "a://b:".repeat(1000) + " x@y", "a://b:".repeat(1000) + "@" + "c://d:".repeat(999)];
  for (const line of quadratic) {
    intakeCheck({ output: line.slice(0, 12000) });
    const t0 = performance.now();
    intakeCheck({ output: line.slice(0, 12000) });
    assert.ok(performance.now() - t0 < 12, `${line.slice(0, 12)}: ${(performance.now() - t0).toFixed(1)} ms warm`);
  }
  // Same matches as the full line: a placeholder URL then a real one, in one word and in two.
  assert.equal(intakeCheck({ output: `${pg}u:<password>@h,${pg}u:${pw}@h2` })[0]?.kind, "url_credentials");
  assert.equal(intakeCheck({ output: `see ${pg}u:<password>@h and ${pg}u:${pw}@h2 too` })[0]?.kind, "url_credentials");
});

test("an input with more strings than any validated field set can hold is refused, not passed unscreened", () => {
  assert.deepEqual(intakeCheck({ pad: Array(300).fill(""), output: "fine" }), [{ field: "(input)", line: 0, kind: "too_complex" }]);
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
const get = async (e: any, path: string) => {
  const res = await app.fetch(new Request(`https://x${path}`, { headers: { accept: "application/json", "cf-connecting-ip": "203.0.113.7" } }), e, ctx);
  const text = await res.text();
  return { status: res.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const withSecret = { task: "Check this deploy script for mistakes.", output: `#!/bin/sh\nexport KEY=${fake.github}\nwrangler deploy` };
const clean = { task: "Check this deploy script for mistakes.", output: "#!/bin/sh\nwrangler deploy" };
const RULES = "Pick the plan with fewer steps that still meets every requirement; on a tie, pick alpha.";

function assertRefusal(r: { status: number; text: string; body: any }, field: string, line: number, kind = "an API key or access token") {
  assert.equal(r.status, 422, r.text);
  assert.equal(r.body.code, "secret_in_input");
  assert.match(r.body.error, new RegExp(`${field.replace(/[[\].]/g, "\\$&")} line ${line} \\(${kind}\\)`));
  assert.ok(!r.text.includes(fake.github.slice(4)), "the response never holds the secret");
  assert.equal(r.body.receipt.payload.receipt_format, REFUSAL_RECEIPT_FORMAT);
  assert.equal(r.body.receipt.payload.label, "secrets");
  assert.equal(r.body.receipt.payload.policy_sha256, "f".repeat(64));
}

t("off: nothing is screened (today's behaviour)", async () => {
  const r = await call(env({ CONTENT_SCREEN: "off" }), "/review", withSecret);
  assert.equal(r.status, 200, r.text);
});

t("a paid review with a secret: refused 422 with a signed refusal-v1 receipt, never settled, no provider call, nothing logged", async () => {
  const f = fakeFacilitator();
  let r: any;
  try {
    // FAKE_AI off: a reviewer that ran would really call its provider (and be counted in f.calls.other).
    const logs = await logsOf(async () => {
      r = await call(env({ PAYMENTS_ENABLED: "true", FAKE_AI: "false" }), "/review-3", withSecret, { "x-payment": payHeader("0x" + "a".repeat(40), "200000") });
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

t("the screen answers after the region and sanctions checks: a sanctioned caller gets the region refusal, no signed receipt", async () => {
  for (const path of ["/review", "/free/review"]) {
    const r = await call(env({ FREE_REVIEW_DAILY_BUDGET_USD: "3.00" }), path, withSecret, { "cf-ipcountry": "CU" });
    assert.equal(r.status, 451, `${path}: ${r.text}`);
    assert.equal(r.body.receipt, undefined);
  }
});

t("without a configured policy hash the receipt signs the built-in policy's hash and says so", async () => {
  const r = await call(env({ CONTENT_POLICY_SHA256: undefined }), "/review", withSecret);
  assert.equal(r.status, 422, r.text);
  assert.equal(r.body.receipt.payload.policy_sha256, createHash("sha256").update(canonicalJson(BUILT_IN_POLICY)).digest("hex"));
  assert.equal(r.body.receipt.payload.policy_source, BUILT_IN_POLICY.version);
});

t("every public route that carries customer text is screened, in every text field: review tiers, free, internal free, multi-part, match creation", async () => {
  const TEAM = { TEAM_TOKEN: "t".repeat(40), TEAM_MEMBERS: "5.0", TEAM_MEMBER_DAILY_USD: "0.50", TEAM_DAILY_USD: "0.80" };
  const INTERNAL = "i".repeat(40);
  const inTitle = { ...clean, title: `deploy ${fake.github}` };
  const inCriteria = { ...clean, criteria: [{ name: "accuracy", weight: 2 }, { name: fake.github, weight: 1 }] };
  const multi = (n: number) => ({ task: "Check the handoff: every fact is right.", pieces: Array.from({ length: n }, (_, i) => ({ text: i === 1 ? `a\n${fake.github}` : `Piece ${i + 1}.` })) });
  const cases: Array<[Record<string, unknown>, string, unknown, Record<string, string>, string, number, string]> = [
    [{}, "/review", withSecret, {}, "output", 2, "Nothing was charged."],
    [{}, "/review-3", inTitle, {}, "title", 1, "Nothing was charged."],
    [{}, "/review-3", inCriteria, {}, "criteria[1].name", 1, "Nothing was charged."],
    [{ MULTI_PART_ENABLED: "true" }, "/review-3x2", multi(2), {}, "pieces[1].text", 2, "Nothing was charged."],
    [{ MULTI_PART_ENABLED: "true" }, "/review-3x3", multi(3), {}, "pieces[1].text", 2, "Nothing was charged."],
    [{ FREE_REVIEW_DAILY_BUDGET_USD: "3.00" }, "/free/review", withSecret, {}, "output", 2, "Your free review wasn't used."],
    [{ FREE_REVIEW_DAILY_BUDGET_USD: "3.00" }, "/free/review-3", inTitle, {}, "title", 1, "Your free review wasn't used."],
    [{ INTERNAL_TOKEN: INTERNAL, EXT_FREE_DAILY_BUDGET_USD: "1.00" }, "/internal/free/review", withSecret, { "x-internal-auth": INTERNAL, "x-caller-id": "user-1" }, "output", 2, "Your free review wasn't used."],
    [{}, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: `${RULES}\nDeploy with ${fake.github}` }, {}, "rules", 2, "No match was created and nothing was charged."],
    [{}, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: RULES, title: fake.github }, {}, "title", 1, "No match was created and nothing was charged."],
    [{}, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: RULES, criteria: [{ name: fake.github, weight: 1 }] }, {}, "criteria[0].name", 1, "No match was created and nothing was charged."],
  ];
  for (const [extra, path, body, headers, field, line, after] of cases) {
    const r = await call(env(extra), path, body, headers);
    assertRefusal(r, field, line);
    assert.ok(r.body.error.endsWith(after), `${path}: ${r.body.error.slice(-60)}`);
  }
});

t("only validated fields are screened: an extra field the route ignores (and never sends to a provider) isn't refused", async () => {
  const r = await call(env(), "/review", { ...clean, notes: `deploy with ${fake.github}` });
  assert.equal(r.status, 200, r.text);
});

t("match creation screens only what reaches a judge: an rps key or a draw option is never screened", async () => {
  const rps = await call(env(), "/matches", { tier: "rps", seats: ["alpha", "beta"], key: "deal:" + fake.openai.slice(0, 30) });
  assert.equal(rps.status, 201, rps.text);
  const draw = await call(env(), "/matches", { tier: "draw", seats: ["alpha", "beta"], options: ["one", `amqp://ops:${pw}@mq`] });
  assert.equal(draw.status, 201, draw.text);
});

t("a refused submission says already_settled only when the seat really paid", async () => {
  const f = fakeFacilitator();
  try {
    const e = env({ PAYMENTS_ENABLED: "true", JOIN_WAIT_SECONDS: "5" });
    const c = await call(e, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: RULES });
    assert.equal(c.status, 201, c.text);
    // A paid seat waits for the other one (and is released, uncharged, if nobody comes): join both at once.
    const tok: Record<string, string> = {};
    const join = (s: string, i: number) => call(e, "/join/judge", { match_id: c.body.match_id, seat: s }, { "x-payment": payHeader("0x" + String(i + 1).repeat(40), "100000") });
    const first = join("alpha", 0);
    await new Promise((ok) => setTimeout(ok, 50));
    const [a, b] = await Promise.all([first, join("beta", 1)]);
    for (const [s, j] of [["alpha", a], ["beta", b]] as const) {
      assert.equal(j.status, 200, j.text);
      tok[s] = j.body.seat_token;
    }
    assert.equal(Object.keys(tok).length, 2, "both seats joined");
    const r = await call(e, `/matches/${c.body.match_id}/submit`, { seat: "alpha", seat_token: tok.alpha, position: `Plan.\n${fake.github}` });
    assert.equal(r.status, 422, r.text);
    assert.equal(r.body.receipt.payload.charged, "already_settled");
  } finally {
    f.restore();
  }
});

t("turning the screen on never forfeits a match whose seats weren't told: submissions to it aren't screened", async () => {
  const e = env({ CONTENT_SCREEN: "off" });
  const c = await call(e, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: RULES });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.body.content_rule, undefined);
  e.CONTENT_SCREEN = "shadow"; // the switch, after creation
  const j = await call(e, "/join/judge", { match_id: c.body.match_id, seat: "alpha" });
  assert.equal((await call(e, "/join/judge", { match_id: c.body.match_id, seat: "beta" })).status, 200);
  const r = await call(e, `/matches/${c.body.match_id}/submit`, { seat: "alpha", seat_token: j.body.seat_token, position: `Plan.\n${fake.github}` });
  assert.equal(r.status, 200, r.text);
});

t("allow_secrets: true passes fake keys on purpose, counted; the team's own routes count without refusing", async () => {
  const MP = { MULTI_PART_ENABLED: "true" };
  const multi = { task: "Check the scrubber's fixtures.", pieces: [{ text: "Piece one." }, { text: `fixture\n${fake.github}` }] };
  let logs = await logsOf(async () => {
    assert.equal((await call(env(), "/review", { ...withSecret, allow_secrets: true })).status, 200);
    assert.equal((await call(env(MP), "/review-3x2", { ...multi, allow_secrets: true })).status, 200, "the multi-part validator accepts the field");
    assert.equal((await call(env({ FREE_REVIEW_DAILY_BUDGET_USD: "3.00" }), "/free/review", { ...withSecret, allow_secrets: true })).status, 200);
    assert.equal((await call(env(), "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: `${RULES}\n${fake.github}`, allow_secrets: true })).status, 201);
  });
  assert.match(logs, /"passed":"allowed"/);
  assert.ok(!logs.includes(fake.github.slice(4)), "counted, never content");
  // Without the field, the same requests are refused (shown above); allow_secrets: false refuses too.
  assert.equal((await call(env(), "/review", { ...withSecret, allow_secrets: false })).status, 422);
  // The team's own route: counted, not refused.
  const TEAM = { TEAM_TOKEN: "t".repeat(40), TEAM_MEMBERS: "5.0", TEAM_MEMBER_DAILY_USD: "0.50", TEAM_DAILY_USD: "0.80" };
  logs = await logsOf(async () => {
    assert.equal((await call(env(TEAM), "/team/review", withSecret, { "x-team-token": TEAM.TEAM_TOKEN, "x-team-member": "5.0" })).status, 200);
  });
  assert.match(logs, /"passed":"team"/);
  // Submissions: single position and multi-part pieces.
  const e = env({ MULTI_JUDGE_ENABLED: "true" });
  for (const [tier, body] of [["judge", { position: `Plan.\n${fake.github}` }], ["judge-3x2", { pieces: [{ text: "one" }, { text: `two\n${fake.github}` }] }]] as const) {
    const c = await call(e, "/matches", { tier, seats: ["alpha", "beta"], rules: RULES });
    const tok: Record<string, string> = {};
    for (const s of ["alpha", "beta"]) tok[s] = (await call(e, `/join/${tier}`, { match_id: c.body.match_id, seat: s })).body.seat_token;
    const r = await call(e, `/matches/${c.body.match_id}/submit`, { seat: "alpha", seat_token: tok.alpha, ...body, allow_secrets: true });
    assert.equal(r.status, 200, `${tier}: ${r.text}`);
  }
});

t("refusals and allow_secrets passes are counted in /admin/stats, on every route, submissions included", async () => {
  const e = env({ MULTI_JUDGE_ENABLED: "true" });
  await call(e, "/review", withSecret);
  await call(e, "/review", { ...withSecret, allow_secrets: true });
  const c = await call(e, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: RULES });
  const tok: Record<string, string> = {};
  for (const s of ["alpha", "beta"]) tok[s] = (await call(e, "/join/judge", { match_id: c.body.match_id, seat: s })).body.seat_token;
  await call(e, `/matches/${c.body.match_id}/submit`, { seat: "alpha", seat_token: tok.alpha, position: `Plan.\n${fake.github}` });
  await call(e, `/matches/${c.body.match_id}/submit`, { seat: "alpha", seat_token: tok.alpha, position: `Plan.\n${fake.github}`, allow_secrets: true });
  await new Promise((ok) => setTimeout(ok, 50));
  const res = await app.fetch(new Request("https://x/admin/stats", { headers: { authorization: `Bearer ${"a".repeat(40)}` } }), e, ctx);
  const st = JSON.stringify(await res.json());
  assert.match(st, /"screen_2a_refused":2/, st.slice(0, 400));
  assert.match(st, /"screen_2a_allowed":2/, st.slice(0, 400));
});

t("a refusal's receipt hashes only the fields that reach a provider (not the panel or other request settings)", async () => {
  const r = await call(env(), "/review-3", { ...withSecret, title: "Deploy script", panel: "rotate" });
  assert.equal(r.status, 422, r.text);
  assert.deepEqual(Object.keys(r.body.receipt.payload.inputs_sha256).sort(), ["output", "task", "title"]);
});

t("the review routes' payment request carries the request rule, with how to send fake keys", async () => {
  const r = await call(env({ PAYMENTS_ENABLED: "true" }), "/review", clean);
  assert.equal(r.status, 402, r.text);
  assert.ok(r.text.includes(REQUEST_RULE), r.text.slice(0, 300));
  assert.match(REQUEST_RULE, /allow_secrets/);
});

t("a refused match creation creates nothing: the same key then creates a fresh match", async () => {
  const e = env();
  const key = "screen-" + "k".repeat(20);
  const refused = await call(e, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: `${RULES}\n${fake.github}`, key });
  assertRefusal(refused, "rules", 2);
  const again = await call(e, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: RULES, key });
  assert.equal(again.status, 201, again.text);
  assert.equal(again.body.existing, undefined, "no match existed under that key");
  // Input the match object would refuse anyway isn't screened here: it gets the same error as before.
  const bad = await call(e, "/matches", { tier: "judge", seats: ["alpha"], rules: fake.github });
  assert.notEqual(bad.status, 422);
  assert.ok(bad.status >= 400 && bad.status < 500, bad.text);
});

t("a refused submission, after the seat check, changes nothing: the seat is still waited on and can submit again; the receipt names match, seat and tier", async () => {
  const e = env();
  const c = await call(e, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: RULES });
  assert.equal(c.status, 201, c.text);
  const id = c.body.match_id;
  const tok: Record<string, string> = {};
  for (const s of ["alpha", "beta"]) {
    const j = await call(e, "/join/judge", { match_id: id, seat: s });
    assert.equal(j.status, 200, j.text);
    tok[s] = j.body.seat_token;
  }
  // The seat check comes first: a secret with a bad token is a 403, and the token itself is never screened.
  const wrongToken = await call(e, `/matches/${id}/submit`, { seat: "alpha", seat_token: fake.github, position: `Plan A.\n${fake.github}` });
  assert.equal(wrongToken.status, 403, wrongToken.text);
  const r = await call(e, `/matches/${id}/submit`, { seat: "alpha", seat_token: tok.alpha, position: `My plan.\n\nUse ${fake.github}` });
  assertRefusal(r, "position", 3);
  assert.match(r.body.error, /Nothing was submitted.*forfeits, with no refund/);
  const p = r.body.receipt.payload;
  assert.equal(p.charged, false, "payments off: nobody paid");
  assert.deepEqual([p.match_id, p.seat, p.tier], [id, "alpha", "judge"]);
  const st = await get(e, `/matches/${id}`);
  assert.equal(st.body.phase, "submit");
  assert.deepEqual(st.body.waiting_on.sort(), ["alpha", "beta"], "alpha is still waited on");
  assert.equal((await call(e, `/matches/${id}/submit`, { seat: "alpha", seat_token: tok.alpha, position: "My plan." })).status, 200);
  assert.deepEqual((await get(e, `/matches/${id}`)).body.waiting_on, ["beta"]);
});

t("multi-part judge submissions are screened piece by piece, after the seat check", async () => {
  const e = env({ MULTI_JUDGE_ENABLED: "true" });
  const c = await call(e, "/matches", { tier: "judge-3x2", seats: ["alpha", "beta"], rules: RULES });
  assert.equal(c.status, 201, c.text);
  const id = c.body.match_id;
  const tok: Record<string, string> = {};
  for (const s of ["alpha", "beta"]) {
    const j = await call(e, "/join/judge-3x2", { match_id: id, seat: s });
    assert.equal(j.status, 200, j.text);
    tok[s] = j.body.seat_token;
  }
  const r = await call(e, `/matches/${id}/submit`, { seat: "alpha", seat_token: tok.alpha, pieces: [{ text: "Piece one." }, { text: `Piece two.\n${fake.github}` }] });
  assertRefusal(r, "pieces[1].text", 2);
  assert.equal(r.body.receipt.payload.seat, "alpha");
  const st = await get(e, `/matches/${id}`);
  assert.ok(st.body.waiting_on.includes("alpha"), st.text);
});

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
