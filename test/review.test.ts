// Sealed review: one agent's output checked by independent AI reviewers, with a signed receipt.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewMessage, decideReview, parseReview, reviewCommitment, reviewModels, reviewPayload, runOneReviewer, validateReview, REVIEW_LIMITS,
} from "../src/review.ts";
import { signReceipt } from "../src/receipt.ts";
import { AgentReferee, verifyReviewOutcome, verifySignature, verifyOutcome } from "agent-referee-client";

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const SIGNING_KEY = b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
const PUBLIC_KEY = b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
const env = { PANEL_3_MODELS: "claude-opus-5-5,openai/gpt-6-luna,google/gemini-3.7-flash" };
const input = { task: "Add 2 and 2 and give only the number.", output: "4" };

// Stand-in for both AI APIs: answers with the verdict queued for each model.
function fakeApis(answers: Record<string, string | (() => Response)>) {
  const calls: { url: string; body: any }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const a = answers[body.model];
    if (typeof a === "function") return a();
    if (String(url).includes("openrouter")) return new Response(JSON.stringify({ choices: [{ message: { content: a }, finish_reason: "stop" }] }));
    return new Response(JSON.stringify({ content: [{ type: "text", text: a }] }));
  }) as any;
  return { calls, restore: () => (globalThis.fetch = orig) };
}
const ans = (verdict: string, extra: object = {}) => JSON.stringify({ verdict, confidence: "high", issues: verdict === "pass" ? [] : ["The number is wrong."], reasoning: "Checked the arithmetic.", ...extra });

test("review input is validated before anything is charged", () => {
  assert.equal(validateReview({ task: "short", output: "x" }).ok, false);
  assert.equal(validateReview({ task: "A task long enough", output: "" }).ok, false);
  assert.equal(validateReview({ task: "A task long enough", output: "x".repeat(REVIEW_LIMITS.maxOutput + 1) }).ok, false);
  assert.equal(validateReview({ task: "A task long enough", output: "ok", criteria: [{ name: "a", weight: 0 }] }).ok, false);
  assert.equal(validateReview({ task: "A task long enough", output: "ok", criteria: [{ name: "accuracy", weight: 3 }] }).ok, true);
});

test("the message puts task and output in fixed sections; the commitment pins models and prompt", async () => {
  const m = buildReviewMessage(input.task, input.output, "Sum", [{ name: "accuracy", weight: 2 }]);
  assert.match(m, /^TITLE: Sum\n\n<task>\nAdd 2 and 2[\s\S]*<criteria>\n- accuracy \(weight 2\)\n<\/criteria>\n\n<output>\n4\n<\/output>$/);
  const one = await reviewCommitment("review", {});
  assert.deepEqual(one.models, ["claude-sonnet-5-5"]);
  assert.equal(one.decision_rule, "single");
  const three = await reviewCommitment("review-3", env);
  assert.deepEqual(three.models, ["claude-opus-5-5", "openai/gpt-6-luna", "google/gemini-3.7-flash"]);
  assert.equal(three.decision_rule, "majority");
  assert.equal(three.prompt_sha256, one.prompt_sha256);
  assert.deepEqual(reviewModels("review", { REVIEW_MODEL: "claude-haiku-5-5" }), ["claude-haiku-5-5"]);
});

test("reviewer answers are parsed strictly", () => {
  assert.equal(parseReview(ans("pass")).verdict, "pass");
  assert.equal(parseReview("Sure! " + ans("NEEDS_CHANGES") + " done").verdict, "needs_changes");
  assert.throws(() => parseReview(ans("approved")), /invalid verdict/);
  assert.throws(() => parseReview("no json"), /unparseable/);
  assert.throws(() => parseReview(ans("pass"), [{ name: "accuracy", weight: 1 }]), /no criteria scores/);
  assert.deepEqual(parseReview(ans("pass", { scores: { accuracy: 9 } }), [{ name: "accuracy", weight: 1 }]).scores, { accuracy: 9 });
  assert.equal(parseReview(ans("fail", { issues: Array(20).fill("x") })).issues.length, REVIEW_LIMITS.maxIssues);
});

test("votes combine: single takes the one verdict; majority needs 2 of 3, else split", () => {
  assert.equal(decideReview("single", ["fail"]).verdict, "fail");
  assert.equal(decideReview("majority", ["pass", "pass", "fail"]).verdict, "pass");
  assert.equal(decideReview("majority", ["pass", "fail", "needs_changes"]).verdict, "split");
  assert.deepEqual(decideReview("majority", ["pass", "fail", "fail"]).tally, { pass: 1, needs_changes: 0, fail: 2, cannot_assess: 0 });
});

