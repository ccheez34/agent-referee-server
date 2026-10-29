// Saves GET /admin/stats (the last 7 days of usage counts, requests by country, region refusals and recent
// cut-offs) to a dated file, so the counts survive after the service deletes days older than 7. Run it every few
// days until the log search (PLAN-priorities 0.1, 0.2) is done. The admin token is typed at a hidden prompt and is
// never shown, saved or sent anywhere except the service.
//
//   node scripts\save-admin-stats.mjs
//   Optional: --out C:\path\to\folder   (default: claud\research\checks\admin-stats)
//             --base https://agent-referee.fairplayclub.workers.dev   (default: https://agentreferee.ai)
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : d);
const base = String(opt("--base", "https://agentreferee.ai")).replace(/\/+$/, "");
// The token only ever goes to Agent Referee's own addresses.
const OWN = ["https://agentreferee.ai", "https://agent-referee.fairplayclub.workers.dev", "https://agent-referee-staging.fairplayclub.workers.dev"];
if (!OWN.includes(base)) {
  console.log(`${base} isn't one of Agent Referee's addresses (${OWN.join(", ")}). Stopped.`);
  process.exit(1);
}
const out = resolve(opt("--out", "C:\\Users\\Admin\\Downloads\\claud\\research\\checks\\admin-stats"));

function askHidden(question) {
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.includes(question) ? s : "");
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write("\n");
      done(a.trim());
    });
  });
}

const token = await askHidden("Admin token (ADMIN_TOKEN, hidden as you type or paste): ");
const res = await fetch(`${base}/admin/stats`, { headers: { authorization: `Bearer ${token}` } });
const text = await res.text();
if (res.status !== 200) {
  console.log(`GET /admin/stats answered ${res.status}: ${text.slice(0, 200)}. Nothing was saved.`);
  process.exit(1);
}
await mkdir(out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = join(out, `admin-stats-${stamp}.json`);
await writeFile(file, JSON.stringify({ saved_at: new Date().toISOString(), base, stats: JSON.parse(text) }, null, 2));
console.log(`Saved ${file}`);
