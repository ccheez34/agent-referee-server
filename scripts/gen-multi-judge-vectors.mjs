// Shared test vectors for the multi-part judge receipt (receipt_format "judge-multi-v1"), made by running real matches
// through the server's own MatchRoom with fake judges, so the JS and Python clients are tested against the same bytes.
// Run again whenever the format changes:
//
//   node scripts/gen-multi-judge-vectors.mjs test/fixtures/multi-judge-vectors.json
//
// Every receipt and ack is signed with a throwaway key made for this run (its public key is in the file). Each case
// says what a verifier given that receipt, the listed acks and (for its own seat) its own pieces must conclude.
import { writeFile } from "node:fs/promises";

const { MatchRoom } = await import("../src/match.ts");
const { canonicalJson, sha256Hex } = await import("../src/logic.ts");
const { signReceipt } = await import("../src/receipt.ts");
const mj = await import("../src/multijudge.ts");

const outPath = process.argv[2] ?? "test/fixtures/multi-judge-vectors.json";
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const b64 = (b) => Buffer.from(b).toString("base64");
const SIGNING_KEY = b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
const PUBLIC_KEY = b64(await crypto.subtle.exportKey("raw", kp.publicKey));
const sign = (payload) => signReceipt(payload, SIGNING_KEY, PUBLIC_KEY);

const RULES = "The side whose plan costs less wins; if equal, the faster one.";
// No Claude judge (judge-tier spec v2.1, §4.1): OpenAI, Google and Mistral. Mistral's output limit isn't recorded in
// multipart.ts yet (its cost check for these tiers hasn't been done), so it's set here, for this run only.
const PANEL = ["openai/gpt-6-luna", "google/gemini-4-argon", "mistralai/mistral-large-4-0"];
const { MODEL_OUTPUT_LIMITS } = await import("../src/multipart.ts");
MODEL_OUTPUT_LIMITS["mistralai/mistral-large-4-0"] = 262_144; // Mistral's published limit (4.0's FACTS.md, Oct 30)

// Fake judges: votes[model] is the winner each one names.
let votes = {};
globalThis.fetch = async (url, init) => {
  const b = JSON.parse(init.body);
  const text = JSON.stringify({ winner: votes[b.model], confidence: "high", rule_applied: "costs less wins", reasoning: "[side alpha, piece 1] is cheaper." });
  return String(url).includes("openrouter")
    ? new Response(JSON.stringify({ model: b.model, choices: [{ message: { content: text }, finish_reason: "stop" }] }))
    : new Response(JSON.stringify({ model: b.model, content: [{ type: "text", text }], stop_reason: "end_turn" }));
};

// Claude judges off, as shipped; the judge pool includes Mistral. Every receipt carries advisory and human_review.
const env = { SIGNING_KEY, PUBLIC_KEY, ANTHROPIC_API_KEY: "x", OPENROUTER_API_KEY: "x", JUDGE_MODEL_POOL: "openai/gpt-6-luna,google/gemini-4-argon,google/gemini-3.7-flash,mistralai/mistral-large-4-0" };
async function run(tier, sides, verdicts, { forfeitOf } = {}) {
  votes = Object.fromEntries(PANEL.map((m, i) => [m, verdicts?.[i] ?? "alpha"]));
  const d = new Map();
  const room = new MatchRoom({ storage: { get: async (k) => structuredClone(d.get(k)), put: async (k, v) => void d.set(k, structuredClone(v)), deleteAll: async () => d.clear(), setAlarm: async () => {} } }, env);
  const call = async (action, body) => {
    room.m = undefined;
    const res = await room.fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
    return res.json();
  };
  const id = "a1b2c3d4e5f6a1b2c3d4e5f6";
  await call("create", { id, input: { tier, seats: ["alpha", "beta"], rules: RULES, title: "Which plan", panel: PANEL } });
  const tok = {};
  for (const s of ["alpha", "beta"]) tok[s] = (await call("join", { seat: s, tier, role: "party", paid: true, payer: `0x${s[0].repeat(40)}` })).seat_token;
  const acks = {};
  for (const s of ["alpha", "beta"]) {
    if (s === forfeitOf) continue;
    const r = await call("submit", { seat: s, seat_token: tok[s], pieces: sides[s].map((text) => ({ text })) });
    acks[s] = r.ack;
  }
  if (forfeitOf) {
    room.now = () => Date.now() + 11 * 60_000;
    await call("status");
  }
  room.m = undefined;
  const st = await call("status");
  if (st.phase !== "done") throw new Error(`match didn't finish: ${st.phase} ${st.error}`);
  return { receipt: st.receipt, acks };
}

