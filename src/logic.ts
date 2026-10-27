// Pure game logic: no Cloudflare or npm imports, so it can be unit-tested in Node.

export type Tier = "rps" | "rps-bo3" | "weighted" | "draw" | "judge" | "judge-2" | "judge-3";
export const TIERS: Tier[] = ["rps", "rps-bo3", "weighted", "draw", "judge", "judge-2", "judge-3"];
/** Tiers decided by AI judges (one judge, or an independent panel of 2 or 3). */
export const JUDGE_TIERS: Tier[] = ["judge", "judge-2", "judge-3"];
export const isJudgeTier = (t: string): t is "judge" | "judge-2" | "judge-3" => (JUDGE_TIERS as string[]).includes(t);
/** Random tiers that support a mutual rematch (a linked series with a running tally). */
export const REMATCH_TIERS: Tier[] = ["rps", "rps-bo3", "weighted"];
export const MAX_SERIES_GAMES = 10;

/** Twice a "$0.015"-style price: what the host of an invite match pays to cover both seats. */
export function doublePrice(price: string): string {
  const n = Number(price.replace(/^\$/, ""));
  return "$" + Number((n * 2).toFixed(6)).toString();
}

export type Move = "rock" | "paper" | "scissors";
export const MOVES: Move[] = ["rock", "paper", "scissors"];

export const MEDIATOR = "mediator";

const enc = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The exact commitment format agents must use: sha256_hex(value + ":" + nonce). */
export function commitmentOf(value: string, nonce: string): Promise<string> {
  return sha256Hex(`${value}:${nonce}`);
}

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Returns the winning move's owner index: 0, 1, or -1 for a tie. */
export function rpsResult(a: Move, b: Move): 0 | 1 | -1 {
  if (a === b) return -1;
  const beats: Record<Move, Move> = { rock: "scissors", paper: "rock", scissors: "paper" };
  return beats[a] === b ? 0 : 1;
}

/**
 * Combine every revealed seed into one shared random number. Nobody, including
 * this service, can steer it alone: each seed was committed before any was seen.
 */
export async function combinedRandom(
  matchId: string,
  round: number,
  seeds: Record<string, string>,
): Promise<{ hex: string; value: bigint }> {
  const parts = Object.keys(seeds)
    .sort()
    .map((seat) => `${seat}=${seeds[seat]}`);
  const hex = await sha256Hex(`${matchId}|${round}|${parts.join("|")}`);
  // 64 bits is far more than enough to make modulo bias negligible for small ranges.
  return { hex, value: BigInt("0x" + hex.slice(0, 16)) };
}

export function weightedPick(weights: Record<string, number>, r: bigint): string {
  const seats = Object.keys(weights).sort();
  const total = seats.reduce((s, k) => s + weights[k], 0);
  let ticket = Number(r % BigInt(total));
  for (const seat of seats) {
    if (ticket < weights[seat]) return seat;
    ticket -= weights[seat];
  }
  return seats[seats.length - 1];
}

export function drawPick(options: string[], r: bigint): number {
  return Number(r % BigInt(options.length));
}

