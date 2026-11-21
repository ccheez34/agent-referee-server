// The v0.5 client against the real server logic: panels, mistrial, criteria, rematch series.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchRoom } from "../src/match.ts";
import { randomToken, canonicalJson, sha256Hex } from "../src/logic.ts";
// @ts-ignore plain JS client
import { AgentReferee, Seat, verifyOutcome, verifySeries } from "agent-referee-client";

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };

/** The real match rooms behind a fake HTTP service, so the real client can talk to them (no payments). */
function service() {
  const rooms = new Map<string, MatchRoom>();
  const env: any = { ...keys, ANTHROPIC_API_KEY: "test", CLAUDE_JUDGES_ENABLED: "true" };
  const roomFor = (name: string) => {
    if (!rooms.has(name)) {
      const data = new Map<string, unknown>();
      const state = { storage: { async get(k: string) { return structuredClone(data.get(k)); }, async put(k: string, v: unknown) { data.set(k, structuredClone(v)); }, async deleteAll() { data.clear(); }, async setAlarm() {} } };
      rooms.set(name, new MatchRoom(state as any, env));
    }
    return rooms.get(name)!;
  };
  env.MATCHES = { idFromName: (n: string) => n, get: (id: string) => ({ fetch: (u: string, i?: any) => roomFor(id).fetch(new Request(u, i)) }) };
  const call = async (id: string, action: string, body?: unknown) => {
    const r = roomFor(id); // no reset between calls: these requests overlap, like real traffic to one Durable Object
    const res = await r.fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() };
  };
  const payers: Record<string, string> = { alpha: "0x" + "a".repeat(40), beta: "0x" + "b".repeat(40) };
  const fetch = async (url: string, init: any = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    let out;
    if (path === "/matches") {
      const id = randomToken(12);
      out = await call(id, "create", { id, input: body });
    } else if (path.startsWith("/join/")) {
      out = await call(body.match_id, "join", { seat: body.seat, tier: path.slice(6), role: "party", paid: true, payer: payers[body.seat], payments_enabled: true });
    } else {
      const [, , id, action] = path.split("/");
      out = action ? await call(id, action, body) : await call(id, "status");
    }
    return new Response(JSON.stringify(out.body), { status: out.status });
  };
  return { fetch, call };
}

function fakeJudges(replies: Record<string, any>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => {
    const body = JSON.parse(init.body);
    const text = JSON.stringify({ rule_applied: "r", reasoning: "Because.", confidence: "high", ...replies[body.model] });
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }));
  }) as any;
  return () => (globalThis.fetch = realFetch);
}

const H = "claude-haiku-5-5", S = "claude-sonnet-5-5", O = "claude-opus-5-5";

async function judged(spec: any) {
  const svc = service();
  const ref = new AgentReferee({ url: "https://ref.test", fetch: svc.fetch, pollMs: 1, publicKeys: [keys.PUBLIC_KEY] });
  const m = await ref.create(spec);
  const [a, b] = [await ref.join(m.match_id, "alpha"), await ref.join(m.match_id, "beta")];
  const pa = a.submit("Plan A: $40, 2 days");
  const sb = await b.submit("Plan B: $35, 5 days");
  const sa = await pa;
  return { sa, sb, a, b };
}

test("client: judge-3 with criteria; both sides' checks pass and the panel decision is recomputed", async () => {
  const criteria = [{ name: "price", weight: 3 }, { name: "speed", weight: 1 }];
  // haiku's own "winner" field says alpha, but every judge's scores favor beta
  const scoreB = { alpha: { price: 4, speed: 9 }, beta: { price: 8, speed: 3 } };
  const restore = fakeJudges({ [H]: { winner: "alpha", scores: scoreB }, [S]: { winner: "beta", scores: scoreB }, [O]: { winner: "beta", scores: { alpha: { price: 9, speed: 9 }, beta: { price: 1, speed: 1 } } } });
  try {
    const { sa, sb } = await judged({ tier: "judge-3", seats: ["alpha", "beta"], rules: "Best value for the buyer.", criteria });
    assert.equal(sa.result.winner, "beta");
    assert.deepEqual(sa.result.tally, { alpha: 1, beta: 2, mistrial: 0 });
    for (const s of [sa, sb]) assert.deepEqual([s.check.ok, s.check.signed, s.check.problems], [true, true, []], JSON.stringify(s.check));
    assert.ok(sa.check.trusts.some((t: string) => /recomputed/.test(t)));

    // tampering: the service claims alpha won, re-signing nothing -> signature fails; and the recompute catches it offline
    const forged = structuredClone(sa.receipt);
    forged.payload.outcome.winner = "alpha";
    const v = await verifyOutcome(forged);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p: string) => /should be beta/.test(p)), JSON.stringify(v.problems));
    // a vote swapped to a model nobody agreed to
    const swapped = structuredClone(sa.receipt);
    swapped.payload.outcome.votes[2].model = "some-cheap-model";
    assert.ok((await verifyOutcome(swapped)).problems.some((p: string) => /committed panelist/.test(p)));
  } finally {
    restore();
  }
});

