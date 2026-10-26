// PayAI merchant authentication: an EdDSA-signed JWT, valid 2 minutes, cached and renewed 30 s before expiry.
// Spec: https://docs.payai.network/x402/facilitators/authentication
let payaiCached: { token: string; refreshAt: number } | null = null;
export async function payaiToken(keyId: string, secret: string, nowMs = Date.now()): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  if (payaiCached && now < payaiCached.refreshAt) return payaiCached.token;
  const enc = new TextEncoder();
  const b64url = (bytes: Uint8Array) => {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const header = b64url(enc.encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: keyId })));
  const payload = b64url(enc.encode(JSON.stringify({ sub: keyId, iss: "payai-merchant", iat: now, exp: now + 120, jti: crypto.randomUUID() })));
  const key = await crypto.subtle.importKey("pkcs8", payaiSecretToPkcs8(secret), { name: "Ed25519" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(`${header}.${payload}`)));
  const token = `${header}.${payload}.${b64url(sig)}`;
  payaiCached = { token, refreshAt: now + 90 };
  return token;
}

// Ed25519 PKCS#8 header; followed by the 32-byte private seed.
const PKCS8_ED25519_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

/**
 * Accepts the secret in any common encoding: optional payai_sk_ prefix, base64 or base64url, with or without
 * padding, as PKCS#8 DER (48 bytes), a raw 32-byte seed, or a 64-byte seed+public key. Errors describe the
 * secret's shape only, never its content.
 */
export function payaiSecretToPkcs8(secret: string): Uint8Array {
  const raw = secret.trim().replace(/^payai_sk_/i, "").replace(/\s+/g, "");
  let b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    const shape = `${raw.length} characters${/[^A-Za-z0-9+/=_-]/.test(raw) ? ", including characters that aren't base64" : ""}`;
    throw new Error(`PAYAI_API_KEY_SECRET couldn't be read (${shape}). Re-copy the secret from the PayAI dashboard and run wrangler secret put PAYAI_API_KEY_SECRET again.`);
  }
  const wrap = (seed: Uint8Array) => {
    const out = new Uint8Array(48);
    out.set(PKCS8_ED25519_PREFIX);
    out.set(seed, 16);
    return out;
  };
  if (bytes.length === 32) return wrap(bytes);
  if (bytes.length === 64) return wrap(bytes.slice(0, 32));
  if (bytes.length === 48) return bytes;
  throw new Error(`PAYAI_API_KEY_SECRET decoded to ${bytes.length} bytes; expected an Ed25519 key (32, 48 or 64 bytes). Re-copy the secret from the PayAI dashboard.`);
}
