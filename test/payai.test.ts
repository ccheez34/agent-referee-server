// PayAI merchant JWT: EdDSA, the documented header and claims, verifiable with the matching public key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { payaiToken } from "../src/payai.ts";

test("payaiToken builds a valid EdDSA JWT per PayAI's spec, accepts the payai_sk_ prefix, and caches", async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const secret = "payai_sk_" + Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
  const now = Date.now();
  const token = await payaiToken("key_123", secret, now);
  const [h, p, s] = token.split(".");
  const dec = (x: string) => JSON.parse(Buffer.from(x, "base64url").toString());
  assert.deepEqual(dec(h), { alg: "EdDSA", typ: "JWT", kid: "key_123" });
  const claims = dec(p);
  assert.equal(claims.sub, "key_123");
  assert.equal(claims.iss, "payai-merchant");
  assert.equal(claims.exp - claims.iat, 120);
  assert.match(claims.jti, /^[0-9a-f-]{36}$/);
  assert.ok(!/[+/=]/.test(token), "base64url, no padding");
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, kp.publicKey, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${p}`));
  assert.equal(ok, true);
  assert.equal(await payaiToken("key_123", secret, now + 60_000), token, "reused within 90 s");
  assert.notEqual(await payaiToken("key_123", secret, now + 95_000), token, "renewed before the 120 s expiry");
});

test("the PayAI secret is accepted in every common encoding, and bad ones get a safe, clear error", async () => {
  const { payaiSecretToPkcs8 } = await import("../src/payai.ts");
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const seed = pkcs8.slice(16);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const forms = [
    Buffer.from(pkcs8).toString("base64"),
    "payai_sk_" + Buffer.from(pkcs8).toString("base64url"),
    Buffer.from(seed).toString("base64url"),
    "payai_sk_" + Buffer.from(seed).toString("base64"),
    Buffer.from(new Uint8Array([...seed, ...pub])).toString("base64"),
    "  payai_sk_" + Buffer.from(pkcs8).toString("base64") + "\n",
  ];
  const msg = new TextEncoder().encode("x");
  for (const f of forms) {
    const key = await crypto.subtle.importKey("pkcs8", payaiSecretToPkcs8(f), { name: "Ed25519" }, false, ["sign"]);
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, msg);
    assert.equal(await crypto.subtle.verify({ name: "Ed25519" }, kp.publicKey, sig, msg), true, f.slice(0, 12));
  }
  assert.throws(() => payaiSecretToPkcs8("not a key!!"), (e: any) => e.message.includes("couldn't be read") && !e.message.includes("not a key"));
  assert.throws(() => payaiSecretToPkcs8("QUJD"), /decoded to 3 bytes/);
});
