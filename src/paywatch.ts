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
