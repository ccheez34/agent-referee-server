// Stripe without its SDK (stripe.ts, change request CR1). The signature check is tested against vectors made by
// Stripe's own code, so a scheme mistake shared by our signer and our checker can't hide (2.0's review point, 15:50):
// stripe-node 23.1.0 (github.com/stripe/stripe-node, commit 6d5ed967d602224ac3056dc3f0befbb55487ee50), compiled from
// source in Claude 5.0's workspace on Oct 30, 2026, and run with Stripe.webhooks.generateTestHeaderStringAsync (its
// SubtleCrypto provider; the Node provider gave the same header). Stripe's own verifyHeaderAsync accepted HEADER and
// ROTATION_HEADER and refused the wrong secret and a tampered body. The secrets are fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutSessionIdOk, formEncode, readRawCapped, secretHasWhitespace, stripeCall, stripeKeyKind, verifyStripeSignature, STRIPE_API_VERSION, STRIPE_TOLERANCE_S } from "../src/stripe.ts";

const SECRET = "whsec_agentreferee_fake_test_secret_not_real_0001";
const OTHER_SECRET = "whsec_agentreferee_fake_rotated_secret_not_real_0002";
const T = 1793404800; // 2026-10-30T22:40:00Z
const PAYLOAD =
  '{\n  "id": "evt_test_agentreferee_0001",\n  "object": "event",\n  "type": "checkout.session.completed",\n  "livemode": false,\n  "data": { "object": { "id": "cs_test_a1AgentRefereeVector0001", "object": "checkout.session", "mode": "payment", "payment_status": "paid", "currency": "usd", "amount_subtotal": 1000, "amount_total": 1000, "livemode": false, "payment_intent": "pi_test_AgentRefereeVector0001", "metadata": { "pack": "small", "pending_id": "0123456789abcdef0123456789abcdef", "nonce_hash": "ab" } } }\n}';
const HEADER = "t=1793404800,v1=22b48ef23cb6ce9abf5ddf594ee7396ef00a42960631796ce55971d9e5c99b98";
const ROTATION_HEADER =
  "t=1793404800,v1=77b874b8fc75d0ec424e7918f86f02c6db08fbce249da26b5879276bf38428b8,v1=22b48ef23cb6ce9abf5ddf594ee7396ef00a42960631796ce55971d9e5c99b98,v0=0000000000000000000000000000000000000000000000000000000000000000";

test("signature: Stripe's own vector passes, as a string and as the raw bytes", async () => {
  assert.deepEqual(await verifyStripeSignature(PAYLOAD, HEADER, SECRET, T), { ok: true, timestamp: T });
  assert.deepEqual(await verifyStripeSignature(new TextEncoder().encode(PAYLOAD), HEADER, SECRET, T + STRIPE_TOLERANCE_S), { ok: true, timestamp: T });
});

test("signature: while a secret is rolled, any v1 may match (v0 is ignored)", async () => {
  assert.equal((await verifyStripeSignature(PAYLOAD, ROTATION_HEADER, SECRET, T)).ok, true);
  assert.equal((await verifyStripeSignature(PAYLOAD, ROTATION_HEADER, OTHER_SECRET, T)).ok, true);
  const v0only = `t=${T},v0=${"0".repeat(64)}`;
  assert.deepEqual(await verifyStripeSignature(PAYLOAD, v0only, SECRET, T), { ok: false, reason: "no_v1" });
});

test("signature: the key is the whole whsec_ secret as UTF-8, not the part after the prefix, and not base64-decoded", async () => {
  assert.deepEqual(await verifyStripeSignature(PAYLOAD, HEADER, SECRET.slice("whsec_".length), T), { ok: false, reason: "mismatch" });
  const b64 = Buffer.from(SECRET.slice(6), "base64").toString("latin1");
  assert.equal((await verifyStripeSignature(PAYLOAD, HEADER, b64, T)).ok, false);
  assert.deepEqual(await verifyStripeSignature(PAYLOAD, HEADER, OTHER_SECRET, T), { ok: false, reason: "mismatch" });
});

test("signature: a tampered or re-serialized body fails (the raw bytes are signed)", async () => {
  assert.equal((await verifyStripeSignature(PAYLOAD.replace('"amount_subtotal": 1000', '"amount_subtotal": 100'), HEADER, SECRET, T)).ok, false);
  assert.equal((await verifyStripeSignature(JSON.stringify(JSON.parse(PAYLOAD)), HEADER, SECRET, T)).ok, false);
  assert.equal((await verifyStripeSignature(`${PAYLOAD}\n`, HEADER, SECRET, T)).ok, false);
});

