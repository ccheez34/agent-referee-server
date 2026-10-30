// Credit packs through the Worker's routes (spec v2 §8): switches, the webhook, fulfilment, keys, spending, caps,
// region and pauses, stats, admin. Needs the installed dependencies (hono, x402-hono), like routes.test.ts. Stripe is a
// stand-in on globalThis.fetch: no network, no keys (every secret here is fake).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate } from "../src/gate.ts";
import { Health, _resetHealthCaches } from "../src/health.ts";
import { Ledger } from "../src/ledger.ts";
import { MatchRoom } from "../src/match.ts";
import { _clearSnapshots } from "../src/gateclient.ts";
import { verifyReceipt } from "../src/receipt.ts";

let app: any = null;
try {
  app = (await import("../src/index.ts")).default;
} catch (e) {
  console.log(`credits routes tests skipped (dependencies not installed here): ${String((e as any)?.message ?? e).slice(0, 120)}`);
}
const t = app ? test : test.skip;

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };
const mem = () => {
  const d = new Map<string, unknown>();
  return {
    d,
    storage: {
      async get(k: string) { return structuredClone(d.get(k)); },
      async put(k: string, v: unknown) { d.set(k, structuredClone(v)); },
      async delete(k: any) { for (const x of [k].flat()) d.delete(x); return true; },
      async list(o: { prefix?: string; start?: string; limit?: number } = {}) {
        const ks = [...d.keys()].filter((k) => k.startsWith(o.prefix ?? "") && (!o.start || k >= o.start)).sort().slice(0, o.limit ?? Infinity);
        return new Map(ks.map((k) => [k, structuredClone(d.get(k))]));
      },
      async deleteAll() { d.clear(); },
      async setAlarm() {},
    },
  };
};
function ns<T extends { fetch(r: Request): Promise<Response> }>(make: () => T) {
  const objs = new Map<string, T>();
  const n = { objs, broken: false, idFromName: (x: string) => x, get: (id: string) => ({ fetch: async (u: string, i?: RequestInit) => { if (n.broken) throw new Error("object unavailable"); if (!objs.has(id)) objs.set(id, make()); return objs.get(id)!.fetch(new Request(u, i)); } }) };
  return n;
}
const ADMIN = "a".repeat(40);
const WH = "whsec_routes_test_fake_secret_not_real";
const STRIPE_KEY = "rk_test_routesFakeKey0001";
const ON = { CREDITS_ENABLED: "true", STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_WEBHOOK_SECRET: WH };
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
    ADMIN_TOKEN: ADMIN,
    GATES: ns(() => new Gate(mem() as any)),
    HEALTH: ns(() => new Health(mem() as any)),
    ...extra,
  };
  e.LEDGER = e.LEDGER ?? ns(() => new Ledger(mem() as any, e));
  e.MATCHES = ns(() => new MatchRoom(mem() as any, e));
  return e;
}
const ctx = { waitUntil() {}, passThroughOnException() {} };
const IP = { "cf-connecting-ip": "203.0.113.7" };
/** Any request; the answer as text and (when it is JSON) parsed. */
async function req(e: any, method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
  const res = await app.fetch(new Request(`https://x${path}`, { method, headers: { ...IP, ...(init.headers ?? {}) }, body: init.body }), e, ctx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, body: json };
}
const post = (e: any, path: string, body: unknown, headers: Record<string, string> = {}) => req(e, "POST", path, { body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const get = (e: any, path: string, headers: Record<string, string> = {}) => req(e, "GET", path, { headers });
const adminH = { authorization: `Bearer ${ADMIN}` };
const review = { task: "Add 2 and 2 and give only the number.", output: "4" };
const multi = (n: number) => ({ task: "Check the handoff: every fact is right and nothing open is missing.", pieces: Array.from({ length: n }, (_, i) => ({ text: `Piece ${i + 1} of the handoff.` })) });
const tick = () => new Promise((r) => setTimeout(r, 20));

const hex = async (s: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");
async function sign(body: string, secret = WH, t = Math.floor(Date.now() / 1000)) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `t=${t},v1=${Buffer.from(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${body}`))).toString("hex")}`;
}
const webhook = async (e: any, body: string, sig?: string) => req(e, "POST", "/credits/stripe-webhook", { body, headers: { "content-type": "application/json", "stripe-signature": sig ?? (await sign(body)) } });

type SessionOpts = { pack?: string; cents?: number; account_id?: string; nonce_hash?: string; pending_id?: string; livemode?: boolean; pi?: string; status?: string; payment_status?: string };
const checkoutSession = (sid: string, o: SessionOpts = {}) => ({
  id: sid,
  object: "checkout.session",
  status: o.status ?? "complete",
  mode: "payment",
  payment_status: o.payment_status ?? "paid",
  currency: "usd",
  amount_subtotal: o.cents ?? 1000,
  amount_total: o.cents ?? 1000,
  livemode: o.livemode ?? false,
  payment_intent: o.pi ?? `pi_${sid.slice(8)}`,
  metadata: { pack: o.pack ?? "small", ...(o.account_id ? { account_id: o.account_id } : {}), ...(o.nonce_hash ? { nonce_hash: o.nonce_hash } : {}), ...(o.pending_id ? { pending_id: o.pending_id } : {}) },
});
const event = (type: string, object: unknown, livemode = false) => JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, livemode, data: { object } });

const NONCE = "5a".repeat(32);
/** A new account bought through the webhook, its key revealed with the nonce cookie: returns the key. */
async function buyKey(e: any, sid = "cs_test_routesbuy00001", o: SessionOpts = {}) {
  const w = await webhook(e, event("checkout.session.completed", checkoutSession(sid, { nonce_hash: await hex(NONCE), ...o })));
  assert.equal(w.status, 200, w.text);
  const r = await post(e, "/credits/done/reveal", { session_id: sid }, { cookie: `ar_credits_nonce=${NONCE}` });
  assert.equal(r.status, 200, r.text);
  assert.match(r.body.key, /^arc_[A-Za-z0-9_-]{43}$/);
  return r.body.key as string;
}
const withKey = (key: string, extra: Record<string, string> = {}) => ({ "x-credits-key": key, ...extra });

/** Stands in for Stripe's API on globalThis.fetch; records every call. */
function fakeStripe(handler?: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; form: URLSearchParams }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    if (!u.startsWith("https://api.stripe.com/")) throw new Error(`unexpected fetch ${u}`);
    calls.push({ url: u, init, form: new URLSearchParams(typeof init.body === "string" ? init.body : "") });
    if (handler) return handler(u, init);
    if (init.method === "POST" && u.endsWith("/v1/checkout/sessions")) {
      const id = `cs_test_made${String(calls.length).padStart(8, "0")}`;
      return new Response(JSON.stringify({ id, object: "checkout.session", url: `https://checkout.stripe.com/c/pay/${id}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing" } }), { status: 404 });
  }) as any;
  return { calls, restore: () => (globalThis.fetch = orig) };
}
const balanceOf = async (e: any, key: string) => (await get(e, "/credits/account", withKey(key))).body.credits.balance_micro as number;

