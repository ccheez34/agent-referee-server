// Multi-part judge tiers (spec section 2): judge-3x2 and judge-3x3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchRoom, MAX_JUDGE_RUNS } from "../src/match.ts";
import { Health } from "../src/health.ts";
import { canonicalJson, randomToken, sha256Hex, validateCreate, isJudgeTier, isMultiJudgeTier } from "../src/logic.ts";
import { verifyReceipt } from "../src/receipt.ts";
import { runOneJudge, companyOf, PANEL_SIZE } from "../src/judge.ts";
import {
  MULTI_JUDGE_SYSTEM, MULTI_JUDGE_MESSAGE_FORMAT, MULTI_JUDGE_FORMAT_VERSION, MULTI_JUDGE_RECEIPT_FORMAT, MULTI_JUDGE_LIMITS, MULTI_JUDGE_LEASE_MS,
  MULTI_JUDGE_TIMEOUT_MS, MULTI_JUDGE_BUDGET_MS, MULTI_JUDGE_CALL_TIMEOUT_MS, MULTI_JUDGE_DEFAULT_PRICES,
  buildMultiJudgeMessage, multiJudgeCommitment, multiJudgeHow, multiJudgePromptSha, sidePieceRecords, sidePiecesSha256, validateMultiSubmit,
} from "../src/multijudge.ts";
import { multiMaxTokens, multiModels, MultiClosedError, MULTI_SYSTEM } from "../src/multipart.ts";

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };

const OPUS = "claude-opus-5-5", SONNET = "claude-sonnet-5-5", HAIKU = "claude-haiku-5-5", LUNA = "openai/gpt-6-luna", ARGON = "google/gemini-4-argon", FLASH = "google/gemini-3.7-flash", KIMI = "moonshotai/kimi-k3";
const RULES = "The side whose plan costs less wins; if equal, the faster one.";

const mem = () => {
  const d = new Map<string, unknown>();
  return {
    storage: {
      async get(k: string) { return structuredClone(d.get(k)); },
      async put(k: string, v: unknown) { d.set(k, structuredClone(v)); },
      async deleteAll() { d.clear(); },
      async setAlarm() {},
    },
  };
};
function ns<T extends { fetch(r: Request): Promise<Response> }>(make: () => T) {
  const objs = new Map<string, T>();
  return { idFromName: (n: string) => n, get: (id: string) => ({ fetch: (u: string, i?: RequestInit) => (objs.has(id) || objs.set(id, make()), objs.get(id)!.fetch(new Request(u, i))) }) };
}

function world(extra: Record<string, unknown> = {}) {
  const env: any = { ...keys, ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o", CLAUDE_JUDGES_ENABLED: "true", HEALTH: ns(() => new Health(mem() as any)), ...extra };
  const rooms = new Map<string, MatchRoom>();
  const roomFor = (id: string) => {
    if (!rooms.has(id)) rooms.set(id, new MatchRoom(mem() as any, env));
    return rooms.get(id)!;
  };
  const call = async (id: string, action: string, body?: unknown) => {
    const room = roomFor(id);
    room.m = undefined;
    const res = await room.fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as any };
  };
  return { env, call, roomFor };
}

type Sent = { url: string; model: string; system: string; user: string; max_tokens: number };
/** Fake Anthropic and OpenRouter APIs. answer(model) gives the winner, or "fail" for a 529. */
function fakeAi(answer: (model: string, n: number) => string | "fail" = () => "alpha") {
  const real = globalThis.fetch;
  const sent: Sent[] = [];
  const counts: Record<string, number> = {};
  globalThis.fetch = (async (url: any, init: any) => {
    const b = JSON.parse(init.body);
    const openrouter = String(url).includes("openrouter");
    const system = openrouter ? b.messages[0].content : b.system;
    const user = openrouter ? b.messages[1].content : b.messages[0].content;
    sent.push({ url: String(url), model: b.model, system, user, max_tokens: b.max_tokens });
    const n = (counts[b.model] = (counts[b.model] ?? 0) + 1);
    const w = answer(b.model, n);
    if (w === "fail") return new Response("overloaded", { status: 529 });
    const text = JSON.stringify({ winner: w, confidence: "high", rule_applied: "costs less wins", reasoning: "[side alpha, piece 1] is cheaper." });
    return new Response(JSON.stringify(openrouter ? { model: b.model, choices: [{ message: { content: text }, finish_reason: "stop" }] } : { model: b.model, content: [{ type: "text", text }], stop_reason: "end_turn" }));
  }) as any;
  return { sent, counts, restore: () => (globalThis.fetch = real) };
}

const PIECES_A = ["Plan A, part 1: $40 in all.", "Plan A, part 2: ships in 2 days.", "Plan A, part 3: no returns."];
const PIECES_B = ["Plan B, part 1: $35 in all.", "Plan B, part 2: ships in 5 days.", "Plan B, part 3: 30-day returns."];
const pieces = (texts: string[]) => texts.map((text) => ({ text }));

