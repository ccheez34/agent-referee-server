// Checks the client's verifyOutcome() against receipts produced by the real server logic, for every tier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchRoom } from "../src/match.ts";
import { commitmentOf, randomToken } from "../src/logic.ts";
// @ts-ignore plain JS client
import { verifyOutcome, AgentReferee, findContradictions, verifySignature } from "agent-referee-client";

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = {
  SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)),
  PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer),
};

function room() {
  const data = new Map<string, unknown>();
  const state = { storage: {
    async get(k: string) { return data.has(k) ? structuredClone(data.get(k)) : undefined; },
    async put(k: string, v: unknown) { data.set(k, structuredClone(v)); },
    async deleteAll() { data.clear(); },
    async setAlarm() {},
  } };
  const r = new MatchRoom(state as any, { ...keys, CLAUDE_JUDGES_ENABLED: "true" } as any);
  const call = async (action: string, body?: unknown) => {
    r.m = undefined;
    const res = await r.fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
    return (await res.json()) as any;
  };
  return { r, call };
}

async function match(input: any, joins: [string, string?][]) {
  const x = room();
  await x.call("create", { id: randomToken(12), input });
  const tokens: Record<string, string> = {};
  for (const [seat, role] of joins) tokens[seat] = (await x.call("join", { seat, tier: input.tier, role: role ?? "party", paid: true })).seat_token;
  return { ...x, tokens };
}

async function round(x: any, values: Record<string, string>, revealOnly?: string[]) {
  const nonces: Record<string, string> = {};
  for (const s of Object.keys(values)) {
    nonces[s] = randomToken(16);
    await x.call("commit", { seat: s, seat_token: x.tokens[s], commitment: await commitmentOf(values[s], nonces[s]) });
  }
  let last: any;
  for (const s of revealOnly ?? Object.keys(values)) last = await x.call("reveal", { seat: s, seat_token: x.tokens[s], value: values[s], nonce: nonces[s] });
  return last?.match;
}

const later = () => Date.now() + 11 * 60_000;
const moves = ["rock", "paper", "scissors"];

test("weighted: 200 receipts all recompute, both odds", async () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const weights = i % 2 ? { alpha: 70, beta: 30 } : { alpha: 1, beta: 1 };
    const x = await match({ tier: "weighted", seats: ["alpha", "beta"], weights }, [["alpha"], ["beta"]]);
    const m = await round(x, { alpha: randomToken(16), beta: randomToken(16) });
    const v = await verifyOutcome(m.receipt);
    assert.deepEqual([v.ok, v.recomputed, v.problems], [true, true, []], JSON.stringify(v));
    seen.add(m.result.winner);
  }
  assert.equal(seen.size, 2);
});

test("rps and best-of-3, including tied rounds", async () => {
  for (const tier of ["rps", "rps-bo3"]) {
    for (let i = 0; i < 60; i++) {
      const x = await match({ tier, seats: ["alpha", "beta"] }, [["alpha"], ["beta"]]);
      let m: any;
      do m = await round(x, { alpha: moves[i % 3], beta: moves[(i + Math.floor(Math.random() * 3)) % 3] });
      while (m.phase !== "done");
      const v = await verifyOutcome(m.receipt);
      assert.deepEqual([v.ok, v.recomputed], [true, true], JSON.stringify(v));
    }
  }
});

