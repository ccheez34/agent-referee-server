// Agent Referee: a neutral, paid tie-breaker for AI agents (x402 / USDC).
import { Hono, type MiddlewareHandler } from "hono";
import { paymentMiddleware } from "x402-hono";
import { KEY_RE, MEDIATOR, MAX_SERIES_GAMES, doublePrice, idForKey, isJudgeTier, keyId, ipv6Prefix64, payerFromPaymentHeader, randomToken, sha256Hex, type Tier } from "./logic.ts";
import { MatchRoom } from "./match.ts";
import { Ledger, ledgerShardName, shardLimit } from "./ledger.ts";
import { landingHtml, llmsTxt, wantsHtml } from "./landing.ts";
import { JUDGE_MESSAGE_FORMAT, JUDGE_SYSTEM, judgeCommitment, missingJudgeKey, modelPool, optInModels, panelModels, tierCommitment, tierModels, type JudgeTierName } from "./judge.ts";
import type { Env } from "./types.ts";
import { payaiToken } from "./payai.ts";
import { signReceipt } from "./receipt.ts";
import {
  REVIEW_LIMITS, REVIEW_MESSAGE_FORMAT, longReviewRule, REVIEW_SYSTEM, REVIEW_VERDICTS, REVIEWER_BUDGET_MS, missingReviewKey, reviewCommitment, reviewModels, reviewPayload, runOneReviewer, validateReview, type ReviewTier,
} from "./review.ts";
import { Gate, GATE_MAX_WAIT_MS } from "./gate.ts";
import { Health, adminOk, evaluateHealth, healthEvents, listUnjudged, markRefunded, pauseState, recordEvent, recordSettleFailure, setPause, walletBlocked } from "./health.ts";
import { acquireSlots, gateStats, gatesOn, poolsOfProvider, quickBusy, resetPools, type SlotLease } from "./gateclient.ts";
import { classifyPaidResponse, plausiblePayment, priceMicro, reviewBudget, reviewLimitRefusal } from "./paywatch.ts";
import { fakeAiConfig } from "./fakeai.ts";

export { MatchRoom, Ledger, Gate, Health };

const app = new Hono<{ Bindings: Env }>();

const ID_RE = /^[a-f0-9]{24}$/;
// The service answers on several addresses (agentreferee.ai and the original workers.dev one). Invite links always use
// this one so clients from 0.6.1 on accept them; 0.6.2+ clients accept either official address.
const INVITE_BASE = "https://agent-referee.fairplayclub.workers.dev";

function prices(env: Env) {
  return {
    rps: env.PRICE_RPS || "$0.01",
    "rps-bo3": env.PRICE_RPS_BO3 || "$0.02",
    weighted: env.PRICE_WEIGHTED || "$0.015",
    draw: env.PRICE_DRAW_MEDIATOR || "$0.05",
    judge: env.PRICE_JUDGE || "$0.10",
    "judge-2": env.PRICE_JUDGE_2 || "$0.20",
    "judge-3": env.PRICE_JUDGE_3 || "$0.35",
  } satisfies Record<Tier, string>;
}

// Sealed review: one agent, one paid call, priced per review (not per seat).
function reviewPrices(env: Env): Record<ReviewTier, string> {
  return { review: env.PRICE_REVIEW || "$0.05", "review-3": env.PRICE_REVIEW_3 || "$0.20" };
}

// The 2-seat tiers an invite match (host pays for both seats) is available for.
const INVITE_TIERS = ["rps", "rps-bo3", "weighted", "judge", "judge-2", "judge-3"] as const;

// Paid routes. Payment only settles when the handler succeeds (status < 400),
// so a bad match id or a taken seat never costs the agent anything.
let paywall: MiddlewareHandler | null = null;
function getPaywall(env: Env): MiddlewareHandler {
  if (paywall) return paywall;
  const p = prices(env);
  const network = (env.NETWORK || "base-sepolia") as any;
  // What agents see in x402 discovery catalogs (the Bazaar). Written to be self-explanatory to an agent.
  const how =
    " Neutral third party for agents that can't agree; commit-reveal so no side (and not the server) can rig it; Ed25519-signed receipt. " +
    "Step 1: POST /matches (free) to get match_id. Step 2: this call claims your seat and returns seat_token. Full instructions: GET /";
  const joinInput = (seatDesc: string) => ({
    bodyType: "json" as const,
    bodyFields: {
      match_id: { type: "string", required: true, description: "24-char id returned by POST /matches (free)" },
      seat: { type: "string", required: true, description: seatDesc },
    },
  });
  const joinOutput = {
    seat: { type: "string", description: "The seat you claimed" },
    seat_token: { type: "string", description: "Secret token for your later commit/reveal/submit calls. Shown once." },
    match: { type: "object", description: "Current match status: phase, who it's waiting on, etc." },
  };
  const route = (price: string, description: string, seatDesc = "Your seat label, one of the seats named when the match was created") => ({
    price,
    network,
    config: { description: description + how, mimeType: "application/json", inputSchema: joinInput(seatDesc), outputSchema: joinOutput, discoverable: true },
  });
  // x402.org is testnet-only. For real money set FACILITATOR_URL to a mainnet facilitator (see README).
  // With PAYAI_API_KEY_ID + PAYAI_API_KEY_SECRET set (wrangler secret put), every facilitator call carries a
  // short-lived signed token, so settlements draw on the account's paid credits instead of the free allowance.
  const keyId = env.PAYAI_API_KEY_ID?.trim();
  const keySecret = env.PAYAI_API_KEY_SECRET?.trim();
  const facilitator = {
    url: (env.FACILITATOR_URL || "https://x402.org/facilitator") as `${string}://${string}`,
    ...(keyId && keySecret
      ? {
          createAuthHeaders: async () => {
            const h = { Authorization: `Bearer ${await payaiToken(keyId, keySecret)}` };
            return { verify: h, settle: h, supported: h, list: h };
          },
        }
      : {}),
  };
  const rp = reviewPrices(env);
  const reviewRoute = (price: string, description: string) => ({
    price,
    network,
    config: {
      description,
      mimeType: "application/json",
      // Reviewers can take a minute or two; keep the payment authorization valid until the review is done.
      maxTimeoutSeconds: 300,
      inputSchema: {
        bodyType: "json" as const,
        bodyFields: {
          task: { type: "string", required: true, description: `What the agent was asked to do (10-${REVIEW_LIMITS.maxTask} chars)` },
          output: { type: "string", required: true, description: `The agent's output to review (up to ${REVIEW_LIMITS.maxOutput} chars)` },
          title: { type: "string", required: false, description: "Optional short title" },
          criteria: { type: "array", required: false, description: 'Optional weighted criteria, e.g. [{"name":"accuracy","weight":3}]' },
        },
      },
      outputSchema: {
        result: { type: "object", description: "verdict: pass | needs_changes | fail | cannot_assess (review-3 can also be split), plus the tally" },
        votes: { type: "array", description: "Each reviewer's verdict, issues found, reasoning and scores" },
        receipt: { type: "object", description: "Ed25519-signed receipt with hashes of the task and output" },
      },
      discoverable: true,
    },
  });
  paywall = paymentMiddleware(
    env.PAY_TO as `0x${string}`,
    {
      "/join/rps": route(p.rps, "Agent Referee — settle a deadlock with another AI agent by fair rock-paper-scissors. Ties replay free. Each of the 2 agents pays this to join."),
      "/join/rps-bo3": route(p["rps-bo3"], "Agent Referee — best-of-3 rock-paper-scissors between two AI agents. Ties don't count. Each of the 2 agents pays this to join."),
      "/join/weighted": route(p.weighted, "Agent Referee — fair random pick between two AI agents with agreed odds (e.g. 70/30). Both agents add secret seeds so neither can steer it. Each agent pays this to join."),
      "/join/draw/mediator": route(p.draw, "Agent Referee — fair pick among 2-20 options for a group of 2-8 AI agents. A mediator agent pays once for everyone; parties join free at /join/draw/party.", 'Always "mediator" for this route'),
      "/join/judge": route(p.judge, "Agent Referee — an AI judge decides between two AI agents by applying rules both agreed to in advance (optionally scored on weighted criteria). Positions stay hidden until both are in. It can declare a mistrial when no fair decision is possible. Each agent pays this to join."),
      "/join/judge-2": route(p["judge-2"], "Agent Referee — a panel of 2 independent AI judges from different companies (sealed verdicts) decides between two AI agents by rules both agreed to. Both judges must agree, or it's a mistrial sent back to the owners. Each agent pays this to join."),
      "/join/judge-3": route(p["judge-3"], "Agent Referee — a panel of 3 independent AI judges from three different companies (sealed verdicts) decides between two AI agents by rules both agreed to; the majority wins and dissent is kept in the signed receipt. Each agent pays this to join."),
      "/review": reviewRoute(rp.review, "Agent Referee sealed review — one AI reviewer checks your agent's output against its task and returns a verdict (pass, needs_changes, fail or cannot_assess), the problems it found and a signed receipt. One agent, one call; charged only if the review completes."),
      "/review-3": reviewRoute(rp["review-3"], "Agent Referee sealed review — three independent AI reviewers from three different companies check your agent's output in parallel, without seeing each other's verdicts; majority verdict, every vote in a signed receipt. One agent, one call; charged only if the review completes."),
      // Invite matches: the host pays for both seats here; the guest joins free with the invite token.
      ...Object.fromEntries(
        INVITE_TIERS.map((t) => [
          `/host/join/${t}`,
          route(doublePrice(p[t]), `Agent Referee (${t}), invite match — the host agent pays for BOTH seats here, so the other agent can join free with an invite link (POST /matches with "host_pays"). Charged only once the guest has joined.`, "The host's seat (the one named in host_pays)"),
        ]),
      ),
    },
    facilitator as any,
  ) as unknown as MiddlewareHandler;
  return paywall;
}

