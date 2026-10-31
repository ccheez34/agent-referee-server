// Proof receipts (src/proof.ts; research\specs\proof-receipts-2026-10-31\SPEC.md v0.4): the request rules, the GitHub
// observation with a stand-in API, and the route: team members only, free, unlisted, and nothing else changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { L0_NOTE, PROOF_FORMAT, _clearProofCache, observeGithub, parseProofRequest, proofPayload } from "../src/proof.ts";
import { verifyReceipt } from "../src/receipt.ts";

const SHA = "a".repeat(40);
const H64 = "b".repeat(64);

test("requests: full-length lower-case hashes, owner/name lower-cased, short shas and long claims refused", () => {
  const l0 = parseProofRequest({ level: "L0", sha256: H64.toUpperCase(), claim: "tests pass on a1b2c3" });
  assert.deepEqual(l0, { ok: true, value: { level: "L0", check: "stamp", sha256: H64, claim: "tests pass on a1b2c3" } });
  assert.equal(parseProofRequest({ level: "L0", sha256: H64.slice(0, 63) }).ok, false);
  assert.equal(parseProofRequest({ level: "L0", sha256: H64, claim: "x".repeat(501) }).ok, false);
  assert.equal(parseProofRequest({ level: "L0", check: "observe", sha256: H64 }).ok, false);
  const l1 = parseProofRequest({ level: "L1", check: "github_commit", repo: "CCheez34/Agent-Referee-Server", sha: SHA.toUpperCase() });
  assert.deepEqual(l1, { ok: true, value: { level: "L1", check: "github_commit", repo: "ccheez34/agent-referee-server", sha: SHA } });
  assert.equal(parseProofRequest({ level: "L1", check: "github_commit", repo: "o/r", sha: SHA.slice(0, 7) }).ok, false, "short sha");
  assert.equal(parseProofRequest({ level: "L1", check: "url_sha256", repo: "o/r", sha: SHA }).ok, false, "not in this version");
  for (const repo of ["o", "o/r/x", "../r", "o/.git", "o r/x", "-o/r"]) assert.equal(parseProofRequest({ level: "L1", check: "github_commit", repo, sha: SHA }).ok, false, repo);
  assert.equal(parseProofRequest({ level: "L2" }).ok, false);
  assert.equal(parseProofRequest(null).ok, false);
});

// A stand-in for GitHub's API: answers by path, counts calls, and records what was asked.
function fakeGithub(over: Record<string, () => Response> = {}) {
  const calls: { url: string; init: any }[] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ url, init });
    const path = new URL(url).pathname + new URL(url).search;
    for (const [k, v] of Object.entries(over)) if (path.includes(k)) return v();
    if (path.endsWith("/check-runs?per_page=100"))
      return Response.json({ total_count: 2, check_runs: [{ name: "test (22)", app: { slug: "github-actions" }, status: "completed", conclusion: "success", completed_at: "2026-10-31T16:00:00Z" }, { name: "test (24)", app: { slug: "github-actions" }, status: "in_progress", conclusion: null, completed_at: null }] });
    if (path.endsWith("/status")) return Response.json({ state: "pending", statuses: [] });
    return Response.json({ sha: SHA, html_url: `https://github.com/CCheez34/Agent-Referee-Server/commit/${SHA}`, commit: { tree: { sha: "C".repeat(40) }, author: { date: "2026-10-31T15:00:00Z" }, committer: { date: "2026-10-31T15:01:00Z" } }, parents: [{ sha: "D".repeat(40) }] });
  }) as any;
  return { f, calls };
}

test("L1 github_commit: what GitHub reports, with observed_at and the source; only api.github.com, no credentials but our own token", async () => {
  _clearProofCache();
  const { f, calls } = fakeGithub();
  const o = await observeGithub("github_commit", "ccheez34/agent-referee-server", SHA, { fetch: f, now: () => Date.parse("2026-10-31T16:30:00Z") });
  assert.equal(o.ok, true);
  if (!o.ok) return;
  assert.equal(o.repo, "ccheez34/agent-referee-server", "GitHub's spelling, lower-cased");
  assert.deepEqual(o.observed, { commit_sha: SHA, tree_sha: "c".repeat(40), parents: ["d".repeat(40)], author_time: "2026-10-31T15:00:00Z", committer_time: "2026-10-31T15:01:00Z", observed_at: "2026-10-31T16:30:00.000Z", source: "api.github.com" });
  assert.deepEqual(calls.map((x) => x.url), [`https://api.github.com/repos/ccheez34/agent-referee-server/commits/${SHA}`]);
  assert.equal(calls[0].init.headers.authorization, undefined, "no token unless the service has one");
  assert.equal(calls[0].init.redirect, "manual");
  _clearProofCache();
  const t = fakeGithub();
  await observeGithub("github_commit", "o/r", SHA, { fetch: t.f, token: "ghp_test" });
  assert.equal(t.calls[0].init.headers.authorization, "Bearer ghp_test");
});

