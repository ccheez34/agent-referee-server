// Owner approvals: "one place to say yes" (research\specs\rules-in-code-2026-10-31\DESIGN.md part A). A small Worker
// apart from Agent Referee, with its own Ed25519 key and the owner's own token. The owner signs approvals here from his
// phone; every gate, from any AI company's session, reads them and checks them against the pinned public key. Sessions
// never hold the owner's token or the signing key, so they can't make one. The records are exactly the ones 3.0's gate
// checks: `agent-referee-owner-approval-v2` (agent-referee-mcp 0.6.0, gate/README.md, "The approval record part A must
// produce"): each approval names the seat it's for and is used once; several uses are several approvals.
// Deploying it, and setting its token, is the owner's (installing a server is on his owner-only list).

export const APPROVAL_FORMAT = "agent-referee-owner-approval-v2";
// The seven actions every gate policy keeps owner-only (the gate won't start without them; publishing is on his list,
// his "2. A", Oct 31, 12:16), and the default list: those plus tag, rollback and feature_on (3.0's policy template, Nov
// 3). /policy sets the policy's own list.
export const BASELINE_ACTIONS = ["deploy", "publish", "payment", "delete", "secret", "install", "rule_change"];
export const DEFAULT_ACTIONS = [...BASELINE_ACTIONS, "tag", "rollback", "feature_on"];
export type Action = string;
const ACTION_NAME = /^[a-z][a-z0-9_]{0,39}$/; // the gate policy's action names
export const MEMBER = /^[A-Za-z0-9._-]{1,40}$/; // a seat, as its gate's GATE_MEMBER names it
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{24,64}$/;
const VERSION = /^[A-Za-z0-9._:-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
// Printable ASCII only, so a target can't hide characters or run right to left on his phone (fresh read of c3b0b64, #7).
const TARGET = /^[\x20-\x7e]{1,200}$/;
const MAX_COUNT = 20; // approvals signed at once, each used once with its own nonce
const MAX_HOURS = 24; // at most a day here, even when the gate policy's approval_max_hours allows more
const KEEP_MS = 7 * 86_400_000; // approvals: 7 days past their expiry
// Revocations: 8 days past issue. An approval lasts at most a day, so its revocation is always kept at least as long.
const KEEP_REVOCATION_MS = 8 * 86_400_000;
// The store refuses new approvals past this many records on file (a record is on file until its keep time ends), so a
// revocation is never dropped to make room: the owner revokes or waits instead (review 2, Sonnet, Luna and Argon).
// Revocations aren't capped, but each needs an approval on file and an approval gets one revocation, so the list holds
// at most twice this; at about 600 bytes a record that's about 1.2 MB, under a SQLite-backed Durable Object's 2 MiB
// for one stored value (the re-check, Opus; the size is tested).
const MAX_RECORDS = 1000;
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
/** What the store keeps of the gate policy: its version, its seats (members), its owner-only actions, its longest approval. */
export type Policy = { version: string; members: string[]; actions: string[]; max_hours: number };
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
 * Checks an approval request against the policy; returns the fields to sign (without times, nonces and policy version)
 * or an error. The gate compares `target` and `target_sha256` exactly, so the exact version goes in one of them, for
 * example "agent-referee-server:production@<40-hex commit>", or a bundle's sha256 in target_sha256. An approval is used
 * once: `count` asks for that many, each with its own nonce (a standing "at most 3" is three approvals).
 */
export function parseApproval(body: any, policy: { members?: string[]; actions?: string[]; max_hours?: number } = {}): { ok: true; value: { action: Action; member: string; target: string; target_sha256: string | null; count: number; hours: number; request_id?: string } } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Send JSON." };
  const actions = policy.actions ?? DEFAULT_ACTIONS;
  if (typeof body.action !== "string" || !actions.includes(body.action)) return { ok: false, error: `action must be one of ${actions.join(", ")}.` };
  const member = typeof body.member === "string" ? body.member.trim() : "";
  if (!MEMBER.test(member)) return { ok: false, error: "member: the seat it's for, as its gate names it (for example 3.0): letters, digits, . _ -, at most 40." };
  if (policy.members && !policy.members.includes(member)) return { ok: false, error: `member must be one of the policy's seats: ${policy.members.join(", ")}.` };
  const target = typeof body.target === "string" ? body.target.trim() : "";
  if (!TARGET.test(target)) return { ok: false, error: "target: the exact thing, in plain letters, digits and punctuation, at most 200, for example agent-referee-server:production@<40-hex commit>." };
  let target_sha256: string | null = null;
  if (body.target_sha256 !== undefined && body.target_sha256 !== null && body.target_sha256 !== "") {
    const sha: string = typeof body.target_sha256 === "string" ? body.target_sha256.trim().toLowerCase() : "";
    if (!HEX64.test(sha)) return { ok: false, error: "target_sha256 must be 64 hex characters, or left empty." };
    target_sha256 = sha;
  }
  if (body.max_uses !== undefined && body.max_uses !== 1) return { ok: false, error: "An approval is used once (max_uses 1). For several uses, send count: that many approvals, each with its own nonce." };
  const count = body.count === undefined ? 1 : body.count;
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) return { ok: false, error: `count must be a whole number from 1 to ${MAX_COUNT}.` };
  const maxHours = Math.min(MAX_HOURS, policy.max_hours ?? MAX_HOURS);
  const hours = body.expires_in_hours === undefined ? Math.min(2, maxHours) : body.expires_in_hours;
  if (typeof hours !== "number" || !(hours >= 0.25 && hours <= maxHours)) return { ok: false, error: `expires_in_hours must be from 0.25 to ${maxHours} (the policy's approval_max_hours).` };
  if (body.request_id !== undefined && (typeof body.request_id !== "string" || !REQUEST_ID.test(body.request_id))) return { ok: false, error: "request_id: 8 to 64 letters, digits or dashes." };
  return { ok: true, value: { action: body.action, member, target, target_sha256, count, hours, ...(body.request_id ? { request_id: body.request_id } : {}) } };
}

