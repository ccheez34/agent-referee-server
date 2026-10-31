// Judging under load: admission gates, automatic retries, the retry limit, and the refund list for unjudged matches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchRoom, MAX_JUDGE_RUNS } from "../src/match.ts";
import { Gate } from "../src/gate.ts";
import { Health } from "../src/health.ts";
import { randomToken } from "../src/logic.ts";
import { _clearSnapshots } from "../src/gateclient.ts";

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };

const mem = () => {
  const d = new Map<string, unknown>();
  const alarms: number[] = [];
  return {
    d,
    alarms,
    storage: {
      async get(k: string) { return structuredClone(d.get(k)); },
      async put(k: string, v: unknown) { d.set(k, structuredClone(v)); },
      async deleteAll() { d.clear(); },
      async setAlarm(t: number) { alarms.push(t); },
    },
  };
};

function ns<T extends { fetch(r: Request): Promise<Response> }>(make: () => T) {
  const objs = new Map<string, T>();
  return { objs, idFromName: (n: string) => n, get: (id: string) => ({ fetch: (u: string, i?: RequestInit) => (objs.has(id) || objs.set(id, make()), objs.get(id)!.fetch(new Request(u, i))) }) };
}

function world(extra: Record<string, unknown> = {}) {
  _clearSnapshots();
  const env: any = { ...keys, ANTHROPIC_API_KEY: "test", CLAUDE_JUDGES_ENABLED: "true", GATES: ns(() => new Gate(mem() as any)), HEALTH: ns(() => new Health(mem() as any)), ...extra };
  const rooms = new Map<string, { room: MatchRoom; st: ReturnType<typeof mem> }>();
  const roomFor = (id: string) => {
    if (!rooms.has(id)) {
      const st = mem();
      rooms.set(id, { room: new MatchRoom(st as any, env), st });
    }
    return rooms.get(id)!;
  };
  const call = async (id: string, action: string, body?: unknown) => {
    const { room } = roomFor(id);
    room.m = undefined;
    const res = await room.fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as any };
  };
  return { env, call, roomFor };
}

let answer: "ok" | "fail" = "ok";
let judgeCalls = 0;
const realFetch = globalThis.fetch;
function fakeJudge() {
  judgeCalls = 0;
  globalThis.fetch = (async () => {
    judgeCalls++;
    if (answer === "fail") return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }); // not retried within a run
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ winner: "alpha", confidence: "high", rule_applied: "r", reasoning: "Because." }) }] }));
  }) as any;
}

