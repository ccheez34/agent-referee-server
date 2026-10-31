// Owner approvals: "one place to say yes" (research\specs\rules-in-code-2026-10-31\DESIGN.md part A). A small Worker
// apart from Agent Referee, with its own Ed25519 key and the owner's own token. The owner signs approvals here from his
// phone; every gate, from any AI company's session, reads them and checks them against the pinned public key. Sessions
// never hold the owner's token or the signing key, so they can't make one. The records are exactly the ones 3.0's gate
// checks: `agent-referee-owner-approval-v1` (agent-referee-mcp, branch gate-v0, gate/README.md; 2.0's 1126).
// Deploying it, and setting its secrets, is the owner's (installing a server is on his owner-only list).

export const APPROVAL_FORMAT = "agent-referee-owner-approval-v1";
// The gate policy's owner-only actions. Whether publishing stays owner-only is the owner's call; approving one only adds
// a way to say yes.
export const ACTIONS = ["deploy", "publish", "payment", "delete", "secret", "install", "rule_change"] as const;
export type Action = (typeof ACTIONS)[number];
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{24,64}$/;
const VERSION = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_USES = 20;
const MAX_HOURS = 24;
const KEEP_MS = 7 * 86_400_000;
const MAX_RECORDS = 500;

export interface Env {
  APPROVALS: DurableObjectNamespace;
  OWNER_TOKEN?: string; // secret, 32+ characters, typed on his phone; never stored on the PC where sessions run
  APPROVALS_SIGNING_KEY?: string; // secret: base64 PKCS#8 Ed25519 private key
  APPROVALS_PUBLIC_KEY?: string; // base64 raw 32-byte public key (also served at GET /pubkey)
}

/** Agent Referee's rule (src/logic.ts): keys sorted by UTF-16 code units, undefined dropped, no whitespace. */
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

