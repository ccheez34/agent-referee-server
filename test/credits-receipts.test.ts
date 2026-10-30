// Credit packs: receipts (spec v2 §2 "Receipt", §8 "Receipts"). A review paid from credits says funding: "credits",
// has no payer, no network (nothing was paid on-chain) and no account id (receipts are shareable). Node only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewCommitment, reviewPayload } from "../src/review.ts";
import { multiCommitment, multiReviewPayload } from "../src/multipart.ts";
import { signReceipt, verifyReceipt } from "../src/receipt.ts";
import { canonicalJson } from "../src/logic.ts";

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const SIGNING_KEY = b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
const PUBLIC_KEY = b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);

const input = { task: "Add 2 and 2 and give only the number.", output: "4" };
const vote = (model: string, i: number) => ({ reviewer: i + 1, model, verdict: "pass" as const, confidence: "high" as const, issues: [], reasoning: "Checked." });

test("receipts: a single review paid from credits has funding credits, payer null, no network, and verifies", async () => {
  const c = await reviewCommitment("review", {});
  // The handler passes network: undefined for credits; the payload drops it even if one is passed.
  const payload = await reviewPayload({ tier: "review", input, commitment: c, votes: c.models.map(vote), network: "base", id: "rc1", funding: "credits" });
  const p: any = payload;
  assert.equal(p.funding, "credits");
  assert.equal(p.payer, null);
  assert.equal("network" in p && p.network !== undefined, false);
  assert.ok(!canonicalJson(p).includes('"network"'), "not in the signed bytes");
  assert.ok(!canonicalJson(p).includes("arca_"), "no account id");
  const receipt = await signReceipt(payload as any, SIGNING_KEY, PUBLIC_KEY);
  assert.equal(await verifyReceipt(receipt, PUBLIC_KEY), true);
  assert.ok(!JSON.stringify(receipt).includes('"network"'), "not in the JSON the agent gets either");
  // Changing the funding breaks the signature.
  assert.equal(await verifyReceipt({ ...receipt, payload: { ...receipt.payload, funding: "team" } }, PUBLIC_KEY), false);
});

test("receipts: a multi-part review paid from credits too", async () => {
  const c = await multiCommitment("review-3x2", { MULTI_PART_EXCLUDE: "" }, ["claude-opus-5-5", "openai/gpt-6-luna", "google/gemini-4-argon"]);
  const payload: any = await multiReviewPayload({ tier: "review-3x2", input: { task: input.task, pieces: [{ text: "one" }, { text: "two" }] }, commitment: c, votes: c.models.map(vote), network: "base", id: "rc2", funding: "credits" });
  assert.equal(payload.funding, "credits");
  assert.equal(payload.payer, null);
  assert.equal(payload.network, undefined);
  assert.equal(payload.receipt_format, "review-multi-v1");
  assert.equal(await verifyReceipt(await signReceipt(payload, SIGNING_KEY, PUBLIC_KEY), PUBLIC_KEY), true);
});

test("receipts: team and x402 receipts keep their network", async () => {
  const c = await reviewCommitment("review", {});
  const team: any = await reviewPayload({ tier: "review", input, commitment: c, votes: c.models.map(vote), network: "base", id: "rt", funding: "team" });
  assert.equal(team.network, "base");
  const paid: any = await reviewPayload({ tier: "review", input, commitment: c, votes: c.models.map(vote), payer: "0xabc", network: "base", id: "rp" });
  assert.equal(paid.network, "base");
  assert.equal(paid.funding, undefined);
});