test("draw with mediator, and a draw where one party walks away", async () => {
  for (let i = 0; i < 50; i++) {
    const x = await match({ tier: "draw", seats: ["a", "b", "c"], options: ["x", "y", "z", "w"] }, [["a"], ["b"], ["c"], ["mediator", "mediator"]]);
    const m = await round(x, { a: randomToken(16), b: randomToken(16), c: randomToken(16), mediator: randomToken(16) });
    const v = await verifyOutcome(m.receipt);
    assert.deepEqual([v.ok, v.recomputed], [true, true], JSON.stringify(v));
  }
  const x = await match({ tier: "draw", seats: ["a", "b", "c"], options: ["x", "y"] }, [["a"], ["b"], ["c"], ["mediator", "mediator"]]);
  const nonces: Record<string, string> = {};
  for (const s of ["a", "b", "mediator"]) {
    nonces[s] = randomToken(16);
    await x.call("commit", { seat: s, seat_token: x.tokens[s], commitment: await commitmentOf(s + "seed-0123456789", nonces[s]) });
  }
  x.r.now = later; // c never commits: excluded
  await x.call("status");
  x.r.now = () => Date.now();
  let m: any;
  for (const s of ["a", "b", "mediator"]) m = (await x.call("reveal", { seat: s, seat_token: x.tokens[s], value: s + "seed-0123456789", nonce: nonces[s] })).match;
  assert.equal(m.phase, "done");
  const v = await verifyOutcome(m.receipt);
  assert.deepEqual([v.ok, v.recomputed, v.trusts.length], [true, true, 1], JSON.stringify(v));
});

test("forfeits: reveals still check out, forfeit is listed as trusted", async () => {
  const x = await match({ tier: "rps", seats: ["alpha", "beta"] }, [["alpha"], ["beta"]]);
  await round(x, { alpha: "rock", beta: "paper" }, ["alpha"]);
  x.r.now = later;
  const st = await x.call("status");
  const v = await verifyOutcome(st.receipt);
  assert.deepEqual([v.ok, v.recomputed, v.trusts.length], [true, false, 1], JSON.stringify(v));

  const y = await match({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 } }, [["alpha"], ["beta"]]);
  await y.call("commit", { seat: "alpha", seat_token: y.tokens.alpha, commitment: await commitmentOf("seed-0123456789abcdef", "n".repeat(16)) });
  y.r.now = later;
  const v2 = await verifyOutcome((await y.call("status")).receipt);
  assert.deepEqual([v2.ok, v2.recomputed, v2.trusts.length], [true, false, 1], JSON.stringify(v2));
});

test("tampering is caught", async () => {
  const x = await match({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 50, beta: 50 } }, [["alpha"], ["beta"]]);
  const m = await round(x, { alpha: randomToken(16), beta: randomToken(16) });
  const flipped = structuredClone(m.receipt);
  flipped.payload.outcome.winner = m.result.winner === "alpha" ? "beta" : "alpha";
  assert.equal((await verifyOutcome(flipped)).ok, false);
  const badReveal = structuredClone(m.receipt);
  badReveal.payload.proof.reveals.alpha.value = "different-seed-0000";
  assert.equal((await verifyOutcome(badReveal)).ok, false);
  const odds = structuredClone(m.receipt);
  odds.payload.outcome.weights = { alpha: 99, beta: 1 };
  // changing the odds either changes the expected winner or breaks nothing visible; the signature catches it:
  const ref = new AgentReferee({ fetch: async () => { throw new Error("offline check must not call the network"); } });
  assert.equal(await ref.verifyReceipt(m.receipt, { publicKeys: [keys.PUBLIC_KEY] }), true);
  assert.equal(await ref.verifyReceipt(odds, { publicKeys: [keys.PUBLIC_KEY] }), false);
  assert.equal(await ref.verifyReceipt(flipped, { publicKeys: [keys.PUBLIC_KEY] }), false);

  const r = await match({ tier: "rps-bo3", seats: ["alpha", "beta"] }, [["alpha"], ["beta"]]);
  let rm: any;
  do rm = await round(r, { alpha: "rock", beta: "scissors" }); while (rm.phase !== "done");
  const fake = structuredClone(rm.receipt);
  fake.payload.outcome.winner = "beta";
  assert.equal((await verifyOutcome(fake)).ok, false);
});

