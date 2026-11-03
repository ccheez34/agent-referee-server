// The content screen, layer 2a (design: research/specs/content-screen-2026-11-03/DESIGN-v1.md and ADDENDUM-1).
// A local, free check on every request that carries customer text: secrets (private keys, provider API keys,
// credentials in URLs, bearer tokens) are refused before any AI provider sees them, and before any payment settles.
// Only high-confidence patterns refuse here: a code review routinely holds hashes, base64 and the word "token",
// so find's printing heuristics (long hex, base64 on a key-word line) stay out. The patterns below are find's own
// (find/lib/scrub.mjs, v1 build Nov 1); test/screen.test.ts checks they still agree with a vendored copy of it.
// The response names the field, line and kind, never the matched text, and nothing here logs content.

import { canonicalJson, sha256Hex } from "./logic.ts";
import { signReceipt, type Receipt } from "./receipt.ts";

export type ScreenMode = "off" | "shadow" | "enforce";

/** CONTENT_SCREEN: "off" (default), "shadow" (2b labels only; 2a still refuses) or "enforce". Anything else is "off". */
export function screenMode(env: { CONTENT_SCREEN?: string }): ScreenMode {
  const v = String(env.CONTENT_SCREEN ?? "").trim().toLowerCase();
  return v === "shadow" || v === "enforce" ? v : "off";
}

// Zero-width, soft-hyphen and bidi characters are removed first (find's ZW), so they can't split a secret.
const ch = (...c: number[]) => String.fromCharCode(...c);
const ZW = new RegExp(`[${ch(0xad, 0x61c)}${ch(0x200b)}-${ch(0x200f)}${ch(0x202a)}-${ch(0x202e)}${ch(0x2060)}-${ch(0x2069)}${ch(0xfeff)}]`, "g");

/** The kinds refused, each with find's pattern (sources and flags copied exactly). */
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

// A match that is plainly a documentation placeholder isn't refused: "Bearer YOUR_API_KEY_HERE", AWS's published
// example key, "sk-xxxxxxxxxxxxxxxxxxxx", "https://user:<password>@host". (A real key with one of these words in it
// is vanishingly rare; refusing every code sample that shows how to authenticate is not.)
const PLACEHOLDER = /example|your[_-]?|placeholder|redacted|dummy|changeme|x{6,}|\*{4,}|\.{3}|<[^>]*>|\{\{|\$\{|\$[A-Z_]{3,}|%[A-Z_]+%/i;

export type IntakeHit = { field: string; line: number; kind: string };

// Top-level fields that are the server's own tokens or ids, never customer text.
const SKIP_TOP = new Set(["seat", "seat_token", "invite_token", "match_id", "payment", "key", "tier", "panel", "demo", "host_pays", "wallet"]);
const MAX_HITS = 20;

/** Every string in the body (depth 6 at most) with its path, e.g. "pieces[1].text". */
function strings(v: unknown, path: string, depth: number, out: Array<[string, string]>) {
  if (depth > 6 || out.length > 5000) return;
  if (typeof v === "string") out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, depth + 1, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (depth === 0 && SKIP_TOP.has(k)) continue;
      strings(x, path ? `${path}.${k}` : k, depth + 1, out);
    }
}

/** The part of a match that would be the secret (for the placeholder test). A private key block always counts. */
function secretPart(kind: string, m: RegExpMatchArray): string {
  if (kind === "url_credentials") return m[0].slice(m[1].length); // the password, up to the @
  if (kind === "bearer_token") return m[0].slice(m[1].length + m[2].length);
  if (kind === "private_key") return "";
  return m[0]; // the key itself (AWS's example key ends in EXAMPLE inside the match)
}

/** Layer 2a: where the body holds a secret, by field, line (1-based) and kind. Empty = passes. */
export function intakeCheck(body: unknown): IntakeHit[] {
  const all: Array<[string, string]> = [];
  strings(body, "", 0, all);
  const hits: IntakeHit[] = [];
  for (const [field, text] of all) {
    const lines = text.replace(ZW, "").split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++)
      for (const p of INTAKE_PATTERNS) {
        const line = lines[i];
        const real = p.re.global ? [...line.matchAll(p.re)].some((m) => !PLACEHOLDER.test(secretPart(p.kind, m))) : p.re.test(line);
        if (real) hits.push({ field: field || "(body)", line: i + 1, kind: p.kind });
      }
  }
  return hits;
}

export const REFUSAL_RECEIPT_FORMAT = "refusal-v1";

/** sha256 of every customer string in the body, by field: what a refusal receipt signs (never the text). */
export async function fieldHashes(body: unknown): Promise<Record<string, string>> {
  const all: Array<[string, string]> = [];
  strings(body, "", 0, all);
  const out: Record<string, string> = {};
  for (const [f, t] of all.slice(0, 200)) out[f || "(body)"] = await sha256Hex(t);
  return out;
}

/** The signed "refused, not charged" result: route, label, where, the input's hashes, the policy's hash, the time. */
export async function refusalReceipt(
  env: { SIGNING_KEY?: string; PUBLIC_KEY?: string; CONTENT_POLICY_SHA256?: string },
  o: { route: string; label: string; step: "2a" | "2b"; hits?: IntakeHit[]; body: unknown; model?: string; charged: false | "already_settled" },
): Promise<Receipt> {
  const inputs = await fieldHashes(o.body);
  const payload: Record<string, unknown> = {
    receipt_format: REFUSAL_RECEIPT_FORMAT,
    route: o.route,
    refused: true,
    label: o.label,
    step: o.step,
    ...(o.hits?.length ? { where: o.hits.map((h) => ({ field: h.field, line: h.line, kind: h.kind })) } : {}),
    ...(o.model ? { screen_model: o.model } : {}),
    inputs_sha256: inputs,
    inputs_canonical_sha256: await sha256Hex(canonicalJson(inputs)),
    policy_sha256: env.CONTENT_POLICY_SHA256 || null,
    charged: o.charged,
    at: new Date().toISOString(),
  };
  return signReceipt(payload, env.SIGNING_KEY, env.PUBLIC_KEY);
}

const KIND_TEXT: Record<string, string> = Object.fromEntries(INTAKE_PATTERNS.map((p) => [p.kind, p.what]));

/** The 422 for a 2a hit. `after`: what the refusal means for this route (reviews: nothing charged). */
export async function intakeRefusal(env: any, route: string, body: unknown, hits: IntakeHit[], after: string, charged: false | "already_settled" = false): Promise<Response> {
  const where = hits.slice(0, 5).map((h) => `${h.field} line ${h.line} (${KIND_TEXT[h.kind] ?? h.kind})`).join("; ");
  const receipt = await refusalReceipt(env, { route, label: "secrets", step: "2a", hits, body, charged });
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
