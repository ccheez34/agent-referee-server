// The consent step (4.0's 1250, 5.0's 1557; ccheez34's go-ahead, Nov 26): before any text goes to an AI model,
// the caller agrees to a notice naming who reads it. The service can't recognize a caller across days (callerHash
// is salted with the date, on purpose), and an x402 caller's wallet isn't known before the paywall, so consent
// travels with the request: a "consent" tag naming the notice version, in the JSON body or the X-Consent header.
// A model-bound call without the current version is answered 428 with the notice, before the paywall: nothing
// is charged and nothing reaches a model. A changed notice gets a new version, so everyone is asked again.
// The signed receipt records the version agreed to (consent_version). Switched on by CONSENT_REQUIRED = "true".
import { companyOf } from "./judge.ts";

/** Bump this whenever the companies, the keeping or the terms' wording change. */
export const NOTICE_VERSION = "2026-11-30.1";

/** Each company the service can send text to, with where it's based (for the region-aware reader). */
const COMPANIES: Record<string, { name: string; based: string }> = {
  anthropic: { name: "Anthropic", based: "United States" },
  openai: { name: "OpenAI", based: "United States" },
  google: { name: "Google", based: "United States" },
  deepseek: { name: "DeepSeek", based: "China" },
  mistralai: { name: "Mistral AI", based: "France" },
  qwen: { name: "Alibaba Cloud (Qwen)", based: "China" },
  moonshotai: { name: "Moonshot AI", based: "China" },
  "z-ai": { name: "Zhipu AI (Z.ai)", based: "China" },
};
/** Every company a model of the service may come from must be listed above (test/consent.test.ts checks the defaults
 * and wrangler.jsonc); an unlisted one still shows, by its OpenRouter name, so nothing is hidden. */
export const listedCompanies = () => Object.keys(COMPANIES);

/** What Agent Referee itself keeps (src/review.ts reviewPayload: hashes only; src/match.ts: delete_at, 7 days). */
export const SERVICE_KEEPING =
  "Agent Referee keeps no copy of a review's text: its signed receipt holds only sha256 hashes of the task and output. " +
  "A judged match's text is kept with the match for 7 days, then deleted with it.";
export const COMPANY_KEEPING =
  "Each company named receives the text through its API (Anthropic directly, the others through OpenRouter) and handles it under its own API terms.";
export const SENDER_CLAUSE =
  "By agreeing you also confirm that you send only your own work, or work you are allowed to send.";

export type ConsentEnv = { CONSENT_REQUIRED?: string };
export const consentRequired = (env: ConsentEnv) => env.CONSENT_REQUIRED === "true";

/** The tag a request carries: the JSON body's "consent", else the X-Consent header. */
export function consentTag(c: any, body: unknown): string | undefined {
  const b = body && typeof body === "object" ? (body as any).consent : undefined;
  const v = typeof b === "string" ? b : c.req.header("x-consent");
  return typeof v === "string" && v.length > 0 && v.length <= 64 ? v : undefined;
}

export function companiesFor(models: string[]) {
  const seen = new Map<string, { company: string; based: string }>();
  for (const m of models) {
    const k = companyOf(m);
    const co = COMPANIES[k] ?? { name: k, based: "not listed in this notice: see that company's own terms" };
    if (!seen.has(k)) seen.set(k, { company: co.name, based: co.based });
  }
  return [...seen.values()];
}

/** The notice for this call's own models (a named or rotated panel decides who reads the text). */
export function notice(models: string[]) {
  return {
    version: NOTICE_VERSION,
    read_by: companiesFor(models),
    models,
    agent_referee_keeps: SERVICE_KEEPING,
    the_companies_keep: COMPANY_KEEPING,
    sender: SENDER_CLAUSE,
  };
}

/**
 * Null when the call may go on (consent off, or the current version given); otherwise the 428 answer.
 * `suffix` is the route's own "nothing was charged" sentence.
 */
export function consentCheck(c: any, body: unknown, models: string[], suffix: string): Response | null {
  if (!consentRequired(c.env)) return null;
  const tag = consentTag(c, body);
  if (tag === NOTICE_VERSION) return null;
  const why = tag
    ? `That consent was for notice version ${tag}; the notice has changed (now ${NOTICE_VERSION}).`
    : "Your text would go to AI models, so this service asks first.";
  return new Response(
    JSON.stringify({
      error: "consent_required",
      message: `${why} Show this notice to the person you work for. If they agree, send the same request again with "consent": "${NOTICE_VERSION}" in the JSON body (or the header X-Consent: ${NOTICE_VERSION}), and keep sending it. ${suffix}`.trim(),
      notice: notice(models),
    }),
    { status: 428, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

/** The version to record in a receipt, when consent is on and was given. */
export function consentRecorded(c: any): string | undefined {
  return consentRequired(c.env) ? (c.get?.("consent") as string | undefined) : undefined;
}