// Routes the real client's HTTP calls into a MatchRoom, so Seat.play() runs end to end.
function clientFor(x0: any, id: string, publicKeys = [keys.PUBLIC_KEY], onAck?: any) {
  // No state reset between calls: concurrent requests share the live room, like the real Durable Object.
  const x = { call: async (action: string, body?: unknown) => {
    const res = await x0.r.fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
    return (await res.json()) as any;
  } };
  const fetch = async (url: string, init: any = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    let out: any;
    if (path.startsWith("/join/") || path.startsWith("/demo/join/")) {
      const demo = path.startsWith("/demo/");
      const tier = path.split("/")[demo ? 3 : 2];
      out = await x.call("join", { seat: body.seat, tier, role: path.endsWith("mediator") ? "mediator" : "party", paid: !demo, demo });
    } else if (path.endsWith("/commit")) out = await x.call("commit", body);
    else if (path.endsWith("/reveal")) out = await x.call("reveal", body);
    else out = await x.call("status");
    return new Response(JSON.stringify(out), { status: out.error ? 400 : 200 });
  };
  return new AgentReferee({ url: "https://ref.test", fetch, pollMs: 1, publicKeys, onAck });
}

test("own-seed check: a service that swaps one side's seed is caught by that side", async () => {
  for (const tier of ["weighted", "rps-bo3"]) {
    const x = room();
    const id = randomToken(12);
    await x.call("create", { id, input: tier === "weighted" ? { tier, seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 } } : { tier, seats: ["alpha", "beta"] } });
    const ref = clientFor(x, id);
    const [a, b] = await Promise.all([ref.join(id, "alpha"), ref.join(id, "beta")]);
    const [st] = await Promise.all([a.play(), b.play()]);
    assert.deepEqual([st.check?.ok, st.check?.recomputed], [true, true], "play() auto-checks");
    for (const s of [a, b]) {
      const v = await verifyOutcome(st.receipt, { seat: s });
      assert.deepEqual([v.ok, v.recomputed], [true, true], JSON.stringify(v));
    }
    if (tier !== "weighted") continue;
    // Dishonest service: replaces beta's seed with a fresh one (and a matching commitment), recomputes a winner.
    const forged = structuredClone(st.receipt);
    const nonce = "f".repeat(32);
    let seed = "";
    for (let i = 0; i < 100; i++) {
      seed = "forged-" + i + "-0123456789";
      forged.payload.proof.reveals.beta = { value: seed, nonce };
      forged.payload.proof.commits.beta = await (await import("../src/logic.ts")).commitmentOf(seed, nonce);
      delete forged.payload.proof.combined_sha256;
      forged.payload.outcome.winner = st.result.winner === "alpha" ? "beta" : "alpha";
      if ((await verifyOutcome(forged)).ok) break; // found a seed that flips the result self-consistently
    }
    assert.equal((await verifyOutcome(forged)).ok, true, "self-consistent forgery passes the plain check");
    assert.equal((await verifyOutcome(forged, { seat: a })).ok, true, "alpha's own inputs are untouched");
    const caught = await verifyOutcome(forged, { seat: b });
    assert.equal(caught.ok, false);
    assert.ok(caught.problems.some((p: string) => p.includes("replaced")), JSON.stringify(caught));
  }
});

test("play() check fails if the signature doesn't match the pinned key", async () => {
  const x = room();
  const id = randomToken(12);
  await x.call("create", { id, input: { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 } } });
  const wrongKey = b64((await crypto.subtle.exportKey("raw", ((await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair).publicKey)) as ArrayBuffer);
  const good = clientFor(x, id);
  const bad = clientFor(x, id, [wrongKey]);
  const [a, b] = await Promise.all([good.join(id, "alpha"), bad.join(id, "beta")]);
  const [sa, sb] = await Promise.all([a.play(), b.play()]);
  assert.deepEqual([sa.check.ok, sa.check.signed], [true, true]);
  assert.deepEqual([sb.check.ok, sb.check.signed], [false, false]);
  assert.ok(sb.check.problems.some((p: string) => p.includes("signature")));
});

