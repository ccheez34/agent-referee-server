// Free demo matches: same protocol, no payment, marked demo in everything signed, never recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchRoom } from "../src/match.ts";
import { Ledger } from "../src/ledger.ts";
import { commitmentOf, randomToken, validateCreate, idForKey } from "../src/logic.ts";

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };
// In-memory storage with list/delete, like a real Durable Object's.
export const memList = (d: Map<string, unknown>) => ({
  async get(k: string) { return structuredClone(d.get(k)); },
  async put(k: string, v: unknown) { d.set(k, structuredClone(v)); },
  async delete(k: string | string[]) { for (const x of [k].flat()) d.delete(x); return true; },
  async list(o: { prefix?: string; limit?: number }) { return new Map([...d.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort().slice(0, o.limit ?? 1e9).map((k) => [k, d.get(k)])); },
  async deleteAll() { d.clear(); },
  async setAlarm() {},
});
const mem = () => { const d = new Map(); return { storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); }, async deleteAll() { d.clear(); }, async setAlarm() {} } }; };

function room(env: any = {}) {
  const r = new MatchRoom(mem() as any, { ...keys, ...env } as any);
  const call = async (action: string, body?: unknown) => (await (await r.fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }))).json()) as any;
  return { r, call };
}

test("demo validation: judge and seat locks are refused; demo must be a boolean", () => {
  assert.equal(validateCreate({ tier: "judge", seats: ["a", "b"], rules: "the longer answer wins", demo: true }).ok, false);
  assert.equal(validateCreate({ tier: "weighted", seats: ["a", "b"], weights: { a: 1, b: 1 }, demo: true, seat_wallets: { a: "0x" + "1".repeat(40) } }).ok, false);
  assert.equal(validateCreate({ tier: "rps", seats: ["a", "b"], demo: "yes" }).ok, false);
  const v = validateCreate({ tier: "rps", seats: ["a", "b"], demo: true });
  assert.ok(v.ok && v.value.demo === true);
});

test("demo and paid matches with the same key get different ids", async () => {
  assert.notEqual(await idForKey("task-1"), await idForKey("task-1", true));
});

test("a demo match plays free, everything signed says demo, and the wrong route is refused both ways", async () => {
  // Ledger that would fail the test if a demo match tried to record anything.
  let recorded = 0;
  const LEDGER = { idFromName: () => "g", get: () => ({ fetch: async () => { recorded++; return new Response(JSON.stringify({ records: {} })); } }) };
  const { call } = room({ LEDGER });
  const id = randomToken(12);
  await call("create", { id, input: { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 }, demo: true } });
  assert.equal((await call("status")).demo, true);

  const paidTry = await call("join", { seat: "alpha", tier: "weighted", role: "party", paid: true, payer: "0x" + "2".repeat(40) });
  assert.ok(paidTry.error?.includes("demo"), "a paid join of a demo match is refused, so the payment never settles");

  const a = await call("join", { seat: "alpha", tier: "weighted", role: "party", demo: true });
  const b = await call("join", { seat: "beta", tier: "weighted", role: "party", demo: true });
  assert.ok(a.seat_token && b.seat_token);
  assert.equal(a.ack.payload.demo, true);
  const n = { alpha: "n".repeat(32), beta: "m".repeat(32) };
  const v = { alpha: "seed-alpha-0123456789", beta: "seed-beta-0123456789" };
  for (const s of ["alpha", "beta"] as const) await call("commit", { seat: s, seat_token: s === "alpha" ? a.seat_token : b.seat_token, commitment: await commitmentOf(v[s], n[s]) });
  let last: any;
  for (const s of ["alpha", "beta"] as const) last = await call("reveal", { seat: s, seat_token: s === "alpha" ? a.seat_token : b.seat_token, value: v[s], nonce: n[s] });
  assert.equal(last.match.phase, "done");
  assert.equal(last.match.receipt.payload.demo, true);
  assert.equal(last.ack.payload.demo, true);
  assert.equal(recorded, 0, "demo matches never touch the ledger");

  // And the reverse: a paid match refuses the free demo route.
  const p = room({ LEDGER });
  const pid = randomToken(12);
  await p.call("create", { id: pid, input: { tier: "rps", seats: ["alpha", "beta"] } });
  const freeTry = await p.call("join", { seat: "alpha", tier: "rps", role: "party", demo: true });
  assert.ok(freeTry.error?.includes("paid"), JSON.stringify(freeTry));
  assert.equal((await p.call("status")).demo, undefined);
});

