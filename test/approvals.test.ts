// The owner-approvals Worker (owner-approvals/; rules-in-code DESIGN part A, APPROVALS-FORMAT.md v1). These tests
// need no installed packages, so they run anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore, _resetFailures, canonicalJson, handle, keyIdOf, parseApproval, verifyRecord } from "../owner-approvals/src/approvals.ts";
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
const POLICY = "a".repeat(64);
const COMMIT = "b".repeat(40);
const deploy = { action: "deploy", target: "agent-referee-server production", target_ref: { commit: COMMIT.toUpperCase() }, uses: 1, expires_in_hours: 2 };

test("the signed bytes are Agent Referee's canonical JSON, so one verifier works for both", () => {
  for (const v of [{ b: 1, a: [3, { z: null, y: "é" }], c: undefined }, [1, "x", { k: true }], "s", 5, null])
    assert.equal(canonicalJson(v), agentRefereeCanonical(v));
});

test("approval requests: his six actions only, one exact target, at most 20 uses and 24 hours", () => {
  const ok = parseApproval(deploy);
  assert.deepEqual(ok, { ok: true, value: { action: "deploy", target: "agent-referee-server production", target_ref: { commit: COMMIT }, uses: 1, hours: 2 } });
  for (const bad of [
    { ...deploy, action: "merge" },
    { ...deploy, target: "" },
    { ...deploy, target_ref: { commit: COMMIT.slice(0, 7) } },
    { ...deploy, target_ref: { commit: COMMIT, sha256: POLICY } },
    { ...deploy, target_ref: {} },
    { ...deploy, uses: 21 },
    { ...deploy, uses: 1.5 },
    { ...deploy, expires_in_hours: 25 },
    { ...deploy, expires_in_hours: 0.1 },
    { ...deploy, note: "x".repeat(201) },
    { ...deploy, target_ref: { name: "rm -rf /" } },
  ])
    assert.equal(parseApproval(bad).ok, false, JSON.stringify(bad));
  assert.equal(parseApproval({ action: "secret", target: "the team token", target_ref: { name: "TEAM_TOKEN" } }).ok, true);
});

test("only the owner's token signs; nothing is signed before the rules version is set", async () => {
  const { e } = await env();
  assert.equal((await go(e, "/approve", deploy)).status, 401);
  assert.equal((await go(e, "/approve", deploy, "w".repeat(40))).status, 401);
  assert.equal((await go(e, "/approve", deploy, OWNER)).status, 409, "no policy version yet");
  assert.equal((await go(e, "/policy", { sha256: "nope" }, OWNER)).status, 400);
  assert.equal((await go(e, "/policy", { sha256: POLICY.toUpperCase() }, OWNER)).status, 200);
  const none = await env({ OWNER_TOKEN: undefined });
  assert.match((await go(none.e, "/approve", deploy, OWNER)).body.error, /No owner token/);
  const short = await env({ OWNER_TOKEN: "short" });
  assert.equal((await go(short.e, "/approve", deploy, "short")).status, 401, "a token under 32 characters never works");
});

test("an approval is signed with the approvals key, names the exact action and target, and expires", async () => {
  const { e } = await env();
  await go(e, "/policy", { sha256: POLICY }, OWNER);
  const r = await go(e, "/approve", { ...deploy, note: "after the free review" }, OWNER);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rec = r.body.approval;
  assert.equal(await verifyRecord(rec, e.APPROVALS_PUBLIC_KEY), true);
  const p = rec.payload;
  assert.deepEqual([p.record_format, p.action, p.target_ref, p.uses, p.policy_version, p.note], ["owner-approval-v1", "deploy", { commit: COMMIT }, 1, POLICY, "after the free review"]);
  assert.equal(Date.parse(p.expires_at) - Date.parse(p.issued_at), 2 * 3_600_000);
  assert.match(p.nonce, /^[0-9a-f]{32}$/);
  // Another key, a changed field or the envelope's own key don't make it valid.
  const other = await keys();
  assert.equal(await verifyRecord(rec, other.APPROVALS_PUBLIC_KEY), false);
  assert.equal(await verifyRecord({ ...rec, payload: { ...p, uses: 5 } }, e.APPROVALS_PUBLIC_KEY), false);
  assert.equal(await verifyRecord({ ...rec, public_key: other.APPROVALS_PUBLIC_KEY }, e.APPROVALS_PUBLIC_KEY), true, "the envelope's key is ignored; the pinned one decides");
});

test("revocations are signed records too; the list is readable with the read token, and the public key by anyone", async () => {
  const { e } = await env({ READ_TOKEN: "r".repeat(40) });
  await go(e, "/policy", { sha256: POLICY }, OWNER);
  const a = (await go(e, "/approve", deploy, OWNER)).body.approval;
  const rv = await go(e, "/revoke", { nonce: a.payload.nonce }, OWNER);
  assert.equal(rv.status, 200);
  assert.equal(await verifyRecord(rv.body.revocation, e.APPROVALS_PUBLIC_KEY), true);
  assert.deepEqual([rv.body.revocation.payload.record_format, rv.body.revocation.payload.revokes_nonce], ["owner-revocation-v1", a.payload.nonce]);
  assert.equal((await go(e, "/approvals")).status, 401);
  const list = await go(e, "/approvals", undefined, "r".repeat(40));
  assert.deepEqual([list.body.approvals.length, list.body.revocations.length, list.body.policy_version], [1, 1, POLICY]);
  const pk = await go(e, "/pubkey");
  assert.deepEqual([pk.body.public_key, pk.body.key_id], [e.APPROVALS_PUBLIC_KEY, await keyIdOf(e.APPROVALS_PUBLIC_KEY)]);
  assert.equal(pk.headers.get("access-control-allow-origin"), "*");
});

test("the store forgets records 7 days after they expire, and repeated wrong tokens slow everyone down", async () => {
  const { e, store } = await env();
  await go(e, "/policy", { sha256: POLICY }, OWNER);
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
