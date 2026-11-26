import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/gate.ts";
import { Health, _resetHealthCaches } from "../src/health.ts";
import { Ledger } from "../src/ledger.ts";
import { MatchRoom } from "../src/match.ts";
import { _clearSnapshots } from "../src/gateclient.ts";
import { NOTICE_VERSION } from "../src/consent.ts";
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
const PAUSED = {};
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
  assert.match(r.body.notice.sender, /only your own work/, what);
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
