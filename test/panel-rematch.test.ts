// Judge panels (judge-2, judge-3), mistrial, confidence, weighted criteria, and rematch series.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchRoom } from "../src/match.ts";
import { commitmentOf, randomToken, canonicalJson, sha256Hex, validateCreate, specFingerprint } from "../src/logic.ts";
import { verifyReceipt } from "../src/receipt.ts";
import { decide, votePick, criteriaTotals, JUDGE_SYSTEM_V2, JUDGE_FORMAT_VERSION_V2 } from "../src/judge.ts";

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };

/** Several match rooms that can reach each other (like the MATCHES namespace), for rematches. */
function world(extraEnv: Record<string, unknown> = {}) {
  const rooms = new Map<string, MatchRoom>();
  const env: any = { ...keys, ANTHROPIC_API_KEY: "test", ...extraEnv };
  const roomFor = (name: string) => {
    if (!rooms.has(name)) {
      const data = new Map<string, unknown>();
      const state = {
        storage: {
          async get(k: string) { return data.has(k) ? structuredClone(data.get(k)) : undefined; },
          async put(k: string, v: unknown) { data.set(k, structuredClone(v)); },
          async deleteAll() { data.clear(); },
          async setAlarm() {},
        },
      };
      rooms.set(name, new MatchRoom(state as any, env));
    }
    return rooms.get(name)!;
  };
  env.MATCHES = { idFromName: (n: string) => n, get: (id: string) => ({ fetch: (u: string, i?: any) => roomFor(id).fetch(new Request(u, i)) }) };
  const call = async (id: string, action: string, body?: unknown) => {
    const room = roomFor(id);
    room.m = undefined; // fresh object each call, like a real DO waking from storage
    const res = await room.fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as any };
  };
  return { env, call, roomFor };
}

type Reply = { winner: string; confidence?: string; mistrial_reason?: string; mistrial_code?: string; scores?: any; reasoning?: string; rule_applied?: string } | "fail" | "credit";
/** Fake Anthropic API: each model answers per `replies`; records what each model was sent. */
function fakeJudges(replies: Record<string, Reply | Reply[]>) {
  const realFetch = globalThis.fetch;
  const sent: { model: string; system: string; user: string }[] = [];
  const counts: Record<string, number> = {};
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({ model: body.model, system: body.system, user: body.messages[0].content });
    const n = (counts[body.model] = (counts[body.model] ?? 0) + 1);
    const r = replies[body.model];
    const reply = Array.isArray(r) ? r[Math.min(n - 1, r.length - 1)] : r;
    if (!reply || reply === "fail") return new Response("overloaded", { status: 529 });
    if (reply === "credit")
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }), { status: 400 });
    const text = JSON.stringify({ rule_applied: "cheaper wins", reasoning: "Because of the rules.", confidence: "high", ...reply });
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }));
  }) as any;
  return { sent, counts, restore: () => (globalThis.fetch = realFetch) };
}

const H = "claude-haiku-5-5", S = "claude-sonnet-5-5", O = "claude-opus-5-5";

async function judgeMatch(w: ReturnType<typeof world>, input: any) {
  const id = randomToken(12);
  const created = await w.call(id, "create", { id, input });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const t: Record<string, string> = {};
  for (const s of input.seats) t[s] = (await w.call(id, "join", { seat: s, tier: input.tier, role: "party", paid: true })).body.seat_token;
  await w.call(id, "submit", { seat: input.seats[0], seat_token: t[input.seats[0]], position: "Plan A: $40, ships in 2 days" });
  const done = await w.call(id, "submit", { seat: input.seats[1], seat_token: t[input.seats[1]], position: "Plan B: $35, ships in 5 days" });
  return { id, t, created: created.body, done: done.body };
}