const PAUSED_MSG =
  "Paid matches are paused for a moment. Free demo matches work now: add \"demo\": true to POST /matches and join at /demo/join/<tier>. Nobody was charged.";
const REVIEWS_PAUSED_MSG = "Sealed reviews are paused for a moment. Nobody was charged; try again later.";
const paidPaused = (env: Env) => env.PAID_PAUSED === "true";
/** The wrangler secret or the phone switch (POST /admin/pause). */
async function paidPausedNow(env: Env) {
  return paidPaused(env) || (await pauseState(env)).paid;
}
async function reviewsPausedNow(env: Env) {
  return env.REVIEWS_PAUSED === "true" || (await pauseState(env)).reviews;
}

/** 503 "busy, nothing charged", with the seconds to wait in Retry-After (and in the body, for agents). */
const busy = (retryAfterS: number, what: string) =>
  new Response(
    JSON.stringify({ error: `busy: ${what} Nothing was charged; retry in about ${retryAfterS} s.`, busy: true, retry_after_s: retryAfterS }),
    { status: 503, headers: { "content-type": "application/json", "retry-after": String(retryAfterS) } },
  );

/** Adds one to today's usage count for GET /admin/stats. Counts only, never who; never delays or fails a request. */
function stat(c: any, name: string) {
  if (!c.env.LEDGER) return;
  void inBackground(c, ledgerJson(c.env, undefined, "stat", { name }));
}

/** Runs after the response when the platform allows it (waitUntil), otherwise right away. */
async function inBackground(c: any, p: Promise<unknown>) {
  const safe = p.catch((e) => console.error(`background task failed: ${String(e?.message ?? e).slice(0, 200)}`));
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    await safe;
  }
}

const paidRoute = async (c: any, next: any) => {
  // Checked before the paywall, so a paused service never asks anyone to pay.
  if (await paidPausedNow(c.env)) return err(503, PAUSED_MSG);
  if (c.env.PAYMENTS_ENABLED === "false") return next();
  const hadPayment = !!c.req.header("x-payment");
  const payer = payerFromPaymentHeader(c.req.header("x-payment"));
  // A wallet whose payment once failed to settle after the work was delivered isn't served again (before payment).
  if (payer && (await walletBlocked(c.env, payer)))
    return err(403, "wallet_blocked: an earlier payment from this wallet didn't settle after the work was delivered, so it can't pay here anymore. Nothing was charged. Contact hello@agentreferee.ai with the wallet address.");
  const t0 = Date.now();
  let handlerRan = false;
  let handlerStatus: number | undefined;
  let handlerMs = 0;
  const r = await getPaywall(c.env)(c, async () => {
    handlerRan = true;
    const h0 = Date.now();
    await next();
    handlerMs = Date.now() - h0;
    handlerStatus = c.res?.status;
  });
  const final: Response | undefined = r instanceof Response ? r : c.res;
  if (hadPayment && final) {
    let errorText = "";
    if (final.status === 402) errorText = String(((await final.clone().json().catch(() => ({}))) as any)?.error ?? "");
    const o = classifyPaidResponse({ hadPayment, handlerRan, handlerStatus, status: final.status, errorText });
    const facilitatorMs = Date.now() - t0 - handlerMs;
    console.log(JSON.stringify({ payment: o.kind, path: c.req.path, facilitator_ms: facilitatorMs, handler_ms: handlerMs, ...("detail" in o ? { stage: o.stage, detail: o.detail } : {}) }));
    // A settle failure means the work was done but not paid for: always worth an alert (even when the payer caused it).
    if ("stage" in o && o.stage === "settle") await inBackground(c, recordSettleFailure(c.env, payer, `${c.req.path}: ${o.detail}`));
    if (o.kind === "facilitator_problem") await inBackground(c, recordEvent(c.env, o.credit ? "credit_problem" : "facilitator_problem", `${o.stage} ${c.req.path}: ${o.detail}`));
  }
  return r;
};

/**
 * Sealed review, before the paywall: pause switches, input checks, the review panel drawn once, the failed-review
 * allowance, and admission. A request that hasn't paid yet is checked against a cached snapshot of the provider pools
 * (no slot taken). A paid request takes its reviewer slots BEFORE the payment is verified and keeps them through the
 * review, so a verified payment never meets a full pool. Any refusal here is before payment: nothing is charged.
 */
async function reviewGuard(c: any, next: any) {
  const tier: ReviewTier = c.req.path === "/review-3" ? "review-3" : "review";
  const t0 = Date.now();
  if (await paidPausedNow(c.env)) return err(503, PAUSED_MSG);
  if (await reviewsPausedNow(c.env)) return err(503, REVIEWS_PAUSED_MSG);
  const body = await c.req.json().catch(() => null);
  const v = validateReview(body, tier);
  if (!v.ok) return err(400, `${v.error} Nothing was charged.`);
  let commitment;
  try {
    commitment = await reviewCommitment(tier, c.env, v.value.panel, undefined, v.value.task.length + v.value.output.length);
  } catch (e: any) {
    return err(400, `${String(e?.message ?? e)} Nothing was charged.`);
  }
  if (missingReviewKey(c.env, commitment.models)) return err(503, "Sealed review is temporarily unavailable. Nothing was charged.");
  const paying = c.env.PAYMENTS_ENABLED === "false" || !!c.req.header("x-payment");
  if (!paying) {
    // The first x402 call (no payment yet): answer busy now rather than after the agent signs a payment.
    const b = await quickBusy(c.env, commitment.models);
    if (b) return busy(b.retryAfter, "the AI reviewers are at capacity.");
    c.set("review", { tier, input: v.value, commitment, t0 });
    return next();
  }
  // A failed review isn't charged, so failed reviews are capped per address per day: nobody gets free AI calls in bulk.
  const caller = await callerHash(c);
  const failLimit = Number(c.env.REVIEW_FAIL_LIMIT || 10);
  // Only a payment that at least claims to pay us the right amount takes slots before verification; anything else
  // goes straight to the paywall (which refuses it), and if the facilitator accepts it anyway the handler takes its
  // slots then. So fake payment headers can't fill the gates.
  const price = priceMicro(reviewPrices(c.env)[tier]);
  const plausible = c.env.PAYMENTS_ENABLED === "false" || plausiblePayment(c.req.header("x-payment"), { payTo: c.env.PAY_TO, network: c.env.NETWORK, minMicro: price });
  if (!plausible) {
    c.set("review", { tier, input: v.value, commitment, t0, caller, failLimit });
    return next();
  }
  const check = await failLimitCheck(c, caller, failLimit);
  if (check instanceof Response) return check;
  const reservation = check?.token;
  const slots = await acquireSlots(c.env, commitment.models, { leaseMs: REVIEWER_BUDGET_MS + 30_000, waitMs: GATE_MAX_WAIT_MS });
  if (!slots.ok) {
    await releaseReservation(c, caller, failLimit, reservation);
    return busy(slots.retryAfter, busyWhat(slots.reason));
  }
  const g: any = { tier, input: v.value, commitment, t0, lease: slots.lease, caller, failLimit, reservation };
  c.set("review", g);
  try {
    await next();
  } finally {
    await slots.lease.release(); // normally already released by the handler; a second call does nothing
    if (!g.recorded) await releaseReservation(c, caller, failLimit, reservation); // the paywall refused it, or it threw
  }
}

/** Give back an in-flight reservation that ended without a result (best effort; it expires after 5 minutes anyway). */
async function releaseReservation(c: any, caller: string | undefined, failLimit: number, token?: string) {
  if (!token || !caller || !c.env.LEDGER) return;
  await ledgerJson(c.env, caller, "review-fails", { caller, limit: failLimit, release_token: token }).catch(() => {});
}

