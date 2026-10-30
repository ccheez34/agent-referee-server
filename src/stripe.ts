// Stripe without its SDK (change request CR1, accepted by 4.0 at 15:51 and by 2.0 at 15:50, Oct 30, 2026): a payment
// path gains no dependency, and the code can be tested without npm. The webhook signature is checked with WebCrypto and
// the few REST calls go through fetch.
//
// The signature scheme, as in Stripe's docs (docs.stripe.com/webhooks/signature) and stripe-node's src/Webhooks.ts:
// - The Stripe-Signature header is "t=<unix seconds>,v1=<hex>[,v1=<hex>...][,v0=<hex>]".
// - Each v1 is HMAC-SHA256, keyed with the WHOLE signing secret as UTF-8 bytes ("whsec_" prefix included; it is not
//   base64-decoded), over "<t>.<raw request body>". The body is the exact bytes received, never re-serialized JSON.
// - Any v1 may match (Stripe sends two while a secret is being rolled). v0 is ignored.
// - Events older than the tolerance (300 s, stripe-node's default) are refused.
// test/stripe.test.ts checks this against a vector made by stripe-node's own generateTestHeaderStringAsync.

/** The Stripe API version every REST call pins (Stripe-Version header). Create the test-mode webhook endpoint with the
 * same version and the "snapshot" payload. */
export const STRIPE_API_VERSION = "2026-09-30.endive";
/** Maximum age of a signed webhook event, in seconds (stripe-node's DEFAULT_TOLERANCE). */
export const STRIPE_TOLERANCE_S = 300;

const enc = new TextEncoder();

export type SignatureCheck =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "no_secret" | "no_header" | "bad_header" | "no_v1" | "mismatch" | "too_old" | "too_new" };

/** Hex HMAC-SHA256 of `${t}.` followed by the raw body bytes, keyed with the secret's UTF-8 bytes. */
async function stripeHmacHex(secret: string, t: number, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = enc.encode(`${t}.`);
  const msg = new Uint8Array(prefix.length + body.length);
  msg.set(prefix, 0);
  msg.set(body, prefix.length);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings of the same length (every v1 is checked to be 64 hex characters first). */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Checks a Stripe-Signature header against the raw body. `body` should be the exact bytes received (a string is
 * encoded as UTF-8). Refuses: no secret, an empty header, a header without one "t" or without any well-formed v1, no
 * v1 that matches, or a timestamp more than `toleranceS` seconds old (or more than that in the future).
 */
export async function verifyStripeSignature(
  body: string | Uint8Array,
  header: string | null | undefined,
  secret: string | null | undefined,
  nowS: number,
  toleranceS = STRIPE_TOLERANCE_S,
): Promise<SignatureCheck> {
  if (!secret || !secret.trim()) return { ok: false, reason: "no_secret" };
  if (!header || !header.trim()) return { ok: false, reason: "no_header" };
  let t: number | undefined;
  let tCount = 0;
  const v1: string[] = [];
  for (const item of header.split(",")) {
    const i = item.indexOf("=");
    if (i < 0) continue;
    const k = item.slice(0, i).trim();
    const v = item.slice(i + 1).trim();
    if (k === "t") {
      tCount++;
      if (/^\d{1,12}$/.test(v)) t = Number(v);
    } else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  if (t === undefined || tCount !== 1) return { ok: false, reason: "bad_header" };
  if (!v1.length) return { ok: false, reason: "no_v1" };
  const expected = await stripeHmacHex(secret, t, typeof body === "string" ? enc.encode(body) : body);
  let match = false;
  for (const s of v1) if (sameHex(expected, s)) match = true; // every one checked; any may match
  if (!match) return { ok: false, reason: "mismatch" };
  if (nowS - t > toleranceS) return { ok: false, reason: "too_old" };
  if (t - nowS > toleranceS) return { ok: false, reason: "too_new" };
  return { ok: true, timestamp: t };
}

/** "test" for sk_test_/rk_test_ keys, "live" for sk_live_/rk_live_, otherwise "unknown". */
export function stripeKeyKind(key: string | undefined): "test" | "live" | "unknown" | "none" {
  const k = String(key ?? "").trim();
  if (!k) return "none";
  if (/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(k)) return "test";
  if (/^(sk|rk)_live_[A-Za-z0-9]{8,}$/.test(k)) return "live";
  return "unknown";
}

/** A Checkout Session id of the configured mode (cs_test_… or, only when live, cs_live_…). Anything else is never sent
 * to Stripe. */
export function checkoutSessionIdOk(id: unknown, live: boolean): id is string {
  return typeof id === "string" && (live ? /^cs_live_[A-Za-z0-9]{8,200}$/ : /^cs_test_[A-Za-z0-9]{8,200}$/).test(id);
}

/** Stripe's form encoding: nested objects and arrays in bracket notation (line_items[0][price_data][currency]=usd). */
export function formEncode(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (v: unknown, name: string) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${name}[${i}]`));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${name}[${k}]`);
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(v, k);
  return out.join("&");
}

/** A failed Stripe call. The message names the call and Stripe's error type and code, never a key or secret. */
export class StripeCallError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type StripeFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * One Stripe REST call: form-encoded, the pinned Stripe-Version, an Idempotency-Key when given (every create sends one),
 * and a timeout. Returns the parsed JSON body; throws StripeCallError on any non-2xx answer, a timeout or an unreadable
 * answer. `fetchFn` is for tests.
 */
export async function stripeCall(
  key: string,
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  opts: { idempotencyKey?: string; timeoutMs?: number; fetchFn?: StripeFetch } = {},
): Promise<any> {
  const form = formEncode(params);
  const url = `https://api.stripe.com/v1${path}${method === "GET" && form ? `?${form}` : ""}`;
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, "stripe-version": STRIPE_API_VERSION };
  if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await (opts.fetchFn ?? fetch)(url, { method, headers, body: method === "POST" ? form : undefined, signal: ctl.signal });
  } catch (e: any) {
    throw new StripeCallError(`stripe ${method} ${path}: ${ctl.signal.aborted ? "timed out" : "unreachable"}`, 0);
  } finally {
    clearTimeout(timer);
  }
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data || typeof data !== "object") {
    const e = data?.error;
    const what = e ? [e.type, e.code].filter((x) => typeof x === "string").join("/") : "unreadable answer";
    throw new StripeCallError(`stripe ${method} ${path} answered ${res.status}: ${what || "error"}`, res.status);
  }
  return data;
}
