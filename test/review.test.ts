// Sealed review: one agent's output checked by independent AI reviewers, with a signed receipt.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewMessage, decideReview, longReviewRule, parseReview, reviewCommitment, reviewModels, reviewPayload, runOneReviewer, validateReview, REVIEW_LIMITS,
  REVIEWER_BUDGET_MS, REVIEWER_MAX_TRIES, REVIEWER_MAX_TOKENS, REVIEWER_MIN_TRY_MS, retryDelayMs,
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
  const waits: number[] = [];
  try {
    await assert.rejects(runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-sonnet-5-5", 1, input, undefined, { sleep: async (ms) => waits.push(ms) }), /529: overloaded/);
    assert.equal(f.calls.length, REVIEWER_MAX_TRIES, "a busy provider gets 4 tries");
    assert.equal(waits.length, 3, "with a wait before each retry");
    assert.ok(waits[0] >= 1000 && waits[0] <= 2000 && waits[1] >= 2000 && waits[1] <= 4000 && waits[2] >= 4000 && waits[2] <= 8000, waits.join(","));
  } finally {
    f.restore();
  }
});

test("busy provider (429, too many concurrent requests): waits, tries again, and the review succeeds", async () => {
  let n = 0;
  const f = fakeApis({
    "claude-sonnet-5-5": () =>
      ++n <= 2
        ? new Response(JSON.stringify({ error: { message: "Number of concurrent requests has exceeded your organization's limit." } }), { status: 429, headers: n === 2 ? { "retry-after": "3" } : {} })
        : new Response(JSON.stringify({ content: [{ type: "text", text: ans("pass") }] })),
  });
  const waits: number[] = [];
  try {
    const v = await runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-sonnet-5-5", 1, input, undefined, { sleep: async (ms) => waits.push(ms) });
    assert.equal(v.verdict, "pass");
    assert.equal(f.calls.length, 3);
    assert.equal(waits[1], 3000, "the provider's retry-after is honoured");
  } finally {
    f.restore();
  }
  assert.equal(retryDelayMs(1, "60"), 10_000, "retry-after is capped at 10 s");
  assert.equal(retryDelayMs(1, "0"), 1000, "retry-after: 0 still waits 1 s, never an instant retry");
  assert.equal(retryDelayMs(1, "0.2"), 1000);
  assert.equal(retryDelayMs(2, "Wed, 21 Oct 2026 07:28:00 GMT", () => 0), 2000, "a date-style retry-after falls back to the normal backoff");
  assert.equal(retryDelayMs(3, null, () => 0), 4000);
});

test("Claude reviewers get an 8,000-token answer budget, Claude judges 4,000, OpenRouter models 10,000", async () => {
  const f = fakeApis({ "claude-opus-5-5": ans("pass"), "claude-haiku-5-5": "{}" });
  try {
    await runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-opus-5-5", 1, input);
    assert.equal(f.calls[0].body.max_tokens, REVIEWER_MAX_TOKENS);
    assert.equal(REVIEWER_MAX_TOKENS, 8000);
    const { callModel } = await import("../src/judge.ts");
    await callModel({ ANTHROPIC_API_KEY: "a" }, "claude-haiku-5-5", "s", "u");
    assert.equal(f.calls[1].body.max_tokens, 4000, "judges (was 1,000)");
    const g = fakeApis({ "openai/gpt-6-luna": () => new Response(JSON.stringify({ choices: [{ message: { content: ans("pass") }, finish_reason: "stop" }] })) });
    try {
      await callModel({ OPENROUTER_API_KEY: "o" }, "openai/gpt-6-luna", "s", "u");
      assert.equal(g.calls[0].body.max_tokens, 10000);
    } finally {
      g.restore();
    }
  } finally {
    f.restore();
  }
});