/** Extra reviews one address may have in flight beyond its remaining failure allowance (REVIEW_PARALLEL_PER_ADDRESS, default 20). */
const reviewParallel = (env: Env) => {
  const raw = String(env.REVIEW_PARALLEL_PER_ADDRESS ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 20;
};

/** The failed-review allowance for this caller, reserving one in-flight review (released when the result is
 * recorded). Fails closed when the ledger can't answer. Returns a refusal, or the reservation token (or null). */
async function failLimitCheck(c: any, caller: string | undefined, failLimit: number): Promise<Response | { token?: string } | null> {
  if (!caller || !c.env.LEDGER) return null;
  let f: any;
  try {
    f = await ledgerJson(c.env, caller, "review-fails", { caller, limit: failLimit, global_limit: shardLimit(c.env.REVIEW_FAIL_GLOBAL_LIMIT, 500), parallel: reviewParallel(c.env), reserve: true });
  } catch (e: any) {
    await recordEvent(c.env, "ledger_error", `review-fails: ${String(e?.message ?? e)}`);
    return err(503, "Sealed review is temporarily unavailable (its usage limits can't be checked right now). Nothing was charged; try again in a minute.");
  }
  if (!f.blocked) return { token: f.token };
  const r = reviewLimitRefusal(f, failLimit, reviewParallel(c.env));
  return r.busy ? busy(r.retryAfterS, r.message) : err(r.status, r.message);
}

const busyWhat = (reason: string) =>
  reason === "provider_cap" ? "the AI provider's account limit was reached; reviews resume when it's lifted." : "the AI reviewers are at capacity.";

/** Judge seats: refuse before payment when the match's judges are closed by a provider cap or their queue is full.
 * Judging itself happens later; this only avoids taking money when we already know it can't start soon. */
async function judgeJoinGuard(c: any, next: any) {
  if (!gatesOn(c.env)) return next();
  const body: any = await c.req.json().catch(() => null);
  const id = body?.match_id;
  if (typeof id !== "string" || !ID_RE.test(id)) return next(); // the handler gives the proper error, before payment settles
  const status: any = await (await forward(c.env, id, "status")).json().catch(() => null);
  const models: string[] = status?.judge ? (status.judge.panel ?? [{ model: status.judge.model }]).map((p: any) => p.model) : [];
  const b = models.length ? await quickBusy(c.env, models) : null;
  if (b) return busy(b.retryAfter, "this match's AI judges are at capacity.");
  return next();
}

for (const t of ["judge", "judge-2", "judge-3"]) {
  app.use(`/join/${t}`, judgeJoinGuard);
  app.use(`/host/join/${t}`, judgeJoinGuard);
}
app.use("/review", reviewGuard);
app.use("/review-3", reviewGuard);
app.use("/join/*", paidRoute);
app.use("/host/join/*", paidRoute);
app.use("/review", paidRoute);
app.use("/review-3", paidRoute);

function room(env: Env, id: string) {
  return env.MATCHES.get(env.MATCHES.idFromName(id));
}

async function forward(env: Env, id: string, action: string, body?: unknown) {
  const stub = room(env, id);
  const res = await stub.fetch(`https://match/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Responses from a Durable Object have locked headers. Copy into a fresh Response
  // so the payment middleware can attach its X-PAYMENT-RESPONSE receipt header.
  return new Response(res.body, { status: res.status, headers: new Headers(res.headers) });
}

const err = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

// ---------- discovery ----------

app.get("/", (c) => {
  const p = prices(c.env);
  const base = new URL(c.req.url).origin;
  // The same address answers with HTML or JSON depending on Accept, so caches must keep them apart.
  c.header("Vary", "Accept");
  // A person in a browser gets a readable page; agents and tools get the JSON instructions below.
  if (wantsHtml(c.req.header("accept"), c.req.query("format"))) return c.html(landingHtml({ ...p, ...reviewPrices(c.env), free_reviews: freeReviewsLabel(c.env) }, base, c.env.DEMO_PER_IP_LIMIT || "20"));
  return c.json({
    service: "Agent Referee",
    docs: "https://github.com/ccheez34/agent-referee-client",
    website: "https://agentreferee.ai",
    contact: "hello@agentreferee.ai",
    terms: "https://github.com/ccheez34/agent-referee-client/blob/main/TERMS.md",
    privacy: "https://github.com/ccheez34/agent-referee-client/blob/main/PRIVACY.md",
    health: `${base}/health`,
    status_page: "https://stats.uptimerobot.com/dh6sVMvo3W",
    llms_txt: `${base}/llms.txt`,
    coming_next: "The full Python client (receipt checks are on PyPI now: pip install agent-referee-client) and an MCP server.",
    limitations: "Run by one person. AI judges can be wrong; a verdict is not legal arbitration. Records belong to a wallet, not a company, and a fresh wallet starts clean. Not a wager: both agents pay a fixed fee whoever wins; the service never holds stakes.",
    plans: "Using this at volume? Company accounts are in the works: prepaid credit packs, monthly plans with matches included, card payment alongside USDC, and one bill covering both sides of every match. Tell us what you need: https://github.com/ccheez34/agent-referee-client/issues/new?title=Plans%20%2F%20company%20account",
    summary:
      "A neutral third party that settles disagreements between AI agents. Every random outcome uses commit-reveal so no agent (and not this server) can rig it, and every result comes with an Ed25519-signed receipt.",
    payment: { protocol: "x402", network: c.env.NETWORK, asset: "USDC", pay_to: c.env.PAY_TO },
    ...(paidPaused(c.env) ? { notice: PAUSED_MSG } : {}),
    tiers: {
      "1 rps": { tier: "rps", seats: 2, price_per_seat: p.rps, what: "Rock-paper-scissors; ties replay free." },
      "2 rps-bo3": { tier: "rps-bo3", seats: 2, price_per_seat: p["rps-bo3"], what: "Best of 3 rock-paper-scissors; ties don't count." },
      "3 weighted": { tier: "weighted", seats: 2, price_per_seat: p.weighted, what: "Random pick with agreed odds: 50/50 for a fair coin, or e.g. 70/30. Both agents contribute secret seeds. The best default." },
      "4 draw": { tier: "draw", seats: "2-8 parties + mediator", price: `${p.draw} paid by the mediator; parties join free`, what: "Fair pick among 2-20 options. A third agent mediates and pays; every seat contributes a seed." },
      "5 judge": { tier: "judge", seats: 2, price_per_seat: p.judge, what: "An AI judge picks a winner by applying rules both agents agreed to, with a confidence level. Optional weighted criteria: the judge scores each side 0-10 per criterion and the winner is computed from the scores. It can declare a mistrial (sent back to the owners) when no fair decision is possible. Submissions stay hidden until both are in." },
      "6 judge-2": { tier: "judge-2", seats: 2, price_per_seat: p["judge-2"], what: "Two independent AI judges from different companies decide in parallel, neither seeing the other's verdict. Both must agree, otherwise it's a mistrial. For decisions where a wrong winner costs more than a do-over." },
      "7 judge-3": { tier: "judge-3", seats: 2, price_per_seat: p["judge-3"], what: "Three independent AI judges from three different companies decide in parallel; majority wins. Every vote, including dissent, is in the signed receipt, and anyone can recompute the decision from the votes." },
      "8 review": { tier: "review", seats: 1, price: `${reviewPrices(c.env).review} per review`, what: "Sealed review, no second agent needed: one AI reviewer checks your agent's output against its task and returns pass, needs_changes, fail or cannot_assess, the problems found, and a signed receipt. POST /review." },
      "9 review-3": { tier: "review-3", seats: 1, price: `${reviewPrices(c.env)["review-3"]} per review`, what: "Sealed review by three independent AI reviewers from three different companies; majority verdict, every vote in the signed receipt. POST /review-3." },
    },
    flow: [
      `POST ${base}/matches  {tier, seats:[...], weights?|options?|rules?, title?, key?, seat_wallets?, step_seconds?}  (free) -> match_id`,
      `  seat_wallets (optional): {"alpha":"0x...","beta":"0x..."} reserves each paid seat for one wallet, so a leaked match_id or key can't let anyone else take it.`,
      `  key (optional): a name both agents already share, e.g. "order-5521-delivery". Both agents call POST /matches with the same key and settings and get the same match_id, so no id needs passing. Make it unique per decision and hard to guess.`,
      `POST ${base}/join/<tier>  {match_id, seat}  (x402 paid; draw: /join/draw/mediator paid, /join/draw/party free) -> seat_token`,
      `  A paid join waits up to 15 seconds for every seat to be filled. If the others don't show, your seat is released with a 408 and you are NOT charged. Retry (the client library retries 3 times, about 1 minute in all); nobody ever pays for a no-show. Keep your HTTP timeout above 20 seconds.`,
      `  step_seconds (optional, 60-3600, default 600) on POST /matches sets how long each step may take before a forfeit.`,
      `Random tiers: POST ${base}/matches/<id>/commit {seat, seat_token, commitment}, then POST ${base}/matches/<id>/reveal {seat, seat_token, value, nonce}`,
      `  commitment = sha256_hex(value + ":" + nonce); value is rock|paper|scissors for rps tiers, or a random seed (16+ chars) otherwise; nonce is 16+ random chars`,
      `Judge tiers (judge, judge-2, judge-3): POST ${base}/matches/<id>/submit {seat, seat_token, position}`,
      `  criteria (optional, judge tiers): [{"name":"price","weight":3},{"name":"delivery time","weight":1}] on POST /matches. Each judge scores both sides 0-10 per criterion; the winner is the higher weighted total (a tie is a mistrial).`,
      `  A mistrial (result.winner null, result.mistrial true, escalate_to_owners true) means no fair verdict was possible: take it back to the owners. Seats are still charged, since the judges did the work.`,
      `  result.mistrial_code says why, for programs: different_questions, rules_not_applicable, missing_information or other (from a judge); score_tie, panel_disagreement, panelist_mistrial or no_majority (from the panel rules).`,
      `Invite (one agent pays for both seats, so the other needs no wallet): POST ${base}/matches with "host_pays": "<your seat>" (2-seat tiers, no key). The response has invite.url: send it to the other agent. You join at ${base}/host/join/<tier> and pay double the seat price, charged only once the guest is in (keep retrying while you wait, like any join). The guest opens the url to read the settings, then POST ${base}/invite/join {match_id, invite_token} to take its seat free. Works in demo matches too (${base}/demo/host/join/<tier>).`,
      `Rematch (rps, rps-bo3, weighted): after a result, each party calls POST ${base}/matches/<id>/rematch {seat, seat_token}. Once both have, the response (and the match status) gives next_match_id: join it like any match (paid per seat). Seats are locked to the wallets that paid this game. Each receipt carries the series tally and the previous receipt's hash. Up to ${MAX_SERIES_GAMES} games per series.`,
      `Lost your seat_token after paying? POST ${base}/matches/<id>/recover {payment: "<the exact X-PAYMENT header you paid with>"} re-issues your seat with a new token, free.`,
      `Sealed review (one agent, no match): POST ${base}/review or ${base}/review-3 (x402 paid) {task, output, title?, criteria?} -> {result:{verdict, tally}, votes, receipt}. Usually seconds, but up to 4 minutes if a provider is slow: keep your HTTP timeout at least 300 seconds. Failed reviews aren't charged (up to 10 per IP address per day, plus one per successful review). Verdicts: pass, needs_changes, fail, cannot_assess (review-3 can be split). The receipt holds sha256 of the task and output; anyone holding the output can check it. If a reviewer fails, nothing is charged. GET ${base}/reviewers shows the models and prompt before you pay.`,
      ...(freeReviewConfig(c.env).budgetMicro ? [`Free sealed review (no wallet): POST ${base}/free/review or ${base}/free/review-3 with the same body. ${freeReviewConfig(c.env).perCaller.review} single-reviewer and ${freeReviewConfig(c.env).perCaller["review-3"]} review-3 per IP address per UTC day, inside one shared daily budget; receipts are signed the same way and say "funding": "free". A busy service or a failed reviewer doesn't use up a free review.`] : []),
      `GET ${base}/matches/<id> for status, result and signed receipt; GET ${base}/pubkey to verify receipts`,
      `Records: GET ${base}/agents/<wallet> shows a paying wallet's judge record, luck record, completed vs forfeited matches and badges, so an agent can check a counterparty before trusting it. Records only cover matches the wallet actually joined, so an empty record means unknown, not reliable. Add "private_record": true (or false) to any paid join to hide (or show) your own record; the setting sticks to your wallet until you change it. The same wallet in two seats never counts.`,
      `Free demo (no wallet): add "demo": true to POST /matches, then join at ${base}/demo/join/<tier> instead of /join/<tier>. Same protocol, signed receipts marked demo, nothing recorded, no judge tier, up to ${c.env.DEMO_PER_IP_LIMIT || 20} demo matches per day per IP address (${c.env.DEMO_DAILY_LIMIT || 2000} across all users).`,
      `Judge tiers: the model(s), prompt fingerprint and (for panels) decision rule are fixed when the match is created and shown in its status before you pay. GET ${base}/judge publishes the full prompt.`,
    ],
    rules: [
      "Every step has a deadline (10 minutes by default): commit (or submit, in the judge tier) once everyone has joined, then reveal once everyone has committed. Miss it and you forfeit: the side that acted wins, and the forfeit goes on your record. In a draw, seats that walk away are left out and the draw continues.",
      "Unfinished matches expire after 24 hours; all match data is deleted after 7 days.",
      "The referee charges a fixed fee per seat. It never holds, pays out, or takes a share of any stakes between agents.",
    ],
  });
});

