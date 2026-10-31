// Proof receipts (src/proof.ts; research\specs\proof-receipts-2026-10-31\SPEC.md v0.4): the request rules, the GitHub
// observation with a stand-in API, and the route: team members only, free, unlisted, and nothing else changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { L0_NOTE, LIMITS, PROOF_FORMAT, _clearProofCache, observeGithub, parseProofRequest, proofPayload } from "../src/proof.ts";
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
  for (const repo of ["o", "o/r/x", "../r", "o/.", "o/..", "o r/x", "-o/r"]) assert.equal(parseProofRequest({ level: "L1", check: "github_commit", repo, sha: SHA }).ok, false, repo);
  for (const repo of ["o/.github", "o/.github-private"]) assert.equal(parseProofRequest({ level: "L1", check: "github_commit", repo, sha: SHA }).ok, true, `${repo} is a real kind of repository`);
  assert.equal(parseProofRequest({ level: "L2" }).ok, false);
  assert.equal(parseProofRequest(null).ok, false);
});

// A stand-in for GitHub's API: answers by path, counts calls, and records what was asked. `tick` runs before each answer.
function fakeGithub(over: Record<string, () => Response> = {}, tick: () => void = () => {}) {
  const calls: { url: string; init: any }[] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ url, init });
    tick();
    const u = new URL(url);
    const path = u.pathname + u.search;
    for (const [k, v] of Object.entries(over)) if (path.includes(k)) return v();
    if (u.pathname.endsWith("/check-runs"))
      return Response.json({ total_count: 2, check_runs: [{ name: "test (22)", head_sha: SHA, app: { slug: "github-actions" }, status: "completed", conclusion: "success", completed_at: "2026-10-31T16:00:00Z" }, { name: "test (24)", head_sha: SHA, app: { slug: "github-actions" }, status: "in_progress", conclusion: null, completed_at: null }] });
    if (u.pathname.endsWith("/status")) return Response.json({ sha: SHA, state: "pending", total_count: 0, statuses: [] });
    if (u.pathname.includes("/compare/")) return Response.json({ status: "behind" });
    if (u.pathname.endsWith("/branches-where-head")) return Response.json([{ name: "main" }]);
    if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname)) return Response.json({ full_name: "CCheez34/Agent-Referee-Server", private: false, default_branch: "main" });
    return Response.json({ sha: SHA, html_url: `https://github.com/CCheez34/Agent-Referee-Server/commit/${SHA}`, commit: { tree: { sha: "C".repeat(40) }, author: { date: "2026-10-31T15:00:00Z" }, committer: { date: "2026-10-31T15:01:00Z" } }, parents: [{ sha: "D".repeat(40) }] });
  }) as any;
  return { f, calls };
}

test("L1 github_commit: GitHub's facts, where the commit is in the repository, and the time after the last answer", async () => {
  _clearProofCache();
  let clock = Date.parse("2026-10-31T16:30:00Z");
  const { f, calls } = fakeGithub({}, () => (clock += 5_000));
  const o = await observeGithub("github_commit", "ccheez34/agent-referee-server", SHA, { fetch: f, now: () => clock });
  assert.equal(o.ok, true);
  if (!o.ok) return;
  assert.equal(o.repo, "ccheez34/agent-referee-server", "GitHub's spelling, lower-cased");
  assert.deepEqual(o.observed, {
    commit_sha: SHA, tree_sha: "c".repeat(40), parents: ["d".repeat(40)], author_time_as_written: "2026-10-31T15:00:00Z", committer_time_as_written: "2026-10-31T15:01:00Z",
    default_branch: "main", on_default_branch: true, branch_heads: ["main"],
    observed_at: "2026-10-31T16:30:20.000Z", source: "api.github.com",
  }, "observed_at comes after the four answers (fresh read #3)");
  assert.deepEqual(calls.map((x) => new URL(x.url).pathname), ["/repos/ccheez34/agent-referee-server", `/repos/ccheez34/agent-referee-server/commits/${SHA}`, `/repos/ccheez34/agent-referee-server/compare/main...${SHA}`, `/repos/ccheez34/agent-referee-server/commits/${SHA}/branches-where-head`]);
  assert.ok(calls.every((x) => new URL(x.url).origin === "https://api.github.com" && x.init.redirect === "manual"));
  assert.equal(calls[0].init.headers.authorization, undefined, "no token unless the service has one");
  _clearProofCache();
  const t = fakeGithub();
  await observeGithub("github_commit", "o/r", SHA, { fetch: t.f, token: "ghp_test\n" });
  assert.equal(t.calls[0].init.headers.authorization, "Bearer ghp_test", "the token is trimmed");
});