async function createMatch(w: ReturnType<typeof world>, tier: "judge-3x2" | "judge-3x3", extra: Record<string, unknown> = {}) {
  const id = randomToken(12);
  const created = await w.call(id, "create", { id, input: { tier, seats: ["alpha", "beta"], rules: RULES, ...extra } });
  return { id, created };
}
async function joined(w: ReturnType<typeof world>, tier: "judge-3x2" | "judge-3x3", extra: Record<string, unknown> = {}) {
  const { id, created } = await createMatch(w, tier, extra);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const t: Record<string, string> = {};
  for (const s of ["alpha", "beta"]) {
    const j = await w.call(id, "join", { seat: s, tier, role: "party", paid: true, payer: s === "alpha" ? "0x" + "a".repeat(40) : "0x" + "b".repeat(40), payment_hash: s + "-pay" });
    assert.equal(j.status, 200, JSON.stringify(j.body));
    t[s] = j.body.seat_token;
  }
  return { id, t, created: created.body };
}

// ---------- tiers and settings ----------

test("judge-3x2 / judge-3x3 are judge tiers with 3 judges and the majority rule; creation accepts panel and picks", () => {
  for (const t of ["judge-3x2", "judge-3x3"]) {
    assert.ok(isJudgeTier(t) && isMultiJudgeTier(t));
    assert.equal(PANEL_SIZE[t as "judge-3x2"], 3);
    for (const panel of ["rotate", [SONNET, LUNA, ARGON], [[SONNET, LUNA, ARGON], [SONNET, LUNA, FLASH]], { picks: { alpha: SONNET, beta: LUNA } }]) {
      const v = validateCreate({ tier: t, seats: ["alpha", "beta"], rules: RULES, panel });
      assert.ok(v.ok, JSON.stringify(v));
    }
    assert.ok(!validateCreate({ tier: t, seats: ["alpha", "beta"], rules: RULES, demo: true }).ok, "no demo for judge tiers");
    assert.ok(!validateCreate({ tier: t, seats: ["alpha", "beta"] }).ok, "rules are required");
  }
  assert.ok(!isMultiJudgeTier("judge-3"));
  assert.equal(MULTI_JUDGE_DEFAULT_PRICES["judge-3x2"], "$0.45");
  assert.equal(MULTI_JUDGE_DEFAULT_PRICES["judge-3x3"], "$0.60");
});

test("the panel is fixed at creation by the multi-part rules: eligible models from three companies, v5-multi, each judge's answer room", async () => {
  const w = world();
  const { created } = await createMatch(w, "judge-3x3");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const j = created.body.judge;
  assert.equal(j.format_version, MULTI_JUDGE_FORMAT_VERSION);
  assert.equal(j.prompt_sha256, await multiJudgePromptSha());
  assert.equal(j.decision_rule, "majority");
  const models = j.panel.map((p: any) => p.model);
  assert.equal(new Set(models.map(companyOf)).size, 3);
  assert.deepEqual(j.panel.map((p: any) => p.order), ["sorted", "reversed", "sorted"]);
  const { eligible } = multiModels({});
  assert.ok(models.every((m: string) => eligible.includes(m)));
  assert.deepEqual(j.max_tokens, Object.fromEntries(models.map((m: string) => [m, multiMaxTokens(m)])));
  // The joining agent sees it all before paying.
  const st = await w.call(created.body.match_id, "status");
  assert.deepEqual(st.body.judge, j);
});

/** Claude judges on: these tests are about the draw rules, which hold either way (judge-no-claude.test.ts covers "off"). */
const ON = { CLAUDE_JUDGES_ENABLED: "true" };

test("random panel draws never pick Haiku, Opus (left out by default) or opt-in models", async () => {
  for (let i = 0; i < 60; i++) {
    const c = await multiJudgeCommitment("judge-3x2", ON);
    for (const p of c.panel!) assert.ok(![HAIKU, OPUS, KIMI].includes(p.model), p.model);
    const picks = await multiJudgeCommitment("judge-3x3", ON, { picks: { alpha: SONNET, beta: ARGON } });
    const ms = picks.panel!.map((p) => p.model);
    assert.ok(ms.includes(SONNET) && ms.includes(ARGON) && ms.includes(LUNA), "the third is drawn from the company neither picked");
  }
});