// Plain-text summary for AI agents and LLM crawlers.
app.get("/llms.txt", (c) => {
  const base = new URL(c.req.url).origin;
  return c.text(llmsTxt({ ...prices(c.env), ...reviewPrices(c.env), free_reviews: freeReviewsLabel(c.env) }, base, c.env.DEMO_PER_IP_LIMIT || "20"));
});

// Health check for uptime monitors (free, no AI calls, no payments). 200 + "status":"ok" = all good; "degraded" names
// the reasons (a provider cap, high failure rate, payment facilitator problems, ledger errors); 503 = can't run at all.
// The full answer is cached for 30 s per isolate, so a monitor (or anyone) polling it costs almost nothing.
// Keyed by the environment object (one per deployment; tests make their own), so a cached answer never leaks across.
const healthCaches = new WeakMap<object, { at: number; body: any; status: number }>();
app.get("/health", async (c) => {
  const env = c.env;
  const healthCache = healthCaches.get(env);
  if (healthCache && Date.now() - healthCache.at < 30_000) return c.json(healthCache.body, healthCache.status as any);
  const signing = !!env.SIGNING_KEY && !!env.PUBLIC_KEY;
  let records: "ok" | "error" | "off" = !env.LEDGER ? "off" : "ok";
  if (env.LEDGER) {
    try {
      const r = await ledgerCall(env, "agent", undefined, `?wallet=0x${"0".repeat(40)}`);
      if (r.status >= 500) records = "error";
      await ledgerJson(env, "0", "demo-quota", { limit: 0, per_caller: 0 }, true); // one shard answers (limit 0: counts nothing)
    } catch {
      records = "error";
    }
  }
  const judges = Object.fromEntries(
    (["judge", "judge-2", "judge-3"] as const).map((t) => [t, missingJudgeKey(env, tierModels(env, t)) ? "unavailable" : "ok"]),
  );
  const pools = gatesOn(env) ? [...new Set([...poolsOfProvider(env, "anthropic"), "openrouter"])] : [];
  const gates = pools.length ? await gateStats(env, pools) : {};
  const events = await healthEvents(env).catch(() => []);
  const unjudged = await listUnjudged(env).catch(() => []);
  const verdict = evaluateHealth({ gates, events, ledger: records, unjudgedOpen: unjudged.filter((u) => !u.refunded).length });
  const pause = await pauseState(env);
  if (pause.auto) verdict.reasons.push(`auto_paused: ${pause.auto}`), (verdict.degraded = true);
  const paused = paidPaused(env) || pause.paid;
  const reviewsPaused = env.REVIEWS_PAUSED === "true" || pause.reviews;
  const ok = signing && records !== "error";
  const allJudges = Object.values(judges).every((v) => v === "ok");
  const status = !ok ? "down" : verdict.degraded || !allJudges ? "degraded" : paused || reviewsPaused ? "paused" : "ok";
  const body = {
    ok,
    status,
    reasons: [...verdict.reasons, ...(allJudges ? [] : ["judge_key_missing"])],
    warnings: verdict.warnings,
    checks: {
      receipts_signing: signing ? "ok" : "missing key",
      records,
      payments: env.PAYMENTS_ENABLED === "false" ? "off" : paused ? "paused" : "on",
      reviews: reviewsPaused || paused ? "paused" : "on",
      judges,
      providers: Object.fromEntries(
        Object.entries(gates).map(([p, g]: [string, any]) => [p, g?.error ? "unreachable" : g?.tripped ? "capped" : g?.full ? "full" : g?.throttled_until ? "throttled" : "ok"]),
      ),
    },
    time: new Date().toISOString(),
  };
  healthCaches.set(env, { at: Date.now(), body, status: ok ? 200 : 503 });
  return c.json(body, ok ? 200 : 503);
});

// ---------- operator controls (Authorization: Bearer <ADMIN_TOKEN>; 404 when no token is configured) ----------

async function admin(c: any): Promise<Response | null> {
  if (!c.env.ADMIN_TOKEN) return err(404, "Not found. GET / for how to use this service.");
  if (!(await adminOk(c.env, c.req.header("authorization")))) return err(401, "Wrong or missing admin token.");
  return null;
}

// Pause or resume from a phone (an iPhone Shortcut): {"scope":"paid"|"reviews","on":true|false}. Applies within 15 s.
app.post("/admin/pause", async (c) => {
  const denied = await admin(c);
  if (denied) return denied;
  const body: any = await c.req.json().catch(() => null);
  if (!["paid", "reviews"].includes(body?.scope) || typeof body?.on !== "boolean") return err(400, 'Send {"scope":"paid"|"reviews","on":true|false}.');
  healthCaches.delete(c.env);
  return c.json(await setPause(c.env, body.scope, body.on));
});

// Paid judge matches that couldn't be judged: refund these wallets from the fee wallet, then mark them refunded.
app.post("/admin/unjudged", async (c) => {
  const denied = await admin(c);
  if (denied) return denied;
  const body: any = await c.req.json().catch(() => ({}));
  if (typeof body?.refunded_match_id === "string") await markRefunded(c.env, body.refunded_match_id);
  return c.json(await listUnjudged(c.env));
});

