// The pre-judge (src/prejudge.ts; content-screen design v1 section 5, ADDENDUM-2 and 5.0's notes of Nov 5): a free
// brief from the customer's question, before anything is judged; a review that uses it records both hashes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/gate.ts";
import { Health, _resetHealthCaches } from "../src/health.ts";
import { Ledger } from "../src/ledger.ts";
import { MatchRoom } from "../src/match.ts";
import { _clearSnapshots } from "../src/gateclient.ts";
import { verifyReceipt } from "../src/receipt.ts";
import { canonicalJson, sha256Hex } from "../src/logic.ts";
import {
  PREJUDGE_FORMAT_VERSION, PREJUDGE_LIMITS, PREJUDGE_MAX_TOKENS, PREJUDGE_MESSAGE_FORMAT, PREJUDGE_SYSTEM, briefSha256, checkPrejudge, chooseWriter, listsSha256, parsePrejudge, prejudgeConfig, validatePrejudge,
} from "../src/prejudge.ts";
import { reviewCommitment } from "../src/review.ts";

let app: any = null;
try {
  app = (await import("../src/index.ts")).default;
} catch (e) {
  console.log(`prejudge route tests skipped (dependencies not installed here): ${String((e as any)?.message ?? e).slice(0, 120)}`);
}
const t = app ? test : test.skip;

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };
// Signed by hand: receipt.ts keeps the first signing key it loads, as the Worker does, so another key needs its own path.
const signWith = async (payload: any, pair: CryptoKeyPair) => ({
  payload,
  signature: b64(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(canonicalJson(payload)))),
  algorithm: "Ed25519" as const,
  public_key: b64((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer),
});
const mem = () => {
  const d = new Map<string, unknown>();
  return { storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); }, async delete(k: any) { for (const x of [k].flat()) d.delete(x); return true; }, async list(o: { prefix?: string } = {}) { return new Map([...d.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort().map((k) => [k, structuredClone(d.get(k))])); }, async deleteAll() { d.clear(); }, async setAlarm() {} } };
};
function ns<T extends { fetch(r: Request): Promise<Response> }>(make: () => T) {
  const objs = new Map<string, T>();
  const n = { objs, broken: false, idFromName: (x: string) => x, get: (id: string) => ({ fetch: async (u: string, i?: RequestInit) => { if (n.broken) throw new Error("object unavailable"); if (!objs.has(id)) objs.set(id, make()); return objs.get(id)!.fetch(new Request(u, i)); } }) };
  return n;
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
    CLAUDE_JUDGES_ENABLED: "true",
    GATES: ns(() => new Gate(mem() as any)),
    HEALTH: ns(() => new Health(mem() as any)),
    ...extra,
  };
  e.LEDGER = e.LEDGER ?? ns(() => new Ledger(mem() as any, e));
  e.MATCHES = ns(() => new MatchRoom(mem() as any, e));
  return e;
}
const ON = { PREJUDGE_ENABLED: "true", FREE_REVIEW_DAILY_BUDGET_USD: "3.00" };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = async (e: any, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.fetch(new Request(`https://x${path}`, body === undefined ? { headers } : { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers }, body: JSON.stringify(body) }), e, ctx);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const question = "Write a function that adds two whole numbers and returns their sum, with one test that shows it works.";
// Console output, to check what reaches the logs.
function captureLogs() {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of ["log", "error", "warn"] as const) (console as any)[k] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  return { lines, restore: () => void Object.assign(console, orig) };
}
// The real x402 paywall with a stand-in facilitator (as in routes.test.ts): verify says valid, settle succeeds.
const PAYEE = "0x0000000000000000000000000000000000000001";
const payHeader = (n: number, value = "50000") =>
  Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature: "0x" + "ab".repeat(65),
        authorization: { from: "0x" + String(n).padStart(40, "0"), to: PAYEE, value, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: "0x" + String(n).padStart(64, "0") },
      },
    }),
  ).toString("base64");
function fakeFacilitator(settle: "ok" | "fail" = "ok") {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: any, init: any) => {
    const url = String(u);
    const body = init?.body ? JSON.parse(init.body) : {};
    const payer = body?.paymentPayload?.payload?.authorization?.from;
    if (url.endsWith("/verify")) return new Response(JSON.stringify({ isValid: true, payer }), { status: 200 });
    if (url.endsWith("/settle"))
      return new Response(JSON.stringify(settle === "ok" ? { success: true, transaction: "0x" + "cd".repeat(32), network: "base-sepolia", payer } : { success: false, errorReason: "insufficient_funds", transaction: "", network: "base-sepolia", payer }), { status: 200 });
    throw new Error(`no network in these tests: ${url}`);
  }) as any;
  return { restore: () => void (globalThis.fetch = orig) };
}
// The earn-back and the settlement run in the background (waitUntil): give them a moment.
const settleWait = () => new Promise((r) => setTimeout(r, 50));
const TEAM = { "x-team-token": "test-fixture-not-a-secret-0123456789abcdef", "x-team-member": "m1" };
const TEAM_ENV = { TEAM_TOKEN: TEAM["x-team-token"], TEAM_MEMBERS: "m1" };
const output = "function add(a, b) { return a + b; }\n// test: add(2, 3) === 5";