test("pure rules: unanimous, majority, mistrial, criteria totals", () => {
  const P = ["alpha", "beta"];
  assert.deepEqual(decide("unanimous", ["alpha", "alpha"], P).winner, "alpha");
  assert.equal(decide("unanimous", ["alpha", "beta"], P).winner, null);
  assert.equal(decide("unanimous", ["alpha", null], P).winner, null);
  assert.equal(decide("majority", ["beta", "alpha", "beta"], P).winner, "beta");
  assert.equal(decide("majority", ["beta", "alpha", null], P).winner, null);
  assert.equal(decide("majority", [null, null, "alpha"], P).winner, null);
  assert.equal(decide("single", [null], P).winner, null);
  const crit = [{ name: "price", weight: 3 }, { name: "speed", weight: 1 }];
  assert.deepEqual(criteriaTotals({ alpha: { price: 5, speed: 10 }, beta: { price: 8, speed: 2 } }, crit), { alpha: 25, beta: 26 });
  // with criteria, the scores decide even if the judge's "winner" field says otherwise
  assert.equal(votePick({ winner: "alpha", scores: { alpha: { price: 5, speed: 10 }, beta: { price: 8, speed: 2 } } }, crit), "beta");
  assert.equal(votePick({ winner: "alpha", scores: { alpha: { price: 5, speed: 5 }, beta: { price: 5, speed: 5 } } }, crit), null, "tied totals = mistrial vote");
});

test("validation: criteria, panels and demo", () => {
  const ok = (x: any) => validateCreate(x).ok;
  assert.equal(ok({ tier: "judge-2", seats: ["a", "b"], rules: "Cheaper plan wins." }), true);
  assert.equal(ok({ tier: "judge-3", seats: ["a", "b"], rules: "Cheaper plan wins.", criteria: [{ name: "price", weight: 3 }] }), true);
  assert.equal(ok({ tier: "judge-3", seats: ["a", "b", "c"], rules: "Cheaper plan wins." }), false, "panels are 2 seats");
  assert.equal(ok({ tier: "judge-2", seats: ["a", "b"] }), false, "rules required");
  assert.equal(ok({ tier: "judge-2", seats: ["a", "b"], rules: "Cheaper plan wins.", demo: true }), false, "no free AI calls");
  assert.equal(ok({ tier: "weighted", seats: ["a", "b"], weights: { a: 1, b: 1 }, criteria: [{ name: "x", weight: 1 }] }), false);
  for (const bad of [[], [{ name: "x", weight: 0 }], [{ name: "x", weight: 1.5 }], [{ name: "", weight: 1 }], [{ name: "x", weight: 1 }, { name: "x", weight: 2 }], Array(9).fill(0).map((_, i) => ({ name: `c${i}`, weight: 1 }))])
    assert.equal(ok({ tier: "judge", seats: ["a", "b"], rules: "Cheaper plan wins.", criteria: bad }), false, JSON.stringify(bad));
  // criteria are part of the agreed settings: a different criteria list is a different match
  const a = { tier: "judge", seats: ["a", "b"], rules: "Cheaper plan wins.", criteria: [{ name: "price", weight: 3 }] };
  assert.notEqual(specFingerprint(a), specFingerprint({ ...a, criteria: [{ name: "price", weight: 2 }] }));
});