// Usage counts for the last 7 UTC days: reviews done, failed, refused and busy, plus today's free budget used.
// Counts only: nothing about who asked.
app.get("/admin/stats", async (c) => {
  const denied = await admin(c);
  if (denied) return denied;
  if (!c.env.LEDGER) return err(503, "Stats need the ledger.");
  let s: any;
  try {
    s = await ledgerJson(c.env, undefined, "stats", {});
    if (!Array.isArray(s?.days) || !s.days.length) throw new Error("unexpected answer");
  } catch (e: any) {
    console.error(`admin stats: ${String(e?.message ?? e).slice(0, 200)}`);
    return err(503, "Stats can't be read right now; try again in a minute.");
  }
  const usd = (micro: unknown) => (Number.isFinite(micro) ? Math.round((micro as number) / 10_000) / 100 : 0);
  const pub = freeReviewConfig(c.env);
  const ext = freeReviewConfig(c.env, "ext");
  return c.json({
    today: s.days[0],
    last_7_days: s.days,
    free_budget_today: {
      public: { spent_usd: usd(s.free_spent_micro?.public), budget_usd: usd(pub.budgetMicro) },
      ext: { spent_usd: usd(s.free_spent_micro?.ext), budget_usd: usd(ext.budgetMicro), note: "free reviews from the hosted MCP server (ChatGPT)" },
    },
    key: "free_* = free reviews from the public routes; ext_* = free reviews from the hosted MCP server (ChatGPT); paid_* = paid reviews. ok_review / ok_review3 = completed, failed = a reviewer failed (not used / not charged), busy = at capacity, refused_caller = that address or user had used today's allowance, refused_budget = the shared budget was used up, bad_input = the request was rejected. Spending is counted at list price, not the real AI cost.",
  });
});

// Reopen provider pools after a spend cap was lifted (instead of waiting for the hourly probe).
app.post("/admin/gate-reset", async (c) => {
  const denied = await admin(c);
  if (denied) return denied;
  const pools = gatesOn(c.env) ? [...new Set([...poolsOfProvider(c.env, "anthropic"), "openrouter"])] : [];
  await resetPools(c.env, pools);
  healthCaches.delete(c.env);
  return c.json({ ok: true, reset: pools });
});

// The exact judge setup, so anyone can check the prompt_sha256 in a match or receipt.
app.get("/judge", async (c) => {
  const commit = await judgeCommitment(c.env.JUDGE_MODEL || "claude-haiku-5-5");
  return c.json({
    ...commit,
    panels: {
      "judge-2": await tierCommitment("judge-2", panelModels(c.env, "judge-2")),
      "judge-3": await tierCommitment("judge-3", panelModels(c.env, "judge-3")),
      how_votes_combine: {
        unanimous: "judge-2: if both judges pick the same party it wins; otherwise mistrial.",
        majority: "judge-3: a party with 2 or more of the 3 votes wins; otherwise mistrial.",
        criteria: "With criteria, each judge's pick is the party with the higher weighted total of its 0-10 scores (equal totals count as a mistrial vote).",
        mistrial_codes: "A judge's own mistrial: different_questions, rules_not_applicable, missing_information (or other). From the rules: score_tie, panel_disagreement (judge-2 split), panelist_mistrial (a judge-2 panelist declared one), no_majority (judge-3).",
        independence: "Panelists run in parallel and never see each other's verdicts. Panelist 2 sees the parties in reverse order.",
      },
    },
    model_pool: modelPool(c.env),
    opt_in_models: optInModels(c.env),
    opt_in_note: OPT_IN_NOTE,
    choosing_the_panel: PANEL_CHOICE_HELP,
    fingerprint_formula: "sha256_hex(format_version + \"\\n\" + system_prompt + \"\\n\" + message_format)",
    system_prompt: JUDGE_SYSTEM,
    message_format: JUDGE_MESSAGE_FORMAT,
    note: "Each judge match locks in these values when it is created, before anyone pays. They appear in the match status and the signed receipt. AI output can vary slightly even with identical inputs, so verdicts are auditable rather than bit-for-bit reproducible.",
  });
});

const OPT_IN_NOTE =
  "opt_in_models come from companies outside model_pool (Mistral, EU; DeepSeek, Qwen/Alibaba, Kimi/Moonshot and GLM/Z.ai, China). Agents may name them in an exact list, an agreed set or a judge-3 pick, but they are never drawn at random: rotate and the drawn third judge use model_pool only. Their requests go through OpenRouter only to hosts that don't collect request data; submissions still reach whichever host runs the model, so leave secrets and personal data out.";

const PANEL_CHOICE_HELP =
  'Optional "panel" on POST /matches (judge-2, judge-3), part of the settings both agents agree to: "rotate" seats one model from each AI company, choosing which model at random within each company from model_pool; ["model", ...] uses exactly those models (each from model_pool or opt_in_models); [["a","b","c"], ["d","e","f"]] draws one of up to 5 agreed sets at random; judge-3 only: {"picks": {"<seat>": "model", "<seat>": "model"}} lets each party name one judge, and the third comes at random from a company neither picked, so neither side controls the majority. Every panel uses models from different AI companies. The draw happens before anyone pays, and the chosen models plus how they were chosen (panel_selection) are in the match status and the signed receipt. Without it, the default panel is used.';

// ---------- sealed review (one agent, one call) ----------

/** A caller's address as a one-way hash salted with a server secret and today's date: can't be turned back into
 * an IP and can't link the same caller across days. Undefined when there's no IP header (local tests). */
async function callerHash(c: any): Promise<string | undefined> {
  let ip: string | undefined = c.req.header("cf-connecting-ip");
  // Staging load tests stand in for many callers with this header; production never reads it.
  if (c.env.STAGING === "true" && c.env.NETWORK !== "base" && c.req.header("x-test-caller")) ip = `test:${c.req.header("x-test-caller")}`;
  // One IPv6 connection usually controls a whole /64 block, so count the block, not each address in it.
  if (ip && ip.includes(":")) ip = ipv6Prefix64(ip);
  const day = new Date().toISOString().slice(0, 10);
  return ip ? (await sha256Hex(`${c.env.SIGNING_KEY || "demo"}|${day}|${ip}`)).slice(0, 20) : undefined;
}

/** Runs every committed reviewer in parallel, so no reviewer sees another's verdict. All are waited for before the
 * caller gives the slots back. */
function runReviewers(c: any, commitment: any, input: any, lease: SlotLease, budgetMs: number) {
  const fake = fakeAiConfig(c.env, { mix: c.req.header("x-test-fake-mix"), delay: c.req.header("x-test-fake-delay") });
  const keys = { ANTHROPIC_API_KEY: c.env.ANTHROPIC_API_KEY, OPENROUTER_API_KEY: c.env.OPENROUTER_API_KEY, fake };
  return Promise.allSettled(
    commitment.models.map((m: string, i: number) => runOneReviewer(keys, m, i + 1, input, undefined, { budgetMs, observe: (o) => lease.observe(i, o) })),
  );
}

async function handleReview(c: any, tier: ReviewTier) {
  // reviewGuard (before the paywall) already checked the input, drew the panel and took the reviewer slots.
  const g = c.get("review") as
    | { tier: ReviewTier; input: any; commitment: any; t0: number; lease?: SlotLease; caller?: string; failLimit?: number; reservation?: string; recorded?: boolean }
    | undefined;
  if (!g || g.tier !== tier) return err(503, "Sealed review is temporarily unavailable. Nothing was charged.");
  const failLimit = g.failLimit ?? 10;
  if (!g.lease) {
    // Rare by design: the quick local check found this payment header implausible, yet the facilitator verified it.
    // Real clients shouldn't land here (if they do, the local check needs fixing, hence the log). Check the
    // allowance and take the slots now; any refusal is still >= 400, so nothing settles.
    console.warn(JSON.stringify({ late_admission: true, path: c.req.path, note: "verified payment failed the local plausibility check" }));
    const check = await failLimitCheck(c, g.caller, failLimit);
    if (check instanceof Response) return check;
    g.reservation = check?.token;
    const late = await acquireSlots(c.env, g.commitment.models, { leaseMs: REVIEWER_BUDGET_MS + 30_000, waitMs: GATE_MAX_WAIT_MS });
    if (!late.ok) {
      await releaseReservation(c, g.caller, failLimit, g.reservation);
      g.recorded = true;
      return busy(late.retryAfter, busyWhat(late.reason));
    }
    g.lease = late.lease;
  }
  const { input, commitment, caller } = g;
  const lease = g.lease;
  const started = Date.now();
  let settled: PromiseSettledResult<any>[];
  try {
    // What's left of the reviewers' budget, never past the payment authorization's own deadline.
    const budgetMs = reviewBudget({ budgetMs: REVIEWER_BUDGET_MS, elapsedMs: started - g.t0, header: c.req.header("x-payment") });
    if (budgetMs === null) return busy(10, "not enough time was left in this payment's window for a full review.");
    settled = await runReviewers(c, commitment, input, lease, budgetMs);
  } finally {
    await lease.release();
  }
  const record = async (what: "record" | "record_ok") => {
    g.recorded = true;
    if (caller && c.env.LEDGER) await ledgerJson(c.env, caller, "review-fails", { caller, limit: failLimit, [what]: true, release_token: g.reservation }).catch(() => {});
  };
  const failed = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) {
    const msg = String(failed.reason?.message ?? failed.reason);
    console.error(`review ${tier} failed after ${Date.now() - started}ms: ${msg.slice(0, 200)}`);
    // Returning an error means the payment never settles: a failed review costs the agent nothing.
    if (lease.capHit()) {
      // The provider's account limit isn't the caller's fault: don't count it against their allowance.
      await releaseReservation(c, caller, failLimit, g.reservation);
      g.recorded = true;
      return busy(600, "the AI provider's account limit was reached; reviews resume when it's lifted.");
    }
    await record("record");
    stat(c, "paid_failed");
    return err(502, `A reviewer didn't return a usable verdict (${msg.slice(0, 200)}). Nothing was charged; try again.`);
  }
  const votes = settled.map((r) => (r as PromiseFulfilledResult<any>).value);
  console.log(`review ${tier} ok in ${Date.now() - started}ms: ${votes.map((v) => `${v.model}=${v.verdict}`).join(" ")}`);
  await record("record_ok");
  stat(c, `paid_ok_${tier.replace("-", "")}`);
  const payload = await reviewPayload({
    tier,
    input,
    commitment,
    votes,
    payer: payerFromPaymentHeader(c.req.header("x-payment")),
    network: c.env.NETWORK,
    id: randomToken(12),
  });
  const receipt = await signReceipt(payload, c.env.SIGNING_KEY, c.env.PUBLIC_KEY);
  return c.json({
    review_id: payload.review_id,
    tier,
    result: payload.result,
    votes,
    receipt,
    note: "Save the receipt with the task and output: anyone holding all three can check the signature and that task_sha256 and output_sha256 match (sha256 of the exact UTF-8 text, no normalization). The service keeps no copy of the review; the receipt you hold is the only record. It is not a guarantee the output is correct.",
  });
}

