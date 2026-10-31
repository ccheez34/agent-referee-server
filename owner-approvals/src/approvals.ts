// Owner approvals: "one place to say yes" (research\specs\rules-in-code-2026-10-31\DESIGN.md part A, and
// APPROVALS-FORMAT.md v1). A small Worker apart from Agent Referee, with its own Ed25519 key and the owner's own token.
// The owner signs approvals here from his phone; every gate, from any AI company's session, reads them and checks them
// against the pinned public key. Sessions never hold the owner's token or the signing key, so they can't make one.
// Deploying it, and setting its secrets, is the owner's (installing a server is on his owner-only list).

export const ACTIONS = ["deploy", "payment", "delete", "secret", "install", "rule_change"] as const;
export type Action = (typeof ACTIONS)[number];
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const NAME = /^[A-Za-z0-9_.:\/-]{1,100}$/;
const MAX_USES = 20;
const MAX_HOURS = 24;
const KEEP_EXPIRED_MS = 7 * 86_400_000;
const MAX_RECORDS = 500;

export interface Env {
  APPROVALS: DurableObjectNamespace;
  OWNER_TOKEN?: string; // secret, 32+ characters, typed on his phone; never stored on the PC where sessions run
  READ_TOKEN?: string; // secret (optional): when set, GET /approvals needs it (sessions and gates hold this one)
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

/** Checks an approval request; returns the fields to sign (without times, ids and the policy version) or an error. */
export function parseApproval(body: any): { ok: true; value: { action: Action; target: string; target_ref: Record<string, string>; uses: number; hours: number; note?: string } } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Send JSON." };
  if (!ACTIONS.includes(body.action)) return { ok: false, error: `action must be one of ${ACTIONS.join(", ")}.` };
  const target = typeof body.target === "string" ? body.target.trim() : "";
  if (!target || target.length > 200) return { ok: false, error: "target: say what this applies to, in at most 200 characters." };
  const ref = body.target_ref;
  let target_ref: Record<string, string>;
  if (ref && typeof ref.commit === "string" && Object.keys(ref).length === 1) {
    const commit = ref.commit.trim().toLowerCase();
    if (!HEX40.test(commit)) return { ok: false, error: "target_ref.commit must be the full 40-hex commit." };
    target_ref = { commit };
  } else if (ref && typeof ref.sha256 === "string" && Object.keys(ref).length === 1) {
    const sha256 = ref.sha256.trim().toLowerCase();
    if (!HEX64.test(sha256)) return { ok: false, error: "target_ref.sha256 must be 64 hex characters." };
    target_ref = { sha256 };
  } else if (ref && typeof ref.name === "string" && Object.keys(ref).length === 1) {
    const name = ref.name.trim();
    if (!NAME.test(name)) return { ok: false, error: "target_ref.name: letters, digits and _ . : / - only, at most 100." };
    target_ref = { name };
  } else return { ok: false, error: 'target_ref must be exactly one of {"commit"}, {"sha256"} or {"name"}.' };
  const uses = body.uses === undefined ? 1 : body.uses;
  if (!Number.isInteger(uses) || uses < 1 || uses > MAX_USES) return { ok: false, error: `uses must be a whole number from 1 to ${MAX_USES}.` };
  const hours = body.expires_in_hours === undefined ? 2 : body.expires_in_hours;
  if (typeof hours !== "number" || !(hours >= 0.25 && hours <= MAX_HOURS)) return { ok: false, error: `expires_in_hours must be from 0.25 to ${MAX_HOURS}.` };
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 200)) return { ok: false, error: "note: at most 200 characters." };
  return { ok: true, value: { action: body.action, target, target_ref, uses, hours, ...(body.note ? { note: body.note } : {}) } };
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

/** One store for every record (a single Durable Object), so the list and the revocations are never split. */
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
    const fresh = (list: Envelope[]) => list.filter((r) => Date.parse(String(r.payload.expires_at ?? r.payload.issued_at)) > now - KEEP_EXPIRED_MS);
    if (action === "add-approval" || action === "add-revocation") {
      const k = action === "add-approval" ? "approvals" : "revocations";
      const list: Envelope[] = fresh((await st.get(k)) ?? []);
      list.push(body.record);
      await st.put(k, list.slice(-MAX_RECORDS));
      return json(200, { ok: true });
    }
    if (action === "list") return json(200, { approvals: fresh((await st.get("approvals")) ?? []), revocations: fresh((await st.get("revocations")) ?? []), policy_version: (await st.get("policy_version")) ?? null });
    if (action === "set-policy") {
      await st.put("policy_version", body.sha256);
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
  if (req.method === "GET" && path === "/approvals") {
    if (env.READ_TOKEN && !(await sameToken(env.READ_TOKEN, bearer(req)))) return json(401, { error: "Send the read token as Authorization: Bearer." });
    return json(200, await call(env, "list"));
  }
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
    const sha256 = typeof body?.sha256 === "string" ? body.sha256.trim().toLowerCase() : "";
    if (!HEX64.test(sha256)) return json(400, { error: "sha256 must be the 64-hex sha256 of the RULES.md in force." });
    await call(env, "set-policy", { sha256 });
    return json(200, { ok: true, policy_version: sha256 });
  }
  if (path === "/revoke") {
    const nonce = typeof body?.nonce === "string" ? body.nonce.trim().toLowerCase() : "";
    if (!HEX32.test(nonce)) return json(400, { error: "nonce must be the 32-hex nonce of the approval to revoke." });
    const record = await signRecord({ record_format: "owner-revocation-v1", revokes_nonce: nonce, issued_at: new Date(now).toISOString(), nonce: hex(16) }, env);
    await call(env, "add-revocation", { record });
    return json(200, { revocation: record });
  }
  const parsed = parseApproval(body);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const policy = (await call(env, "get-policy")).policy_version;
  if (!policy) return json(409, { error: "Set the policy version first: POST /policy with the sha256 of the RULES.md in force." });
  const v = parsed.value;
  const payload = {
    record_format: "owner-approval-v1",
    approval_id: hex(12),
    action: v.action,
    target: v.target,
    target_ref: v.target_ref,
    uses: v.uses,
    policy_version: policy,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + Math.round(v.hours * 3_600_000)).toISOString(),
    nonce: hex(16),
    ...(v.note ? { note: v.note } : {}),
  };
  let record: Envelope;
  try {
    record = await signRecord(payload, env);
  } catch (e: any) {
    return json(503, { error: `Couldn't sign: ${String(e?.message ?? e)}. Nothing was approved.` });
  }
  await call(env, "add-approval", { record });
  return json(200, { approval: record });
}

/** Tests only. */
export const _resetFailures = () => (failures = { at: 0, n: 0 });