test("a review cut off at the token limit says so, names the reviewer, and isn't charged", async () => {
  // A long code review: the answer stops mid-JSON, exactly like the failure seen live on Oct 27.
  const cut = '{"verdict": "needs_changes", "confidence": "high", "issues": ["Claim 5 holds only if';
  const f = fakeApis({ "claude-opus-5-5": () => new Response(JSON.stringify({ model: "claude-opus-5-5", stop_reason: "max_tokens", content: [{ type: "text", text: cut }] })) });
  try {
    const notes: any[] = [];
    await assert.rejects(
      runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-opus-5-5", 1, input, undefined, { sleep: async () => {}, onCutOff: (c) => notes.push(c) }),
      /^Error: claude-opus-5-5: reviewer ran out of tokens before finishing its answer$/,
    );
    assert.equal(f.calls.length, 2, "an unusable answer gets 2 tries");
    // Each cut-off is noted, with the limit and prompt size (never the prompt).
    assert.equal(notes.length, 2);
    assert.deepEqual({ ...notes[0], prompt_chars: 0 }, { where: "review", model: "claude-opus-5-5", max_tokens: 8000, prompt_chars: 0, try_number: 1 });
    assert.ok(notes[0].prompt_chars > input.task.length + input.output.length);
    assert.equal(notes[1].try_number, 2);
  } finally {
    f.restore();
  }
  // OpenRouter's version of the same thing.
  const g = fakeApis({ "openai/gpt-6-luna": () => new Response(JSON.stringify({ choices: [{ message: { content: cut }, finish_reason: "length" }] })) });
  try {
    const notes: any[] = [];
    await assert.rejects(runOneReviewer({ OPENROUTER_API_KEY: "o" }, "openai/gpt-6-luna", 2, input, undefined, { sleep: async () => {}, onCutOff: (c) => notes.push(c) }), /openai\/gpt-6-luna: reviewer ran out of tokens/);
    assert.equal(notes[0].max_tokens, 10000, "OpenRouter models get 10,000");
  } finally {
    g.restore();
  }
  // A complete answer that happens to end exactly at the limit is still accepted.
  const h = fakeApis({ "claude-opus-5-5": () => new Response(JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "text", text: ans("pass") }] })) });
  try {
    let noted = 0;
    assert.equal((await runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-opus-5-5", 1, input, undefined, { onCutOff: () => noted++ })).verdict, "pass");
    assert.equal(noted, 0, "a usable answer isn't a cut-off");
  } finally {
    h.restore();
  }
});