// ---------- switches ----------

t("switches: off without CREDITS_ENABLED (404) while the webhook still works; the operator's token opens it for tests", async () => {
  const e = env({ STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_WEBHOOK_SECRET: WH });
  for (const [m, p] of [["GET", "/credits"], ["POST", "/credits/checkout"], ["POST", "/credits/review"], ["GET", "/credits/account"], ["POST", "/credits/claim"], ["GET", "/credits/done?session_id=cs_test_abcdefgh123"]])
    assert.equal((await req(e, m, p, { body: m === "POST" ? "{}" : undefined, headers: { "content-type": "application/json" } })).status, 404, `${m} ${p}`);
  // The webhook still credits (a refund or dispute after a switch-off must still apply).
  const w = await webhook(e, event("checkout.session.completed", checkoutSession("cs_test_switchoff0001")));
  assert.equal(w.status, 200, w.text);
  const op = { "x-operator-token": ADMIN };
  assert.equal((await get(e, "/credits?format=json", op)).status, 200);
  // Spending needs no Stripe key (staging can test with an admin-adjusted account).
  const noStripe = env({ CREDITS_ENABLED: "true" });
  assert.equal((await get(noStripe, "/credits")).status, 404, "buying needs a Stripe key");
  assert.equal((await post(noStripe, "/credits/review", review)).status, 401, "spending is on: it wants a key");
});

