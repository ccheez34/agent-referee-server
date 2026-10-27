export interface Env {
  MATCHES: DurableObjectNamespace;
  LEDGER?: DurableObjectNamespace; // agent records

  // vars (wrangler.jsonc)
  PAY_TO: string; // your receiving wallet address (0x...) on the chosen network
  NETWORK: string; // "base-sepolia" for testing, "base" for real money
  FACILITATOR_URL?: string; // defaults to https://x402.org/facilitator (testnet only)
  PAYMENTS_ENABLED?: string; // "false" turns the paywall off for local testing
  PAID_PAUSED?: string; // "true" refuses paid matches (before any payment) and points agents to demo mode
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
}
export interface DOState {
  storage: DOStorage;
}
