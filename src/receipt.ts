// Signed receipts: Ed25519 over the canonical JSON of the result.
import { canonicalJson } from "./logic.ts";

const enc = new TextEncoder();

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.trim());
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}

export type Receipt = {
  payload: Record<string, unknown>;
  payload_canonical_sha256?: string;
  signature: string | null; // base64 Ed25519 signature of canonicalJson(payload)
  algorithm: "Ed25519";
  public_key: string | null; // base64 raw 32-byte key, also served at GET /pubkey
};

let cached: { key: CryptoKey; pub: string } | null = null;

async function loadKey(pkcs8B64: string, pubB64: string) {
  if (cached) return cached;
  const key = await crypto.subtle.importKey("pkcs8", b64ToBytes(pkcs8B64), { name: "Ed25519" }, false, ["sign"]);
  cached = { key, pub: pubB64.trim() };
  return cached;
}

export async function signReceipt(
  payload: Record<string, unknown>,
  signingKey?: string,
  publicKey?: string,
): Promise<Receipt> {
  if (!signingKey || !publicKey) {
    // Still return the payload so local testing works; production should always set the secrets.
    return { payload, signature: null, algorithm: "Ed25519", public_key: null };
  }
  const { key, pub } = await loadKey(signingKey, publicKey);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(canonicalJson(payload)));
  return { payload, signature: bytesToB64(sig), algorithm: "Ed25519", public_key: pub };
}

export async function verifyReceipt(r: Receipt, publicKeyB64: string): Promise<boolean> {
  if (!r.signature) return false;
  const key = await crypto.subtle.importKey("raw", b64ToBytes(publicKeyB64), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, b64ToBytes(r.signature), enc.encode(canonicalJson(r.payload)));
}
