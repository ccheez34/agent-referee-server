// Free load test against the STAGING Worker (fake AI answers, payments off). Never point this at the live service.
//
//   node scripts/load-test.mjs --url https://agent-referee-staging.<you>.workers.dev --scenario burst --n 300
//
// Scenarios:
//   burst    --n N              N sealed reviews at once (S1: 300, S2: 3000)
//   sustain  --rate R --minutes M   R reviews per second for M minutes (S3: 20/s for 10 min)
//   review3  --n N              N review-3 calls at once (three reviewers each, two providers)
//   demos    --n N --callers C  N free demo matches from C different callers (S6: 5000 from 1000)
//   mixed    --n N              reviews, review-3, demo matches and /health together (S7)
// Pass: only 200, 503 "busy" (with Retry-After), 429 (limits) and nothing slower than 300 s; no 5xx other than busy.
const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]?.startsWith("--") ? "true" : all[i + 1]]] : a), []),
);
const url = String(args.url || "").replace(/\/$/, "");
if (!url) {
  console.log("Usage: node scripts/load-test.mjs --url <staging url> --scenario burst|sustain|review3|demos|mixed [--n 300]");
  process.exit(1);
}
if (/agentreferee\.ai|agent-referee\.fairplayclub/.test(url) && !/staging/.test(url)) {
  console.log("That looks like the live service. This script only runs against the staging Worker.");
  process.exit(1);
}
const scenario = args.scenario || "burst";
const n = Number(args.n || 300);
const callers = Number(args.callers || 1000);

const health = await fetch(`${url}/health`).then((r) => r.json()).catch(() => null);
if (!health) {
  console.log(`No answer from ${url}/health. Is the staging Worker deployed?`);
  process.exit(1);
}
if (health.checks?.payments !== "off") {
  console.log(`Refusing to run: payments are "${health.checks?.payments}" on this Worker (staging has them off).`);
  process.exit(1);
}

const results = [];
const task = "Add 2 and 2 and give only the number.";
async function one(kind, i) {
  const t0 = Date.now();
  const caller = String(i % callers);
  let req;
  if (kind === "review" || kind === "review-3")
    req = fetch(`${url}/${kind}`, { method: "POST", headers: { "content-type": "application/json", "x-test-caller": caller }, body: JSON.stringify({ task, output: "4" }) });
  else if (kind === "demo")
    req = fetch(`${url}/matches`, { method: "POST", headers: { "content-type": "application/json", "x-test-caller": caller }, body: JSON.stringify({ tier: "rps", seats: ["a", "b"], demo: true }) });
  else req = fetch(`${url}/health`);
  try {
    const res = await req;
    const body = await res.json().catch(() => ({}));
    results.push({ kind, status: res.status, ms: Date.now() - t0, busy: !!body.busy, retryAfter: res.headers.get("retry-after"), error: res.status >= 400 ? String(body.error ?? "").slice(0, 120) : "" });
  } catch (e) {
    results.push({ kind, status: 0, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 120) });
  }
}

const started = Date.now();
console.log(`Scenario ${scenario} against ${url} ...`);
if (scenario === "sustain") {
  const rate = Number(args.rate || 20);
  const minutes = Number(args.minutes || 10);
  const pending = [];
  let i = 0;
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    for (let k = 0; k < rate; k++) pending.push(one("review", i++));
    await new Promise((r) => setTimeout(r, 1000));
    if (i % (rate * 30) === 0) console.log(`  ${Math.round((Date.now() - started) / 1000)} s: ${i} sent, ${results.length} answered`);
  }
  await Promise.all(pending);
} else {
  const kinds = { burst: ["review"], review3: ["review-3"], demos: ["demo"], mixed: ["review", "review", "review-3", "demo", "health"] }[scenario] ?? ["review"];
  await Promise.all(Array.from({ length: n }, (_, i) => one(kinds[i % kinds.length], i)));
}

const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0);
console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(0)} s. ${results.length} answers.`);
for (const kind of [...new Set(results.map((r) => r.kind))]) {
  const rs = results.filter((r) => r.kind === kind);
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  const by = {};
  for (const r of rs) {
    const key = r.status === 503 && r.busy ? "503 busy" : String(r.status);
    by[key] = (by[key] ?? 0) + 1;
  }
  console.log(`  ${kind}: ${JSON.stringify(by)}  p50 ${pct(ms, 50)} ms, p95 ${pct(ms, 95)} ms, p99 ${pct(ms, 99)} ms, max ${ms[ms.length - 1]} ms`);
}
const unexpected = results.filter((r) => !(r.status === 200 || r.status === 201 || r.status === 429 || (r.status === 503 && r.busy && r.retryAfter)));
const slow = results.filter((r) => r.ms > 300_000);
const examples = [...new Set(unexpected.map((r) => `${r.status} ${r.error}`))].slice(0, 8);
console.log(`\nUnexpected answers: ${unexpected.length}${examples.length ? "\n  " + examples.join("\n  ") : ""}`);
console.log(`Slower than 300 s: ${slow.length}`);
const h = await fetch(`${url}/health`).then((r) => r.json()).catch(() => null);
console.log(`Health now: ${h?.status} ${h?.reasons?.length ? "(" + h.reasons.join(", ") + ")" : ""}  providers: ${JSON.stringify(h?.checks?.providers ?? {})}`);
console.log(unexpected.length || slow.length ? "\nRESULT: FAIL" : "\nRESULT: PASS");
