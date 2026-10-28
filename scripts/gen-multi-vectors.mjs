// Shared test vectors for the multi-part review receipt (receipt_format "review-multi-v1"), computed by the server's
// own code, so the JS and Python clients are tested against the same bytes. Run again whenever the format changes:
//
//   node scripts/gen-multi-vectors.mjs test/fixtures/multi-review-vectors.json
//
// Every receipt is signed with a throwaway key made for this run (its public key is in the file). Each case says what
// a verifier given that receipt plus the listed task and pieces must conclude: ok, or not ok and why.
import { writeFile } from "node:fs/promises";

const mp = await import("../src/multipart.ts");
const { canonicalJson, sha256Hex } = await import("../src/logic.ts");
const { signReceipt } = await import("../src/receipt.ts");

const outPath = process.argv[2] ?? "test/fixtures/multi-review-vectors.json";
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const b64 = (b) => Buffer.from(b).toString("base64");
const SIGNING_KEY = b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
const PUBLIC_KEY = b64(await crypto.subtle.exportKey("raw", kp.publicKey));
const sign = (payload) => signReceipt(payload, SIGNING_KEY, PUBLIC_KEY);

const models = ["claude-opus-5-5", "openai/gpt-6-luna", "google/gemini-4-argon"];
const task = "Review the handoff: every fact must match the code, and every open item must be listed.";
const vote = (i, verdict, issues = [], dropped = 0) => ({ reviewer: i + 1, model: models[i], verdict, confidence: "high", issues, reasoning: "Short reasoning.", issues_dropped: dropped });

async function make(tier, pieces, verdicts, extra = {}) {
  const commitment = await mp.multiCommitment(tier, {}, models);
  const votes = verdicts.map((v, i) => vote(i, v, v === "pass" ? [] : [`[piece 1] problem from reviewer ${i + 1}`, "[all] a problem across pieces"], i === 0 ? 3 : 0));
  const payload = await mp.multiReviewPayload({ tier, input: { task, pieces, title: "Handoff v5", ...extra }, commitment, votes, payer: "0x28275fa8fe39996501e160104a23e1af5e005f58", network: "base", id: "a1b2c3d4e5f6a1b2c3d4e5f6", now: new Date("2026-10-28T22:00:00.000Z") });
  return payload;
}

const piecesA = [{ name: "Server", text: "What's live: version 996005f8.\n" }, { text: "Open items: the multi-part tiers." }];
const piecesB = [
  { name: "Part 1 — 日本語 ✓", text: "漢字とemoji 😀 count as UTF-16 code units: 😀 is 2." },
  { text: "Line endings stay exactly as sent:\r\nCRLF, and a trailing space " },
  { name: "Docs", text: "  separators and \"quotes\" and \\ backslashes." },
];

const cases = [];
const add = async (id, what, payload, given, expect) => cases.push({ id, what, given, receipt: await sign(payload), expect });

// ---------- valid ----------
const okA = await make("review-3x2", piecesA, ["pass", "needs_changes", "pass"]);
await add("valid-3x2", "A valid 2-piece receipt, one piece named.", okA, { task, pieces: piecesA }, { ok: true, verdict: "pass" });
const okB = await make("review-3x3", piecesB, ["needs_changes", "fail", "pass"]);
await add("valid-3x3-unicode", "A valid 3-piece receipt with CJK, emoji, CRLF, U+2028 and escapes; the verdict is split.", okB, { task, pieces: piecesB }, { ok: true, verdict: "split" });

// ---------- the verifier's inputs don't match ----------
await add("wrong-piece-text", "The verifier holds a different text for piece 2.", okA, { task, pieces: [piecesA[0], { text: piecesA[1].text + "!" }] }, { ok: false, reason: "piece 2 sha256 differs" });
await add("missing-name", "The verifier forgot piece 1's name: names are part of pieces_sha256.", okA, { task, pieces: [{ text: piecesA[0].text }, piecesA[1]] }, { ok: false, reason: "piece 1 name differs" });
await add("pieces-swapped", "The right pieces in the wrong order.", okA, { task, pieces: [piecesA[1], piecesA[0]] }, { ok: false, reason: "piece order differs" });
await add("wrong-task", "A different task.", okA, { task: task + " ", pieces: piecesA }, { ok: false, reason: "task_sha256 differs" });
await add("wrong-count", "Three pieces given for a 2-piece receipt.", okA, { task, pieces: [...piecesA, { text: "extra" }] }, { ok: false, reason: "piece count differs from the tier" });