// ---------- the parts, without the routes ----------

test("validatePrejudge: the question's bounds; a writer must be a string", () => {
  assert.equal(validatePrejudge(null).ok, false);
  assert.equal(validatePrejudge([]).ok, false);
  assert.equal(validatePrejudge({ question: "short" }).ok, false);
  assert.equal(validatePrejudge({ question: "x".repeat(PREJUDGE_LIMITS.maxQuestion + 1) }).ok, false);
  assert.equal(validatePrejudge({ question, writer: 7 }).ok, false);
  const ok = validatePrejudge({ question, writer: "claude-haiku-5-5" });
  assert.ok(ok.ok && ok.value.writer === "claude-haiku-5-5" && ok.value.question === question);
});

test("prejudgeConfig: off unless switched on; the writers and the counts", () => {
  assert.equal(prejudgeConfig({}).enabled, false);
  const c = prejudgeConfig({ PREJUDGE_ENABLED: "true" });
  assert.deepEqual(c.writers, ["claude-haiku-5-5"]);
  assert.equal(c.perDay, 3);
  assert.equal(c.costMicro, 10_000);
  assert.equal(prejudgeConfig({ PREJUDGE_ENABLED: "true", PREJUDGE_PER_DAY: "0" }).enabled, false, "0 a day is off");
  assert.deepEqual(prejudgeConfig({ PREJUDGE_ENABLED: "true", PREJUDGE_WRITERS: " claude-haiku-5-5, google/gemini-3.7-flash ,claude-haiku-5-5" }).writers, ["claude-haiku-5-5", "google/gemini-3.7-flash"]);
  // Only models the service knows (the pool and the opt-in list), under the ids its panels use (the fresh read's F7).
  const odd = prejudgeConfig({ PREJUDGE_ENABLED: "true", PREJUDGE_WRITERS: "claude-haiku-5-5,anthropic/claude-haiku-5-5,made-up-model" });
  assert.deepEqual(odd.writers, ["claude-haiku-5-5"]);
  assert.deepEqual(odd.unknownWriters, ["anthropic/claude-haiku-5-5", "made-up-model"]);
  assert.equal(prejudgeConfig({ PREJUDGE_ENABLED: "true", PREJUDGE_WRITERS: "made-up-model" }).enabled, false, "no known writer: off");
});

test("chooseWriter: only from the list; a named one must be on it", () => {
  assert.deepEqual(chooseWriter(["a", "b"], "b"), { ok: true, writer: "b" });
  assert.equal(chooseWriter(["a", "b"], "c").ok, false);
  assert.equal(chooseWriter([], undefined).ok, false);
  for (const r of [0, 0.49, 0.5, 0.999999]) {
    const w = chooseWriter(["a", "b"], undefined, () => r);
    assert.ok(w.ok && ["a", "b"].includes(w.writer));
  }
});

