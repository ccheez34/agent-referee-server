// Owner approvals: "one place to say yes" (research\specs\rules-in-code-2026-10-31\DESIGN.md part A). A small Worker
// apart from Agent Referee, with its own Ed25519 key and the owner's own token. The owner signs approvals here from his
// phone; every gate, from any AI company's session, reads them and checks them against the pinned public key. Sessions
// never hold the owner's token or the signing key, so they can't make one. The records are exactly the ones 3.0's gate
// checks: `agent-referee-owner-approval-v1` (agent-referee-mcp, branch gate-v0, gate/README.md; 2.0's 1126).
// Deploying it, and setting its token, is the owner's (installing a server is on his owner-only list).

export const APPROVAL_FORMAT = "agent-referee-owner-approval-v1";
// The gate policy's owner-only actions. Whether publishing stays owner-only is the owner's call; approving one only adds
// a way to say yes.
export const ACTIONS = ["deploy", "publish", "payment", "delete", "secret", "install", "rule_change"] as const;
export type Action = (typeof ACTIONS)[number];
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{24,64}$/;
const VERSION = /^[A-Za-z0-9._:-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
// Printable ASCII only, so a target can't hide characters or run right to left on his phone (fresh read of c3b0b64, #7).
const TARGET = /^[\x20-\x7e]{1,200}$/;
const MAX_USES = 20;
const MAX_HOURS = 24;
const KEEP_MS = 7 * 86_400_000; // approvals: 7 days past their expiry
// Revocations: 8 days past issue. An approval lasts at most a day, so its revocation is always kept at least as long.
const KEEP_REVOCATION_MS = 8 * 86_400_000;
const MAX_RECORDS = 500;
const REQUEST_ID_MS = 86_400_000;

export interface Env {
  APPROVALS: DurableObjectNamespace;
  // Secret: 32 or more random characters, set from his phone in Cloudflare's dashboard; never typed on the PC where
  // sessions run. There's no key secret: the signing key is made inside the Worker's own store (signer, below).
  OWNER_TOKEN?: string;
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
const unb64url = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (s: string | Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", typeof s === "string" ? enc.encode(s) : s))].map((x) => x.toString(16).padStart(2, "0")).join("");
export const keyIdOf = async (publicKeyB64: string) => (await sha256Hex(unb64(publicKeyB64))).slice(0, 16);

export type Envelope = { payload: Record<string, unknown>; signature: string; algorithm: "Ed25519"; public_key: string };
export type Signer = { key: CryptoKey; publicKey: string };

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

/**
 * The approvals key lives only in the store (one Durable Object), made there the first time it's needed: no key file,
 * no secret to paste, and the public key it signs with can't drift from the one it serves (fresh read of c3b0b64, #2
 * and #4). The store signs; the private key never leaves it, not even to the Worker (part A review 1, Sonnet and Luna).
 */
async function storeKey(state: any): Promise<Signer> {
  const jwk = await state.blockConcurrencyWhile(async () => {
    let k = await state.storage.get("key");
    if (!k) {
      const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
      k = await crypto.subtle.exportKey("jwk", kp.privateKey);
      await state.storage.put("key", k);
    }
    return k;
  });
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  return { key, publicKey: b64(unb64url(String(jwk.x))) };
}

/** Signs a record, then checks it with the same public key before anyone sees it or it's stored. */
export async function signRecord(payload: Record<string, unknown>, s: Signer): Promise<Envelope> {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, s.key, enc.encode(canonicalJson(payload)));
  const record: Envelope = { payload, signature: b64(sig), algorithm: "Ed25519", public_key: s.publicKey };
  if (!(await verifyRecord(record, s.publicKey))) throw new Error("the record didn't verify with the approvals key");
  return record;
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
export function parseApproval(body: any): { ok: true; value: { action: Action; target: string; target_sha256: string | null; max_uses: number; hours: number; request_id?: string } } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Send JSON." };
  if (!ACTIONS.includes(body.action)) return { ok: false, error: `action must be one of ${ACTIONS.join(", ")}.` };
  const target = typeof body.target === "string" ? body.target.trim() : "";
  if (!TARGET.test(target)) return { ok: false, error: "target: the exact thing, in plain letters, digits and punctuation, at most 200, for example agent-referee-server:production@<40-hex commit>." };
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
  if (body.request_id !== undefined && (typeof body.request_id !== "string" || !REQUEST_ID.test(body.request_id))) return { ok: false, error: "request_id: 8 to 64 letters, digits or dashes." };
  return { ok: true, value: { action: body.action, target, target_sha256, max_uses, hours, ...(body.request_id ? { request_id: body.request_id } : {}) } };
}

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
    const fresh = (list: Envelope[]) =>
      list.filter((r) => (r.payload.type === "revocation" ? Date.parse(String(r.payload.issued_at)) > now - KEEP_REVOCATION_MS : Date.parse(String(r.payload.expires_at)) > now - KEEP_MS));
    if (action === "pubkey") return json(200, { public_key: (await storeKey(this.state)).publicKey });
    // Signs a payload the Worker built, checks it with the same key, and hands back only the envelope.
    if (action === "sign") {
      try {
        return json(200, { record: await signRecord(body.payload, await storeKey(this.state)) });
      } catch (e: any) {
        return json(503, { error: String(e?.message ?? e) });
      }
    }
    if (action === "find-request") {
      const rids: Record<string, { nonce: string; at: number }> = (await st.get("rids")) ?? {};
      const hit = rids[body.request_id];
      const record = hit && now - hit.at < REQUEST_ID_MS ? fresh((await st.get("records")) ?? []).find((r) => r.payload.type === "approval" && r.payload.nonce === hit.nonce) : undefined;
      return json(200, { record: record ?? null });
    }
    if (action === "add") {
      // One add at a time (blockConcurrencyWhile), so a repeated request id always finds the first record, and a freeze
      // that lands after the Worker's own check still stops a new approval (part A review 1, Luna and Sonnet).
      const out = await this.state.blockConcurrencyWhile(async () => {
        const list: Envelope[] = fresh((await st.get("records")) ?? []);
        const isApproval = body.record?.payload?.type === "approval";
        if (isApproval && (await st.get("frozen"))) return { frozen: true };
        const rid: string | undefined = body.request_id;
        let rids: Record<string, { nonce: string; at: number }> = {};
        if (rid) {
          rids = Object.fromEntries(Object.entries((await st.get("rids")) ?? {}).filter(([, v]: any) => now - v.at < REQUEST_ID_MS)) as any;
          const first = rids[rid] && list.find((r) => r.payload.type === "approval" && r.payload.nonce === rids[rid].nonce);
          if (first) return { ok: true, existing: first };
        }
        list.push(body.record);
        await st.put("records", list.slice(-MAX_RECORDS));
        if (rid) await st.put("rids", { ...rids, [rid]: { nonce: String(body.record.payload.nonce), at: now } });
        return { ok: true };
      });
      return json(200, out);
    }
    // The gate reads {"approvals": [...]} and tells approvals and revocations apart by `type`.
    if (action === "list")
      return json(200, { approvals: fresh((await st.get("records")) ?? []), policy_version: (await st.get("policy_version")) ?? null, frozen: !!(await st.get("frozen")) });
    if (action === "set-policy") {
      await st.put("policy_version", body.version);
      return json(200, { ok: true });
    }
    if (action === "freeze") {
      await st.put("frozen", !!body.on);
      return json(200, { ok: true });
    }
    return json(404, { error: "Unknown action." });
  }
}