/** Checks the gate policy's fields the store keeps; returns the policy or an error. */
export function parsePolicy(body: any): { ok: true; value: Policy } | { ok: false; error: string } {
  const version = typeof body?.version === "string" ? body.version.trim() : "";
  if (!VERSION.test(version)) return { ok: false, error: 'version must be the gate policy\'s "version": 1 to 64 letters, digits, or . _ : -' };
  const members = Array.isArray(body?.members) ? body.members.map((m: unknown) => (typeof m === "string" ? m.trim() : "")) : [];
  if (!members.length || members.length > 40 || members.some((m: string) => !MEMBER.test(m)) || new Set(members).size !== members.length)
    return { ok: false, error: 'members must list every seat, as the gate policy\'s "members" does (for example ["1.0", "2.0", "3.0"]): letters, digits, . _ -, each once.' };
  let actions = DEFAULT_ACTIONS;
  if (body?.actions !== undefined) {
    if (!Array.isArray(body.actions) || !body.actions.length || body.actions.length > 40 || body.actions.some((a: unknown) => typeof a !== "string" || !ACTION_NAME.test(a)) || new Set(body.actions).size !== body.actions.length)
      return { ok: false, error: "actions: the gate policy's owner-only action names (lower-case letters, digits, _), each once." };
    const missing = BASELINE_ACTIONS.filter((a) => !body.actions.includes(a));
    if (missing.length) return { ok: false, error: `actions must include ${missing.join(", ")}: every gate keeps them owner-only.` };
    actions = body.actions;
  }
  const max_hours = body?.approval_max_hours === undefined ? MAX_HOURS : body.approval_max_hours;
  if (!Number.isInteger(max_hours) || max_hours < 1 || max_hours > MAX_HOURS) return { ok: false, error: `approval_max_hours must be a whole number from 1 to ${MAX_HOURS}: the gate policy's, at most a day here.` };
  return { ok: true, value: { version, members, actions, max_hours } };
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
    const fresh = (list: Envelope[], now: number) =>
      list.filter((r) => (r.payload.type === "revocation" ? Date.parse(String(r.payload.issued_at)) > now - KEEP_REVOCATION_MS : Date.parse(String(r.payload.expires_at)) > now - KEEP_MS));
    if (action === "pubkey") return storeKey(this.state).then((s) => json(200, { public_key: s.publicKey }), (e) => json(503, { error: `Couldn't read the approvals key: ${String(e?.message ?? e).slice(0, 200)}.` }));
    // The store builds and signs every record itself: it never signs a payload it's handed, so no caller can get an
    // approval past the limits, the freeze or the policy version (fresh read of 1091ea5, #3). Each action runs as one
    // turn (blockConcurrencyWhile), so approvals, revocations and the freeze never interleave (#2). The key is fetched
    // first, because storeKey takes a turn of its own. Nothing throws out of a turn: an error there would reset the store.
    if (action === "approve") {
      let signer: Signer;
      try {
        signer = await storeKey(this.state);
      } catch (e: any) {
        return json(503, { error: `Couldn't read the approvals key: ${String(e?.message ?? e).slice(0, 200)}. Nothing was approved.` });
      }
      const out = await this.state.blockConcurrencyWhile(async () => {
        try {
          if (await st.get("frozen")) return { status: 409, body: { error: "Approvals are frozen. Unfreeze them first. Nothing was approved." } };
          const policy: Policy | undefined = await st.get("policy");
          if (!policy) return { status: 409, body: { error: "Set the policy first: POST /policy with the gate policy's version and members. Nothing was approved." } };
          // Checked against the stored policy, inside the turn that signs, so a policy change can't slip between them.
          const parsed = parseApproval(body, policy);
          if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
          const v = parsed.value;
          const now = this.now();
          const list = fresh((await st.get("records")) ?? [], now);
          const rids: Record<string, { nonces?: string[]; nonce?: string; at: number }> = Object.fromEntries(Object.entries((await st.get("rids")) ?? {}).filter(([, x]: any) => now - x.at < REQUEST_ID_MS)) as any;
          const hit = v.request_id ? rids[v.request_id] : undefined;
          const firsts = (hit ? (hit.nonces ?? (hit.nonce ? [hit.nonce] : [])) : []).map((n) => list.find((r) => r.payload.type === "approval" && r.payload.nonce === n)).filter(Boolean) as Envelope[];
          // A request id seen within the day whose approvals aren't on file any more never makes new ones (review 2).
          if (hit && !firsts.length) return { status: 409, body: { error: "This request id was already used today and its approvals are no longer on file. Send a new request id. Nothing new was approved." } };
          if (firsts.length) {
            // The same request again (a double tap) gets the first approvals back, but only if every field, the seat,
            // the count, the length and the policy version match, and they're still live; otherwise nothing is
            // approved (fresh read of 1091ea5, #1).
            const p = firsts[0].payload;
            const same = firsts.length === v.count && p.member === v.member && p.action === v.action && p.target === v.target && p.target_sha256 === v.target_sha256 && Date.parse(String(p.expires_at)) - Date.parse(String(p.issued_at)) === Math.round(v.hours * 3_600_000) && p.policy_version === policy.version;
            if (!same) return { status: 409, body: { error: "This request id was already used for a different approval, or under another policy version. Nothing new was approved." } };
            const revoked = firsts.some((f) => list.some((r) => r.payload.type === "revocation" && r.payload.nonce === f.payload.nonce));
            if (revoked || Date.parse(String(p.expires_at)) <= now) return { status: 409, body: { error: "This request id's approval was revoked or has expired. Send a new request id. Nothing new was approved." } };
            return { status: 200, body: { approval: firsts[0], approvals: firsts, repeat: true } };
          }
          if (list.length + v.count > MAX_RECORDS) return { status: 409, body: { error: `The store holds ${list.length} records of ${MAX_RECORDS}; nothing is dropped to make room. Revoke or let old approvals age out (7 days past expiry). Nothing was approved.` } };
          const issued_at = new Date(now).toISOString();
          const expires_at = new Date(now + Math.round(v.hours * 3_600_000)).toISOString();
          const records: Envelope[] = [];
          for (let i = 0; i < v.count; i++)
            records.push(await signRecord({ format: APPROVAL_FORMAT, type: "approval", member: v.member, action: v.action, target: v.target, target_sha256: v.target_sha256, policy_version: policy.version, issued_at, expires_at, nonce: hex(16), max_uses: 1 }, signer));
          // All signed before anything is stored, and the records and the request id stored in one atomic write: a
          // failure stores none of them, so "Nothing was approved" is true and a retry can't mint a second set (the
          // re-check, Opus and Luna).
          list.push(...records);
          await st.put({ records: list, rids: v.request_id ? { ...rids, [v.request_id]: { nonces: records.map((r) => String(r.payload.nonce)), at: now } } : rids });
          return { status: 200, body: { approval: records[0], approvals: records } };
        } catch (e: any) {
          return { status: 503, body: { error: `Couldn't sign or store the approval: ${String(e?.message ?? e).slice(0, 200)}. Nothing was approved.` } };
        }
      });
      return json(out.status, out.body);
    }
    // One nonce, or every live approval, revoked in one turn and stored in one write. An already-revoked approval gets
    // its earlier revocation back (part A review 1). If signing fails partway, what was signed is kept and counted.
    if (action === "revoke") {
      const all = body?.all === true;
      const one = typeof body?.nonce === "string" ? body.nonce.trim().toLowerCase() : "";
      if (!all && !NONCE.test(one)) return json(400, { error: 'Send {"nonce": "<the approval\'s nonce>"} or {"all": true}.' });
      let signer: Signer;
      try {
        signer = await storeKey(this.state);
      } catch (e: any) {
        return json(503, { error: `Couldn't read the approvals key: ${String(e?.message ?? e).slice(0, 200)}. Nothing was revoked.` });
      }
      const out = await this.state.blockConcurrencyWhile(async () => {
        try {
          const now = this.now();
          const list = fresh((await st.get("records")) ?? [], now);
          if (!all && !list.some((r) => r.payload.type === "approval" && r.payload.nonce === one))
            return { status: 404, body: { error: "No approval with that nonce is on file here. Nothing was revoked." } };
          const nonces = all ? live(list, now).map((r) => String(r.payload.nonce)) : [one];
          const done = new Map(list.filter((r) => r.payload.type === "revocation").map((r) => [r.payload.nonce, r]));
          const revocations: Envelope[] = [];
          let added = 0;
          let failed = "";
          for (const nonce of nonces) {
            const earlier = done.get(nonce);
            if (earlier) {
              revocations.push(earlier);
              continue;
            }
            try {
              const r = await signRecord({ format: APPROVAL_FORMAT, type: "revocation", nonce, issued_at: new Date(now).toISOString() }, signer);
              list.push(r);
              revocations.push(r);
              added++;
            } catch (e: any) {
              failed = String(e?.message ?? e).slice(0, 200);
              break;
            }
          }
          if (added) await st.put("records", list); // never trimmed: a revocation is never dropped to make room
          if (failed) return { status: 503, body: { error: `Couldn't sign: ${failed}. ${revocations.length} of ${nonces.length} revoked.`, revocations } };
          return { status: 200, body: all ? { revoked: revocations.length, revocations } : { revocation: revocations[0] } };
        } catch (e: any) {
          return { status: 503, body: { error: `Couldn't store the revocations: ${String(e?.message ?? e).slice(0, 200)}. Nothing was revoked.` } };
        }
      });
      return json(out.status, out.body);
    }
    // The gate reads {"approvals": [...]} and tells approvals and revocations apart by `type`.
    // The reads and the two settings, each one turn, each answering instead of throwing (review 2, Sonnet).
    const turn = (what: string, f: () => Promise<{ status: number; body: unknown }>) =>
      this.state.blockConcurrencyWhile(() => f().catch((e: any) => ({ status: 503, body: { error: `Couldn't ${what}: ${String(e?.message ?? e).slice(0, 200)}.` } }))).then((o: { status: number; body: unknown }) => json(o.status, o.body));
    if (action === "list")
      return turn("read the records", async () => {
        const policy: Policy | undefined = await st.get("policy");
        return { status: 200, body: { approvals: fresh((await st.get("records")) ?? [], this.now()), policy: policy ?? null, policy_version: policy?.version ?? null, frozen: !!(await st.get("frozen")) } };
      });
    if (action === "set-policy")
      return turn("store the policy", async () => {
        const parsed = parsePolicy(body);
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
        await st.put("policy", parsed.value);
        return { status: 200, body: { ok: true, policy: parsed.value } };
      });
    if (action === "freeze")
      return turn("store the freeze", async () => {
        await st.put("frozen", !!body.on);
        return { status: 200, body: { ok: true, frozen: !!body.on } };
      });
    return json(404, { error: "Unknown action." });
  }
}

