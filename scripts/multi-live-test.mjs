// Live tests of the multi-part review tiers (spec 4.3), paid from the test wallet, with the tiers still closed to the
// public: every request carries the operator's token. Shows the plan and the total and waits for "pay"; spending is
// capped at that total. Saves each response (receipt + per-call timing and tokens) in the plan's folder, checks every
// receipt offline, and writes INDEX-live.md, results-live.json and printout-live.txt.
//
//   node scripts\multi-live-test.mjs --wallet-file C:\Users\Admin\Downloads\test-wallet.txt --plan C:\...\plan.json
//
// The operator token is typed at a hidden prompt (never shown, never saved). The wallet key is read from the file and
// never printed. x402-fetch is loaded from the local MCP server's folder (--mcp-dir, default below).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, createPublicKey, verify } from "node:crypto";

const PINNED = "vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY="; // live signing key, key ID 375ba8b346776e2f
const PRICES = { "review-3x2": 0.6, "review-3x3": 0.7 }; // the live prices since option B (Oct 28); also the most one payment may be
const args = process.argv.slice(2);
const opt = (k, d) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : d);
if (!opt("--wallet-file") || !opt("--plan")) {
  console.log("Usage: node scripts\\multi-live-test.mjs --wallet-file PATH --plan PATH_TO_plan.json [--mcp-dir PATH]");
  process.exit(1);
}
const mcpDir = opt("--mcp-dir", "C:\\Users\\Admin\\Downloads\\claud\\agent-referee-mcp");

// ---------- the plan ----------
const plan = JSON.parse(await readFile(resolve(opt("--plan")), "utf8"));
const base = String(plan.base || "https://agentreferee.ai").replace(/\/+$/, "");
// The operator token only ever goes to Agent Referee's own addresses, so a wrong or tampered plan can't leak it.
const OWN = ["https://agentreferee.ai", "https://agent-referee.fairplayclub.workers.dev", "https://agent-referee-staging.fairplayclub.workers.dev"];
if (!OWN.includes(base)) {
  console.log(`The plan's base (${base}) isn't one of Agent Referee's addresses: ${OWN.join(", ")}. Stopped before asking for the token. Nothing was charged.`);
  process.exit(1);
}
const task = await readFile(resolve(plan.task), "utf8");
const runs = [];
for (const r of plan.runs) {
  if (!PRICES[r.tier]) throw new Error(`Run ${r.label}: unknown tier ${r.tier}.`);
  const texts = [];
  for (const f of r.pieces) texts.push((await readFile(resolve(f), "utf8")).replace(/^\uFEFF/, ""));
  if (texts.length !== (r.tier === "review-3x2" ? 2 : 3)) throw new Error(`Run ${r.label}: wrong number of pieces.`);
  const pieces = texts.map((text, i) => ({ name: `Part ${i + 1}`, text }));
  const total = texts.reduce((n, t) => n + t.length, 0);
  if (texts.some((t) => !t.trim() || t.length > 12000) || total > 36000) throw new Error(`Run ${r.label}: a piece is empty or over 12,000 characters, or the total is over 36,000.`);
  runs.push({ ...r, pieces, total });
}
const totalUsd = Math.round(runs.reduce((n, r) => n + PRICES[r.tier], 0) * 100) / 100;
const log = [];
const say = (s = "") => (console.log(s), log.push(s));
say(`${plan.name}: ${runs.length} reviews, $${totalUsd.toFixed(2)} in all, each charged only if it completes. Service: ${base}`);
for (const r of runs) say(`  ${r.label}: ${r.tier}, ${r.panel.join(", ")}  (${r.total} characters)`);
say(`Results go to ${plan.folder}`);

// ---------- prompts: the operator token (hidden), then "pay" ----------
function ask(question, hidden = false) {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => rl.output.write(s.includes(question) ? s : "");
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      done(a.trim());
    });
  });
}
const opToken = await ask("Operator token (ADMIN_TOKEN, hidden as you type or paste): ", true);
const probe = await fetch(`${base}/admin/stats`, { headers: { authorization: `Bearer ${opToken}` } });
if (probe.status !== 200) {
  console.log(`The service didn't accept that token (GET /admin/stats answered ${probe.status}). Stopped. Nothing was charged.`);
  process.exit(1);
}
console.log("Token accepted.");
const pub = await (await fetch(`${base}/pubkey`)).json();
if (!base.includes("staging") && pub.public_key !== PINNED) {
  console.log("The service's signing key isn't the pinned one. Stopped. Nothing was charged.");
  process.exit(1);
}
const keyB64 = pub.public_key;
if ((await ask('Type "pay" to go ahead: ')).toLowerCase() !== "pay") {
  console.log("Stopped. Nothing was charged.");
  process.exit(0);
}