test("signed step acknowledgments: honest matches are clean; a seed swap and a fake forfeit become provable", async () => {
  const x = room();
  const id = randomToken(12);
  await x.call("create", { id, input: { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 } } });
  const streamed: string[] = [];
  const ref = clientFor(x, id, [keys.PUBLIC_KEY], (ack: any, seat: any) => { streamed.push(`${seat.seat}:${ack.payload.step}`); });
  const [a, b] = await Promise.all([ref.join(id, "alpha"), ref.join(id, "beta")]);
  const [st] = await Promise.all([a.play(), b.play()]);
  assert.deepEqual(streamed.sort(), ["alpha:commit", "alpha:join", "alpha:reveal", "beta:commit", "beta:join", "beta:reveal"], "onAck streams every ack");
  const commitAck = b.acks.find((k: any) => k.payload.step === "commit").payload;
  assert.deepEqual(Object.keys(commitAck).sort(), ["accepted_at", "commitment", "match_id", "round", "seat", "service", "step", "tier", "type"]);
  assert.match(commitAck.commitment, /^[0-9a-f]{64}$/);
  assert.deepEqual(b.acks.map((k: any) => k.payload.step), ["join", "commit", "reveal"]);
  assert.equal(st.check.ok, true, JSON.stringify(st.check));
  assert.deepEqual(st.acks.map((k: any) => k.payload.step), ["join", "commit", "reveal"], "play() returns the acks");
  assert.deepEqual([findContradictions(st.receipt, a.acks), findContradictions(st.receipt, b.acks)], [[], []]);

  // A third party (no seeds, only the signed documents) checks both signatures, then the contradiction.
  const judgeOf = new AgentReferee({ fetch: async () => { throw new Error("offline"); }, publicKeys: [keys.PUBLIC_KEY] });
  for (const k of b.acks) assert.equal(await judgeOf.verifyReceipt(k), true);

  // 1) Seed swap: beta's reveal replaced with a forged one (matching commitment).
  const { commitmentOf } = await import("../src/logic.ts");
  const swapped = structuredClone(st.receipt);
  swapped.payload.proof.reveals.beta = { value: "forged-seed-0123456789", nonce: "n".repeat(32) };
  swapped.payload.proof.commits.beta = await commitmentOf("forged-seed-0123456789", "n".repeat(32));
  const ev1 = findContradictions(swapped, b.acks);
  assert.ok(ev1.length >= 2 && ev1.every((e: any) => e.ack.signature), JSON.stringify(ev1));
  const third = await verifyOutcome(swapped, { acks: b.acks });
  assert.deepEqual([third.ok, third.evidence.length > 0], [false, true]);

  // 2) Fake forfeit: beta revealed in time, but the receipt says beta forfeited.
  const fake = structuredClone(st.receipt);
  delete fake.payload.proof.reveals.beta;
  fake.payload.outcome = { winner: "alpha", by_forfeit: true, forfeited: ["beta"] };
  const ev2 = findContradictions(fake, b.acks);
  assert.ok(ev2.some((e: any) => e.reason.includes("forfeiting")), JSON.stringify(ev2));
  assert.equal(findContradictions(fake, a.acks).length, 0, "alpha's acks don't contradict it; beta's do");

  // 3) A tampered acknowledgment is worthless: its signature fails.
  const forgedAck = structuredClone(b.acks[1]);
  forgedAck.payload.commitment = "0".repeat(64);
  assert.equal(await judgeOf.verifyReceipt(forgedAck), false);
  b.acks[1] = forgedAck;
  const c = await b._check(st.receipt);
  assert.equal(c.ok, false);
});

