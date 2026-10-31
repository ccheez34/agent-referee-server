// The owner-approvals Worker (owner-approvals/; rules-in-code DESIGN part A). Its records are the ones 3.0's gate
// checks (agent-referee-owner-approval-v1, gate/README.md on agent-referee-mcp's gate-v0). These tests need no
// installed packages, so they run anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_FORMAT, ApprovalStore, _resetFailures, canonicalJson, handle, keyIdOf, parseApproval, verifyRecord } from "../owner-approvals/src/approvals.ts";
import { pageResponse } from "../owner-approvals/src/page.ts";
import { canonicalJson as agentRefereeCanonical } from "../src/logic.ts";

const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
async function keys() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { APPROVALS_SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), APPROVALS_PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };
}
const mem = () => {
  const d = new Map<string, unknown>();
  return { storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); } } };
};
const OWNER = "o".repeat(40);
async function env(extra: Record<string, unknown> = {}) {
  _resetFailures();
  const store = new ApprovalStore(mem());
  return { store, e: { ...(await keys()), OWNER_TOKEN: OWNER, APPROVALS: { idFromName: (x: string) => x, get: () => ({ fetch: (u: string, i?: RequestInit) => store.fetch(new Request(u, i)) }) }, ...extra } as any };
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

test("approval requests: the gate policy's owner-only actions, one exact target, at most 20 uses and 24 hours", () => {
  const ok = parseApproval(deploy);
  assert.deepEqual(ok, { ok: true, value: { action: "deploy", target: TARGET, target_sha256: null, max_uses: 1, hours: 2 } });
  const hashed = parseApproval({ action: "publish", target: "npm:agent-referee-client@0.11.0", target_sha256: "C".repeat(64) });
  assert.deepEqual(hashed, { ok: true, value: { action: "publish", target: "npm:agent-referee-client@0.11.0", target_sha256: "c".repeat(64), max_uses: 1, hours: 2 } });
  for (const bad of [
    { ...deploy, action: "merge" },
    { ...deploy, action: "__proto__" },
    { ...deploy, target: "" },
    { ...deploy, target: "x".repeat(201) },
    { ...deploy, target: "two\nlines" },
    { ...deploy, target_sha256: COMMIT },
    { ...deploy, target_sha256: 5 },
    { ...deploy, max_uses: 21 },
    { ...deploy, max_uses: 0 },
    { ...deploy, max_uses: 1.5 },
    { ...deploy, expires_in_hours: 25 },
    { ...deploy, expires_in_hours: 0.1 },
    { ...deploy, expires_in_hours: "2" },
  ])
    assert.equal(parseApproval(bad).ok, false, JSON.stringify(bad));
  for (const empty of [undefined, null, ""]) assert.equal((parseApproval({ ...deploy, target_sha256: empty }) as any).value.target_sha256, null);
});

test("only the owner's token signs; nothing is signed before the rules version is set", async () => {
  const { e } = await env();
  assert.equal((await go(e, "/approve", deploy)).status, 401);
  assert.equal((await go(e, "/approve", deploy, "w".repeat(40))).status, 401);
  assert.equal((await go(e, "/approve", deploy, OWNER)).status, 409, "no policy version yet");
  for (const version of ["", "two words", "x".repeat(65), 5]) assert.equal((await go(e, "/policy", { version }, OWNER)).status, 400, String(version));
  assert.equal((await go(e, "/policy", { version: ` ${POLICY} ` }, OWNER)).status, 200);
  const none = await env({ OWNER_TOKEN: undefined });
  assert.match((await go(none.e, "/approve", deploy, OWNER)).body.error, /No owner token/);
  const short = await env({ OWNER_TOKEN: "short" });
  assert.equal((await go(short.e, "/approve", deploy, "short")).status, 401, "a token under 32 characters never works");
});

test("an approval is exactly the gate's record: signed with the approvals key, the exact action and target, and it expires", async () => {
  const { e } = await env();
  await go(e, "/policy", { version: POLICY }, OWNER);
  const r = await go(e, "/approve", { ...deploy, max_uses: 3 }, OWNER);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rec = r.body.approval;
  assert.equal(await verifyRecord(rec, e.APPROVALS_PUBLIC_KEY), true);
  const p = rec.payload;
  assert.deepEqual(Object.keys(p).sort(), ["action", "expires_at", "format", "issued_at", "max_uses", "nonce", "policy_version", "target", "target_sha256", "type"]);
  assert.deepEqual([p.format, p.type, p.action, p.target, p.target_sha256, p.max_uses, p.policy_version], [APPROVAL_FORMAT, "approval", "deploy", TARGET, null, 3, POLICY]);
  assert.equal(gateShapeProblem(p), null);
  assert.equal(Date.parse(p.expires_at) - Date.parse(p.issued_at), 2 * 3_600_000);
  assert.match(p.nonce, /^[0-9a-f]{32}$/);
  assert.equal(rec.algorithm, "Ed25519");
  // target_sha256 null is signed as null, not dropped: the gate needs the key present.
  assert.match(canonicalJson(p), /"target_sha256":null/);
  // Another key, a changed field or the envelope's own key don't make it valid.
  const other = await keys();
  assert.equal(await verifyRecord(rec, other.APPROVALS_PUBLIC_KEY), false);
  assert.equal(await verifyRecord({ ...rec, payload: { ...p, max_uses: 5 } }, e.APPROVALS_PUBLIC_KEY), false);
  assert.equal(await verifyRecord({ ...rec, public_key: other.APPROVALS_PUBLIC_KEY }, e.APPROVALS_PUBLIC_KEY), true, "the envelope's key is ignored; the pinned one decides");
});

test("revocations name the approval's nonce; the list is open to anyone, as the gate reads it, and so is the public key", async () => {
  const { e } = await env();
  await go(e, "/policy", { version: POLICY }, OWNER);
  const a = (await go(e, "/approve", deploy, OWNER)).body.approval;
  assert.equal((await go(e, "/revoke", { nonce: "f".repeat(32) }, OWNER)).status, 404, "a mistyped nonce revokes nothing, and says so");
  assert.equal((await go(e, "/revoke", { nonce: "xyz" }, OWNER)).status, 400);
  assert.equal((await go(e, "/revoke", { nonce: a.payload.nonce })).status, 401, "revoking needs the owner's token too");
  const rv = await go(e, "/revoke", { nonce: a.payload.nonce.toUpperCase() }, OWNER);
  assert.equal(rv.status, 200, JSON.stringify(rv.body));
  const rp = rv.body.revocation.payload;
  assert.equal(await verifyRecord(rv.body.revocation, e.APPROVALS_PUBLIC_KEY), true);
  assert.deepEqual(rp, { format: APPROVAL_FORMAT, type: "revocation", nonce: a.payload.nonce, issued_at: rp.issued_at });
  assert.equal(gateShapeProblem(rp), null);
  const list = await go(e, "/approvals");
  assert.equal(list.status, 200);
  assert.deepEqual([list.body.approvals.map((r: any) => r.payload.type), list.body.policy_version], [["approval", "revocation"], POLICY]);
  assert.ok(Array.isArray(list.body.approvals), 'the gate reads {"approvals": [...]}');
  const pk = await go(e, "/pubkey");
  assert.deepEqual([pk.body.public_key, pk.body.key_id], [e.APPROVALS_PUBLIC_KEY, await keyIdOf(e.APPROVALS_PUBLIC_KEY)]);
  assert.equal(pk.headers.get("access-control-allow-origin"), "*");
});

test("the store forgets records 7 days after they expire, and repeated wrong tokens slow everyone down", async () => {
  const { e, store } = await env();
  await go(e, "/policy", { version: POLICY }, OWNER);
  await go(e, "/approve", deploy, OWNER);
  store.now = () => Date.now() + 8 * 86_400_000;
  assert.equal((await go(e, "/approvals")).body.approvals.length, 0);
  for (let i = 0; i < 10; i++) await go(e, "/approve", deploy, "w".repeat(40));
  assert.equal((await go(e, "/approve", deploy, OWNER)).status, 429, "even the right token waits");
});

test("the page needs no token, loads nothing from elsewhere, and never stores the token", async () => {
  const { e } = await env();
  const r = await go(e, "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy")!, /default-src 'none'.*connect-src 'self'/);
  assert.ok(!/https?:\/\//.test(r.body), "no outside URLs");
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(r.body));
  assert.equal((await go(e, "/nope")).status, 404);
});