test("parsePrejudge: a brief that fits a review; the lists whole or refused; criteria a review accepts", () => {
  const d = parsePrejudge('Here it is: {"task": "Return the sum of two whole numbers.", "changes": ["Stated the input type."], "please_confirm": []} Done.');
  assert.equal(d.task, "Return the sum of two whole numbers.");
  assert.deepEqual(d.changes, ["Stated the input type."]);
  assert.equal(d.criteria, undefined);
  const w = parsePrejudge(JSON.stringify({ task: "Return the sum of two whole numbers.", criteria: [{ name: " speed ", weight: 2 }], changes: [], please_confirm: ["Inputs are whole numbers."] }));
  assert.deepEqual(w.criteria, [{ name: "speed", weight: 2 }], "validated as a review validates them");
  assert.throws(() => parsePrejudge("no json"), /unusable/);
  assert.throws(() => parsePrejudge('{"task": "short"}'), /brief isn't/);
  assert.throws(() => parsePrejudge(JSON.stringify({ task: "x".repeat(4001) })), /brief isn't/);
  assert.throws(() => parsePrejudge(JSON.stringify({ task: "Return the sum of two whole numbers.", criteria: [{ name: "a", weight: 0 }] })), /criteria/);
  assert.throws(() => parsePrejudge(JSON.stringify({ task: "Return the sum of two whole numbers.", changes: "one" })), /changes/);
  assert.throws(() => parsePrejudge(JSON.stringify({ task: "Return the sum of two whole numbers.", changes: Array(21).fill("c") })), /changes/, "never cut");
  assert.throws(() => parsePrejudge(JSON.stringify({ task: "Return the sum of two whole numbers.", please_confirm: ["x".repeat(501)] })), /please_confirm/);
});

test("briefSha256 covers the task and the criteria (none: null)", async () => {
  const a = await briefSha256("Return the sum.");
  assert.equal(a, await sha256Hex('{"criteria":null,"task":"Return the sum."}'));
  assert.notEqual(a, await briefSha256("Return the sum.", [{ name: "speed", weight: 2 }]));
  assert.notEqual(a, await briefSha256("Return the sum!"));
});

test("reviewCommitment's exclude: a named or default panel holding the writer is refused; rotate draws without it", async () => {
  await assert.rejects(reviewCommitment("review", {}, undefined, undefined, 0, ["claude-sonnet-5-5"]), /wrote this brief/);
  await assert.rejects(reviewCommitment("review-3", {}, ["claude-opus-5-5", "openai/gpt-6-luna", "claude-haiku-5-5"] as any, undefined, 0, ["claude-haiku-5-5"]), /wrote this brief/);
  const ok = await reviewCommitment("review", {}, undefined, undefined, 0, ["claude-haiku-5-5"]);
  assert.deepEqual(ok.models, ["claude-sonnet-5-5"]);
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 40; i++) {
    const c = await reviewCommitment("review-3", {}, "rotate", rand, 0, ["claude-haiku-5-5"]);
    assert.ok(!c.models.includes("claude-haiku-5-5"), c.models.join(","));
  }
  // The writer alone in its company: "rotate" can't seat three companies, and the refusal says why (F8).
  await assert.rejects(
    reviewCommitment("review-3", { MODEL_POOL: "claude-sonnet-5-5,openai/gpt-6-luna,google/gemini-4-argon" } as any, "rotate", undefined, 0, ["openai/gpt-6-luna"]),
    /brief's writer, openai\/gpt-6-luna, is left out of this panel/,
  );
  // Any other refusal stands as it is (fresh read of e5153fa, N5).
  await assert.rejects(reviewCommitment("review", {}, ["made-up-model"] as any, undefined, 0, ["claude-haiku-5-5"]), (e: any) => !/brief's writer/.test(e.message));
});

test("checkPrejudge: only this service's signature, only for this brief", async () => {
  const task = "Return the sum of two whole numbers.";
  const payload = { type: "prejudge", format_version: PREJUDGE_FORMAT_VERSION, prejudge_id: "p1", question_sha256: "q", brief_sha256: await briefSha256(task), writer: "claude-haiku-5-5", allowance_ref: "2026-11-22|x" };
  const r = await signWith(payload, kp);
  const ok = await checkPrejudge(r, { task }, keys.PUBLIC_KEY);
  assert.ok(ok.ok && ok.use.writer === "claude-haiku-5-5" && ok.use.allowance_ref === "2026-11-22|x");
  assert.match((await checkPrejudge(r, { task: task + " " }, keys.PUBLIC_KEY) as any).error, /another brief/);
  assert.match((await checkPrejudge(r, { task, criteria: [{ name: "speed", weight: 1 }] }, keys.PUBLIC_KEY) as any).error, /another brief/);
  const theirs = await signWith(payload, other);
  assert.match((await checkPrejudge(theirs, { task }, keys.PUBLIC_KEY) as any).error, /isn't signed by this service/);
  const edited = { ...r, payload: { ...payload, writer: "someone-else" } };
  assert.match((await checkPrejudge(edited, { task }, keys.PUBLIC_KEY) as any).error, /isn't signed by this service/);
  assert.match((await checkPrejudge({ ...r, signature: null }, { task }, keys.PUBLIC_KEY) as any).error, /isn't signed/);
  assert.match((await checkPrejudge("receipt", { task }, keys.PUBLIC_KEY) as any).error, /must be the receipt/);
  const review = await signWith({ ...payload, type: "review" }, kp);
  assert.match((await checkPrejudge(review, { task }, keys.PUBLIC_KEY) as any).error, /isn't a pre-judge receipt/);
  assert.match((await checkPrejudge(r, { task }, undefined) as any).error, /isn't signed/);
  // The routes pass their network: a receipt signed for another network is refused (the fresh read's F6).
  const here = await signWith({ ...payload, network: "base-sepolia" }, kp);
  assert.ok((await checkPrejudge(here, { task }, keys.PUBLIC_KEY, "base-sepolia")).ok);
  assert.match((await checkPrejudge(here, { task }, keys.PUBLIC_KEY, "base") as any).error, /another network \(base-sepolia\)/);
  assert.match((await checkPrejudge(r, { task }, keys.PUBLIC_KEY, "base") as any).error, /another network \(none\)/);
});

// ---------- the routes ----------

t("off by default, and off without the free reviews' budget", async () => {
  assert.equal((await call(env(), "/prejudge", { question })).status, 503);
  assert.equal((await call(env({ PREJUDGE_ENABLED: "true" }), "/prejudge", { question })).status, 503, "no free budget");
  const info = (await call(env(), "/reviewers")).body;
  assert.equal(info.prejudge, undefined, "GET /reviewers says nothing of it while it's off");
});

t("a brief: the draft, its changes, what to confirm, and a receipt signed with both hashes", async () => {
  const e = env(ON);
  const r = await call(e, "/prejudge", { question });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.brief.task.includes(question));
  assert.ok(Array.isArray(r.body.changes) && Array.isArray(r.body.please_confirm));
  assert.equal(r.body.writer, "claude-haiku-5-5");
  assert.match(r.body.saw, /question only/);
  assert.equal(r.body.question_sha256, await sha256Hex(question));
  assert.equal(r.body.brief_sha256, await briefSha256(r.body.brief.task, r.body.brief.criteria));
  assert.deepEqual(r.body.free, { used_today: 1, per_day: 3, left_today: 2 });
  const p = r.body.receipt.payload;
  assert.equal(p.type, "prejudge");
  assert.equal(p.saw, "question");
  assert.equal(p.funding, "free");
  assert.equal(p.question_sha256, r.body.question_sha256);
  assert.equal(p.brief_sha256, r.body.brief_sha256);
  assert.equal(p.prompt_sha256, await sha256Hex(`${PREJUDGE_FORMAT_VERSION}\n${PREJUDGE_SYSTEM}\n${PREJUDGE_MESSAGE_FORMAT}`));
  assert.equal(typeof p.allowance_ref, "string");
  assert.equal(p.lists_sha256, await listsSha256(r.body.changes, r.body.please_confirm), "what the customer was shown to confirm, by hash");
  assert.equal(p.writer_reported, r.body.writer_reported, "the model the provider reported, signed");
  assert.match(p.note, /doesn't check that the brief is faithful/);
  assert.match(r.body.next, /The writer, claude-haiku-5-5, can't sit on that review's panel/);
  assert.ok(await verifyReceipt(r.body.receipt, keys.PUBLIC_KEY));
  const info = (await call(e, "/reviewers")).body;
  assert.equal(info.prejudge.available, true);
  assert.deepEqual(info.prejudge.writers, ["claude-haiku-5-5"]);
});

t("bad input, a writer off the list, and a secret in the question are refused, and the allowance isn't used", async () => {
  const e = env({ ...ON, PREJUDGE_PER_DAY: "1", CONTENT_SCREEN: "enforce" });
  assert.equal((await call(e, "/prejudge", { question: "short" })).status, 400);
  const off = await call(e, "/prejudge", { question, writer: "openai/gpt-6-luna" });
  assert.equal(off.status, 400);
  assert.match(off.body.error, /writer must be one of/);
  const secret = await call(e, "/prejudge", { question: `${question} Use the key ${"AKIA" + "Q3XZ7TK2MRB5VWNP"}.` });
  assert.equal(secret.status, 422, JSON.stringify(secret.body));
  const ok = await call(e, "/prejudge", { question });
  assert.equal(ok.status, 200, "the one use of the day is still there");
});

t("a few a day per address, inside the free budget; another address has its own; free reviews keep theirs", async () => {
  const e = env({ ...ON, PREJUDGE_PER_DAY: "2" });
  assert.equal((await call(e, "/prejudge", { question })).status, 200);
  assert.equal((await call(e, "/prejudge", { question })).status, 200);
  const third = await call(e, "/prejudge", { question });
  assert.equal(third.status, 429);
  assert.match(third.body.error, /free pre-judges \(2 per day/);
  assert.equal((await call(e, "/prejudge", { question }, { "cf-connecting-ip": "198.51.100.20" })).status, 200);
  assert.equal((await call(e, "/free/review", { task: question, output })).status, 200, "its own count, not the free reviews'");
  const tight = env({ ...ON, FREE_REVIEW_DAILY_BUDGET_USD: "0.015" });
  assert.equal((await call(tight, "/prejudge", { question })).status, 200);
  const over = await call(tight, "/prejudge", { question }, { "cf-connecting-ip": "198.51.100.21" });
  assert.equal(over.status, 429, "the shared budget");
  assert.match(over.body.error, /used up for everyone/);
});

t("the writer's failures: an unusable or cut-off answer counts the use; a provider error gives it back; the budget keeps both", async () => {
  // An answer the parser refuses: the question can cause it, so the use counts (the fresh read's F1).
  let e = env({ ...ON, PREJUDGE_PER_DAY: "1" });
  const r = await call(e, "/prejudge", { question: `${question} BROKEN-WRITER` });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.match(r.body.error, /counts as one of today's free pre-judges/);
  assert.equal((await call(e, "/prejudge", { question })).status, 429, "the unusable one counted");
  // An answer cut off at the token limit counts too, and its record names the pre-judge, not a review (F9).
  e = env({ ...ON, PREJUDGE_PER_DAY: "1" });
  const cap = captureLogs();
  let cut;
  try {
    cut = await call(e, "/prejudge", { question }, { "x-test-fake-mix": "cut:1" });
  } finally {
    cap.restore();
  }
  assert.equal(cut.status, 502, JSON.stringify(cut.body));
  assert.equal((await call(e, "/prejudge", { question })).status, 429, "the cut-off one counted");
  const cutLines = cap.lines.filter((l) => l.includes("ran_out_of_tokens"));
  assert.ok(cutLines.length > 0 && cutLines.every((l) => l.includes('"where":"prejudge"')), cutLines.join("\n"));
  // A provider error (overloaded, every try): the question can't cause it, so the use comes back, and the budget too,
  // since nothing was written (fresh read N1).
  e = env({ ...ON, PREJUDGE_PER_DAY: "1", FREE_REVIEW_DAILY_BUDGET_USD: "0.01" });
  const down = await call(e, "/prejudge", { question }, { "x-test-fake-mix": "500:1" });
  assert.equal(down.status, 502, JSON.stringify(down.body));
  assert.match(down.body.error, /couldn't be reached.*wasn't used/s);
  assert.equal((await call(e, "/prejudge", { question }, { "cf-connecting-ip": "198.51.100.2" })).status, 200, "the budget came back: another address fits");
  // ... at most PREJUDGE_GIVEBACKS_PER_DAY times a day per address (default 2); after that a failure counts.
  e = env({ ...ON, PREJUDGE_PER_DAY: "1" });
  for (let i = 0; i < 2; i++) assert.match((await call(e, "/prejudge", { question }, { "x-test-fake-mix": "500:1" })).body.error, /wasn't used/);
  const third = await call(e, "/prejudge", { question }, { "x-test-fake-mix": "500:1" });
  assert.equal(third.status, 502);
  assert.match(third.body.error, /today's 2 failed pre-judges given back to your address are used, so this one counts/);
  assert.equal((await call(e, "/prejudge", { question })).status, 429, "the third failure counted");
  // The provider's answers come from stand-ins in this process (nothing leaves the machine).
  const orig = globalThis.fetch;
  const answer = (status: number, error: object) => (async () => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } })) as any;
  try {
    // A timeout: usually a slow provider, so the use comes back (within the cap); the budget keeps the try's cost.
    globalThis.fetch = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as any;
    e = env({ ...ON, PREJUDGE_PER_DAY: "1", FAKE_AI: "false", FREE_REVIEW_DAILY_BUDGET_USD: "0.01" });
    const slow = await call(e, "/prejudge", { question });
    assert.equal(slow.status, 502, JSON.stringify(slow.body));
    assert.match(slow.body.error, /took too long \(its AI provider was slow\).*wasn't used/s);
    globalThis.fetch = orig;
    e.FAKE_AI = "true";
    const other = await call(e, "/prejudge", { question }, { "cf-connecting-ip": "198.51.100.2" });
    assert.equal(other.status, 429, "the budget kept the timed-out try's cost");
    // A moderation refusal (OpenRouter's 403 for flagged input): the question causes it, so the use counts.
    globalThis.fetch = answer(403, { code: 403, message: "Your input was flagged by the moderation", metadata: { reasons: ["x"], flagged_input: "..." } });
    e = env({ ...ON, PREJUDGE_PER_DAY: "1", FAKE_AI: "false", PREJUDGE_WRITERS: "openai/gpt-6-luna" });
    const flagged = await call(e, "/prejudge", { question });
    assert.equal(flagged.status, 502, JSON.stringify(flagged.body));
    assert.match(flagged.body.error, /refused the request \(403\).*counts as one of today's free pre-judges/s);
    globalThis.fetch = orig;
    e.FAKE_AI = "true";
    assert.equal((await call(e, "/prejudge", { question })).status, 429, "the flagged one counted");
    // Our own account refused (a 403 worded as an account problem): the use and the budget come back.
    globalThis.fetch = answer(403, { code: 403, message: "This account has been suspended." });
    e = env({ ...ON, PREJUDGE_PER_DAY: "1", FAKE_AI: "false", PREJUDGE_WRITERS: "openai/gpt-6-luna" });
    const ours = await call(e, "/prejudge", { question });
    assert.equal(ours.status, 502, JSON.stringify(ours.body));
    assert.match(ours.body.error, /couldn't be reached.*wasn't used/s);
    globalThis.fetch = orig;
    e.FAKE_AI = "true";
    assert.equal((await call(e, "/prejudge", { question })).status, 200, "given back");
  } finally {
    globalThis.fetch = orig;
  }
});

t("a review that uses the brief: its receipt records the question's and the brief's hashes and the writer", async () => {
  const e = env(ON);
  const pj = (await call(e, "/prejudge", { question })).body;
  for (const path of ["/review", "/review-3", "/free/review"]) {
    const r = await call(e, path, { task: pj.brief.task, output, prejudge: pj.receipt });
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
    const brief = r.body.receipt.payload.brief;
    const { note, ...fields } = brief;
    assert.deepEqual(fields, { source: "prejudge", prejudge_id: pj.prejudge_id, question_sha256: pj.question_sha256, brief_sha256: pj.brief_sha256, writer: "claude-haiku-5-5" });
    assert.match(note, /doesn't check that the brief is faithful to the question/);
    assert.equal(r.body.receipt.payload.allowance_ref, undefined, "the allowance's reference stays out of the review's receipt");
    assert.ok(!r.body.receipt.payload.reviewers.models.includes("claude-haiku-5-5"));
    assert.ok(await verifyReceipt(r.body.receipt, keys.PUBLIC_KEY));
  }
  const plain = await call(e, "/review", { task: pj.brief.task, output });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.receipt.payload.brief, undefined, "no prejudge, no brief block");
  // A brief with criteria: its hash covers them, so the review must send them as the brief has them. (The fake
  // reviewers don't score criteria, so this stops at the payment challenge, after the brief's check.)
  const paid = env({ ...ON, PAYMENTS_ENABLED: "true" });
  const w = (await call(paid, "/prejudge", { question: `${question} WEIGHTED` })).body;
  assert.ok(w.brief.criteria?.length, "the fake writer added criteria");
  assert.equal(w.brief_sha256, await briefSha256(w.brief.task, w.brief.criteria));
  assert.equal((await call(paid, "/review", { task: w.brief.task, criteria: w.brief.criteria, output, prejudge: w.receipt })).status, 402);
  assert.equal((await call(paid, "/review", { task: w.brief.task, output, prejudge: w.receipt })).status, 400, "criteria left out: another brief");
});

t("a changed brief, an edited receipt or another key's receipt is refused before payment", async () => {
  const e = env({ ...ON, PAYMENTS_ENABLED: "true" });
  const pj = (await call(e, "/prejudge", { question })).body;
  const edited = await call(e, "/review", { task: pj.brief.task + " Also sort the list.", output, prejudge: pj.receipt });
  assert.equal(edited.status, 400, JSON.stringify(edited.body));
  assert.match(edited.body.error, /another brief.*Nothing was charged/s);
  const withCriteria = await call(e, "/review", { task: pj.brief.task, criteria: [{ name: "speed", weight: 1 }], output, prejudge: pj.receipt });
  assert.equal(withCriteria.status, 400);
  const forged = { ...pj.receipt, payload: { ...pj.receipt.payload, brief_sha256: await briefSha256(pj.brief.task + " Also sort the list.") } };
  const f = await call(e, "/review", { task: pj.brief.task + " Also sort the list.", output, prejudge: forged });
  assert.equal(f.status, 400);
  assert.match(f.body.error, /isn't signed by this service/);
  const theirs = await signWith(pj.receipt.payload, other);
  assert.equal((await call(e, "/review", { task: pj.brief.task, output, prejudge: theirs })).status, 400);
  const free = await call(e, "/free/review", { task: pj.brief.task + "!", output, prejudge: pj.receipt });
  assert.equal(free.status, 400);
  assert.match(free.body.error, /Your free review wasn't used/);
  const ok = await call(e, "/review", { task: pj.brief.task, output, prejudge: pj.receipt });
  assert.equal(ok.status, 402, "the brief as signed goes on to the normal payment challenge");
});

t("the writer can't review the brief it wrote", async () => {
  const e = env({ ...ON, PREJUDGE_WRITERS: "claude-sonnet-5-5" });
  const pj = (await call(e, "/prejudge", { question })).body;
  assert.equal(pj.writer, "claude-sonnet-5-5");
  const r = await call(e, "/review", { task: pj.brief.task, output, prejudge: pj.receipt });
  assert.equal(r.status, 400, "review's default reviewer is Sonnet");
  assert.match(r.body.error, /wrote this brief.*Nothing was charged/s);
  const other = await call(e, "/review", { task: pj.brief.task, output, prejudge: pj.receipt, panel: ["openai/gpt-6-luna"] });
  assert.equal(other.status, 200, JSON.stringify(other.body));
});

t("the earn-back: a review paid through the paywall gives the pre-judge back, once, never the budget; free, team and failed reviews give nothing, nor does /review with payments off", async () => {
  // Payments off (the harness's default): no one paid, so a /review gives nothing back (the fresh read's F3).
  let e = env({ ...ON, PREJUDGE_PER_DAY: "1" });
  let pj = (await call(e, "/prejudge", { question })).body;
  assert.equal((await call(e, "/prejudge", { question })).status, 429);
  assert.equal((await call(e, "/free/review", { task: pj.brief.task, output, prejudge: pj.receipt })).status, 200);
  assert.equal((await call(e, "/prejudge", { question })).status, 429, "a free review earns nothing back");
  assert.equal((await call(e, "/review", { task: pj.brief.task, output, prejudge: pj.receipt })).status, 200);
  await settleWait();
  assert.equal((await call(e, "/prejudge", { question })).status, 429, "payments off: nothing back");
  const f = fakeFacilitator();
  try {
    // Through the real paywall: given back once, to the address that asked for the brief.
    e = env({ ...ON, PREJUDGE_PER_DAY: "1", PAYMENTS_ENABLED: "true" });
    pj = (await call(e, "/prejudge", { question })).body;
    assert.equal((await call(e, "/prejudge", { question })).status, 429);
    const paid = await call(e, "/review", { task: pj.brief.task, output, prejudge: pj.receipt }, { "x-payment": payHeader(1) });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    await settleWait();
    assert.equal((await call(e, "/prejudge", { question })).status, 200, "given back by the paid review");
    assert.equal((await call(e, "/review", { task: pj.brief.task, output, prejudge: pj.receipt }, { "x-payment": payHeader(2) })).status, 200);
    await settleWait();
    assert.equal((await call(e, "/prejudge", { question })).status, 429, "once only: the same receipt gives nothing more back");
    // A paid review that fails gives nothing back (G3).
    e = env({ ...ON, PREJUDGE_PER_DAY: "1", PAYMENTS_ENABLED: "true" });
    pj = (await call(e, "/prejudge", { question })).body;
    const failed = await call(e, "/review", { task: pj.brief.task, output, prejudge: pj.receipt }, { "x-payment": payHeader(3), "x-test-fake-mix": "cut:1" });
    assert.equal(failed.status, 502, JSON.stringify(failed.body));
    await settleWait();
    assert.equal((await call(e, "/prejudge", { question })).status, 429, "a failed review gives nothing back");
    // Never the shared budget (G2): the caller's count comes back, the budget stays spent.
    e = env({ ...ON, PREJUDGE_PER_DAY: "1", PAYMENTS_ENABLED: "true", FREE_REVIEW_DAILY_BUDGET_USD: "0.02" });
    pj = (await call(e, "/prejudge", { question })).body;
    assert.equal((await call(e, "/prejudge", { question }, { "cf-connecting-ip": "198.51.100.2" })).status, 200, "the budget is now full");
    assert.equal((await call(e, "/review", { task: pj.brief.task, output, prejudge: pj.receipt }, { "x-payment": payHeader(4) })).status, 200);
    await settleWait();
    const full = await call(e, "/prejudge", { question });
    assert.equal(full.status, 429);
    assert.match(full.body.error, /used up for everyone/, "the caller's count came back, the budget didn't");
    // A team review gives nothing back (G1).
    e = env({ ...ON, PREJUDGE_PER_DAY: "1", PAYMENTS_ENABLED: "true", ...TEAM_ENV });
    pj = (await call(e, "/prejudge", { question })).body;
    assert.equal((await call(e, "/team/review", { task: pj.brief.task, output, prejudge: pj.receipt }, TEAM)).status, 200);
    await settleWait();
    assert.equal((await call(e, "/prejudge", { question })).status, 429, "a team review earns nothing back");
  } finally {
    f.restore();
  }
  // A payment that fails to settle: the customer pays nothing, and nothing comes back (fresh read of e5153fa, F3 b).
  const bad = fakeFacilitator("fail");
  try {
    const e = env({ ...ON, PREJUDGE_PER_DAY: "1", PAYMENTS_ENABLED: "true" });
    const pj = (await call(e, "/prejudge", { question })).body;
    const unpaid = await call(e, "/review", { task: pj.brief.task, output, prejudge: pj.receipt }, { "x-payment": payHeader(5) });
    assert.equal(unpaid.status, 402, JSON.stringify(unpaid.body));
    await settleWait();
    assert.equal((await call(e, "/prejudge", { question })).status, 429, "an unsettled payment gives nothing back");
  } finally {
    bad.restore();
  }
});

// ---------- after the free fresh read of b59cd88 (Nov 21): its guards G4 to G8 and its findings, as tests ----------

test("the writer's prompt states every limit the parser enforces, and the largest answer it accepts fits the writer's token budget", () => {
  const L = PREJUDGE_LIMITS;
  for (const n of [L.minTask, L.maxTask, L.maxItems, L.maxItemLen, L.maxCriteria, L.maxCriterionName]) assert.ok(PREJUDGE_SYSTEM.includes(String(n)), `the prompt names ${n}`);
  const largest = JSON.stringify({
    task: "x".repeat(L.maxTask),
    criteria: Array.from({ length: L.maxCriteria }, (_, i) => ({ name: String(i).padEnd(L.maxCriterionName, "n"), weight: 100 })),
    changes: Array(L.maxItems).fill("x".repeat(L.maxItemLen)),
    please_confirm: Array(L.maxItems).fill("y".repeat(L.maxItemLen)),
  });
  assert.doesNotThrow(() => parsePrejudge(largest), "the parser accepts the largest answer");
  assert.ok(largest.length / 4 < PREJUDGE_MAX_TOKENS * 0.9, `${largest.length} characters, about ${Math.ceil(largest.length / 4)} tokens, against ${PREJUDGE_MAX_TOKENS}`);
  assert.throws(() => parsePrejudge(JSON.stringify({ task: "x".repeat(20), changes: Array(L.maxItems + 1).fill("x") })), /changes/);
});

t("the brief's task is trimmed, so a client that trims it still matches", async () => {
  const e = env(ON);
  const pj = (await call(e, "/prejudge", { question: `${question}   \n` })).body;
  assert.equal(pj.brief.task, pj.brief.task.trim());
  assert.equal((await call(e, "/review", { task: pj.brief.task, output, prejudge: pj.receipt })).status, 200);
});

t("\"prejudge\": null, false, 0 or \"\" is no brief, as before the pre-judge", async () => {
  const e = env({ ...ON, FREE_REVIEWS_PER_DAY: "9" });
  for (const none of [null, false, 0, ""]) {
    const r = await call(e, "/review", { task: question, output, prejudge: none });
    assert.equal(r.status, 200, `/review with ${JSON.stringify(none)}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.receipt.payload.brief, undefined);
    assert.equal((await call(e, "/free/review", { task: question, output, prejudge: none })).status, 200, `/free/review with ${JSON.stringify(none)}`);
  }
});

t("a receipt signed for another network is refused before payment", async () => {
  const e = env(ON);
  const pj = (await call(e, "/prejudge", { question })).body;
  const elsewhere = await signWith({ ...pj.receipt.payload, network: "base" }, kp);
  const r = await call(e, "/review", { task: pj.brief.task, output, prejudge: elsewhere });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /another network \(base\).*Nothing was charged/s);
});

t("a free review keeps the writer off its panel too, and its free review isn't used (G4)", async () => {
  const e = env({ ...ON, PREJUDGE_WRITERS: "claude-sonnet-5-5", FREE_REVIEWS_PER_DAY: "1" });
  const pj = (await call(e, "/prejudge", { question })).body;
  const r = await call(e, "/free/review", { task: pj.brief.task, output, prejudge: pj.receipt });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /wrote this brief.*free review wasn't used/s);
  assert.equal((await call(e, "/free/review", { task: question, output })).status, 200, "the free review wasn't used");
});

t("the question never reaches the logs: a good, an unusable and a cut-off answer, and a provider error that quotes it (G6)", async () => {
  const MARK = "ZEBRA-MARKER-7731";
  const cap = captureLogs();
  const orig = globalThis.fetch;
  try {
    const e = env(ON);
    await call(e, "/prejudge", { question: `${question} ${MARK}` });
    await call(e, "/prejudge", { question: `${question} ${MARK} BROKEN-WRITER` });
    await call(e, "/prejudge", { question: `${question} ${MARK}` }, { "x-test-fake-mix": "cut:1" });
    // No fake AI: the provider's answer comes from this stand-in, in this process (nothing leaves the machine), an
    // error that quotes the prompt, as some providers' validation errors do.
    globalThis.fetch = (async (_u: any, init?: any) => {
      const sent = String(init?.body ?? "");
      const i = sent.indexOf(MARK);
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `Request rejected near: ${sent.slice(Math.max(0, i - 20), i + 30)}` } }), { status: 400, headers: { "content-type": "application/json" } });
    }) as any;
    const quoted = await call(env({ ...ON, FAKE_AI: "false" }), "/prejudge", { question: `${question} ${MARK}` });
    assert.equal(quoted.status, 502, JSON.stringify(quoted.body));
  } finally {
    globalThis.fetch = orig;
    cap.restore();
  }
  assert.ok(cap.lines.some((l) => l.includes("prejudge failed")), "the failures were logged");
  assert.deepEqual(cap.lines.filter((l) => l.includes(MARK)), [], "no log line holds the question");
});

t("a sanctioned location is refused before the writer, and the use isn't counted (G7)", async () => {
  const e = env({ ...ON, PREJUDGE_PER_DAY: "1" });
  const r = await call(e, "/prejudge", { question }, { "x-test-country": "IR" });
  assert.equal(r.status, 451, JSON.stringify(r.body));
  assert.equal((await call(e, "/prejudge", { question })).status, 200);
});

t("a writer whose provider key is missing: 503 before any call, and the use isn't counted (G8)", async () => {
  const e = env({ ...ON, PREJUDGE_PER_DAY: "1", ANTHROPIC_API_KEY: undefined });
  assert.equal((await call(e, "/prejudge", { question })).status, 503);
  e.ANTHROPIC_API_KEY = "fake";
  assert.equal((await call(e, "/prejudge", { question })).status, 200);
});

t("one address's unusable answers can't spend the shared free budget (the fresh read's F1)", async () => {
  // Room for one counted pre-judge ($0.01) and one free review ($0.05): six counted failures would leave none.
  const e = env({ ...ON, PREJUDGE_PER_DAY: "1", FREE_REVIEW_DAILY_BUDGET_USD: "0.06" });
  for (let i = 0; i < 6; i++) await call(e, "/prejudge", { question: `${question} BROKEN-WRITER` });
  assert.equal((await call(e, "/free/review", { task: question, output }, { "cf-connecting-ip": "198.51.100.2" })).status, 200, "another address still gets its free review");
});

t("a writer's cut-off reaches the ledger's cut-off records, labeled as the pre-judge's (fresh read of e5153fa, N2)", async () => {
  const ADMIN = "a".repeat(40); // a test fixture, as in routes.test.ts
  const e = env({ ...ON, ADMIN_TOKEN: ADMIN });
  assert.equal((await call(e, "/prejudge", { question }, { "x-test-fake-mix": "cut:1" })).status, 502);
  await settleWait();
  const stats = await call(e, "/admin/stats", undefined, { authorization: `Bearer ${ADMIN}` });
  assert.equal(stats.status, 200, JSON.stringify(stats.body));
  const recent = stats.body.ran_out_of_tokens_recent ?? [];
  assert.ok(recent.length > 0 && recent.every((x: any) => x.where === "prejudge" && x.model === "claude-haiku-5-5"), JSON.stringify(recent));
});

t("writers the service doesn't know are named in the logs (fresh read of e5153fa, N4)", async () => {
  const cap = captureLogs();
  let r;
  try {
    r = await call(env({ ...ON, PREJUDGE_WRITERS: "claude-haiku-5.5" }), "/prejudge", { question });
  } finally {
    cap.restore();
  }
  assert.equal(r.status, 503, "no known writer: off");
  assert.ok(cap.lines.some((l) => l.includes("doesn't know, left out: claude-haiku-5.5")), cap.lines.join("\n"));
});