/** Deterministic JSON (sorted keys) so signatures can be re-checked by anyone. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

// ---------- validation ----------

export const LABEL_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const KEY_RE = /^[A-Za-z0-9._:-]{3,128}$/;
export const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
export const LIMITS = {
  minNonce: 16,
  minSeed: 16,
  maxValue: 256,
  maxOptions: 20,
  maxOptionLen: 200,
  maxParties: 8,
  maxRules: 4000,
  maxPosition: 6000,
  maxTitle: 200,
  maxCriteria: 8,
  maxCriterionName: 60,
};

export type Criterion = { name: string; weight: number };

export type CreateInput = {
  tier: Tier;
  key?: string;
  seat_wallets?: Record<string, string>;
  step_seconds?: number;
  seats: string[];
  title?: string;
  weights?: Record<string, number>;
  options?: string[];
  rules?: string;
  criteria?: Criterion[]; // judge tiers: agreed, weighted scoring criteria; the winner is computed from the scores
  demo?: boolean; // free practice match: no payment, receipts marked demo, never recorded
  host_pays?: string; // invite match: this seat pays for both seats; the other agent joins free with an invite token
  panel?: "rotate" | string[] | string[][] | { picks: Record<string, string> }; // judge-2 / judge-3: which models judge (see choosePanel in judge.ts)
};

export function validateCreate(body: any): { ok: true; value: CreateInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be a JSON object." };
  const tier = body.tier as Tier;
  if (!TIERS.includes(tier)) return { ok: false, error: `tier must be one of: ${TIERS.join(", ")}` };

  const seats = body.seats;
  if (!Array.isArray(seats) || !seats.every((s) => typeof s === "string" && LABEL_RE.test(s)))
    return { ok: false, error: "seats must be an array of labels (letters, digits, _ or -, max 32 chars)." };
  if (new Set(seats).size !== seats.length) return { ok: false, error: "seats must be unique." };
  if (seats.includes(MEDIATOR)) return { ok: false, error: `"${MEDIATOR}" is reserved.` };

  const title = body.title;
  if (title !== undefined && (typeof title !== "string" || title.length > LIMITS.maxTitle))
    return { ok: false, error: `title must be a string up to ${LIMITS.maxTitle} chars.` };

  const key = body.key;
  if (key !== undefined && (typeof key !== "string" || !KEY_RE.test(key)))
    return { ok: false, error: "key must be 3-128 characters: letters, digits, and . _ : - only." };

  const out: CreateInput = { tier, seats, title, key };

  if (body.demo !== undefined && typeof body.demo !== "boolean") return { ok: false, error: "demo must be true or false." };
  if (body.demo === true) {
    if (isJudgeTier(tier)) return { ok: false, error: "Demo mode isn't available for the judge tiers (every verdict is a real AI call). Try weighted, rps, rps-bo3 or draw." };
    if (body.seat_wallets !== undefined) return { ok: false, error: "Demo matches are free, so seats can't be locked to wallets." };
    out.demo = true;
  }

  const step = body.step_seconds;
  if (step !== undefined) {
    if (!Number.isInteger(step) || step < 60 || step > 3600)
      return { ok: false, error: "step_seconds must be a whole number from 60 to 3600 (default 600)." };
    out.step_seconds = step;
  }

  // Optional seat locks: a paid seat can only be claimed by a payment from this wallet.
  const sw = body.seat_wallets;
  if (sw !== undefined) {
    if (!sw || typeof sw !== "object" || Array.isArray(sw)) return { ok: false, error: "seat_wallets must be an object like {\"alpha\": \"0x...\"}." };
    const lockable = tier === "draw" ? [MEDIATOR] : seats;
    const locks: Record<string, string> = {};
    for (const [seat, addr] of Object.entries(sw)) {
      if (!lockable.includes(seat))
        return {
          ok: false,
          error:
            tier === "draw"
              ? `In a draw only the paid "${MEDIATOR}" seat can be locked to a wallet (party seats are free to join).`
              : `seat_wallets has unknown seat "${seat}".`,
        };
      if (typeof addr !== "string" || !WALLET_RE.test(addr)) return { ok: false, error: `seat_wallets.${seat} must be a 0x wallet address.` };
      locks[seat] = addr.toLowerCase();
    }
    if (Object.keys(locks).length) out.seat_wallets = locks;
  }

  if (tier === "draw") {
    if (seats.length < 2 || seats.length > LIMITS.maxParties)
      return { ok: false, error: `draw needs 2 to ${LIMITS.maxParties} party seats (the mediator seat is added automatically).` };
    const options = body.options;
    if (
      !Array.isArray(options) ||
      options.length < 2 ||
      options.length > LIMITS.maxOptions ||
      !options.every((o) => typeof o === "string" && o.length > 0 && o.length <= LIMITS.maxOptionLen)
    )
      return { ok: false, error: `options must be 2 to ${LIMITS.maxOptions} non-empty strings.` };
    out.options = options;
  } else if (seats.length !== 2) {
    return { ok: false, error: `${tier} needs exactly 2 seats.` };
  }

  // Invite match: one agent (the host) pays for both seats and gets an invite for the other agent, who joins free.
  if (body.host_pays !== undefined) {
    if (tier === "draw") return { ok: false, error: "draw already works this way: the mediator pays and the parties join free." };
    if (typeof body.host_pays !== "string" || !seats.includes(body.host_pays))
      return { ok: false, error: "host_pays must be the seat of the agent that pays for both seats." };
    if (key !== undefined)
      return { ok: false, error: "An invite match can't use a shared key: only the agent that creates it receives the invite. Leave out key and send the invite instead." };
    if (out.seat_wallets && Object.keys(out.seat_wallets).some((s) => s !== body.host_pays))
      return { ok: false, error: "In an invite match only the host's seat can be locked to a wallet (the guest joins free)." };
    out.host_pays = body.host_pays;
  }

  if (tier === "weighted") {
    const w = body.weights;
    if (!w || typeof w !== "object") return { ok: false, error: "weighted needs weights, e.g. {\"alpha\":70,\"beta\":30}." };
    for (const s of seats) {
      const n = w[s];
      if (!Number.isInteger(n) || n < 1 || n > 1000)
        return { ok: false, error: `weights.${s} must be an integer from 1 to 1000.` };
    }
    if (Object.keys(w).length !== seats.length) return { ok: false, error: "weights must have exactly one entry per seat." };
    out.weights = Object.fromEntries(seats.map((s) => [s, w[s]]));
  }

  if (isJudgeTier(tier)) {
    const rules = body.rules;
    if (typeof rules !== "string" || rules.trim().length < 10 || rules.length > LIMITS.maxRules)
      return { ok: false, error: `${tier} needs rules: the agreed decision criteria, 10 to ${LIMITS.maxRules} chars.` };
    out.rules = rules;
    if (body.criteria !== undefined) {
      const c = validateCriteria(body.criteria);
      if (typeof c === "string") return { ok: false, error: c };
      out.criteria = c;
    }
  } else if (body.criteria !== undefined) {
    return { ok: false, error: "criteria are only for the judge tiers (judge, judge-2, judge-3)." };
  }

  if (body.panel !== undefined) {
    if (tier !== "judge-2" && tier !== "judge-3") return { ok: false, error: "panel is only for the panel tiers (judge-2, judge-3)." };
    const e = isPicks(body.panel) ? picksError(body.panel, tier, out.seats) : panelShapeError(body.panel, tier === "judge-2" ? 2 : 3);
    if (e) return { ok: false, error: e };
    out.panel = body.panel;
  }

  return { ok: true, value: out };
}

/** Scoring criteria: 1-8 of {name, weight}. Names are unique; weights are whole numbers 1-100. */
export function validateCriteria(v: unknown): Criterion[] | string {
  const err = `criteria must be 1 to ${LIMITS.maxCriteria} items like {"name": "price", "weight": 3}: unique names up to ${LIMITS.maxCriterionName} characters, whole-number weights from 1 to 100.`;
  if (!Array.isArray(v) || v.length < 1 || v.length > LIMITS.maxCriteria) return err;
  const out: Criterion[] = [];
  for (const c of v) {
    if (!c || typeof c !== "object" || typeof c.name !== "string") return err;
    const name = c.name.trim();
    if (!name || name.length > LIMITS.maxCriterionName || /[\n\r]/.test(name)) return err;
    if (!Number.isInteger(c.weight) || c.weight < 1 || c.weight > 100) return err;
    if (out.some((x) => x.name === name)) return err;
    out.push({ name, weight: c.weight });
  }
  return out;
}

