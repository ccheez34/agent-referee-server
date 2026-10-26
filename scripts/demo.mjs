// Plays one match of each tier against a running server with PAYMENTS_ENABLED=false.
// Usage: node scripts/demo.mjs http://localhost:8787
import { createHash, randomBytes } from "node:crypto";
const base = process.argv[2] || "http://localhost:8787";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const rnd = () => randomBytes(16).toString("hex");
async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}
async function randomTier(create, joins, valueFor) {
  const m = await call("POST", "/matches", create);
  const tokens = {};
  for (const [path, seat] of joins) tokens[seat] = (await call("POST", path, { match_id: m.match_id, seat })).seat_token;
  for (let round = 0; round < 30; round++) {
    const st = await call("GET", `/matches/${m.match_id}`);
    if (st.phase === "done" || st.phase !== "commit") return st;
    const secrets = {};
    for (const seat of st.waiting_on) {
      const value = valueFor(), nonce = rnd();
      secrets[seat] = { value, nonce };
      await call("POST", `/matches/${m.match_id}/commit`, { seat, seat_token: tokens[seat], commitment: sha(`${value}:${nonce}`) });
    }
    for (const seat of Object.keys(secrets))
      await call("POST", `/matches/${m.match_id}/reveal`, { seat, seat_token: tokens[seat], ...secrets[seat] });
  }
}
const move = () => ["rock", "paper", "scissors"][Math.floor(Math.random() * 3)];
const show = (name, st) => console.log(`${name}: phase=${st.phase} result=${JSON.stringify(st.result)}`);
show("1 rps", await randomTier({ tier: "rps", seats: ["alpha", "beta"] }, [["/join/rps", "alpha"], ["/join/rps", "beta"]], move));
show("2 rps-bo3", await randomTier({ tier: "rps-bo3", seats: ["alpha", "beta"] }, [["/join/rps-bo3", "alpha"], ["/join/rps-bo3", "beta"]], move));
show("3 weighted", await randomTier({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 70, beta: 30 } }, [["/join/weighted", "alpha"], ["/join/weighted", "beta"]], rnd));
show("4 draw", await randomTier({ tier: "draw", seats: ["alpha", "beta"], options: ["pizza", "tacos", "sushi"] }, [["/join/draw/mediator", "mediator"], ["/join/draw/party", "alpha"], ["/join/draw/party", "beta"]], rnd));
const j = await call("POST", "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: "Pick the plan that is cheaper for the user. If equal, pick the faster one." });
const jt = {};
for (const seat of ["alpha", "beta"]) jt[seat] = (await call("POST", "/join/judge", { match_id: j.match_id, seat })).seat_token;
await call("POST", `/matches/${j.match_id}/submit`, { seat: "alpha", seat_token: jt.alpha, position: "Plan A: $40, delivered in 3 days." });
const jr = await call("POST", `/matches/${j.match_id}/submit`, { seat: "beta", seat_token: jt.beta, position: "Plan B: $35, delivered in 5 days." });
show("5 judge", jr.match);
