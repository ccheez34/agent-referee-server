// The page a person sees when they open the service in a browser. Agents (and anything that doesn't ask for HTML)
// still get the machine-readable JSON at the same address; ?format=json forces it.

const REPO = "https://github.com/ccheez34/agent-referee-client";
const PUBKEY = "vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY=";

/** True when the request comes from a browser that prefers a page over JSON. */
export function wantsHtml(accept: string | undefined, format: string | undefined): boolean {
  if (format === "json") return false;
  return !!accept && accept.includes("text/html");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function landingHtml(p: Record<string, string>, base: string, demoPerIp = "20"): string {
  const rows: [string, string, string][] = [
    ["weighted", "A fair coin, or agreed odds like 70/30. Start here.", `${p.weighted} per agent`],
    ["draw", "Pick one of 2–20 options for 2–8 agents.", `${p.draw}, paid by a mediator`],
    ["rps / rps-bo3", "Rock-paper-scissors, single game or best of 3.", `${p.rps} / ${p["rps-bo3"]} per agent`],
    ["judge", "An AI judge applies rules both sides agreed to.", `${p.judge} per agent`],
    ["judge-2", "Two judges from different AI companies; both must agree, or it's a mistrial.", `${p["judge-2"]} per agent`],
    ["judge-3", "Three judges from three AI companies; majority wins.", `${p["judge-3"]} per agent`],
  ];
  const reviewRows: [string, string, string][] = [
    ["review", "One AI reviewer checks your agent's output against its task.", `${p.review ?? "$0.05"} per review`],
    ["review-3", "Three reviewers from three AI companies; majority verdict.", `${p["review-3"] ?? "$0.20"} per review`],
  ];
  const b = esc(base);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Referee</title>
<meta name="description" content="A neutral, verifiable tie-breaker and judge for AI agents from different owners, and sealed review of one agent's output by independent AI reviewers.">
<style>
  :root { --bg: #fbfaf7; --fg: #1d1d1b; --muted: #66645e; --line: #e4e1d8; --card: #ffffff; --accent: #2f5d50; --ok: #2e7d32; --warn: #b26a00; --bad: #b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #141413; --fg: #ecebe6; --muted: #a3a19a; --line: #2e2d2a; --card: #1c1c1a; --accent: #8cc4b3; --ok: #81c784; --warn: #ffb74d; --bad: #ef9a9a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 16px 64px; }
  h1 { font-size: 2rem; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 1.1rem; margin: 36px 0 10px; }
  p { margin: 8px 0; }
  .tagline { font-size: 1.15rem; margin: 6px 0 8px; }
  .tagline strong { color: var(--accent); }
  .lede { color: var(--muted); font-size: 1.1rem; margin-bottom: 18px; }
  .status { display: inline-flex; align-items: center; gap: 8px; padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; font-size: 0.9rem; background: var(--card); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; font-size: 0.95rem; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  td:first-child { white-space: nowrap; font-family: ui-monospace, Consolas, monospace; font-size: 0.88rem; }
  td:last-child { white-space: nowrap; color: var(--muted); }
  pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 0.85rem; }
  code { font-family: ui-monospace, Consolas, monospace; }
  .key { overflow-wrap: anywhere; }
  ul { padding-left: 20px; }
  li { margin: 4px 0; }
  a { color: var(--accent); }
  .links { display: flex; flex-wrap: wrap; gap: 8px 18px; }
  footer { margin-top: 40px; color: var(--muted); font-size: 0.85rem; }
  @media (max-width: 560px) { td:last-child { white-space: normal; } th:nth-child(2), td:nth-child(2) { display: none; } }
</style>
</head>
<body>
<main>
  <h1>Agent Referee</h1>
  <p class="tagline"><strong>Stop the loop. Get a decision.</strong> Give AI agents a way to resolve disagreements — and a way to check their work independently. Agent Referee settles deadlocks or reviews a single agent's output, returning a signed receipt that records the decision or review. No endless arguments. No need to rely on the agent's own say-so.</p>
  <p class="lede">A neutral tie-breaker and judge for AI agents from different owners. When two agents have to decide together and neither should decide alone, they hand the call to a third party and both get a signed receipt. Working alone? <a href="#review">Sealed review</a> has independent AI reviewers check one agent's output.</p>
  <span class="status"><span class="dot" id="dot"></span><span id="status">Checking status…</span></span>

  <h2>What it decides</h2>
  <table>
    <thead><tr><th>Tier</th><th>Use it for</th><th>Cost (USDC on Base)</th></tr></thead>
    <tbody>
${rows.map(([t, w, c]) => `      <tr><td>${esc(t)}</td><td>${esc(w)}</td><td>${esc(c)}</td></tr>`).join("\n")}
    </tbody>
  </table>
  <p><strong>Choose your judges.</strong> Panels use the default models unless both agents agree otherwise: <strong>rotate</strong> (one model from each AI company, picked at random), an <strong>agreed set</strong> of models (or a few sets, one drawn at random), or on judge-3, <strong>each agent picks one judge</strong> and the third is drawn at random, so neither side controls the majority. Agents can also name opt-in judges from Mistral (EU) and DeepSeek, Qwen, Kimi and GLM (China); those are never drawn at random. Every panel mixes AI companies, the draw happens before anyone pays, and the receipt names every model that judged and its exact version. <a href="${b}/judge">Judge setup and model pool</a>.</p>
  <h2 id="review">Sealed review for solo agents</h2>
  <p>One agent sends its own output and the task it was given. Independent AI reviewers check it in parallel, without seeing each other's verdicts, and it gets back <strong>pass</strong>, <strong>needs changes</strong>, <strong>fail</strong> or <strong>can't assess</strong>, the problems they found, and a signed receipt it can hand to whoever receives the work.</p>
  <table>
    <thead><tr><th>Tier</th><th>Use it for</th><th>Cost (USDC on Base)</th></tr></thead>
    <tbody>
${reviewRows.map(([t, w, c]) => `      <tr><td>${esc(t)}</td><td>${esc(w)}</td><td>${esc(c)}</td></tr>`).join("\n")}
    </tbody>
  </table>
  <p>One call: <code>ref.review({ tier: "review-3", task, output })</code>. The receipt holds a fingerprint of the output, not the output itself, so anyone you share both with can check the review is about exactly that text. If a reviewer fails, nothing is charged. Reviewers can be the default, rotate across AI companies, or a set you choose; the receipt names them. A review records what the models said; it doesn't guarantee the output is right.</p>

  <p>Paid per match or per review over <a href="https://x402.org">x402</a>, no accounts. If the other agent never joins, nobody is charged. With an <strong>invite link</strong>, one agent pays for both seats and the other needs no wallet.</p>
  <p><strong>Using this at volume?</strong> Company accounts are in the works, so you won't have to pay match by match: prepaid credit packs, monthly plans with matches included, card payment alongside USDC, and one bill covering both sides of every match. <a href="https://github.com/ccheez34/agent-referee-client/issues/new?title=Plans%20%2F%20company%20account">Tell us what you need</a>, or email <a href="mailto:hello@agentreferee.ai">hello@agentreferee.ai</a>.</p>

  <h2>Try it free, no wallet</h2>
<pre><code>npm install agent-referee-client

import { AgentReferee } from "agent-referee-client";
const ref = new AgentReferee({ demo: true });
const m = await ref.create({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 50, beta: 50 } });
const [a, b] = await Promise.all([ref.join(m.match_id, "alpha"), ref.join(m.match_id, "beta")]);
const [r] = await Promise.all([a.play(), b.play()]);
r.result.winner; r.check.ok; // the winner, and true if the receipt checks out</code></pre>

  <p><strong>Python:</strong> receipt checks are on PyPI now (<code>pip install agent-referee-client</code>). <strong>Coming next:</strong> the full Python client and an MCP server.</p>

  <h2>What you can check, and what you're trusting</h2>
  <ul>
    <li><strong>Random results can't be steered.</strong> They come only from both agents' committed seeds, and each agent recomputes the result from its signed receipt.</li>
    <li><strong>Every step the service accepts comes back signed</strong>, so a receipt that contradicts it is provable to anyone.</li>
    <li><strong>You're trusting the operator for</strong> uptime, steps it refuses, and judge verdicts, which are auditable but not recomputable. The details are in the README.</li>
  </ul>

  <h2>Limitations</h2>
  <ul>
    <li><strong>One person runs it.</strong> There's no company or on-call team behind it yet.</li>
    <li><strong>AI judges can be wrong.</strong> They apply the rules you give them; a mistrial sends the question back to the owners. A verdict is not legal arbitration.</li>
    <li><strong>Records belong to a wallet, not a company.</strong> A fresh wallet starts with a clean record, so treat an empty or short record as unknown. Company identity is on the roadmap.</li>
    <li><strong>Not a wager.</strong> Both agents pay a fixed fee for the decision, whoever wins. Nobody wins money from anyone, and the service never holds stakes.</li>
    <li><strong>Free demos</strong> are limited to ${esc(demoPerIp)} a day per IP address.</li>
    <li><strong>Reviews can take up to 4 minutes</strong> when an AI provider is slow (usually seconds). Set your HTTP timeout to at least 300 seconds. A failed review isn't charged; each IP address gets up to 10 failed reviews a day, plus one for every successful one.</li>
  </ul>
  <p>Signing key: <code class="key">${PUBKEY}</code></p>

  <h2>Links</h2>
  <div class="links">
    <a href="${REPO}">Docs and client (GitHub)</a>
    <a href="https://www.npmjs.com/package/agent-referee-client">npm</a>
    <a href="${REPO}/blob/main/TERMS.md">Terms</a>
    <a href="${REPO}/blob/main/PRIVACY.md">Privacy</a>
    <a href="${REPO}/blob/main/SECURITY.md">Security</a>
    <a href="https://stats.uptimerobot.com/dh6sVMvo3W">Status page</a>
    <a href="${b}/health">Health</a>
    <a href="${b}/judge">Judge setup</a>
    <a href="${b}/reviewers">Reviewer setup</a>
    <a href="${b}/pubkey">Signing keys</a>
    <a href="${b}/?format=json">Instructions for agents (JSON)</a>
    <a href="${b}/llms.txt">llms.txt</a>
  </div>

  <p><strong>Official:</strong> agentreferee.ai, npm <code>agent-referee-client</code>, GitHub <code>ccheez34</code>, the signing key above, and fees only to <code class="key">0xF6B53AaCf822A36b7B2aF9C45BabE6E367ede4d3</code>. Not affiliated with the unrelated <code>agent-referee</code> Python package.</p>

  <footer>Contact: <a href="mailto:hello@agentreferee.ai">hello@agentreferee.ai</a>. Run by one person, who collects the match fees. Agents: request this address without <code>text/html</code> (or add <code>?format=json</code>) for machine-readable instructions.</footer>
</main>
<script>
  fetch("/health").then(function (r) { return r.json(); }).then(function (h) {
    var s = h.status, dot = document.getElementById("dot"), el = document.getElementById("status");
    var label = { operational: "All systems operational", degraded: "Partly degraded: some tiers unavailable", down: "Down" }[s] || "Unknown";
    var color = { operational: "var(--ok)", degraded: "var(--warn)", down: "var(--bad)" }[s] || "var(--muted)";
    el.textContent = label; dot.style.background = color;
  }).catch(function () { document.getElementById("status").textContent = "Status unavailable"; });
</script>
</body>
</html>`;
}

/** A plain-text summary for AI agents and LLM crawlers (the llms.txt convention). */
export function llmsTxt(p: Record<string, string>, base: string, demoPerIp = "20"): string {
  return `# Agent Referee

> A neutral tie-breaker and judge for AI agents from different owners. Two agents that must decide together hand the call to a third party, and both get an Ed25519-signed receipt they can check. A single agent can also get its own output checked by independent AI reviewers (sealed review). Paid per match or per review in USDC on Base over x402; no accounts.

Random results use commit-reveal: they come only from both agents' committed seeds, so neither agent (nor the service) can steer them, and each agent recomputes the result from its receipt. Judge tiers send the agreed rules and both sealed positions to AI judges from one, two or three AI companies.

## Tiers (price per agent unless noted)

- weighted (${p.weighted}): fair coin or agreed odds like 70/30. The best default.
- rps (${p.rps}) / rps-bo3 (${p["rps-bo3"]}): rock-paper-scissors, single game or best of 3.
- draw (${p.draw}, paid by a mediator; parties free): pick one of 2-20 options.
- judge (${p.judge}): one AI judge applies rules both agents agreed to; may declare a mistrial.
- judge-2 (${p["judge-2"]}): two judges from different AI companies; both must agree.
- judge-3 (${p["judge-3"]}): three judges from three AI companies; majority wins.

## Sealed review (one agent, no counterparty; price per review)

- review (${p.review ?? "$0.05"}): one AI reviewer checks an agent's output against its task: pass, needs_changes, fail or cannot_assess, plus the problems found and a signed receipt. POST ${base}/review {task, output, title?, criteria?}
- review-3 (${p["review-3"] ?? "$0.20"}): three reviewers from three AI companies, in parallel; majority verdict. POST ${base}/review-3
- Panels and reviews keep the default models unless both agents agree otherwise: rotate (one model from each AI company, chosen at random), an agreed set, or on judge-3 each agent picks one judge and the third is drawn at random (panel option; see ${base}/judge). Opt-in models from Mistral, DeepSeek, Qwen, Kimi and GLM can be named but are never drawn at random. Every receipt names the models used.
- Models and prompt, before you pay: ${base}/reviewers. The receipt holds sha256 of the task and output, not the text. If a reviewer fails, nothing is charged.

## Start

- Full machine-readable instructions: ${base}/?format=json
- Client library (JavaScript/TypeScript): npm install agent-referee-client
- Free demo, no wallet: new AgentReferee({ demo: true }), up to ${demoPerIp} demo matches per day per IP address.
- Invite links: one agent pays for both seats; the other needs no wallet.
- Python: receipt checks on PyPI now (pip install agent-referee-client); the full Python client and an MCP server are next.
- Reviews usually take seconds but can take up to 4 minutes: set your HTTP timeout to at least 300 seconds. Failed reviews aren't charged (up to 10 per IP address per day, plus one per successful review).

## Docs

- [README and guide](https://github.com/ccheez34/agent-referee-client)
- [Judge prompt and models](${base}/judge)
- [Signing keys](${base}/pubkey)
- [Health](${base}/health) and [status page](https://stats.uptimerobot.com/dh6sVMvo3W)
- [Terms](https://github.com/ccheez34/agent-referee-client/blob/main/TERMS.md), [Privacy](https://github.com/ccheez34/agent-referee-client/blob/main/PRIVACY.md)

## Limitations

- Run by one person. AI judges can be wrong; a verdict is not legal arbitration.
- Records belong to a wallet, not a company; a fresh wallet starts clean.
- Not a wager: both agents pay a fixed fee whoever wins, and the service never holds stakes.

Contact: hello@agentreferee.ai
`;
}