export function validateRevealValue(tier: Tier, value: unknown): string | null {
  if (typeof value !== "string" || value.length > LIMITS.maxValue) return "value must be a string.";
  if (tier === "rps" || tier === "rps-bo3") {
    if (!MOVES.includes(value as Move)) return `value must be one of: ${MOVES.join(", ")}`;
  } else if (value.length < LIMITS.minSeed) {
    return `value must be a random seed of at least ${LIMITS.minSeed} characters.`;
  }
  return null;
}

/** Match id for a shared key: both agents compute the same id from a name they already share. */
export async function idForKey(key: string, demo = false): Promise<string> {
  // Demo matches live in their own id space, so a demo key can never land in a paid match (or vice versa).
  return (await sha256Hex(`${demo ? "agent-referee-demo-key" : "agent-referee-key"}:${key}`)).slice(0, 24);
}

/** The settings both agents must agree on. Seat order and title don't matter. */
export function specFingerprint(i: { tier: string; seats: string[]; weights?: unknown; options?: unknown; rules?: unknown; criteria?: unknown; seat_wallets?: unknown; step_seconds?: unknown; demo?: unknown; panel?: unknown }) {
  return canonicalJson({ tier: i.tier, seats: [...i.seats].sort(), weights: i.weights, options: i.options, rules: i.rules, criteria: i.criteria, seat_wallets: i.seat_wallets, step_seconds: i.step_seconds, demo: i.demo ? true : undefined, panel: i.panel });
}