test("judge submissions get a signed acknowledgment, including the last submitter whose request waits for the verdict", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ winner: "buyer", reasoning: "late", rule_applied: "deadline rule" }) }] }), { status: 200 })) as any;
  try {
    const data = new Map<string, unknown>();
    const state = { storage: { async get(k: string) { return structuredClone(data.get(k)); }, async put(k: string, v: unknown) { data.set(k, structuredClone(v)); }, async deleteAll() { data.clear(); }, async setAlarm() {} } };
    const r = new MatchRoom(state as any, { ...keys, ANTHROPIC_API_KEY: "x", CLAUDE_JUDGES_ENABLED: "true" } as any);
    const call = async (action: string, body?: unknown) => (await (await r.fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }))).json()) as any;
    const id = randomToken(12);
    await call("create", { id, input: { tier: "judge", seats: ["buyer", "seller"], rules: "Late delivery means the buyer wins." } });
    const tb = (await call("join", { seat: "buyer", tier: "judge", paid: true })).seat_token;
    const ts = (await call("join", { seat: "seller", tier: "judge", paid: true })).seat_token;
    const s1 = await call("submit", { seat: "buyer", seat_token: tb, position: "It arrived late." });
    const s2 = await call("submit", { seat: "seller", seat_token: ts, position: "It was on time." });
    assert.equal(s1.ack.payload.step, "submit");
    assert.equal(s2.ack.payload.step, "submit");
    assert.equal(s2.match.phase, "done", JSON.stringify(s2.match));
    assert.deepEqual(findContradictions(s2.match.receipt, [s1.ack, s2.ack]), []);
    const fake = structuredClone(s2.match.receipt);
    fake.payload.outcome = { winner: "buyer", by_forfeit: true, forfeited: ["seller"] };
    assert.equal(findContradictions(fake, [s2.ack]).length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("acks arrive step by step via onAck, survive a forfeit, and verify standalone offline", async () => {
  const x = room();
  const id = randomToken(12);
  await x.call("create", { id, input: { tier: "rps", seats: ["alpha", "beta"] } });
  const base = clientFor(x, id);
  const streamed: string[] = [];
  const ref = new AgentReferee({ url: base.url, fetch: base.fetch, pollMs: 1, publicKeys: [keys.PUBLIC_KEY], onAck: (ack: any) => { streamed.push(ack.payload.step); } });
  const [a, b] = await Promise.all([ref.join(id, "alpha"), ref.join(id, "beta")]);
  assert.deepEqual(streamed, ["join", "join"], "join acks stream immediately");
  // alpha commits and reveals; beta commits, then walks away before revealing
  await Promise.all([a.playRound("rock").catch(() => {}), (async () => {
    const { commitmentOf } = await import("../src/logic.ts");
    const c = await x.call("commit", { seat: "beta", seat_token: b.token, commitment: await commitmentOf("paper", "p".repeat(32)) });
    assert.ok(c.ack);
  })(), (async () => {
    // let alpha reveal, then advance the clock past the reveal deadline
    for (let i = 0; i < 200 && a.acks.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    x.r.now = () => Date.now() + 11 * 60_000;
  })()]);
  const st = await x.call("status");
  assert.equal(st.phase, "done");
  assert.deepEqual(st.result.forfeited, ["beta"]);
  assert.deepEqual(a.acks.map((k: any) => k.payload.step), ["join", "commit", "reveal"], "alpha keeps every ack through the forfeit");
  assert.ok(streamed.includes("reveal"), "reveal ack streamed via onAck");
  for (const k of a.acks) assert.equal(await verifySignature(k, [keys.PUBLIC_KEY]), true);
  assert.equal(await verifySignature(st.receipt, [keys.PUBLIC_KEY]), true);
  assert.equal(await verifySignature(st.receipt, ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="]), false);
  // A service that instead claimed alpha forfeited would be contradicted by alpha's signed reveal ack:
  const lie = structuredClone(st.receipt);
  lie.payload.outcome = { winner: "beta", by_forfeit: true, forfeited: ["alpha"] };
  assert.ok(findContradictions(lie, a.acks).some((e: any) => e.reason.includes("forfeiting")));
  const commitAck = a.acks.find((k: any) => k.payload.step === "commit");
  assert.match(commitAck.payload.commitment, /^[0-9a-f]{64}$/);
  assert.ok(commitAck.payload.accepted_at && commitAck.payload.match_id === id && commitAck.payload.seat === "alpha");
});

test("robustness: a throwing onAck can't break a match; each ack fires once; signatures survive key reordering", async () => {
  const x = room();
  const id = randomToken(12);
  await x.call("create", { id, input: { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 } } });
  const base = clientFor(x, id);
  let calls = 0;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const ref = new AgentReferee({ url: base.url, fetch: base.fetch, pollMs: 1, publicKeys: [keys.PUBLIC_KEY], onAck: () => { calls++; throw new Error("disk full"); } });
    const [a, b] = await Promise.all([ref.join(id, "alpha"), ref.join(id, "beta")]);
    const [sa] = await Promise.all([a.play(), b.play()]);
    assert.equal(sa.check.ok, true, JSON.stringify(sa.check));
    assert.equal(calls, 6, "join + commit + reveal for each of two seats, exactly once each");
    // Canonical signing: the same document with keys in a different order still verifies...
    const ack = a.acks[1];
    const reordered = { ...ack, payload: Object.fromEntries(Object.entries(ack.payload).reverse()) };
    assert.equal(await verifySignature(reordered, [keys.PUBLIC_KEY]), true);
    // ...a parsed document can't carry duplicate keys, and a changed value fails:
    const dup = JSON.parse(JSON.stringify(ack).replace('"step":"commit"', '"step":"commit","step":"reveal"'));
    assert.equal(await verifySignature(dup, [keys.PUBLIC_KEY]), false);
    // Domain separation: an ack's signed payload says it's an ack, so it can't pass as a receipt.
    assert.equal(ack.payload.type, "step-ack");
    assert.equal((await verifyOutcome(ack as any)).ok, false);
  } finally {
    console.warn = warn;
  }
});

test("new client against an old server (no acks in responses) still works", async () => {
  const x = room();
  const id = randomToken(12);
  await x.call("create", { id, input: { tier: "rps-bo3", seats: ["alpha", "beta"] } });
  const base = clientFor(x, id);
  const oldServerFetch = async (url: string, init: any) => {
    const res = await base.fetch(url, init);
    const body = await res.json();
    delete body.ack; // what the pre-0.3.0 server returned
    return new Response(JSON.stringify(body), { status: res.status });
  };
  const ref = new AgentReferee({ url: base.url, fetch: oldServerFetch, pollMs: 1, publicKeys: [keys.PUBLIC_KEY] });
  const [a, b] = await Promise.all([ref.join(id, "alpha"), ref.join(id, "beta")]);
  const [sa, sb] = await Promise.all([a.play(), b.play()]);
  assert.deepEqual([sa.check.ok, sb.check.ok, a.acks.length, sa.acks.length], [true, true, 0, 0]);
});

test("a retried commit is refused and issues no second ack", async () => {
  const x = room();
  const id = randomToken(12);
  await x.call("create", { id, input: { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 } } });
  const j = await x.call("join", { seat: "alpha", tier: "weighted", paid: true });
  await x.call("join", { seat: "beta", tier: "weighted", paid: true });
  const { commitmentOf } = await import("../src/logic.ts");
  const c = await commitmentOf("seed-0123456789abcdef", "n".repeat(32));
  const first = await x.call("commit", { seat: "alpha", seat_token: j.seat_token, commitment: c });
  const again = await x.call("commit", { seat: "alpha", seat_token: j.seat_token, commitment: c });
  assert.ok(first.ack);
  assert.ok(again.error && !again.ack);
});

test("settings check: a receipt with different odds than the agent asked for is caught", async () => {
  const x = room();
  const id = randomToken(12);
  await x.call("create", { id, input: { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 50, beta: 50 } } });
  const ref = clientFor(x, id);
  ref._requested.set(id, { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 50, beta: 50 }, demo: false });
  const [a, b] = await Promise.all([ref.join(id, "alpha"), ref.join(id, "beta")]);
  const [sa] = await Promise.all([a.play(), b.play()]);
  assert.equal(sa.check.ok, true, JSON.stringify(sa.check));
  // A dishonest service hands this agent a receipt claiming 70/30 (signature aside, the settings alone are caught).
  const other = structuredClone(sa.receipt);
  other.payload.outcome.weights = { alpha: 70, beta: 30 };
  const v = await verifyOutcome(other, { seat: a });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p: string) => p.includes("odds")), JSON.stringify(v.problems));
  // Same for a receipt that claims to be a demo, or a different tier.
  const demoed = structuredClone(sa.receipt);
  demoed.payload.demo = true;
  assert.ok((await verifyOutcome(demoed, { seat: a })).problems.some((p: string) => p.includes("demo")));
});