// ---------- paying ----------
const walletText = await readFile(resolve(opt("--wallet-file")), "utf8");
const keys = [...new Set(walletText.match(/0x[0-9a-fA-F]{64}/g) ?? [])];
const keyLine = keys.length === 1 ? keys[0] : [...new Set(walletText.split(/\r?\n/).filter((l) => /key/i.test(l)).flatMap((l) => l.match(/0x[0-9a-fA-F]{64}/g) ?? []))];
const privateKey = typeof keyLine === "string" ? keyLine : keyLine.length === 1 ? keyLine[0] : null;
if (!privateKey) throw new Error("Couldn't find exactly one private key in the wallet file.");
const x402 = await import(pathToFileURL(createRequire(join(mcpDir, "package.json")).resolve("x402-fetch")).href);
const mod = x402.wrapFetchWithPayment ? x402 : x402.default;
const signer = await mod.createSigner("base", privateKey);
const paying = mod.wrapFetchWithPayment(globalThis.fetch.bind(globalThis), signer, BigInt(Math.round(Math.max(...Object.values(PRICES)) * 1e6)));

// ---------- checks ----------
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const canonical = (v) =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const pubKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(keyB64, "base64")]), format: "der", type: "spki" });
function checkReceipt(r, rc) {
  const p = rc?.payload ?? {};
  const problems = [];
  if (!rc?.signature || !verify(null, Buffer.from(canonical(p), "utf8"), pubKey, Buffer.from(rc.signature, "base64"))) problems.push("signature");
  if (p.receipt_format !== "review-multi-v1" || p.tier !== r.tier) problems.push("format or tier");
  if (p.task_sha256 !== sha(task) || p.output_sha256 !== undefined) problems.push("task hash");
  const want = r.pieces.map((x, i) => ({ index: i + 1, name: x.name, sha256: sha(x.text), chars: x.text.length }));
  if (canonical(p.pieces) !== canonical(want)) problems.push("pieces");
  if (p.pieces_sha256 !== sha(canonical(p.pieces ?? []))) problems.push("pieces_sha256");
  const votes = p.votes ?? [];
  const tally = { pass: 0, needs_changes: 0, fail: 0, cannot_assess: 0 };
  for (const v of votes) tally[v.verdict]++;
  const top = Object.keys(tally).find((k) => tally[k] > votes.length / 2) ?? "split";
  if (votes.length !== 3 || p.result?.verdict !== top) problems.push("verdict");
  if (votes.some((v) => !Number.isInteger(v.issues_dropped))) problems.push("issues_dropped");
  return problems;
}

