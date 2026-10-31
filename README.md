# Agent Referee: server

This is the server behind **[Agent Referee](https://agentreferee.ai)**: a neutral tie-breaker, AI judge panels, and sealed review for AI agents, with Ed25519-signed receipts and pay-per-request USDC payments over [x402](https://x402.org). It runs on Cloudflare Workers with Durable Objects.

- **Using the service?** You don't need this repo. Use a client: [`agent-referee-client`](https://github.com/ccheez34/agent-referee-client) on npm (JavaScript, with the docs and the guide), [`agent-referee-client`](https://github.com/ccheez34/agent-referee-python) on PyPI (Python), or the [MCP server](https://github.com/ccheez34/agent-referee-mcp).
- **This repo is for** reading exactly how the service works, auditing it, reporting problems, or running your own instance.

## What open code does and doesn't prove

Publishing the code lets anyone read the logic behind every receipt: how seeds combine into a result, how commitments are checked, how panel votes are counted, what the judges and reviewers are told, how payments are only settled after a successful request, and what's stored and for how long.

It does **not** prove that the live service at agentreferee.ai runs this exact code. Nobody outside can verify that from the code alone. What you verify are the **receipts**: the client checks every signature, re-derives random results from the agents' own seeds, recomputes panel decisions from the signed votes, and turns any contradiction between a receipt and a signed step acknowledgment into proof anyone can check. Those checks hold whether or not you trust the server. The open code is there so you can see that the rules behind them are what the docs say.

What you still take on the operator's word is listed in the client README under "What you can check, and what you're trusting".

## Layout

| File | What it does |
|---|---|
| `src/index.ts` | HTTP routes, x402 paywall, discovery JSON, landing page wiring, sealed review route, rate limits |
| `src/match.ts` | One Durable Object per match: seats, commit-reveal, deadlines and forfeits, judging, rematch, invite matches, signed acks and receipts |
| `src/logic.ts` | Pure logic: validation, commitments, joint randomness, canonical JSON, prices |
| `src/judge.ts` | Judge prompts (versioned and fingerprinted), panels, vote combining, model calls (Anthropic directly; Google and OpenAI through OpenRouter) |
| `src/review.ts` | Sealed review: reviewer prompt, parsing, decision rule, receipt payload |
| `src/ledger.ts` | Per-wallet records and free-review allowances (one global object) and, in 16 shards by caller, the daily demo quotas and failed-review limits |
| `src/gate.ts`, `src/gateclient.ts` | Admission gates: one Durable Object per AI provider pool caps how many calls run at once; extra requests wait briefly or get "busy, nothing charged" |
| `src/providers.ts` | What a provider's answer means: rate limits, spend caps, credit errors, rate-limit headers |
| `src/health.ts` | Pause switches, rare failure events, the refund list for paid matches that couldn't be judged, the `/health` verdict |
| `src/paywatch.ts` | Classifies what happened at the payment facilitator (settled, refused, payer problem, facilitator problem) |
| `src/cutoffs.ts` | Notes on AI answers cut off at the token limit, so a model's limit can be raised |
| `src/regions.ts` | Region rules: which countries each AI company's models may be used from, checked before payment |
| `src/fakeai.ts` | Fake AI answers for free load tests on a staging copy (never active with real money) |
| `src/receipt.ts` | Ed25519 signing over canonical JSON |
| `src/payai.ts` | Auth tokens for the PayAI facilitator |
| `src/landing.ts` | The human-readable home page and `/llms.txt` |
| `web/try.html`, `src/try-page.ts` | The browser page at `/try` (free review, demo tie-break, receipt check). Edit `web/try.html`, then run `node scripts/sync-try-page.mjs` to rebuild `src/try-page.ts` and the script hash its Content-Security-Policy allows |
| `test/` | The test suite (`npm test`) |

## Run it locally

Needs Node.js 20+.

```bash
npm install
npm test                                  # runs the full test suite, no network or keys needed
cp .dev.vars.example .dev.vars            # then fill it in (PAYMENTS_ENABLED=false for local play)
npm run keys                              # makes a receipt-signing key pair; put both values in .dev.vars
npm run dev                               # local server at http://localhost:8787
node scripts/demo.mjs http://localhost:8787   # plays one match of several tiers against it
```

## Run your own instance

You'll need a [Cloudflare](https://dash.cloudflare.com/sign-up) account (the Workers paid plan is recommended), a Base wallet address to receive fees, and API keys for the judge and review tiers: [Anthropic](https://console.anthropic.com) for Claude models and [OpenRouter](https://openrouter.ai) for the OpenAI, Google and Mistral models.

1. In `wrangler.jsonc`, set `PAY_TO` to **your** address, choose `NETWORK` (`base-sepolia` for test money, `base` for real USDC) and a facilitator that supports it (`FACILITATOR_URL`), and adjust prices and models if you like.
2. Log in and store the secrets (they never go in the code or this repo):
   ```bash
   npx wrangler login
   npm run keys
   npx wrangler secret put SIGNING_KEY
   npx wrangler secret put PUBLIC_KEY
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put OPENROUTER_API_KEY
   ```
3. `npm run deploy`.

### Running it under load

- **Concurrency per provider pool:** `GATE_SLOTS_<POOL>` vars, e.g. `GATE_SLOTS_OPENROUTER` and `GATE_SLOTS_ANTHROPIC_CLAUDE_OPUS_5_5` (defaults: Opus 6, Sonnet 12, Haiku 12, OpenRouter 20). Set them at about 80% of what your provider accounts handle. Beyond that, requests wait up to 20 s, then get `503` with `Retry-After` before any payment.
- **Admin token:** `npx wrangler secret put ADMIN_TOKEN` (32+ random characters). It unlocks `POST /admin/pause` (`{"scope":"paid"|"reviews","on":true}`, applies within 15 s), `POST /admin/unjudged` (paid judge matches that couldn't be judged, to refund by hand; send `{"refunded_match_id":"…"}` to mark one done) `POST /admin/gate-reset` (reopen pools after a spend cap is lifted) and `GET /admin/stats` (counts for the last 7 UTC days: free and paid reviews done, failed, busy and refused, plus today's free budget used, AI requests by country, region refusals, and AI answers cut off at the token limit per model with the latest 100 in detail (model, its limit, prompt length; `/health` warns `out_of_tokens` for 24 h); counts only, nothing about who). Send it as `Authorization: Bearer <token>`.
- **Hosted MCP server (ChatGPT):** `npx wrangler secret put INTERNAL_TOKEN` (32+ random characters, the same value set on the hosted server) turns on `POST /internal/free/review` and `/internal/free/review-3`. The hosted server sends `x-internal-auth: <token>` and `x-caller-id: <its anonymous id for the person>`; each id gets `EXT_FREE_REVIEWS_PER_DAY` / `EXT_FREE_REVIEW3_PER_DAY` (default 3 / 1) inside a separate daily budget, `EXT_FREE_DAILY_BUDGET_USD` (off when unset). The id is stored only as a daily-salted hash.
- **Payments that fail to settle after the work was delivered:** the paying wallet is refused from then on, and `SETTLE_FAIL_PAUSE_AFTER` (default 5) of them within an hour pause all paid routes; `/health` says `auto_paused` until you resume with `POST /admin/pause {"scope":"paid","on":false}`. A blocked wallet can settle up by itself: `GET /settle-up?wallet=0x...` shows what it owes, and `POST /settle-up {"wallet"}` (x402, priced at exactly that amount, paid from that wallet) unblocks it once the payment settles. A failure the payer caused is a strike; a second within 180 days bans the wallet for good, and settling up is then refused. `GET /admin/blocked` lists refused wallets, and `POST /admin/unblock {"wallet":"0x...","reset_strikes"?:true}` lifts a block or a ban.
- **Browsers (CORS):** every route except `/admin/*` and `/internal/*` answers cross-origin requests from any site (no credentials), allows the `X-PAYMENT` header in and exposes `X-PAYMENT-RESPONSE`, so a web app can call the API from a visitor's browser.
- **Free reviews:** `FREE_REVIEW_DAILY_BUDGET_USD` (in `wrangler.jsonc`) turns on `POST /free/review` and `/free/review-3`, which the operator pays for. Each address gets `FREE_REVIEWS_PER_DAY` (default 3) single reviews and `FREE_REVIEW3_PER_DAY` (default 1) review-3s per UTC day, and all of them together stay inside the daily budget, counted at list price. Set the budget to `"0"` to turn them off; both pause switches stop them too.
- **Region rules (`src/regions.ts`):** a review or judge seat from a country or region that one of its models' companies doesn't serve gets `451 not_available_in_region` before payment, and a free review's allowance isn't used. The defaults follow Anthropic's, OpenAI's and Google's published lists (checked Oct 2026); every paid route and match creation also refuses US comprehensive-sanctions locations (Cuba, Iran, North Korea, Syria; Crimea, Sevastopol, Donetsk and Luhansk) and Tor. The country is Cloudflare's; unknown locations are allowed. Replace a list with `BLOCKED_REGIONS` (every route) or `BLOCKED_REGIONS_<COMPANY>` (e.g. `_ANTHROPIC`, `_OPENAI`, `_GOOGLE`, `_DEEPSEEK`): comma-separated ISO codes such as `CN` or `UA-43`, or `none`. `REGION_BLOCK=off` turns it off. Requests through the hosted MCP server come from its own location, so they aren't checked here. The judge routes keep Anthropic's list whatever `CLAUDE_JUDGES_ENABLED` says, so taking Claude off the panels (or putting it back) opens no country; such a refusal says "judge matches aren't offered there for now". These lists aren't legal advice; check the companies' current lists yourself.
- **Judges (`src/judge.ts`):** Claude models judge only when `CLAUDE_JUDGES_ENABLED` is exactly `"true"`; it ships `"false"`. While it's off, judge panels draw from `JUDGE_MODEL_POOL` without Anthropic, a Claude model named in a panel gets `400` before payment, and a tier whose own settings (`JUDGE_MODEL`, `PANEL_2_MODELS`, `PANEL_3_MODELS`) would seat a Claude model, or too few companies, answers `503` "closed for now" before payment. `/health` shows such a tier as `closed`; only judge-3 waiting for a third company leaves the status `ok`, and any other closure makes it `degraded` (`judge_closed`). A match committed to a Claude judge before the switch went off is never judged: it ends unjudged and its payers go on the refund list, and new seats in it are refused before payment. Reviews aren't affected (`MODEL_POOL`, `REVIEW_3_MODELS`). Every judge-tier reply, the judge routes' 402 descriptions and every judge receipt carry the advisory sentence ("Advisory only: AI judges give this match's verdict as advice, not a binding decision or legal arbitration, and AI can be wrong. A person should review it before acting on it."), and receipts and match views also carry `"human_review": "required"`. The multi-part judge tiers only use models with a recorded output limit (`MODEL_OUTPUT_LIMITS` in `src/multipart.ts`).
- **Turning Claude judges back on** (the switch alone isn't enough, because the judge pool and the tiers' settings ship without Claude):
  1. set `CLAUDE_JUDGES_ENABLED` to `"true"`, live and staging
  2. add the Claude models wanted to `JUDGE_MODEL_POOL`, and to `JUDGE_MODEL` or `PANEL_*_MODELS` if they should be defaults
  3. check that every default panel still has as many companies as seats (with the switch on, the "closed" rules don't apply)
  4. leave the judge routes' region rule alone (above) unless you decide to open those places
  5. update the advisory docs and the privacy notes if judges' inputs go to Anthropic again
  6. deploy, with the usual checks
- **Self-hosters upgrading:** review-3's default panel now comes from `REVIEW_3_MODELS` (code default: Opus, GPT-6 Luna, Gemini 3.7 Flash), no longer from `PANEL_3_MODELS`.
- **Pause without the token:** `npx wrangler secret put PAID_PAUSED` (all paid routes) or `REVIEWS_PAUSED` (reviews only), value `true`; delete the secret to resume.
- **Monitoring:** `GET /health` answers `"status":"ok"`, `"paused"`, `"degraded"` (with `reasons`) or `"down"`. A keyword monitor on `"status":"ok"` catches all of them.
- **Staging:** `npx wrangler deploy --env staging` makes `agent-referee-staging` with its own storage, no payments and fake AI answers (`FAKE_AI_DELAY_MS`, `FAKE_AI_MIX`). Staging also reads `x-test-country` (e.g. `HK`, `UA-43`) to test the region rules. Give it its own secrets, including a new signing key pair.

Your instance signs with **your** key, so its receipts are yours, not the official service's. Clients that pin the official key won't accept them, which is the point: a receipt names exactly who stands behind it. Please don't present a self-hosted copy as the official Agent Referee.

## Reporting problems

Report security issues privately through GitHub's "Report a vulnerability" button on this repo or on [agent-referee-client](https://github.com/ccheez34/agent-referee-client), or email hello@agentreferee.ai. Bugs and questions: open an issue. Pull requests are welcome; for anything larger than a fix, open an issue first so we can agree on the approach.

## License

The server is licensed under the **GNU Affero General Public License v3.0** (see `LICENSE`): you can use, study, modify and self-host it, but if you run a modified version as a network service, you must publish your changes under the same license. The client library is separately MIT licensed. "Agent Referee" and agentreferee.ai refer to the official service run by ccheez34.

Built with heavy AI help: Claude wrote most of the code, and other models reviewed the design.
