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
// Fake keys on purpose (test fixtures, decoys, a scrubber's own patterns): the sender says so, and the request passes.
export const ALLOW_NOTE = `Sending fake keys on purpose (test fixtures, decoys)? Add allow_secrets: true to the request; a real secret sent with it reaches the AI companies.`;
export const SUBMIT_RULE = `Submissions holding a secret (${SECRET_KINDS}) are refused before any AI sees them. A refused submission counts as not submitted: send it again without the secret before the step deadline. If no submission from a seat is accepted by then, that seat forfeits, with no refund. ${ALLOW_NOTE}`;
export const REQUEST_RULE = `Reviews and new matches holding a secret (${SECRET_KINDS}) are refused before any AI sees them, and a refused request isn't charged. ${ALLOW_NOTE}`;

/** CONTENT_SCREEN: "off" (default), "shadow" (2b labels only; 2a still refuses) or "enforce". Anything else is "off". */
export function screenMode(env: { CONTENT_SCREEN?: string }): ScreenMode {
  const v = String(env.CONTENT_SCREEN ?? "").trim().toLowerCase();
  return v === "shadow" || v === "enforce" ? v : "off";
}

// Removed before matching, so they can't split a secret: every format character (\p{Cf}: zero-width, bidi, soft
// hyphen, word joiners, the BOM, tag characters) and every default-ignorable code point (U+034F, U+17B4/5, the
// Mongolian selectors, variation selectors, Hangul fillers, U+FFF0-8), plus the separators U+2028 and U+2029.
const cp = (...c: number[]) => c.map((x) => String.fromCodePoint(x)).join("");
const FORMAT_CHARS = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
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
// The nearest label before a 64-hex value decides: a key label refuses, a hash or public-key label passes, none passes.
const WALLET_LABEL = /(public[ _-]?key|pub[ _-]?key)|(priv(?:ate)?[ _-]?key|secret[ _-]?key|signing[ _-]?key|wallet[ _-]?key|account[ _-]?key|deployer[ _-]?key|[a-z0-9]_key\b|wallet\s*\(|from_key|privatekeytoaccount|signer|mnemonic)|((?<![a-z])(?:tx|txid|tx_?hash|hash(?:es)?|digest|sha\d*|checksum|fingerprint|address|addr|salt|nonce|root|commitment|seed_hash)(?![a-z]))/gi;
// Published development values, not secrets (two sources each: their projects' docs and the fresh reader's probes).
const DEV_KEYS = new Set(["ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"]); // Hardhat/Anvil account #0
const DEV_MNEMONICS = new Set([
  "test test test test test test test test test test test junk", // Hardhat, Anvil
  "candy maple cake sugar pudding cream honey rich smooth crumble sweet treat", // Truffle develop
  "myth like bonus scare over problem client lizard pioneer submit female collect", // Ganache -d
  "legal winner thank year wave sausage worth useful legal winner thank yellow", // a BIP39 test vector
]);
const PHRASE = /(?<![A-Za-z0-9])(mnemonic|seed|passphrase|pass[ _-]phrase|(?:seed|recovery)[ _-]?phrase)(["']?\s*[:=]\s*)(.{8,})$/i; // find's PHRASE, one match per line
const URL_NO_USER = /\b[a-z][a-z0-9+.-]*:\/\/:([^\s@]+)@/gi; // "redis://:password@host", which find's pattern misses
const B64_PEM = /(?<![A-Za-z0-9+/])LS0tLS1CRUdJTi[A-Za-z0-9+/]{60,}={0,2}/g; // base64 of "-----BEGIN" and more (wrapped at 64 or 76 too)
const SEED_LABEL = /mnemonic|seed|recovery[ _-]?(?:phrase|words)|pass[ _-]?phrase|secret[ _-]?(?:phrase|words)|backup[ _-]?phrase/i;
const SERVER_KINDS: Record<string, string> = { wallet_key: "a wallet private key", seed_phrase: "a seed phrase", encoded_private_key: "a base64-encoded private key" };

// Placeholders: words that mark documentation or test values.
const PLACEHOLDER_WORD = /example|your[_-]?(?:api|secret|access|token|key|pass)|placeholder|redacted|dummy|sample|changeme|goes[_-]?here|token[_-]?here|key[_-]?here|wrong|invalid|bogus|fake/i;
const distinct = (s: string) => new Set(s).size;
/** A short unit repeated, e.g. "abab…" or "wrong-token-wrong-token-…": never a real key. */
const repeated = (s: string) => /^(.{1,16}?)\1+(.{0,16})$/s.test(s) && s.length >= 12;
const plainPlaceholder = (s: string) =>
  PLACEHOLDER_WORD.test(s) || /x{6,}|\*{4,}|\.{3}|<[^>]*>|\{\{|\$\{/.test(s) || repeated(s);

/** A key body's run of base64 in a line, wherever it sits: bare, quoted, concatenated, in an array, after "#" or ">"
 * or a literal "\n" escape. It needs real variety and both cases (so "XXXX…" and long hex don't count). */
function keyBody(line: string): boolean {
  const run = /[A-Za-z0-9+/]{40,}/.exec(line.replace(/\\[nr]/g, " "))?.[0].slice(0, 64) ?? "";
  return run.length >= 40 && distinct(run) >= 16 && /[A-Z]/.test(run) && /[a-z]/.test(run);
}
/** An ascending run of 6 (abcdef, 123456): typed by a person, never drawn at random. */
const ascending = (s: string) => {
  for (let i = 0, n = 1; i + 1 < s.length; i++) {
    n = s.charCodeAt(i + 1) === s.charCodeAt(i) + 1 && /[A-Za-z0-9]/.test(s[i]) ? n + 1 : 1;
    if (n >= 6) return true;
  }
  return false;
};

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
    // `lines` runs on into the next field's first lines, for a header that ends one piece and a body that opens the next.
    if (keyBody(lines[i].slice(m.index + m[0].length))) return true;
    for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
      const t = lines[j].replace(/^[\s"'`#>*/+,;()[\]]+/, "");
      if (t === "" || /^[A-Za-z-]+:\s/.test(t)) continue; // blank, or a PEM header line (Proc-Type:, DEK-Info:)
      return keyBody(t);
    }
    return false;
  }
  if (kind === "url_credentials") {
    // The password runs from the scheme's user colon to the FIRST "@", and must be valid userinfo: no "/", quotes,
    // spaces or brackets. ("http://localhost:5173/@vite" has the port, not a password.)
    const after = m[0].slice(m[1].length);
    const user = m[1].slice(m[1].indexOf("//") + 2, -1);
    const slash = after.indexOf("/");
    const authority = slash === -1 ? after : after.slice(0, slash);
    const firstAt = after.indexOf("@"), lastAt = authority.lastIndexOf("@");
    // The host after a given "@", read from the line itself (the match ends at the run's last "@").
    const hostAfter = (at: number) => lines[i].slice(m.index + m[1].length + at + 1).match(/^[^/:\s"'?#,]*/)?.[0] ?? "";
    return realUrlPassword(after.slice(0, firstAt), user, hostAfter(firstAt)) || (lastAt > firstAt && realUrlPassword(authority.slice(0, lastAt), user, hostAfter(lastAt), true));
  }
  if (kind === "bearer_token") {
    const token = m[0].slice(m[1].length + m[2].length);
    if (/^[A-Z_]+$/.test(token)) return false; // ACCESS_TOKEN_GOES_HERE
    return !plainPlaceholder(token) && !ascending(token) && distinct(token) >= 8;
  }
  // api_key: the key itself (AWS's documented example key ends in EXAMPLE inside the match)
  const body = m[0].replace(/^(?:sk-|sk_(?:live|test)_|AKIA|gh[pousr]_|github_pat_|xox[abprs]-|AIza|ya29\.)/, "");
  return !plainPlaceholder(m[0]) && !ascending(body) && distinct(body) >= 8;
}

const DEV_HOSTS = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)$/i;
const DEV_PASSWORDS = /^(?:postgres|guest|root|admin|test|foobared|mysql|redis|rabbitmq|minio(?:admin)?|dev)$/i;
/** A URL password: valid userinfo (no "/", quotes, spaces or brackets; a raw "@" only when `withAt`), not a placeholder,
 * and not a development default (the user name repeated, a local host, a documented default password). */
function realUrlPassword(pass: string, user = "", host = "", withAt = false): boolean {
  if (!pass || !(withAt ? /^[^\s"'<>\\/`{}|^[\]]+$/ : /^[^\s"'<>\\/`{}|^@[\]]+$/).test(pass)) return false;
  if (pass === user || DEV_HOSTS.test(host) || DEV_PASSWORDS.test(pass)) return false;
  if (/^(?:pass(?:word)?|passwd|pwd|secret|token|changeme|p|x+|\*+)$/i.test(pass)) return false;
  if (/^\$[A-Z_][A-Z0-9_]*$|^%[A-Z_][A-Z0-9_]*%$/.test(pass)) return false; // $VAR or %VAR%, case-sensitive and whole
  return !plainPlaceholder(pass) && distinct(pass) >= 3;
}

const MAX_STARTS = 200; // URL candidates on one line; past it the line is refused as too complex (fail closed)
const TOO_COMPLEX = Symbol("too complex");
/** Every URL-credential match, from every start position (a greedy match must not hide a later one on the line). */
function* everyMatch(re: RegExp, line: string): Generator<RegExpExecArray | typeof TOO_COMPLEX> {
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (let from = 0, n = 0; from <= line.length; n++) {
    if (n >= MAX_STARTS) { yield TOO_COMPLEX; return; }
    r.lastIndex = from;
    const m = r.exec(line);
    if (!m) return;
    yield m;
    from = m.index + 1;
  }
}

/** 12 to 24 BIP39-shaped words (lowercase, 3 to 8 letters, at least 8 different), not a published dev mnemonic. */
function seedWords(text: string): boolean {
  const words = text.trim().replace(/^["'`]|["'`,;]+$/g, "").trim().split(/\s+/);
  return [12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w)) && new Set(words).size >= 8 && !DEV_MNEMONICS.has(words.join(" "));
}

function serverHits(line: string, prev: string): string[] {
  const kinds: string[] = [];
  for (const m of line.matchAll(WALLET_KEY)) {
    const hex = m[0].replace(/^0x/, "").toLowerCase();
    if (distinct(hex) < 10 || DEV_KEYS.has(hex)) continue;
    const labels = [...line.slice(Math.max(0, m.index! - 80), m.index).matchAll(WALLET_LABEL)];
    const near = labels[labels.length - 1];
    if (near && near[2] && !near[1] && !near[3]) { kinds.push("wallet_key"); break; }
  }
  // A seed phrase: find's labelled form, a label then ":" or "=" anywhere before the words, or the label on the line above.
  const p = PHRASE.exec(line);
  const quoted = /["'`]([a-z ]{20,})["'`]/.exec(line)?.[1];
  const afterSep = /[:=]\s*(.+)$/.exec(line)?.[1];
  if ((p && seedWords(p[3])) || (SEED_LABEL.test(line) && ((quoted && seedWords(quoted)) || (afterSep && seedWords(afterSep)))) || (SEED_LABEL.test(prev) && seedWords(line)))
    kinds.push("seed_phrase");
  if (line.includes("://:"))
    for (const m of line.matchAll(URL_NO_USER)) {
      const host = line.slice(m.index! + m[0].length).match(/^[^/:\s"'?#,]*/)?.[0] ?? "";
      if (realUrlPassword(m[1], "", host)) { kinds.push("url_credentials"); break; }
    }
  if (line.includes("LS0tLS1CRUdJTi")) for (const m of line.matchAll(B64_PEM)) {
    try {
      if (/PRIVATE KEY/.test(atob(m[0].slice(0, Math.floor(Math.min(m[0].length, 80) / 4) * 4)))) { kinds.push("encoded_private_key"); break; }
    } catch { /* not base64 after all */ }
  }
  return kinds;
}

/** Layer 2a over validated fields: where they hold a secret, by field, line (1-based) and kind. Empty = passes. */
export function intakeCheck(fields: unknown): IntakeHit[] {
  const all: Array<[string, string]> = [];
  if (!strings(fields, "", 0, all)) return [{ field: "(input)", line: 0, kind: "too_complex" }]; // fail closed
  const hits: IntakeHit[] = [];
  const split = (t: string) => t.replace(FORMAT_CHARS, "").replace(OTHER_INVISIBLE, "").split(/\r\n|\r|\n/);
  const fieldLines = all.map(([, text]) => split(text));
  for (let f = 0; f < all.length; f++) {
    const field = all[f][0];
    const own = fieldLines[f];
    const lines = f + 1 < all.length ? own.concat(fieldLines[f + 1].slice(0, 4)) : own; // a key body may open the next piece
    for (let i = 0; i < own.length && hits.length < MAX_HITS; i++) {
      const kinds = new Set<string>();
      for (const p of INTAKE_PATTERNS) {
        if (p.kind === "url_credentials") {
          if (!own[i].includes("://")) continue;
          for (const m of everyMatch(p.re, own[i])) {
            if (m === TOO_COMPLEX) { kinds.add("too_complex"); break; }
            if (realMatch(p.kind, m, lines, i)) { kinds.add(p.kind); break; }
          }
        } else
          for (const m of p.re.global ? own[i].matchAll(p.re) : [p.re.exec(own[i])].filter((x) => x !== null))
            if (realMatch(p.kind, m as RegExpExecArray, lines, i)) { kinds.add(p.kind); break; }
      }
      for (const k of serverHits(own[i], i > 0 ? own[i - 1] : "")) kinds.add(k);
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

const KIND_TEXT: Record<string, string> = { ...Object.fromEntries(INTAKE_PATTERNS.map((p) => [p.kind, p.what])), ...SERVER_KINDS, too_complex: "too complex to screen" };

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
      error: `content_refused: the input looks like it holds a secret: ${where}${hits.length > 5 ? ` and ${hits.length - 5} more` : ""}. Remove it (or replace it with a placeholder) and send again, so it never reaches an AI provider; if it is a fake key on purpose, send again with "allow_secrets": true. ${after}`,
      code: "secret_in_input",
      where: hits,
      receipt,
    }),
    { status: 422, headers: { "content-type": "application/json" } },
  );
}
