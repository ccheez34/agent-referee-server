// One runner's share of a many-machine burst against the STAGING Worker (fake AI, payments off).
// GitHub Actions starts several runners (each a separate machine and IP); every runner waits for the same start
// time, then fires all its requests at once. Writes its results to burst-result.json for the summary job.
//
//   node scripts/burst-many.mjs --url <staging url> --n 150 --start <epoch ms> --runner 7
import { writeFile } from "node:fs/promises";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const url = String(args.url || "").replace(/\/$/, "");
const n = Number(args.n || 150);
const start = Number(args.start || 0);
if (!/staging/.test(url)) throw new Error("Staging only.");
// Node's built-in fetch has no per-host connection limit, so all n requests go out in parallel.

const h = await fetch(`${url}/health`).then((r) => r.json());
if (h.checks?.payments !== "off") throw new Error(`payments are "${h.checks?.payments}" on this Worker; refusing.`);
// Open the connections before the start (TLS handshakes), so the burst itself is just the requests.
await Promise.all(Array.from({ length: Math.min(n, 50) }, () => fetch(`${url}/health`).then((r) => r.arrayBuffer()).catch(() => {})));

const wait = start - Date.now();
console.log(`runner ${args.runner}: ${n} requests, starting in ${(wait / 1000).toFixed(1)} s`);
if (wait < 0) console.log("WARNING: this runner started late; its requests go out now.");
await new Promise((r) => setTimeout(r, Math.max(0, wait)));

const task = "Add 2 and 2 and give only the number.";
const results = await Promise.all(
  Array.from({ length: n }, async (_, i) => {
    const sent = Date.now();
    try {
      const res = await fetch(`${url}/review`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-caller": `r${args.runner}-${i}` },
        body: JSON.stringify({ task, output: "4" }),
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, busy: !!body.busy, retryAfter: res.headers.get("retry-after"), sent, ms: Date.now() - sent, error: res.status >= 400 ? String(body.error ?? "").slice(0, 100) : "" };
    } catch (e) {
      return { status: 0, sent, ms: Date.now() - sent, error: `${String(e?.message ?? e).slice(0, 60)} (${String(e?.cause?.code || e?.cause?.message || "").slice(0, 60)})` };
    }
  }),
);
await writeFile("burst-result.json", JSON.stringify({ runner: args.runner, start, results }));
const by = {};
for (const r of results) {
  const k = r.status === 503 && r.busy ? "503 busy" : String(r.status);
  by[k] = (by[k] ?? 0) + 1;
}
console.log(`runner ${args.runner}: ${JSON.stringify(by)}`);