test("refused at creation, before anyone pays: Haiku, opt-in, Opus while left out, two from one company; closed with a company missing (503)", async () => {
  const w = world();
  for (const panel of [[HAIKU, LUNA, ARGON], [KIMI, LUNA, ARGON], [OPUS, LUNA, ARGON], { picks: { alpha: HAIKU, beta: LUNA } }]) {
    const { created } = await createMatch(w, "judge-3x3", { panel });
    assert.equal(created.status, 400, JSON.stringify(panel));
    assert.match(created.body.error, /Not eligible for multi-part judge matches/);
  }
  const same = await createMatch(w, "judge-3x2", { panel: [SONNET, ARGON, FLASH] });
  assert.equal(same.created.status, 400);
  assert.match(same.created.body.error, /three different AI companies/);
  // Bringing Opus back (MULTI_PART_EXCLUDE="") makes it eligible here too.
  const back = await createMatch(world({ MULTI_PART_EXCLUDE: "" }), "judge-3x3", { panel: [OPUS, LUNA, ARGON] });
  assert.equal(back.created.status, 201);
  // Google with no eligible model closes the tiers.
  const closed = await createMatch(world({ MULTI_PART_EXCLUDE: `${OPUS},${ARGON},${FLASH}` }), "judge-3x2");
  assert.equal(closed.created.status, 503);
  assert.match(closed.created.body.error, /judge-3x2 is closed for now: it needs an eligible judge from each of three AI companies, and google has none/);
  await assert.rejects(multiJudgeCommitment("judge-3x2", { ...ON, MULTI_PART_EXCLUDE: `${OPUS},${ARGON},${FLASH}` }), MultiClosedError);
});

// ---------- submitting ----------

