// The content screen, layer 2a (design: research/specs/content-screen-2026-11-03/DESIGN-v1.md and its addenda).
// A local, free check: secrets in the text that would reach an AI provider are refused before any provider sees them,
// and before any payment settles.
// - It screens only VALIDATED fields, the exact text a provider would get, after each route's own size checks
//   (validated fields are at most 12,000 characters). Screening the raw body let a body padded with thousands of
//   strings slip a secret past the walk, and gave crafted long lines quadratic regex time (the fresh read, Nov 3).
// - Only high-confidence kinds refuse. Four patterns are find's own (find/lib/scrub.mjs, the locked v1 build), copied
//   exactly; test/screen.test.ts checks them against a vendored copy. Three more are this server's: a wallet private
//   key, a labelled seed phrase, and a base64-encoded PEM private key (what an agent holding an x402 wallet would leak).
// - What decides a hit is stricter than find's printing scrub: a PEM header needs a key body after it, a URL
//   "password" must be valid userinfo up to the first "@", and plain placeholders, repeated units and low-variety
//   strings pass (documentation and tests are full of them).
// The response names the field, line and kind, never the matched text; nothing here logs content.

import { canonicalJson, sha256Hex } from "./logic.ts";
import { signReceipt, type Receipt } from "./receipt.ts";

export type ScreenMode = "off" | "shadow" | "enforce";

// What customers are told before they pay, while the screen is on (ccheez34, Nov 3 08:58: a refused submission ends with
// no refund "as long as they are made aware that they cant send certain content before"). Shown on every judge tier's
// payment request, in every match view, in GET /judge, GET / and /llms.txt.
export const SECRET_KINDS = "a private key, a wallet key or seed phrase, an API key or access token, a password inside a URL, or a bearer token";
export const SUBMIT_RULE = `Submissions holding a secret (${SECRET_KINDS}) are refused before any AI sees them. A refused submission counts as not submitted: send it again without the secret before the step deadline. If no submission from a seat is accepted by then, that seat forfeits, with no refund.`;
export const REQUEST_RULE = `Reviews and new matches holding a secret (${SECRET_KINDS}) are refused before any AI sees them, and a refused request isn't charged.`;

/** CONTENT_SCREEN: "off" (default), "shadow" (2b labels only; 2a still refuses) or "enforce". Anything else is "off". */
export function screenMode(env: { CONTENT_SCREEN?: string }): ScreenMode {
  const v = String(env.CONTENT_SCREEN ?? "").trim().toLowerCase();
  return v === "shadow" || v === "enforce" ? v : "off";
}

// Removed before matching, so they can't split a secret: every format character (\p{Cf}: zero-width, bidi, soft
// hyphen, word joiners, the BOM, tag characters, U+180E), U+034F, variation selectors, Hangul fillers, and the line and
// paragraph separators U+2028 and U+2029.
const cp = (...c: number[]) => c.map((x) => String.fromCodePoint(x)).join("");
const FORMAT_CHARS = /\p{Cf}/gu;
const OTHER_INVISIBLE = new RegExp(`[${cp(0x34f)}${cp(0xfe00)}-${cp(0xfe0f)}${cp(0xe0100)}-${cp(0xe01ef)}${cp(0x115f, 0x1160, 0x3164, 0xffa0, 0x2028, 0x2029)}]`, "gu");