const store = (env: Env) => env.APPROVALS.get(env.APPROVALS.idFromName("global"));
const call = async (env: Env, action: string, body?: unknown) =>
  (await store(env).fetch(`https://store/${action}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;

const live = (records: Envelope[], now: number) => {
  const revoked = new Set(records.filter((r) => r.payload.type === "revocation").map((r) => r.payload.nonce));
  return records.filter((r) => r.payload.type === "approval" && !revoked.has(r.payload.nonce) && Date.parse(String(r.payload.expires_at)) > now);
};

export async function handle(req: Request, env: Env, page: () => Response): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "GET" && path === "/") return page();
  if (req.method === "GET" && path === "/pubkey") {
    const { public_key } = await call(env, "pubkey");
    return json(200, { public_key, key_id: await keyIdOf(public_key), algorithm: "Ed25519" }, { "access-control-allow-origin": "*" });
  }
  // Anyone can read the records (DESIGN §3A): their signatures are what count, and gates send no token. While he has
  // frozen approvals, this answers 503, so every gate refuses every owner-only step (they fail closed).
  if (req.method === "GET" && path === "/approvals") {
    const l = await call(env, "list");
    if (l.frozen) return json(503, { error: "frozen: the owner has frozen all approvals. Nothing is approved until he unfreezes them.", code: "frozen" });
    return json(200, { approvals: l.approvals, policy_version: l.policy_version });
  }
  if (req.method !== "POST" || !["/approve", "/revoke", "/policy", "/freeze", "/status"].includes(path)) return json(404, { error: "Not found." });
  // The owner's token, compared in constant time. No lockout: a token of 32 or more random characters can't be guessed,
  // and a lockout let anyone stop him from revoking (fresh read of c3b0b64, #1).
  if (!(await sameToken(env.OWNER_TOKEN, bearer(req)))) return json(401, { error: env.OWNER_TOKEN ? "That isn't the owner's token." : "No owner token is set on this service." });
  const now = Date.now();
  const body: any = await req.json().catch(() => null);
  if (path === "/status") {
    const l = await call(env, "list");
    return json(200, { frozen: l.frozen, policy_version: l.policy_version, live: live(l.approvals, now) });
  }
  if (path === "/freeze") {
    if (typeof body?.on !== "boolean") return json(400, { error: 'Send {"on": true} to freeze every approval, or {"on": false} to unfreeze.' });
    await call(env, "freeze", { on: body.on });
    return json(200, { frozen: body.on });
  }
  if (path === "/policy") {
    // The gate policy's `version`: an approval made under another version doesn't count.
    const version = typeof body?.version === "string" ? body.version.trim() : "";
    if (!VERSION.test(version)) return json(400, { error: 'version must be the gate policy\'s "version": 1 to 64 letters, digits, or . _ : -' });
    await call(env, "set-policy", { version });
    return json(200, { ok: true, policy_version: version });
  }
  if (path === "/revoke") {
    const { approvals } = await call(env, "list");
    let nonces: string[];
    if (body?.all === true) nonces = live(approvals, now).map((r) => String(r.payload.nonce));
    else {
      const nonce = typeof body?.nonce === "string" ? body.nonce.trim().toLowerCase() : "";
      if (!NONCE.test(nonce)) return json(400, { error: 'Send {"nonce": "<the approval\'s nonce>"} or {"all": true}.' });
      // A mistyped nonce would revoke nothing, so say so instead of signing it.
      if (!approvals.some((r: Envelope) => r.payload.type === "approval" && r.payload.nonce === nonce))
        return json(404, { error: "No approval with that nonce is on file here. Nothing was revoked." });
      nonces = [nonce];
    }
    // An approval that's already revoked gets its revocation back, not another one (part A review 1, Sonnet).
    const done = new Map(approvals.filter((r: Envelope) => r.payload.type === "revocation").map((r: Envelope) => [r.payload.nonce, r]));
    const revocations: Envelope[] = [];
    for (const nonce of nonces) {
      const earlier = done.get(nonce);
      if (earlier) {
        revocations.push(earlier as Envelope);
        continue;
      }
      const signed = await call(env, "sign", { payload: { format: APPROVAL_FORMAT, type: "revocation", nonce, issued_at: new Date(now).toISOString() } });
      if (!signed.record) return json(503, { error: `Couldn't sign: ${signed.error ?? "unknown"}. ${revocations.length} of ${nonces.length} revoked.`, revocations });
      await call(env, "add", { record: signed.record });
      revocations.push(signed.record);
    }
    return json(200, body?.all === true ? { revoked: revocations.length, revocations } : { revocation: revocations[0] });
  }
  const parsed = parseApproval(body);
  if (!parsed.ok) return json(400, { error: parsed.error });
  const v = parsed.value;
  const l = await call(env, "list");
  if (l.frozen) return json(409, { error: "Approvals are frozen. Unfreeze them first. Nothing was approved." });
  if (!l.policy_version) return json(409, { error: "Set the policy version first: POST /policy with the gate policy's version." });
  // The same request sent twice (a double tap) gives the first approval back, not a second one (fresh read, #3). The
  // same id with different fields is refused, not answered with the old approval (part A review 1, Sonnet).
  const same = (r: Envelope) => r.payload.action === v.action && r.payload.target === v.target && r.payload.target_sha256 === v.target_sha256 && r.payload.max_uses === v.max_uses;
  const repeat = (r: Envelope) => (same(r) ? json(200, { approval: r, repeat: true }) : json(409, { error: "This request id was already used for a different approval. Nothing new was approved." }));
  if (v.request_id) {
    const earlier = (await call(env, "find-request", { request_id: v.request_id })).record;
    if (earlier) return repeat(earlier);
  }
  const payload = {
    format: APPROVAL_FORMAT,
    type: "approval",
    action: v.action,
    target: v.target,
    target_sha256: v.target_sha256,
    policy_version: l.policy_version,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + Math.round(v.hours * 3_600_000)).toISOString(),
    nonce: hex(16),
    max_uses: v.max_uses,
  };
  const signed = await call(env, "sign", { payload });
  if (!signed.record) return json(503, { error: `Couldn't sign: ${signed.error ?? "unknown"}. Nothing was approved.` });
  const record: Envelope = signed.record;
  const added = await call(env, "add", { record, ...(v.request_id ? { request_id: v.request_id } : {}) });
  if (added.frozen) return json(409, { error: "Approvals are frozen. Unfreeze them first. Nothing was approved." });
  if (added.existing) return repeat(added.existing);
  return json(200, { approval: record });
}
