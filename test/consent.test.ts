import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/gate.ts";
import { Health, _resetHealthCaches } from "../src/health.ts";
import { Ledger } from "../src/ledger.ts";
import { MatchRoom } from "../src/match.ts";
import { _clearSnapshots } from "../src/gateclient.ts";
import { NOTICE_VERSION, consentCheck, listedCompanies, noticeText } from "../src/consent.ts";
import { createHash } from "node:crypto";
import { allowedModels, companyOf, judgeAllowed } from "../src/judge.ts";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "../src/review.ts";

let app: any = null;
try {
  app = (await import("../src/index.ts")).default;
} catch (e) {
  console.log(`consent tests skipped (dependencies not installed here): ${String((e as any)?.message ?? e).slice(0, 120)}`);
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
const ON = { CONSENT_REQUIRED: "true", MULTI_PART_ENABLED: "true", TEAM_MEMBER_DAILY_USD: "5", TEAM_DAILY_USD: "5" };
const V = NOTICE_VERSION;

async function verified(receipt: any) {
  const pub = await crypto.subtle.importKey("raw", Buffer.from(receipt.public_key, "base64"), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, pub, Buffer.from(receipt.signature, "base64"), new TextEncoder().encode(canonicalJson(receipt.payload)));
}
function isNotice(r: { status: number; body: any }, what: string) {
  assert.equal(r.status, 428, `${what}: ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.equal(r.body.error, "consent_required", what);
  assert.equal(r.body.notice.version, V, what);
  assert.ok(Array.isArray(r.body.notice.read_by) && r.body.notice.read_by.length > 0, `${what}: names the companies`);
  assert.match(r.body.notice.sender, /own the work you send, or are allowed to send it/, what);
  assert.ok(r.body.message.includes(`"consent": "${V}"`), `${what}: says how to agree`);
}

t("switched off (the default): nothing changes, and receipts carry no consent_version", async () => {
  const e = env();
  const r = await call(e, "/team/review", review, team);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.receipt.payload.consent_version, undefined);
  const free = await call(e, "/free/review", review);
  assert.equal(free.status, 200);
  assert.equal(free.body.receipt.payload.consent_version, undefined);
});

t("switched on: every model-bound route answers 428 with the notice, before anything else is taken", async () => {
  const e = env(ON);
  for (const [path, b, h] of [
    ["/review", review, {}],
    ["/review-3", review, {}],
    ["/review-3x2", pieces, {}],
    ["/free/review", review, {}],
    ["/free/review-3", review, {}],
    ["/team/review", review, team],
    ["/team/review-3x2", pieces, team],
    ["/matches", { tier: "judge-3", seats: ["a", "b"], rules: "Pick the shorter answer." }, {}],
  ] as const) isNotice(await call(e, path, b, h as any), path);
  assert.equal(e.MATCHES.objs.size, 0, "no match was created");
  assert.equal(e.GATES.objs.size, 0, "no reviewer slot was asked for");
  // the free allowance wasn't touched: a consenting free review still goes through
  assert.equal((await call(e, "/free/review", { ...review, consent: V })).status, 200);
});

t("with payments on, a call without consent gets the notice, never a payment request (402)", async () => {
  const e = env({ ...ON, PAYMENTS_ENABLED: "true" });
  for (const [path, b] of [["/review", review], ["/review-3", review], ["/review-3x2", pieces]] as const) {
    isNotice(await call(e, path, b), path);
    isNotice(await call(e, path, b, { "x-payment": "e30=" }), `${path} with a payment header`);
  }
  // with consent, the same unpaid call reaches the paywall as before
  assert.equal((await call(e, "/review", { ...review, consent: V })).status, 402);
});

t("the notice names the companies of this call's own panel", async () => {
  const e = env(ON);
  const r = await call(e, "/team/review", { ...review, panel: ["openai/gpt-6-luna"] }, team);
  isNotice(r, "named panel");
  assert.deepEqual(r.body.notice.read_by, [{ company: "OpenAI", based: "United States" }]);
  assert.deepEqual(r.body.notice.models, ["openai/gpt-6-luna"]);
});

t("an old or wrong version is asked again; the current one, in the body or the header, goes through and is signed into the receipt", async () => {
  const e = env(ON);
  const old = await call(e, "/team/review", { ...review, consent: "2026-01-01.1" }, team);
  isNotice(old, "old version");
  assert.match(old.body.message, /notice has changed/);
  const viaBody = await call(e, "/team/review", { ...review, consent: V }, team);
  assert.equal(viaBody.status, 200, JSON.stringify(viaBody.body));
  assert.equal(viaBody.body.receipt.payload.consent_version, V);
  assert.ok(await verified(viaBody.body.receipt), "the signature covers consent_version");
  const viaHeader = await call(e, "/free/review-3", review, { "x-consent": V });
  assert.equal(viaHeader.status, 200, JSON.stringify(viaHeader.body));
  assert.equal(viaHeader.body.receipt.payload.consent_version, V);
  const multi = await call(e, "/team/review-3x2", { ...pieces, consent: V }, team);
  assert.equal(multi.status, 200, JSON.stringify(multi.body).slice(0, 300));
  assert.equal(multi.body.receipt.payload.consent_version, V);
  assert.ok(await verified(multi.body.receipt));
});

t("judge matches: the creator, each paying seat and an invited guest each agree for their own text; other tiers aren't asked", async () => {
  const e = env(ON);
  const created = await call(e, "/matches", { tier: "judge-3", seats: ["a", "b"], rules: "Pick the shorter answer.", consent: V });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.match_id ?? created.body.id;
  assert.ok(id, JSON.stringify(created.body).slice(0, 300));
  isNotice(await call(e, "/join/judge-3", { match_id: id, seat: "a" }), "joining a judge seat");
  const joined = await call(e, "/join/judge-3", { match_id: id, seat: "a", consent: V });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  // an invite match: the host's consent doesn't cover the guest's text
  const inv = await call(e, "/matches", { tier: "judge-3", seats: ["a", "b"], rules: "Pick the shorter answer.", host_pays: "a", consent: V });
  assert.equal(inv.status, 201, JSON.stringify(inv.body).slice(0, 300));
  const iid = inv.body.match_id ?? inv.body.id;
  const host = await call(e, "/host/join/judge-3", { match_id: iid, seat: "a", consent: V });
  assert.equal(host.status, 200, JSON.stringify(host.body).slice(0, 300));
  const token = host.body.invite?.invite_token ?? inv.body.invite?.invite_token;
  assert.ok(token, JSON.stringify(host.body).slice(0, 400));
  isNotice(await call(e, "/invite/join", { match_id: iid, invite_token: token, seat: "b" }), "an invited guest");
  const guest = await call(e, "/invite/join", { match_id: iid, invite_token: token, seat: "b", consent: V });
  assert.equal(guest.status, 200, JSON.stringify(guest.body).slice(0, 300));
  // tiers with no AI never ask
  assert.equal((await call(e, "/matches", { tier: "rps", seats: ["a", "b"] })).status, 201);
});

t("GET /consent and GET /reviewers tell an agent the version before it sends anything", async () => {
  const e = env(ON);
  const n = await raw(e, "/consent");
  assert.equal(n.headers.get("cache-control"), "no-store");
  const nb: any = await n.json();
  assert.equal(nb.required, true);
  assert.equal(nb.version, V);
  assert.ok(nb.read_by.some((x: any) => x.company === "Anthropic"));
  const rv = await call(e, "/reviewers");
  assert.equal(rv.body.consent.version, V);
  assert.equal(rv.body.consent.required, true);
  assert.equal((await call(env(), "/consent")).body.required, false);
});

t("review-3x3, team review-3 and -3x3, paid judge seats and judge-match creation: 428 first, and with payments on never 402", async () => {
  const e = env({ ...ON, PAYMENTS_ENABLED: "true", ADMIN_TOKEN: "a".repeat(40) });
  const three = { task: "Three pieces.", pieces: [{ text: "a" }, { text: "b" }, { text: "c" }] };
  for (const [path, b, h] of [
    ["/review-3x3", three, {}],
    ["/review-3x3", three, { "x-payment": "e30=" }],
    ["/team/review-3", review, team],
    ["/team/review-3x3", three, team],
  ] as const) isNotice(await call(e, path, b, h as any), path);
  // a paid judge seat and judge-match creation, with payments on: the notice, never a payment request
  const off = env({ ...ON, CONSENT_REQUIRED: "false" });
  const m = await call(off, "/matches", { tier: "judge-3", seats: ["a", "b"], rules: "Pick the shorter answer." });
  assert.equal(m.status, 201, JSON.stringify(m.body).slice(0, 200));
  const on = { ...off, CONSENT_REQUIRED: "true", PAYMENTS_ENABLED: "true" };
  const seat = await call(on, "/join/judge-3", { match_id: m.body.match_id ?? m.body.id, seat: "a" });
  isNotice(seat, "a paid judge seat with payments on");
  const seatPaid = await call(on, "/join/judge-3", { match_id: m.body.match_id ?? m.body.id, seat: "a" }, { "x-payment": "e30=" });
  isNotice(seatPaid, "a paid judge seat with a payment header");
  isNotice(await call(on, "/matches", { tier: "judge-3", seats: ["a", "b"], rules: "Pick the shorter answer." }), "judge-match creation with payments on");
  // with consent, the same seat goes on to the paywall
  assert.equal((await call(on, "/join/judge-3", { match_id: m.body.match_id ?? m.body.id, seat: "a" }, { "x-consent": V })).status, 402);
});

t("the hosted MCP server's free route asks too, before its allowance, and takes the header tag into the receipt", async () => {
  const e = env({ ...ON, INTERNAL_TOKEN: "i".repeat(40), EXT_FREE_DAILY_BUDGET_USD: "3.00" });
  const h = { "x-internal-auth": "i".repeat(40), "x-caller-id": "chatgpt-user-1" };
  isNotice(await call(e, "/internal/free/review", review, h), "/internal/free/review");
  // asked several times over: the caller's one free review-3 of the day is still there afterwards
  for (let i = 0; i < 4; i++) isNotice(await call(e, "/internal/free/review-3", review, h), "/internal/free/review-3");
  const ok = await call(e, "/internal/free/review-3", review, { ...h, "x-consent": V });
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200));
  assert.equal(ok.body.receipt.payload.consent_version, V);
});

t("tiers with no AI never ask (rps, weighted, draw), and with consent off the match routes are unchanged", async () => {
  const e = env(ON);
  assert.equal((await call(e, "/matches", { tier: "weighted", seats: ["a", "b"], weights: { a: 1, b: 1 } })).status, 201);
  assert.equal((await call(e, "/matches", { tier: "draw", seats: ["a", "b"], options: ["x", "y"] })).status, 201);
  const off = env();
  const m = await call(off, "/matches", { tier: "judge-3", seats: ["a", "b"], rules: "Pick the shorter answer." });
  assert.equal(m.status, 201);
  assert.equal((await call(off, "/join/judge-3", { match_id: m.body.match_id ?? m.body.id, seat: "a" })).status, 200);
});

t("the header tag works on matches, seats and guests too", async () => {
  const e = env(ON);
  const h = { "x-consent": V };
  const inv = await call(e, "/matches", { tier: "judge-3", seats: ["a", "b"], rules: "Pick the shorter answer.", host_pays: "a" }, h);
  assert.equal(inv.status, 201, JSON.stringify(inv.body).slice(0, 200));
  const iid = inv.body.match_id ?? inv.body.id;
  const host = await call(e, "/host/join/judge-3", { match_id: iid, seat: "a" }, h);
  assert.equal(host.status, 200, JSON.stringify(host.body).slice(0, 200));
  const token = host.body.invite?.invite_token ?? inv.body.invite?.invite_token;
  assert.equal((await call(e, "/invite/join", { match_id: iid, invite_token: token, seat: "b" }, h)).status, 200);
});

t("every company a model may come from is named in the notice, for the defaults and wrangler.jsonc", async () => {
  const src = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const vars: Record<string, string> = {};
  for (const m of src.matchAll(/"([A-Z_]+)":\s*"([^"]*)"/g)) if (!(m[1] in vars)) vars[m[1]] = m[2];
  for (const env of [{}, vars]) {
    const models = [...allowedModels(env), ...judgeAllowed(env as any)];
    const missing = [...new Set(models.map(companyOf))].filter((k) => !listedCompanies().includes(k));
    assert.deepEqual(missing, [], "add these companies to consent.ts COMPANIES (and bump NOTICE_VERSION)");
  }
});

t("a 428 leaves the team allowance untouched", async () => {
  const e = env(ON);
  const before = (await call(e, "/team/allowance", undefined, team)).body.team;
  for (let i = 0; i < 3; i++) isNotice(await call(e, "/team/review-3", review, team), "team review-3");
  const after = (await call(e, "/team/allowance", undefined, team)).body.team;
  assert.deepEqual(after, before);
});

t("GET /consent covers the opt-in and new models agents may name, not only the pool", async () => {
  const nb = (await call(env(ON), "/consent")).body;
  assert.ok(nb.models.includes("deepseek/deepseek-v4-pro-0813"), "an opt-in model");
  assert.ok(nb.models.includes("google/gemini-4-neon"), "a new model");
  assert.ok(nb.read_by.some((x: any) => x.company === "DeepSeek"));
});

t("a panel with a model from a company the notice doesn't name is refused, never sent under the notice", () => {
  const c = { env: { CONSENT_REQUIRED: "true" }, req: { header: () => V } };
  const r = consentCheck(c, { consent: V }, ["claude-sonnet-5-5", "acme/model-1"], "Nothing was charged.");
  assert.ok(r, "refused");
  assert.equal(r!.status, 503);
  assert.equal(consentCheck(c, { consent: V }, ["claude-sonnet-5-5", "openai/gpt-6-luna"], ""), null);
});

// The notice's text is pinned to its version: change the companies or the words, and this fails until NOTICE_VERSION
// is bumped and the new version's fingerprint added here (so everyone is asked again).
const NOTICE_FINGERPRINTS: Record<string, string> = {
  "2026-11-30.1": "ef6e91f0b7b272f917875954abc3934b807f167203023838a5abbc5b2e206a1d", // his own-work clause (withdrawn Nov 27)
  "2026-11-30.2": "bf2e6067baf216dce80d5fc1693856739c66c2a38bf63b82a00c075e306792c4", // own it or are allowed to send it (the team's suggestion)
};
t("the notice's text can't change without a new NOTICE_VERSION", () => {
  const sha = createHash("sha256").update(noticeText()).digest("hex");
  assert.equal(NOTICE_FINGERPRINTS[V], sha, `notice text changed: bump NOTICE_VERSION and pin "${sha}" for the new version`);
});

t("a judge match's receipt signs the creator's and each seat's notice version; with the step off it carries none", async () => {
  for (const on of [true, false]) {
    const e = env(on ? ON : {});
    const created = await call(e, "/matches", { tier: "judge-3", seats: ["a", "b"], rules: "Pick the shorter answer.", ...(on ? { consent: V } : {}) });
    assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 200));
    const id = created.body.match_id ?? created.body.id;
    const tok: Record<string, string> = {};
    tok.a = (await call(e, "/join/judge-3", { match_id: id, seat: "a", ...(on ? { consent: V } : {}) })).body.seat_token;
    tok.b = (await call(e, "/join/judge-3", { match_id: id, seat: "b" }, on ? { "x-consent": V } : {})).body.seat_token;
    assert.ok(tok.a && tok.b, "both joined");
    await call(e, `/matches/${id}/submit`, { seat: "a", seat_token: tok.a, position: "short" });
    const done = await call(e, `/matches/${id}/submit`, { seat: "b", seat_token: tok.b, position: "a much longer answer" });
    assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
    const receipt = done.body.match.receipt;
    assert.ok(receipt, JSON.stringify(done.body.match).slice(0, 300));
    if (on) {
      assert.deepEqual(receipt.payload.consent_versions, { creator: V, seats: { a: V, b: V } });
      assert.ok(await verified(receipt), "the signature covers consent_versions");
    } else assert.equal(receipt.payload.consent_versions, undefined);
  }
});

t("an invited guest's version is recorded beside the host's", async () => {
  const e = env(ON);
  const inv = await call(e, "/matches", { tier: "judge-3", seats: ["a", "b"], rules: "Pick the shorter answer.", host_pays: "a", consent: V });
  const iid = inv.body.match_id ?? inv.body.id;
  const host = await call(e, "/host/join/judge-3", { match_id: iid, seat: "a", consent: V });
  const token = host.body.invite?.invite_token ?? inv.body.invite?.invite_token;
  const g = await call(e, "/invite/join", { match_id: iid, invite_token: token, seat: "b", consent: V });
  assert.equal(g.status, 200, JSON.stringify(g.body).slice(0, 200));
  const room = e.MATCHES.objs.get(iid);
  const m = (room as any).m;
  assert.equal(m.creator_consent_version, V);
  assert.equal(m.joined.a.consent_version, V);
  assert.equal(m.joined.b.consent_version, V);
});
