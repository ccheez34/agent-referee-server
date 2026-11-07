// USDC_PAUSED (ccheez34, Nov 6, 2026): every route that takes USDC refuses before any other check, with the scope note;
// free reviews, free demo matches and the team allowance keep working. Same harness as routes.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/gate.ts";
import { Health, _resetHealthCaches } from "../src/health.ts";
import { Ledger } from "../src/ledger.ts";
import { MatchRoom } from "../src/match.ts";
import { _clearSnapshots } from "../src/gateclient.ts";
import { SCOPE_NOTE } from "../src/landing.ts";

let app: any = null;
try {
  app = (await import("../src/index.ts")).default;
} catch (e) {
  console.log(`usdc-pause tests skipped (dependencies not installed here): ${String((e as any)?.message ?? e).slice(0, 120)}`);
}
const t = app ? test : test.skip;

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };
const mem = () => {
  const d = new Map<string, unknown>();
  return { storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); }, async delete(k: any) { for (const x of [k].flat()) d.delete(x); return true; }, async list(o: { prefix?: string } = {}) { return new Map([...d.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort().map((k) => [k, structuredClone(d.get(k))])); }, async deleteAll() { d.clear(); }, async setAlarm() {} } };
};
function ns<T extends { fetch(r: Request): Promise<Response> }>(make: () => T) {
  const objs = new Map<string, T>();
  return { objs, idFromName: (x: string) => x, get: (id: string) => ({ fetch: async (u: string, i?: RequestInit) => { if (!objs.has(id)) objs.set(id, make()); return objs.get(id)!.fetch(new Request(u, i)); } }) };
}
const TEAM_TOKEN = "t".repeat(40);
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
    FREE_REVIEW_DAILY_BUDGET_USD: "3.00",
    TEAM_TOKEN,
    TEAM_MEMBERS: "2.0",
    TEAM_MEMBER_DAILY_USD: "0.50",
    TEAM_DAILY_USD: "0.80",
    GATES: ns(() => new Gate(mem() as any)),
    HEALTH: ns(() => new Health(mem() as any)),
    ...extra,
  };
  e.LEDGER = ns(() => new Ledger(mem() as any, e));
  e.MATCHES = ns(() => new MatchRoom(mem() as any, e));
  return e;
}
const PAUSED = { USDC_PAUSED: "true" };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const raw = (e: any, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`https://x${path}`, body === undefined ? { headers } : { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", "cf-ipcountry": "US", ...headers }, body: JSON.stringify(body) }), e, ctx);
const call = async (e: any, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res: Response = await raw(e, path, body, headers);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const review = { task: "Add 2 and 2 and give only the number.", output: "4" };
const pieces = { task: "Two pieces.", pieces: [{ text: "a" }, { text: "b" }] };
const team = { "x-team-token": TEAM_TOKEN, "x-team-member": "2.0" };

t("while USDC is paused, every route that takes USDC refuses first, with the scope note, and nothing is created", async () => {
  const e = env(PAUSED);
  for (const [path, body] of [
    ["/review", review],
    ["/review-3", review],
    ["/review-3x2", pieces],
    ["/review-3x3", pieces],
    ["/join/rps", { match_id: "m", seat: "a" }],
    ["/join/weighted", { match_id: "m", seat: "a" }],
    ["/join/judge-3", { match_id: "m", seat: "a" }],
    ["/join/judge-3x2", { match_id: "m", seat: "a" }], // multiJudgeJoinGuard would answer first ("aren't open yet") if the order broke
    ["/host/join/judge-3x3", { match_id: "m", seat: "a" }],
    ["/join/draw/mediator", { match_id: "m", seat: "mediator" }],
    ["/host/join/judge", { match_id: "m", seat: "a" }],
    ["/settle-up", { wallet: "0x" + "1".repeat(40) }],
    ["/matches", { tier: "rps", seats: ["a", "b"] }],
    ["/matches", { tier: "judge-3", seats: ["a", "b"], rules: "Pick the shorter answer." }],
  ] as const) {
    const r = await call(e, path, body);
    assert.equal(r.status, 503, path);
    assert.equal(r.body.code, "usdc_paused", path);
    assert.equal(r.body.scope, SCOPE_NOTE, path);
    assert.match(r.body.error, /Nothing was charged/, path);
  }
  assert.equal(e.MATCHES.objs.size, 0, "no match was created");
});

t("while USDC is paused, free reviews, free demo matches and the team allowance keep working", async () => {
  const e = env(PAUSED);
  const free = await call(e, "/free/review", review);
  assert.equal(free.status, 200, JSON.stringify(free.body));
  assert.equal(free.body.receipt.payload.funding, "free");
  const teamRun = await call(e, "/team/review", review, team);
  assert.equal(teamRun.status, 200, JSON.stringify(teamRun.body));
  assert.equal(teamRun.body.receipt.payload.funding, "team");
  const demo = await call(e, "/matches", { tier: "rps", seats: ["a", "b"], demo: true });
  assert.equal(demo.status, 201, JSON.stringify(demo.body));
  const party = await call(e, "/join/draw/party", { match_id: "nope", seat: "x" });
  assert.notEqual(party.body?.code, "usdc_paused", "a draw's parties join free, so the guard lets them through");
});

t("without USDC_PAUSED nothing changes: a paid match can be created and nothing says paused", async () => {
  const e = env();
  assert.equal((await call(e, "/matches", { tier: "rps", seats: ["a", "b"] })).status, 201);
  const home = await call(e, "/", undefined, { accept: "application/json" });
  assert.equal(home.body.notice, undefined);
  assert.equal(home.body.scope, SCOPE_NOTE);
});

t("the public descriptions carry the scope note, and say USDC is paused while it is", async () => {
  const e = env({ ...PAUSED, PAYMENTS_ENABLED: "true" });
  const home = await call(e, "/", undefined, { accept: "application/json" });
  assert.equal(home.body.scope, SCOPE_NOTE);
  assert.match(home.body.notice, /Paid use \(USDC\) is paused/);
  const llms = await (await raw(e, "/llms.txt")).text();
  assert.ok(llms.includes(SCOPE_NOTE), "llms.txt has the scope note");
  assert.match(llms, /\*\*Notice:\*\* Paid use \(USDC\) is paused/);
  // This change leaves GET /reviewers as it was (judge-no-claude.test.ts pins it byte for byte); its paid routes refuse above.
  assert.equal((await call(e, "/judge")).body.scope, SCOPE_NOTE);
  const html = await (await raw(e, "/", undefined, { accept: "text/html" })).text();
  assert.ok(html.includes("technical evaluation of AI agents"), "the landing page says what it's for");
  assert.equal((await call(e, "/health")).body.checks.payments, "paused");
});

t("with payments on, a paused paid route answers the pause, never a payment request (402), and takes no reviewer slot", async () => {
  const e = env({ ...PAUSED, PAYMENTS_ENABLED: "true" });
  for (const [path, body] of [["/review", review], ["/review-3", review], ["/review-3x2", pieces], ["/join/rps", { match_id: "m", seat: "a" }], ["/host/join/weighted", { match_id: "m", seat: "a" }]] as const) {
    const r = await call(e, path, body, { "x-payment": "e30=" });
    assert.equal(r.status, 503, path);
    assert.equal(r.body.code, "usdc_paused", path);
  }
  assert.equal(e.GATES.objs.size, 0, "no admission gate (reviewer slot) was touched");
});

t("while USDC is paused, the free review-3, demo joins, the demo invite flow and a demo draw all work", async () => {
  const e = env(PAUSED);
  const ip = { "cf-connecting-ip": "198.51.100.40" };
  assert.equal((await call(e, "/free/review-3", review, ip)).status, 200);
  const m = await call(e, "/matches", { tier: "rps", seats: ["a", "b"], demo: true });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  // A seat waits until every seat is filled, so both join at once.
  const both = await Promise.all(["a", "b"].map((seat) => call(e, "/demo/join/rps", { match_id: m.body.match_id, seat })));
  for (const j of both) assert.ok(j.status < 400, JSON.stringify(j.body));
  const inv = await call(e, "/matches", { tier: "rps", seats: ["a", "b"], demo: true, host_pays: "a" });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const guest = await call(e, "/invite/join", { match_id: inv.body.match_id, invite_token: inv.body.invite.invite_token });
  assert.ok(guest.status < 400, JSON.stringify(guest.body));
  const host = await call(e, "/demo/host/join/rps", { match_id: inv.body.match_id, seat: "a" });
  assert.ok(host.status < 400, JSON.stringify(host.body));
  const d = await call(e, "/matches", { tier: "draw", seats: ["p1", "p2"], options: ["x", "y"], demo: true });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const draw = await Promise.all([
    call(e, "/demo/join/draw/mediator", { match_id: d.body.match_id, seat: "mediator" }),
    call(e, "/demo/join/draw/party", { match_id: d.body.match_id, seat: "p1" }),
    call(e, "/demo/join/draw/party", { match_id: d.body.match_id, seat: "p2" }),
  ]);
  for (const j of draw) assert.ok(j.status < 400, JSON.stringify(j.body));
});

t("a paid draw already running when USDC is paused: its parties still join (they never pay)", async () => {
  const e = env();
  const d = await call(e, "/matches", { tier: "draw", seats: ["p1", "p2"], options: ["x", "y"] });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  e.USDC_PAUSED = "true";
  const party = await call(e, "/join/draw/party", { match_id: d.body.match_id, seat: "p1" });
  assert.notEqual(party.body?.code, "usdc_paused", JSON.stringify(party.body));
  assert.ok(party.status < 400, JSON.stringify(party.body));
});
