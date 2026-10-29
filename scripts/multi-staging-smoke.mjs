// Free smoke test of the multi-part review tiers on the staging Worker (fake AI, payments off). Nothing is charged.
//
//   node scripts\multi-staging-smoke.mjs https://agent-referee-staging.fairplayclub.workers.dev
//
// Checks: GET /reviewers shows the tiers on; review-3x2 and review-3x3 complete with three companies and a
// review-multi-v1 receipt whose hashes, chars and signature check out against GET /pubkey; bad input is refused (400),
// an oversized body gets 413, and Haiku is refused. Prints PASS or FAIL for each, and a summary line at the end.
import { createHash, createPublicKey, verify } from "node:crypto";

const base = (process.argv[2] || "").replace(/\/+$/, "");
if (!/^https:\/\/agent-referee-staging\./.test(base)) {
  console.log("Usage: node scripts\\multi-staging-smoke.mjs https://agent-referee-staging.fairplayclub.workers.dev  (staging only)");
  process.exit(1);
}
let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${!ok && detail ? `  -> ${detail}` : ""}`);
  if (!ok) failures++;
};
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const canonical = (v) =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const post = async (path, body, raw) => {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const info = await (await fetch(`${base}/reviewers`)).json();
check(info?.multi_part?.status === "on", "GET /reviewers: multi_part status is on", JSON.stringify(info?.multi_part?.status));
const pub = await (await fetch(`${base}/pubkey`)).json();
const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub.public_key, "base64")]), format: "der", type: "spki" });

const task = "Check this handoff: every fact must be right and every open item listed.";
for (const [tier, n] of [["review-3x2", 2], ["review-3x3", 3]]) {
  const pieces = Array.from({ length: n }, (_, i) => (i === 0 ? { name: "Part 1 ✓", text: "漢字 and emoji 😀 in piece one." } : { text: `Piece ${i + 1}.\r\nKept exactly. ` }));
  const t0 = Date.now();
  const r = await post(`/${tier}`, { task, pieces });
  const s = Math.round((Date.now() - t0) / 1000);
  check(r.status === 200, `${tier}: completes (${s} s)`, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  if (r.status !== 200) continue;
  const rc = r.body.receipt, p = rc.payload;
  check(p.receipt_format === "review-multi-v1" && p.tier === tier, `${tier}: receipt_format and tier`, `${p.receipt_format} ${p.tier}`);
  check(p.output_sha256 === undefined && p.task_sha256 === sha(task), `${tier}: task_sha256 kept, no output_sha256`);
  const want = pieces.map((x, i) => ({ index: i + 1, name: x.name ?? "", sha256: sha(x.text), chars: x.text.length }));
  check(canonical(p.pieces) === canonical(want), `${tier}: each piece's index, name, sha256 and chars`, JSON.stringify(p.pieces));
  check(p.pieces_sha256 === sha(canonical(p.pieces)), `${tier}: pieces_sha256`);
  const companies = new Set(p.reviewers.models.map((m) => (m.includes("/") ? m.split("/")[0] : "anthropic")));
  check(p.votes.length === 3 && companies.size === 3 && !p.reviewers.models.includes("claude-haiku-5-5"), `${tier}: 3 votes from 3 companies, no Haiku`, p.reviewers.models.join(", "));
  check(p.votes.every((v) => Number.isInteger(v.issues_dropped)), `${tier}: issues_dropped in every vote`);
  check(p.reviewers.format_version === "agent-referee-review-v4-multi" && p.reviewers.prompt_sha256 === info.multi_part.prompt_sha256, `${tier}: prompt version and fingerprint match /reviewers`);
  check(verify(null, Buffer.from(canonical(p), "utf8"), key, Buffer.from(rc.signature, "base64")), `${tier}: signature checks out against GET /pubkey`);
}

const two = [{ text: "a" }, { text: "b" }];
check((await post("/review-3x3", { task, pieces: two })).status === 400, "wrong piece count: 400");
check((await post("/review-3x2", { task, pieces: [{ text: "x".repeat(12_001) }, { text: "b" }] })).status === 400, "a piece over 12,000 characters: 400");
check((await post("/review-3x2", { task, pieces: two, panel: ["claude-haiku-5-5", "openai/gpt-6-luna", "google/gemini-4-argon"] })).status === 400, "Haiku on the panel: 400");
check((await post("/review-3x2", null, JSON.stringify({ task, pieces: [{ text: "\u0001".repeat(50_000) }, { text: "b" }] }))).status === 413, "a body over 256 KB: 413");

console.log(failures ? `\n${failures} check(s) FAILED. Paste this output.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
