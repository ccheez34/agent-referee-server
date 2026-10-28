export interface Env {
  MATCHES: DurableObjectNamespace;
  LEDGER?: DurableObjectNamespace; // agent records, and (in 16 shards) the daily per-caller counters
  GATES?: DurableObjectNamespace; // admission gates, one per AI provider pool (gate.ts)
  HEALTH?: DurableObjectNamespace; // pause switches, rare failure events, the unjudged-refund list (health.ts)

  // vars (wrangler.jsonc)
  PAY_TO: string; // your receiving wallet address (0x...) on the chosen network
  NETWORK: string; // "base-sepolia" for testing, "base" for real money
  FACILITATOR_URL?: string; // defaults to https://x402.org/facilitator (testnet only)
  PAYMENTS_ENABLED?: string; // "false" turns the paywall off for local testing
  REVIEW_PARALLEL_PER_ADDRESS?: string; // reviews one address may run at once beyond its remaining failure allowance (default 20)
  // Free sealed reviews (the operator pays): off unless the daily budget (USD, counted at list price) is above 0.
  FREE_REVIEW_DAILY_BUDGET_USD?: string;
  FREE_REVIEWS_PER_DAY?: string; // free single-reviewer reviews per address per UTC day (default 3)
  FREE_REVIEW3_PER_DAY?: string; // free review-3 reviews per address per UTC day (default 1)
  INTERNAL_TOKEN?: string; // secret shared with the hosted MCP server (ChatGPT); enables /internal/free/*
  EXT_FREE_DAILY_BUDGET_USD?: string; // daily budget for free reviews sent by the hosted MCP server (off when unset)
  EXT_FREE_REVIEWS_PER_DAY?: string; // per hosted-server user per UTC day (default 3)
  EXT_FREE_REVIEW3_PER_DAY?: string; // per hosted-server user per UTC day (default 1)
  LONG_REVIEW_CHARS?: string; // task + output longer than this: light models (LIGHT_REVIEW_MODELS) sit out of reviews (default 6000)
  LIGHT_REVIEW_MODELS?: string; // comma list, default "claude-haiku-5-5"
  PAID_PAUSED?: string; // "true" refuses paid matches (before any payment) and points agents to demo mode
  REVIEWS_PAUSED?: string; // "true" refuses sealed reviews only (before any payment)
  SETTLE_FAIL_PAUSE_AFTER?: string; // payments failing to settle after delivered work, per hour, before paid routes pause (default 5)
  GATES_ENABLED?: string; // "false" turns the admission gates off (they're on whenever GATES is bound)
  // GATE_SLOTS_<POOL>: concurrent AI calls per pool, e.g. GATE_SLOTS_OPENROUTER=20, GATE_SLOTS_ANTHROPIC_CLAUDE_OPUS_5_5=6
  STAGING?: string; // "true" only on the staging Worker: allows FAKE_AI and the x-test-caller header (never with NETWORK=base)
  FAKE_AI?: string; // staging only: "true" answers every AI call with a fake (see fakeai.ts)
  FAKE_AI_DELAY_MS?: string; // staging only: e.g. "2000-30000"
  FAKE_AI_MIX?: string; // staging only: e.g. "429:0.1,500:0.05,cap:0.01,hang:0.05,cut:0.02"
  JUDGE_MODEL?: string;
  PRICE_RPS?: string; // price PER SEAT, e.g. "$0.01"
  PRICE_RPS_BO3?: string;
  PRICE_WEIGHTED?: string;
  PRICE_DRAW_MEDIATOR?: string; // the mediator pays the whole draw
  PRICE_JUDGE?: string;
  PRICE_JUDGE_2?: string; // per seat, 2-judge panel
  PRICE_JUDGE_3?: string; // per seat, 3-judge panel
  PRICE_REVIEW?: string; // sealed review, one reviewer (per review, default $0.05)
  PRICE_REVIEW_3?: string; // sealed review, three reviewers (per review, default $0.20)
  OPT_IN_MODELS?: string; // models agents may name but that are never drawn at random (default: judge.ts DEFAULT_OPT_IN_MODELS; "" turns them off)
  MODEL_POOL?: string; // models agents may choose for panels and reviews, comma separated (default: judge.ts DEFAULT_MODEL_POOL)
  REVIEW_MODEL?: string; // the single reviewer for "review" (default claude-sonnet-5-5)
  OPERATOR_TEST_WALLETS?: string; // comma separated; their records are labeled as the operator's self-play
  REVIEW_FAIL_GLOBAL_LIMIT?: string; // failed reviews per day across everyone before only proven payers continue (default 500)
  REVIEW_FAIL_LIMIT?: string; // failed (uncharged) reviews allowed per address per day (default 10)
  PANEL_MODELS?: string; // comma separated, panelist 1 first (default: JUDGE_MODEL, claude-sonnet-5-5, claude-opus-5-5)
  PANEL_2_MODELS?: string; // judge-2's own list (overrides PANEL_MODELS). "provider/model" ids go through OpenRouter
  PANEL_3_MODELS?: string; // judge-3's own list (overrides PANEL_MODELS)
  REVEAL_WINDOW_SECONDS?: string;
  JOIN_WAIT_SECONDS?: string; // how long a paid join waits for the other seats (default 15, max 60)
  DEMO_DAILY_LIMIT?: string; // free demo matches allowed per day (UTC), across everyone (default 2000)
  DEMO_PER_IP_LIMIT?: string; // free demo matches per day from one IP address (default 20; stored only as a daily salted hash)

  // secrets (wrangler secret put ...)
  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string; // needed when a panel uses a non-Claude model ("provider/model" id)
  PAYAI_API_KEY_ID?: string; // PayAI merchant key: needed once the facilitator's free settlements run out
  PAYAI_API_KEY_SECRET?: string; // base64 PKCS8 Ed25519 key, optionally prefixed payai_sk_
  ADMIN_TOKEN?: string; // 32+ random characters: unlocks POST /admin/pause, /admin/unjudged and /admin/gate-reset
  SIGNING_KEY?: string; // base64 PKCS8 Ed25519 private key (scripts/gen-keys.mjs)
  PUBLIC_KEY?: string; // base64 raw Ed25519 public key
  PUBLIC_KEY_HISTORY?: string; // JSON list of retired keys: [{"public_key":"...","retired":"2027-01-01"}]
}

// Minimal structural types so the Durable Object can also run under Node in tests.
export interface DOStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(time: number): Promise<void>;
  // Present on real Durable Objects; optional so simple test mocks still fit.
  list?<T = unknown>(opts: { prefix?: string; start?: string; limit?: number }): Promise<Map<string, T>>;
  delete?(keys: string | string[]): Promise<boolean | number>;
}
export interface DOState {
  storage: DOStorage;
}