app.post("/review", (c) => handleReview(c, "review"));
app.post("/review-3", (c) => handleReview(c, "review-3"));

// ---------- free sealed review (the operator pays; small daily allowance) ----------

/** Free reviews: a few per address per UTC day, inside one daily budget across everyone (counted at list price).
 * Off unless FREE_REVIEW_DAILY_BUDGET_USD is set above 0. */
function freeReviewConfig(env: Env, pool: "" | "ext" = "") {
  const usd = Number(String((pool ? env.EXT_FREE_DAILY_BUDGET_USD : env.FREE_REVIEW_DAILY_BUDGET_USD) ?? "").trim() || 0);
  const whole = (v: string | undefined, d: number) => {
    const n = Number(String(v ?? "").trim());
    return String(v ?? "").trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
  };
  return {
    budgetMicro: Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1_000_000) : 0,
    perCaller: (pool
      ? { review: whole(env.EXT_FREE_REVIEWS_PER_DAY, 3), "review-3": whole(env.EXT_FREE_REVIEW3_PER_DAY, 1) }
      : { review: whole(env.FREE_REVIEWS_PER_DAY, 3), "review-3": whole(env.FREE_REVIEW3_PER_DAY, 1) }) as Record<ReviewTier, number>,
  };
}

/** "3 single-reviewer and 1 review-3" for the landing page and llms.txt, or "" when free reviews are off. */
function freeReviewsLabel(env: Env) {
  const cfg = freeReviewConfig(env);
  return cfg.budgetMicro ? `${cfg.perCaller.review} single-reviewer and ${cfg.perCaller["review-3"]} review-3` : "";
}

/** What /reviewers, / and llms.txt say about free reviews. */
function freeReviewInfo(env: Env) {
  const cfg = freeReviewConfig(env);
  if (!cfg.budgetMicro) return { available: false };
  return {
    available: true,
    how: "POST /free/review or /free/review-3 with the same body as the paid routes. No wallet or payment.",
    per_address_per_day: cfg.perCaller,
    shared_daily_limit: "One daily budget covers everyone's free reviews; once it's used up, free reviews pause until 00:00 UTC.",
    receipts: 'Signed like paid ones, with "funding": "free" and no payer.',
    failures: "If a reviewer fails or the service is busy, your free review isn't used.",
  };
}

const FREE_PAID_HINT = "Paid reviews (POST /review or /review-3 with x402) have no daily allowance.";

/** ext: a review sent by the hosted MCP server (ChatGPT) on behalf of one of its users, with its own budget. */
async function handleFreeReview(c: any, tier: ReviewTier, ext?: { caller: string }) {
  const pool = ext ? "ext" : "";
  const p = ext ? "ext_" : "free_"; // usage-count prefix
  const t = tier.replace("-", "");
  const cfg = freeReviewConfig(c.env, pool);
  if (!cfg.budgetMicro || !cfg.perCaller[tier]) return err(503, `Free reviews aren't available right now. ${FREE_PAID_HINT}`);
  if (await paidPausedNow(c.env)) return err(503, PAUSED_MSG);
  if (await reviewsPausedNow(c.env)) return err(503, REVIEWS_PAUSED_MSG);
  const t0 = Date.now();
  const body = await c.req.json().catch(() => null);
  const v = validateReview(body, tier);
  if (!v.ok) {
    stat(c, `${p}bad_input`);
    return err(400, `${v.error} Your free review wasn't used.`);
  }
  let commitment;
  try {
    commitment = await reviewCommitment(tier, c.env, v.value.panel, undefined, v.value.task.length + v.value.output.length);
  } catch (e: any) {
    stat(c, `${p}bad_input`);
    return err(400, `${String(e?.message ?? e)} Your free review wasn't used.`);
  }
  if (missingReviewKey(c.env, commitment.models)) return err(503, "Sealed review is temporarily unavailable. Your free review wasn't used.");
  const caller = ext ? ext.caller : await callerHash(c);
  if (!caller || !c.env.LEDGER) return err(503, "Free reviews aren't available from here. " + FREE_PAID_HINT);
  // Quick capacity check first, so a full pool doesn't use anyone's allowance.
  const b = await quickBusy(c.env, commitment.models);
  if (b) {
    stat(c, `${p}busy`);
    return busy(b.retryAfter, "the AI reviewers are at capacity. Your free review wasn't used.");
  }

  let q: any;
  try {
    q = await ledgerJson(c.env, undefined, "free-review", { caller, tier, cost_micro: priceMicro(reviewPrices(c.env)[tier]), budget_micro: cfg.budgetMicro, per_caller: cfg.perCaller[tier], ...(pool ? { pool } : {}) }, true);
  } catch (e: any) {
    await recordEvent(c.env, "ledger_error", `free-review: ${String(e?.message ?? e)}`);
    return err(503, "Free reviews are temporarily unavailable (their limits can't be checked right now). Your free review wasn't used; try again in a minute.");
  }
  if (q.__status === 429) {
    stat(c, q.reason === "per_caller" ? `${p}refused_caller` : `${p}refused_budget`);
    const which = tier === "review-3" ? "review-3" : "single-reviewer";
    return err(
      429,
      q.reason === "per_caller"
        ? `You've used today's free ${which} reviews (${q.limit} per day ${ext ? "per user" : "from one address"}). They reset at 00:00 UTC. ${FREE_PAID_HINT}`
        : `Today's free reviews are used up for everyone. They reset at 00:00 UTC. ${FREE_PAID_HINT}`,
    );
  }
  const token: string = q.token;
  // Give the person's review back. refundBudget only when no reviewer was called, so nothing can have been spent.
  let released = false;
  const release = async (refundBudget: boolean) => {
    if (released) return;
    released = true;
    // Tried twice: a give-back that never lands would cost the person a review they didn't get.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await ledgerJson(c.env, undefined, "free-review", { release_token: token, refund_budget: refundBudget });
        return;
      } catch (e: any) {
        if (attempt === 2) await recordEvent(c.env, "ledger_error", `free-review release: ${String(e?.message ?? e)}`);
      }
    }
  };

  let settled: PromiseSettledResult<any>[];
  let lease: SlotLease;
  const input = v.value;
  const started = Date.now();
  let called = false; // set once any reviewer may have been called (and cost money)
  try {
    const slots = await acquireSlots(c.env, commitment.models, { leaseMs: REVIEWER_BUDGET_MS + 30_000, waitMs: GATE_MAX_WAIT_MS });
    if (!slots.ok) {
      await release(true);
      stat(c, `${p}busy`);
      return busy(slots.retryAfter, `${busyWhat(slots.reason)} Your free review wasn't used.`);
    }
    lease = slots.lease;
    try {
      // The same time budget as a paid review (there's no payment window to respect here).
      const budgetMs = reviewBudget({ budgetMs: REVIEWER_BUDGET_MS, elapsedMs: started - t0 });
      if (budgetMs === null) {
        await release(true);
        return busy(10, "not enough time was left for a full review. Your free review wasn't used.");
      }
      called = true;
      settled = await runReviewers(c, commitment, input, lease, budgetMs);
    } finally {
      await lease.release();
    }
  } catch (e: any) {
    // Anything unexpected after the reservation: the person keeps their review. The budget is refunded only if
    // no reviewer was called yet.
    await release(!called);
    throw e;
  }
  const failed = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) {
    const msg = String(failed.reason?.message ?? failed.reason);
    console.error(`free review ${tier} failed after ${Date.now() - started}ms: ${msg.slice(0, 200)}`);
    // The person gets their review back. The budget is refunded only when a provider's account limit stopped a
    // single-reviewer review (the provider refused, so nothing was spent). In a review-3 the other reviewers may
    // already have answered and cost money, so the budget keeps the reservation.
    await release(lease.capHit() && commitment.models.length === 1);
    stat(c, `${p}failed`);
    if (lease.capHit()) return busy(600, "the AI provider's account limit was reached; reviews resume when it's lifted. Your free review wasn't used.");
    return err(502, `A reviewer didn't return a usable verdict (${msg.slice(0, 200)}). Your free review wasn't used; try again.`);
  }
  const votes = settled.map((r) => (r as PromiseFulfilledResult<any>).value);
  stat(c, `${p}ok_${t}`);
  console.log(`free review ${tier} ok in ${Date.now() - started}ms: ${votes.map((x) => `${x.model}=${x.verdict}`).join(" ")}`);
  const payload = await reviewPayload({ tier, input, commitment, votes, network: c.env.NETWORK, id: randomToken(12), funding: "free" });
  const receipt = await signReceipt(payload, c.env.SIGNING_KEY, c.env.PUBLIC_KEY);
  return c.json({
    review_id: payload.review_id,
    tier,
    result: payload.result,
    votes,
    receipt,
    free: { used_today: q.used, per_day: q.limit, left_today: Math.max(0, q.limit - q.used) },
    note: "A free review (the receipt says funding: free). Save the receipt with the task and output: anyone holding all three can check the signature and that task_sha256 and output_sha256 match. The service keeps no copy of the review; the receipt you hold is the only record. It is not a guarantee the output is correct.",
  });
}

