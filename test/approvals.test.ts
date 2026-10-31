// The owner-approvals Worker (owner-approvals/; rules-in-code DESIGN part A). Its records are the ones 3.0's gate
// checks (agent-referee-owner-approval-v1, gate/README.md on agent-referee-mcp's gate-v0). These tests need no
// installed packages, so they run anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_FORMAT, ApprovalStore, canonicalJson, handle, keyIdOf, parseApproval, verifyRecord } from "../owner-approvals/src/approvals.ts";
import { PAGE, pageResponse } from "../owner-approvals/src/page.ts";
import { canonicalJson as agentRefereeCanonical } from "../src/logic.ts";

// A stand-in Durable Object state: storage, and blockConcurrencyWhile as a simple queue.
const mem = () => {
  const d = new Map<string, unknown>();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); } },
    blockConcurrencyWhile<T>(f: () => Promise<T>): Promise<T> {
      const run = chain.then(f);
      chain = run.catch(() => {});
      return run;
    },
  };
};
const OWNER = "o".repeat(40);
async function env(extra: Record<string, unknown> = {}) {
  const store = new ApprovalStore(mem());
  return { store, e: { OWNER_TOKEN: OWNER, APPROVALS: { idFromName: (x: string) => x, get: () => ({ fetch: (u: string, i?: RequestInit) => store.fetch(new Request(u, i)) }) }, ...extra } as any };
}
const req = (path: string, body?: unknown, token?: string) =>
  new Request(`https://approvals.example${path}`, body === undefined ? { headers: token ? { authorization: `Bearer ${token}` } : {} } : { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const go = async (e: any, path: string, body?: unknown, token?: string) => {
  const r = await handle(req(path, body, token), e, pageResponse);
  return { status: r.status, headers: r.headers, body: r.headers.get("content-type")?.includes("json") ? ((await r.json()) as any) : await r.text() };
};
const POLICY = "2026-11-01.1";
const COMMIT = "b".repeat(40);
const TARGET = `agent-referee-server:production@${COMMIT}`;
const deploy = { action: "deploy", target: ` ${TARGET} `, max_uses: 1, expires_in_hours: 2 };

// The gate's own shape rules, copied from agent-referee-mcp gate-v0 dce97cf, gate/src/approvals.mjs (shapeProblem),
// so a change on either side shows up here.
const GATE_NONCE = /^[0-9a-f]{24,64}$/;
const GATE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function gateShapeProblem(p: any): string | null {
  if (!p || typeof p !== "object") return "no payload";
  if (p.format !== "agent-referee-owner-approval-v1") return "format";
  if (!GATE_NONCE.test(String(p.nonce ?? ""))) return "nonce";
  const validTime = (v: any) => GATE_ISO.test(String(v ?? "")) && Number.isFinite(Date.parse(v));
  if (!validTime(p.issued_at)) return "issued_at";
  if (p.type === "revocation") return null;
  if (p.type !== "approval") return "type";
  if (typeof p.action !== "string" || !p.action) return "action";
  if (typeof p.target !== "string" || !p.target) return "target";
  if (p.target_sha256 !== null && !/^[0-9a-f]{64}$/.test(String(p.target_sha256))) return "target_sha256";
  if (typeof p.policy_version !== "string") return "policy_version";
  if (!validTime(p.expires_at)) return "expires_at";
  const uses = p.max_uses ?? 1;
  if (!Number.isInteger(uses) || uses < 1 || uses > 20) return "max_uses";
  return null;
}

test("the signed bytes are Agent Referee's canonical JSON, so one verifier works for both", () => {
  for (const v of [{ b: 1, a: [3, { z: null, y: "é" }], c: undefined }, [1, "x", { k: true }], "s", 5, null])
    assert.equal(canonicalJson(v), agentRefereeCanonical(v));
});

test("approval requests: the gate policy's owner-only actions, one exact plain-text target, at most 20 uses and 24 hours", () => {
  const ok = parseApproval(deploy);
  assert.deepEqual(ok, { ok: true, value: { action: "deploy", target: TARGET, target_sha256: null, max_uses: 1, hours: 2 } });
  const hashed = parseApproval({ action: "publish", target: "npm:agent-referee-client@0.11.0", target_sha256: "C".repeat(64), request_id: "r-1234567" });
  assert.deepEqual(hashed, { ok: true, value: { action: "publish", target: "npm:agent-referee-client@0.11.0", target_sha256: "c".repeat(64), max_uses: 1, hours: 2, request_id: "r-1234567" } });
  for (const bad of [
    { ...deploy, action: "merge" },
    { ...deploy, action: "__proto__" },
    { ...deploy, target: "" },
    { ...deploy, target: "x".repeat(201) },
    { ...deploy, target: "two\nlines" },
    { ...deploy, target: "pay​ment" }, // a zero-width space
    { ...deploy, target: "abc‮def" }, // right to left
    { ...deploy, target: "café" },
    { ...deploy, target_sha256: COMMIT },
    { ...deploy, target_sha256: 5 },
    { ...deploy, max_uses: 21 },
    { ...deploy, max_uses: 0 },
    { ...deploy, max_uses: 1.5 },
    { ...deploy, expires_in_hours: 25 },
    { ...deploy, expires_in_hours: 0.1 },
    { ...deploy, expires_in_hours: "2" },
    { ...deploy, request_id: "short" },
    { ...deploy, request_id: "has spaces in it" },
  ])
    assert.equal(parseApproval(bad).ok, false, JSON.stringify(bad));
  for (const empty of [undefined, null, ""]) assert.equal((parseApproval({ ...deploy, target_sha256: empty }) as any).value.target_sha256, null);
});

test("only the owner's token signs; wrong tokens never lock him out; nothing is signed before the policy version is set", async () => {
  const { e } = await env();
  assert.equal((await go(e, "/approve", deploy)).status, 401);
  // Anyone can send wrong tokens all day: the owner still gets through, and so does his revoke (fresh read of c3b0b64, #1).
  for (let i = 0; i < 25; i++) assert.equal((await go(e, "/approve", deploy, "w".repeat(40))).status, 401);
  assert.equal((await go(e, "/approve", deploy, OWNER)).status, 409, "no policy version yet");
  for (const version of ["", "two words", "x".repeat(65), 5]) assert.equal((await go(e, "/policy", { version }, OWNER)).status, 400, String(version));
  assert.equal((await go(e, "/policy", { version: ` ${POLICY} ` }, OWNER)).status, 200);
  assert.equal((await go(e, "/approve", deploy, OWNER)).status, 200);
  const none = await env({ OWNER_TOKEN: undefined });
  assert.match((await go(none.e, "/approve", deploy, OWNER)).body.error, /No owner token/);
  const short = await env({ OWNER_TOKEN: "short" });
  assert.equal((await go(short.e, "/approve", deploy, "short")).status, 401, "a token under 32 characters never works");
});

test("the key is made inside the store, once, and never leaves it; every record carries it and verifies with it", async () => {
  const { e, store } = await env();
  // Two first calls at once still make one key.
  const [k1, k2] = await Promise.all([go(e, "/pubkey"), go(e, "/pubkey")]);
  assert.equal(k1.body.public_key, k2.body.public_key);
  assert.equal(k1.body.key_id, await keyIdOf(k1.body.public_key));
  assert.equal(k1.headers.get("access-control-allow-origin"), "*");
  await go(e, "/policy", { version: POLICY }, OWNER);
  const rec = (await go(e, "/approve", deploy, OWNER)).body.approval;
  assert.equal(rec.public_key, k1.body.public_key, "the envelope's key is the served key (fresh read of c3b0b64, #4)");
  assert.equal(await verifyRecord(rec, k1.body.public_key), true);
  assert.equal((await go(e, "/pubkey")).body.public_key, k1.body.public_key, "the same key later");
  // The store signs; nothing it answers carries the private key (part A review 1).
  const ask = async (action: string, body?: unknown) => (await store.fetch(new Request(`https://store/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }))).json() as Promise<any>;
  const signed = await ask("sign", { payload: { a: 1 } });
  assert.equal(await verifyRecord(signed.record, k1.body.public_key), true);
  for (const out of [signed, await ask("pubkey"), await ask("key"), await ask("list")]) assert.ok(!/"d":/.test(JSON.stringify(out)), "no private key in any answer");
  assert.equal((await ask("key")).error, "Unknown action.");
});

test("an approval is exactly the gate's record: the exact action and target, and it expires", async () => {
  const { e } = await env();
  await go(e, "/policy", { version: POLICY }, OWNER);
  const r = await go(e, "/approve", { ...deploy, max_uses: 3 }, OWNER);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rec = r.body.approval;
  const p = rec.payload;
  assert.deepEqual(Object.keys(p).sort(), ["action", "expires_at", "format", "issued_at", "max_uses", "nonce", "policy_version", "target", "target_sha256", "type"]);
  assert.deepEqual([p.format, p.type, p.action, p.target, p.target_sha256, p.max_uses, p.policy_version], [APPROVAL_FORMAT, "approval", "deploy", TARGET, null, 3, POLICY]);
  assert.equal(gateShapeProblem(p), null);
  assert.equal(Date.parse(p.expires_at) - Date.parse(p.issued_at), 2 * 3_600_000);
  assert.match(p.nonce, /^[0-9a-f]{32}$/);
  assert.equal(rec.algorithm, "Ed25519");
  assert.match(canonicalJson(p), /"target_sha256":null/, "null is signed as null, not dropped: the gate needs the key");
  const pub = (await go(e, "/pubkey")).body.public_key;
  assert.equal(await verifyRecord({ ...rec, payload: { ...p, max_uses: 5 } }, pub), false, "a changed field");
  const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const otherPub = Buffer.from((await crypto.subtle.exportKey("raw", other.publicKey)) as ArrayBuffer).toString("base64");
  assert.equal(await verifyRecord(rec, otherPub), false, "another key");
});

test("a double tap gives the first approval back, not a second one (fresh read of c3b0b64, #3)", async () => {
  const { e } = await env();
  await go(e, "/policy", { version: POLICY }, OWNER);
  const body = { ...deploy, request_id: "tap-0001-abcd" };
  const [a, b] = await Promise.all([go(e, "/approve", body, OWNER), go(e, "/approve", body, OWNER)]);
  assert.equal(a.body.approval.payload.nonce, b.body.approval.payload.nonce);
  const again = await go(e, "/approve", body, OWNER);
  assert.deepEqual([again.body.repeat, again.body.approval.payload.nonce], [true, a.body.approval.payload.nonce]);
  assert.equal((await go(e, "/approvals")).body.approvals.length, 1);
  assert.equal((await go(e, "/approve", { ...body, request_id: "tap-0002-abcd" }, OWNER)).body.approval.payload.nonce === a.body.approval.payload.nonce, false, "a new request id is a new approval");
  // The same id with different fields is refused, not answered with the old approval (part A review 1).
  assert.equal((await go(e, "/approve", { ...body, target: "agent-referee-server:staging" }, OWNER)).status, 409);
});

test("revocations name the approval's nonce; revoke-all; the list is open to anyone, as the gate reads it", async () => {
  const { e } = await env();
  await go(e, "/policy", { version: POLICY }, OWNER);
  const a = (await go(e, "/approve", deploy, OWNER)).body.approval;
  const b = (await go(e, "/approve", { ...deploy, action: "publish", target: "npm:x@1.0.0" }, OWNER)).body.approval;
  assert.equal((await go(e, "/revoke", { nonce: "f".repeat(32) }, OWNER)).status, 404, "a mistyped nonce revokes nothing, and says so");
  assert.equal((await go(e, "/revoke", { nonce: "xyz" }, OWNER)).status, 400);
  assert.equal((await go(e, "/revoke", { nonce: a.payload.nonce })).status, 401, "revoking needs the owner's token too");
  const rv = await go(e, "/revoke", { nonce: a.payload.nonce.toUpperCase() }, OWNER);
  assert.equal(rv.status, 200, JSON.stringify(rv.body));
  const rp = rv.body.revocation.payload;
  assert.deepEqual(rp, { format: APPROVAL_FORMAT, type: "revocation", nonce: a.payload.nonce, issued_at: rp.issued_at });
  assert.equal(gateShapeProblem(rp), null);
  const status = await go(e, "/status", {}, OWNER);
  assert.deepEqual(status.body.live.map((r: any) => r.payload.nonce), [b.payload.nonce], "the revoked one isn't live");
  // Revoking it again gives the same revocation back and adds nothing (part A review 1).
  const again = await go(e, "/revoke", { nonce: a.payload.nonce }, OWNER);
  assert.deepEqual(again.body.revocation, rv.body.revocation);
  const all = await go(e, "/revoke", { all: true }, OWNER);
  assert.equal(all.body.revoked, 1);
  assert.deepEqual((await go(e, "/status", {}, OWNER)).body.live, []);
  const list = await go(e, "/approvals");
  assert.equal(list.status, 200);
  assert.deepEqual([list.body.approvals.map((r: any) => r.payload.type), list.body.policy_version], [["approval", "approval", "revocation", "revocation"], POLICY]);
  assert.equal((await go(e, "/status", {})).status, 401, "the owner's status needs his token");
});

test("freeze: the list answers 503 so every gate refuses, nothing new is signed, and revoking still works", async () => {
  const { e, store } = await env();
  await go(e, "/policy", { version: POLICY }, OWNER);
  const a = (await go(e, "/approve", deploy, OWNER)).body.approval;
  assert.equal((await go(e, "/freeze", { on: "yes" }, OWNER)).status, 400);
  assert.equal((await go(e, "/freeze", { on: true })).status, 401);
  assert.deepEqual((await go(e, "/freeze", { on: true }, OWNER)).body, { frozen: true });
  const list = await go(e, "/approvals");
  assert.deepEqual([list.status, list.body.code], [503, "frozen"]);
  assert.equal((await go(e, "/approve", deploy, OWNER)).status, 409);
  assert.equal((await go(e, "/revoke", { nonce: a.payload.nonce }, OWNER)).status, 200);
  assert.equal((await go(e, "/status", {}, OWNER)).body.frozen, true);
  // A freeze that lands after the Worker's own check still stops the new approval in the store (part A review 1).
  const late = await (await store.fetch(new Request("https://store/add", { method: "POST", body: JSON.stringify({ record: { payload: { type: "approval", nonce: "e".repeat(32), expires_at: new Date(Date.now() + 3_600_000).toISOString() } } }) }))).json();
  assert.deepEqual(late, { frozen: true });
  await go(e, "/freeze", { on: false }, OWNER);
  assert.equal((await go(e, "/approvals")).status, 200);
  assert.equal((await go(e, "/approvals")).body.approvals.length, 2, "the late approval wasn't stored");
});

test("the store keeps approvals 7 days past expiry and revocations 8 days past issue, so a revocation outlives its approval", async () => {
  const { e, store } = await env();
  await go(e, "/policy", { version: POLICY }, OWNER);
  const a = (await go(e, "/approve", { ...deploy, expires_in_hours: 2 }, OWNER)).body.approval;
  await go(e, "/revoke", { nonce: a.payload.nonce }, OWNER);
  const types = async () => (await go(e, "/approvals")).body.approvals.map((r: any) => r.payload.type);
  const h = 3_600_000;
  store.now = () => Date.now() + 7 * 24 * h + 1 * h; // 7 days and 1 hour later: both kept (it expired after 2 hours)
  assert.deepEqual(await types(), ["approval", "revocation"]);
  store.now = () => Date.now() + 7 * 24 * h + 3 * h; // the approval is gone (7 days past its expiry); its revocation isn't
  assert.deepEqual(await types(), ["revocation"]);
  store.now = () => Date.now() + 8 * 24 * h + 60_000;
  assert.deepEqual(await types(), []);
});

test("the page needs no token, loads nothing from elsewhere, never stores the token, and never renders HTML from answers", async () => {
  const { e } = await env();
  const r = await go(e, "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy")!, /default-src 'none'.*connect-src 'self'/);
  assert.ok(!/https?:\/\//.test(r.body), "no outside URLs");
  assert.ok(!/localStorage|sessionStorage|document\.cookie|innerHTML|insertAdjacentHTML|document\.write/.test(PAGE));
  assert.match(PAGE, /b\.disabled=on/, "buttons are off while a request is out");
  assert.match(PAGE, /request_id:rid/, "a repeated Sign sends the same request id");
  assert.equal((await go(e, "/nope")).status, 404);
});