test("L1: a commit that lives only in a fork shows as not on the default branch and no branch's head (fresh read #1)", async () => {
  _clearProofCache();
  const { f } = fakeGithub({ "/compare/": () => Response.json({ status: "diverged" }), "/branches-where-head": () => Response.json([]) });
  const o: any = await observeGithub("github_commit", "o/r", SHA, { fetch: f });
  assert.deepEqual([o.observed.on_default_branch, o.observed.branch_heads], [false, []]);
});

test("L1 github_checks: every run and status with who posted it, in-progress runs never shown as passed; cached 10 minutes as a copy", async () => {
  _clearProofCache();
  let clock = Date.parse("2026-10-31T16:30:00Z");
  const { f, calls } = fakeGithub({ "/status": () => Response.json({ sha: SHA, state: "success", total_count: 31, statuses: [{ context: "ci/x", state: "success", creator: { login: "someone" }, updated_at: "2026-10-31T16:01:00Z" }] }) });
  const o: any = await observeGithub("github_checks", "o/r", SHA, { fetch: f, now: () => clock });
  assert.equal(o.ok, true);
  assert.deepEqual(o.observed.check_runs.map((r: any) => [r.name, r.status, r.conclusion]), [["test (22)", "completed", "success"], ["test (24)", "in_progress", null]]);
  assert.deepEqual(o.observed.statuses, [{ context: "ci/x", state: "success", creator: "someone", updated_at: "2026-10-31T16:01:00Z" }]);
  assert.deepEqual([o.observed.statuses_total, o.observed.statuses_truncated], [31, true], "more statuses than were read (fresh read #4)");
  assert.equal(calls.length, 6, "the repository, the commit, the compare, the branch heads, its check runs and its statuses");
  assert.ok(calls.some((x) => x.url.endsWith("/status?per_page=100")));
  o.observed.check_runs.length = 0; // a caller changing its copy
  clock += 9 * 60_000;
  const again: any = await observeGithub("github_checks", "o/r", SHA, { fetch: f, now: () => clock });
  assert.equal(calls.length, 6, "from the cache");
  assert.equal(again.observed.check_runs.length, 2, "each caller gets its own copy");
  assert.equal(again.observed.observed_at, "2026-10-31T16:30:00.000Z", "a new receipt can't make an old observation look new");
  clock += 2 * 60_000;
  await observeGithub("github_checks", "o/r", SHA, { fetch: f, now: () => clock });
  assert.equal(calls.length, 12, "asked again after 10 minutes");
});