/** Pull the paying wallet out of an x402 "exact" EVM payment header (already verified by the paywall). */
export function payerFromPaymentHeader(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  try {
    const decoded = JSON.parse(atob(header));
    const from = decoded?.payload?.authorization?.from;
    return typeof from === "string" && WALLET_RE.test(from) ? from.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Short, stable id for a signing key, so receipts can name which key signed them. */
export async function keyId(publicKeyB64: string): Promise<string> {
  return (await sha256Hex(publicKeyB64.trim())).slice(0, 16);
}

/** Field-by-field differences between two match settings, so a mismatch (e.g. a typo'd wallet) is easy to spot. */
export function specDifferences(
  has: { tier: string; seats: string[]; weights?: any; options?: any; rules?: any; criteria?: any; seat_wallets?: any; step_seconds?: any; demo?: any; panel?: any },
  sent: { tier: string; seats: string[]; weights?: any; options?: any; rules?: any; criteria?: any; seat_wallets?: any; step_seconds?: any; demo?: any; panel?: any },
) {
  const out: { field: string; match_has: unknown; you_sent: unknown }[] = [];
  const cmp = (field: string, a: unknown, b: unknown) => {
    if (canonicalJson(a ?? null) !== canonicalJson(b ?? null)) out.push({ field, match_has: a ?? null, you_sent: b ?? null });
  };
  cmp("tier", has.tier, sent.tier);
  cmp("seats", [...has.seats].sort(), [...sent.seats].sort());
  cmp("options", has.options, sent.options);
  cmp("rules", has.rules, sent.rules);
  cmp("criteria", has.criteria, sent.criteria);
  cmp("panel", has.panel, sent.panel);
  cmp("step_seconds", has.step_seconds, sent.step_seconds);
  cmp("demo", has.demo ? true : undefined, sent.demo ? true : undefined);
  for (const k of new Set([...Object.keys(has.weights ?? {}), ...Object.keys(sent.weights ?? {})])) cmp(`weights.${k}`, has.weights?.[k], sent.weights?.[k]);
  for (const k of new Set([...Object.keys(has.seat_wallets ?? {}), ...Object.keys(sent.seat_wallets ?? {})]))
    cmp(`seat_wallets.${k}`, has.seat_wallets?.[k], sent.seat_wallets?.[k]);
  return out;
}

/** The first four groups of an IPv6 address (its /64 block), expanded so equivalent spellings match. */
export function ipv6Prefix64(ip: string): string {
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => (g || "0").toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/** Shape check, no pool needed (used when validating settings). Returns an error message, or null if fine. */
export function panelShapeError(v: unknown, size: number): string | null {
  const err = `panel must be "rotate", an array of ${size} model ids, or an array of up to 5 such arrays (one is drawn at random).`;
  if (v === "rotate") return null;
  if (!Array.isArray(v) || !v.length) return err;
  const isSet = (x: unknown) => Array.isArray(x) && x.length === size && x.every((m) => typeof m === "string" && m.length > 0 && m.length <= 80) && new Set(x).size === x.length;
  if (v.every((x) => typeof x === "string")) return isSet(v) ? null : err;
  if (v.length > 5 || !v.every(isSet)) return err;
  return null;
}

const isPicks = (v: unknown): v is { picks: Record<string, string> } => !!v && typeof v === "object" && !Array.isArray(v);

/** judge-3 { picks: { seatA: model, seatB: model } }: each of the two parties names one judge; the third is drawn. */
function picksError(v: { picks?: unknown }, tier: string, seats: string[]): string | null {
  const err = 'panel {"picks": {...}} is for judge-3 with two parties: one model id per party, like {"picks": {"buyer": "claude-opus-5-5", "seller": "openai/gpt-6-luna"}}. The third judge is drawn at random.';
  const p = v.picks;
  if (tier !== "judge-3" || seats.length !== 2 || Object.keys(v).length !== 1 || !p || typeof p !== "object" || Array.isArray(p)) return err;
  const keys = Object.keys(p);
  if (keys.length !== 2 || !seats.every((s) => keys.includes(s))) return err;
  const ms = Object.values(p);
  if (!ms.every((m) => typeof m === "string" && m.length > 0 && m.length <= 80) || ms[0] === ms[1]) return err;
  return null;
}