const sides2 = { alpha: ["Plan A: $40 in all.\n", "Ships in 2 days."], beta: ["Plan B: $35 in all.", "Ships in 5 days."] };
const sides3 = {
  alpha: ["漢字とemoji 😀 count as UTF-16 code units: 😀 is 2.", "Line endings stay exactly as sent:\r\nCRLF, and a trailing space ", "  \"quotes\" and \\ backslashes, U+2028 here: end."],
  beta: ["Plan B, part 1.", "Plan B, part 2.", "Plan B, part 3."],
};

const cases = [];
const add = (id, what, receipt, given, expect) => cases.push({ id, what, given, receipt, expect });
const resign = async (payload) => sign(payload);

// ---------- valid ----------
const a = await run("judge-3x2", sides2, ["alpha", "beta", "alpha"]);
add("valid-3x2", "A judged 2-piece match: alpha wins 2 to 1.", a.receipt, { pieces: sides2, acks: [a.acks.alpha, a.acks.beta] }, { ok: true, winner: "alpha" });
const b = await run("judge-3x3", sides3, ["beta", "beta", "alpha"]);
add("valid-3x3-unicode", "A judged 3-piece match with CJK, emoji, CRLF, U+2028 and escapes in one side; beta wins 2 to 1.", b.receipt, { pieces: sides3, acks: [b.acks.alpha, b.acks.beta] }, { ok: true, winner: "beta" });
const f = await run("judge-3x2", sides2, null, { forfeitOf: "beta" });
add("valid-forfeit", "beta never submitted: alpha wins by forfeit, and the receipt shows only alpha's pieces.", f.receipt, { pieces: { alpha: sides2.alpha }, acks: [f.acks.alpha] }, { ok: true, winner: "alpha", by_forfeit: true });

// ---------- the verifier's own pieces don't match ----------
add("wrong-piece-text", "alpha holds a different text for its piece 2.", a.receipt, { pieces: { ...sides2, alpha: [sides2.alpha[0], sides2.alpha[1] + "!"] } }, { ok: false, reason: "alpha piece 2 sha256 differs" });
add("pieces-swapped", "alpha's pieces in the wrong order.", a.receipt, { pieces: { ...sides2, alpha: [sides2.alpha[1], sides2.alpha[0]] } }, { ok: false, reason: "alpha piece order differs" });
add("wrong-count", "alpha holds 3 pieces for a 2-piece tier.", a.receipt, { pieces: { ...sides2, alpha: [...sides2.alpha, "extra"] } }, { ok: false, reason: "piece count differs from the tier" });

