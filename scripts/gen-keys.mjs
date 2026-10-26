// Generates the Ed25519 key pair used to sign receipts. Run: npm run keys
const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const b64 = (buf) => Buffer.from(buf).toString("base64");
const priv = b64(await crypto.subtle.exportKey("pkcs8", privateKey));
const pub = b64(await crypto.subtle.exportKey("raw", publicKey));
console.log(`SIGNING_KEY=${priv}`);
console.log(`PUBLIC_KEY=${pub}`);
console.log("\nKeep SIGNING_KEY secret. Save both with:");
console.log("  npx wrangler secret put SIGNING_KEY");
console.log("  npx wrangler secret put PUBLIC_KEY");