test("signature: an old timestamp (over 300 s) or a far-future one is refused, even with a good signature", async () => {
  assert.deepEqual(await verifyStripeSignature(PAYLOAD, HEADER, SECRET, T + STRIPE_TOLERANCE_S + 1), { ok: false, reason: "too_old" });
  assert.deepEqual(await verifyStripeSignature(PAYLOAD, HEADER, SECRET, T - STRIPE_TOLERANCE_S - 1), { ok: false, reason: "too_new" });
  // A replayed header with the timestamp changed: the signature covers t, so it fails.
  assert.deepEqual(await verifyStripeSignature(PAYLOAD, HEADER.replace(`t=${T}`, `t=${T + 600}`), SECRET, T + 600), { ok: false, reason: "mismatch" });
});

test("signature: an empty or malformed header, or no secret, is refused", async () => {
  const sig = HEADER.split("v1=")[1];
  const cases: [string | undefined, string | undefined, string][] = [
    [HEADER, undefined, "no_secret"],
    [HEADER, "   ", "no_secret"],
    [undefined, SECRET, "no_header"],
    ["", SECRET, "no_header"],
    [`v1=${sig}`, SECRET, "bad_header"],
    [`t=abc,v1=${sig}`, SECRET, "bad_header"],
    [`t=${T},t=${T},v1=${sig}`, SECRET, "bad_header"],
    [`t=${T}`, SECRET, "no_v1"],
    [`t=${T},v1=${sig.slice(1)}`, SECRET, "no_v1"],
    [`t=${T},v1=${sig.toUpperCase()}`, SECRET, "no_v1"],
    [`t=${T},v1=${"0".repeat(64)}`, SECRET, "mismatch"],
  ];
  for (const [h, s, why] of cases) assert.deepEqual(await verifyStripeSignature(PAYLOAD, h, s, T), { ok: false, reason: why }, `${h} / ${s}`);
  // Spaces around items are tolerated (Stripe sends none).
  assert.equal((await verifyStripeSignature(PAYLOAD, `t=${T}, v1=${sig}`, SECRET, T)).ok, true);
});

test("key kinds and session ids", () => {
  assert.equal(stripeKeyKind(undefined), "none");
  assert.equal(stripeKeyKind("rk_test_51Abcdefgh"), "test");
  assert.equal(stripeKeyKind("sk_test_51Abcdefgh"), "test");
  assert.equal(stripeKeyKind("sk_live_51Abcdefgh"), "live");
  assert.equal(stripeKeyKind("rk_live_51Abcdefgh"), "live");
  assert.equal(stripeKeyKind("pk_test_51Abcdefgh"), "unknown");
  assert.equal(stripeKeyKind("whsec_51Abcdefgh"), "unknown");
  assert.equal(checkoutSessionIdOk("cs_test_a1B2c3D4e5", false), true);
  assert.equal(checkoutSessionIdOk("cs_live_a1B2c3D4e5", false), false);
  assert.equal(checkoutSessionIdOk("cs_live_a1B2c3D4e5", true), true);
  assert.equal(checkoutSessionIdOk("cs_test_a1B2c3D4e5", true), false);
  assert.equal(checkoutSessionIdOk("cs_test_../../v1/charges", false), false);
  assert.equal(checkoutSessionIdOk({}, false), false);
});

test("form encoding: Stripe's bracket notation", () => {
  const body = formEncode({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 1000, product_data: { name: "Agent Referee credits – small" } } }],
    metadata: { pack: "small", account_id: undefined },
    expires_at: 1793406600,
  });
  const pairs = body.split("&").map((p) => p.split("=").map(decodeURIComponent));
  assert.deepEqual(pairs, [
    ["mode", "payment"],
    ["payment_method_types[0]", "card"],
    ["line_items[0][quantity]", "1"],
    ["line_items[0][price_data][currency]", "usd"],
    ["line_items[0][price_data][unit_amount]", "1000"],
    ["line_items[0][price_data][product_data][name]", "Agent Referee credits – small"],
    ["metadata[pack]", "small"],
    ["expires_at", "1793406600"],
  ]);
});