test("judge-2: two different models judge independently; agreement wins, signed with every vote", async () => {
  const f = fakeJudges({ [H]: { winner: "beta" }, [S]: { winner: "beta", confidence: "medium" } });
  try {
    const w = world();
    const { created, done } = await judgeMatch(w, { tier: "judge-2", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." });
    // committed before payment: both models, each panelist's party order, and the rule
    assert.deepEqual(created.judge.panel, [{ model: H, order: "sorted" }, { model: S, order: "reversed" }]);
    assert.equal(created.judge.decision_rule, "unanimous");
    const m = done.match;
    assert.equal(m.phase, "done");
    assert.equal(m.result.winner, "beta");
    assert.equal(m.result.mistrial, undefined);
    assert.deepEqual(m.result.tally, { alpha: 0, beta: 2, mistrial: 0 });
    assert.deepEqual(m.result.votes.map((v: any) => [v.panelist, v.model, v.winner, v.confidence]), [[1, H, "beta", "high"], [2, S, "beta", "medium"]]);
    assert.deepEqual(m.receipt.payload.proof.judge, created.judge);
    assert.equal(await verifyReceipt(m.receipt, keys.PUBLIC_KEY), true);
    // independence: each judge got only the case, never another verdict; panelist 2 saw the parties reversed
    assert.equal(f.sent.length, 2);
    const [h, s] = [f.sent.find((x) => x.model === H)!, f.sent.find((x) => x.model === S)!];
    assert.ok(h.user.indexOf('party="alpha"') < h.user.indexOf('party="beta"'));
    assert.ok(s.user.indexOf('party="beta"') < s.user.indexOf('party="alpha"'));
    assert.ok(s.user.includes("PARTY LABELS: beta, alpha"));
    for (const x of f.sent) assert.equal(/winner/i.test(x.user), false, "no verdicts leak into a judge's input");
  } finally {
    f.restore();
  }
});

test("judge-2: a split panel is a mistrial sent back to the owners", async () => {
  const f = fakeJudges({ [H]: { winner: "alpha" }, [S]: { winner: "beta" } });
  try {
    const { done } = await judgeMatch(world(), { tier: "judge-2", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." });
    const r = done.match.result;
    assert.equal(r.winner, null);
    assert.equal(r.mistrial, true);
    assert.equal(r.escalate_to_owners, true);
    assert.match(r.mistrial_reason, /disagreed/);
    assert.equal(r.mistrial_code, "panel_disagreement");
    assert.equal(done.match.receipt.payload.outcome.mistrial, true);
  } finally {
    f.restore();
  }
});

test("judge-3: majority wins and the dissent stays in the receipt; no majority is a mistrial", async () => {
  let f = fakeJudges({ [H]: { winner: "alpha" }, [S]: { winner: "beta" }, [O]: { winner: "beta", confidence: "low" } });
  try {
    const { created, done } = await judgeMatch(world(), { tier: "judge-3", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." });
    assert.deepEqual(created.judge.panel.map((p: any) => p.order), ["sorted", "reversed", "sorted"]);
    assert.equal(done.match.result.winner, "beta");
    assert.equal(done.match.result.decision_rule, "majority");
    assert.deepEqual(done.match.result.tally, { alpha: 1, beta: 2, mistrial: 0 });
    assert.equal(done.match.result.votes[0].winner, "alpha", "dissent kept");
  } finally {
    f.restore();
  }
  f = fakeJudges({ [H]: { winner: "alpha" }, [S]: { winner: "MISTRIAL", mistrial_reason: "They answer different questions." }, [O]: { winner: "beta" } });
  try {
    const { done } = await judgeMatch(world(), { tier: "judge-3", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." });
    assert.equal(done.match.result.winner, null);
    assert.equal(done.match.result.mistrial, true);
    assert.equal(done.match.result.votes[1].mistrial_reason, "They answer different questions.");
    assert.equal(done.match.result.votes[1].mistrial_code, "other", "no code given by the judge = other");
    assert.equal(done.match.result.mistrial_code, "no_majority");
  } finally {
    f.restore();
  }
});

test("single judge: mistrial and confidence; v3 prompt; records count a mistrial as completed, not a loss", async () => {
  const f = fakeJudges({ [H]: { winner: "MISTRIAL", mistrial_code: "missing_information", mistrial_reason: "Neither plan gives a price.", confidence: "high" } });
  try {
    const { done } = await judgeMatch(world(), { tier: "judge", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." });
    const r = done.match.result;
    assert.equal(r.winner, null);
    assert.equal(r.mistrial, true);
    assert.equal(r.mistrial_reason, "Neither plan gives a price.");
    assert.equal(r.mistrial_code, "missing_information");
    assert.equal(done.match.receipt.payload.outcome.mistrial_code, "missing_information", "the code is in the signed receipt");
    assert.equal(r.confidence, "high");
    assert.ok(f.sent[0].system.includes("MISTRIAL"));
    // records: a mistrial is "completed" for both wallets, never a win or a loss
    const room: any = new MatchRoom({ storage: {} } as any, {} as any);
    room.m = { tier: "judge", parties: ["alpha", "beta"], joined: { alpha: { paid_by: "0x1" }, beta: { paid_by: "0x2" } } };
    assert.deepEqual(room.outcomeUpdates(r).map((u: any) => u.outcome), ["completed", "completed"]);
    room.m.tier = "judge-3";
    assert.deepEqual(room.outcomeUpdates({ winner: "beta" }).map((u: any) => [u.kind, u.outcome]), [["judge", "loss"], ["judge", "win"]]);
  } finally {
    f.restore();
  }
});

test("criteria: the winner is computed from the judges' scores and the agreed weights", async () => {
  const criteria = [{ name: "price", weight: 3 }, { name: "speed", weight: 1 }];
  // The model's own "winner" says alpha, but its scores favor beta: the agreed weights decide.
  const f = fakeJudges({ [H]: { winner: "alpha", scores: { alpha: { price: 5, speed: 10 }, beta: { price: 8, speed: 2 } } } });
  try {
    const { done } = await judgeMatch(world(), { tier: "judge", seats: ["alpha", "beta"], rules: "Best value for the buyer.", criteria });
    const r = done.match.result;
    assert.equal(r.winner, "beta");
    assert.deepEqual(r.totals, { alpha: 25, beta: 26 });
    assert.deepEqual(r.criteria, criteria);
    assert.equal(done.match.receipt.payload.proof.criteria_sha256, await sha256Hex(canonicalJson(criteria)));
    assert.ok(f.sent[0].user.includes("- price (weight 3)\n- speed (weight 1)"));
  } finally {
    f.restore();
  }
  // missing or out-of-range scores are rejected (retried, then an error the parties can retry)
  const g = fakeJudges({ [H]: { winner: "alpha", scores: { alpha: { price: 11, speed: 1 }, beta: { price: 1, speed: 1 } } } });
  try {
    const { done } = await judgeMatch(world(), { tier: "judge", seats: ["alpha", "beta"], rules: "Best value for the buyer.", criteria });
    assert.equal(done.match.phase, "error");
    assert.match(done.match.error, /invalid score/);
  } finally {
    g.restore();
  }
});

test("panel retry reruns only the judge that failed; verdicts already given are never re-rolled", async () => {
  const f = fakeJudges({ [H]: { winner: "beta" }, [S]: ["fail", "fail", { winner: "beta" }] });
  try {
    const w = world();
    const { id, t, done } = await judgeMatch(w, { tier: "judge-2", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." });
    assert.equal(done.match.phase, "error");
    assert.match(done.match.error, /1 of 2 judges failed/);
    const retried = await w.call(id, "retry-judge", { seat: "alpha", seat_token: t.alpha });
    assert.equal(retried.body.match.phase, "done");
    assert.equal(retried.body.match.result.winner, "beta");
    assert.equal(f.counts[H], 1, "haiku's verdict was kept, not asked again");
    assert.equal(f.counts[S], 3);
  } finally {
    f.restore();
  }
});

test("a judge API error shows the provider's reason, isn't retried pointlessly, and the client's submit retries judging for you", async () => {
  const f = fakeJudges({ [H]: "credit" });
  try {
    const w = world();
    const { id, t, done } = await judgeMatch(w, { tier: "judge", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." });
    assert.equal(done.match.phase, "error");
    assert.match(done.match.error, /400: Your credit balance is too low/);
    assert.equal(f.counts[H], 1, "a 400 isn't retried immediately; it won't fix itself");
    // the provider is fixed (credits added): retry-judge finishes the match
    f.restore();
    const g = fakeJudges({ [H]: { winner: "beta" } });
    try {
      const retried = await w.call(id, "retry-judge", { seat: "alpha", seat_token: t.alpha });
      assert.equal(retried.body.match.phase, "done");
      assert.equal(retried.body.match.result.winner, "beta");
    } finally {
      g.restore();
    }
  } finally {
    f.restore();
  }
});

test("a judge match created before v3 keeps running the exact v2 prompt it locked in", async () => {
  const f = fakeJudges({ [H]: { winner: "alpha" } });
  try {
    const w = world();
    const id = randomToken(12);
    await w.call(id, "create", { id, input: { tier: "judge", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." } });
    // simulate a match created by the previous server version
    const room = w.roomFor(id);
    const st: any = await room.state.storage.get("m");
    st.judge = { ...st.judge, format_version: JUDGE_FORMAT_VERSION_V2, prompt_sha256: await sha256Hex(`${JUDGE_FORMAT_VERSION_V2}\nold`) };
    await room.state.storage.put("m", st);
    const t: Record<string, string> = {};
    for (const s of ["alpha", "beta"]) t[s] = (await w.call(id, "join", { seat: s, tier: "judge", role: "party", paid: true })).body.seat_token;
    await w.call(id, "submit", { seat: "alpha", seat_token: t.alpha, position: "A" });
    const done = await w.call(id, "submit", { seat: "beta", seat_token: t.beta, position: "B" });
    assert.equal(done.body.match.result.winner, "alpha");
    assert.equal(f.sent[0].system, JUDGE_SYSTEM_V2);
  } finally {
    f.restore();
  }
});

// ---------- rematch ----------

async function playWeighted(w: ReturnType<typeof world>, id: string, payers?: Record<string, string>) {
  const t: Record<string, string> = {};
  for (const s of ["alpha", "beta"]) {
    const j = await w.call(id, "join", { seat: s, tier: "weighted", role: "party", paid: true, payer: payers?.[s], payments_enabled: true });
    assert.equal(j.status, 200, JSON.stringify(j.body));
    t[s] = j.body.seat_token;
  }
  const v: Record<string, [string, string]> = { alpha: [randomToken(16), randomToken(16)], beta: [randomToken(16), randomToken(16)] };
  for (const s of ["alpha", "beta"]) await w.call(id, "commit", { seat: s, seat_token: t[s], commitment: await commitmentOf(v[s][0], v[s][1]) });
  let last: any;
  for (const s of ["alpha", "beta"]) last = await w.call(id, "reveal", { seat: s, seat_token: t[s], value: v[s][0], nonce: v[s][1] });
  assert.equal(last.body.match.phase, "done");
  return { t, match: last.body.match };
}

test("rematch: both must ask; the next game is linked, wallet-locked, and carries a running signed tally", async () => {
  const w = world();
  const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40);
  const id = randomToken(12);
  await w.call(id, "create", { id, input: { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 }, title: "who drafts" } });
  // not before the result
  const early = await w.call(id, "rematch", { seat: "alpha", seat_token: "x" });
  assert.equal(early.status, 403);
  const g1 = await playWeighted(w, id, { alpha: A, beta: B });
  assert.equal(g1.match.rematch.available, true);
  assert.deepEqual(g1.match.tally.games, 1);

  const one = await w.call(id, "rematch", { seat: "alpha", seat_token: g1.t.alpha });
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.rematch.waiting_on, ["beta"]);
  assert.equal(one.body.rematch.next_match_id, undefined);
  assert.equal(one.body.ack.payload.step, "rematch");
  assert.equal((await w.call(id, "rematch", { seat: "alpha", seat_token: "wrong" })).status, 403);
  const both = await w.call(id, "rematch", { seat: "beta", seat_token: g1.t.beta });
  const next = both.body.rematch.next_match_id;
  assert.match(next, /^[0-9a-f]{24}$/);
  // asking again is harmless and returns the same game
  assert.equal((await w.call(id, "rematch", { seat: "alpha", seat_token: g1.t.alpha })).body.rematch.next_match_id, next);

  const st2 = (await w.call(next, "status")).body;
  assert.equal(st2.phase, "joining");
  assert.equal(st2.title, "who drafts");
  assert.deepEqual(st2.weights, { alpha: 1, beta: 1 });
  assert.deepEqual(st2.seat_wallets, { alpha: A, beta: B }, "locked to the wallets that paid game 1");
  assert.equal(st2.series.game, 2);
  assert.equal(st2.series.series_id, id);
  // a stranger's wallet can't take a seat in the rematch
  const stolen = await w.call(next, "join", { seat: "alpha", tier: "weighted", role: "party", paid: true, payer: "0x" + "c".repeat(40), payments_enabled: true });
  assert.equal(stolen.status, 403);

  const g2 = await playWeighted(w, next, { alpha: A, beta: B });
  const s = g2.match.receipt.payload.series;
  assert.equal(s.series_id, id);
  assert.equal(s.game, 2);
  assert.equal(s.previous_match_id, id);
  assert.equal(s.previous_receipt_sha256, await sha256Hex(canonicalJson(g1.match.receipt.payload)));
  assert.equal(s.tally.games, 2);
  assert.equal(s.tally.wins.alpha + s.tally.wins.beta + s.tally.no_result, 2);
  const w1 = g1.match.result.winner, w2 = g2.match.result.winner;
  assert.equal(s.tally.wins[w1], w1 === w2 ? 2 : 1);
  assert.equal(await verifyReceipt(g2.match.receipt, keys.PUBLIC_KEY), true);
});

test("rematch limits: random tiers only, parties only, at most 10 games per series", async () => {
  const w = world();
  // judge tiers can't rematch
  const f = fakeJudges({ [H]: { winner: "alpha" } });
  try {
    const { id, t } = await judgeMatch(w, { tier: "judge", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." });
    assert.equal((await w.call(id, "rematch", { seat: "alpha", seat_token: t.alpha })).status, 400);
  } finally {
    f.restore();
  }
  // play a series to the cap
  let id = randomToken(12);
  await w.call(id, "create", { id, input: { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 } } });
  for (let game = 1; game <= 10; game++) {
    const g = await playWeighted(w, id);
    assert.equal(g.match.tally.games, game);
    const a = await w.call(id, "rematch", { seat: "alpha", seat_token: g.t.alpha });
    if (game === 10) {
      assert.equal(a.status, 409);
      assert.match(a.body.error, /10 games/);
      assert.equal(g.match.rematch.available, false);
      break;
    }
    id = (await w.call(id, "rematch", { seat: "beta", seat_token: g.t.beta })).body.rematch.next_match_id;
  }
});

test("demo matches can rematch too, and stay demo", async () => {
  const w = world();
  const id = randomToken(12);
  await w.call(id, "create", { id, input: { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 }, demo: true } });
  const t: Record<string, string> = {};
  for (const s of ["alpha", "beta"]) t[s] = (await w.call(id, "join", { seat: s, tier: "weighted", role: "party", demo: true })).body.seat_token;
  const v: Record<string, [string, string]> = { alpha: [randomToken(16), randomToken(16)], beta: [randomToken(16), randomToken(16)] };
  for (const s of ["alpha", "beta"]) await w.call(id, "commit", { seat: s, seat_token: t[s], commitment: await commitmentOf(v[s][0], v[s][1]) });
  for (const s of ["alpha", "beta"]) await w.call(id, "reveal", { seat: s, seat_token: t[s], value: v[s][0], nonce: v[s][1] });
  await w.call(id, "rematch", { seat: "alpha", seat_token: t.alpha });
  const next = (await w.call(id, "rematch", { seat: "beta", seat_token: t.beta })).body.rematch.next_match_id;
  const st = (await w.call(next, "status")).body;
  assert.equal(st.demo, true);
  assert.equal(st.seat_wallets, undefined);
});

// ---------- mixed-provider panels (Claude via Anthropic, others via OpenRouter) ----------

const MIXED = {
  PANEL_2_MODELS: "claude-opus-5-5,google/gemini-4-argon",
  PANEL_3_MODELS: "claude-opus-5-5,openai/gpt-6-luna,google/gemini-3.7-flash",
  OPENROUTER_API_KEY: "or-test",
};

/** Fake Anthropic + OpenRouter: answers per model, records each request. `reply` may be "length" (out of tokens). */
function fakeMixed(replies: Record<string, any>) {
  const realFetch = globalThis.fetch;
  const sent: { url: string; headers: any; body: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), headers: init.headers, body });
    const r = replies[body.model];
    const text = JSON.stringify({ rule_applied: "r", reasoning: "Because of the rules.", confidence: "medium", ...r });
    if (String(url).includes("openrouter.ai")) {
      if (r === "length") return new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] }));
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }));
  }) as any;
  return { sent, restore: () => (globalThis.fetch = realFetch) };
}

test("judge-3 with Opus + GPT-6 Luna + Gemini Flash: each goes to the right API, committed up front, majority decides", async () => {
  const f = fakeMixed({ "claude-opus-5-5": { winner: "beta" }, "openai/gpt-6-luna": { winner: "alpha" }, "google/gemini-3.7-flash": { winner: "beta" } });
  try {
    const { done } = await judgeMatch(world(MIXED), { tier: "judge-3", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." });
    assert.deepEqual(done.match.judge.panel.map((p: any) => p.model), ["claude-opus-5-5", "openai/gpt-6-luna", "google/gemini-3.7-flash"], "the lineup is locked in before anyone pays");
    assert.equal(done.match.result.winner, "beta");
    assert.deepEqual(done.match.result.tally, { alpha: 1, beta: 2, mistrial: 0 });
    assert.deepEqual(done.match.result.votes.map((v: any) => v.model), ["claude-opus-5-5", "openai/gpt-6-luna", "google/gemini-3.7-flash"]);
    const anthropic = f.sent.filter((s) => s.url.includes("anthropic.com"));
    const openrouter = f.sent.filter((s) => s.url.includes("openrouter.ai"));
    assert.deepEqual(anthropic.map((s) => s.body.model), ["claude-opus-5-5"]);
    assert.deepEqual(openrouter.map((s) => s.body.model).sort(), ["google/gemini-3.7-flash", "openai/gpt-6-luna"]);
    for (const s of openrouter) {
      assert.equal(s.headers.authorization, "Bearer or-test");
      assert.equal(s.body.temperature, undefined);
      assert.equal(s.body.messages[0].role, "system");
      assert.match(s.body.messages[0].content, /neutral referee/);
      assert.equal(s.body.reasoning.effort, "low");
    }
    // panelist 2 (GPT-6 Luna) sees the parties in reverse order, like any panel
    const luna = openrouter.find((s) => s.body.model === "openai/gpt-6-luna")!;
    assert.ok(luna.body.messages[1].content.indexOf('party="beta"') < luna.body.messages[1].content.indexOf('party="alpha"'));
  } finally {
    f.restore();
  }
});

test("judge-2 with Opus + Gemini 4 Argon; a judge that runs out of tokens is a clear, retryable error", async () => {
  const f = fakeMixed({ "claude-opus-5-5": { winner: "alpha" }, "google/gemini-4-argon": "length" });
  try {
    const w = world(MIXED);
    const { id, t, done } = await judgeMatch(w, { tier: "judge-2", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." });
    assert.equal(done.match.phase, "error");
    assert.match(done.match.error, /1 of 2 judges failed \(judge ran out of tokens before answering\)/);
    f.restore();
    const g = fakeMixed({ "claude-opus-5-5": { winner: "nobody-asked" }, "google/gemini-4-argon": { winner: "alpha" } });
    try {
      const retried = await w.call(id, "retry-judge", { seat: "beta", seat_token: t.beta });
      assert.equal(retried.body.match.result.winner, "alpha", "both judges agree; Opus's earlier verdict was kept, not re-asked");
      assert.equal(g.sent.filter((s) => s.body.model === "claude-opus-5-5").length, 0);
    } finally {
      g.restore();
    }
  } finally {
    f.restore();
  }
});

test("a panel that needs OpenRouter but has no key never judges with a missing model", async () => {
  const f = fakeMixed({ "claude-opus-5-5": { winner: "alpha" } });
  try {
    const { done } = await judgeMatch(world({ ...MIXED, OPENROUTER_API_KEY: undefined }), { tier: "judge-2", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." });
    assert.equal(done.match.phase, "error");
    assert.match(done.match.error, /missing OPENROUTER_API_KEY/);
    assert.equal(f.sent.length, 0);
  } finally {
    f.restore();
  }
});