const store = (env: Env) => env.APPROVALS.get(env.APPROVALS.idFromName("global"));
// The store's answer, status and all; a store that can't be reached or answers nothing readable is a 503 in words.
const ask = async (env: Env, action: string, body?: unknown): Promise<{ status: number; body: any }> => {
  try {
    const r = await store(env).fetch(`https://store/${action}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  } catch (e: any) {
    return { status: 503, body: { error: `The approvals store didn't answer: ${String(e?.message ?? e).slice(0, 200)}.` } };
  }
};
const pass = async (env: Env, action: string, body: unknown) => {
  const r = await ask(env, action, body);
  return json(r.status, r.body);
};

const live = (records: Envelope[], now: number) => {
  const revoked = new Set(records.filter((r) => r.payload.type === "revocation").map((r) => r.payload.nonce));
  return records.filter((r) => r.payload.type === "approval" && !revoked.has(r.payload.nonce) && Date.parse(String(r.payload.expires_at)) > now);
};

export async function handle(req: Request, env: Env, page: () => Response): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "GET" && path === "/") return page();
  if (req.method === "GET" && path === "/pubkey") {
    const k = await ask(env, "pubkey");
    if (k.status !== 200) return json(k.status, k.body);
    return json(200, { public_key: k.body.public_key, key_id: await keyIdOf(k.body.public_key), algorithm: "Ed25519" }, { "access-control-allow-origin": "*" });
  }
  // Anyone can read the records (DESIGN §3A): their signatures are what count, and gates send no token. While he has
  // frozen approvals, this answers 503, so every gate refuses every owner-only step (they fail closed).
  if (req.method === "GET" && path === "/approvals") {
    const l = await ask(env, "list");
    if (l.status !== 200) return json(503, { error: "The approvals record can't be read right now; gates refuse until it can.", code: "unavailable" });
    if (l.body.frozen) return json(503, { error: "frozen: the owner has frozen all approvals. Nothing is approved until he unfreezes them.", code: "frozen" });
    return json(200, { approvals: l.body.approvals }); // exactly what the gate reads (review 2, Sonnet)
  }
  if (req.method !== "POST" || !["/approve", "/revoke", "/policy", "/freeze", "/status"].includes(path)) return json(404, { error: "Not found." });
  // The owner's token, compared in constant time. No lockout: a token of 32 or more random characters can't be guessed,
  // and a lockout let anyone stop him from revoking (fresh read of c3b0b64, #1).
  if (!(await sameToken(env.OWNER_TOKEN, bearer(req)))) return json(401, { error: env.OWNER_TOKEN ? "That isn't the owner's token." : "No owner token is set on this service." });
  const now = Date.now();
  const body: any = await req.json().catch(() => null);
  if (path === "/status") {
    const l = await ask(env, "list");
    if (l.status !== 200) return json(l.status, l.body);
    return json(200, { frozen: l.body.frozen, policy: l.body.policy, policy_version: l.body.policy_version, live: live(l.body.approvals, now), records: l.body.approvals.length, max_records: MAX_RECORDS });
  }
  if (path === "/freeze") {
    if (typeof body?.on !== "boolean") return json(400, { error: 'Send {"on": true} to freeze every approval, or {"on": false} to unfreeze.' });
    const f = await ask(env, "freeze", { on: body.on });
    return f.status === 200 ? json(200, { frozen: body.on }) : json(f.status, f.body);
  }
  if (path === "/policy") {
    // The gate policy's version (an approval made under another one doesn't count), its seats, its owner-only actions
    // and its approval_max_hours, as the owner copies them from the policy file. Checked again inside the store.
    const parsed = parsePolicy(body);
    if (!parsed.ok) return json(400, { error: parsed.error });
    return pass(env, "set-policy", parsed.value);
  }
  // Revoking and approving are decided inside the store, in one turn each (fresh read of 1091ea5, #2 and #3).
  if (path === "/revoke") return pass(env, "revoke", body);
  return pass(env, "approve", body);
}