app.post("/free/review", (c) => handleFreeReview(c, "review"));
app.post("/free/review-3", (c) => handleFreeReview(c, "review-3"));

// ---------- internal: free reviews sent by the hosted MCP server (ChatGPT) ----------
// Every ChatGPT request comes from OpenAI's addresses, so the hosted server passes its own anonymous id for the
// person (ChatGPT's "openai/subject") in x-caller-id, proven by the shared INTERNAL_TOKEN secret. Its reviews use a
// separate budget (EXT_FREE_DAILY_BUDGET_USD) and allowance. 404 unless INTERNAL_TOKEN is set.

async function internalOk(env: Env, header: string | undefined): Promise<boolean> {
  const want = env.INTERNAL_TOKEN?.trim();
  if (!want || want.length < 32 || !header) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(header.trim())), crypto.subtle.digest("SHA-256", enc.encode(want))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** The hosted server's id for one of its users, as a daily-salted one-way hash (like callerHash for IPs). Users
 * without an id share one allowance. */
async function extCallerHash(c: any): Promise<string> {
  const raw = String(c.req.header("x-caller-id") ?? "").trim();
  const id = /^[\x20-\x7e]{1,200}$/.test(raw) ? raw : "anonymous";
  const day = new Date().toISOString().slice(0, 10);
  return `ext:${(await sha256Hex(`${c.env.SIGNING_KEY || "demo"}|${day}|ext|${id}`)).slice(0, 20)}`;
}

async function handleInternalFree(c: any, tier: ReviewTier) {
  if (!c.env.INTERNAL_TOKEN) return err(404, "Not found. GET / for how to use this service.");
  if (!(await internalOk(c.env, c.req.header("x-internal-auth")))) return err(401, "Wrong or missing internal token.");
  return handleFreeReview(c, tier, { caller: await extCallerHash(c) });
}

app.post("/internal/free/review", (c) => handleInternalFree(c, "review"));
app.post("/internal/free/review-3", (c) => handleInternalFree(c, "review-3"));

// What a review will use, published so an agent can check before paying (free).
app.get("/reviewers", async (c) => {
  const rp = reviewPrices(c.env);
  return c.json({
    tiers: {
      review: { price: rp.review, ...(await reviewCommitment("review", c.env)) },
      "review-3": { price: rp["review-3"], ...(await reviewCommitment("review-3", c.env)) },
    },
    how: `POST /review or /review-3 (x402 paid, one agent) with {task, output, title?, criteria?}. Returns result, votes and a signed receipt. If a reviewer fails, the request fails and nothing is charged.`,
    free: freeReviewInfo(c.env),
    verdicts: REVIEW_VERDICTS,
    model_pool: modelPool(c.env),
    opt_in_models: optInModels(c.env),
    opt_in_note: OPT_IN_NOTE,
    choosing_the_reviewers: PANEL_CHOICE_HELP.replace("on POST /matches (judge-2, judge-3)", "in the review request (review: 1 model, review-3: 3)").replace(/; judge-3 only: .*? majority\./, "."),
    how_votes_combine: "review: the single reviewer's verdict. review-3: a verdict with 2 or more of the 3 votes wins, and cannot_assess counts as a vote like any other (pass+pass+cannot_assess = pass; pass+cannot_assess+cannot_assess = cannot_assess; pass+fail+cannot_assess = split). Otherwise the result is split. Reviewers run in parallel and never see each other's verdicts.",
    writing_the_task: "task is what the work was supposed to do: the instructions or spec the agent was given, with its requirements (for example \"Write a function that retries a request up to 4 times, waiting 1-8 s between tries, and never runs longer than 240 s\"). It is not a message to the reviewers. Phrased as \"check this output for X\", a reviewer may judge whether the output IS a check for X, and fail it. Put any claims you want verified into the task as requirements.",
    what_a_receipt_proves: "That these models gave these verdicts about this exact task and output. The paying agent chose both the task and the output, so a receiver should check the task is the one it actually asked for. A review is one sample (re-running can differ), reviewers see only the text (no tools, web or code execution), and it is not a guarantee of correctness.",
    hashing: "task_sha256 and output_sha256 are sha256 of the exact UTF-8 text sent, with no trimming or normalization. Inputs over the limits are refused, never truncated.",
    timeouts: "Each reviewer call is limited to 100 seconds. If an AI provider is busy or returns an error, the call waits a few seconds and is tried again (up to 4 tries; a call that hangs or gives an unusable answer gets 2), and all tries end within about 240 seconds (no new try starts with less than 15 seconds left), so every review finishes or fails inside the 300-second payment authorization. Reviews usually take seconds; set your HTTP client timeout to at least 300 seconds so you never cut off a review you've paid for.",
    failed_review_limit: "Failed reviews aren't charged. Each IP address (each /64 block for IPv6) starts the day with 10 allowed failures, plus one more for each successful review that day, so a paying user isn't locked out by a bad provider hour. If failed reviews across everyone pass a daily ceiling, addresses with no successful review that day must wait until 00:00 UTC.",
    if_your_connection_drops: "If your connection drops after a review completed and you were charged, email hello@agentreferee.ai with the transaction hash and the review will be re-run free. (A review that never completes is never charged.)",
    split: "split means no verdict got a majority (review-3 only): the panel disagreed. If you need a single answer, treat it like cannot_assess and read each vote's issues. Re-running is a fresh sample, not a fix.",
    decoding: "Model weights and sampling are controlled by each AI provider and are not pinned. Everything the service controls (the prompt, the decision rule, the panel's models and structure) is pinned and recorded in the receipt.",
    limits_criteria: "Up to 8 criteria, names up to 60 characters, whole-number weights 1-100. Title up to 200 characters.",
    limits: REVIEW_LIMITS,
    long_inputs: { ...longReviewRule(c.env), rule: "When task + output is longer than max_chars_for_light_models, \"rotate\" leaves the light models out, and a request naming one is refused before payment." },
    fingerprint_formula: "sha256_hex(format_version + \"\\n\" + system_prompt + \"\\n\" + message_format)",
    system_prompt: REVIEW_SYSTEM,
    message_format: REVIEW_MESSAGE_FORMAT,
    privacy: "The task and output are sent to the AI companies running the reviewers (Anthropic; Google and OpenAI through OpenRouter for review-3). The receipt holds only their SHA-256 hashes, but reviewers' issues and reasoning may quote the output. Nothing is stored by the service.",
  });
});

// Current signing key plus every retired key, so old receipts stay verifiable forever.
app.get("/pubkey", async (c) => {
  let history: { public_key: string; retired?: string }[] = [];
  try {
    const parsed = JSON.parse(c.env.PUBLIC_KEY_HISTORY || "[]");
    if (Array.isArray(parsed)) history = parsed.filter((h) => h && typeof h.public_key === "string");
  } catch {}
  return c.json({
    algorithm: "Ed25519",
    public_key: c.env.PUBLIC_KEY ?? null,
    key_id: c.env.PUBLIC_KEY ? await keyId(c.env.PUBLIC_KEY) : null,
    signs: "canonical JSON (sorted keys) of receipt.payload",
    history: await Promise.all(history.map(async (h) => ({ ...h, key_id: await keyId(h.public_key) }))),
    note: "A receipt is valid if its signature checks out against the current key or any key in history.",
  });
});

// ---------- matches ----------

app.post("/matches", async (c) => {
  const input: any = await c.req.json().catch(() => null);
  if (isJudgeTier(input?.tier) && missingJudgeKey(c.env, tierModels(c.env, input.tier as JudgeTierName)))
    return err(503, "This judge tier is temporarily unavailable.");
  const demo = input?.demo === true;
  if (!demo && paidPaused(c.env)) return err(503, PAUSED_MSG);
  // Free demo matches are capped per day so they can't crowd out paid ones.
  if (demo && c.env.LEDGER) {
    const limit = Number(c.env.DEMO_DAILY_LIMIT || 2000);
    const per_caller = Number(c.env.DEMO_PER_IP_LIMIT || 20);
    // One-way, salted with a server secret and today's date, so it can't be turned back into an IP
    // and can't link the same caller across days.
    const caller = await callerHash(c);
    try {
      const q = await ledgerJson(c.env, caller, "demo-quota", { limit: caller ? shardLimit(String(limit), 2000) : limit, per_caller, caller }, true);
      if (q.__status === 429) return err(429, q.error);
    } catch (e: any) {
      await recordEvent(c.env, "ledger_error", `demo-quota: ${String(e?.message ?? e)}`);
      return err(503, "Demo matches are temporarily unavailable (their daily limit can't be checked right now). Try again in a minute.");
    }
  }
  // With a shared key, both agents compute the same match id, so nobody has to pass an id around.
  const id = typeof input?.key === "string" && KEY_RE.test(input.key) ? await idForKey(input.key, demo) : randomToken(12);
  const res = await forward(c.env, id, "create", { id, input });
  if (res.status !== 201 || !input?.host_pays) return res;
  // Invite match: hand the creator a link to send the other agent. It's shown only here, once.
  const created: any = await res.json();
  const base = new URL(c.req.url).origin;
  const t = created.invite.invite_token;
  created.invite = {
    ...created.invite,
    // Always the original address, which every published client accepts, whichever address this request came in on.
    url: `${INVITE_BASE}/invite/${id}?token=${t}`,
    how: `Send url to the other agent. It joins free: POST ${base}/invite/join {"match_id":"${id}","invite_token":"<token>"} (or with the client: ref.acceptInvite(url)). You pay for both seats at ${base}${demo ? "/demo" : ""}/host/join/${created.tier}, charged only once the guest has joined. Anyone holding this token can take the guest seat, so send it only to the agent you mean.`,
  };
  return c.json(created, 201);
});

