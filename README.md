# Agent Referee: server

This is the server behind **[Agent Referee](https://agentreferee.ai)**: a neutral tie-breaker, AI judge panels, and sealed review for AI agents, with Ed25519-signed receipts and pay-per-request USDC payments over [x402](https://x402.org). It runs on Cloudflare Workers with Durable Objects.

- **Using the service?** You don't need this repo. Use the client: [`agent-referee-client`](https://github.com/ccheez34/agent-referee-client) (npm and PyPI), which has the docs, the guide, and the receipt checks.
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
| `src/ledger.ts` | Per-wallet records (one global object) and, in 16 shards by caller, the daily demo quotas and failed-review limits |
| `src/gate.ts`, `src/gateclient.ts` | Admission gates: one Durable Object per AI provider pool caps how many calls run at once; extra requests wait briefly or get "busy, nothing charged" |
| `src/providers.ts` | What a provider's answer means: rate limits, spend caps, credit errors, rate-limit headers |
| `src/health.ts` | Pause switches, rare failure events, the refund list for paid matches that couldn't be judged, the `/health` verdict |
| `src/paywatch.ts` | Classifies what happened at the payment facilitator (settled, refused, payer problem, facilitator problem) |
| `src/fakeai.ts` | Fake AI answers for free load tests on a staging copy (never active with real money) |
| `src/receipt.ts` | Ed25519 signing over canonical JSON |
| `src/payai.ts` | Auth tokens for the PayAI facilitator |
| `src/landing.ts` | The human-readable home page and `/llms.txt` |
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

You'll need a [Cloudflare](https://dash.cloudflare.com/sign-up) account (the Workers paid plan is recommended), a Base wallet address to receive fees, and API keys for the judge and review tiers: [Anthropic](https://console.anthropic.com) for Claude models and [OpenRouter](https://openrouter.ai) for the Google and OpenAI panel models.

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
- **Admin token:** `npx wrangler secret put ADMIN_TOKEN` (32+ random characters). It unlocks `POST /admin/pause` (`{"scope":"paid"|"reviews","on":true}`, applies within 15 s), `POST /admin/unjudged` (paid judge matches that couldn't be judged, to refund by hand; send `{"refunded_match_id":"…"}` to mark one done) and `POST /admin/gate-reset` (reopen pools after a spend cap is lifted). Send it as `Authorization: Bearer <token>`.
- **Pause without the token:** `npx wrangler secret put PAID_PAUSED` (all paid routes) or `REVIEWS_PAUSED` (reviews only), value `true`; delete the secret to resume.
- **Monitoring:** `GET /health` answers `"status":"ok"`, `"paused"`, `"degraded"` (with `reasons`) or `"down"`. A keyword monitor on `"status":"ok"` catches all of them.
- **Staging:** `npx wrangler deploy --env staging` makes `agent-referee-staging` with its own storage, no payments and fake AI answers (`FAKE_AI_DELAY_MS`, `FAKE_AI_MIX`). Give it its own secrets, including a new signing key pair.

Your instance signs with **your** key, so its receipts are yours, not the official service's. Clients that pin the official key won't accept them, which is the point: a receipt names exactly who stands behind it. Please don't present a self-hosted copy as the official Agent Referee.

## Reporting problems

Report security issues privately through GitHub's "Report a vulnerability" button on this repo or on [agent-referee-client](https://github.com/ccheez34/agent-referee-client), or email hello@agentreferee.ai. Bugs and questions: open an issue. Pull requests are welcome; for anything larger than a fix, open an issue first so we can agree on the approach.

## License

The server is licensed under the **GNU Affero General Public License v3.0** (see `LICENSE`): you can use, study, modify and self-host it, but if you run a modified version as a network service, you must publish your changes under the same license. The client library is separately MIT licensed. "Agent Referee" and agentreferee.ai refer to the official service run by ccheez34.

Built with heavy AI help: Claude wrote most of the code, and other models reviewed the design.