t("switches: a live key without CREDITS_LIVE is refused (503) and /health says misconfigured; /health shows the mode", async () => {
  const live = env({ CREDITS_ENABLED: "true", STRIPE_SECRET_KEY: "sk_live_notreal0000000", STRIPE_WEBHOOK_SECRET: WH });
  assert.equal((await post(live, "/credits/checkout", { pack: "small" })).status, 503);
  assert.equal((await post(live, "/credits/review", review, withKey(`arc_${"A".repeat(43)}`))).status, 503);
  assert.equal((await webhook(live, event("checkout.session.completed", checkoutSession("cs_test_live00000001")))).status, 503, "Stripe retries until it's fixed");
  const h = await get(live, "/health");
  assert.equal(h.body.checks.credits, "misconfigured");
  assert.ok(h.body.warnings.includes("credits_misconfigured"));
  assert.equal((await get(env(), "/health")).body.checks.credits, "off");
  assert.equal((await get(env(ON), "/health")).body.checks.credits, "test");
});

// ---------- the webhook ----------

t("webhook: a valid signature credits once; a bad or old signature, a tampered body or the wrong mode is refused", async () => {
  const e = env(ON);
  const body = event("checkout.session.completed", checkoutSession("cs_test_webhook00001"));
  assert.equal((await webhook(e, body, await sign(body, "whsec_some_other_secret"))).status, 400);
  assert.equal((await webhook(e, body, await sign(body, WH, Math.floor(Date.now() / 1000) - 301))).status, 400, "older than 300 s");
  assert.equal((await webhook(e, body.replace('"amount_subtotal":1000', '"amount_subtotal":100000'), await sign(body))).status, 400, "tampered");
  assert.equal((await webhook(e, body, "")).status, 400);
  const liveEvent = event("checkout.session.completed", checkoutSession("cs_test_webhook00002", { livemode: true }), true);
  assert.equal((await webhook(e, liveEvent)).status, 400, "a live event in test mode");
  assert.equal((await webhook(e, body)).status, 200);
  assert.equal((await webhook(e, body)).status, 200, "the same event again");
  const v = await get(e, "/admin/credits/cs_test_webhook00001", adminH);
  assert.equal(v.body.balance_micro, 10_000_000, "credited once");
  assert.equal((await webhook(e, event("customer.created", { id: "cus_1" }))).status, 200, "other events are ignored");
  assert.equal((await webhook(env({ ...ON, STRIPE_WEBHOOK_SECRET: undefined }), body)).status, 404, "no secret, no webhook");
});

t("webhook: a ledger failure answers 5xx so Stripe retries; a refund before its purchase is 5xx, then applies on retry", async () => {
  const e = env(ON);
  const refund = event("charge.refunded", { id: "ch_test_early0001", object: "charge", payment_intent: "pi_routesearly01", amount: 1000, amount_refunded: 400 });
  assert.equal((await webhook(e, refund)).status, 503);
  await webhook(e, event("checkout.session.completed", checkoutSession("cs_test_routesearly01")));
  assert.equal((await webhook(e, refund)).status, 200);
  assert.equal((await get(e, "/admin/credits/pi_routesearly01", adminH)).body.balance_micro, 6_000_000);
  e.LEDGER.broken = true;
  assert.equal((await webhook(e, event("checkout.session.completed", checkoutSession("cs_test_routesdown001")))).status, 503);
});

t("webhook: a mismatch (unpaid, wrong amount, unknown pack) is held and credits nothing; /done says it's being checked", async () => {
  const e = env(ON);
  await webhook(e, event("checkout.session.completed", checkoutSession("cs_test_routesheld001", { cents: 999 })));
  const s = fakeStripe();
  try {
    const page = await get(e, "/credits/done?session_id=cs_test_routesheld001", { accept: "text/html" });
    assert.equal(page.status, 200);
    assert.match(page.text, /checked by hand/);
    assert.ok(!/failed/i.test(page.text));
    assert.equal(s.calls.length, 0, "recorded already: no Stripe call");
  } finally {
    s.restore();
  }
  const h = await get(e, "/health");
  assert.ok(h.body.warnings.includes("credit_pack_alert"), "the operator is alerted");
});