test("a seat that joined someone else's match checks against what the match showed at join", async () => {
  const x = room();
  const id = randomToken(12);
  await x.call("create", { id, input: { tier: "draw", seats: ["p1", "p2"], options: ["x", "y", "z"] } });
  const ref = clientFor(x, id);
  const s = await ref.join(id, "p1");
  assert.deepEqual(s.requested, { tier: "draw", seats: ["p1", "p2"], weights: undefined, options: ["x", "y", "z"], rules: undefined, demo: false });
});

test("demo client: creates a demo match, joins free via /demo/join, and check.ok passes with demo receipts", async () => {
  const x = room();
  const base = clientFor(x, "unused");
  const paths: string[] = [];
  const spy = async (url: string, init: any) => { paths.push(new URL(url).pathname); return base.fetch(url, init); };
  const ref = new AgentReferee({ url: base.url, fetch: spy, pollMs: 1, publicKeys: [keys.PUBLIC_KEY], demo: true });
  // The mock routes every create to this one room; the id comes from the room's own create call.
  const id = randomToken(12);
  const created = await x.call("create", { id, input: { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 }, demo: true } });
  ref._requested.set(id, { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 }, demo: true });
  const [a, b] = await Promise.all([ref.join(id, "alpha"), ref.join(id, "beta")]);
  const [sa, sb] = await Promise.all([a.play(), b.play()]);
  assert.ok(created.demo);
  assert.ok(paths.includes("/demo/join/weighted"), JSON.stringify(paths));
  assert.equal(sa.receipt.payload.demo, true);
  assert.deepEqual([sa.check.ok, sb.check.ok], [true, true], JSON.stringify(sa.check));
});

