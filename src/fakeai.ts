// Fake AI answers for free load tests on the staging Worker. Never active in production: fakeAiConfig() returns null
// unless FAKE_AI=true AND STAGING=true AND NETWORK isn't "base" (real money).
//
// FAKE_AI_DELAY_MS: "2000-30000" (random delay range). FAKE_AI_MIX: share of answers that misbehave, e.g.
// "429:0.1,500:0.05,cap:0.01,hang:0.05,cut:0.02" (the rest are good answers). Shapes match the real APIs closely
// enough for the callers' parsing, retry and cap handling to run exactly as in production.

export type FakeAi = { minMs: number; maxMs: number; mix: [kind: string, share: number][] };

/** override: staging load tests may send x-test-fake-mix / x-test-fake-delay headers to pick a failure mix per request
 * (no redeploy between scenarios). Only ever read when fake AI is already on, so production never sees them. */
export function fakeAiConfig(
  env: { FAKE_AI?: string; STAGING?: string; NETWORK?: string; FAKE_AI_DELAY_MS?: string; FAKE_AI_MIX?: string },
  override: { mix?: string | null; delay?: string | null } = {},
): FakeAi | null {
  if (env.FAKE_AI !== "true" || env.STAGING !== "true" || !env.NETWORK || env.NETWORK === "base") return null;
  const [a, b] = String(override.delay || env.FAKE_AI_DELAY_MS || "2000-30000").split("-").map(Number);
  const minMs = Number.isFinite(a) ? a : 2000;
  const maxMs = Number.isFinite(b) ? Math.max(b, minMs) : minMs;
  const mix: [string, number][] = String(override.mix ?? env.FAKE_AI_MIX ?? "")
    .split(",")
    .map((p) => p.split(":"))
    .filter(([k, v]) => k && Number.isFinite(Number(v)))
    .map(([k, v]) => [k.trim(), Number(v)]);
  return { minMs, maxMs, mix };
}

function pick(cfg: FakeAi, rand: () => number): string {
  let r = rand();
  for (const [k, share] of cfg.mix) {
    if (r < share) return k;
    r -= share;
  }
  return "ok";
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason ?? new DOMException("aborted", "AbortError"))), { once: true });
  });

/** A response shaped like the real provider's, after a fake thinking delay. */
export async function fakeModelResponse(cfg: FakeAi, model: string, user: string, signal?: AbortSignal, rand: () => number = Math.random): Promise<Response> {
  const openrouter = model.includes("/");
  const kind = pick(cfg, rand);
  if (kind === "hang") {
    await sleep(15 * 60_000, signal); // the caller's own timeout ends it
  }
  await sleep(cfg.minMs + (cfg.maxMs - cfg.minMs) * rand(), signal);
  const err = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ type: "error", error: { type, message } }), { status, headers: { "content-type": "application/json", ...headers } });
  if (kind === "429") return err(429, "rate_limit_error", "Number of concurrent connections has exceeded your rate limit.", { "retry-after": "2" });
  if (kind === "500") return err(529, "overloaded_error", "Overloaded");
  if (kind === "cap") return openrouter ? err(402, "payment_required", "Insufficient credits") : err(429, "rate_limit_error", "enforced_spend_limit_reached: your organization reached its monthly spend limit");
  // A good answer: a review verdict, or a judge verdict naming the first party in the message.
  const isReview = user.includes("<task>") && (user.includes("<output>") || user.includes("=====PIECE 1 of "));
  const party = /party="([^"]+)"/.exec(user)?.[1] ?? "alpha";
  const text = isReview
    ? JSON.stringify({ verdict: "pass", confidence: "high", issues: [], reasoning: "Fake staging answer." })
    : JSON.stringify({ winner: party, confidence: "high", rule_applied: "Fake staging answer.", reasoning: "Fake staging answer." });
  const cut = kind === "cut";
  const answer = cut ? text.slice(0, 20) : text;
  const headers = { "content-type": "application/json" };
  if (openrouter) return new Response(JSON.stringify({ model, choices: [{ message: { content: answer }, finish_reason: cut ? "length" : "stop" }] }), { headers });
  return new Response(JSON.stringify({ model, content: [{ type: "text", text: answer }], stop_reason: cut ? "max_tokens" : "end_turn" }), { headers });
}