t("webhook: a dispute freezes and debits; checkout.session.expired clears the open checkout", async () => {
  const e = env(ON);
  const key = await buyKey(e, "cs_test_routesdisp001");
  assert.equal((await webhook(e, event("charge.dispute.created", { id: "dp_test_routes01", object: "dispute", payment_intent: "pi_routesdisp001", amount: 1000 }))).status, 200);
  const spend = await post(e, "/credits/review", review, withKey(key));
  assert.equal(spend.status, 403);
  assert.match(spend.body.error, /frozen/);
  const v = await get(e, "/credits/account", withKey(key));
  assert.equal(v.body.credits.frozen, true, "a frozen account can still read its balance");
  assert.equal(v.body.credits.balance_micro, 0);
  // checkout.session.expired: the open checkout's slot (and its pending amount) is freed.
  const s = fakeStripe();
  try {
    const opened = [];
    for (let i = 0; i < 3; i++) opened.push((await post(e, "/credits/checkout", { pack: "small" }, { "cf-connecting-ip": "198.51.100.90" })).status);
    assert.deepEqual(opened, [200, 200, 200]);
    assert.equal((await post(e, "/credits/checkout", { pack: "small" }, { "cf-connecting-ip": "198.51.100.90" })).status, 429);
    const pid = s.calls[0].form.get("metadata[pending_id]");
    const expired = await webhook(e, event("checkout.session.expired", { id: "cs_test_made00000001", object: "checkout.session", status: "expired", metadata: { pack: "small", pending_id: pid } }));
    assert.equal(expired.status, 200);
    assert.equal((await post(e, "/credits/checkout", { pack: "small" }, { "cf-connecting-ip": "198.51.100.90" })).status, 200, "room again");
  } finally {
    s.restore();
  }
});

// ---------- buying ----------