test("REST calls: pinned version, idempotency key, form body; errors name the call and Stripe's code, never the key", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const ok = async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ id: "cs_test_made00001", url: "https://checkout.stripe.com/c/pay/cs_test_made00001" }), { status: 200 });
  };
  const made = await stripeCall("rk_test_SECRETVALUE123", "POST", "/checkout/sessions", { mode: "payment" }, { idempotencyKey: "abc", fetchFn: ok });
  assert.equal(made.id, "cs_test_made00001");
  const h = seen[0].init.headers as Record<string, string>;
  assert.equal(seen[0].url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(h["stripe-version"], STRIPE_API_VERSION);
  assert.equal(h["idempotency-key"], "abc");
  assert.equal(h["content-type"], "application/x-www-form-urlencoded");
  assert.equal(h.authorization, "Bearer rk_test_SECRETVALUE123");
  assert.equal(seen[0].init.body, "mode=payment");
  await stripeCall("rk_test_SECRETVALUE123", "GET", "/checkout/sessions/cs_test_made00001", {}, { fetchFn: ok });
  assert.equal(seen[1].url, "https://api.stripe.com/v1/checkout/sessions/cs_test_made00001");
  assert.equal(seen[1].init.body, undefined);
  const bad = async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such checkout.session" } }), { status: 404 });
  await assert.rejects(stripeCall("rk_test_SECRETVALUE123", "GET", "/checkout/sessions/cs_test_x0000001", {}, { fetchFn: bad }), (e: any) => {
    assert.equal(e.status, 404);
    assert.match(e.message, /answered 404: invalid_request_error\/resource_missing/);
    assert.ok(!e.message.includes("SECRETVALUE"));
    return true;
  });
  const down = async () => {
    throw new Error("connect ECONNREFUSED rk_test_SECRETVALUE123");
  };
  await assert.rejects(stripeCall("rk_test_SECRETVALUE123", "GET", "/x", {}, { fetchFn: down }), (e: any) => !e.message.includes("SECRETVALUE") && e.status === 0);
  const hang = (_u: string, init: RequestInit) =>
    new Promise<Response>((_, rej) => (init.signal as AbortSignal).addEventListener("abort", () => rej(new Error("aborted"))));
  await assert.rejects(stripeCall("rk_test_SECRETVALUE123", "GET", "/x", {}, { fetchFn: hang, timeoutMs: 20 }), /timed out/);
});

test("signature: a NaN clock or tolerance refuses instead of passing (fresh-agent check, Oct 30)", async () => {
  assert.equal((await verifyStripeSignature(PAYLOAD, HEADER, SECRET, NaN)).ok, false);
  assert.equal((await verifyStripeSignature(PAYLOAD, HEADER, SECRET, T, NaN)).ok, false);
  assert.equal((await verifyStripeSignature(PAYLOAD, HEADER, SECRET, T + 25 * 365 * 86_400)).ok, false);
  assert.equal(secretHasWhitespace(`${SECRET}\n`), true);
  assert.equal(secretHasWhitespace(SECRET), false);
  assert.equal(secretHasWhitespace(undefined), false);
});

test("the raw body is capped while it's read: a chunked body with no length stops at the cap", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024);
  const endless = new ReadableStream<Uint8Array>({
    pull(ctl) {
      pulled++;
      if (pulled > 1_000) ctl.close(); // a safety stop for the test itself (64 MB)
      else ctl.enqueue(chunk);
    },
  });
  const big = new Request("https://x/credits/stripe-webhook", { method: "POST", body: endless, duplex: "half" } as any);
  assert.equal(big.headers.get("content-length"), null);
  assert.deepEqual(await readRawCapped(big, 1_000_000), { ok: false, reason: "too_big" });
  assert.ok(pulled <= 20, `stopped after about 1 MB, not after ${pulled} chunks`);
  const declared = new Request("https://x", { method: "POST", body: "x", headers: { "content-length": "2000000" } });
  assert.deepEqual(await readRawCapped(declared, 1_000_000), { ok: false, reason: "too_big" });
  const ok = await readRawCapped(new Request("https://x", { method: "POST", body: PAYLOAD }), 1_000_000);
  assert.equal(ok.ok, true);
  assert.equal(new TextDecoder().decode((ok as any).bytes), PAYLOAD, "the exact bytes, unchanged");
});