// ---------- run ----------
const folder = resolve(plan.folder);
await mkdir(join(folder, "receipts-live"), { recursive: true });
const short = (m) => (m.startsWith("claude-") ? m.split("-")[1] : m.includes("gpt") ? "gpt" : m.split("/").pop().split(/[-.]/).filter((x) => /^[a-z]+$/.test(x)).pop());
const rows = [];
let spent = 0;
for (const [i, r] of runs.entries()) {
  if (spent + PRICES[r.tier] > totalUsd + 1e-9) {
    say(`\nStopping: the next run would pass the $${totalUsd.toFixed(2)} cap.`);
    break;
  }
  say(`\n===== ${r.label} (${i + 1} of ${runs.length}): ${r.tier}, ${r.total} characters =====`);
  const t0 = Date.now();
  let status = 0, body = null, error = "";
  try {
    const res = await paying(`${base}/${r.tier}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-operator-token": opToken },
      body: JSON.stringify({ task, pieces: r.pieces, title: `Live test ${r.label}`, panel: r.panel }),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (e) {
    error = String(e?.message ?? e).slice(0, 300);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  const calls = body?.operator?.calls ?? [];
  for (const k of calls) say(`  ${k.model.padEnd(24)} try ${k.try_number}  ${(k.ms / 1000).toFixed(1).padStart(6)} s  ${k.outcome}${k.status ? ` ${k.status}` : ""}  in ${k.input_tokens ?? "?"}  out ${k.output_tokens ?? "?"}${k.reasoning_tokens ? ` (reasoning ${k.reasoning_tokens})` : ""}`);
  if (status === 200 && body?.receipt) {
    spent += PRICES[r.tier];
    const problems = checkReceipt(r, body.receipt);
    const name = `${r.label}-${body.receipt.payload.reviewers.models.map(short).join("-")}-${body.result.verdict}.json`;
    await writeFile(join(folder, "receipts-live", name), JSON.stringify(body, null, 2));
    say(`VERDICT ${body.result.verdict} in ${secs} s. Receipt check: ${problems.length ? "FAILED (" + problems.join(", ") + ")" : "OK"}. Saved receipts-live\\${name}`);
    rows.push({ label: r.label, tier: r.tier, chars: r.total, status, secs, verdict: body.result.verdict, check_ok: !problems.length, problems, calls, receipt: `receipts-live/${name}` });
  } else {
    say(`Didn't complete (${status || "no answer"}, ${secs} s), nothing charged: ${error || JSON.stringify(body?.error ?? body).slice(0, 300)}`);
    rows.push({ label: r.label, tier: r.tier, chars: r.total, status, secs, error: error || body?.error || "", calls });
  }
}

// ---------- summary ----------
const byModel = {};
for (const row of rows)
  for (const k of row.calls) {
    const m = (byModel[k.model] ??= { calls: 0, answered: 0, cut_off: 0, timeout: 0, error: 0, max_ms: 0, over_90s: 0, in: [], out: [], reasoning: [] });
    m.calls++;
    if (k.outcome === "answered") m.answered++;
    else if (k.outcome === "cut_off") m.cut_off++;
    else if (k.outcome === "timeout") m.timeout++;
    else m.error++;
    m.max_ms = Math.max(m.max_ms, k.ms);
    if (k.ms > 90_000) m.over_90s++;
    if (k.input_tokens !== undefined) m.in.push(k.input_tokens);
    if (k.output_tokens !== undefined) m.out.push(k.output_tokens);
    if (k.reasoning_tokens) m.reasoning.push(k.reasoning_tokens);
  }
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : "-");
const mx = (a) => (a.length ? Math.max(...a) : "-");
const done = rows.filter((r) => r.verdict);
const index = [
  `# ${plan.name}`,
  "",
  `${new Date().toISOString().slice(0, 10)}. ${done.length} of ${rows.length} completed, $${spent.toFixed(2)} paid. Failed reviews aren't charged. Every completed receipt was checked offline (signature against ${base}/pubkey, task and piece hashes, chars, pieces_sha256, verdict).`,
  "",
  "| Run | Tier | Characters | Verdict | Seconds | Receipt check | Receipt |",
  "|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.label} | ${r.tier} | ${r.chars} | ${r.verdict ?? `failed (${r.status || "no answer"}), not charged`} | ${r.secs} | ${r.verdict ? (r.check_ok ? "OK" : "FAILED: " + r.problems.join(", ")) : "-"} | ${r.receipt ? "`" + r.receipt + "`" : String(r.error).replace(/\|/g, "/").slice(0, 120)} |`),
  "",
  "## Per model (spec 4.3: passes with no cut-offs and every answer in 90 s or less)",
  "",
  "| Model | Calls | Answered | Cut off | Timed out | Errors | Slowest (s) | Over 90 s | Avg in | Avg out | Max out | Avg reasoning |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...Object.entries(byModel).sort().map(([k, m]) => `| ${k} | ${m.calls} | ${m.answered} | ${m.cut_off} | ${m.timeout} | ${m.error} | ${(m.max_ms / 1000).toFixed(1)} | ${m.over_90s} | ${avg(m.in)} | ${avg(m.out)} | ${mx(m.out)} | ${avg(m.reasoning)} |`),
  "",
  "Token counts are what each provider reported. Cost is worked out from them separately, at the consoles' prices.",
  "",
];
await writeFile(join(folder, "INDEX-live.md"), index.join("\n"));
await writeFile(join(folder, "results-live.json"), JSON.stringify({ plan: plan.name, base, spent_usd: spent, rows, by_model: byModel }, null, 2));
await writeFile(join(folder, "printout-live.txt"), log.join("\n") + "\n");
console.log(`\n${done.length} of ${rows.length} completed, $${spent.toFixed(2)} paid. Index: ${join(folder, "INDEX-live.md")}`);