t("checkout: a Checkout Session priced from CREDITS_PACKS, pinned API version, idempotency key, the nonce cookie", async () => {
  const e = env(ON);
  const s = fakeStripe();
  try {
    const r = await post(e, "/credits/checkout", { pack: "medium" });
    assert.equal(r.status, 200, r.text);
    assert.match(r.body.url, /^https:\/\/checkout\.stripe\.com\//);
    const call = s.calls[0];
    const h = call.init.headers as Record<string, string>;
    assert.equal(h["stripe-version"], "2026-09-30.endive");
    assert.match(h["idempotency-key"], /^credits-checkout-[0-9a-f]{32}$/);
    assert.equal(h.authorization, `Bearer ${STRIPE_KEY}`);
    const f = call.form;
    assert.equal(f.get("mode"), "payment");
    assert.equal(f.get("payment_method_types[0]"), "card");
    assert.equal(f.get("line_items[0][price_data][unit_amount]"), "2500");
    assert.equal(f.get("line_items[0][price_data][currency]"), "usd");
    assert.equal(f.get("metadata[pack]"), "medium");
    assert.match(f.get("metadata[pending_id]")!, /^[0-9a-f]{32}$/);
    assert.match(f.get("metadata[nonce_hash]")!, /^[0-9a-f]{64}$/);
    assert.equal(f.get("metadata[account_id]"), null);
    assert.equal(f.get("success_url"), "https://x/credits/done?session_id={CHECKOUT_SESSION_ID}");
    const exp = Number(f.get("expires_at")) * 1000 - Date.now();
    assert.ok(exp > 30 * 60_000 && exp <= 31 * 60_000, "just over Stripe's 30-minute minimum");
    const cookie = r.headers.get("set-cookie")!;
    assert.match(cookie, /^ar_credits_nonce=[0-9a-f]{64}; Path=\/credits\/done; Max-Age=86400; HttpOnly; Secure; SameSite=Lax$/);
    assert.equal(f.get("metadata[nonce_hash]"), await hex(cookie.split(";")[0].split("=")[1]));
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("access-control-allow-origin"), null, "no CORS on /credits");
    // A browser form: 303 to Stripe.
    const form = await req(e, "POST", "/credits/checkout", { body: "pack=small", headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(form.status, 303);
    assert.match(form.headers.get("location")!, /^https:\/\/checkout\.stripe\.com\//);
    assert.equal((await post(e, "/credits/checkout", { pack: "huge" })).status, 400);
  } finally {
    s.restore();
  }
});

t("checkout: at most 3 open per address; Stripe failing answers 502 and frees the slot; caps count open checkouts", async () => {
  const e = env({ ...ON, CREDITS_MAX_BALANCE_USD: "30" });
  const s = fakeStripe();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await post(e, "/credits/checkout", { pack: "small" })).status, 200);
    const fourth = await post(e, "/credits/checkout", { pack: "small" });
    assert.equal(fourth.status, 429);
    assert.match(fourth.body.error, /3 checkouts open/);
    assert.equal((await post(e, "/credits/checkout", { pack: "small" }, { "cf-connecting-ip": "198.51.100.77" })).status, 200, "another address");
  } finally {
    s.restore();
  }
  const down = fakeStripe(() => new Response(JSON.stringify({ error: { type: "api_error" } }), { status: 500 }));
  try {
    const r = await post(e, "/credits/checkout", { pack: "small" }, { "cf-connecting-ip": "198.51.100.78" });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /Nothing was charged/);
  } finally {
    down.restore();
  }
  const ok = fakeStripe();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await post(e, "/credits/checkout", { pack: "small" }, { "cf-connecting-ip": "198.51.100.78" })).status, 200, "the failed one didn't keep a slot");
    // Caps: a $10 account topping up with $25 while $25 is already open would pass $30.
    const key = await buyKey(e, "cs_test_routescaps001");
    assert.equal((await post(e, "/credits/checkout", { pack: "small" }, withKey(key, { "cf-connecting-ip": "198.51.100.79" }))).status, 200);
    const over = await post(e, "/credits/checkout", { pack: "medium" }, withKey(key, { "cf-connecting-ip": "198.51.100.79" }));
    assert.equal(over.status, 429);
    assert.match(over.body.error, /over \$30\.00/);
    const top = ok.calls.at(-1)!;
    assert.match(top.form.get("metadata[account_id]")!, /^arca_/);
    assert.equal(top.form.get("metadata[nonce_hash]"), null, "a top-up never gets a reveal nonce");
  } finally {
    ok.restore();
  }
});