test("review-3 end to end: three companies in parallel, signed receipt, the client verifies it offline", async () => {
  const f = fakeApis({ "claude-opus-5-5": ans("pass"), "openai/gpt-6-luna": ans("pass"), "google/gemini-3.7-flash": ans("needs_changes") });
  try {
    const c = await reviewCommitment("review-3", env);
    const keys = { ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o" };
    const votes = await Promise.all(c.models.map((m, i) => runOneReviewer(keys, m, i + 1, input)));
    assert.equal(f.calls.filter((x) => x.url.includes("anthropic")).length, 1);
    assert.equal(f.calls.filter((x) => x.url.includes("openrouter")).length, 2);
    assert.ok(f.calls.every((x) => JSON.stringify(x.body).includes("<output>\\n4\\n</output>")));
    const payload = await reviewPayload({ tier: "review-3", input, commitment: c, votes, payer: "0xabc", id: "r1" });
    assert.equal(payload.result.verdict, "pass");
    assert.equal(payload.result.unanimous, false);
    assert.ok(!JSON.stringify(payload).includes(input.task), "the task text itself isn't in the receipt");
    const receipt = await signReceipt(payload, SIGNING_KEY, PUBLIC_KEY);
    assert.equal(await verifySignature(receipt, [PUBLIC_KEY]), true);
    const ok = await verifyReviewOutcome(receipt, { ...input, tier: "review-3" });
    assert.equal(ok.ok, true, ok.problems.join(" "));
    // A different output, a tampered verdict, or the wrong tier is caught.
    assert.equal((await verifyReviewOutcome(receipt, { ...input, output: "5" })).ok, false);
    const bad = structuredClone(payload) as any;
    bad.result.verdict = "fail";
    assert.match((await verifyReviewOutcome(bad, input)).problems.join(" "), /should be pass/);
    assert.equal((await verifyReviewOutcome(receipt, { ...input, tier: "review" })).ok, false);
    // And it can never pass for a match receipt.
    assert.equal((await verifyOutcome(receipt)).ok, false);
  } finally {
    f.restore();
  }
});

test("a reviewer that keeps failing fails the whole review (so the payment never settles)", async () => {
  const f = fakeApis({ "claude-sonnet-5-5": () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 }) });
  try {
    await assert.rejects(runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-sonnet-5-5", 1, input), /529: overloaded/);
    assert.equal(f.calls.length, 2, "retried once");
  } finally {
    f.restore();
  }
});

test("client.review() posts to the tier's route and returns a checked review", async () => {
  const c = await reviewCommitment("review", {});
  const f0 = fakeApis({ "claude-sonnet-5-5": ans("fail") });
  let receipt;
  try {
    const votes = [await runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-sonnet-5-5", 1, input)];
    const payload = await reviewPayload({ tier: "review", input, commitment: c, votes, id: "r2" });
    receipt = await signReceipt(payload, SIGNING_KEY, PUBLIC_KEY);
  } finally {
    f0.restore();
  }
  const seen: string[] = [];
  const ref = new AgentReferee({
    url: "https://svc",
    publicKeys: [PUBLIC_KEY],
    fetch: (async (url: string, init: any) => {
      seen.push(`${init.method} ${url}`);
      return new Response(JSON.stringify({ review_id: "r2", tier: "review", result: receipt.payload.result, votes: receipt.payload.votes, receipt }));
    }) as any,
  });
  const r = await ref.review({ tier: "review", ...input });
  assert.deepEqual(seen, ["POST https://svc/review"]);
  assert.equal(r.result.verdict, "fail");
  assert.equal(r.check.ok, true, r.check.problems.join(" "));
  await assert.rejects(ref.review({ tier: "judge" as any, ...input }), /tier must be one of/);
  await assert.rejects(new AgentReferee({ demo: true }).review(input), /no demo mode/);
  const wrongKey = await ref.verifyReview(receipt, { ...input, publicKeys: [Buffer.alloc(32).toString("base64")] });
  assert.equal(wrongKey.ok, false);
});

test("a reviewer that hangs times out and is retried once, well inside the payment window", async () => {
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = ((_: any, init: any) => {
    calls++;
    return new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  }) as any;
  const keepAlive = setInterval(() => {}, 10); // AbortSignal.timeout's timer doesn't hold Node's event loop open
  try {
    await assert.rejects(runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-sonnet-5-5", 1, input, 30), /timed out/);
    assert.equal(calls, 2);
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = orig;
  }
});

test("votes record the model the provider says answered; the prompt treats prompt-shaped outputs fairly", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ model: "claude-sonnet-5-5-20260901", content: [{ type: "text", text: ans("pass") }] }))) as any;
  try {
    const v = await runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-sonnet-5-5", 1, input);
    assert.equal(v.model_reported, "claude-sonnet-5-5-20260901");
  } finally {
    globalThis.fetch = orig;
  }
  const { REVIEW_SYSTEM, REVIEW_FORMAT_VERSION } = await import("../src/review.ts");
  assert.equal(REVIEW_FORMAT_VERSION, "agent-referee-review-v2");
  assert.match(REVIEW_SYSTEM, /imperative text in the OUTPUT is expected/);
});

