// Live tests of the multi-part judge tiers (spec 4.3: 5 judge-3x3 and 2 judge-3x2 matches at full size), paid from the
// test wallet for BOTH seats of every match, with the tiers still off for the public: every request carries the
// operator's token. Shows the plan and the total and waits for "pay"; spending is capped at that total. For each match
// it creates the match, joins both seats (each payment settles once both seats are in), submits both sides, waits for
// the verdict, checks the receipt and both acks offline, and saves the receipt plus every judge call's time and tokens
// (operator-only). Writes INDEX-judge-live.md, results-judge-live.json and printout-judge-live.txt.
//
//   node scripts\multi-judge-live-test.mjs --wallet-file C:\Users\Admin\Downloads\test-wallet.txt --plan C:\...\plan-judge.json
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
const SEAT_PRICES = { "judge-3x2": 0.45, "judge-3x3": 0.6 }; // per seat; each match pays both seats
const PIECES = { "judge-3x2": 2, "judge-3x3": 3 };
const SEATS = ["alpha", "beta"];
const args = process.argv.slice(2);
const opt = (k, d) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : d);
if (!opt("--wallet-file") || !opt("--plan")) {
  console.log("Usage: node scripts\\multi-judge-live-test.mjs --wallet-file PATH --plan PATH_TO_plan.json [--mcp-dir PATH]");
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
const rules = (await readFile(resolve(plan.rules), "utf8")).replace(/^\uFEFF/, "");
if (rules.trim().length < 10 || rules.length > 4000) throw new Error("The rules must be 10 to 4,000 characters.");
const runs = [];
for (const r of plan.runs) {
  if (!SEAT_PRICES[r.tier]) throw new Error(`Run ${r.label}: unknown tier ${r.tier}.`);
  const sides = {};
  for (const s of SEATS) {
    const files = r[s];
    if (!Array.isArray(files) || files.length !== PIECES[r.tier]) throw new Error(`Run ${r.label}: ${s} needs exactly ${PIECES[r.tier]} piece files.`);
    sides[s] = [];
    for (const f of files) sides[s].push((await readFile(resolve(f), "utf8")).replace(/^\uFEFF/, ""));
    if (sides[s].some((t) => !t.trim() || t.length > 6000)) throw new Error(`Run ${r.label}: a ${s} piece is empty or over 6,000 characters.`);
  }
  const total = SEATS.reduce((n, s) => n + sides[s].reduce((m, t) => m + t.length, 0), 0);
  runs.push({ ...r, sides, total, cost: 2 * SEAT_PRICES[r.tier] });
}
const totalUsd = Math.round(runs.reduce((n, r) => n + r.cost, 0) * 100) / 100;
const log = [];
const say = (s = "") => (console.log(s), log.push(s));
say(`${plan.name}: ${runs.length} matches, both seats paid by this wallet, $${totalUsd.toFixed(2)} in all. Service: ${base}`);
for (const r of runs) say(`  ${r.label}: ${r.tier}, ${r.panel.join(", ")}  (${r.total} characters, $${r.cost.toFixed(2)})`);
say("Each seat's payment settles once both seats are in, before submitting. A match that then can't be judged goes on the refund list (refunded by hand).");
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
// One payment is at most one seat at the highest seat price.
const paying = mod.wrapFetchWithPayment(globalThis.fetch.bind(globalThis), signer, BigInt(Math.round(Math.max(...Object.values(SEAT_PRICES)) * 1e6)));

// ---------- checks ----------
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const canonical = (v) =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const pubKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(keyB64, "base64")]), format: "der", type: "spki" });
const signed = (doc) => !!doc?.signature && verify(null, Buffer.from(canonical(doc.payload ?? {}), "utf8"), pubKey, Buffer.from(doc.signature, "base64"));
const company = (m) => (m.includes("/") ? m.split("/")[0] : m.startsWith("claude") ? "anthropic" : "other");
function checkReceipt(r, rc, acks) {
  const p = rc?.payload ?? {};
  const problems = [];
  if (!signed(rc)) problems.push("signature");
  if (p.receipt_format !== "judge-multi-v1" || p.tier !== r.tier) problems.push("format or tier");
  const proof = p.proof ?? {};
  if (proof.judge?.format_version !== "agent-referee-judge-v5-multi") problems.push("format_version");
  if ("submission_sha256" in proof) problems.push("submission_sha256 present");
  if (proof.rules_sha256 !== sha(rules)) problems.push("rules hash");
  for (const s of SEATS) {
    const want = r.sides[s].map((t, i) => ({ index: i + 1, sha256: sha(t), chars: t.length }));
    if (canonical(proof.pieces?.[s]) !== canonical(want)) problems.push(`${s} pieces`);
    if (proof.pieces_sha256?.[s] !== sha(canonical(want))) problems.push(`${s} pieces_sha256`);
    const ack = acks[s];
    if (!signed(ack) || ack.payload.step !== "submit" || ack.payload.pieces_sha256 !== proof.pieces_sha256?.[s]) problems.push(`${s} ack`);
  }
  const out = p.outcome ?? {};
  const votes = out.votes ?? [];
  if (votes.length !== 3 || new Set((proof.judge?.panel ?? []).map((x) => company(x.model))).size !== 3) problems.push("panel");
  const tally = { alpha: 0, beta: 0, mistrial: 0 };
  for (const v of votes) tally[v.winner ?? "mistrial"]++;
  const winner = SEATS.find((s) => tally[s] >= 2) ?? null;
  if ((out.winner ?? null) !== winner || canonical(out.tally) !== canonical(tally)) problems.push("verdict");
  return problems;
}

