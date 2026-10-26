// Verify a receipt: node scripts/verify-receipt.mjs https://your-worker.workers.dev <match_id>
const [base, id] = process.argv.slice(2);
if (!base || !id) { console.error("usage: node scripts/verify-receipt.mjs <base_url> <match_id>"); process.exit(1); }
const canon = (v) => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
const { public_key } = await (await fetch(`${base}/pubkey`)).json();
const match = await (await fetch(`${base}/matches/${id}`)).json();
const r = match.receipt;
if (!r?.signature) { console.log("No signed receipt (match not done, or signing keys not set)."); process.exit(1); }
const key = await crypto.subtle.importKey("raw", Buffer.from(public_key, "base64"), { name: "Ed25519" }, false, ["verify"]);
const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(r.signature, "base64"), new TextEncoder().encode(canon(r.payload)));
console.log(ok ? "VALID receipt" : "INVALID receipt");
console.log(JSON.stringify(r.payload.outcome, null, 2));