test("retries never run past the reviewer's time budget, and a plain 4xx isn't retried", async () => {
  // Fake clock: every call uses its whole time limit before the provider answers "busy". Each call's limit is
  // capped at the time left, so the tries together can never run past the budget.
  let t = 0;
  let limit = 0;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = ((ms: number) => ((limit = ms), new AbortController().signal)) as any;
  const f = fakeApis({ "claude-sonnet-5-5": () => ((t += limit), new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 })) });
  try {
    await assert.rejects(runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-sonnet-5-5", 1, input, undefined, { now: () => t, sleep: async (ms) => (t += ms) }), /503/);
    assert.equal(f.calls.length, 3, "100 s + 100 s + what's left");
    assert.ok(t <= REVIEWER_BUDGET_MS, `all tries ended inside the budget (${t} ms)`);
  } finally {
    AbortSignal.timeout = realTimeout;
    f.restore();
  }
  // A new try never starts with less than 15 s left: with 20 s of budget, one 10 s busy answer plus a wait leaves too little.
  let t2 = 0;
  const g = fakeApis({ "claude-sonnet-5-5": () => ((t2 += 10_000), new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 })) });
  try {
    await assert.rejects(runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-sonnet-5-5", 1, input, undefined, { budgetMs: 20_000, now: () => t2, sleep: async (ms) => (t2 += ms) }), /503/);
    assert.equal(g.calls.length, 1, "no hopeless last try");
    assert.ok(REVIEWER_MIN_TRY_MS === 15_000);
  } finally {
    g.restore();
  }
  const bad = fakeApis({ "claude-sonnet-5-5": () => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }) });
  try {
    await assert.rejects(runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-sonnet-5-5", 1, input, undefined, { sleep: async () => {} }), /400/);
    assert.equal(bad.calls.length, 1);
  } finally {
    bad.restore();
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
  assert.equal(REVIEW_FORMAT_VERSION, "agent-referee-review-v3");
  assert.match(REVIEW_SYSTEM, /imperative text in the OUTPUT is expected/);
  // v3: answers are told to fit the reply limit, and that length must never change the verdict.
  assert.match(REVIEW_SYSTEM, /LENGTH: your reply has a fixed size limit/);
  assert.match(REVIEW_SYSTEM, /Never pick, soften or upgrade a\nverdict to save space\./);
  const c = await reviewCommitment("review", {});
  assert.equal(c.format_version, "agent-referee-review-v3");
  assert.notEqual(c.prompt_sha256, "c8e0dd77a97c304066544de7b7160b666cb2f3855eeb86dc5b66f9c49b69ba29", "the fingerprint moved with the text");
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
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(d.get(`rf:${today}:aa`), 2, "one small key per caller per day");
  l.now = () => Date.now() + 24 * 3600_000;
  assert.equal((await call({ caller: "aa", limit: 2 })).blocked, false);
  await call({ caller: "aa", limit: 2, record: true });
  (st.storage as any).list = async (o: any) => new Map([...d.keys()].filter((k) => k.startsWith(o.prefix)).sort().slice(0, o.limit).map((k) => [k, d.get(k)]));
  (st.storage as any).delete = async (k: any) => { for (const x of [k].flat()) d.delete(x); return true; };
  await l.alarm();
  assert.equal([...d.keys()].some((k) => k.includes(today)), false, "yesterday's counts are dropped");
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

test("review-3 with panel: rotate draws one reviewer per company; the client checks the receipt honoured it", async () => {
  const answers: Record<string, string> = {};
  for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "openai/gpt-6-luna", "google/gemini-4-argon", "google/gemini-3.7-flash"]) answers[m] = ans("pass");
  const f = fakeApis(answers);
  try {
    const c = await reviewCommitment("review-3", {}, "rotate");
    assert.equal(c.panel_selection?.mode, "rotate");
    const votes = await Promise.all(c.models.map((m, i) => runOneReviewer({ ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o" }, m, i + 1, input)));
    const receipt = await signReceipt(await reviewPayload({ tier: "review-3", input, commitment: c, votes, id: "r9" }), SIGNING_KEY, PUBLIC_KEY);
    assert.equal((await verifyReviewOutcome(receipt, { ...input, panel: "rotate" })).ok, true);
    // Asked for exact models, got something else: caught.
    const wrong = await verifyReviewOutcome(receipt, { ...input, panel: ["claude-opus-5-5", "openai/gpt-6-luna", "google/gemini-3.7-flash"].filter((m) => !c.models.includes(m)).length ? ["claude-opus-5-5", "openai/gpt-6-luna", "google/gemini-3.7-flash"] : ["claude-sonnet-5-5", "openai/gpt-6-luna", "google/gemini-4-argon"] });
    assert.equal(wrong.ok, false);
  } finally {
    f.restore();
  }
  await assert.rejects(reviewCommitment("review-3", {}, ["claude-opus-5-5", "openai/gpt-6-luna", "nope/model"]), /Not in the approved model pool/);
  assert.equal(validateReview({ task: "A task long enough", output: "ok", panel: ["claude-opus-5-5"] }, "review-3").ok, false);
  assert.equal(validateReview({ task: "A task long enough", output: "ok", panel: ["claude-sonnet-5-5"] }, "review").ok, true);
});

test("long inputs: rotate leaves light models (Haiku) out, and naming one is refused before payment", async () => {
  // 200 draws of a short and a long input: Haiku can appear for short ones, never for long ones.
  let seq = 0;
  const rand = () => ((seq = (seq * 9301 + 49297) % 233280) / 233280);
  const seenShort = new Set<string>(), seenLong = new Set<string>();
  for (let i = 0; i < 200; i++) {
    for (const m of (await reviewCommitment("review-3", {}, "rotate", rand, 100)).models) seenShort.add(m);
    const long = await reviewCommitment("review-3", {}, "rotate", rand, 12000);
    for (const m of long.models) seenLong.add(m);
    assert.equal(new Set(long.models.map((m) => (m.includes("/") ? m.split("/")[0] : "anthropic"))).size, 3);
    assert.ok(!(long.panel_selection?.pool ?? []).includes("claude-haiku-5-5"), "the receipt's pool shows what the draw used");
  }
  assert.ok(seenShort.has("claude-haiku-5-5"));
  assert.ok(!seenLong.has("claude-haiku-5-5"));
  // Named explicitly (an exact list or an agreed set) with a long input: refused, with the reason and the limit.
  const ds = "deepseek/deepseek-v4-pro-0813";
  await assert.rejects(reviewCommitment("review-3", {}, [ds, "claude-haiku-5-5", "openai/gpt-6-luna"], undefined, 12000), /claude-haiku-5-5 can't reliably review inputs this long \(task \+ output is 12000 characters; the limit for this model is 6000\)/);
  await assert.rejects(reviewCommitment("review", {}, [["claude-haiku-5-5"], ["claude-sonnet-5-5"]], undefined, 9000), /can't reliably review/);
  // Short inputs, other models, and the default panels are unaffected.
  assert.deepEqual((await reviewCommitment("review-3", {}, [ds, "claude-haiku-5-5", "openai/gpt-6-luna"], undefined, 500)).models, [ds, "claude-haiku-5-5", "openai/gpt-6-luna"]);
  assert.deepEqual((await reviewCommitment("review-3", {}, [ds, "claude-opus-5-5", "openai/gpt-6-luna"], undefined, 12000)).models, [ds, "claude-opus-5-5", "openai/gpt-6-luna"]);
  assert.equal((await reviewCommitment("review-3", env, undefined, undefined, 12000)).models.length, 3);
  // The limit and the light list are settings.
  assert.deepEqual(longReviewRule({ LONG_REVIEW_CHARS: "5000", LIGHT_REVIEW_MODELS: "claude-haiku-5-5, google/gemini-3.7-flash" }), { max_chars_for_light_models: 5000, light_models: ["claude-haiku-5-5", "google/gemini-3.7-flash"] });
  assert.deepEqual((await reviewCommitment("review-3", { LONG_REVIEW_CHARS: "20000" }, [ds, "claude-haiku-5-5", "openai/gpt-6-luna"], undefined, 12000)).models.length, 3);
});