test("L1 github_checks: every run and status, in-progress runs never shown as passed; cached 10 minutes with the original time", async () => {
  _clearProofCache();
  let clock = Date.parse("2026-10-31T16:30:00Z");
  const { f, calls } = fakeGithub();
  const o: any = await observeGithub("github_checks", "o/r", SHA, { fetch: f, now: () => clock });
  assert.equal(o.ok, true);
  assert.deepEqual(o.observed.check_runs.map((r: any) => [r.name, r.status, r.conclusion]), [["test (22)", "completed", "success"], ["test (24)", "in_progress", null]]);
  assert.equal(o.observed.combined_status, "pending");
  assert.equal(calls.length, 3, "the commit, its check runs and its statuses");
  clock += 9 * 60_000;
  const again: any = await observeGithub("github_checks", "o/r", SHA, { fetch: f, now: () => clock });
  assert.equal(calls.length, 3, "from the cache");
  assert.equal(again.observed.observed_at, "2026-10-31T16:30:00.000Z", "a new receipt can't make an old observation look new");
  clock += 2 * 60_000;
  await observeGithub("github_checks", "o/r", SHA, { fetch: f, now: () => clock });
  assert.equal(calls.length, 6, "asked again after 10 minutes");
});

test("L1 failures give no receipt: not found, GitHub's rate limit, a redirect off its API, a different commit", async () => {
  const cases: [Record<string, () => Response>, number, RegExp][] = [
    [{ [`/commits/${SHA}`]: () => new Response("{}", { status: 404 }) }, 404, /not found/],
    [{ [`/commits/${SHA}`]: () => new Response("{}", { status: 403 }) }, 503, /rate limit/],
    [{ [`/commits/${SHA}`]: () => new Response("{}", { status: 429 }) }, 503, /rate limit/],
    [{ [`/commits/${SHA}`]: () => new Response(null, { status: 301, headers: { location: "https://evil.example/x" } }) }, 502, /outside its API/],
    [{ [`/commits/${SHA}`]: () => Response.json({ sha: "e".repeat(40), html_url: "" }) }, 404, /different commit/],
  ];
  for (const [over, status, re] of cases) {
    _clearProofCache();
    const o: any = await observeGithub("github_commit", "o/r", SHA, { fetch: fakeGithub(over).f });
    assert.deepEqual([o.ok, o.status], [false, status]);
    assert.match(o.error, re);
  }
  // A redirect inside GitHub's API (a renamed repository) is followed once.
  _clearProofCache();
  let n = 0;
  const moved = (async (url: string) => (n++ === 0 ? new Response(null, { status: 301, headers: { location: `https://api.github.com/repositories/1/commits/${SHA}` } }) : Response.json({ sha: SHA, html_url: `https://github.com/new/name/commit/${SHA}`, commit: {}, parents: [] }))) as any;
  const o: any = await observeGithub("github_commit", "old/name", SHA, { fetch: moved });
  assert.deepEqual([o.ok, o.repo], [true, "new/name"]);
});

test("the payload: claimed and observed kept apart, the L0 note, team funding at no charge", () => {
  const l0: any = proofPayload({ request: { level: "L0", check: "stamp", sha256: H64, claim: "done" }, member: "2.0", id: "x".repeat(24), issuedAt: "2026-10-31T16:40:00.000Z" });
  assert.deepEqual(l0, { format: PROOF_FORMAT, type: "proof", service: "Agent Referee", receipt_id: "x".repeat(24), level: "L0", check: "stamp", subject: { sha256: H64 }, claimed: { text: "done" }, note: L0_NOTE, issued_at: "2026-10-31T16:40:00.000Z", caller: { member: "2.0" }, funding: "team", price_micro: 0 });
  assert.equal("observed" in l0, false);
  const l1: any = proofPayload({ request: { level: "L1", check: "github_commit", repo: "o/r", sha: SHA }, member: "3.0", id: "y".repeat(24), issuedAt: "2026-10-31T16:40:00.000Z", observation: { repo: "o/r", observed: { commit_sha: SHA } } });
  assert.equal("claimed" in l1, false);
  assert.deepEqual(l1.subject, { repo: "o/r", sha: SHA });
});