/** find's four patterns (sources and flags copied exactly from find/lib/scrub.mjs). */
export const INTAKE_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp; what: string }> = [
  { kind: "private_key", re: /-----BEGIN[A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----/i, what: "a private key block" },
  {
    kind: "api_key",
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[\w-]{35}|ya29\.[\w-]{20,})/g,
    what: "an API key or access token",
  },
  { kind: "url_credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)\S+@/gi, what: "a password inside a URL" },
  { kind: "bearer_token", re: /\b(bearer)(\s+)[A-Za-z0-9._~+/=-]{16,}/gi, what: "a bearer token" },
];

// This server's own kinds (not in find).
const WALLET_KEY = /(?<![0-9A-Za-z])(?:0x)?[0-9a-fA-F]{64}(?![0-9A-Za-z])/g;
const WALLET_WORD = /priv(?:ate)?[ _-]?key|secret[ _-]?key|signing[ _-]?key|wallet[ _-]?key|account[ _-]?key/i;
const HASH_LABEL = /sha-?(1|224|256|384|512)|\bsha\b|(?<![a-z])hash(es)?(?![a-z])|digest|fingerprint|checksum|manifest|\btx(id)?\b|transaction|public/i; // find's, plus "public"
const PHRASE = /(?<![A-Za-z0-9])(mnemonic|seed|passphrase|pass[ _-]phrase|(?:seed|recovery)[ _-]?phrase)(["']?\s*[:=]\s*)(.{8,})$/i; // find's PHRASE, one match per line
const URL_NO_USER = /\b[a-z][a-z0-9+.-]*:\/\/:([^\s@]+)@/gi; // "redis://:password@host", which find's pattern misses
const B64_PEM = /(?<![A-Za-z0-9+/])LS0tLS1CRUdJTi[A-Za-z0-9+/]{200,}={0,2}/g; // base64 of "-----BEGIN", then a key's worth
const SERVER_KINDS: Record<string, string> = { wallet_key: "a wallet private key", seed_phrase: "a seed phrase", encoded_private_key: "a base64-encoded private key" };

// Placeholders: words that mark documentation or test values.
const PLACEHOLDER_WORD = /example|your[_-]?(?:api|secret|access|token|key|pass)|placeholder|redacted|dummy|sample|changeme|goes[_-]?here|token[_-]?here|key[_-]?here|wrong|invalid|bogus|fake/i;
const distinct = (s: string) => new Set(s).size;
/** A short unit repeated, e.g. "abab…" or "wrong-token-wrong-token-…": never a real key. */
const repeated = (s: string) => /^(.{1,16}?)\1+(.{0,16})$/s.test(s) && s.length >= 12;
const plainPlaceholder = (s: string) =>
  PLACEHOLDER_WORD.test(s) || /x{6,}|\*{4,}|\.{3}|<[^>]*>|\{\{|\$\{/.test(s) || repeated(s);

/** A key body: a base64 line of 40+ characters with real variety (not "XXXX…" or "AAAA…"). */
const keyBody = (s: string) => /^[A-Za-z0-9+/]{40,}={0,2}$/.test(s) && distinct(s) >= 16;

export type IntakeHit = { field: string; line: number; kind: string };
const MAX_HITS = 20;
const MAX_STRINGS = 200; // validated inputs hold a handful (task, output, title, criteria, pieces)

/** Every string in the validated fields (depth 6 at most) with its path, e.g. "pieces[1].text". */
function strings(v: unknown, path: string, depth: number, out: Array<[string, string]>): boolean {
  if (out.length >= MAX_STRINGS) return false;
  if (typeof v === "string") out.push([path || "(text)", v]);
  else if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (!strings(v[i], `${path}[${i}]`, depth + 1, out)) return false;
  } else if (v && typeof v === "object") {
    if (depth >= 6) return false;
    for (const [k, x] of Object.entries(v)) if (!strings(x, path ? `${path}.${k}` : k, depth + 1, out)) return false;
  }
  return true;
}

/** Is this regex match a real secret? (find's patterns decide where to look; this decides whether to refuse.) */
function realMatch(kind: string, m: RegExpExecArray, lines: string[], i: number): boolean {
  if (kind === "private_key") {
    // A header alone (a constant in code, a docs line) isn't a key. A key body follows: on the next lines, or on the
    // same line after literal "\n" escapes (a JSON-escaped key, as in a cloud service-account file).
    const rest = lines[i].slice(m.index + m[0].length).replace(/^(?:\\n|\\r|\s)+/, "");
    const sameLine = /^[A-Za-z0-9+/]{40,}/.exec(rest)?.[0] ?? "";
    if (keyBody(sameLine.slice(0, 64))) return true;
    for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === "" || /^[A-Za-z-]+:\s/.test(t)) continue; // blank, or a PEM header line (Proc-Type:, DEK-Info:)
      return keyBody(t.slice(0, 64)) && /^[A-Za-z0-9+/=]+$/.test(t);
    }
    return false;
  }
  if (kind === "url_credentials") {
    // The password runs from the scheme's user colon to the FIRST "@", and must be valid userinfo: no "/", quotes,
    // spaces or brackets. ("http://localhost:5173/@vite" has the port, not a password.)
    const after = m[0].slice(m[1].length);
    return realUrlPassword(after.slice(0, after.indexOf("@")));
  }
  if (kind === "bearer_token") {
    const token = m[0].slice(m[1].length + m[2].length);
    if (/^[A-Z_]+$/.test(token)) return false; // ACCESS_TOKEN_GOES_HERE
    return !plainPlaceholder(token) && distinct(token) >= 8;
  }
  // api_key: the key itself (AWS's documented example key ends in EXAMPLE inside the match)
  const body = m[0].replace(/^(?:sk-|sk_(?:live|test)_|AKIA|gh[pousr]_|github_pat_|xox[abprs]-|AIza|ya29\.)/, "");
  return !plainPlaceholder(m[0]) && distinct(body) >= 8;
}

/** A URL password up to the first "@": valid userinfo (no "/", quotes, spaces or brackets) and not a placeholder. */
function realUrlPassword(pass: string): boolean {
  if (!pass || !/^[^\s"'<>\\/`{}|^@[\]]+$/.test(pass)) return false;
  if (/^(?:pass(?:word)?|passwd|pwd|secret|token|changeme|p|x+|\*+)$/i.test(pass)) return false;
  if (/^\$[A-Z_][A-Z0-9_]*$|^%[A-Z_][A-Z0-9_]*%$/.test(pass)) return false; // $VAR or %VAR%, case-sensitive and whole
  return !plainPlaceholder(pass) && distinct(pass) >= 3;
}

/** Every match of a /g regex, from every start position (a greedy match must not hide a later one on the same line). */
function* everyMatch(re: RegExp, line: string): Generator<RegExpExecArray> {
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (let from = 0; from <= line.length; ) {
    r.lastIndex = from;
    const m = r.exec(line);
    if (!m) return;
    yield m;
    from = m.index + 1;
  }
}

function serverHits(line: string): string[] {
  const kinds: string[] = [];
  if (WALLET_WORD.test(line) && !HASH_LABEL.test(line))
    for (const m of line.matchAll(WALLET_KEY)) if (distinct(m[0].replace(/^0x/, "").toLowerCase()) >= 10) { kinds.push("wallet_key"); break; }
  const p = PHRASE.exec(line);
  if (p) {
    const words = p[3].trim().replace(/^["'`]|["'`,;]+$/g, "").trim().split(/\s+/);
    if ([12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w)) && new Set(words).size >= 8) kinds.push("seed_phrase");
  }
  for (const m of line.matchAll(URL_NO_USER)) if (realUrlPassword(m[1])) { kinds.push("url_credentials"); break; }
  for (const m of line.matchAll(B64_PEM)) {
    try {
      if (/PRIVATE KEY/.test(atob(m[0].slice(0, 80)))) { kinds.push("encoded_private_key"); break; }
    } catch { /* not base64 after all */ }
  }
  return kinds;
}

/** Layer 2a over validated fields: where they hold a secret, by field, line (1-based) and kind. Empty = passes. */
export function intakeCheck(fields: unknown): IntakeHit[] {
  const all: Array<[string, string]> = [];
  if (!strings(fields, "", 0, all)) return [{ field: "(input)", line: 0, kind: "too_complex" }]; // fail closed
  const hits: IntakeHit[] = [];
  for (const [field, text] of all) {
    const lines = text.replace(FORMAT_CHARS, "").replace(OTHER_INVISIBLE, "").split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
      const kinds = new Set<string>();
      for (const p of INTAKE_PATTERNS) {
        for (const m of everyMatch(p.re, lines[i]))
          if (realMatch(p.kind, m, lines, i)) { kinds.add(p.kind); break; }
      }
      for (const k of serverHits(lines[i])) kinds.add(k);
      for (const kind of kinds) hits.push({ field, line: i + 1, kind });
    }
  }
  return hits.slice(0, MAX_HITS);
}

export const REFUSAL_RECEIPT_FORMAT = "refusal-v1";

/** The policy 2a enforces, as data: its sha256 is what a refusal receipt signs when no terms hash is configured. */
export const BUILT_IN_POLICY = {
  version: "2a-v1",
  refuses: [...INTAKE_PATTERNS.map((p) => p.kind), ...Object.keys(SERVER_KINDS)],
  request_rule: REQUEST_RULE,
  submit_rule: SUBMIT_RULE,
};

/** sha256 of every screened string, by field: what a refusal receipt signs (never the text). */
export async function fieldHashes(fields: unknown): Promise<Record<string, string>> {
  const all: Array<[string, string]> = [];
  strings(fields, "", 0, all);
  const out: Record<string, string> = {};
  for (const [f, t] of all) out[f] = await sha256Hex(t);
  return out;
}

/** The signed refusal: route, label, where, the screened inputs' hashes, the policy's hash, what was charged. */
export async function refusalReceipt(
  env: { SIGNING_KEY?: string; PUBLIC_KEY?: string; CONTENT_POLICY_SHA256?: string },
  o: { route: string; label: string; step: "2a" | "2b"; hits?: IntakeHit[]; fields: unknown; model?: string; charged: false | "already_settled"; bind?: Record<string, unknown> },
): Promise<Receipt> {
  const inputs = await fieldHashes(o.fields);
  const payload: Record<string, unknown> = {
    receipt_format: REFUSAL_RECEIPT_FORMAT,
    route: o.route,
    ...(o.bind ?? {}),
    refused: true,
    label: o.label,
    step: o.step,
    ...(o.hits?.length ? { where: o.hits.map((h) => ({ field: h.field, line: h.line, kind: h.kind })) } : {}),
    ...(o.model ? { screen_model: o.model } : {}),
    inputs_sha256: inputs,
    inputs_canonical_sha256: await sha256Hex(canonicalJson(inputs)),
    ...(env.CONTENT_POLICY_SHA256
      ? { policy_sha256: env.CONTENT_POLICY_SHA256, policy_source: "CONTENT_POLICY_SHA256" }
      : { policy_sha256: await sha256Hex(canonicalJson(BUILT_IN_POLICY)), policy_source: BUILT_IN_POLICY.version }),
    charged: o.charged,
    at: new Date().toISOString(),
  };
  return signReceipt(payload, env.SIGNING_KEY, env.PUBLIC_KEY);
}

const KIND_TEXT: Record<string, string> = { ...Object.fromEntries(INTAKE_PATTERNS.map((p) => [p.kind, p.what])), ...SERVER_KINDS, too_complex: "too many fields to screen" };

/** The 422 for a 2a hit. `after`: what the refusal means for this route (reviews: nothing charged). */
export async function intakeRefusal(
  env: any,
  route: string,
  fields: unknown,
  hits: IntakeHit[],
  after: string,
  charged: false | "already_settled" = false,
  bind?: Record<string, unknown>,
): Promise<Response> {
  const where = hits.slice(0, 5).map((h) => `${h.field} line ${h.line} (${KIND_TEXT[h.kind] ?? h.kind})`).join("; ");
  const receipt = await refusalReceipt(env, { route, label: "secrets", step: "2a", hits, fields, charged, bind });
  return new Response(
    JSON.stringify({
      error: `content_refused: the input looks like it holds a secret: ${where}${hits.length > 5 ? ` and ${hits.length - 5} more` : ""}. Remove it (or replace it with a placeholder) and send again, so it never reaches an AI provider. ${after}`,
      code: "secret_in_input",
      where: hits,
      receipt,
    }),
    { status: 422, headers: { "content-type": "application/json" } },
  );
}
