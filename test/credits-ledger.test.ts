// Credit packs: the "credits" ledger object (credits-ledger.ts through Ledger.fetch). Runs with Node alone: no hono,
// no network, no keys. Spec v2 §8: reservations, fulfilment, keys, refunds and disputes, caps, config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ledger } from "../src/ledger.ts";
import { checkPaidSession, creditsConfig, parsePacks, HOLD_MAX_MS, MARKER_KEEP_MS, CLAIM_TTL_MS, MICRO_PER_USD } from "../src/credits-ledger.ts";

/** In-memory Durable Object storage with list (prefix, inclusive start, limit), delete and a recorded alarm. */
function mem() {
  const d = new Map<string, unknown>();
  const alarms: number[] = [];
  const storage = {
    async get<T>(k: string) {
      return structuredClone(d.get(k)) as T | undefined;
    },
    async put(k: string, v: unknown) {
      d.set(k, structuredClone(v));
    },
    async delete(k: string | string[]) {
      for (const x of [k].flat()) d.delete(x);
      return true;
    },
    async list<T>(o: { prefix?: string; start?: string; limit?: number } = {}) {
      const keys = [...d.keys()].filter((k) => k.startsWith(o.prefix ?? "") && (!o.start || k >= o.start)).sort().slice(0, o.limit ?? Infinity);
      return new Map(keys.map((k) => [k, structuredClone(d.get(k)) as T]));
    },
    async deleteAll() {
      d.clear();
    },
    async setAlarm(t: number) {
      alarms.push(t);
    },
  };
  return { storage, d, alarms };
}

const T0 = Date.parse("2026-10-30T22:00:00Z");
const ENV = { CREDITS_ENABLED: "true" } as any;