const enc = new TextEncoder();
const b64 = (u: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(u instanceof Uint8Array ? u : new Uint8Array(u))));
const unb64 = (s: string) => Uint8Array.from(atob(s.trim()), (ch) => ch.charCodeAt(0));
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (s: string | Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", typeof s === "string" ? enc.encode(s) : s))].map((x) => x.toString(16).padStart(2, "0")).join("");
export const keyIdOf = async (publicKeyB64: string) => (await sha256Hex(unb64(publicKeyB64))).slice(0, 16);

export type Envelope = { payload: Record<string, unknown>; signature: string; algorithm: "Ed25519"; public_key: string };

export async function signRecord(payload: Record<string, unknown>, env: Env): Promise<Envelope> {
  if (!env.APPROVALS_SIGNING_KEY || !env.APPROVALS_PUBLIC_KEY) throw new Error("the approvals key isn't set");
  const key = await crypto.subtle.importKey("pkcs8", unb64(env.APPROVALS_SIGNING_KEY), { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(canonicalJson(payload)));
  return { payload, signature: b64(sig), algorithm: "Ed25519", public_key: env.APPROVALS_PUBLIC_KEY.trim() };
}

/** For gates and tests: true only when the record was signed by the pinned key (the envelope's own key is ignored). */
export async function verifyRecord(r: Envelope, pinnedPublicKeyB64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", unb64(pinnedPublicKeyB64), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, unb64(r.signature), enc.encode(canonicalJson(r.payload)));
  } catch {
    return false;
  }
}

/**
 * Checks an approval request; returns the fields to sign (without times, nonce and policy version) or an error. The
 * gate compares `target` and `target_sha256` exactly, so the exact version goes in one of them, for example
 * "agent-referee-server:production@<40-hex commit>", or a bundle's sha256 in target_sha256.
 */
export function parseApproval(body: any): { ok: true; value: { action: Action; target: string; target_sha256: string | null; max_uses: number; hours: number } } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Send JSON." };
  if (!ACTIONS.includes(body.action)) return { ok: false, error: `action must be one of ${ACTIONS.join(", ")}.` };
  const target = typeof body.target === "string" ? body.target.trim() : "";
  if (!target || target.length > 200 || /[\u0000-\u001f\u007f]/.test(target))
    return { ok: false, error: "target: the exact thing, on one line and at most 200 characters, for example agent-referee-server:production@<40-hex commit>." };
  let target_sha256: string | null = null;
  if (body.target_sha256 !== undefined && body.target_sha256 !== null && body.target_sha256 !== "") {
    const sha: string = typeof body.target_sha256 === "string" ? body.target_sha256.trim().toLowerCase() : "";
    if (!HEX64.test(sha)) return { ok: false, error: "target_sha256 must be 64 hex characters, or left empty." };
    target_sha256 = sha;
  }
  const max_uses = body.max_uses === undefined ? 1 : body.max_uses;
  if (!Number.isInteger(max_uses) || max_uses < 1 || max_uses > MAX_USES) return { ok: false, error: `max_uses must be a whole number from 1 to ${MAX_USES}.` };
  const hours = body.expires_in_hours === undefined ? 2 : body.expires_in_hours;
  if (typeof hours !== "number" || !(hours >= 0.25 && hours <= MAX_HOURS)) return { ok: false, error: `expires_in_hours must be from 0.25 to ${MAX_HOURS}.` };
  return { ok: true, value: { action: body.action, target, target_sha256, max_uses, hours } };
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

/** Constant-time check: both sides hashed, then compared byte by byte. No token configured means no access. */
async function sameToken(configured: string | undefined, sent: string | undefined): Promise<boolean> {
  if (!configured || configured.length < 32 || !sent) return false;
  const [a, b] = await Promise.all([sha256Hex(configured), sha256Hex(sent)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const bearer = (req: Request) => (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") || undefined;

/** One store and one list for every record (a single Durable Object), so approvals and revocations are never split. */
export class ApprovalStore {
  state: any;
  now: () => number = () => Date.now();
  constructor(state: any) {
    this.state = state;
  }
  async fetch(req: Request): Promise<Response> {
    const action = new URL(req.url).pathname.slice(1);
    const st = this.state.storage;
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const now = this.now();
    // Approvals are kept 7 days past expiry, revocations 7 days past issue (an approval lasts at most 24 hours).
    const fresh = (list: Envelope[]) => list.filter((r) => Date.parse(String(r.payload.expires_at ?? r.payload.issued_at)) > now - KEEP_MS);
    if (action === "add") {
      const list: Envelope[] = fresh((await st.get("records")) ?? []);
      list.push(body.record);
      await st.put("records", list.slice(-MAX_RECORDS));
      return json(200, { ok: true });
    }
    // The gate reads {"approvals": [...]} and tells approvals and revocations apart by `type`.
    if (action === "list") return json(200, { approvals: fresh((await st.get("records")) ?? []), policy_version: (await st.get("policy_version")) ?? null });
    if (action === "set-policy") {
      await st.put("policy_version", body.version);
      return json(200, { ok: true });
    }
    if (action === "get-policy") return json(200, { policy_version: (await st.get("policy_version")) ?? null });
    return json(404, { error: "Unknown action." });
  }
}

const store = (env: Env) => env.APPROVALS.get(env.APPROVALS.idFromName("global"));
const call = async (env: Env, action: string, body?: unknown) =>
  (await store(env).fetch(`https://store/${action}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;

let failures: { at: number; n: number } = { at: 0, n: 0 };

export async function handle(req: Request, env: Env, page: () => Response): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "GET" && path === "/") return page();
  if (req.method === "GET" && path === "/pubkey") {
    if (!env.APPROVALS_PUBLIC_KEY) return json(503, { error: "The approvals key isn't set yet." });
    return json(200, { public_key: env.APPROVALS_PUBLIC_KEY.trim(), key_id: await keyIdOf(env.APPROVALS_PUBLIC_KEY), algorithm: "Ed25519" }, { "access-control-allow-origin": "*" });
  }
  // Anyone can read the records (DESIGN §3A): their signatures are what count, and gates send no token.
  if (req.method === "GET" && path === "/approvals") return json(200, await call(env, "list"));
  if (req.method !== "POST" || !["/approve", "/revoke", "/policy"].includes(path)) return json(404, { error: "Not found." });
  // The owner's token. Repeated wrong tokens slow everyone down for a while, in this Worker instance.
  const now = Date.now();
  if (now - failures.at > 600_000) failures = { at: now, n: 0 };
  if (failures.n >= 10) return json(429, { error: "Too many wrong tokens; wait 10 minutes." });
  if (!(await sameToken(env.OWNER_TOKEN, bearer(req)))) {
    failures.n++;
    return json(401, { error: env.OWNER_TOKEN ? "That isn't the owner's token." : "No owner token is set on this service." });
  }
  const body: any = await req.json().catch(() => null);
  if (path === "/policy") {
    // The gate policy's `version`: an approval made under another version doesn't count.
    const version = typeof body?.version === "string" ? body.version.trim() : "";
    if (!VERSION.test(version)) return json(400, { error: 'version must be the gate policy\'s "version": 1 to 64 letters, digits, or . _ : -' });
    await call(env, "set-policy", { version });
    return json(200, { ok: true, policy_version: version });
  }
  if (path === "/revoke") {
    const nonce = typeof body?.nonce === "string" ? body.nonce.trim().toLowerCase() : "";
    if (!NONCE.test(nonce)) return json(400, { error: "nonce must be the approval's nonce: 24 to 64 hex characters." });
    const { approvals } = await call(env, "list");
    // A mistyped nonce would revoke nothing, so say so instead of signing it.
    if (!approvals.some((r: Envelope) => r.payload.type === "approval" && r.payload.nonce === nonce))
      return json(404, { error: "No approval with that nonce is on file here. Nothing was revoked." });
    let record: Envelope;
    try {
      record = await signRecord({ format: APPROVAL_FORMAT, type: "revocation", nonce, issued_at: new Date(now).toISOString() }, env);
    } catch (e: any) {
      return json(503, { error: `Couldn't sign: ${String(e?.message ?? e)}. Nothing was revoked.` });
    }
    await call(env, "add", { record });
    return json(200, { revocation: record });
  }
  const parsed = parseApproval(body);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const policy = (await call(env, "get-policy")).policy_version;
  if (!policy) return json(409, { error: "Set the policy version first: POST /policy with the gate policy's version." });
  const v = parsed.value;
  const payload = {
    format: APPROVAL_FORMAT,
    type: "approval",
    action: v.action,
    target: v.target,
    target_sha256: v.target_sha256,
    policy_version: policy,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + Math.round(v.hours * 3_600_000)).toISOString(),
    nonce: hex(16),
    max_uses: v.max_uses,
  };
  let record: Envelope;
  try {
    record = await signRecord(payload, env);
  } catch (e: any) {
    return json(503, { error: `Couldn't sign: ${String(e?.message ?? e)}. Nothing was approved.` });
  }
  await call(env, "add", { record });
  return json(200, { approval: record });
}

/** Tests only. */
export const _resetFailures = () => (failures = { at: 0, n: 0 });