t("/credits/done: a bad id gets 'not found' with no Stripe call; Stripe down says 'being added'; it fulfils a finished checkout once", async () => {
  const e = env(ON);
  const s = fakeStripe();
  try {
    for (const bad of ["x", "cs_live_abcdefgh1234", "cs_test_../../v1/charges", ""]) assert.equal((await get(e, `/credits/done?session_id=${encodeURIComponent(bad)}`)).status, 404);
    assert.equal(s.calls.length, 0, "no Stripe call");
  } finally {
    s.restore();
  }
  const down = fakeStripe(() => {
    throw new Error("network down");
  });
  try {
    const p = await get(e, "/credits/done?session_id=cs_test_routesdone001");
    assert.equal(p.status, 200);
    assert.match(p.text, /being added/);
    assert.match(p.text, /http-equiv="refresh" content="10"/);
  } finally {
    down.restore();
  }
  const open = fakeStripe(() => new Response(JSON.stringify(checkoutSession("cs_test_routesdone002", { status: "open", payment_status: "unpaid" }))));
  try {
    assert.match((await get(e, "/credits/done?session_id=cs_test_routesdone002")).text, /hasn't been paid/);
  } finally {
    open.restore();
  }
  // Paid: /done fulfils, and the webhook arriving afterwards doesn't credit again.
  const sid = "cs_test_routesdone003";
  const paid = fakeStripe(() => new Response(JSON.stringify(checkoutSession(sid, { nonce_hash: "ab".repeat(32) }))));
  try {
    const p = await get(e, `/credits/done?session_id=${sid}`);
    assert.match(p.text, /Credits added/);
    assert.match(p.text, /Reveal my key/);
    assert.equal(p.headers.get("referrer-policy"), "no-referrer");
    assert.match(p.headers.get("content-security-policy")!, /default-src 'none'/);
  } finally {
    paid.restore();
  }
  assert.equal((await webhook(e, event("checkout.session.completed", checkoutSession(sid)))).status, 200);
  assert.equal((await get(e, `/admin/credits/${sid}`, adminH)).body.balance_micro, 10_000_000);
  // An unfinished checkout is never recorded as held (it would never be credited once paid).
  const unfinished = await webhook(e, event("checkout.session.completed", checkoutSession("cs_test_routesdone004", { status: "open" })));
  assert.equal(unfinished.status, 200);
  assert.equal((await get(e, "/admin/credits/cs_test_routesdone004", adminH)).status, 404);
});

// ---------- keys ----------

t("keys: revealed only with the nonce cookie, once; two reveals at once give one key; a top-up never issues one", async () => {
  const e = env(ON);
  const sid = "cs_test_routeskeys001";
  await webhook(e, event("checkout.session.completed", checkoutSession(sid, { nonce_hash: await hex(NONCE) })));
  assert.equal((await post(e, "/credits/done/reveal", { session_id: sid })).status, 403, "no cookie");
  assert.equal((await post(e, "/credits/done/reveal", { session_id: sid }, { cookie: `ar_credits_nonce=${"0".repeat(64)}` })).status, 403, "another browser's cookie");
  const both = await Promise.all([1, 2].map(() => post(e, "/credits/done/reveal", { session_id: sid }, { cookie: `ar_credits_nonce=${NONCE}` })));
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  const winner = both.find((r) => r.status === 200)!;
  assert.match(winner.headers.get("set-cookie")!, /Max-Age=0/, "the cookie is cleared");
  assert.equal(winner.headers.get("cache-control"), "no-store");
  assert.equal((await get(e, "/credits/account", withKey(winner.body.key))).status, 200);
  const page = await req(e, "POST", "/credits/done/reveal", { body: `session_id=${sid}`, headers: { "content-type": "application/x-www-form-urlencoded", cookie: `ar_credits_nonce=${NONCE}` } });
  assert.equal(page.status, 409);
  assert.match(page.text, /already been shown/);
  // A top-up session never issues a key.
  const acct = (await get(e, "/credits/account", withKey(winner.body.key))).body.credits.account_id;
  await webhook(e, event("checkout.session.completed", checkoutSession("cs_test_routeskeys002", { account_id: acct, nonce_hash: await hex(NONCE) })));
  assert.equal((await post(e, "/credits/done/reveal", { session_id: "cs_test_routeskeys002" }, { cookie: `ar_credits_nonce=${NONCE}` })).status, 409);
  assert.equal(await balanceOf(e, winner.body.key), 20_000_000);
});

t("keys: after the operator's rotate the old key fails at once; the claim code gives a new key, once", async () => {
  const e = env(ON);
  const key = await buyKey(e, "cs_test_routesrot0001");
  const acct = (await get(e, "/credits/account", withKey(key))).body.credits.account_id;
  assert.equal((await post(e, "/admin/credits/rotate", { account_id: acct, reason: "lost key" })).status, 401, "admin only");
  const rot = await post(e, "/admin/credits/rotate", { account_id: acct, reason: "lost key" }, adminH);
  assert.equal(rot.status, 200, rot.text);
  assert.match(rot.body.claim_code, /^arcc_[A-Za-z0-9_-]{24}$/);
  assert.equal((await post(e, "/credits/review", review, withKey(key))).status, 401);
  const claim = await post(e, "/credits/claim", { code: rot.body.claim_code });
  assert.equal(claim.status, 200, claim.text);
  assert.equal((await post(e, "/credits/claim", { code: rot.body.claim_code })).status, 404, "once");
  assert.equal(await balanceOf(e, claim.body.key), 10_000_000);
});

// ---------- spending ----------

t("spending: the receipt says funding credits with no payer and no network; the price is taken once; a failure uses nothing", async () => {
  const e = env(ON);
  const key = await buyKey(e);
  const r = await post(e, "/credits/review", review, withKey(key, { "x-payment": "bm90LWEtcmVhbC1wYXltZW50" }));
  assert.equal(r.status, 200, r.text);
  const p = r.body.receipt.payload;
  assert.equal(p.funding, "credits");
  assert.equal(p.payer, null, "an x-payment header sent along is ignored");
  assert.equal("network" in p, false);
  assert.ok(!JSON.stringify(r.body.receipt).includes("arca_"), "no account id in the receipt");
  assert.equal(await verifyReceipt(r.body.receipt, keys.PUBLIC_KEY), true);
  assert.equal(r.body.credits.charged, "$0.05");
  assert.equal(r.body.credits.balance_micro, 9_950_000);
  assert.equal(await balanceOf(e, key), 9_950_000);
  const fail = await post(e, "/credits/review", review, withKey(key, { "x-test-fake-mix": "500:1", "x-test-fake-delay": "1-2" }));
  assert.ok(fail.status >= 500, fail.text);
  assert.equal(await balanceOf(e, key), 9_950_000, "the failed review's hold came back");
  const acct = await get(e, "/credits/account", withKey(key));
  assert.equal(acct.body.credits.held, "$0.00");
});

t("spending: every tier routes to its own price (the routePath fix)", async () => {
  const e = env({ ...ON, MULTI_PART_ENABLED: "true" });
  const key = await buyKey(e);
  const cases: [string, unknown, string, number][] = [
    ["/credits/review", review, "review", 50_000],
    ["/credits/review-3", review, "review-3", 200_000],
    ["/credits/review-3x2", multi(2), "review-3x2", 600_000],
    ["/credits/review-3x3", multi(3), "review-3x3", 700_000],
  ];
  let left = 10_000_000;
  for (const [path, body, tier, price] of cases) {
    const r = await post(e, path, body, withKey(key));
    assert.equal(r.status, 200, `${path}: ${r.text}`);
    assert.equal(r.body.receipt.payload.tier, tier);
    assert.equal(r.body.receipt.payload.funding, "credits");
    left -= price;
    assert.equal(r.body.credits.balance_micro, left, path);
  }
});

t("spending: not enough credits is 429 with nothing used (not 402); wrong method, no key or a bad key is refused", async () => {
  const e = env(ON);
  const key = await buyKey(e);
  await post(e, "/admin/credits/adjust", { account_id: (await get(e, "/credits/account", withKey(key))).body.credits.account_id, amount_usd: "-9.97", reason: "leave 3 cents" }, adminH);
  const r = await post(e, "/credits/review", review, withKey(key));
  assert.equal(r.status, 429);
  assert.match(r.body.error, /Nothing was used/);
  assert.equal(r.body.credits.balance_micro, 30_000);
  assert.equal((await get(e, "/credits/review", withKey(key))).status, 405);
  assert.equal((await post(e, "/credits/review", review)).status, 401);
  assert.equal((await post(e, "/credits/review", review, withKey("arc_short"))).status, 401);
  assert.equal((await post(e, "/credits/review", review, { authorization: `Bearer ${key}` })).status, 429, "Bearer works too");
});

t("spending: a reserve that times out answers 503 'nothing was used' and leaves a tombstone, so the late reserve can't hold", async () => {
  const e = env({ ...ON, LEDGER_TIMEOUT_MS: "50" });
  const key = await buyKey(e);
  const get0 = e.LEDGER.get;
  let hung = false;
  e.LEDGER.get = (id: string) => {
    const stub = get0(id);
    return {
      fetch: async (u: string, i?: RequestInit) => {
        if (id === "credits" && u.endsWith("/credits-reserve") && !hung) {
          hung = true;
          await new Promise((r) => setTimeout(r, 120)); // arrives after the Worker gave up (and after its release)
        }
        return stub.fetch(u, i);
      },
    };
  };
  const r = await post(e, "/credits/review", review, withKey(key));
  assert.equal(r.status, 503);
  assert.match(r.body.error, /Nothing was used/);
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(await balanceOf(e, key), 10_000_000, "the late reserve was refused by the tombstone");
});

t("spending: region rules (451) and pauses apply to spending and to checkout; the webhook is exempt", async () => {
  const e = env(ON);
  const key = await buyKey(e);
  assert.equal((await post(e, "/credits/review", review, withKey(key, { "x-test-country": "KP" }))).status, 451);
  assert.equal((await post(e, "/credits/checkout", { pack: "small" }, { "x-test-country": "KP" })).status, 451);
  assert.equal(await balanceOf(e, key), 10_000_000);
  // Stripe's servers call the webhook: no region check there.
  const body = event("checkout.session.completed", checkoutSession("cs_test_routesregion1"));
  const w = await req(e, "POST", "/credits/stripe-webhook", { body, headers: { "content-type": "application/json", "stripe-signature": await sign(body), "x-test-country": "KP" } });
  assert.equal(w.status, 200, w.text);
  const paused = env({ ...ON, PAID_PAUSED: "true" });
  const k2 = await buyKey(paused, "cs_test_routespause01");
  assert.equal((await post(paused, "/credits/review", review, withKey(k2))).status, 503);
  assert.equal((await post(paused, "/credits/checkout", { pack: "small" })).status, 503);
  const reviewsPaused = env({ ...ON, REVIEWS_PAUSED: "true" });
  const k3 = await buyKey(reviewsPaused, "cs_test_routespause02");
  assert.equal((await post(reviewsPaused, "/credits/review", review, withKey(k3))).status, 503);
  const s = fakeStripe();
  try {
    assert.equal((await post(reviewsPaused, "/credits/checkout", { pack: "small" })).status, 200, "buying isn't a review");
  } finally {
    s.restore();
  }
});

t("stats: credits reviews are counted as credits_*, never as x402 paid ones", async () => {
  const e = env(ON);
  const key = await buyKey(e);
  assert.equal((await post(e, "/credits/review", review, withKey(key))).status, 200);
  await post(e, "/credits/review", review, withKey(key, { "x-test-fake-mix": "500:1", "x-test-fake-delay": "1-2" }));
  await tick();
  const today = (await get(e, "/admin/stats", adminH)).body.today.counts;
  assert.equal(today.credits_ok_review, 1, JSON.stringify(today));
  assert.equal(today.credits_failed, 1);
  assert.equal(today.paid_ok_review, undefined);
  assert.equal(today.paid_failed, undefined);
});

// ---------- the operator ----------

t("admin: the account by id, checkout or payment intent; adjust and freeze with a reason; a CSV export of the log", async () => {
  const e = env(ON);
  const key = await buyKey(e, "cs_test_routesadmin01");
  await post(e, "/credits/review", review, withKey(key));
  assert.equal((await get(e, "/admin/credits/cs_test_routesadmin01")).status, 401);
  const v = await get(e, "/admin/credits/pi_routesadmin01", adminH);
  assert.equal(v.status, 200, v.text);
  assert.equal(v.body.purchases[0].refundable_cents, 995);
  assert.equal((await post(e, "/admin/credits/adjust", { account_id: v.body.account_id, freeze: true }, adminH)).status, 400, "a reason is required");
  const fz = await post(e, "/admin/credits/adjust", { account_id: v.body.account_id, freeze: true, reason: "=HYPERLINK(\"x\")" }, adminH);
  assert.equal(fz.body.frozen, true);
  assert.equal((await post(e, "/credits/review", review, withKey(key))).status, 403);
  const csv = await get(e, "/admin/credits/export", adminH);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type")!, /text\/csv/);
  const lines = csv.text.trim().split("\r\n");
  assert.match(lines[0], /^seq,at,type,account_id,amount_micro/);
  assert.deepEqual(lines.slice(1).map((l) => l.split(",")[2]), ["purchase", "key_issued", "reserve", "commit", "admin_view", "adjust", "admin_export"]);
  assert.ok(csv.text.includes(`"'=HYPERLINK(""x"")"`), "a formula-looking reason can't run in a spreadsheet");
  const made = await post(e, "/admin/credits/adjust", { create: true, amount_usd: "5", reason: "held checkout fixed by hand" }, adminH);
  assert.match(made.body.account_id, /^arca_/);
  assert.equal(made.body.balance_micro, 5_000_000);
});