function setup(env: any = ENV) {
  const m = mem();
  const l = new Ledger({ storage: m.storage } as any, env);
  let clock = T0;
  l.now = () => clock;
  const call = async (action: string, body: unknown) => {
    const res = await l.fetch(new Request(`https://ledger/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as any };
  };
  return { l, m, call, tick: (ms: number) => (clock += ms), now: () => clock };
}

const hex = (n: number, seed: string) => (seed.repeat(n).slice(0, n));
const KEY1 = hex(64, "a1");
const KEY2 = hex(64, "b2");
const NONCE = hex(64, "c3");
let tokenN = 0;
const token = () => (++tokenN).toString(16).padStart(32, "0");
const pendingId = () => `${(++tokenN).toString(16).padStart(31, "0")}e`;

function session(id: string, over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    id,
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    currency: "usd",
    amount_subtotal: 1000,
    amount_total: 1000,
    livemode: false,
    payment_intent: `pi_${id.slice(8)}`,
    metadata: { pack: "small", nonce_hash: NONCE, ...meta },
    ...over,
  };
}

/** Buys a new account (pack small, $10) and reveals its key: returns its id. */
async function newAccount(s: ReturnType<typeof setup>, sid = "cs_test_newaccount0001", key = KEY1) {
  const f = await s.call("credits-fulfill", { session: session(sid) });
  assert.equal(f.status, 200);
  assert.equal(f.body.fulfilled, true);
  const k = await s.call("credits-issue-key", { session_id: sid, nonce_hash: NONCE, key_hash: key });
  assert.equal(k.status, 200, JSON.stringify(k.body));
  const a = await s.call("credits-auth", { key_hash: key });
  assert.equal(a.status, 200);
  return a.body.account_id as string;
}

async function entries(s: ReturnType<typeof setup>) {
  return (await s.call("credits-export", {})).body.entries as any[];
}

// ---------- config ----------

test("packs: the default list, custom lists, bad entries skipped", () => {
  assert.deepEqual([...parsePacks(undefined)], [["small", 1000], ["medium", 2500], ["large", 10000]]);
  assert.deepEqual([...parsePacks("tiny=1,odd=2.50, big=200")], [["tiny", 100], ["odd", 250], ["big", 20000]]);
  assert.deepEqual([...parsePacks("x=0.5,Bad=10,ok=10,ok=20,neg=-1,y=1.234")], [["ok", 1000]]);
});

test("mode: off, test, live, and misconfigured for a live key without CREDITS_LIVE (or the reverse)", () => {
  assert.equal(creditsConfig({}).mode, "off");
  assert.equal(creditsConfig({ CREDITS_ENABLED: "true" }).mode, "test");
  assert.equal(creditsConfig({ CREDITS_ENABLED: "true", STRIPE_SECRET_KEY: "rk_test_abcdefgh123" }).mode, "test");
  assert.equal(creditsConfig({ CREDITS_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_abcdefgh123" }).mode, "test");
  const live = creditsConfig({ CREDITS_ENABLED: "true", STRIPE_SECRET_KEY: "sk_live_abcdefgh123" });
  assert.equal(live.mode, "misconfigured");
  assert.match(live.problem!, /CREDITS_LIVE isn't/);
  assert.ok(!live.problem!.includes("abcdefgh"), "never names the key");
  assert.equal(creditsConfig({ STRIPE_SECRET_KEY: "rk_live_abcdefgh123" }).mode, "misconfigured", "even while switched off");
  assert.equal(creditsConfig({ CREDITS_ENABLED: "true", CREDITS_LIVE: "true", STRIPE_SECRET_KEY: "rk_test_abcdefgh123" }).mode, "misconfigured");
  assert.equal(creditsConfig({ CREDITS_ENABLED: "true", STRIPE_SECRET_KEY: "pk_test_abcdefgh123" }).mode, "misconfigured");
  assert.equal(creditsConfig({ CREDITS_ENABLED: "true", CREDITS_LIVE: "true", STRIPE_SECRET_KEY: "rk_live_abcdefgh123" }).mode, "live");
  assert.equal(creditsConfig({}).maxBalanceMicro, 500 * MICRO_PER_USD);
  assert.equal(creditsConfig({ CREDITS_MAX_DAILY_USD: "100" }).maxDailyMicro, 100 * MICRO_PER_USD);
});

test("the paid-session check: every condition in spec §5.2", () => {
  const cfg = creditsConfig({});
  assert.deepEqual(checkPaidSession(session("cs_test_x0000001"), cfg), { ok: true, pack: "small", cents: 1000, credits_micro: 10 * MICRO_PER_USD });
  const bad = (over: Record<string, unknown>, meta: Record<string, unknown> = {}) => (checkPaidSession(session("cs_test_x0000001", over, meta), cfg) as any).reason;
  assert.equal(bad({ payment_status: "unpaid" }), "not_paid");
  assert.equal(bad({ mode: "subscription" }), "not_payment_mode");
  assert.equal(bad({ currency: "eur" }), "wrong_currency");
  assert.equal(bad({ amount_subtotal: 999 }), "wrong_amount");
  assert.equal(bad({ amount_subtotal: 2500 }), "wrong_amount");
  assert.equal(bad({}, { pack: "huge" }), "unknown_pack");
  assert.equal(bad({ livemode: true }), "livemode_mismatch");
  assert.equal(bad({ object: "payment_intent" }), "not_a_checkout_session");
  assert.equal((checkPaidSession(session("cs_test_x0000001", { livemode: true }), creditsConfig({ CREDITS_LIVE: "true" })) as any).ok, true);
});

// ---------- fulfilment ----------

test("fulfil: a new account is created and credited once, even for the same event twice", async () => {
  const s = setup();
  const first = await s.call("credits-fulfill", { session: session("cs_test_once00000001") });
  assert.equal(first.body.fulfilled, true);
  assert.equal(first.body.created_account, true);
  assert.equal(first.body.balance_micro, 10 * MICRO_PER_USD);
  const again = await s.call("credits-fulfill", { session: session("cs_test_once00000001") });
  assert.equal(again.body.already, true);
  const view = await s.call("credits-view", { session_id: "cs_test_once00000001" });
  assert.equal(view.body.balance_micro, 10 * MICRO_PER_USD);
  assert.equal(view.body.total_bought_micro, 10 * MICRO_PER_USD);
  assert.equal(view.body.purchases.length, 1);
  assert.equal(view.body.has_key, false);
  assert.match(view.body.account_id, /^arca_[0-9a-f]{24}$/);
  const log = await entries(s);
  assert.deepEqual(log.map((e) => e.type), ["purchase"]);
});

test("fulfil: the webhook racing /credits/done credits once", async () => {
  const s = setup();
  const sid = "cs_test_race00000001";
  const [a, b] = await Promise.all([s.call("credits-fulfill", { session: session(sid) }), s.call("credits-fulfill", { session: session(sid) })]);
  assert.equal([a, b].filter((r) => r.body.fulfilled).length, 1);
  assert.equal([a, b].filter((r) => r.body.already).length, 1);
  const view = await s.call("credits-view", { session_id: sid });
  assert.equal(view.body.balance_micro, 10 * MICRO_PER_USD);
});

test("fulfil: unpaid, wrong amount, wrong currency, unknown pack or livemode mismatch is held and credits nothing", async () => {
  const s = setup();
  const cases: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
    ["cs_test_held00000001", { payment_status: "unpaid" }, {}, "not_paid"],
    ["cs_test_held00000002", { amount_subtotal: 1 }, {}, "wrong_amount"],
    ["cs_test_held00000003", { currency: "gbp" }, {}, "wrong_currency"],
    ["cs_test_held00000004", {}, { pack: "free" }, "unknown_pack"],
    ["cs_test_held00000005", { livemode: true }, {}, "livemode_mismatch"],
    ["cs_test_held00000006", {}, { account_id: "arca_000000000000000000000000" }, "unknown_account"],
    ["cs_test_held00000007", {}, { account_id: "not-an-account" }, "bad_account_id"],
  ];
  for (const [sid, over, meta, why] of cases) {
    const r = await s.call("credits-fulfill", { session: session(sid, over, meta) });
    assert.equal(r.body.held, true, sid);
    assert.equal(r.body.reason, why, sid);
    assert.equal(r.body.alert, "held");
    const page = await s.call("credits-session", { session_id: sid });
    assert.equal(page.body.status, "held");
    assert.equal(page.body.credits_micro, 0);
    assert.equal(page.body.key_available, false);
    // Held once: a retry doesn't credit either.
    assert.equal((await s.call("credits-fulfill", { session: session(sid) })).body.already, true);
  }
  assert.ok((await entries(s)).every((e) => e.type === "held"));
  // A held session's payment is still known, so a later refund or dispute finds it (and takes nothing).
  const refund = await s.call("credits-debit", { kind: "refund", payment_intent: "pi_held00000001", amount_refunded: 1000, ref: "ch_test_1" });
  assert.equal(refund.body.applied, true);
  assert.equal(refund.body.debit_micro, 0);
});

test("fulfil: a top-up credits the existing account; past the cap it still credits and alerts", async () => {
  const s = setup({ ...ENV, CREDITS_MAX_BALANCE_USD: "20" });
  const id = await newAccount(s);
  const up = await s.call("credits-fulfill", { session: session("cs_test_topup0000001", {}, { account_id: id, nonce_hash: undefined }) });
  assert.equal(up.body.fulfilled, true);
  assert.equal(up.body.created_account, false);
  assert.equal(up.body.balance_micro, 20 * MICRO_PER_USD);
  assert.equal(up.body.alert, undefined);
  const over = await s.call("credits-fulfill", { session: session("cs_test_topup0000002", {}, { account_id: id }) });
  assert.equal(over.body.balance_micro, 30 * MICRO_PER_USD, "the money was taken, so it's credited");
  assert.equal(over.body.alert, "over_cap");
  // A top-up never issues a key.
  const k = await s.call("credits-issue-key", { session_id: "cs_test_topup0000001", nonce_hash: NONCE, key_hash: KEY2 });
  assert.equal(k.status, 409);
  assert.equal(k.body.reason, "not_available");
});

// ---------- keys ----------

test("keys: revealed only with the nonce, only for a created account, once; a wrong nonce doesn't use it up", async () => {
  const s = setup();
  const sid = "cs_test_keys00000001";
  await s.call("credits-fulfill", { session: session(sid) });
  assert.equal((await s.call("credits-session", { session_id: sid })).body.key_available, true);
  const wrong = await s.call("credits-issue-key", { session_id: sid, nonce_hash: hex(64, "dd"), key_hash: KEY2 });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.reason, "wrong_browser");
  const right = await s.call("credits-issue-key", { session_id: sid, nonce_hash: NONCE, key_hash: KEY1 });
  assert.equal(right.status, 200);
  const twice = await s.call("credits-issue-key", { session_id: sid, nonce_hash: NONCE, key_hash: KEY2 });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.reason, "already_shown");
  assert.equal((await s.call("credits-auth", { key_hash: KEY1 })).status, 200);
  assert.equal((await s.call("credits-auth", { key_hash: KEY2 })).status, 401);
  assert.equal((await s.call("credits-session", { session_id: sid })).body.key_available, false);
  // No nonce stored (a session from elsewhere): no key can be revealed; the operator's rotate is the way.
  await s.call("credits-fulfill", { session: session("cs_test_keys00000002", {}, { nonce_hash: undefined }) });
  assert.equal((await s.call("credits-issue-key", { session_id: "cs_test_keys00000002", nonce_hash: NONCE, key_hash: KEY2 })).status, 403);
});

test("keys: two reveals at once give one key", async () => {
  const s = setup();
  const sid = "cs_test_keys00000003";
  await s.call("credits-fulfill", { session: session(sid) });
  const [a, b] = await Promise.all([
    s.call("credits-issue-key", { session_id: sid, nonce_hash: NONCE, key_hash: KEY1 }),
    s.call("credits-issue-key", { session_id: sid, nonce_hash: NONCE, key_hash: KEY2 }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const ok = [(await s.call("credits-auth", { key_hash: KEY1 })).status, (await s.call("credits-auth", { key_hash: KEY2 })).status];
  assert.deepEqual(ok.sort(), [200, 401]);
});

test("keys: after a rotate the old key fails; the claim code works once; the purchase page can't reveal any more", async () => {
  const s = setup();
  const sid = "cs_test_rotate000001";
  await s.call("credits-fulfill", { session: session(sid) });
  const id = (await s.call("credits-view", { session_id: sid })).body.account_id;
  // The buyer never reached the page: the operator rotates before any key was shown.
  const code1 = hex(64, "e5");
  const r = await s.call("credits-rotate", { account_id: id, code_hash: code1, reason: "never reached the page" });
  assert.equal(r.status, 200);
  assert.equal((await s.call("credits-issue-key", { session_id: sid, nonce_hash: NONCE, key_hash: KEY1 })).status, 409, "reveal closed by the rotate");
  const claim = await s.call("credits-claim", { code_hash: code1, key_hash: KEY1 });
  assert.equal(claim.status, 200);
  assert.equal((await s.call("credits-claim", { code_hash: code1, key_hash: KEY2 })).status, 404, "once");
  assert.equal((await s.call("credits-auth", { key_hash: KEY1 })).status, 200);
  // Lost key: rotate again; KEY1 stops working at once, and a second rotate replaces the first claim code.
  const code2 = hex(64, "f6");
  const code3 = hex(64, "a7");
  await s.call("credits-rotate", { account_id: id, code_hash: code2, reason: "lost key" });
  assert.equal((await s.call("credits-auth", { key_hash: KEY1 })).status, 401);
  await s.call("credits-rotate", { account_id: id, code_hash: code3, reason: "sent the wrong code" });
  assert.equal((await s.call("credits-claim", { code_hash: code2, key_hash: KEY2 })).status, 404);
  // An expired code fails.
  s.tick(CLAIM_TTL_MS + 1);
  assert.equal((await s.call("credits-claim", { code_hash: code3, key_hash: KEY2 })).status, 410);
  assert.equal((await s.call("credits-auth", { key_hash: KEY2 })).status, 401);
  const types = (await entries(s)).map((e) => e.type);
  assert.deepEqual(types, ["purchase", "rotate", "claim", "rotate", "rotate"]);
});

// ---------- reservations ----------

test("reservations: commit on success; release gives it back; tokens are used once", async () => {
  const s = setup();
  const id = await newAccount(s);
  const t1 = token();
  const r = await s.call("credits-reserve", { account_id: id, key_hash: KEY1, amount_micro: 200_000, token: t1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.balance_micro, 9_800_000);
  assert.equal(r.body.held_micro, 200_000);
  const c = await s.call("credits-commit", { token: t1, review_id: "abc123" });
  assert.equal(c.body.committed, true);
  assert.equal(c.body.held_micro, 0);
  assert.equal(c.body.balance_micro, 9_800_000);
  assert.equal((await s.call("credits-commit", { token: t1 })).body.already, true, "a retried commit is idempotent");
  assert.equal((await s.call("credits-release", { token: t1 })).body.reason, "committed", "a committed spend is never given back");
  assert.equal((await s.call("credits-reserve", { account_id: id, key_hash: KEY1, amount_micro: 1, token: t1 })).status, 409);
  const t2 = token();
  await s.call("credits-reserve", { account_id: id, key_hash: KEY1, amount_micro: 600_000, token: t2 });
  const rel = await s.call("credits-release", { token: t2, why: "failed" });
  assert.equal(rel.body.released, true);
  assert.equal(rel.body.balance_micro, 9_800_000);
  assert.equal((await s.call("credits-release", { token: t2 })).body.already, true);
  const v = await s.call("credits-view", { account_id: id });
  assert.equal(v.body.total_spent_micro, 200_000);
  assert.equal(v.body.held_micro, 0);
  const log = await entries(s);
  assert.deepEqual(log.map((e) => e.type), ["purchase", "key_issued", "reserve", "commit", "reserve", "release"]);
  assert.equal(log[3].review_id, "abc123");
});

test("reservations: not enough balance or a frozen account is refused with nothing used", async () => {
  const s = setup();
  const id = await newAccount(s);
  const r = await s.call("credits-reserve", { account_id: id, key_hash: KEY1, amount_micro: 10_000_001, token: token() });
  assert.equal(r.status, 429);
  assert.equal(r.body.reason, "balance");
  assert.equal(r.body.balance_micro, 10_000_000);
  await s.call("credits-adjust", { account_id: id, freeze: true, reason: "test freeze" });
  const f = await s.call("credits-reserve", { account_id: id, key_hash: KEY1, amount_micro: 1, token: token() });
  assert.equal(f.status, 403);
  assert.equal(f.body.reason, "frozen");
  assert.equal((await s.call("credits-reserve", { account_id: id, key_hash: KEY2, amount_micro: 1, token: token() })).status, 401, "the key must still match");
  assert.equal((await s.call("credits-view", { account_id: id })).body.balance_micro, 10_000_000);
});

test("reservations: a release that arrives before its reserve leaves a tombstone, and the late reserve is refused", async () => {
  const s = setup();
  const id = await newAccount(s);
  const t = token();
  const early = await s.call("credits-release", { token: t, why: "timeout" });
  assert.equal(early.body.tombstone, true);
  const late = await s.call("credits-reserve", { account_id: id, key_hash: KEY1, amount_micro: 50_000, token: t });
  assert.equal(late.status, 409);
  assert.equal(late.body.reason, "released");
  assert.equal((await s.call("credits-view", { account_id: id })).body.balance_micro, 10_000_000);
});

test("reservations: the alarm releases a 10-minute-old hold (and only that one); a late commit then costs nothing", async () => {
  const s = setup();
  const id = await newAccount(s);
  const old = token();
  await s.call("credits-reserve", { account_id: id, key_hash: KEY1, amount_micro: 700_000, token: old });
  assert.ok(s.m.alarms.some((t) => t === T0 + HOLD_MAX_MS), "an alarm by the hold's deadline");
  s.tick(5 * 60_000);
  const young = token();
  await s.call("credits-reserve", { account_id: id, key_hash: KEY1, amount_micro: 100_000, token: young });
  s.tick(5 * 60_000); // old is now exactly 10 minutes old, young 5
  await s.l.alarm();
  let v = await s.call("credits-view", { account_id: id });
  assert.equal(v.body.held_micro, 100_000);
  assert.equal(v.body.balance_micro, 10_000_000 - 100_000);
  const log = await entries(s);
  const rel = log.find((e) => e.type === "release");
  assert.equal(rel.why, "alarm");
  assert.equal(rel.token, old);
  assert.equal(s.m.alarms.at(-1), s.now() + 5 * 60_000, "next alarm: when the young hold turns 10 minutes");
  // The review behind the old hold finished after all: its commit finds the hold released, so it's free.
  const late = await s.call("credits-commit", { token: old });
  assert.equal(late.body.committed, false);
  assert.equal(late.body.reason, "released");
  v = await s.call("credits-view", { account_id: id });
  assert.equal(v.body.total_spent_micro, 0);
  assert.equal(v.body.balance_micro, 10_000_000 - 100_000);
});

test("reservations: a release on a frozen account doesn't unfreeze it, and pays the shortfall first", async () => {
  const s = setup();
  const id = await newAccount(s, "cs_test_frozen000001");
  const t = token();
  await s.call("credits-reserve", { account_id: id, key_hash: KEY1, amount_micro: 4_000_000, token: t });
  // A full refund arrives while the review runs: 6 left to debit, 4 short.
  const refund = await s.call("credits-debit", { kind: "refund", payment_intent: "pi_frozen000001", amount_refunded: 1000, ref: "ch_test_2" });
  assert.equal(refund.body.debit_micro, 6_000_000);
  assert.equal(refund.body.shortfall_micro, 4_000_000);
  assert.equal(refund.body.alert, "shortfall");
  await s.call("credits-adjust", { account_id: id, freeze: true, reason: "refunded in full" });
  const rel = await s.call("credits-release", { token: t });
  assert.equal(rel.body.shortfall_paid_micro, 4_000_000);
  const v = await s.call("credits-view", { account_id: id });
  assert.equal(v.body.frozen, true);
  assert.equal(v.body.shortfall_micro, 0);
  assert.equal(v.body.balance_micro, 0);
  assert.equal(v.body.held_micro, 0);
});

test("the alarm deletes markers after an hour and stops when nothing is left", async () => {
  const s = setup();
  const id = await newAccount(s);
  const t = token();
  await s.call("credits-reserve", { account_id: id, key_hash: KEY1, amount_micro: 1, token: t });
  await s.call("credits-commit", { token: t });
  await s.call("credits-release", { token: token() }); // a tombstone
  s.tick(MARKER_KEEP_MS);
  await s.l.alarm();
  assert.equal([...s.m.d.keys()].filter((k) => k.startsWith("cr:")).length, 0);
  assert.equal(s.m.d.has("c_alarm"), false, "nothing left to watch");
  // Log lines are never deleted.
  assert.equal((await entries(s)).length, 5);
});

// ---------- refunds and disputes ----------

test("refunds: a partial refund, then a second partial: correct deltas; a repeat changes nothing", async () => {
  const s = setup();
  const id = await newAccount(s, "cs_test_refund000001");
  const pi = "pi_refund000001";
  const r1 = await s.call("credits-debit", { kind: "refund", payment_intent: pi, amount_refunded: 300, ref: "ch_test_3" });
  assert.equal(r1.body.debit_micro, 3_000_000);
  const r2 = await s.call("credits-debit", { kind: "refund", payment_intent: pi, amount_refunded: 450, ref: "ch_test_3" });
  assert.equal(r2.body.debit_micro, 1_500_000, "only the new part (cumulative amount_refunded)");
  const r3 = await s.call("credits-debit", { kind: "refund", payment_intent: pi, amount_refunded: 450, ref: "ch_test_3" });
  assert.equal(r3.body.applied, false);
  const v = await s.call("credits-view", { account_id: id });
  assert.equal(v.body.balance_micro, 5_500_000);
  assert.equal(v.body.purchases[0].refunded_cents, 450);
  assert.equal(v.body.purchases[0].refundable_cents, 550, "min(paid - refunded, balance)");
});

test("refunds: after credits were spent, the rest is shortfall and the balance never goes below zero", async () => {
  const s = setup();
  const id = await newAccount(s, "cs_test_spent0000001");
  const t = token();
  await s.call("credits-reserve", { account_id: id, key_hash: KEY1, amount_micro: 7_000_000, token: t });
  await s.call("credits-commit", { token: t });
  const r = await s.call("credits-debit", { kind: "refund", payment_intent: "pi_spent0000001", amount_refunded: 1000 });
  assert.equal(r.body.debit_micro, 3_000_000);
  assert.equal(r.body.shortfall_micro, 7_000_000);
  const v = await s.call("credits-view", { account_id: id });
  assert.equal(v.body.balance_micro, 0);
  assert.equal(v.body.shortfall_micro, 7_000_000);
  assert.equal(v.body.purchases[0].refundable_cents, 0);
  // The operator can clear a shortfall he has accepted as a loss (logged).
  await s.call("credits-adjust", { account_id: id, clear_shortfall: true, reason: "accepted loss" });
  assert.equal((await s.call("credits-view", { account_id: id })).body.shortfall_micro, 0);
  assert.equal((await entries(s)).at(-1).shortfall_cleared_micro, 7_000_000);
});

test("disputes: freeze and debit the purchase's credits minus what was refunded; a later refund takes nothing more", async () => {
  const s = setup();
  const id = await newAccount(s, "cs_test_dispute00001");
  await s.call("credits-fulfill", { session: session("cs_test_dispute00002", { amount_subtotal: 2500 }, { pack: "medium", account_id: id }) });
  const pi = "pi_dispute00001";
  await s.call("credits-debit", { kind: "refund", payment_intent: pi, amount_refunded: 200 });
  const d = await s.call("credits-debit", { kind: "dispute", payment_intent: pi, ref: "dp_test_1" });
  assert.equal(d.body.frozen, true);
  assert.equal(d.body.debit_micro, 8_000_000, "10 credited - 2 refunded");
  assert.equal((await s.call("credits-debit", { kind: "dispute", payment_intent: pi })).body.applied, false);
  const later = await s.call("credits-debit", { kind: "refund", payment_intent: pi, amount_refunded: 1000 });
  assert.equal(later.body.debit_micro, 0);
  const v = await s.call("credits-view", { account_id: id });
  assert.equal(v.body.frozen, true);
  assert.match(v.body.frozen_reason, /dispute dp_test_1/);
  assert.equal(v.body.balance_micro, 25_000_000);
  // Unfreezing is by hand.
  await s.call("credits-adjust", { account_id: id, unfreeze: true, reason: "dispute won" });
  assert.equal((await s.call("credits-view", { account_id: id })).body.frozen, false);
});

test("refunds and disputes for a payment not seen yet: 404 (the Worker answers 5xx), then they apply on retry", async () => {
  const s = setup();
  const early = await s.call("credits-debit", { kind: "refund", payment_intent: "pi_outoforder01", amount_refunded: 500 });
  assert.equal(early.status, 404);
  assert.equal(early.body.reason, "unknown_payment");
  await s.call("credits-fulfill", { session: session("cs_test_outoforder01") });
  const retry = await s.call("credits-debit", { kind: "refund", payment_intent: "pi_outoforder01", amount_refunded: 500 });
  assert.equal(retry.body.debit_micro, 5_000_000);
});

test("an early fraud warning freezes the account, once", async () => {
  const s = setup();
  const id = await newAccount(s, "cs_test_fraud0000001");
  const w = await s.call("credits-debit", { kind: "fraud_warning", payment_intent: "pi_fraud0000001", ref: "issfr_test_1" });
  assert.equal(w.body.frozen, true);
  assert.equal((await s.call("credits-debit", { kind: "fraud_warning", payment_intent: "pi_fraud0000001" })).body.applied, false);
  const v = await s.call("credits-view", { account_id: id });
  assert.equal(v.body.frozen, true);
  assert.equal(v.body.balance_micro, 10_000_000, "no debit");
});

// ---------- caps ----------

test("caps: open checkouts count toward the max balance and the daily cap", async () => {
  const s = setup({ ...ENV, CREDITS_MAX_BALANCE_USD: "60", CREDITS_MAX_DAILY_USD: "45" });
  const id = await newAccount(s); // $10 bought today
  const exp = s.now() + 31 * 60_000;
  const p1 = pendingId();
  assert.equal((await s.call("credits-pending-add", { pending_id: p1, pack: "medium", expires_at: exp, account_id: id, key_hash: KEY1 })).status, 200);
  // bought 10 + pending 25 + 25 = 60 > 45 a day
  const p2 = await s.call("credits-pending-add", { pending_id: pendingId(), pack: "medium", expires_at: exp, account_id: id, key_hash: KEY1 });
  assert.equal(p2.status, 429);
  assert.equal(p2.body.reason, "max_daily");
  // Over the balance cap: 10 + 25 pending + 100 > 60
  const p3 = await s.call("credits-pending-add", { pending_id: pendingId(), pack: "large", expires_at: exp, account_id: id, key_hash: KEY1 });
  assert.equal(p3.body.reason, "max_balance");
  // The open checkout expires (Stripe's checkout.session.expired): room again.
  await s.call("credits-pending-clear", { pending_id: p1 });
  assert.equal((await s.call("credits-view", { account_id: id })).body.pending_micro, 0);
  assert.equal((await s.call("credits-pending-add", { pending_id: pendingId(), pack: "medium", expires_at: exp, account_id: id, key_hash: KEY1 })).status, 200);
  // A frozen account can't top up.
  await s.call("credits-adjust", { account_id: id, freeze: true, reason: "test" });
  assert.equal((await s.call("credits-pending-add", { pending_id: pendingId(), pack: "small", expires_at: exp, account_id: id, key_hash: KEY1 })).status, 403);
});

test("caps: at most 3 open checkouts per address; fulfilment and the alarm clear them", async () => {
  const s = setup();
  const exp = s.now() + 31 * 60_000;
  const ip = "0123456789abcdef0123";
  const ids = [pendingId(), pendingId(), pendingId()];
  for (const p of ids) assert.equal((await s.call("credits-pending-add", { pending_id: p, pack: "small", expires_at: exp, ip })).status, 200);
  const fourth = await s.call("credits-pending-add", { pending_id: pendingId(), pack: "small", expires_at: exp, ip });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.reason, "open_checkouts");
  assert.equal((await s.call("credits-pending-add", { pending_id: pendingId(), pack: "small", expires_at: exp, ip: "fedcba98765432100000" })).status, 200, "another address");
  // One completes: its pending is cleared through the session's metadata.
  await s.call("credits-fulfill", { session: session("cs_test_pending00001", {}, { pending_id: ids[0] }) });
  assert.equal((await s.call("credits-pending-add", { pending_id: pendingId(), pack: "small", expires_at: exp, ip })).status, 200);
  // The rest expire: the alarm clears them a minute after Stripe's expiry.
  s.tick(32 * 60_000 + 1);
  await s.l.alarm();
  assert.equal([...s.m.d.keys()].filter((k) => k.startsWith("cp:") || k.startsWith("cq:")).length, 0);
  // A new account's checkout can't be over the caps on its own.
  const small = setup({ ...ENV, CREDITS_MAX_BALANCE_USD: "20" });
  assert.equal((await small.call("credits-pending-add", { pending_id: pendingId(), pack: "medium", expires_at: exp })).body.reason, "max_balance");
});

// ---------- the operator ----------

test("admin: adjust (credit, debit, create, a reason required) and lookups by session and payment intent", async () => {
  const s = setup();
  const id = await newAccount(s, "cs_test_admin0000001");
  assert.equal((await s.call("credits-adjust", { account_id: id, amount_micro: 1, reason: "" })).status, 400);
  assert.equal((await s.call("credits-adjust", { account_id: id, amount_micro: -20_000_000, reason: "too much" })).status, 409);
  assert.equal((await s.call("credits-adjust", { account_id: id, amount_micro: -1_000_000, reason: "correction" })).body.balance_micro, 9_000_000);
  const made = await s.call("credits-adjust", { create: true, amount_micro: 5_000_000, reason: "held session cs_test_x fixed by hand" });
  assert.match(made.body.account_id, /^arca_/);
  assert.equal(made.body.balance_micro, 5_000_000);
  assert.equal((await s.call("credits-view", { payment_intent: "pi_admin0000001" })).body.account_id, id);
  assert.equal((await s.call("credits-view", { session_id: "cs_test_admin0000001" })).body.account_id, id);
  assert.equal((await s.call("credits-view", { account_id: "arca_ffffffffffffffffffffffff" })).status, 404);
});

test("export: every line in order, in pages, never deleted", async () => {
  const s = setup();
  const id = await newAccount(s);
  for (let i = 0; i < 4; i++) {
    const t = token();
    await s.call("credits-reserve", { account_id: id, key_hash: KEY1, amount_micro: 1_000, token: t });
    await s.call("credits-commit", { token: t });
  }
  const page1 = await s.call("credits-export", { limit: 4 });
  assert.deepEqual(page1.body.entries.map((e: any) => e.seq), [1, 2, 3, 4]);
  assert.equal(page1.body.next, 4);
  const page2 = await s.call("credits-export", { after: 4, limit: 100 });
  assert.deepEqual(page2.body.entries.map((e: any) => e.seq), [5, 6, 7, 8, 9, 10]);
  assert.equal(page2.body.next, null);
  assert.ok(page2.body.entries.every((e: any) => typeof e.at === "string"));
});

test("bad input is refused before anything is read or written", async () => {
  const s = setup();
  for (const [action, body] of [
    ["credits-reserve", { account_id: "x", key_hash: KEY1, amount_micro: 1, token: token() }],
    ["credits-reserve", { account_id: "arca_000000000000000000000000", key_hash: KEY1, amount_micro: 0, token: token() }],
    ["credits-reserve", { account_id: "arca_000000000000000000000000", key_hash: KEY1, amount_micro: 1.5, token: token() }],
    ["credits-commit", { token: "short" }],
    ["credits-fulfill", { session: { id: "cs_live" } }],
    ["credits-debit", { kind: "chargeback", payment_intent: "pi_123456789" }],
    ["credits-pending-add", { pending_id: pendingId(), pack: "small", expires_at: T0 - 1 }],
  ] as const) {
    const r = await s.call(action, body);
    assert.equal(r.status, 400, `${action} ${JSON.stringify(body)}`);
  }
  assert.equal((await s.call("credits-nope", {})).status, 404);
});

// ---------- deploy safety ----------

/** wrangler.jsonc without its comments (strings, like the URLs in it, are left alone). */
function jsonc(text: string): any {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") while (i < text.length && text[i] !== "\n") i++;
    else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

test("deploy safety: wrangler.jsonc's top-level vars hold no CREDITS_* setting and no Stripe secret", () => {
  const cfg = jsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.ok(cfg.vars && typeof cfg.vars === "object", "the top-level vars were found");
  assert.ok("PAY_TO" in cfg.vars, "the real vars, not an empty object");
  const bad = Object.keys(cfg.vars).filter((k) => k.startsWith("CREDITS_") || k.startsWith("STRIPE_"));
  assert.deepEqual(bad, [], "a production deploy must not be able to switch credits on");
});