// ---------- signed, but inconsistent ----------
const p = a.receipt.payload;
add("bad-pieces-sha256", "Signed, but beta's pieces_sha256 isn't the hash of its pieces list.", await resign({ ...p, proof: { ...p.proof, pieces_sha256: { ...p.proof.pieces_sha256, beta: "0".repeat(64) } } }), { pieces: sides2 }, { ok: false, reason: "beta pieces_sha256 doesn't match pieces" });
{
  const pb = b.receipt.payload;
  const cp = pb.proof.pieces.alpha.map((r, i) => (i === 0 ? { ...r, chars: [...sides3.alpha[0]].length } : r));
  add("chars-as-code-points", "Signed and self-consistent, but alpha's piece 1 chars counts code points instead of UTF-16 units.", await resign({ ...pb, proof: { ...pb.proof, pieces: { ...pb.proof.pieces, alpha: cp }, pieces_sha256: { ...pb.proof.pieces_sha256, alpha: await sha256Hex(canonicalJson(cp)) } } }), { pieces: sides3 }, { ok: false, reason: "alpha piece 1 chars differs" });
}
add("missing-side", "Signed, judged (not a forfeit), but only alpha's pieces are in the proof.", await resign({ ...p, proof: { ...p.proof, pieces: { alpha: p.proof.pieces.alpha }, pieces_sha256: { alpha: p.proof.pieces_sha256.alpha } } }), { pieces: sides2 }, { ok: false, reason: "a judged receipt must have both sides' pieces" });
add("has-submission-sha256", "Signed, but it also carries proof.submission_sha256, which this format never has.", await resign({ ...p, proof: { ...p.proof, submission_sha256: { alpha: await sha256Hex("x"), beta: await sha256Hex("y") } } }), { pieces: sides2 }, { ok: false, reason: "unexpected submission_sha256" });
add("bad-winner", "Signed, but the winner doesn't follow from the votes (2 for alpha).", await resign({ ...p, outcome: { ...p.outcome, winner: "beta" } }), { pieces: sides2 }, { ok: false, reason: "winner doesn't recompute" });
add("bad-tally", "Signed, but the tally doesn't match the votes.", await resign({ ...p, outcome: { ...p.outcome, tally: { alpha: 3, beta: 0, mistrial: 0 } } }), { pieces: sides2 }, { ok: false, reason: "tally doesn't recompute" });
add("two-votes", "Signed, but only 2 votes on a 3-judge tier.", await resign({ ...p, outcome: { ...p.outcome, votes: p.outcome.votes.slice(0, 2) } }), { pieces: sides2 }, { ok: false, reason: "expected 3 votes" });
{
  const same = ["openai/gpt-6-luna", "google/gemini-3.7-flash", "google/gemini-4-argon"]; // two from Google
  const judge = { ...p.proof.judge, model: same[0], panel: p.proof.judge.panel.map((s, i) => ({ ...s, model: same[i] })) };
  add("same-company", "Signed, but two judges from one company.", await resign({ ...p, proof: { ...p.proof, judge }, outcome: { ...p.outcome, votes: p.outcome.votes.map((v, i) => ({ ...v, model: same[i] })) } }), { pieces: sides2 }, { ok: false, reason: "judges not from three companies" });
}
add("wrong-format-version", "Signed, but the judges' format_version isn't the multi-part one.", await resign({ ...p, proof: { ...p.proof, judge: { ...p.proof.judge, format_version: "agent-referee-judge-v4" } } }), { pieces: sides2 }, { ok: false, reason: "format_version isn't agent-referee-judge-v5-multi" });
add("unknown-format", "A receipt_format the client doesn't know: refuse and ask to update the client.", await resign({ ...p, receipt_format: "judge-multi-v2" }), { pieces: sides2 }, { ok: false, reason: "unknown receipt_format" });
add("old-tier-name", "receipt_format judge-multi-v1 but tier judge-3.", await resign({ ...p, tier: "judge-3" }), { pieces: sides2 }, { ok: false, reason: "tier isn't a multi-part judge tier" });
{
  const tampered = structuredClone(a.receipt);
  tampered.payload.outcome.winner = "beta";
  add("bad-signature", "The payload was changed after signing.", tampered, { pieces: sides2 }, { ok: false, reason: "signature" });
}

// ---------- acks the receipt contradicts (provable to anyone) ----------
{
  const otherAck = await sign({ ...a.acks.alpha.payload, pieces_sha256: "1".repeat(64) });
  add("ack-pieces-changed", "alpha's signed submit ack names other pieces than the receipt: the two signed documents prove the change.", a.receipt, { pieces: {}, acks: [otherAck] }, { ok: false, reason: "alpha's submission was changed (ack contradicts receipt)" });
  const forfeitAck = await sign({ ...a.acks.alpha.payload, seat: "beta", pieces: p.proof.pieces.beta, pieces_sha256: p.proof.pieces_sha256.beta });
  add("forfeit-after-ack", "The forfeit receipt says beta forfeited, but beta holds a signed submit ack.", f.receipt, { pieces: { alpha: sides2.alpha }, acks: [f.acks.alpha, forfeitAck] }, { ok: false, reason: "beta listed as forfeiting after its submission was accepted" });
}

const blocks = [];
for (const texts of [sides2.alpha, sides3.alpha]) {
  const records = await mj.sidePieceRecords(texts);
  blocks.push({ texts, records, canonical: canonicalJson(records), pieces_sha256: await mj.sidePiecesSha256(records) });
}

await writeFile(
  outPath,
  JSON.stringify(
    {
      generated_by: "agent-referee-server scripts/gen-multi-judge-vectors.mjs",
      receipt_format: mj.MULTI_JUDGE_RECEIPT_FORMAT,
      public_key: PUBLIC_KEY,
      notes: [
        "Verify the signature (Ed25519 over canonical JSON of payload) against public_key, for the receipt and for every ack.",
        "Then: receipt_format must be known; tier judge-3x2 (2 pieces per side) or judge-3x3 (3); proof.judge.format_version agent-referee-judge-v5-multi; no proof.submission_sha256; for every side in proof.pieces, proof.pieces_sha256[side] = sha256 hex of canonical JSON of proof.pieces[side], each record {index, sha256, chars} (no name), chars in UTF-16 code units.",
        "A judged receipt has both sides' pieces, 3 votes from 3 companies, and the majority winner and tally recompute from the votes. A forfeit receipt (outcome.by_forfeit) has the pieces of the side that submitted only.",
        "Given a seat's own pieces: their count, order, sha256 (UTF-8) and chars must match that seat's records. Given acks: a submit ack's pieces and pieces_sha256 must equal the receipt's for that seat, and a seat with a submit ack can't be listed as forfeiting.",
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
