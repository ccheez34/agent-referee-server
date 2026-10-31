// Makes the approvals key pair on the owner's computer. Prints the public key (for wrangler.jsonc and the gates) and
// writes the private key to a file the owner then puts into the Worker as a secret and deletes. Never paste it in a chat.
//   node owner-approvals/scripts/gen-keys.mjs
import { writeFileSync, existsSync } from "node:fs";
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const b64 = (b) => Buffer.from(b).toString("base64");
const priv = b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
const pub = b64(await crypto.subtle.exportKey("raw", kp.publicKey));
const file = "approvals-signing-key.txt";
if (existsSync(file)) { console.log(`${file} already exists; not overwriting it.`); process.exit(1); }
writeFileSync(file, priv + "\n", { mode: 0o600 });
console.log(`Public key (put it in wrangler.jsonc as APPROVALS_PUBLIC_KEY, and give it to the gates):\n${pub}\n`);
console.log(`Private key written to ${file}. Run: npx wrangler secret put APPROVALS_SIGNING_KEY, paste the file's contents, then delete the file.`);