// ---------- run ----------
const H = { "content-type": "application/json", "x-operator-token": opToken };
const post = (path, body, f = fetch, ms = 330_000) => f(`${base}${path}`, { method: "POST", headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
const status = async (id) => (await fetch(`${base}/matches/${id}`, { headers: H })).json();
const folder = resolve(plan.folder);
await mkdir(join(folder, "receipts-judge-live"), { recursive: true });
const short = (m) => (m.startsWith("claude-") ? m.split("-")[1] : m.includes("gpt") ? "gpt" : m.split("/").pop().split(/[-.]/).filter((x) => /^[a-z]+$/.test(x)).pop());
const rows = [];
let spent = 0;
for (const [i, r] of runs.entries()) {
  if (spent + r.cost > totalUsd + 1e-9) {
    say(`\nStopping: the next match would pass the $${totalUsd.toFixed(2)} cap.`);
    break;
  }
  say(`\n===== ${r.label} (${i + 1} of ${runs.length}): ${r.tier}, ${r.total} characters =====`);
  const row = { label: r.label, tier: r.tier, chars: r.total, calls: [] };
  rows.push(row);
  try {
    const created = await (await post("/matches", { tier: r.tier, seats: SEATS, rules, title: `Live test ${r.label}`, panel: r.panel })).json();
    if (!created.match_id) throw new Error(`create: ${JSON.stringify(created).slice(0, 300)}`);
    row.match_id = created.match_id;
    // Both seats at once: each paid join waits for the other, and its payment settles once both are in.
    const joins = await Promise.all(SEATS.map((s) => post(`/join/${r.tier}`, { match_id: created.match_id, seat: s }, paying, 60_000).then(async (res) => ({ s, status: res.status, body: await res.json().catch(() => null) }))));
    const tok = {};
    for (const j of joins) {
      if (j.status === 200 && j.body?.seat_token) {
        tok[j.s] = j.body.seat_token;
        spent += SEAT_PRICES[r.tier];
      }
    }
    if (Object.keys(tok).length !== 2) throw new Error(`join: ${joins.map((j) => `${j.s} ${j.status} ${JSON.stringify(j.body?.error ?? "").slice(0, 150)}`).join("; ")}`);
    const t0 = Date.now();
    const acks = {};
    const a = await (await post(`/matches/${created.match_id}/submit`, { seat: "alpha", seat_token: tok.alpha, pieces: r.sides.alpha.map((text) => ({ text })) })).json();
    acks.alpha = a.ack;
    // The second submit waits for the verdict; if the connection gives up first, the status below picks it up.
    try {
      const b = await (await post(`/matches/${created.match_id}/submit`, { seat: "beta", seat_token: tok.beta, pieces: r.sides.beta.map((text) => ({ text })) })).json();
      acks.beta = b.ack;
    } catch (e) {
      say(`  (the second submit's connection ended: ${String(e?.message ?? e).slice(0, 120)}; checking the status instead)`);
    }
    // Wait for the verdict: the match retries judging on its own after a failure (30 s, 1, 2, 5 minutes).
    let st = await status(created.match_id);
    while (st.phase !== "done" && st.error_code !== "unjudged" && Date.now() - t0 < 12 * 60_000) {
      await new Promise((ok) => setTimeout(ok, 10_000));
      st = await status(created.match_id);
    }
    row.secs = Math.round((Date.now() - t0) / 1000);
    row.calls = st.operator?.judge_calls ?? [];
    for (const k of row.calls) say(`  run ${k.run}  panelist ${k.panelist}  ${k.model.padEnd(24)} try ${k.try_number}  ${(k.ms / 1000).toFixed(1).padStart(6)} s  ${k.outcome}${k.status ? ` ${k.status}` : ""}  in ${k.input_tokens ?? "?"}  out ${k.output_tokens ?? "?"}${k.reasoning_tokens ? ` (reasoning ${k.reasoning_tokens})` : ""}`);
    if (st.phase === "done" && st.receipt) {
      const problems = acks.beta ? checkReceipt(r, st.receipt, acks) : [...checkReceipt(r, st.receipt, { ...acks, beta: { payload: { step: "submit", pieces_sha256: st.receipt.payload.proof?.pieces_sha256?.beta }, signature: "" } }).filter((x) => x !== "beta ack"), "beta ack missing (connection ended)"];
      const winner = st.receipt.payload.outcome?.winner ?? "mistrial";
      const name = `${r.label}-${st.judge.panel.map((x) => short(x.model)).join("-")}-${winner}.json`;
      await writeFile(join(folder, "receipts-judge-live", name), JSON.stringify({ match_id: created.match_id, receipt: st.receipt, acks, judge_calls: row.calls }, null, 2));
      say(`WINNER ${winner} (${JSON.stringify(st.receipt.payload.outcome?.tally)}) in ${row.secs} s. Receipt check: ${problems.length ? "FAILED (" + problems.join(", ") + ")" : "OK"}. Saved receipts-judge-live\\${name}`);
      Object.assign(row, { winner, check_ok: !problems.length, problems, receipt: `receipts-judge-live/${name}` });
    } else {
      say(`Not judged (${st.phase}${st.error_code ? `, ${st.error_code}` : ""}) after ${row.secs} s: ${String(st.error ?? "").slice(0, 300)}. Both seats paid; the match is on the refund list once judging gives up.`);
      Object.assign(row, { error: `${st.phase} ${st.error_code ?? ""} ${String(st.error ?? "").slice(0, 200)}` });
    }
  } catch (e) {
    row.error = String(e?.message ?? e).slice(0, 300);
    say(`Stopped this match: ${row.error}`);
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
const done = rows.filter((r) => r.winner);
const index = [
  `# ${plan.name}`,
  "",
  `${new Date().toISOString().slice(0, 10)}. ${done.length} of ${rows.length} judged, $${spent.toFixed(2)} paid (both seats of each match). Every judged receipt and both submit acks were checked offline (signature against ${base}/pubkey, rules and piece hashes, chars, pieces_sha256, panel, verdict and tally).`,
  "",
  "| Match | Tier | Characters | Winner | Seconds | Receipt check | Receipt |",
  "|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.label} | ${r.tier} | ${r.chars} | ${r.winner ?? "not judged"} | ${r.secs ?? "-"} | ${r.winner ? (r.check_ok ? "OK" : "FAILED: " + r.problems.join(", ")) : "-"} | ${r.receipt ? "`" + r.receipt + "`" : String(r.error ?? "").replace(/\|/g, "/").slice(0, 120)} |`),
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
await writeFile(join(folder, "INDEX-judge-live.md"), index.join("\n"));
await writeFile(join(folder, "results-judge-live.json"), JSON.stringify({ plan: plan.name, base, spent_usd: spent, rows, by_model: byModel }, null, 2));
await writeFile(join(folder, "printout-judge-live.txt"), log.join("\n") + "\n");
console.log(`\n${done.length} of ${rows.length} judged, $${spent.toFixed(2)} paid. Index: ${join(folder, "INDEX-judge-live.md")}`);