test("a shared key can't switch a match between demo and paid", async () => {
  const { call } = room();
  const id = randomToken(12);
  await call("create", { id, input: { tier: "rps", seats: ["alpha", "beta"], key: "k-123", demo: true } });
  const other = await call("create", { id, input: { tier: "rps", seats: ["alpha", "beta"], key: "k-123" } });
  assert.ok(other.differences?.some((d: any) => d.field === "demo"), JSON.stringify(other));
});

test("the daily demo cap refuses once reached and resets the next day", async () => {
  const l = new Ledger(mem() as any, {} as any);
  const q = async () => (await l.fetch(new Request("https://ledger/demo-quota", { method: "POST", body: JSON.stringify({ limit: 2 }) }))).status;
  assert.deepEqual([await q(), await q(), await q()], [200, 200, 429]);
  l.now = () => Date.now() + 24 * 3600_000;
  assert.equal(await q(), 200);
});

test("one caller can't use up everyone's demos; others still get theirs, and counts reset daily", async () => {
  const d = new Map();
  const st = { storage: memList(d) };
  const l = new Ledger(st as any, {} as any);
  const q = async (caller?: string) => (await l.fetch(new Request("https://ledger/demo-quota", { method: "POST", body: JSON.stringify({ limit: 10, per_caller: 2, caller }) }))).status;
  assert.deepEqual([await q("aaa"), await q("aaa"), await q("aaa")], [200, 200, 429]);
  assert.equal(await q("bbb"), 200); // a different caller isn't affected
  assert.equal(await q(), 200); // no caller (no IP header) falls back to the global cap only
  // A refused caller didn't use up the global count: 4 counted so far.
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(d.get(`dm:${day}`), 4);
  assert.equal(d.get(`dmc:${day}:aaa`), 2, "one small key per caller per day");
  assert.ok(![...d.keys()].some((k) => String(JSON.stringify(d.get(k))).includes(".")), "only hashes and counts are stored");
  l.now = () => Date.now() + 24 * 3600_000;
  assert.equal(await q("aaa"), 200); // next day, fresh
  await l.alarm(); // the cleanup the first request of the day scheduled
  assert.equal([...d.keys()].some((k) => k.includes(day)), false, "yesterday's counts are dropped");
});

test("landing page shows the limitations; llms.txt lists tiers, prices and limits", async () => {
  const { landingHtml, llmsTxt, wantsHtml } = await import("../src/landing.ts");
  const p = { weighted: "$0.015", rps: "$0.01", "rps-bo3": "$0.02", draw: "$0.05", judge: "$0.15", "judge-2": "$0.25", "judge-3": "$0.50" };
  const html = landingHtml(p, "https://agentreferee.ai", "20");
  for (const s of ["Limitations", "One person runs it", "AI judges can be wrong", "fresh wallet starts with a clean record", "Not a wager", "20 a day", "pip install agent-referee-client", "npx -y agent-referee-mcp", "/llms.txt"]) assert.ok(html.includes(s), s);
  const t = llmsTxt(p, "https://agentreferee.ai", "20");
  for (const s of ["# Agent Referee", "judge-3 ($0.50)", "weighted ($0.015)", "https://agentreferee.ai/?format=json", "Client library (Python)", "agent-referee-mcp", "Not a wager"]) assert.ok(t.includes(s), s);
  assert.equal(wantsHtml("text/html", undefined), true);
  assert.equal(wantsHtml("application/json", undefined), false);
});
