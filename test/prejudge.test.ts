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
  PREJUDGE_FORMAT_VERSION, PREJUDGE_LIMITS, PREJUDGE_MESSAGE_FORMAT, PREJUDGE_SYSTEM, briefSha256, checkPrejudge, chooseWriter, parsePrejudge, prejudgeConfig, validatePrejudge,
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
  assert.deepEqual(prejudgeConfig({ PREJUDGE_ENABLED: "true", PREJUDGE_WRITERS: " a, b ,a" }).writers, ["a", "b"]);
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

t("an unusable answer from the writer: 502, and the use is given back", async () => {
  const e = env({ ...ON, PREJUDGE_PER_DAY: "1" });
  const r = await call(e, "/prejudge", { question: `${question} BROKEN-WRITER` });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.match(r.body.error, /wasn't used/);
  assert.equal((await call(e, "/prejudge", { question })).status, 200);
});

t("a review that uses the brief: its receipt records the question's and the brief's hashes and the writer", async () => {
  const e = env(ON);
  const pj = (await call(e, "/prejudge", { question })).body;
  for (const path of ["/review", "/review-3", "/free/review"]) {
    const r = await call(e, path, { task: pj.brief.task, output, prejudge: pj.receipt });
    assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
    const brief = r.body.receipt.payload.brief;
    assert.deepEqual(brief, { source: "prejudge", prejudge_id: pj.prejudge_id, question_sha256: pj.question_sha256, brief_sha256: pj.brief_sha256, writer: "claude-haiku-5-5" });
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

t("a paid review that uses the brief gives the pre-judge back, once; a free review doesn't", async () => {
  const e = env({ ...ON, PREJUDGE_PER_DAY: "1" });
  const pj = (await call(e, "/prejudge", { question })).body;
  assert.equal((await call(e, "/prejudge", { question })).status, 429);
  assert.equal((await call(e, "/free/review", { task: pj.brief.task, output, prejudge: pj.receipt })).status, 200);
  assert.equal((await call(e, "/prejudge", { question })).status, 429, "a free review earns nothing back");
  assert.equal((await call(e, "/review", { task: pj.brief.task, output, prejudge: pj.receipt })).status, 200);
  const again = await call(e, "/prejudge", { question });
  assert.equal(again.status, 200, "given back by the paid review");
  assert.equal((await call(e, "/review", { task: pj.brief.task, output, prejudge: pj.receipt })).status, 200);
  assert.equal((await call(e, "/prejudge", { question })).status, 429, "once only: the same receipt gives nothing more back");
});