test("submit refusals change nothing and the seat can submit again: count, names, position, size; 6,000 CJK/emoji accepted", async () => {
  const w = world();
  const ai = fakeAi();
  try {
    const { id, t } = await joined(w, "judge-3x2");
    const sub = (body: Record<string, unknown>) => w.call(id, "submit", { seat: "alpha", seat_token: t.alpha, ...body });
    const refusals: [Record<string, unknown>, RegExp][] = [
      [{ pieces: pieces(PIECES_A) }, /exactly 2 items on judge-3x2 \(got 3\)/],
      [{ pieces: [{ text: "a" }] }, /exactly 2 items/],
      [{ pieces: [{ name: "Mine", text: "a" }, { text: "b" }] }, /has a name, which these tiers don't accept/],
      [{ pieces: [{ text: "a", extra: 1 }, { text: "b" }] }, /unknown field: extra/],
      [{ position: "one text" }, /takes your side as "pieces", not "position"/],
      [{ pieces: [{ text: "x".repeat(MULTI_JUDGE_LIMITS.maxPiece + 1) }, { text: "b" }] }, /1 to 6000 characters \(it has 6001\)/],
      [{ pieces: [{ text: "   " }, { text: "b" }] }, /can't be only spaces or line breaks/],
      [{ pieces: [{ text: "a" }, { text: "b" }], name: "Alpha Corp" }, /Unknown field: name/],
      [{ pieces: [{ text: 5 }, { text: "b" }] }, /1 to 6000/],
      [{ pieces: "ab" }, /exactly 2 items/],
    ];
    for (const [body, re] of refusals) {
      const r = await sub(body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.match(r.body.error, re);
      const st = await w.call(id, "status");
      assert.equal(st.body.phase, "submit");
      assert.deepEqual(st.body.waiting_on, ["alpha", "beta"], "nothing changed");
    }
    // 6,000 UTF-16 units of CJK and emoji (an emoji counts 2) is accepted.
    const big = "漢字😀".repeat(1500);
    assert.equal(big.length, 6000);
    const ok = await sub({ pieces: [{ text: big }, { text: "second" }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const again = await sub({ pieces: [{ text: "x" }, { text: "y" }] });
    assert.equal(again.status, 409);
    assert.equal(ai.sent.length, 0, "no AI until both sides are in");
  } finally {
    ai.restore();
  }
});

test("judge-3 refuses pieces, so an agent can't think it submitted pieces there", async () => {
  const w = world();
  const id = randomToken(12);
  await w.call(id, "create", { id, input: { tier: "judge-3", seats: ["alpha", "beta"], rules: RULES } });
  const tok = (await w.call(id, "join", { seat: "alpha", tier: "judge-3", role: "party", paid: true })).body.seat_token;
  await w.call(id, "join", { seat: "beta", tier: "judge-3", role: "party", paid: true });
  const r = await w.call(id, "submit", { seat: "alpha", seat_token: tok, pieces: pieces(PIECES_A) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /pieces are for judge-3x2 and judge-3x3/);
});

test("validateMultiSubmit never throws on a body that isn't an object", () => {
  for (const b of ["text", 5, true, null, [1, 2]]) assert.equal(validateMultiSubmit(b, "judge-3x2").ok, false);
});

test("validateMultiSubmit and the side records: index, sha256 (UTF-8), chars (UTF-16), no names", async () => {
  assert.deepEqual(validateMultiSubmit({ pieces: pieces(PIECES_A) }, "judge-3x3"), { ok: true, texts: PIECES_A });
  const r = await sidePieceRecords(["😀", "a\r\nb"]);
  assert.deepEqual(r, [
    { index: 1, sha256: await sha256Hex("😀"), chars: 2 },
    { index: 2, sha256: await sha256Hex("a\r\nb"), chars: 4 },
  ]);
  assert.equal(await sidePiecesSha256(r), await sha256Hex(canonicalJson(r)));
});

// ---------- judging and the receipt ----------

test("a full judge-3x3 match: v5-multi message with SIDE/PIECE boundaries and a token, reversed order for panelist 2, answer room, and a judge-multi-v1 receipt", async () => {
  const w = world();
  const ai = fakeAi(() => "beta");
  try {
    const { id, t, created } = await joined(w, "judge-3x3", { title: "Which plan", criteria: undefined });
    const a = await w.call(id, "submit", { seat: "alpha", seat_token: t.alpha, pieces: pieces(PIECES_A) });
    assert.equal(a.status, 200);
    const ackA = a.body.ack;
    const done = await w.call(id, "submit", { seat: "beta", seat_token: t.beta, pieces: pieces(PIECES_B) });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const ackB = done.body.ack;
    assert.equal(done.body.match.phase, "done", JSON.stringify(done.body.match.error));

    // What the judges were sent.
    assert.equal(ai.sent.length, 3);
    const panel = created.judge.panel;
    for (const s of ai.sent) {
      assert.equal(s.system, MULTI_JUDGE_SYSTEM);
      assert.equal(s.max_tokens, created.judge.max_tokens[s.model]);
      const token = /=====SIDE alpha ([0-9a-f]{16})=====/.exec(s.user)?.[1];
      assert.ok(token, "boundary token");
      const order = panel.find((p: any) => p.model === s.model).order;
      assert.equal(s.user, buildMultiJudgeMessage(RULES, { alpha: PIECES_A, beta: PIECES_B }, token!, "Which plan", undefined, order));
      assert.equal(s.user.includes(`=====PIECE 3 of 3 ${token}=====\n${PIECES_B[2]}\n=====END PIECE 3 ${token}=====`), true);
      assert.equal(s.user.indexOf("=====SIDE alpha") < s.user.indexOf("=====SIDE beta"), order === "sorted");
    }
    assert.equal(new Set(ai.sent.map((s) => /SIDE alpha ([0-9a-f]{16})/.exec(s.user)![1])).size, 3, "a new token for each judge");

    // The receipt.
    const r = done.body.match.receipt;
    assert.ok(await verifyReceipt(r, keys.PUBLIC_KEY));
    const p = r.payload;
    assert.equal(p.receipt_format, MULTI_JUDGE_RECEIPT_FORMAT);
    assert.equal(p.tier, "judge-3x3");
    assert.equal(p.outcome.winner, "beta");
    assert.equal(p.outcome.votes.length, 3);
    assert.equal(p.proof.submission_sha256, undefined);
    assert.equal(p.proof.position_sha256, undefined);
    for (const [seat, texts] of [["alpha", PIECES_A], ["beta", PIECES_B]] as const) {
      const recs = await sidePieceRecords([...texts]);
      assert.deepEqual(p.proof.pieces[seat], recs);
      assert.equal(p.proof.pieces_sha256[seat], await sidePiecesSha256(recs));
    }
    assert.equal(p.proof.rules_sha256, await sha256Hex(RULES));
    assert.deepEqual(p.proof.judge, created.judge);

    // Each ack signs the same pieces and pieces_sha256 as the receipt.
    for (const [ack, seat] of [[ackA, "alpha"], [ackB, "beta"]] as const) {
      assert.ok(await verifyReceipt(ack, keys.PUBLIC_KEY));
      assert.equal(ack.payload.step, "submit");
      assert.equal(ack.payload.receipt_format, MULTI_JUDGE_RECEIPT_FORMAT);
      assert.equal(ack.payload.position_sha256, undefined);
      assert.deepEqual(ack.payload.pieces, p.proof.pieces[seat]);
      assert.equal(ack.payload.pieces_sha256, p.proof.pieces_sha256[seat]);
    }
    // The pieces themselves are never shown.
    const st = JSON.stringify((await w.call(id, "status")).body);
    for (const x of [...PIECES_A, ...PIECES_B]) assert.ok(!st.includes(x));
  } finally {
    ai.restore();
  }
});

test("a forfeit receipt is judge-multi-v1 and shows the pieces of the side that submitted", async () => {
  const w = world();
  const ai = fakeAi();
  try {
    const { id, t } = await joined(w, "judge-3x2");
    const a = await w.call(id, "submit", { seat: "alpha", seat_token: t.alpha, pieces: pieces(PIECES_A.slice(0, 2)) });
    const room = w.roomFor(id);
    room.now = () => Date.now() + 11 * 60_000;
    const st = await w.call(id, "status");
    room.now = () => Date.now();
    assert.equal(st.body.phase, "done");
    const p = st.body.receipt.payload;
    assert.ok(await verifyReceipt(st.body.receipt, keys.PUBLIC_KEY));
    assert.equal(p.receipt_format, MULTI_JUDGE_RECEIPT_FORMAT);
    assert.deepEqual(p.outcome, { winner: "alpha", by_forfeit: true, forfeited: ["beta"] });
    assert.deepEqual(Object.keys(p.proof.pieces), ["alpha"]);
    assert.equal(p.proof.judge.format_version, MULTI_JUDGE_FORMAT_VERSION, "the forfeit receipt names the agreed judges too");
    assert.deepEqual(p.proof.pieces.alpha, a.body.ack.payload.pieces);
    assert.equal(p.proof.pieces_sha256.alpha, a.body.ack.payload.pieces_sha256);
    assert.equal(ai.sent.length, 0);
  } finally {
    ai.restore();
  }
});

test(`judging that keeps failing stops after ${MAX_JUDGE_RUNS} runs and lists the payers for a refund (option A)`, async () => {
  const w = world();
  const ai = fakeAi(() => "fail");
  try {
    const { id, t } = await joined(w, "judge-3x2");
    await w.call(id, "submit", { seat: "alpha", seat_token: t.alpha, pieces: pieces(PIECES_A.slice(0, 2)) });
    const done = await w.call(id, "submit", { seat: "beta", seat_token: t.beta, pieces: pieces(PIECES_B.slice(0, 2)) });
    assert.equal(done.body.match.error_code, "judge_failed");
    for (let i = 2; i <= MAX_JUDGE_RUNS; i++) await w.call(id, "retry-judge", { seat: "alpha", seat_token: t.alpha });
    const st = await w.call(id, "status");
    assert.equal(st.body.error_code, "unjudged");
    const list: any = await (await w.env.HEALTH.get("global").fetch("https://health/unjudged")).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].tier, "judge-3x2");
    assert.deepEqual(list[0].payers.map((p: any) => p.seat).sort(), ["alpha", "beta"]);
  } finally {
    ai.restore();
  }
});

test("a split vote keeps the majority rule; a retry keeps verdicts already given", async () => {
  const w = world();
  // The Google judge fails the first run (both tries), then answers.
  const ai = fakeAi((m, n) => (companyOf(m) === "google" ? (n <= 2 ? "fail" : "alpha") : companyOf(m) === "openai" ? "beta" : "alpha"));
  try {
    const { id, t } = await joined(w, "judge-3x2");
    await w.call(id, "submit", { seat: "alpha", seat_token: t.alpha, pieces: pieces(PIECES_A.slice(0, 2)) });
    const first = await w.call(id, "submit", { seat: "beta", seat_token: t.beta, pieces: pieces(PIECES_B.slice(0, 2)) });
    assert.equal(first.body.match.error_code, "judge_failed");
    const calledBefore = ai.sent.length;
    const r = await w.call(id, "retry-judge", { seat: "beta", seat_token: t.beta });
    assert.equal(r.body.match.phase, "done");
    assert.equal(ai.sent.length - calledBefore, 1, "only the missing judge reruns");
    assert.equal(r.body.match.result.winner, "alpha");
    assert.deepEqual(r.body.match.result.tally, { alpha: 2, beta: 1, mistrial: 0 });
  } finally {
    ai.restore();
  }
});

// ---------- timing (spec section 2) ----------

test("timing: 120 s calls capped at the time left less 5 s, a second try only with 60 s left, a 280 s lease, a 5-minute judging limit", async () => {
  assert.equal(MULTI_JUDGE_CALL_TIMEOUT_MS, 120_000);
  assert.equal(MULTI_JUDGE_LEASE_MS, 280_000);
  assert.equal(MULTI_JUDGE_TIMEOUT_MS, 300_000);
  assert.ok(MULTI_JUDGE_BUDGET_MS + 20_000 <= MULTI_JUDGE_TIMEOUT_MS, "gate wait plus the budget fit the judging limit");
  assert.ok(MULTI_JUDGE_BUDGET_MS <= MULTI_JUDGE_LEASE_MS, "both tries fit the lease");
  assert.ok(2 * MULTI_JUDGE_CALL_TIMEOUT_MS + 5_000 <= MULTI_JUDGE_BUDGET_MS, "two full calls and the wait fit the budget");

  // A first call that times out late leaves under 60 s: no second try.
  let clock = 0;
  const timeouts: number[] = [];
  const real = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  (AbortSignal as any).timeout = (ms: number) => (timeouts.push(ms), realTimeout.call(AbortSignal, 10));
  globalThis.fetch = (async (_u: any, init: any) => {
    clock += 200_000; // this call took 200 s
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  }) as any;
  try {
    const how = multiJudgeHow({ model: SONNET, maxTokens: 12_000, rules: RULES, pieces: { alpha: ["a", "b"], beta: ["c", "d"] }, order: "sorted", token: "0123456789abcdef" });
    await assert.rejects(runOneJudge({ keys: { ANTHROPIC_API_KEY: "a" }, model: SONNET, formatVersion: MULTI_JUDGE_FORMAT_VERSION, panelist: 1, order: "sorted", rules: RULES, submissions: { alpha: "x", beta: "y" }, how, now: () => clock, sleep: async () => {} }), /timed out/);
    assert.deepEqual(timeouts, [120_000], "one try only: 50 s were left");
    void MULTI_JUDGE_CALL_TIMEOUT_MS;
    // A first call that took 150 s leaves 100 s: the second try is capped at 95 s.
    timeouts.length = 0;
    clock = 0;
    globalThis.fetch = (async () => {
      clock += 150_000;
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as any;
    await assert.rejects(runOneJudge({ keys: { ANTHROPIC_API_KEY: "a" }, model: SONNET, formatVersion: MULTI_JUDGE_FORMAT_VERSION, panelist: 1, order: "sorted", rules: RULES, submissions: { alpha: "x", beta: "y" }, how, now: () => clock, sleep: async () => {} }));
    assert.deepEqual(timeouts, [120_000, MULTI_JUDGE_BUDGET_MS - 150_000 - 5_000], "second try capped at the time left less 5 s");
    // A provider error late in the budget: no retry wait, and no second try, when the second try couldn't start in time.
    timeouts.length = 0;
    clock = 0;
    const waits: number[] = [];
    globalThis.fetch = (async () => {
      clock += 189_000; // 61 s left: a retry wait of 1-5 s would leave under 60 s
      return new Response("overloaded", { status: 529 });
    }) as any;
    await assert.rejects(runOneJudge({ keys: { ANTHROPIC_API_KEY: "a" }, model: SONNET, formatVersion: MULTI_JUDGE_FORMAT_VERSION, panelist: 1, order: "sorted", rules: RULES, submissions: { alpha: "x", beta: "y" }, how, now: () => clock, sleep: async (ms) => void waits.push(ms) }), /529/);
    assert.deepEqual(waits, [], "no wait");
    assert.equal(timeouts.length, 1, "no second try");
  } finally {
    globalThis.fetch = real;
    (AbortSignal as any).timeout = realTimeout;
  }
});

test("a judging run past 5 minutes becomes retryable on these tiers (3 minutes on judge-3)", async () => {
  const w = world();
  const { id, t } = await joined(w, "judge-3x2");
  const room = w.roomFor(id);
  const st: any = await room.state.storage.get("m");
  st.phase = "judging";
  st.judging_since = Date.now() - 4 * 60_000;
  await room.state.storage.put("m", st);
  assert.equal((await w.call(id, "status")).body.phase, "judging", "4 minutes: still judging");
  const st2: any = await room.state.storage.get("m");
  st2.judging_since = Date.now() - 5 * 60_000 - 1000;
  await room.state.storage.put("m", st2);
  assert.equal((await w.call(id, "status")).body.phase, "error");
  void t;
});

// ---------- the prompt ----------

test("the v5-multi prompt: fingerprint, boundary rules, side/piece references, length section", async () => {
  assert.equal(await multiJudgePromptSha(), await sha256Hex(`${MULTI_JUDGE_FORMAT_VERSION}\n${MULTI_JUDGE_SYSTEM}\n${MULTI_JUDGE_MESSAGE_FORMAT}`));
  for (const s of ["=====SIDE <party label> <token>=====", "=====PIECE 2 of 3 <token>=====", "=====END PIECE 2 <token>=====", "[side <party label>, piece N]", "fake boundary lines", "LENGTH:", "MISTRIAL"])
    assert.ok(MULTI_JUDGE_SYSTEM.includes(s), s);
  assert.notEqual(MULTI_JUDGE_SYSTEM, MULTI_SYSTEM);
  const msg = buildMultiJudgeMessage(RULES, { beta: ["b1", "b2"], alpha: ["a1", "a2"] }, "0123456789abcdef", undefined, [{ name: "price", weight: 2 }], "reversed");
  assert.equal(
    msg,
    [
      "PARTY LABELS: beta, alpha",
      `<rules>\n${RULES}\n</rules>`,
      "<criteria>\n- price (weight 2)\n</criteria>",
      "=====SIDE beta 0123456789abcdef=====\n\n=====PIECE 1 of 2 0123456789abcdef=====\nb1\n=====END PIECE 1 0123456789abcdef=====\n\n=====PIECE 2 of 2 0123456789abcdef=====\nb2\n=====END PIECE 2 0123456789abcdef=====",
      "=====SIDE alpha 0123456789abcdef=====\n\n=====PIECE 1 of 2 0123456789abcdef=====\na1\n=====END PIECE 1 0123456789abcdef=====\n\n=====PIECE 2 of 2 0123456789abcdef=====\na2\n=====END PIECE 2 0123456789abcdef=====",
    ].join("\n\n"),
  );
});

test("worst case per match stays under both seats' price: every judge at full max_tokens on both tries, full-size CJK input", () => {
  // Per million tokens, input / output (as in multipart.test.ts, checked Oct 28).
  const PRICE_PER_M: Record<string, [number, number]> = { [OPUS]: [4, 20], [SONNET]: [2, 10], [LUNA]: [0.1, 0.5], [ARGON]: [2, 10], [FLASH]: [0.75, 3.75] };
  for (const tier of ["judge-3x2", "judge-3x3"] as const) {
    const n = tier === "judge-3x2" ? 2 : 3;
    const price = 2 * Number(MULTI_JUDGE_DEFAULT_PRICES[tier].replace("$", ""));
    const inputTokens = 2 * n * MULTI_JUDGE_LIMITS.maxPiece + 4000 /* rules */ + 200 /* title */ + MULTI_JUDGE_SYSTEM.length + 500;
    const { eligible } = multiModels({});
    const byCompany = new Map<string, string[]>();
    for (const x of eligible) byCompany.set(companyOf(x), [...(byCompany.get(companyOf(x)) ?? []), x]);
    let worst = 0;
    for (const ms of byCompany.values()) worst += Math.max(...ms.map((x) => (2 * (inputTokens * PRICE_PER_M[x][0] + multiMaxTokens(x) * PRICE_PER_M[x][1])) / 1e6));
    assert.ok(worst < price, `${tier}: worst case $${worst.toFixed(3)} is not under $${price}`);
  }
});

test("the installed JS client either refuses judge-multi-v1 receipts clearly (0.8.x, 0.9.x) or checks them (0.10.0+), and never passes a wrong one", async () => {
  // 0.8.0 refuses the unknown tier; 0.8.1 to 0.9.x refuse the unknown receipt_format ("update the client"); 0.10.0 and
  // later check judge-multi-v1. Whichever is installed, a receipt whose piece hashes were changed must never pass.
  const { verifyOutcome, verifySignature } = await import("agent-referee-client");
  const w = world();
  const ai = fakeAi();
  try {
    const { id, t } = await joined(w, "judge-3x3");
    await w.call(id, "submit", { seat: "alpha", seat_token: t.alpha, pieces: pieces(PIECES_A) });
    const done = await w.call(id, "submit", { seat: "beta", seat_token: t.beta, pieces: pieces(PIECES_B) });
    const receipt = done.body.match.receipt;
    assert.equal(await verifySignature(receipt, [keys.PUBLIC_KEY]), true, "the signature itself is fine");
    const r = await verifyOutcome(receipt);
    const refused = r.problems.some((x: string) => /Unknown tier "judge-3x3"|judge-multi-v1|[Uu]pdate the client/.test(x));
    assert.ok(r.ok || refused, `neither checked nor clearly refused: ${r.problems.join("; ")}`);
    const bad = JSON.parse(JSON.stringify(receipt));
    bad.payload.proof.pieces_sha256.alpha = "0".repeat(64);
    assert.equal((await verifyOutcome(bad)).ok, false, "a receipt with a changed piece hash must not pass");
    const swapped = JSON.parse(JSON.stringify(receipt));
    swapped.payload.proof.pieces.alpha[0].sha256 = "f".repeat(64);
    assert.equal((await verifyOutcome(swapped)).ok, false, "a receipt with a changed piece record must not pass");
  } finally {
    ai.restore();
  }
});

// ---------- the shared vectors (scripts/gen-multi-judge-vectors.mjs) ----------

/** A reference verifier written from the vectors' notes, independent of the server's code paths. */
async function referenceVerify(receipt: any, given: any, publicKey: string): Promise<string[]> {
  const problems: string[] = [];
  if (!(await verifyReceipt(receipt, publicKey))) return ["signature"];
  for (const ack of given.acks ?? []) if (!(await verifyReceipt(ack, publicKey))) problems.push("ack signature");
  const p = receipt.payload;
  if (p.receipt_format !== "judge-multi-v1") return ["unknown receipt_format"];
  const n = ({ "judge-3x2": 2, "judge-3x3": 3 } as Record<string, number>)[p.tier];
  if (!n) return ["tier isn't a multi-part judge tier"];
  const proof = p.proof;
  if (proof.judge?.format_version !== "agent-referee-judge-v5-multi") problems.push("format_version");
  if ("submission_sha256" in proof) problems.push("unexpected submission_sha256");
  for (const [side, recs] of Object.entries<any[]>(proof.pieces ?? {})) {
    if (recs.length !== n) problems.push(`${side} piece count`);
    if ((await sha256Hex(canonicalJson(recs))) !== proof.pieces_sha256?.[side]) problems.push(`${side} pieces_sha256`);
    if (recs.some((r) => "name" in r)) problems.push(`${side} has names`);
  }
  const out = p.outcome;
  if (out.by_forfeit) {
    const present = p.parties.filter((s: string) => !out.forfeited.includes(s));
    if (Object.keys(proof.pieces ?? {}).sort().join() !== present.sort().join()) problems.push("forfeit pieces");
  } else {
    if (Object.keys(proof.pieces ?? {}).length !== 2) problems.push("both sides' pieces");
    const votes = out.votes ?? [];
    if (votes.length !== 3) problems.push("expected 3 votes");
    if (new Set(proof.judge.panel.map((x: any) => companyOf(x.model))).size !== 3) problems.push("three companies");
    const tally: Record<string, number> = Object.fromEntries([...p.parties, "mistrial"].map((k: string) => [k, 0]));
    for (const v of votes) tally[v.winner ?? "mistrial"]++;
    const winner = p.parties.find((s: string) => tally[s] >= 2) ?? null;
    if ((out.winner ?? null) !== winner) problems.push("winner");
    if (JSON.stringify(out.tally) !== JSON.stringify(tally)) problems.push("tally");
  }
  for (const [side, texts] of Object.entries<string[]>(given.pieces ?? {})) {
    const recs = proof.pieces?.[side];
    if (!recs) continue;
    if (texts.length !== recs.length) { problems.push(`${side} count`); continue; }
    for (let i = 0; i < texts.length; i++) {
      if (recs[i].index !== i + 1 || recs[i].sha256 !== (await sha256Hex(texts[i]))) problems.push(`${side} piece ${i + 1} sha256`);
      if (recs[i].chars !== texts[i].length) problems.push(`${side} piece ${i + 1} chars`);
    }
  }
  for (const ack of given.acks ?? []) {
    const a = ack.payload;
    if (a.step !== "submit" || a.match_id !== p.match_id) continue;
    if ((out.forfeited ?? []).includes(a.seat)) problems.push(`${a.seat} forfeited after an accepted submit`);
    if (proof.pieces_sha256?.[a.seat] !== a.pieces_sha256 || JSON.stringify(proof.pieces?.[a.seat]) !== JSON.stringify(a.pieces)) problems.push(`${a.seat} ack contradicts receipt`);
  }
  return problems;
}

test("the shared judge-multi-v1 vectors: every case comes out as it says (valid ones pass, the rest fail)", async () => {
  const { readFile } = await import("node:fs/promises");
  const v = JSON.parse(await readFile(new URL("./fixtures/multi-judge-vectors.json", import.meta.url), "utf8"));
  assert.equal(v.receipt_format, "judge-multi-v1");
  assert.ok(v.cases.length >= 20);
  for (const c of v.cases) {
    const problems = await referenceVerify(c.receipt, c.given, v.public_key);
    assert.equal(problems.length === 0, c.expect.ok, `${c.id}: ${problems.join("; ") || "no problems"}`);
  }
  for (const b of v.building_blocks) {
    assert.deepEqual(b.records, await sidePieceRecords(b.texts));
    assert.equal(b.pieces_sha256, await sha256Hex(b.canonical));
  }
});

test("each judge call's model, try, time, outcome and tokens are kept for the operator only: never in the status or the receipt", async () => {
  const w = world();
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const b = JSON.parse(init.body);
    const openrouter = String(url).includes("openrouter");
    const text = JSON.stringify({ winner: "alpha", confidence: "high", rule_applied: "r", reasoning: "x" });
    return new Response(JSON.stringify(openrouter
      ? { model: b.model, choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 9000, completion_tokens: 700, completion_tokens_details: { reasoning_tokens: 300 } } }
      : { model: b.model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 9500, output_tokens: 1200 } }));
  }) as any;
  try {
    const { id, t } = await joined(w, "judge-3x2");
    await w.call(id, "submit", { seat: "alpha", seat_token: t.alpha, pieces: pieces(PIECES_A.slice(0, 2)) });
    const done = await w.call(id, "submit", { seat: "beta", seat_token: t.beta, pieces: pieces(PIECES_B.slice(0, 2)) });
    assert.equal(done.body.match.phase, "done");
    const op = await w.call(id, "operator-status");
    const calls = op.body.operator.judge_calls;
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.equal(c.outcome, "answered");
      assert.equal(c.try_number, 1);
      assert.equal(c.run, 1);
      assert.ok(typeof c.ms === "number" && c.panelist >= 1);
      if (c.model.includes("/")) assert.deepEqual([c.input_tokens, c.output_tokens, c.reasoning_tokens], [9000, 700, 300]);
      else assert.deepEqual([c.input_tokens, c.output_tokens], [9500, 1200]);
    }
    const pub = JSON.stringify((await w.call(id, "status")).body);
    assert.ok(!pub.includes("judge_calls") && !pub.includes("9500"), "not in the public status or the receipt");
  } finally {
    globalThis.fetch = real;
  }
});

test("judge-3 keeps no call record (only the multi-part tiers do)", async () => {
  const w = world();
  const ai = fakeAi();
  try {
    const id = randomToken(12);
    await w.call(id, "create", { id, input: { tier: "judge-3", seats: ["alpha", "beta"], rules: RULES } });
    const tok: Record<string, string> = {};
    for (const s of ["alpha", "beta"]) tok[s] = (await w.call(id, "join", { seat: s, tier: "judge-3", role: "party", paid: true })).body.seat_token;
    await w.call(id, "submit", { seat: "alpha", seat_token: tok.alpha, position: "Plan A" });
    await w.call(id, "submit", { seat: "beta", seat_token: tok.beta, position: "Plan B" });
    assert.deepEqual((await w.call(id, "operator-status")).body.operator.judge_calls, []);
  } finally {
    ai.restore();
  }
});