test("L1 failures give no receipt: private, not found, rate limit, redirects off the API, another commit's answers", async () => {
  const cases: [Record<string, () => Response>, string, number, RegExp][] = [
    [{ "/repos/o/r?": () => Response.json({}), }, "github_commit", 404, /isn't public/],
    [{ [`/commits/${SHA}`]: () => new Response("{}", { status: 404 }) }, "github_commit", 404, /not found/],
    [{ [`/commits/${SHA}`]: () => new Response("{}", { status: 403 }) }, "github_commit", 503, /rate limit/],
    [{ [`/commits/${SHA}`]: () => new Response("{}", { status: 429 }) }, "github_commit", 503, /rate limit/],
    [{ [`/commits/${SHA}`]: () => new Response(null, { status: 301, headers: { location: "https://evil.example/x" } }) }, "github_commit", 502, /outside/],
    [{ [`/commits/${SHA}`]: () => new Response(null, { status: 302, headers: { location: "/" } }) }, "github_commit", 502, /outside/],
    [{ [`/commits/${SHA}`]: () => Response.json({ sha: "e".repeat(40), html_url: "" }) }, "github_commit", 404, /different commit/],
    [{ "/check-runs": () => Response.json({ total_count: 1, check_runs: [{ name: "x", head_sha: "e".repeat(40), status: "completed", conclusion: "success" }] }) }, "github_checks", 502, /different commit/],
    [{ "/status?": () => Response.json({ sha: "e".repeat(40), state: "success", statuses: [] }) }, "github_checks", 502, /different commit/],
    [{ "/check-runs": () => Response.json({ total_count: 0 }) }, "github_checks", 502, /couldn't be read/],
  ];
  for (const [over, check, status, re] of cases) {
    _clearProofCache();
    // The private case answers the repository call with private missing; the stand-in matches paths, so use the exact one.
    const fixed = Object.fromEntries(Object.entries(over).map(([k, v]) => [k === "/repos/o/r?" ? "/repos/o/r" : k, v]));
    const g = k0(fixed);
    const o: any = await observeGithub(check as any, "o/r", SHA, { fetch: g });
    assert.deepEqual([o.ok, o.status], [false, status], `${JSON.stringify(Object.keys(over))}: ${o.error}`);
    assert.match(o.error, re);
  }
  // A redirect inside GitHub's API (a renamed repository) is followed once.
  _clearProofCache();
  let n = 0;
  const moved = fakeGithub({ [`/commits/${SHA}`]: () => (n++ === 0 ? new Response(null, { status: 301, headers: { location: `https://api.github.com/repositories/1/commits/${SHA}` } }) : Response.json({ sha: SHA, commit: {}, parents: [] })) });
  const o: any = await observeGithub("github_commit", "o/r", SHA, { fetch: moved.f });
  assert.equal(o.ok, true);
});
// The private-repository case needs the repository call to match exactly, not every path that starts with it.
function k0(over: Record<string, () => Response>) {
  const exact = over["/repos/o/r"];
  const rest = Object.fromEntries(Object.entries(over).filter(([k]) => k !== "/repos/o/r"));
  const base = fakeGithub(rest).f;
  return (async (url: string, init: any) => (exact && new URL(url).pathname === "/repos/o/r" ? exact() : base(url, init))) as any;
}

test("the payload: claimed and observed kept apart, the signed limits, a declared member, team funding at no charge", () => {
  const l0: any = proofPayload({ request: { level: "L0", check: "stamp", sha256: H64, claim: "done" }, member: "2.0", id: "x".repeat(24), issuedAt: "2026-10-31T16:40:00.000Z" });
  assert.deepEqual(l0, { receipt_format: PROOF_FORMAT, type: "proof", service: "Agent Referee", receipt_id: "x".repeat(24), level: "L0", check: "stamp", subject: { sha256: H64 }, claimed: { text: "done" }, note: L0_NOTE, limits: LIMITS.L0, issued_at: "2026-10-31T16:40:00.000Z", caller: { member: "2.0", verified: false }, funding: "team", price_micro: 0 });
  assert.equal("observed" in l0, false);
  const l1: any = proofPayload({ request: { level: "L1", check: "github_commit", repo: "o/r", sha: SHA }, member: "3.0", id: "y".repeat(24), issuedAt: "2026-10-31T16:40:00.000Z", observation: { repo: "o/r", observed: { commit_sha: SHA } } });
  assert.equal("claimed" in l1, false);
  assert.deepEqual([l1.subject, l1.limits], [{ repo: "o/r", sha: SHA }, LIMITS.L1]);
  for (const t of [LIMITS.L0, LIMITS.L1]) assert.match(t, /never stands in for the owner's yes: deploys, payments, deletes, secrets, installing skills or servers, and rule changes/);
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
  assert.deepEqual([p.receipt_format, p.level, p.subject, p.claimed, p.note, p.caller, p.price_micro, p.limits], [PROOF_FORMAT, "L0", { sha256: H64 }, { text: "release-gate passed on the branch" }, L0_NOTE, { member: "2.0", verified: false }, 0, LIMITS.L0]);
  assert.match(r.body.what_it_proves, /declared, not verified.*Not that the claim is true/);
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
  const big = await app.fetch(new Request("https://x/team/proof", { method: "POST", headers: { "content-type": "application/json", ...as() }, body: JSON.stringify({ level: "L0", sha256: H64, claim: "x".repeat(5000) }) }), e, ctx);
  assert.equal(big.status, 413);
});

t("route: L1 has its own daily limit, and a failed L1 attempt counts against it", async () => {
  const orig = globalThis.fetch;
  _clearProofCache();
  const gh = fakeGithub({ [`/commits/${SHA}`]: () => new Response("{}", { status: 404 }) });
  globalThis.fetch = ((u: any, i: any) => gh.f(String(u), i)) as any;
  try {
    const e = await env({ PROOF_L1_DAILY: "2", PROOF_L0_DAILY: "1" });
    const ask = () => post(e, { level: "L1", check: "github_commit", repo: "o/r", sha: SHA });
    assert.equal((await ask()).status, 404, "not found: no receipt");
    assert.equal((await ask()).status, 404);
    const third = await ask();
    assert.equal(third.status, 429, "both failed attempts counted");
    assert.equal((await post(e, { level: "L0", sha256: H64 })).status, 200, "L0 counts separately");
  } finally {
    globalThis.fetch = orig;
  }
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
    assert.deepEqual([p.observed.source, p.observed.on_default_branch, p.limits], ["api.github.com", true, LIMITS.L1]);
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