// ---------- the route (needs hono; CI runs it) ----------
let app: any = null;
try {
  app = (await import("../src/index.ts")).default;
} catch (e) {
  console.log(`proof route tests skipped (dependencies not installed here): ${String((e as any)?.message ?? e).slice(0, 120)}`);
}
const t = app ? test : test.skip;
const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const KEYS = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };
const mem = () => {
  const d = new Map<string, unknown>();
  return { storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); }, async delete(k: any) { for (const x of [k].flat()) d.delete(x); return true; }, async list(o: { prefix?: string } = {}) { return new Map([...d.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort().map((k) => [k, structuredClone(d.get(k))])); }, async deleteAll() { d.clear(); }, async setAlarm() {} } };
};
function ns(make: () => any) {
  const objs = new Map<string, any>();
  return { idFromName: (x: string) => x, get: (id: string) => ({ fetch: async (u: string, i?: RequestInit) => { if (!objs.has(id)) objs.set(id, make()); return objs.get(id).fetch(new Request(u, i)); } }) };
}
const TEAM_TOKEN = "t".repeat(40);
async function env(extra: Record<string, unknown> = {}) {
  const { Ledger } = await import("../src/ledger.ts");
  const { Health } = await import("../src/health.ts");
  const e: any = { ...KEYS, PAY_TO: "0x0000000000000000000000000000000000000001", NETWORK: "base-sepolia", PAYMENTS_ENABLED: "false", STAGING: "true", FAKE_AI: "true", TEAM_TOKEN, TEAM_MEMBERS: "2.0,3.0", TEAM_MEMBER_DAILY_USD: "0.50", TEAM_DAILY_USD: "0.80", HEALTH: ns(() => new Health(mem() as any)), ...extra };
  e.LEDGER = ns(() => new Ledger(mem() as any, e));
  return e;
}
const ctx = { waitUntil() {}, passThroughOnException() {} };
const as = (member = "2.0") => ({ "x-team-token": TEAM_TOKEN, "x-team-member": member, "cf-ipcountry": "US", "cf-connecting-ip": "203.0.113.9" });
const post = async (e: any, body: unknown, headers: Record<string, string> = as()) => {
  const res = await app.fetch(new Request("https://x/team/proof", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), e, ctx);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

t("route: an L0 stamp for a team member is signed, says what it proves, and is never an approval", async () => {
  const e = await env();
  const r = await post(e, { level: "L0", sha256: H64, claim: "release-gate passed on the branch" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await verifyReceipt(r.body.receipt, KEYS.PUBLIC_KEY), true);
  const p = r.body.receipt.payload;
  assert.deepEqual([p.format, p.level, p.subject, p.claimed, p.note, p.caller, p.price_micro], [PROOF_FORMAT, "L0", { sha256: H64 }, { text: "release-gate passed on the branch" }, L0_NOTE, { member: "2.0" }, 0]);
  assert.match(r.body.what_it_proves, /Not that the claim is true/);
  assert.match(r.body.never_an_approval, /deploys, payments, deletes, secrets, installing skills or servers, and rule changes/);
});

t("route: team members only; bad requests, sanctioned regions and the daily limit issue nothing", async () => {
  assert.equal((await post(await env({ TEAM_TOKEN: undefined }), { level: "L0", sha256: H64 })).status, 404, "off without a team token");
  const e = await env({ PROOF_L0_DAILY: "2" });
  assert.equal((await post(e, { level: "L0", sha256: H64 }, { ...as(), "x-team-token": "w".repeat(40) })).status, 401);
  assert.equal((await post(e, { level: "L0", sha256: H64 }, as("9.0"))).status, 403);
  assert.equal((await post(e, { level: "L0", sha256: "abc" })).status, 400);
  const ir = await post(e, { level: "L0", sha256: H64 }, { ...as(), "cf-ipcountry": "IR" });
  assert.equal(ir.status, 451);
  assert.equal((await post(e, { level: "L0", sha256: H64 })).status, 200);
  assert.equal((await post(e, { level: "L0", sha256: H64 })).status, 200);
  const third = await post(e, { level: "L0", sha256: H64 });
  assert.equal(third.status, 429, JSON.stringify(third.body));
  assert.equal((await post(e, { level: "L0", sha256: H64 }, as("3.0"))).status, 200, "per member");
});

t("route: L1 asks GitHub and signs what it saw; GitHub's rate limit issues nothing", async () => {
  const orig = globalThis.fetch;
  _clearProofCache();
  let gh = fakeGithub();
  globalThis.fetch = ((u: any, i: any) => gh.f(String(u), i)) as any;
  try {
    const e = await env();
    const r = await post(e, { level: "L1", check: "github_commit", repo: "CCheez34/Agent-Referee-Server", sha: SHA });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await verifyReceipt(r.body.receipt, KEYS.PUBLIC_KEY), true);
    const p = r.body.receipt.payload;
    assert.deepEqual([p.level, p.check, p.subject], ["L1", "github_commit", { repo: "ccheez34/agent-referee-server", sha: SHA }]);
    assert.equal(p.observed.source, "api.github.com");
    assert.equal("claimed" in p, false);
    _clearProofCache();
    gh = fakeGithub({ [`/commits/${SHA}`]: () => new Response("{}", { status: 403 }) });
    const limited = await post(e, { level: "L1", check: "github_checks", repo: "o/r", sha: SHA });
    assert.equal(limited.status, 503);
    assert.match(limited.body.error, /rate limit.*No receipt was issued/);
  } finally {
    globalThis.fetch = orig;
  }
});

t("nothing that exists changes: the route isn't listed in GET / or llms.txt", async () => {
  const e = await env();
  const home = await app.fetch(new Request("https://x/", { headers: { accept: "application/json" } }), e, ctx);
  assert.ok(!(await home.text()).includes("proof"), "unlisted until the experiment's last arm ends");
  const llms = await app.fetch(new Request("https://x/llms.txt"), e, ctx);
  assert.ok(!(await llms.text()).includes("/team/proof"));
});
