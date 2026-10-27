// What happened to a paid request at the payment facilitator, read from the final response (x402-hono 1.x: it verifies,
// runs the handler, and settles only if the handler answered < 400; a verify or settle failure comes back as 402 with
// the facilitator's error text). Our own wrapper marks whether the handler ran, so no library internals are needed.

export type PayOutcome =
  | { kind: "challenge" } // no payment yet: the normal first 402
  | { kind: "settled" }
  | { kind: "not_charged" } // the handler refused (status >= 400): nothing settles, by design
  | { kind: "payer_problem"; stage: "verify" | "settle"; detail: string } // bad signature, no funds, expired: the payer's side
  | { kind: "facilitator_problem"; stage: "verify" | "settle"; detail: string; credit: boolean }; // the facilitator failed us

/** Error texts that mean the payment itself was bad (x402 invalidReason values and similar). */
const PAYER_RE = /^invalid_|insufficient_funds|invalid signature|signature|expired|nonce|not yet valid|payment.*(too low|amount)|wrong network|unsupported scheme/i;
const CREDIT_RE = /credit|free[ _-]?tier|quota|insufficient[ _]credits|top[ -]?up|billing/i;

export function classifyPaidResponse(opts: { hadPayment: boolean; handlerRan: boolean; handlerStatus?: number; status: number; errorText?: string }): PayOutcome {
  if (!opts.hadPayment) return { kind: "challenge" };
  if (opts.handlerRan && opts.handlerStatus !== undefined && opts.handlerStatus >= 400) return { kind: "not_charged" };
  if (opts.status !== 402) return opts.handlerRan ? { kind: "settled" } : { kind: "not_charged" };
  const stage = opts.handlerRan ? "settle" : "verify";
  const detail = String(opts.errorText ?? "").slice(0, 300);
  const credit = CREDIT_RE.test(detail);
  if (!credit && PAYER_RE.test(detail)) return { kind: "payer_problem", stage, detail };
  return { kind: "facilitator_problem", stage, detail, credit };
}

/**
 * A cheap local look at an X-PAYMENT header, before any slot is taken or the facilitator is asked: does it at least
 * claim to pay us the right amount on the right network, and is it still valid? Garbage or mismatched headers skip
 * the admission gates entirely (the paywall then refuses them with its normal 402), so a flood of fake payment
 * headers can't fill the gates. Only the facilitator can confirm the signature and the funds.
 */
export function plausiblePayment(header: string | undefined, opts: { payTo: string; network: string; minMicro: number; nowS?: number }): boolean {
  if (!header || header.length > 20_000) return false;
  try {
    const p: any = JSON.parse(atob(header));
    const a = p?.payload?.authorization;
    const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
    return (
      p?.x402Version === 1 &&
      p?.scheme === "exact" &&
      p?.network === opts.network &&
      typeof p?.payload?.signature === "string" &&
      /^0x[0-9a-fA-F]{130,}$/.test(p.payload.signature) &&
      /^0x[0-9a-fA-F]{40}$/.test(String(a?.from)) &&
      String(a?.to).toLowerCase() === opts.payTo.toLowerCase() &&
      /^\d+$/.test(String(a?.value)) &&
      BigInt(a.value) >= BigInt(opts.minMicro) &&
      Number(a?.validBefore) > nowS
    );
  } catch {
    return false;
  }
}

/** "$0.05" -> 50000 (USDC has 6 decimals). */
export function priceMicro(price: string): number {
  const n = Number(String(price).replace(/^\$/, ""));
  return Number.isFinite(n) ? Math.round(n * 1_000_000) : Number.MAX_SAFE_INTEGER;
}