test("demo client's create sends demo: true and remembers the requested settings", async () => {
  let sent: any;
  const fetch = async (_url: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ match_id: "a".repeat(24), demo: true }), { status: 201 }); };
  const ref = new AgentReferee({ url: "https://ref.test", fetch, demo: true });
  await ref.create({ tier: "rps", seats: ["b", "a"], key: "k-1" });
  assert.equal(sent.demo, true);
  assert.deepEqual(ref._requested.get("a".repeat(24)), { tier: "rps", seats: ["a", "b"], weights: undefined, options: undefined, rules: undefined, demo: true });
});

test("a paid join that keeps failing reports the real error, not the recovery lookup", async () => {
  let joins = 0;
  const fetch = async (url: string, init: any = {}) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/join/")) { joins++; return new Response(JSON.stringify({ error: "Failed to settle payment: insufficient_credits" }), { status: 402 }); }
    if (path.endsWith("/recover")) return new Response(JSON.stringify({ error: "No seat in this match was paid for with that payment." }), { status: 404 });
    return new Response(JSON.stringify({ match_id: "a".repeat(24), tier: "weighted", phase: "joining", seats: [] }), { status: 200 });
  };
  const capture = { fetch, lastPayment: () => "proof" };
  const ref = new AgentReferee({ url: "https://ref.test", fetch, capture, joinRetries: 2 });
  await assert.rejects(ref.join("a".repeat(24), "alpha"), (e: any) => e.message.includes("insufficient_credits"));
  assert.equal(joins, 3);
});
