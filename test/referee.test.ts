// Runs the real Durable Object logic in Node with an in-memory storage mock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchRoom } from "../src/match.ts";
import { commitmentOf, randomToken, rpsResult, weightedPick, canonicalJson } from "../src/logic.ts";
import { verifyReceipt } from "../src/receipt.ts";

async function makeKeys() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
  return {
    SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)),
    PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer),
  };
}
const keys = await makeKeys();

function newRoom(env: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>();
  const state = {
    storage: {
      async get(k: string) { return data.has(k) ? structuredClone(data.get(k)) : undefined; },
      async put(k: string, v: unknown) { data.set(k, structuredClone(v)); },
      async deleteAll() { data.clear(); },
      async setAlarm() {},
    },
  };
  const room = new MatchRoom(state as any, { ...keys, ...env } as any);
  // Fresh object each call, like a real DO waking from storage
  const call = async (action: string, body?: unknown) => {
    room.m = undefined;
    const res = await room.fetch(
      new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  return { room, call };
}

async function setup(input: any, joins: [string, string, string?][]) {
  const r = newRoom();
  const id = randomToken(12);
  const created = await r.call("create", { id, input });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const tokens: Record<string, string> = {};
  for (const [seat, tier, role] of joins) {
    const j = await r.call("join", { seat, tier, role: role ?? "party", paid: true });
    assert.equal(j.status, 200, JSON.stringify(j.body));
    tokens[seat] = j.body.seat_token;
  }
  return { ...r, id, tokens };
}

async function playRound(r: any, tokens: Record<string, string>, values: Record<string, string>) {
  const nonces: Record<string, string> = {};
  for (const seat of Object.keys(values)) {
    nonces[seat] = randomToken(16);
    const c = await r.call("commit", { seat, seat_token: tokens[seat], commitment: await commitmentOf(values[seat], nonces[seat]) });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }
  let last: any;
  for (const seat of Object.keys(values)) {
    last = await r.call("reveal", { seat, seat_token: tokens[seat], value: values[seat], nonce: nonces[seat] });
    assert.equal(last.status, 200, JSON.stringify(last.body));
  }
  return last.body.match;
}

test("rps rules", () => {
  assert.equal(rpsResult("rock", "scissors"), 0);
  assert.equal(rpsResult("rock", "paper"), 1);
  assert.equal(rpsResult("paper", "paper"), -1);
});

test("weighted pick follows weights", () => {
  const counts: Record<string, number> = { a: 0, b: 0 };
  for (let i = 0n; i < 1000n; i++) counts[weightedPick({ a: 70, b: 30 }, i)]++;
  assert.deepEqual(counts, { a: 700, b: 300 });
});

test("tier 1: rps with a tie replays, then signs a verifiable receipt", async () => {
  const r = await setup({ tier: "rps", seats: ["alpha", "beta"] }, [["alpha", "rps"], ["beta", "rps"]]);
  let m = await playRound(r, r.tokens, { alpha: "rock", beta: "rock" });
  assert.equal(m.phase, "commit");
  assert.equal(m.round, 2);
  m = await playRound(r, r.tokens, { alpha: "paper", beta: "rock" });
  assert.equal(m.phase, "done");
  assert.equal(m.result.winner, "alpha");
  assert.equal(await verifyReceipt(m.receipt, keys.PUBLIC_KEY), true);
  // tampering breaks the signature
  const forged = structuredClone(m.receipt);
  forged.payload.outcome.winner = "beta";
  assert.equal(await verifyReceipt(forged, keys.PUBLIC_KEY), false);
});

test("tier 2: best of 3 needs two wins", async () => {
  const r = await setup({ tier: "rps-bo3", seats: ["alpha", "beta"] }, [["alpha", "rps-bo3"], ["beta", "rps-bo3"]]);
  let m = await playRound(r, r.tokens, { alpha: "rock", beta: "scissors" }); // alpha 1-0
  assert.equal(m.phase, "commit");
  m = await playRound(r, r.tokens, { alpha: "rock", beta: "paper" }); // 1-1
  m = await playRound(r, r.tokens, { alpha: "rock", beta: "rock" }); // tie, doesn't count
  assert.deepEqual(m.score, { alpha: 1, beta: 1 });
  m = await playRound(r, r.tokens, { alpha: "scissors", beta: "rock" }); // beta 2-1
  assert.equal(m.phase, "done");
  assert.equal(m.result.winner, "beta");
  assert.equal(m.result.rounds_played, 4);
});

test("tier 3: weighted pick combines both seeds", async () => {
  const r = await setup(
    { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 70, beta: 30 } },
    [["alpha", "weighted"], ["beta", "weighted"]],
  );
  const m = await playRound(r, r.tokens, { alpha: randomToken(16), beta: randomToken(16) });
  assert.equal(m.phase, "done");
  assert.ok(["alpha", "beta"].includes(m.result.winner));
  assert.match(m.receipt.payload.proof.combined_sha256, /^[0-9a-f]{64}$/);
});

test("tier 4: parties join free in any order, the mediator pays, every seat seeds", async () => {
  const r = newRoom();
  const id = randomToken(12);
  await r.call("create", { id, input: { tier: "draw", seats: ["alpha", "beta"], options: ["pizza", "tacos", "sushi"] } });
  const tokens: Record<string, string> = {};
  tokens.alpha = (await r.call("join", { seat: "alpha", tier: "draw", role: "party" })).body.seat_token;
  tokens.mediator = (await r.call("join", { seat: "mediator", tier: "draw", role: "mediator", paid: true })).body.seat_token;
  tokens.beta = (await r.call("join", { seat: "beta", tier: "draw", role: "party" })).body.seat_token;
  const m = await playRound(r, tokens, { mediator: randomToken(16), alpha: randomToken(16), beta: randomToken(16) });
  assert.equal(m.phase, "done");
  assert.ok(["pizza", "tacos", "sushi"].includes(m.result.picked_option));
});

test("tier 5: judge picks a winner; submissions stay hidden until done", async () => {
  const realFetch = globalThis.fetch;
  let sentBody = "";
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBody = init.body;
    return new Response(JSON.stringify({ content: [{ type: "text", text: '{"winner":"beta","rule_applied":"Pick the cheaper plan","reasoning":"Beta is cheaper, which the rules rank first."}' }] }));
  }) as any;
  try {
    const r = newRoom({ ANTHROPIC_API_KEY: "test" });
    const id = randomToken(12);
    const created = await r.call("create", { id, input: { tier: "judge", seats: ["alpha", "beta"], rules: "Pick the cheaper plan; if tied, the faster one." } });
    // judge setup is committed and visible before anyone pays
    const { judgeCommitment } = await import("../src/judge.ts");
    const expected = await judgeCommitment("claude-haiku-5-5");
    assert.deepEqual(created.body.judge, expected);
    assert.match(expected.prompt_sha256, /^[0-9a-f]{64}$/);
    const t: Record<string, string> = {};
    for (const s of ["alpha", "beta"]) t[s] = (await r.call("join", { seat: s, tier: "judge", role: "party", paid: true })).body.seat_token;
    const first = await r.call("submit", { seat: "alpha", seat_token: t.alpha, position: "Plan A: $40" });
    assert.equal(JSON.stringify(first.body).includes("Plan A"), false, "submission leaked before judging");
    const done = await r.call("submit", { seat: "beta", seat_token: t.beta, position: "Plan B: $35" });
    assert.equal(done.body.match.phase, "done");
    assert.equal(done.body.match.result.winner, "beta");
    assert.equal(done.body.match.result.rule_applied, "Pick the cheaper plan");
    assert.deepEqual(done.body.match.receipt.payload.proof.judge, expected);
    const sent = JSON.parse(sentBody);
    assert.equal(sent.temperature, undefined, "current models reject a temperature setting");
    assert.equal(sent.model, "claude-haiku-5-5");
    assert.ok(sentBody.includes("Plan A") && sentBody.includes("Plan B"));
    assert.equal(await verifyReceipt(done.body.match.receipt, keys.PUBLIC_KEY), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("security: wrong token, wrong reveal, stolen seat, wrong tier route", async () => {
  const r = await setup({ tier: "rps", seats: ["alpha", "beta"] }, [["alpha", "rps"]]);
  assert.equal((await r.call("join", { seat: "alpha", tier: "rps", role: "party" })).status, 409);
  assert.equal((await r.call("join", { seat: "beta", tier: "judge", role: "party" })).status, 400);
  const b = await r.call("join", { seat: "beta", tier: "rps", role: "party" });
  const bt = b.body.seat_token;
  const c = await commitmentOf("rock", "n".repeat(16));
  assert.equal((await r.call("commit", { seat: "alpha", seat_token: bt, commitment: c })).status, 403);
  await r.call("commit", { seat: "alpha", seat_token: r.tokens.alpha, commitment: c });
  await r.call("commit", { seat: "beta", seat_token: bt, commitment: await commitmentOf("paper", "m".repeat(16)) });
  // alpha tries to change their move after committing
  const cheat = await r.call("reveal", { seat: "alpha", seat_token: r.tokens.alpha, value: "scissors", nonce: "n".repeat(16) });
  assert.equal(cheat.status, 400);
  // unrevealed values are never visible in status
  await r.call("reveal", { seat: "beta", seat_token: bt, value: "paper", nonce: "m".repeat(16) });
  const st = await r.call("status");
  assert.equal(JSON.stringify(st.body).includes("paper"), false);
});

test("forfeit: a party that won't reveal loses after the deadline", async () => {
  const r = await setup({ tier: "rps", seats: ["alpha", "beta"] }, [["alpha", "rps"], ["beta", "rps"]]);
  const na = "a".repeat(16), nb = "b".repeat(16);
  await r.call("commit", { seat: "alpha", seat_token: r.tokens.alpha, commitment: await commitmentOf("rock", na) });
  await r.call("commit", { seat: "beta", seat_token: r.tokens.beta, commitment: await commitmentOf("paper", nb) });
  await r.call("reveal", { seat: "alpha", seat_token: r.tokens.alpha, value: "rock", nonce: na });
  const realNow = Date.now;
  r.room.now = () => realNow() + 11 * 60_000;
  const st = await r.call("status");
  assert.equal(st.body.phase, "done");
  assert.equal(st.body.result.winner, "alpha");
  assert.equal(st.body.result.by_forfeit, true);
});

test("validation rejects bad matches", async () => {
  const r = newRoom();
  const bad = [
    { tier: "rps", seats: ["a"] },
    { tier: "weighted", seats: ["a", "b"], weights: { a: 70 } },
    { tier: "draw", seats: ["a", "b"], options: ["only one"] },
    { tier: "judge", seats: ["a", "b"] },
    { tier: "rps", seats: ["a", "mediator"] },
    { tier: "lottery", seats: ["a", "b"] },
  ];
  for (const input of bad) assert.equal((await r.call("create", { id: randomToken(12), input })).status, 400, JSON.stringify(input));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});

test("shared key: both agents land in the same match without passing an id", async () => {
  const { idForKey } = await import("../src/logic.ts");
  const r = newRoom();
  const key = "order-5521-delivery";
  const id = await idForKey(key);
  const spec = { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 70, beta: 30 }, key };
  const a = await r.call("create", { id, input: spec });
  assert.equal(a.status, 201);
  // second agent: same key + same settings (seat order and title don't matter) -> same match
  const b = await r.call("create", { id, input: { ...spec, seats: ["beta", "alpha"], title: "hi" } });
  assert.equal(b.status, 200);
  assert.equal(b.body.existing, true);
  assert.equal(b.body.match_id, id);
  // different settings with the same key are refused, never silently merged
  const c = await r.call("create", { id, input: { ...spec, weights: { alpha: 90, beta: 10 } } });
  assert.equal(c.status, 409);
  // draw: mediator seat is added automatically and must not break the comparison
  const r2 = newRoom();
  const dspec = { tier: "draw", seats: ["p", "q"], options: ["x", "y"], key: "team-standup-42" };
  const did = await idForKey(dspec.key);
  assert.equal((await r2.call("create", { id: did, input: dspec })).status, 201);
  assert.equal((await r2.call("create", { id: did, input: dspec })).status, 200);
  // bad keys rejected
  assert.equal((await newRoom().call("create", { id: randomToken(12), input: { ...spec, key: "a b" } })).status, 400);
});

test("seat wallet locks: only the reserved wallet can claim a seat", async () => {
  const A = "0x" + "a".repeat(40), B = "0x" + "B".repeat(40), EVIL = "0x" + "e".repeat(40);
  const r = newRoom();
  const id = randomToken(12);
  const created = await r.call("create", { id, input: { tier: "rps", seats: ["alpha", "beta"], seat_wallets: { alpha: A, beta: B } } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.seat_wallets, { alpha: A, beta: B.toLowerCase() });
  // a stranger who learned the match id is refused (an error status means no charge)
  const stolen = await r.call("join", { seat: "beta", tier: "rps", role: "party", paid: true, payer: EVIL });
  assert.equal(stolen.status, 403);
  const ja = await r.call("join", { seat: "alpha", tier: "rps", role: "party", paid: true, payer: A });
  const jb = await r.call("join", { seat: "beta", tier: "rps", role: "party", paid: true, payer: B.toLowerCase() });
  assert.equal(ja.status, 200);
  assert.equal(jb.status, 200);
  const m = await playRound(r, { alpha: ja.body.seat_token, beta: jb.body.seat_token }, { alpha: "rock", beta: "scissors" });
  assert.deepEqual(m.receipt.payload.paid_by, { alpha: A, beta: B.toLowerCase() });
  assert.equal(await verifyReceipt(m.receipt, keys.PUBLIC_KEY), true);
  // draw party seats are free, so they can't be wallet-locked; the mediator seat can
  const bad = await newRoom().call("create", { id: randomToken(12), input: { tier: "draw", seats: ["p", "q"], options: ["x", "y"], seat_wallets: { p: A } } });
  assert.equal(bad.status, 400);
  const ok = await newRoom().call("create", { id: randomToken(12), input: { tier: "draw", seats: ["p", "q"], options: ["x", "y"], seat_wallets: { mediator: A } } });
  assert.equal(ok.status, 201);
});

test("payer is read from a verified x402 payment header", async () => {
  const { payerFromPaymentHeader } = await import("../src/logic.ts");
  const from = "0x" + "c".repeat(40);
  const header = btoa(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0x", authorization: { from, to: "0x0" } } }));
  assert.equal(payerFromPaymentHeader(header), from);
  assert.equal(payerFromPaymentHeader("not-base64!"), undefined);
  assert.equal(payerFromPaymentHeader(undefined), undefined);
});

test("records, badges and private records", async () => {
  const { Ledger } = await import("../src/ledger.ts");
  const ldata = new Map<string, unknown>();
  const ledger = new Ledger({ storage: {
    async get(k: string) { return ldata.has(k) ? structuredClone(ldata.get(k)) : undefined; },
    async put(k: string, v: unknown) { ldata.set(k, structuredClone(v)); },
    async deleteAll() { ldata.clear(); }, async setAlarm() {},
  } } as any, {} as any);
  const LEDGER = { idFromName: () => "g", get: () => ({ fetch: (u: string, i?: any) => ledger.fetch(new Request(u, i)) }) };
  const L = (action: string, q = "") => ledger.fetch(new Request(`https://ledger/${action}${q}`)).then((r) => r.json() as any);

  const A = "0x" + "1".repeat(40), B = "0x" + "2".repeat(40);
  // A beats B six times in a row (A: hot streak; B: good sport)
  let last: any;
  for (let i = 0; i < 6; i++) {
    const r = newRoom({ LEDGER });
    const id = randomToken(12);
    await r.call("create", { id, input: { tier: "rps", seats: ["alpha", "beta"] } });
    const ja = await r.call("join", { seat: "alpha", tier: "rps", role: "party", paid: true, payer: A });
    const jb = await r.call("join", { seat: "beta", tier: "rps", role: "party", paid: true, payer: B });
    last = await playRound(r, { alpha: ja.body.seat_token, beta: jb.body.seat_token }, { alpha: "paper", beta: "rock" });
  }
  const a = await L("agent", `?wallet=${A}`);
  const b = await L("agent", `?wallet=${B}`);
  assert.equal(a.luck_wins, 6);
  assert.equal(b.luck_losses, 6);
  assert.ok(a.badges.some((x: any) => x.id === "hot-streak"));
  assert.ok(b.badges.some((x: any) => x.id === "good-sport"));
  // standings ride along in the signed receipt
  assert.deepEqual(last.receipt.payload.standings[B].badges, ["Good Sport"]);
  assert.equal(await verifyReceipt(last.receipt, keys.PUBLIC_KEY), true);

  // privacy: B hides its record; lookups and future receipts stop showing it
  await ledger.fetch(new Request("https://ledger/privacy", { method: "POST", body: JSON.stringify({ wallet: B, private: true }) }));
  const hidden = await L("agent", `?wallet=${B}`);
  assert.equal(hidden.private, true);
  assert.equal(hidden.luck_losses, undefined);

  // a wallet playing itself never counts
  const r = newRoom({ LEDGER });
  const id = randomToken(12);
  await r.call("create", { id, input: { tier: "rps", seats: ["alpha", "beta"] } });
  const s1 = await r.call("join", { seat: "alpha", tier: "rps", role: "party", paid: true, payer: A });
  const s2 = await r.call("join", { seat: "beta", tier: "rps", role: "party", paid: true, payer: A });
  await playRound(r, { alpha: s1.body.seat_token, beta: s2.body.seat_token }, { alpha: "paper", beta: "rock" });
  assert.equal((await L("agent", `?wallet=${A}`)).luck_wins, 6);
});

test("seat recovery: an agent that paid but lost its token gets the seat back, free", async () => {
  const r = await setup({ tier: "rps", seats: ["alpha", "beta"] }, []);
  const ja = await r.call("join", { seat: "alpha", tier: "rps", role: "party", paid: true, payment_hash: "h-alpha" });
  const jb = await r.call("join", { seat: "beta", tier: "rps", role: "party", paid: true, payment_hash: "h-beta" });
  assert.equal(ja.status, 200);
  // alpha "loses" its token, recovers with its payment proof
  assert.equal((await r.call("recover", { payment_hash: "wrong" })).status, 404);
  const rec = await r.call("recover", { payment_hash: "h-alpha" });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.seat, "alpha");
  const fresh = rec.body.seat_token;
  // the old token no longer works; the new one does
  const c = await commitmentOf("rock", "n".repeat(16));
  assert.equal((await r.call("commit", { seat: "alpha", seat_token: ja.body.seat_token, commitment: c })).status, 403);
  assert.equal((await r.call("commit", { seat: "alpha", seat_token: fresh, commitment: c })).status, 200);
  const m = await playRound(r, { beta: jb.body.seat_token }, { beta: "scissors" }).catch(() => null);
  await r.call("reveal", { seat: "alpha", seat_token: fresh, value: "rock", nonce: "n".repeat(16) });
  const st = await r.call("status");
  assert.equal(st.body.phase, "done");
  assert.equal(st.body.result.winner, "alpha");
  // after the match ends, recovery just points to the public result
  const after = await r.call("recover", { payment_hash: "h-beta" });
  assert.equal(after.body.seat_token, undefined);
  assert.equal(after.body.match.phase, "done");
});

test("desertion before committing or submitting: the side that acted wins by forfeit", async () => {
  const later = () => Date.now() + 11 * 60_000;
  // rps: alpha commits, beta walks away
  {
    const r = await setup({ tier: "rps", seats: ["alpha", "beta"] }, [["alpha", "rps"], ["beta", "rps"]]);
    await r.call("commit", { seat: "alpha", seat_token: r.tokens.alpha, commitment: await commitmentOf("rock", "a".repeat(16)) });
    const before = await r.call("status");
    assert.ok(before.body.action_deadline);
    r.room.now = later;
    const st = await r.call("status");
    assert.equal(st.body.phase, "done");
    assert.equal(st.body.result.winner, "alpha");
    assert.deepEqual(st.body.result.forfeited, ["beta"]);
  }
  // nobody commits: expires, both forfeit
  {
    const r = await setup({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 } }, [["alpha", "weighted"], ["beta", "weighted"]]);
    r.room.now = later;
    assert.equal((await r.call("status")).body.phase, "expired");
  }
  // judge: alpha submits, beta never does -> alpha wins without calling the judge
  {
    const r = newRoom({ ANTHROPIC_API_KEY: "x" });
    const id = randomToken(12);
    await r.call("create", { id, input: { tier: "judge", seats: ["alpha", "beta"], rules: "Pick the cheaper plan, please." } });
    const t: Record<string, string> = {};
    for (const s of ["alpha", "beta"]) t[s] = (await r.call("join", { seat: s, tier: "judge", role: "party", paid: true })).body.seat_token;
    await r.call("submit", { seat: "alpha", seat_token: t.alpha, position: "Plan A $40" });
    r.room.now = later;
    const st = await r.call("status");
    assert.equal(st.body.phase, "done");
    assert.equal(st.body.result.winner, "alpha");
    assert.equal(st.body.result.by_forfeit, true);
  }
  // draw: one party walks away before committing; the draw continues without it
  {
    const r = newRoom();
    const id = randomToken(12);
    await r.call("create", { id, input: { tier: "draw", seats: ["p", "q", "z"], options: ["x", "y", "w"] } });
    const t: Record<string, string> = {};
    t.mediator = (await r.call("join", { seat: "mediator", tier: "draw", role: "mediator", paid: true })).body.seat_token;
    for (const s of ["p", "q", "z"]) t[s] = (await r.call("join", { seat: s, tier: "draw", role: "party" })).body.seat_token;
    const vals: Record<string, string> = { mediator: randomToken(16), p: randomToken(16), q: randomToken(16) };
    const nonces: Record<string, string> = {};
    for (const s of Object.keys(vals)) {
      nonces[s] = randomToken(16);
      await r.call("commit", { seat: s, seat_token: t[s], commitment: await commitmentOf(vals[s], nonces[s]) });
    }
    const realNow = Date.now;
    r.room.now = later;
    const mid = await r.call("status");
    assert.equal(mid.body.phase, "reveal");
    assert.deepEqual(mid.body.excluded, ["z"]);
    r.room.now = () => realNow() + 12 * 60_000;
    for (const s of Object.keys(vals)) await r.call("reveal", { seat: s, seat_token: t[s], value: vals[s], nonce: nonces[s] });
    const st = await r.call("status");
    assert.equal(st.body.phase, "done");
    assert.deepEqual(st.body.result.forfeited, ["z"]);
  }
});

test("no-shows cost nothing: a paid join waits for the other seat, and is released (uncharged) if nobody comes", async () => {
  // opponent arrives while the first agent waits -> both seated
  {
    const r = newRoom({ JOIN_WAIT_SECONDS: "5" });
    const id = randomToken(12);
    await r.call("create", { id, input: { tier: "rps", seats: ["alpha", "beta"] } });
    const first = r.room.fetch(new Request("https://match/join", { method: "POST", body: JSON.stringify({ seat: "alpha", tier: "rps", role: "party", paid: true, wait: true }) }));
    await new Promise((ok) => setTimeout(ok, 50));
    const second = await r.room.fetch(new Request("https://match/join", { method: "POST", body: JSON.stringify({ seat: "beta", tier: "rps", role: "party", paid: true, wait: true }) }));
    assert.equal(second.status, 200);
    const a = await first;
    assert.equal(a.status, 200);
    const body: any = await a.json();
    assert.ok(body.seat_token);
    assert.equal(body.match.phase, "commit");
  }
  // nobody comes -> 408 (no settlement, so no charge) and the seat is free again
  {
    const r = newRoom({ JOIN_WAIT_SECONDS: "0.2" });
    const id = randomToken(12);
    await r.call("create", { id, input: { tier: "rps", seats: ["alpha", "beta"] } });
    const lonely = await r.call("join", { seat: "alpha", tier: "rps", role: "party", paid: true, wait: true });
    assert.equal(lonely.status, 408);
    const st = await r.call("status");
    assert.deepEqual(st.body.waiting_on, ["alpha", "beta"]);
    assert.equal((await r.call("join", { seat: "alpha", tier: "rps", role: "party", paid: true })).status, 200);
  }
  // per-match step deadline
  {
    const r = newRoom();
    assert.equal((await r.call("create", { id: randomToken(12), input: { tier: "judge", seats: ["a", "b"], rules: "Pick the better plan.", step_seconds: 30 } })).status, 400);
    const ok = await newRoom().call("create", { id: randomToken(12), input: { tier: "judge", seats: ["a", "b"], rules: "Pick the better plan.", step_seconds: 1800 } });
    assert.equal(ok.body.step_seconds, 1800);
  }
});

test("simultaneous reveals resolve the match exactly once with a valid receipt", async () => {
  for (let i = 0; i < 25; i++) {
    const r = await setup({ tier: "rps", seats: ["alpha", "beta"] }, [["alpha", "rps"], ["beta", "rps"]]);
    const na = randomToken(16), nb = randomToken(16);
    await r.call("commit", { seat: "alpha", seat_token: r.tokens.alpha, commitment: await commitmentOf("rock", na) });
    await r.call("commit", { seat: "beta", seat_token: r.tokens.beta, commitment: await commitmentOf("scissors", nb) });
    const send = (seat: string, value: string, nonce: string) =>
      r.room.fetch(new Request("https://match/reveal", { method: "POST", body: JSON.stringify({ seat, seat_token: r.tokens[seat], value, nonce }) }));
    const [a, b] = await Promise.all([send("alpha", "rock", na), send("beta", "scissors", nb)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const st = await r.call("status");
    assert.equal(st.body.result.winner, "alpha");
    assert.equal(st.body.round, 1);
    assert.equal(await verifyReceipt(st.body.receipt, keys.PUBLIC_KEY), true);
  }
});

test("judge runs outside the lock: status answers while it thinks, and failures can be retried", async () => {
  const realFetch = globalThis.fetch;
  let release!: () => void;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls <= 2) return new Response("overloaded", { status: 529 }); // first attempt fails (2 tries inside runJudge)
    await new Promise<void>((ok) => (release = ok)); // second attempt: slow judge
    return new Response(JSON.stringify({ content: [{ type: "text", text: '{"winner":"alpha","rule_applied":"cheaper wins","reasoning":"A is cheaper."}' }] }));
  }) as any;
  try {
    const r = newRoom({ ANTHROPIC_API_KEY: "x" });
    const id = randomToken(12);
    await r.call("create", { id, input: { tier: "judge", seats: ["alpha", "beta"], rules: "Cheaper plan wins." } });
    const t: Record<string, string> = {};
    for (const s of ["alpha", "beta"]) t[s] = (await r.call("join", { seat: s, tier: "judge", role: "party", paid: true })).body.seat_token;
    await r.call("submit", { seat: "alpha", seat_token: t.alpha, position: "A: $30" });
    const failed = await r.call("submit", { seat: "beta", seat_token: t.beta, position: "B: $40" });
    assert.equal(failed.body.match.phase, "error");
    // retry: the judge is slow this time; status must still answer meanwhile
    const pending = r.room.fetch(new Request("https://match/retry-judge", { method: "POST", body: JSON.stringify({ seat: "alpha", seat_token: t.alpha }) }));
    await new Promise((ok) => setTimeout(ok, 30));
    const mid = await r.room.fetch(new Request("https://match/status"));
    assert.equal(((await mid.json()) as any).phase, "judging");
    release();
    const done: any = await (await pending).json();
    assert.equal(done.match.phase, "done");
    assert.equal(done.match.result.winner, "alpha");
    assert.equal(await verifyReceipt(done.match.receipt, keys.PUBLIC_KEY), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a waiting join wakes immediately when the other seat arrives right after (no missed signal)", async () => {
  for (let i = 0; i < 10; i++) {
    const r = newRoom({ JOIN_WAIT_SECONDS: "5" });
    const id = randomToken(12);
    await r.call("create", { id, input: { tier: "rps", seats: ["alpha", "beta"] } });
    const t0 = Date.now();
    const mk = (seat: string) =>
      r.room.fetch(new Request("https://match/join", { method: "POST", body: JSON.stringify({ seat, tier: "rps", role: "party", paid: true, wait: true }) }));
    const [a, b] = await Promise.all([mk("alpha"), mk("beta")]); // fired back to back, no delay
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  }
});

test("a judge call that never returns becomes retryable after 2 minutes", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise(() => {})) as any; // the AI call hangs forever
  try {
    const r = newRoom({ ANTHROPIC_API_KEY: "x" });
    const id = randomToken(12);
    await r.call("create", { id, input: { tier: "judge", seats: ["alpha", "beta"], rules: "Cheaper plan wins." } });
    const t: Record<string, string> = {};
    for (const s of ["alpha", "beta"]) t[s] = (await r.call("join", { seat: s, tier: "judge", role: "party", paid: true })).body.seat_token;
    await r.call("submit", { seat: "alpha", seat_token: t.alpha, position: "A" });
    r.room.fetch(new Request("https://match/submit", { method: "POST", body: JSON.stringify({ seat: "beta", seat_token: t.beta, position: "B" }) })); // never resolves
    await new Promise((ok) => setTimeout(ok, 20));
    assert.equal((await r.call("status")).body.phase, "judging");
    const realNow = Date.now;
    r.room.now = () => realNow() + 3 * 60_000;
    const st = await r.call("status");
    assert.equal(st.body.phase, "error");
    assert.match(st.body.error, /retry-judge/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a shared-key mismatch names exactly what differs (e.g. a mistyped wallet)", async () => {
  const { idForKey } = await import("../src/logic.ts");
  const r = newRoom();
  const key = "deal-42-typo";
  const id = await idForKey(key);
  const right = "0x" + "a".repeat(40), typo = "0x" + "a".repeat(39) + "b";
  await r.call("create", { id, input: { tier: "rps", seats: ["alpha", "beta"], key, seat_wallets: { beta: typo } } });
  const c = await r.call("create", { id, input: { tier: "rps", seats: ["alpha", "beta"], key, seat_wallets: { beta: right } } });
  assert.equal(c.status, 409);
  assert.deepEqual(c.body.differences, [{ field: "seat_wallets.beta", match_has: typo, you_sent: right }]);
  assert.match(c.body.error, /seat_wallets\.beta/);
});