// ---------- signed, but inconsistent (what a client must catch even with a good signature) ----------
const badHash = { ...okA, pieces_sha256: "0".repeat(64) };
await add("bad-pieces-sha256", "Signed, but pieces_sha256 isn't the hash of the canonical pieces list.", badHash, { task, pieces: piecesA }, { ok: false, reason: "pieces_sha256 doesn't match pieces" });
const badChars = { ...okB, pieces: okB.pieces.map((p, i) => (i === 0 ? { ...p, chars: [...piecesB[0].text].length } : p)) };
badChars.pieces_sha256 = await sha256Hex(canonicalJson(badChars.pieces));
await add("chars-as-code-points", "Signed and self-consistent, but chars counts code points instead of UTF-16 units.", badChars, { task, pieces: piecesB }, { ok: false, reason: "piece 1 chars differs" });
const badTally = { ...okA, result: { ...okA.result, verdict: "needs_changes" } };
await add("bad-verdict", "Signed, but the verdict doesn't follow from the votes.", badTally, { task, pieces: piecesA }, { ok: false, reason: "verdict doesn't recompute" });
const twoVotes = { ...okA, votes: okA.votes.slice(0, 2), reviewers: { ...okA.reviewers, models: models.slice(0, 2) } };
await add("two-votes", "Signed, but only 2 votes on a 3-reviewer tier.", twoVotes, { task, pieces: piecesA }, { ok: false, reason: "expected 3 votes" });
const sameCompany = { ...okA, reviewers: { ...okA.reviewers, models: ["claude-opus-5-5", "claude-sonnet-5-5", "google/gemini-4-argon"] }, votes: okA.votes.map((v, i) => ({ ...v, model: ["claude-opus-5-5", "claude-sonnet-5-5", "google/gemini-4-argon"][i] })) };
await add("same-company", "Signed, but two reviewers from one company.", sameCompany, { task, pieces: piecesA }, { ok: false, reason: "reviewers not from three companies" });
const noDropped = { ...okA, votes: okA.votes.map(({ issues_dropped, ...v }) => v) };
await add("no-issues-dropped", "Signed, but votes lack issues_dropped (always present in this format).", noDropped, { task, pieces: piecesA }, { ok: false, reason: "issues_dropped missing" });
const withOutput = { ...okA, output_sha256: await sha256Hex("x") };
await add("has-output-sha256", "Signed, but it also carries output_sha256, which this format never has.", withOutput, { task, pieces: piecesA }, { ok: false, reason: "unexpected output_sha256" });
const unknownFormat = { ...okA, receipt_format: "review-multi-v2" };
await add("unknown-format", "A receipt_format the client doesn't know: refuse and ask to update the client.", unknownFormat, { task, pieces: piecesA }, { ok: false, reason: "unknown receipt_format" });
const oldTier = { ...okA, tier: "review-3" };
await add("old-tier-name", "receipt_format review-multi-v1 but tier review-3.", oldTier, { task, pieces: piecesA }, { ok: false, reason: "tier isn't a multi-part tier" });

// ---------- bad signature ----------
const tampered = await sign(okA);
tampered.payload = { ...tampered.payload, result: { ...tampered.payload.result, verdict: "fail" } };
cases.push({ id: "bad-signature", what: "The payload was changed after signing.", given: { task, pieces: piecesA }, receipt: tampered, expect: { ok: false, reason: "signature" } });

// ---------- the building blocks, on their own ----------
const blocks = [];
for (const pieces of [piecesA, piecesB]) {
  const records = await mp.pieceRecords(pieces);
  blocks.push({ pieces, records, canonical: canonicalJson(records), pieces_sha256: await mp.piecesSha256(records) });
}

await writeFile(
  outPath,
  JSON.stringify(
    {
      generated_by: "agent-referee-server scripts/gen-multi-vectors.mjs",
      receipt_format: mp.MULTI_RECEIPT_FORMAT,
      public_key: PUBLIC_KEY,
      notes: [
        "Verify the signature (Ed25519 over canonical JSON of payload) against public_key.",
        "Then: receipt_format must be known; tier review-3x2 (2 pieces) or review-3x3 (3 pieces); no output_sha256; exactly 3 votes from 3 companies, each with an integer issues_dropped; pieces_sha256 = sha256 hex of canonical JSON of pieces; each given piece's sha256 (UTF-8), chars (UTF-16 code units) and name ('' when none) match in order; task_sha256 matches; the 2-of-3 verdict and tally recompute.",
        "Each case's expect.reason is a hint for test names, not text a client must print.",
      ],
      building_blocks: blocks,
      cases,
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${cases.length} cases to ${outPath}`);