// ---------- invites (one agent pays for both seats) ----------

// What the invited agent sees when it opens the link: the match settings, who pays, and how to accept.
app.get("/invite/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return err(400, "Bad match id.");
  const res = await forward(c.env, id, "status");
  if (!res.ok) return res;
  const m: any = await res.json();
  if (!m.host_pays) return err(400, "This match isn't an invite match.");
  const base = new URL(c.req.url).origin;
  const guest = m.seats.map((s: any) => s.seat).find((s: string) => s !== m.host_pays);
  return c.json({
    invite: `You're invited to an Agent Referee match as seat "${guest}". The other agent ("${m.host_pays}") pays for both seats, so joining is free.`,
    accept: `POST ${base}/invite/join {"match_id":"${id}","invite_token":"<the token in your link>"}, or with the client: ref.acceptInvite("<your link>").`,
    check_first: "Read the settings below (tier, odds, rules, judge models) before accepting: they're what both of you are bound by, and they're in the signed receipt.",
    docs: "https://github.com/ccheez34/agent-referee-client",
    match: m,
  });
});

app.post("/invite/join", async (c) => {
  const body: any = await c.req.json().catch(() => null);
  if (!body || typeof body.match_id !== "string" || !ID_RE.test(body.match_id)) return err(400, "match_id is required.");
  if (typeof body.invite_token !== "string" || body.invite_token.length > 200) return err(400, "invite_token is required.");
  return forward(c.env, body.match_id, "join", { role: "guest", invite_token: body.invite_token, seat: body.seat });
});

app.get("/matches/:id", (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return err(400, "Bad match id.");
  return forward(c.env, id, "status");
});

// Paid but never got the seat_token (connection dropped, crash after payment)? Present the exact
// X-PAYMENT header value you paid with, and the seat is re-issued with a fresh token. No new charge.
app.post("/matches/:id/recover", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return err(400, "Bad match id.");
  const body: any = await c.req.json().catch(() => null);
  if (!body || typeof body.payment !== "string" || body.payment.length < 20 || body.payment.length > 20000)
    return err(400, "payment must be the exact X-PAYMENT header value you sent when joining.");
  return forward(c.env, id, "recover", { payment_hash: await sha256Hex(body.payment) });
});

for (const action of ["commit", "reveal", "submit", "retry-judge", "rematch"]) {
  app.post(`/matches/:id/${action}`, async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return err(400, "Bad match id.");
    return forward(c.env, id, action, await c.req.json().catch(() => ({})));
  });
}

// ---------- joining (paid via the middleware above) ----------

// `paid`: this seat normally costs money. `demo`: the free demo route for that seat (no payment, demo matches only).
function joinRoute(path: string, tier: Tier, role: "party" | "mediator" | "host", paid: boolean, demo = false) {
  app.post(path, async (c) => {
    const body: any = await c.req.json().catch(() => null);
    if (!body || typeof body.match_id !== "string" || !ID_RE.test(body.match_id)) return err(400, "match_id is required.");
    const seat = role === "mediator" ? MEDIATOR : body.seat;
    if (typeof seat !== "string") return err(400, "seat is required.");
    // Never take payment for the judge tier if the judge can't run. Error status = no charge.
    if (isJudgeTier(tier) && missingJudgeKey(c.env, tierModels(c.env, tier as JudgeTierName))) return err(503, "This judge tier is temporarily unavailable.");
    const paymentsOn = c.env.PAYMENTS_ENABLED !== "false";
    const charged = paid && !demo;
    // The paywall has already verified this payment, so the paying wallet is genuine.
    const payer = charged ? payerFromPaymentHeader(c.req.header("X-PAYMENT")) : undefined;
    const paymentHeader = charged ? c.req.header("X-PAYMENT") : undefined;
    const res = await forward(c.env, body.match_id, "join", {
      // Lets an agent that paid but lost its seat_token recover the seat later (POST /matches/<id>/recover).
      payment_hash: paymentHeader ? await sha256Hex(paymentHeader) : undefined,
      seat,
      tier,
      role,
      paid: charged && paymentsOn,
      payments_enabled: paymentsOn && !demo,
      demo,
      // seats that are normally paid wait for the table to fill, so no-shows cost nobody anything (demo seats behave the same)
      wait: paid && (demo || paymentsOn),
      payer,
    });
    // Record privacy rides on a paid join, so only the wallet's owner can change it.
    if (res.ok && payer && typeof body.private_record === "boolean" && c.env.LEDGER) {
      await ledgerCall(c.env, "privacy", { wallet: payer, private: body.private_record }).catch(() => {});
    }
    return res;
  });
}

joinRoute("/join/rps", "rps", "party", true);
joinRoute("/join/rps-bo3", "rps-bo3", "party", true);
joinRoute("/join/weighted", "weighted", "party", true);
joinRoute("/join/judge", "judge", "party", true);
joinRoute("/join/judge-2", "judge-2", "party", true);
joinRoute("/join/judge-3", "judge-3", "party", true);
joinRoute("/join/draw/mediator", "draw", "mediator", true);
joinRoute("/join/draw/party", "draw", "party", false);

// Free demo routes: the same protocol with no payment, for demo matches only (created with "demo": true).
// Outside /join/*, so the paywall never sees them. Receipts and acks are marked demo and nothing is recorded.
joinRoute("/demo/join/rps", "rps", "party", true, true);
joinRoute("/demo/join/rps-bo3", "rps-bo3", "party", true, true);
joinRoute("/demo/join/weighted", "weighted", "party", true, true);
joinRoute("/demo/join/draw/mediator", "draw", "mediator", true, true);
joinRoute("/demo/join/draw/party", "draw", "party", false, true);

// Invite matches: the host's seat pays for both (paid routes above; free demo versions for demo matches).
for (const t of INVITE_TIERS) joinRoute(`/host/join/${t}`, t, "host", true);
for (const t of ["rps", "rps-bo3", "weighted"] as const) joinRoute(`/demo/host/join/${t}`, t, "host", true, true);

// ---------- agent records (free to read) ----------

function ledgerCall(env: Env, action: string, body?: unknown, query = "") {
  const stub = env.LEDGER!.get(env.LEDGER!.idFromName("global"));
  return stub
    .fetch(`https://ledger/${action}${query}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    .then((r) => new Response(r.body, { status: r.status, headers: new Headers(r.headers) }));
}

/** Per-caller daily counters live in 16 ledger shards picked by the caller hash, so no single object takes every call. */
function ledgerShard(env: Env, caller?: string) {
  return env.LEDGER!.get(env.LEDGER!.idFromName(ledgerShardName(caller)));
}

/** A ledger counter call that fails closed: throws on any error, 5xx or unreadable answer (allow429: a 429 is an answer). */
async function ledgerJson(env: Env, caller: string | undefined, action: string, body: unknown, allow429 = false): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      ledgerShard(env, caller).fetch(`https://ledger/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("ledger timed out")), 10_000))),
    ]);
    if (!res.ok && !(allow429 && res.status === 429)) throw new Error(`ledger answered ${res.status}`);
    const data: any = await res.json();
    if (!data || typeof data !== "object") throw new Error("ledger answer unreadable");
    return { ...data, __status: res.status };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

app.get("/agents/:wallet", async (c) => {
  const wallet = c.req.param("wallet").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) return err(400, "Give a 0x wallet address.");
  if (!c.env.LEDGER) return err(503, "Records are not enabled.");
  // Label the operator's own wallets, so their self-play records can't be mistaken for outside use.
  const operator = (c.env.OPERATOR_TEST_WALLETS || "0x28275fa8fe39996501e160104a23e1af5e005f58").toLowerCase().split(",").map((s: string) => s.trim());
  if (!operator.includes(wallet)) return ledgerCall(c.env, "agent", undefined, `?wallet=${wallet}`);
  const r = await ledgerCall(c.env, "agent", undefined, `?wallet=${wallet}`);
  const body: any = await r.json().catch(() => ({}));
  return c.json({ ...body, operator_test_wallet: true, note: "This is the operator's own test wallet. Its matches are self-play used to test the service, not outside usage." }, r.status as any);
});

app.notFound((c) => err(404, "Not found. GET / for how to use this service."));

export default app;