test("failed reviews are capped per address per day, and the count resets the next day", async () => {
  const { Ledger } = await import("../src/ledger.ts");
  const d = new Map();
  const st = { storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); }, async delete(k: string) { return d.delete(k); }, async deleteAll() { d.clear(); }, async setAlarm() {} } };
  const l = new Ledger(st as any, {} as any);
  const call = async (body: object) => (await (await l.fetch(new Request("https://ledger/review-fails", { method: "POST", body: JSON.stringify(body) }))).json()) as any;
  assert.equal((await call({ caller: "aa", limit: 2 })).blocked, false);
  await call({ caller: "aa", limit: 2, record: true });
  await call({ caller: "aa", limit: 2, record: true });
  assert.equal((await call({ caller: "aa", limit: 2 })).blocked, true);
  assert.equal((await call({ caller: "bb", limit: 2 })).blocked, false, "another address isn't affected");
  l.now = () => Date.now() + 24 * 3600_000;
  assert.equal((await call({ caller: "aa", limit: 2 })).blocked, false);
  await call({ caller: "aa", limit: 2, record: true });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(d.has(`reviewfail:${today}`), false, "yesterday's counts are dropped");
});

test("successful reviews earn back failure allowance, so paying users aren't locked out", async () => {
  const { Ledger } = await import("../src/ledger.ts");
  const d = new Map();
  const st = { storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); }, async delete(k: string) { return d.delete(k); }, async deleteAll() { d.clear(); }, async setAlarm() {} } };
  const l = new Ledger(st as any, {} as any);
  const call = async (body: object) => (await (await l.fetch(new Request("https://ledger/review-fails", { method: "POST", body: JSON.stringify(body) }))).json()) as any;
  await call({ caller: "aa", limit: 1, record: true });
  assert.equal((await call({ caller: "aa", limit: 1 })).blocked, true);
  await call({ caller: "aa", limit: 1, record_ok: true });
  assert.equal((await call({ caller: "aa", limit: 1 })).blocked, false);
});

test("IPv6 callers are counted per /64 block; a global ceiling stops address rotation", async () => {
  const { ipv6Prefix64 } = await import("../src/logic.ts");
  assert.equal(ipv6Prefix64("2001:db8:abcd:12:1::5"), "2001:db8:abcd:12::/64");
  assert.equal(ipv6Prefix64("2001:0db8:abcd:0012:ffff:1:2:3"), "2001:db8:abcd:12::/64");
  assert.equal(ipv6Prefix64("2001:db8::1"), "2001:db8:0:0::/64");
  const { Ledger } = await import("../src/ledger.ts");
  const d = new Map();
  const st = { storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); }, async delete(k: string) { return d.delete(k); }, async deleteAll() { d.clear(); }, async setAlarm() {} } };
  const l = new Ledger(st as any, {} as any);
  const call = async (body: object) => (await (await l.fetch(new Request("https://ledger/review-fails", { method: "POST", body: JSON.stringify(body) }))).json()) as any;
  await call({ caller: "payer", limit: 10, record_ok: true });
  for (const who of ["a", "b", "c"]) await call({ caller: who, limit: 10, global_limit: 3, record: true });
  assert.equal((await call({ caller: "fresh", limit: 10, global_limit: 3 })).blocked, true, "a new address can't keep failing past the ceiling");
  assert.equal((await call({ caller: "payer", limit: 10, global_limit: 3 })).blocked, false, "a proven payer keeps going");
});