async function judgeMatch(w: ReturnType<typeof world>) {
  const id = randomToken(12);
  assert.equal((await w.call(id, "create", { id, input: { tier: "judge", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." } })).status, 201);
  const t: Record<string, string> = {};
  for (const s of ["alpha", "beta"]) t[s] = (await w.call(id, "join", { seat: s, tier: "judge", role: "party", paid: true, payer: `0x${s === "alpha" ? "a" : "b"}`.padEnd(42, "0"), payment_hash: `h-${s}` })).body.seat_token;
  await w.call(id, "submit", { seat: "alpha", seat_token: t.alpha, position: "Plan A" });
  const done = await w.call(id, "submit", { seat: "beta", seat_token: t.beta, position: "Plan B" });
  return { id, t, done: done.body };
}

test("no judge slot free: nothing is called, the match says busy, and it judges itself once a slot frees up", async () => {
  fakeJudge();
  answer = "ok";
  try {
    const w = world({ GATE_SLOTS_ANTHROPIC_CLAUDE_HAIKU_5_5: "1" });
    // Someone else holds the only Haiku slot.
    const hold: any = await (await w.env.GATES.get("anthropic:claude-haiku-5-5").fetch("https://gate/acquire", { method: "POST", body: JSON.stringify({ n: 1, slots: 1, lease_ms: 600_000 }) })).json();
    const { id, done } = await judgeMatch(w);
    assert.equal(done.match.phase, "error");
    assert.equal(done.match.error_code, "judges_busy");
    assert.match(done.match.error, /retries judging on its own/);
    assert.ok(done.match.retry_at);
    assert.equal(judgeCalls, 0, "no AI call while busy");
    assert.equal(done.match.judge_runs, undefined, "a busy refusal doesn't count as a try");
    // The slot frees up; the room's own alarm runs the retry.
    await w.env.GATES.get("anthropic:claude-haiku-5-5").fetch("https://gate/release", { method: "POST", body: JSON.stringify({ entries: [{ token: hold.tokens[0], outcome: "ok" }] }) });
    _clearSnapshots();
    const { room } = w.roomFor(id);
    room.m = undefined;
    room.now = () => Date.now() + 10 * 60_000;
    await room.alarm();
    room.now = () => Date.now();
    const after = await w.call(id, "status");
    assert.equal(after.body.phase, "done");
    assert.equal(after.body.result.winner, "alpha");
    assert.equal(judgeCalls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test(`judging that keeps failing stops after ${MAX_JUDGE_RUNS} tries and puts the payers on the refund list`, async () => {
  fakeJudge();
  answer = "fail";
  try {
    const w = world();
    const { id, t, done } = await judgeMatch(w);
    assert.equal(done.match.error_code, "judge_failed");
    assert.equal(done.match.judge_runs, 1);
    for (let i = 2; i <= MAX_JUDGE_RUNS; i++) await w.call(id, "retry-judge", { seat: "alpha", seat_token: t.alpha });
    const st = await w.call(id, "status");
    assert.equal(st.body.error_code, "unjudged");
    assert.equal(st.body.judge_runs, MAX_JUDGE_RUNS);
    assert.match(st.body.error, /refund list/);
    const again = await w.call(id, "retry-judge", { seat: "alpha", seat_token: t.alpha });
    assert.equal(again.status, 409);
    assert.equal(judgeCalls, MAX_JUDGE_RUNS, "no AI calls after the limit");
    const list: any = await (await w.env.HEALTH.get("global").fetch("https://health/unjudged")).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].match_id, id);
    assert.deepEqual(list[0].payers.map((p: any) => p.seat).sort(), ["alpha", "beta"]);
    assert.ok(list[0].payers.every((p: any) => p.wallet && p.payment_hash));
    // Deleting the match later doesn't list it twice.
    const { room } = w.roomFor(id);
    room.m = undefined;
    room.now = () => Date.now() + 8 * 24 * 3600_000;
    await room.alarm();
    const list2: any = await (await w.env.HEALTH.get("global").fetch("https://health/unjudged")).json();
    assert.equal(list2.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a stale retry alarm after the match finished doesn't delete it early", async () => {
  fakeJudge();
  answer = "fail";
  try {
    const w = world();
    const { id, t } = await judgeMatch(w);
    answer = "ok";
    const ok = await w.call(id, "retry-judge", { seat: "alpha", seat_token: t.alpha });
    assert.equal(ok.body.match.phase, "done");
    const { room } = w.roomFor(id);
    room.m = undefined;
    room.now = () => Date.now() + 10 * 60_000; // the old retry time
    await room.alarm();
    room.now = () => Date.now();
    const st = await w.call(id, "status");
    assert.equal(st.status, 200);
    assert.equal(st.body.phase, "done", "still there, still done");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a match that never got to judging isn't put on the refund list when it's deleted", async () => {
  const w = world();
  const id = randomToken(12);
  await w.call(id, "create", { id, input: { tier: "judge", seats: ["alpha", "beta"], rules: "Pick the cheaper plan." } });
  await w.call(id, "join", { seat: "alpha", tier: "judge", role: "party", paid: true, payer: "0x" + "a".repeat(40) });
  const { room } = w.roomFor(id);
  room.m = undefined;
  room.now = () => Date.now() + 8 * 24 * 3600_000;
  await room.alarm();
  const list: any = await (await w.env.HEALTH.get("global").fetch("https://health/unjudged")).json();
  assert.equal(list.length, 0);
});
