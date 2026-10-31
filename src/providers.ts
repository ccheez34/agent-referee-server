// What a provider's answer means for capacity: rate limits, spend caps, and how busy the account is.
// Shared by reviewers, judges and the admission gates. Pure functions, so they're easy to test.

/** Model ids with a "/" go through OpenRouter; plain ids are Claude models called directly. */
export const isOpenRouterModel = (model: string) => model.includes("/");

/** The gate pool a model's calls count against: one per Claude model (Anthropic limits are per model), one for OpenRouter. */
export function poolOf(model: string): string {
  return isOpenRouterModel(model) ? "openrouter" : `anthropic:${model}`;
}

export type Provider = "anthropic" | "openrouter";
export const providerOfPool = (pool: string): Provider => (pool === "openrouter" ? "openrouter" : "anthropic");

/** How a single provider HTTP call turned out. */
export type CallKind = "ok" | "rate" | "server" | "timeout" | "network" | "client" | "cap" | "unused";

/**
 * A spend cap or a prepaid-credit problem. These are account-wide and don't fix themselves on a retry, so the call stops
 * at once and every pool of that provider closes. Matched broadly because the exact wording comes from provider docs and
 * third-party write-ups (Anthropic: 429 enforced_spend_limit_reached, no retry-after, until the month resets; 400
 * "credit balance is too low" / "insufficient credits" / usage limits; OpenRouter: 402 for missing credit).
 */
export function isSpendCap(model: string, status: number, bodyText: string): boolean {
  const t = bodyText.toLowerCase();
  if (isOpenRouterModel(model)) return status === 402;
  if (status === 429) return t.includes("enforced_spend_limit_reached") || t.includes("spend limit");
  if (status === 400 || status === 402 || status === 403)
    return /credit balance|insufficient credit|purchase credits|plans (&|and) billing|billing|usage limit|spend limit/.test(t);
  return false;
}

/**
 * PLAN 0.4, alert A8, and two neighbours (fresh read of Oct 31, F1 and F7). What a 400, 401 or 403 says about the
 * provider account, if anything:
 * - "account": the account or organization itself is disabled, suspended, deactivated, banned, terminated or revoked
 *   (Anthropic is reported to answer a disabled organization with a 400). A legal alert.
 * - "auth": any other 401, so the service's own key was refused. Nobody outside can cause one. An operational alert.
 * - "region": the provider won't serve the place the call left from. A Worker calls from the data centre that took
 *   the request, so an outsider can cause one: a warning only.
 * Never for a moderation refusal (OpenRouter answers 403 when a request's text is flagged): that's about the text,
 * and anyone can cause one.
 */
export type AccountProblem = "account" | "auth" | "region";
export function accountProblem(status: number, bodyText: string): AccountProblem | null {
  if (status !== 400 && status !== 401 && status !== 403) return null;
  if (/flagged|moderation/i.test(bodyText)) return null;
  if (
    /\b(organi[sz]ation|account|api[ _-]?key|workspace)\b[^.]{0,80}?\b(disabled|suspended|deactivated|banned|terminated|revoked)\b/i.test(bodyText) ||
    /\b(disabled|suspended|deactivated|banned|terminated|revoked)\b[^.]{0,40}?\b(organi[sz]ation|account)\b/i.test(bodyText)
  )
    return "account";
  if (status === 401) return "auth";
  if (/not (available|supported) in your (country|region|territory)|unsupported_country|region_not_supported/i.test(bodyText)) return "region";
  return null;
}

/** Whose account an alert is about: Claude models are called on Anthropic's account; every other model through OpenRouter. */
export const accountOf = (model: string) => (model.startsWith("claude") ? "anthropic" : "openrouter");

export function classifyStatus(model: string, status: number, bodyText = ""): CallKind {
  if (status >= 200 && status < 300) return "ok";
  if (isSpendCap(model, status, bodyText)) return "cap";
  if (status === 429) return "rate";
  if (status >= 500) return "server";
  return "client";
}

export class ProviderCapError extends Error {
  readonly cap = true;
  constructor(model: string, status: number, detail: string) {
    super(`${model}: API returned ${status}: ${detail.slice(0, 160)} (the AI provider's spend or credit limit; not retried)`);
  }
}

/** How much of the account's rate limit is left, from the response headers (null when the provider didn't say). */
export type RateInfo = { remaining_frac: number; reset_at: number } | null;

export function rateInfo(headers: Headers, now = Date.now()): RateInfo {
  const pairs: [string, string, string][] = [
    ["anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-reset"],
    ["anthropic-ratelimit-output-tokens-remaining", "anthropic-ratelimit-output-tokens-limit", "anthropic-ratelimit-output-tokens-reset"],
    ["anthropic-ratelimit-input-tokens-remaining", "anthropic-ratelimit-input-tokens-limit", "anthropic-ratelimit-input-tokens-reset"],
    ["x-ratelimit-remaining", "x-ratelimit-limit", "x-ratelimit-reset"],
  ];
  let best: RateInfo = null;
  for (const [r, l, z] of pairs) {
    const rem = Number(headers.get(r));
    const lim = Number(headers.get(l));
    if (!headers.has(r) || !Number.isFinite(rem) || !Number.isFinite(lim) || lim <= 0) continue;
    const frac = Math.max(0, Math.min(1, rem / lim));
    const reset = parseReset(headers.get(z), now);
    if (!best || frac < best.remaining_frac) best = { remaining_frac: frac, reset_at: reset };
  }
  return best;
}

/** Anthropic sends an RFC 3339 time; OpenRouter sends epoch milliseconds. Unknown → one minute from now. */
function parseReset(v: string | null, now: number): number {
  if (!v) return now + 60_000;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? n : n > 1e9 ? n * 1000 : now + n * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : now + 60_000;
}

/** One observed call, reported back to the gate when the slot is released. */
export type CallObservation = { kind: CallKind; status?: number; rate?: RateInfo };

/** The overall outcome of a slot's work: the worst thing that happened, plus the latest rate-limit reading. */
export function summarize(obs: CallObservation[]): { outcome: CallKind; rate: RateInfo } {
  const order: CallKind[] = ["cap", "rate", "server", "timeout", "network", "client", "ok", "unused"];
  let outcome: CallKind = obs.length ? "ok" : "unused";
  for (const o of obs) if (order.indexOf(o.kind) < order.indexOf(outcome)) outcome = o.kind;
  // A call that eventually succeeded after a busy try still counts as "rate" so the gate sees the pressure.
  let rate: RateInfo = null;
  for (const o of obs) if (o.rate) rate = o.rate;
  return { outcome, rate };
}
