// Combines every runner's burst-result.json into one verdict (the same pass rules as load-test.mjs).
import { readdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
const dir = process.argv[2] || "results";
const all = [];
let runners = 0;
for (const d of await readdir(dir)) {
  const j = JSON.parse(await readFile(join(dir, d, "burst-result.json"), "utf8"));
  runners++;
  all.push(...j.results);
}
const by = {};
for (const r of all) {
  const k = r.status === 503 && r.busy ? "503 busy" : String(r.status);
  by[k] = (by[k] ?? 0) + 1;
}
const sent = all.map((r) => r.sent).sort((a, b) => a - b);
const ms = all.map((r) => r.ms).sort((a, b) => a - b);
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
const ok = (r) => r.status === 200 || r.status === 429 || (r.status === 503 && r.busy && r.retryAfter);
const unexpected = all.filter((r) => !ok(r));
const slow = all.filter((r) => r.ms > 300_000);
const examples = [...new Set(unexpected.map((r) => `${r.status} ${r.error}`))].slice(0, 8);
const lines = [
  `## Many-machine burst`,
  `- Runners (separate machines): ${runners}; requests: ${all.length}`,
  `- Sent within: ${((sent[sent.length - 1] - sent[0]) / 1000).toFixed(2)} s (first to last request leaving its machine); 95% within ${((pct(sent, 97.5) - pct(sent, 2.5)) / 1000).toFixed(2)} s`,
  `- Answers: ${JSON.stringify(by)}`,
  `- Time to answer: p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, p99 ${pct(ms, 99)} ms, max ${ms[ms.length - 1]} ms`,
  `- Unexpected answers: ${unexpected.length}${examples.length ? " (" + examples.join("; ") + ")" : ""}`,
  `- Slower than 300 s: ${slow.length}`,
  ``,
  unexpected.length || slow.length ? `**RESULT: FAIL**` : `**RESULT: PASS**`,
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