test("client: judge-2 split is a mistrial; Seat.mistrial and the check say so", async () => {
  const restore = fakeJudges({ [H]: { winner: "alpha" }, [S]: { winner: "beta" } });
  try {
    const { sa } = await judged({ tier: "judge-2", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." });
    assert.equal(Seat.mistrial(sa), true);
    assert.equal(Seat.won(sa, "alpha"), false);
    assert.equal(sa.check.ok, true, JSON.stringify(sa.check));
    assert.ok(sa.check.trusts.some((t: string) => /Mistrial/.test(t)));
  } finally {
    restore();
  }
});

test("client: a receipt whose scoring criteria differ from what was agreed fails the settings check", async () => {
  const restore = fakeJudges({ [H]: { winner: "alpha", scores: { alpha: { price: 9 }, beta: { price: 1 } } } });
  try {
    const { sa, a } = await judged({ tier: "judge", seats: ["alpha", "beta"], rules: "Pick the cheaper plan.", criteria: [{ name: "price", weight: 2 }] });
    assert.equal(sa.check.ok, true, JSON.stringify(sa.check));
    a.requested = { ...a.requested, criteria: [{ name: "price", weight: 5 }] };
    const v = await verifyOutcome(sa.receipt, { seat: a });
    assert.ok(v.problems.some((p: string) => /scoring criteria/.test(p)));
  } finally {
    restore();
  }
});

test("client: seat.rematch() runs a series; verifySeries checks links and tallies and catches a swapped game", async () => {
  const svc = service();
  const ref = new AgentReferee({ url: "https://ref.test", fetch: svc.fetch, pollMs: 1, publicKeys: [keys.PUBLIC_KEY] });
  const m = await ref.create({ tier: "rps", seats: ["alpha", "beta"] });
  let [a, b] = [await ref.join(m.match_id, "alpha"), await ref.join(m.match_id, "beta")];
  const receipts: any[] = [];
  for (let game = 1; game <= 4; game++) {
    const [sa, sb] = await Promise.all([a.play(), b.play()]);
    assert.deepEqual([sa.check.ok, sb.check.ok], [true, true], JSON.stringify(sa.check));
    assert.equal(sa.tally.games, game);
    receipts.push(sa.receipt);
    if (game < 4) [a, b] = await Promise.all([a.rematch(), b.rematch()]);
  }
  const s = await verifySeries(receipts);
  assert.deepEqual([s.ok, s.problems], [true, []]);
  assert.equal(s.tally.games, 4);
  assert.equal(s.tally.wins.alpha + s.tally.wins.beta + s.tally.no_result, 4);
  assert.deepEqual(s.tally, receipts[3].payload.series.tally);
  // order doesn't matter, and a series checked from the middle uses that game's signed tally
  assert.equal((await verifySeries([...receipts].reverse())).ok, true);
  assert.equal((await verifySeries(receipts.slice(1))).ok, true);
  // a missing game, or a game whose receipt was altered, breaks the chain
  assert.equal((await verifySeries([receipts[0], receipts[2], receipts[3]])).ok, false);
  const altered = structuredClone(receipts);
  altered[1].payload.outcome.winner = altered[1].payload.outcome.winner === "alpha" ? "beta" : "alpha";
  const bad = await verifySeries(altered);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p: string) => /link|tally/.test(p)));
  // the rematch request is acknowledged with a signature
  assert.ok(a.acks.length > 0);
  assert.equal(await sha256Hex(canonicalJson(receipts[2].payload)), receipts[3].payload.series.previous_receipt_sha256);
});

test("client: rematch gives up cleanly if the other side never asks (nothing charged)", async () => {
  const svc = service();
  const ref = new AgentReferee({ url: "https://ref.test", fetch: svc.fetch, pollMs: 1, publicKeys: [keys.PUBLIC_KEY] });
  const m = await ref.create({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 } });
  const [a, b] = [await ref.join(m.match_id, "alpha"), await ref.join(m.match_id, "beta")];
  await Promise.all([a.play(), b.play()]);
  await assert.rejects(a.rematch({ timeoutMs: 30 }), /didn't ask for a rematch/);
});

test("client: when judging fails, submit() retries it for both sides and the match still finishes", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_u: any, init: any) => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } }), { status: 400 });
    const text = JSON.stringify({ winner: "beta", rule_applied: "r", reasoning: "Because.", confidence: "high" });
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }));
  }) as any;
  try {
    const svc = service();
    const ref = new AgentReferee({ url: "https://ref.test", fetch: svc.fetch, pollMs: 1, publicKeys: [keys.PUBLIC_KEY] });
    const m = await ref.create({ tier: "judge", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." });
    const [a, b] = [await ref.join(m.match_id, "alpha"), await ref.join(m.match_id, "beta")];
    const pa = a.submit("Plan A: $40", { retryDelayMs: 1 });
    const sb = await b.submit("Plan B: $35", { retryDelayMs: 1 });
    const sa = await pa;
    for (const s of [sa, sb]) {
      assert.equal(s.phase, "done");
      assert.equal(s.result.winner, "beta");
      assert.equal(s.check.ok, true, JSON.stringify(s.check));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
