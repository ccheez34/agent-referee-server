// Judge tiers with Claude judges off (judge-tier spec v2.1, §10): what "off" does. The other judge tests run with the
// switch on, so their expectations (today's Claude defaults) hold; this file is the "off" side, with the settings
// wrangler.jsonc ships. Route tests need the installed dependencies (hono, x402-hono), as in routes.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchRoom, MAX_JUDGE_RUNS } from "../src/match.ts";
import { Health, _resetHealthCaches } from "../src/health.ts";
import { Gate } from "../src/gate.ts";
import { Ledger } from "../src/ledger.ts";
import { _clearSnapshots } from "../src/gateclient.ts";
import { commitmentOf, randomToken } from "../src/logic.ts";
import { verifyReceipt } from "../src/receipt.ts";
import { CLAUDE_JUDGES_OFF, JUDGE_ADVISORY, choosePanel, claudeJudgesOn, companyOf, defaultJudgeModels, judgeAllowed, judgePool, judgeTierClosed, judgeTierWaitsForCompany, allowedModels, PanelShortError, tierCommitment } from "../src/judge.ts";
import { reviewModels } from "../src/review.ts";
import { multiModels } from "../src/multipart.ts";

let app: any = null;
try {
  app = (await import("../src/index.ts")).default;
} catch (e) {
  console.log(`judge-no-claude route tests skipped (dependencies not installed here): ${String((e as any)?.message ?? e).slice(0, 120)}`);
}
const routeTest = app ? test : test.skip;

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };

const OPUS = "claude-opus-5-5", SONNET = "claude-sonnet-5-5", HAIKU = "claude-haiku-5-5";
const LUNA = "openai/gpt-6-luna", ARGON = "google/gemini-4-argon", FLASH = "google/gemini-3.7-flash", MISTRAL = "mistralai/mistral-large-4-0", KIMI = "moonshotai/kimi-k3";
/** The judge settings wrangler.jsonc ships (live and staging), with the switch off. */
const SHIPPED = {
  JUDGE_MODEL: FLASH,
  JUDGE_MODEL_POOL: [LUNA, ARGON, FLASH].join(","),
  JUDGE_EXCLUDE: MISTRAL,
  PANEL_2_MODELS: [LUNA, ARGON].join(","),
  PANEL_3_MODELS: [LUNA, FLASH].join(","),
  REVIEW_3_MODELS: [OPUS, LUNA, FLASH].join(","),
};
const RULES = "Pick the cheaper plan; if equal, the faster one.";
/** A stand-in third company for tests that need judge-3 open. The shipped judge-3 waits for a third company that passes
 * a judge trial (Mistral is excluded since Oct 31), so it's closed with the shipped settings. */
const THIRD = { JUDGE_MODEL_POOL: [LUNA, ARGON, FLASH, KIMI].join(","), PANEL_3_MODELS: [LUNA, FLASH, KIMI].join(",") };

const mem = () => {
  const d = new Map<string, unknown>();
  return { storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); }, async delete(k: any) { for (const x of [k].flat()) d.delete(x); return true; }, async list(o: { prefix?: string } = {}) { return new Map([...d.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort().map((k) => [k, structuredClone(d.get(k))])); }, async deleteAll() { d.clear(); }, async setAlarm() {} } };
};
function ns<T extends { fetch(r: Request): Promise<Response> }>(make: () => T) {
  const objs = new Map<string, T>();
  return { objs, idFromName: (x: string) => x, get: (id: string) => ({ fetch: async (u: string, i?: RequestInit) => { if (!objs.has(id)) objs.set(id, make()); return objs.get(id)!.fetch(new Request(u, i)); } }) };
}

/** A match room world, switch off unless `extra` turns it on. */
function world(extra: Record<string, unknown> = {}) {
  _clearSnapshots();
  const env: any = { ...keys, ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o", ...SHIPPED, HEALTH: ns(() => new Health(mem() as any)), ...extra };
  const rooms = new Map<string, MatchRoom>();
  const roomFor = (id: string) => (rooms.has(id) || rooms.set(id, new MatchRoom(mem() as any, env)), rooms.get(id)!);
  const call = async (id: string, action: string, body?: unknown) => {
    const room = roomFor(id);
    room.m = undefined;
    const res = await room.fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as any };
  };
  return { env, call, roomFor };
}

/** Fake Anthropic and OpenRouter: every judge names `winner` (null: a mistrial). Records the models called. */
function fakeAi(winner: string | null = "alpha") {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const b = JSON.parse(init.body);
    calls.push(b.model);
    const text = JSON.stringify(winner === null
      ? { winner: "MISTRIAL", confidence: "high", rule_applied: "r", mistrial_code: "missing_information", mistrial_reason: "Neither side gave a price.", reasoning: "Because." }
      : { winner, confidence: "high", rule_applied: "r", reasoning: "Because." });
    return String(url).includes("openrouter")
      ? new Response(JSON.stringify({ model: b.model, choices: [{ message: { content: text }, finish_reason: "stop" }] }))
      : new Response(JSON.stringify({ model: b.model, content: [{ type: "text", text }], stop_reason: "end_turn" }));
  }) as any;
  return { calls, restore: () => (globalThis.fetch = real) };
}

const create = (w: ReturnType<typeof world>, input: Record<string, unknown>) => {
  const id = randomToken(12);
  return w.call(id, "create", { id, input: { seats: ["alpha", "beta"], rules: RULES, ...input } }).then((r) => ({ id, ...r }));
};
const committed = (body: any): string[] => (body.match?.judge ?? body.judge)?.panel?.map((p: any) => p.model) ?? [(body.match?.judge ?? body.judge)?.model];

async function playToVerdict(w: ReturnType<typeof world>, tier: string, input: Record<string, unknown> = {}) {
  const c = await create(w, { tier, ...input });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const t: Record<string, string> = {};
  for (const s of ["alpha", "beta"]) t[s] = (await w.call(c.id, "join", { seat: s, tier, role: "party", paid: true, payer: `0x${s[0].repeat(40)}`, payment_hash: `h-${s}` })).body.seat_token;
  await w.call(c.id, "submit", { seat: "alpha", seat_token: t.alpha, position: "Plan A: $40." });
  const done = await w.call(c.id, "submit", { seat: "beta", seat_token: t.beta, position: "Plan B: $35." });
  return { id: c.id, t, created: c.body, done: done.body };
}

// ---------- 1. With the switch off ----------

test("1. off: no judge tier ever commits an Anthropic model, by default or by rotate", async () => {
  const w = world(THIRD);
  for (const tier of ["judge", "judge-2", "judge-3"]) {
    const c = await create(w, { tier });
    assert.equal(c.status, 201, `${tier}: ${JSON.stringify(c.body)}`);
    assert.ok(committed(c.body).every((m) => companyOf(m) !== "anthropic"), `${tier} default: ${committed(c.body)}`);
  }
  for (let i = 0; i < 60; i++) {
    for (const tier of ["judge-2", "judge-3"]) {
      const c = await create(w, { tier, panel: "rotate" });
      assert.equal(c.status, 201, JSON.stringify(c.body));
      assert.ok(committed(c.body).every((m) => companyOf(m) !== "anthropic"), `${tier} rotate: ${committed(c.body)}`);
    }
  }
  assert.ok(judgePool(w.env).every((m) => companyOf(m) !== "anthropic"));
  assert.ok(judgeAllowed(w.env).every((m) => companyOf(m) !== "anthropic"));
});

test("1. off: naming a Claude model gets 400 before payment, plain and anthropic/ ids, in every panel form", async () => {
  const w = world();
  const forms: Record<string, unknown>[] = [
    { tier: "judge-3", panel: [LUNA, FLASH, SONNET] },
    { tier: "judge-3", panel: [LUNA, FLASH, "anthropic/claude-sonnet-5-5"] },
    { tier: "judge-2", panel: [LUNA, OPUS] },
    { tier: "judge-3", panel: [[LUNA, FLASH, HAIKU], [LUNA, ARGON, MISTRAL]] },
    { tier: "judge-3", panel: { picks: { alpha: OPUS, beta: LUNA } } },
  ];
  for (const f of forms) {
    const c = await create(w, f);
    assert.equal(c.status, 400, JSON.stringify(f));
    assert.equal(c.body.error, CLAUDE_JUDGES_OFF);
  }
});

test("1. off: only the exact value \"true\" turns Claude judges on", () => {
  for (const v of [undefined, "", "false", "TRUE", "True", " true", "true ", "1", "yes", "on"]) assert.equal(claudeJudgesOn({ CLAUDE_JUDGES_ENABLED: v }), false, String(v));
  assert.equal(claudeJudgesOn({ CLAUDE_JUDGES_ENABLED: "true" }), true);
});

// ---------- 2. Closed tiers ----------

test("2. a Claude model in a tier's settings closes that tier with 503, and nothing is called", async () => {
  const ai = fakeAi();
  try {
    for (const [tier, setting] of [["judge", { JUDGE_MODEL: HAIKU }], ["judge-2", { PANEL_2_MODELS: [LUNA, SONNET].join(",") }], ["judge-3", { PANEL_3_MODELS: [LUNA, FLASH, OPUS].join(",") }]] as const) {
      const w = world(setting);
      const c = await create(w, { tier });
      assert.equal(c.status, 503, `${tier}: ${JSON.stringify(c.body)}`);
      assert.match(c.body.error, /closed for now/);
    }
    assert.equal(ai.calls.length, 0);
  } finally {
    ai.restore();
  }
});

test("2. judge-2's default with one company, and judge-3's with two, are closed (503); judge-3 never repeats a company", async () => {
  assert.equal((await create(world({ PANEL_2_MODELS: [ARGON, FLASH].join(",") }), { tier: "judge-2" })).status, 503);
  const two = await create(world({ PANEL_3_MODELS: [LUNA, FLASH, ARGON].join(",") }), { tier: "judge-3" });
  assert.equal(two.status, 503);
  assert.match(two.body.error, /third AI company/);
  assert.match(String(judgeTierClosed({ ...SHIPPED }, "judge-3")), /third AI company/, "the shipped judge-3 waits for a third company (Oct 31)");
  assert.equal(judgeTierClosed({ ...SHIPPED, ...THIRD }, "judge-3"), null, "with a third company it's open");
  const models = defaultJudgeModels({ ...SHIPPED, ...THIRD }, "judge-3");
  assert.equal(new Set(models.map(companyOf)).size, 3);
});

test("2. judge-3 rotate without three companies is 503, not 400; picks with no company left are 503; agent mistakes stay 400", async () => {
  const w = world({ JUDGE_MODEL_POOL: [LUNA, ARGON, FLASH].join(",") });
  const rot = await create(w, { tier: "judge-3", panel: "rotate" });
  assert.equal(rot.status, 503, JSON.stringify(rot.body));
  assert.match(rot.body.error, /closed for now/);
  // Both parties pick from OpenAI and Google; the drawn third judge needs a third company and there's none.
  const picks = await create(w, { tier: "judge-3", panel: { picks: { alpha: LUNA, beta: ARGON } } });
  assert.equal(picks.status, 503, JSON.stringify(picks.body));
  assert.throws(() => choosePanel("rotate", 3, [LUNA, ARGON, FLASH], undefined, [LUNA, ARGON, FLASH]), PanelShortError);
  // The agent's own mistakes: an unknown model, two judges from one company.
  assert.equal((await create(w, { tier: "judge-3", panel: [LUNA, FLASH, "acme/unknown-1"] })).status, 400);
  assert.equal((await create(w, { tier: "judge-3", panel: [LUNA, FLASH, ARGON] })).status, 400);
});

// ---------- 3. judge-2 rotate ----------

test("3. judge-2 rotate seats one OpenAI and one Google model", async () => {
  const w = world({ JUDGE_MODEL_POOL: [LUNA, ARGON, FLASH].join(",") });
  for (let i = 0; i < 40; i++) {
    const c = await create(w, { tier: "judge-2", panel: "rotate" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.deepEqual(committed(c.body).map(companyOf).sort(), ["google", "openai"]);
  }
});

// ---------- 5. The multi-part judge tiers ----------

test("5. the multi-part judge tiers close (503) without three companies in the judge pool", async () => {
  const w = world({ MULTI_JUDGE_ENABLED: "true" });
  for (const tier of ["judge-3x2", "judge-3x3"]) {
    const c = await create(w, { tier });
    assert.equal(c.status, 503, `${tier}: ${JSON.stringify(c.body)}`);
  }
  assert.ok(multiModels(w.env, "judge").eligible.every((m: string) => companyOf(m) !== "anthropic"));
});

// ---------- 6. Reviews are unchanged ----------

test("6. reviews are unchanged by the switch: review-3's default, rotate drawing Claude, multi-part reviews with Sonnet", () => {
  const off = { ...SHIPPED };
  const on = { ...SHIPPED, CLAUDE_JUDGES_ENABLED: "true" };
  assert.deepEqual(reviewModels(off as any, "review-3"), reviewModels(on as any, "review-3"));
  assert.deepEqual(reviewModels(off as any, "review-3"), [OPUS, LUNA, FLASH], "review-3's default is today's");
  assert.ok(multiModels(off as any).eligible.includes(SONNET), "multi-part reviews still draw Sonnet");
  assert.deepEqual(multiModels(off as any).eligible, multiModels(on as any).eligible);
});

// ---------- 7. The advisory ----------

test("7. the advisory and the human-review marker are in every judge-tier view and receipt: a winner, a mistrial, a forfeit", async () => {
  const ai = fakeAi();
  try {
    const w = world(THIRD);
    const win = await playToVerdict(w, "judge-3");
    const m = win.done.match;
    assert.equal(m.phase, "done", JSON.stringify(m));
    assert.equal(m.advisory, JUDGE_ADVISORY);
    assert.equal(m.human_review, "required");
    assert.equal(m.receipt.payload.advisory, JUDGE_ADVISORY);
    assert.equal(m.receipt.payload.human_review, "required");
    assert.equal(await verifyReceipt(m.receipt, keys.PUBLIC_KEY), true);
    assert.ok(ai.calls.every((x) => companyOf(x) !== "anthropic"), `no Claude called: ${ai.calls}`);
    // A mistrial.
    ai.restore();
    const mis = fakeAi(null);
    const mt = await playToVerdict(w, "judge");
    assert.equal(mt.done.match.result?.winner ?? null, null, JSON.stringify(mt.done).slice(0, 600));
    assert.equal(mt.done.match.receipt.payload.advisory, JUDGE_ADVISORY);
    assert.equal(await verifyReceipt(mt.done.match.receipt, keys.PUBLIC_KEY), true);
    mis.restore();
    // A forfeit: beta never submits.
    const c = await create(w, { tier: "judge-2" });
    const t: Record<string, string> = {};
    for (const s of ["alpha", "beta"]) t[s] = (await w.call(c.id, "join", { seat: s, tier: "judge-2", role: "party", paid: true })).body.seat_token;
    await w.call(c.id, "submit", { seat: "alpha", seat_token: t.alpha, position: "Plan A." });
    w.roomFor(c.id).now = () => Date.now() + 11 * 60_000;
    const st = await w.call(c.id, "status");
    assert.equal(st.body.result?.by_forfeit ?? st.body.result?.forfeited?.length > 0, true, JSON.stringify(st.body));
    assert.equal(st.body.receipt.payload.advisory, JUDGE_ADVISORY);
    assert.equal(st.body.receipt.payload.human_review, "required");
    // Not in a luck-tier receipt.
    const r = await create(w, { tier: "rps", rules: undefined });
    assert.equal(r.status, 201);
    assert.equal(r.body.advisory ?? r.body.match?.advisory, undefined);
  } finally {
    ai.restore();
  }
});

test("7. a multi-part judge receipt carries the advisory (judge-3x2, with the switch on, since the tier is closed while off)", async () => {
  const ai = fakeAi();
  try {
    const w = world({ CLAUDE_JUDGES_ENABLED: "true", MULTI_JUDGE_ENABLED: "true", JUDGE_MODEL_POOL: undefined });
    const c = await create(w, { tier: "judge-3x2" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const t: Record<string, string> = {};
    for (const s of ["alpha", "beta"]) t[s] = (await w.call(c.id, "join", { seat: s, tier: "judge-3x2", role: "party", paid: true, payer: `0x${s[0].repeat(40)}`, payment_hash: `h-${s}` })).body.seat_token;
    await w.call(c.id, "submit", { seat: "alpha", seat_token: t.alpha, pieces: [{ text: "A1" }, { text: "A2" }] });
    const done = await w.call(c.id, "submit", { seat: "beta", seat_token: t.beta, pieces: [{ text: "B1" }, { text: "B2" }] });
    assert.equal(done.body.match.receipt.payload.advisory, JUDGE_ADVISORY, JSON.stringify(done.body.match).slice(0, 300));
    assert.equal(done.body.match.receipt.payload.human_review, "required");
    assert.equal(await verifyReceipt(done.body.match.receipt, keys.PUBLIC_KEY), true);
  } finally {
    ai.restore();
  }
});

// ---------- 11. A match from before the build ----------

test("11. a match committed to a Claude judge before the change: no call at judging or retry-judge, unjudged, refund list", async () => {
  const ai = fakeAi();
  try {
    // Created under the old settings: Claude judges on, and the judge pool still MODEL_POOL's (with Claude).
    const on = world({ CLAUDE_JUDGES_ENABLED: "true", JUDGE_MODEL_POOL: undefined });
    const c = await create(on, { tier: "judge-2", panel: [LUNA, SONNET] });
    assert.equal(c.status, 201);
    // The same stored match, now under the shipped settings (switch off).
    const off = world();
    const room = on.roomFor(c.id);
    (room as any).env = off.env;
    const t: Record<string, string> = {};
    for (const s of ["alpha", "beta"]) t[s] = (await on.call(c.id, "join", { seat: s, tier: "judge-2", role: "party", paid: true, payer: `0x${s[0].repeat(40)}`, payment_hash: `h-${s}` })).body.seat_token;
    await on.call(c.id, "submit", { seat: "alpha", seat_token: t.alpha, position: "Plan A." });
    const done = await on.call(c.id, "submit", { seat: "beta", seat_token: t.beta, position: "Plan B." });
    assert.equal(done.body.match.error_code, "unjudged", JSON.stringify(done.body.match));
    assert.match(done.body.match.error, /Claude judges are off for now/);
    const again = await on.call(c.id, "retry-judge", { seat: "alpha", seat_token: t.alpha });
    assert.equal(again.status, 409);
    assert.equal(ai.calls.length, 0, "no judge was called");
    const list: any = await (await off.env.HEALTH.get("global").fetch("https://health/unjudged")).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].match_id, c.id);
    assert.deepEqual(list[0].payers.map((p: any) => p.seat).sort(), ["alpha", "beta"]);
  } finally {
    ai.restore();
  }
});

// ---------- 12. With the switch on ----------

test("12. with the switch on, today's behaviour comes back: Claude defaults and named Claude judges work", async () => {
  const w = world({ CLAUDE_JUDGES_ENABLED: "true", JUDGE_MODEL: undefined, PANEL_2_MODELS: undefined, PANEL_3_MODELS: undefined, JUDGE_MODEL_POOL: undefined });
  assert.equal(committed((await create(w, { tier: "judge" })).body)[0], HAIKU);
  const named = await create(w, { tier: "judge-3", panel: [SONNET, LUNA, ARGON] });
  assert.equal(named.status, 201, JSON.stringify(named.body));
  assert.equal(judgeTierClosed({ CLAUDE_JUDGES_ENABLED: "true", PANEL_3_MODELS: [LUNA, FLASH].join(",") }, "judge-3"), null, "closures only apply while off");
  const commitment = await tierCommitment("judge-3", [SONNET, LUNA, ARGON]);
  assert.equal(commitment.panel!.length, 3);
});

// ---------- the routes (4, 8, 9, 10) ----------

function appEnv(extra: Record<string, unknown> = {}) {
  _clearSnapshots();
  _resetHealthCaches();
  const e: any = { ...keys, PAY_TO: "0x0000000000000000000000000000000000000001", NETWORK: "base-sepolia", PAYMENTS_ENABLED: "false", STAGING: "true", FAKE_AI: "true", FAKE_AI_DELAY_MS: "1-5", ANTHROPIC_API_KEY: "fake", OPENROUTER_API_KEY: "fake", ...SHIPPED, GATES: ns(() => new Gate(mem() as any)), HEALTH: ns(() => new Health(mem() as any)), ...extra };
  e.LEDGER = ns(() => new Ledger(mem() as any, e));
  e.MATCHES = ns(() => new MatchRoom(mem() as any, e));
  return e;
}
const ctx = { waitUntil() {}, passThroughOnException() {} };
const http = async (e: any, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.fetch(new Request(`https://x${path}`, body === undefined ? { headers } : { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers }, body: JSON.stringify(body) }), e, ctx);
  return { status: res.status, body: (await res.json().catch(() => null)) as any, text: "" };
};

routeTest("4. an agent-named judge-3 panel of three non-Anthropic companies, with an opt-in model, works through the routes", async () => {
  const e = appEnv();
  const m = await http(e, "/matches", { tier: "judge-3", seats: ["alpha", "beta"], rules: RULES, panel: [LUNA, FLASH, KIMI] });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const id = m.body.match_id ?? m.body.id;
  const j = await http(e, "/join/judge-3", { match_id: id, seat: "alpha" });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  // Host-pays: the host joins, the guest takes its seat free by invite.
  const h = await http(e, "/matches", { tier: "judge-3", seats: ["alpha", "beta"], rules: RULES, panel: [LUNA, FLASH, KIMI], host_pays: "alpha" });
  assert.equal(h.status, 201, JSON.stringify(h.body));
  const hid = h.body.match_id ?? h.body.id;
  const token = h.body.invite.invite_token;
  const g = await http(e, "/invite/join", { match_id: hid, invite_token: token });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const hj = await http(e, "/host/join/judge-3", { match_id: hid, seat: "alpha" });
  assert.equal(hj.status, 200, JSON.stringify(hj.body));
});

routeTest("8. GET /judge, GET / and the judge join routes' 402 text show the advisory, a judge pool without Anthropic, and judge-3's state", async () => {
  const e = appEnv({ PANEL_3_MODELS: [LUNA, FLASH].join(",") });
  const j = await http(e, "/judge");
  assert.equal(j.status, 200);
  assert.equal(j.body.advisory, JUDGE_ADVISORY);
  assert.equal(j.body.human_review, "required");
  assert.equal(j.body.claude_judges_enabled, false);
  assert.ok(JSON.stringify(j.body).includes("closed"), "judge-3 shows closed with two companies");
  const pool: string[] = j.body.model_pool ?? [];
  assert.ok(pool.length > 0 && pool.every((x) => companyOf(x) !== "anthropic"), JSON.stringify(j.body).slice(0, 400));
  assert.ok(j.body.multi_part, "the multi_part section is there");
  const root = await http(e, "/");
  assert.ok(JSON.stringify(root.body).includes(JUDGE_ADVISORY));
  const paid = appEnv({ PAYMENTS_ENABLED: "true" });
  const c = await http(paid, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: RULES });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const r = await http(paid, "/join/judge", { match_id: c.body.match_id ?? c.body.id, seat: "alpha" });
  assert.equal(r.status, 402);
  assert.ok(JSON.stringify(r.body).includes(JUDGE_ADVISORY), "the 402 description carries the advisory");
});

routeTest("9. /health shows a closed judge-3 as closed, and the service stays ok", async () => {
  const h = await http(appEnv({ PANEL_3_MODELS: [LUNA, FLASH].join(",") }), "/health");
  assert.equal(h.body.status, "ok", JSON.stringify(h.body));
  assert.ok(JSON.stringify(h.body).includes("closed"));
});

routeTest("10. regions with the switch off: Anthropic's list still guards judge seats (YE, UA-65, UA-23), and VE for the single judge", async () => {
  const e = appEnv(THIRD);
  const from = (cc: string, sub?: string) => ({ "cf-ipcountry": cc, ...(sub ? { "x-test-country": sub } : {}) });
  for (const tier of ["judge", "judge-3"]) {
    const m = await http(e, "/matches", { tier, seats: ["alpha", "beta"], rules: RULES }, from("US"));
    assert.equal(m.status, 201, JSON.stringify(m.body));
    const id = m.body.match_id ?? m.body.id;
    for (const [cc, sub] of [["YE"], ["UA", "UA-65"], ["UA", "UA-23"]] as [string, string?][]) {
      const r = await http(e, `/join/${tier}`, { match_id: id, seat: "alpha" }, { ...from(cc, sub), "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 200)}` });
      assert.equal(r.status, 451, `${tier} from ${sub ?? cc}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /judge matches aren't offered there for now/);
    }
  }
  const single = await http(e, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: RULES }, from("US"));
  const ve = await http(e, "/join/judge", { match_id: single.body.match_id ?? single.body.id, seat: "alpha" }, from("VE"));
  assert.equal(ve.status, 451, JSON.stringify(ve.body));
});

routeTest("11. a join to a match committed to a Claude judge is refused before payment (503)", async () => {
  const on = appEnv({ CLAUDE_JUDGES_ENABLED: "true", JUDGE_MODEL_POOL: undefined });
  const m = await http(on, "/matches", { tier: "judge-2", seats: ["alpha", "beta"], rules: RULES, panel: [LUNA, SONNET] });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  on.CLAUDE_JUDGES_ENABLED = "false";
  _clearSnapshots();
  const j = await http(on, "/join/judge-2", { match_id: m.body.match_id ?? m.body.id, seat: "alpha" });
  assert.equal(j.status, 503, JSON.stringify(j.body));
  assert.match(j.body.error, /no longer offered/);
});

routeTest("6. GET /reviewers is byte for byte the same with Claude judges off and on", async () => {
  const get = async (e: any) => (await app.fetch(new Request("https://x/reviewers"), e, ctx)).text();
  const off = await get(appEnv());
  const on = await get(appEnv({ CLAUDE_JUDGES_ENABLED: "true" }));
  assert.ok(off.length > 100);
  assert.equal(off, on);
  assert.ok(off.includes(SONNET), "reviews still offer Claude");
});

routeTest("10. the free invite seat of a judge match is region-checked with the judges' companies too", async () => {
  const e = appEnv(THIRD);
  const h = await http(e, "/matches", { tier: "judge-3", seats: ["alpha", "beta"], rules: RULES, host_pays: "alpha" }, { "cf-ipcountry": "US" });
  assert.equal(h.status, 201, JSON.stringify(h.body));
  const g = await http(e, "/invite/join", { match_id: h.body.match_id, invite_token: h.body.invite.invite_token }, { "cf-ipcountry": "YE", "cf-connecting-ip": "198.51.100.77" });
  assert.equal(g.status, 451, JSON.stringify(g.body));
  assert.match(g.body.error, /judge matches aren't offered there for now/);
});

// ---------- review 1's findings (2.0's 2059) and the rest of §10 ----------

import { readFile } from "node:fs/promises";
import { judgeRegionBlock, whereFrom } from "../src/regions.ts";
import { reviewCommitment, DEFAULT_REVIEW_3_MODELS } from "../src/review.ts";
import { MODEL_OUTPUT_LIMITS } from "../src/multipart.ts";

test("finding 1: the multi-part reviews keep a pool model with no recorded output limit, as on main; only the judges drop it", () => {
  const NEW = "openai/gpt-7-new";
  assert.equal(MODEL_OUTPUT_LIMITS[NEW], undefined);
  const env: any = { MODEL_POOL: [SONNET, NEW, ARGON].join(","), JUDGE_MODEL_POOL: [NEW, ARGON, MISTRAL].join(",") };
  assert.ok(multiModels(env, "review").eligible.includes(NEW), "reviews: as on main");
  assert.ok(!multiModels(env, "judge").eligible.includes(NEW), "judges: no recorded limit, not drawn");
  assert.ok(!multiModels(env, "judge").eligible.includes(MISTRAL), "Mistral's limit isn't recorded for these tiers yet");
});

test("finding 2 (spec v2.2 §5): Anthropic's region list guards judge seats whatever the switch says", () => {
  const where = (country: string, sub?: string) => whereFrom({ cf: { country, regionCode: sub } } as any, () => undefined);
  for (const on of [{}, { CLAUDE_JUDGES_ENABLED: "true" }]) {
    for (const [cc, sub] of [["YE"], ["UA", "65"], ["UA", "23"]] as [string, string?][]) {
      assert.equal(judgeRegionBlock(on, [LUNA, ARGON], where(cc, sub))?.company, "judges", `${JSON.stringify(on)} ${cc}${sub ?? ""}`);
    }
    assert.equal(judgeRegionBlock(on, [FLASH], where("VE"))?.company, "judges", "VE for the single judge");
    assert.equal(judgeRegionBlock(on, [LUNA, ARGON], where("JP")), null);
  }
});

test("finding 8: a Claude-committed match on a server without ANTHROPIC_API_KEY still ends unjudged and lists its payers", async () => {
  const ai = fakeAi();
  try {
    const on = world({ CLAUDE_JUDGES_ENABLED: "true", JUDGE_MODEL_POOL: undefined });
    const c = await create(on, { tier: "judge-2", panel: [LUNA, SONNET] });
    const off = world({ ANTHROPIC_API_KEY: undefined });
    (on.roomFor(c.id) as any).env = off.env;
    const t: Record<string, string> = {};
    for (const s of ["alpha", "beta"]) t[s] = (await on.call(c.id, "join", { seat: s, tier: "judge-2", role: "party", paid: true, payer: `0x${s[0].repeat(40)}`, payment_hash: `h-${s}` })).body.seat_token;
    await on.call(c.id, "submit", { seat: "alpha", seat_token: t.alpha, position: "Plan A." });
    const done = await on.call(c.id, "submit", { seat: "beta", seat_token: t.beta, position: "Plan B." });
    assert.equal(done.body.match.error_code, "unjudged", JSON.stringify(done.body.match));
    assert.equal((on.roomFor(c.id) as any).m.unjudged_reason, "claude_off", "finding 9: a marker, not the error text");
    const list: any = await (await off.env.HEALTH.get("global").fetch("https://health/unjudged")).json();
    assert.equal(list.length, 1);
    assert.equal(ai.calls.length, 0);
  } finally {
    ai.restore();
  }
});

test("§10 item 11: the alarm path, and a panel that had partly voted, end unjudged with no Claude call", async () => {
  // Sonnet fails (529), Luna and Argon answer: judge_failed with two votes kept, and a retry due.
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const b = JSON.parse(init.body);
    calls.push(b.model);
    if (!String(url).includes("openrouter")) return new Response("overloaded", { status: 529 });
    const text = JSON.stringify({ winner: "alpha", confidence: "high", rule_applied: "r", reasoning: "Because." });
    return new Response(JSON.stringify({ model: b.model, choices: [{ message: { content: text }, finish_reason: "stop" }] }));
  }) as any;
  try {
    const on = world({ CLAUDE_JUDGES_ENABLED: "true", JUDGE_MODEL_POOL: undefined });
    const { id } = await playToVerdict(on, "judge-3", { panel: [SONNET, LUNA, ARGON] });
    const room: any = on.roomFor(id);
    room.m = undefined;
    await room.load?.();
    let st = await on.call(id, "status");
    assert.equal(st.body.error_code, "judge_failed", JSON.stringify(st.body).slice(0, 300));
    const before = calls.length;
    // Claude judges go off; the alarm's retry comes due.
    const off = world();
    room.env = off.env;
    room.m = undefined;
    room.now = () => Date.now() + 10 * 60_000;
    await room.alarm();
    st = await on.call(id, "status");
    assert.equal(st.body.error_code, "unjudged", JSON.stringify(st.body).slice(0, 300));
    assert.match(st.body.error, /part of it had already voted/);
    assert.equal(calls.length, before, "the alarm called no judge");
    const list: any = await (await off.env.HEALTH.get("global").fetch("https://health/unjudged")).json();
    assert.equal(list.length, 1);
  } finally {
    globalThis.fetch = real;
  }
});

test("§10 item 3 (v2.2): judge-2 rotate with the shipped judge pool seats two different companies, never Anthropic", async () => {
  const w = world();
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const c = await create(w, { tier: "judge-2", panel: "rotate" });
    assert.equal(c.status, 201);
    const cos = committed(c.body).map(companyOf);
    assert.equal(new Set(cos).size, 2);
    assert.ok(!cos.includes("anthropic"));
    cos.forEach((x) => seen.add(x));
  }
  assert.deepEqual([...seen].sort(), ["google", "openai"], "Mistral is never seated while it's excluded (ccheez34, Oct 31 10:13)");
});

test("§10 item 6: reviews' commitments and prompt hash are main's, and review-3 falls back to DEFAULT_REVIEW_3_MODELS", async () => {
  const PROMPT = "6ddeb4657d84f1a4346b452ce7bb431404dbe1f05bdac62b54372628c9fa031e"; // main 2aa89f2, computed Oct 30
  const env: any = { ...SHIPPED };
  const one = await reviewCommitment("review", env);
  const three = await reviewCommitment("review-3", env);
  assert.deepEqual(one.models, [SONNET]);
  assert.deepEqual(three.models, [OPUS, LUNA, FLASH]);
  assert.equal(one.prompt_sha256, PROMPT);
  assert.equal(three.prompt_sha256, PROMPT);
  // Literals, not the constants (re-read R5): main 2aa89f2 shipped review-3 as PANEL_3_MODELS = Opus, Luna, Flash. Main's
  // unconfigured fallback was three Claude sizes; the fixed list is by design (spec v2.1 §3 rule 5, 2.0-D304).
  assert.deepEqual(DEFAULT_REVIEW_3_MODELS.split(","), [OPUS, LUNA, FLASH]);
  assert.deepEqual((await reviewCommitment("review-3", {} as any)).models, [OPUS, LUNA, FLASH], "an unconfigured server");
  const vars = await shippedVars();
  assert.deepEqual((await reviewCommitment("review-3", vars)).models, [OPUS, LUNA, FLASH], "wrangler.jsonc's own setting");
  for (const [k, v] of Object.entries(SHIPPED)) assert.equal(vars[k], v, `this file's SHIPPED.${k} matches wrangler.jsonc`);
  for (let i = 0; i < 40; i++) {
    const r = await reviewCommitment("review-3", env, "rotate");
    if (r.models.some((m) => companyOf(m) === "anthropic")) return; // review rotate can still draw Claude
  }
  assert.fail("review-3 rotate never drew Claude in 40 tries");
});

test("§10 item 7: a receipt from before the build still verifies, and the regenerated vectors have no Claude judge", async () => {
  const mr = JSON.parse(await readFile(new URL("./fixtures/multi-review-vectors.json", import.meta.url), "utf8"));
  const old = mr.cases.find((c: any) => c.expect.ok);
  assert.equal(await verifyReceipt(old.receipt, mr.public_key), true, "a pre-build (review) receipt");
  assert.equal(old.receipt.payload.advisory, undefined, "a review receipt has no advisory");
  // A real judge receipt signed before the build (re-read R5): it still verifies, and the build added nothing to it.
  const pre = JSON.parse(await readFile(new URL("./fixtures/judge-receipt-prebuild.json", import.meta.url), "utf8"));
  assert.equal(await verifyReceipt(pre.receipt, pre.public_key), true, "a pre-build judge receipt");
  assert.equal(pre.receipt.payload.advisory, undefined);
  assert.equal(pre.receipt.payload.human_review, undefined);
  assert.ok(pre.receipt.payload.outcome.votes.some((v: any) => companyOf(v.model) === "anthropic"), "it is from before: a Claude judge voted");
  const mj = JSON.parse(await readFile(new URL("./fixtures/multi-judge-vectors.json", import.meta.url), "utf8"));
  for (const c of mj.cases) {
    const p = c.receipt.payload;
    assert.equal(p.advisory, JUDGE_ADVISORY, c.id);
    assert.equal(p.human_review, "required", c.id);
    const models = [p.proof?.judge?.model, ...(p.proof?.judge?.panel ?? []).map((x: any) => x.model), ...(p.outcome?.votes ?? []).map((v: any) => v.model)].filter(Boolean);
    assert.ok(models.every((m: string) => companyOf(m) !== "anthropic"), `${c.id}: ${models}`);
  }
});

routeTest("finding 3 (v2.2 rule 7): only judge-3's wait for a company leaves /health ok; any other closure degrades it", async () => {
  const wait = await http(appEnv({ PANEL_3_MODELS: [LUNA, FLASH].join(",") }), "/health");
  assert.equal(wait.body.status, "ok", JSON.stringify(wait.body));
  for (const bad of [{ JUDGE_MODEL: HAIKU }, { PANEL_2_MODELS: [ARGON, FLASH].join(",") }, { PANEL_3_MODELS: [LUNA, FLASH, OPUS].join(",") }]) {
    const h = await http(appEnv(bad), "/health");
    assert.equal(h.body.status, "degraded", JSON.stringify(bad));
    assert.ok(h.body.reasons.includes("judge_closed"), JSON.stringify(h.body.reasons));
  }
});

routeTest("finding 6: a match whose status can't be read is refused before payment (503); a missing match still gets the handler's 404", async () => {
  const e = appEnv();
  e.MATCHES = { idFromName: (x: string) => x, get: () => ({ fetch: async () => { throw new Error("object unavailable"); } }) };
  const r = await http(e, "/join/judge-3", { match_id: "a".repeat(24), seat: "alpha" }, { "cf-ipcountry": "US" });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.match(r.body.error, /Nothing was charged/);
  assert.equal(r.body.busy, true, "temporary: a busy 503 (re-read R2)");
  assert.equal(r.body.retry_after_s, 5);
  // Any answer but OK or 404 is a failed read too (re-read R1), on the paid seat and the free invite seat (R2).
  for (const code of [429, 408, 400]) {
    const f = appEnv();
    f.MATCHES = { idFromName: (x: string) => x, get: () => ({ fetch: async () => new Response("{}", { status: code }) }) };
    const j = await http(f, "/join/judge-3", { match_id: "c".repeat(24), seat: "alpha" }, { "cf-ipcountry": "US" });
    assert.equal(j.status, 503, `${code}: ${JSON.stringify(j.body)}`);
    assert.equal(j.body.busy, true, String(code));
    const g = await http(f, "/invite/join", { match_id: "c".repeat(24), invite_token: "t".repeat(20) }, { "cf-ipcountry": "US" });
    assert.equal(g.status, 503, `invite, ${code}: ${JSON.stringify(g.body)}`);
    assert.equal(g.body.busy, true);
  }
  const missing = await http(appEnv(), "/join/judge-3", { match_id: "b".repeat(24), seat: "alpha" }, { "cf-ipcountry": "US" });
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
});

routeTest("finding 7: the free invite seat of a Claude-committed match is refused too", async () => {
  const e = appEnv({ CLAUDE_JUDGES_ENABLED: "true", JUDGE_MODEL_POOL: undefined });
  const h = await http(e, "/matches", { tier: "judge-2", seats: ["alpha", "beta"], rules: RULES, panel: [LUNA, SONNET], host_pays: "alpha" });
  assert.equal(h.status, 201, JSON.stringify(h.body));
  e.CLAUDE_JUDGES_ENABLED = "false";
  _clearSnapshots();
  const g = await http(e, "/invite/join", { match_id: h.body.match_id, invite_token: h.body.invite.invite_token });
  assert.equal(g.status, 503, JSON.stringify(g.body));
  assert.match(g.body.error, /no longer offered/);
});

routeTest("finding 11 and 13: GET /judge keeps its prompt fields when the single judge is closed, and has its own opt-in note", async () => {
  const j = await http(appEnv({ JUDGE_MODEL: HAIKU }), "/judge");
  assert.match(j.body.closed, /closed for now/);
  assert.match(j.body.prompt_sha256, /^[0-9a-f]{64}$/);
  assert.ok(j.body.format_version);
  assert.equal(j.body.model, HAIKU, "model stays a string, the configured id (re-read R4)");
  const r = await http(appEnv(), "/reviewers");
  assert.notEqual(j.body.opt_in_note, r.body.opt_in_note, "the reviewers' note stays as it was; the judges' differs");
  assert.ok(!j.body.opt_in_models.includes(MISTRAL), "Mistral is in the judges' own pool, not an opt-in there");
});

routeTest("§10 item 8: every judge join route's 402 carries the advisory, /host/join too; GET / says when judge-3 is closed", async () => {
  const paid = appEnv({ PAYMENTS_ENABLED: "true", ...THIRD });
  for (const tier of ["judge", "judge-2", "judge-3"]) {
    const c = await http(paid, "/matches", { tier, seats: ["alpha", "beta"], rules: RULES });
    assert.equal(c.status, 201, `${tier}: ${JSON.stringify(c.body)}`);
    for (const route of [`/join/${tier}`, `/host/join/${tier}`]) {
      const r = await http(paid, route, { match_id: c.body.match_id, seat: "alpha" });
      assert.equal(r.status, 402, `${route}: ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.ok(JSON.stringify(r.body).includes(JUDGE_ADVISORY), `${route}: the advisory`);
    }
  }
  // The multi-part judge tiers' 402 (re-read R5): closed while Claude judges are off, so with the switch on.
  const multi = appEnv({ PAYMENTS_ENABLED: "true", MULTI_JUDGE_ENABLED: "true", CLAUDE_JUDGES_ENABLED: "true", JUDGE_MODEL_POOL: undefined });
  const m3 = await http(multi, "/matches", { tier: "judge-3x2", seats: ["alpha", "beta"], rules: RULES });
  assert.equal(m3.status, 201, JSON.stringify(m3.body).slice(0, 300));
  const r3 = await http(multi, "/join/judge-3x2", { match_id: m3.body.match_id, seat: "alpha" });
  assert.equal(r3.status, 402, JSON.stringify(r3.body).slice(0, 300));
  assert.ok(JSON.stringify(r3.body).includes(JUDGE_ADVISORY), "judge-3x2's 402: the advisory");
});

routeTest("re-read R3: llms.txt gives judge-3's closed reason once", async () => {
  const txt = async (e: any) => (await app.fetch(new Request("https://x/llms.txt"), e, ctx)).text();
  const line = (t: string) => t.split("\n").find((l) => l.startsWith("- judge-3 ")) ?? "";
  const wait = line(await txt(appEnv({ PANEL_3_MODELS: [LUNA, FLASH].join(",") })));
  assert.match(wait, /judge-3 is closed for now: judge-3 needs a third AI company; agents can name one themselves \(GET \/judge\)\.$/, wait);
  assert.doesNotMatch(wait, /name three/);
  const off = line(await txt(appEnv({ PANEL_3_MODELS: [LUNA, FLASH, OPUS].join(",") })));
  assert.match(off, /Claude judges are off for now\. Agents can still name three companies themselves \(GET \/judge\)\.$/, off);
  assert.equal(line(await txt(appEnv())), wait, "the shipped settings: judge-3 waits for a third company, said once");
  assert.doesNotMatch(line(await txt(appEnv(THIRD))), /closed/, "open with a third company");
});

routeTest("re-read R5: GET /reviewers is byte for byte main 2aa89f2's, each with its own wrangler.jsonc settings", async () => {
  const snap = await readFile(new URL("./fixtures/reviewers-main-2aa89f2.json", import.meta.url), "utf8");
  const res = await app.fetch(new Request("https://x/reviewers"), { ...(await shippedVars()) }, ctx);
  // A deliberate change to reviews or their settings must regenerate the snapshot (and say why).
  assert.equal(await res.text(), snap);
});

test("re-read R5: a luck-tier receipt has no advisory and no human-review marker", async () => {
  const w = world();
  const c = await create(w, { tier: "rps", rules: undefined });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const t: Record<string, string> = {};
  for (const s of ["alpha", "beta"]) t[s] = (await w.call(c.id, "join", { seat: s, tier: "rps", role: "party", paid: true })).body.seat_token;
  const values: Record<string, string> = { alpha: "paper", beta: "rock" };
  const nonces: Record<string, string> = {};
  for (const s of ["alpha", "beta"]) {
    nonces[s] = randomToken(16);
    assert.equal((await w.call(c.id, "commit", { seat: s, seat_token: t[s], commitment: await commitmentOf(values[s], nonces[s]) })).status, 200);
  }
  let last: any;
  for (const s of ["alpha", "beta"]) last = await w.call(c.id, "reveal", { seat: s, seat_token: t[s], value: values[s], nonce: nonces[s] });
  const m = last.body.match;
  assert.equal(m.phase, "done", JSON.stringify(m).slice(0, 300));
  assert.equal(m.result.winner, "alpha");
  assert.equal(await verifyReceipt(m.receipt, keys.PUBLIC_KEY), true);
  assert.equal(m.receipt.payload.advisory, undefined);
  assert.equal(m.receipt.payload.human_review, undefined);
  assert.equal(m.advisory, undefined);
});

/** wrangler.jsonc's top-level vars: comments outside strings and trailing commas removed. */
async function shippedVars(): Promise<Record<string, string>> {
  const t = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  let out = "", inStr = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i], nx = t[i + 1];
    if (inStr) { out += ch; if (ch === "\\") out += t[++i]; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === "/" && nx === "/") { while (i < t.length && t[i] !== "\n") i++; out += "\n"; continue; }
    if (ch === "/" && nx === "*") { i = t.indexOf("*/", i + 2) + 1; continue; }
    out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")).vars;
}

routeTest("§10 item 10: /host/join and judge-2 seats are region-checked too, and VE's 451 for the single judge has the judges' text", async () => {
  const e = appEnv();
  const m = await http(e, "/matches", { tier: "judge-2", seats: ["alpha", "beta"], rules: RULES }, { "cf-ipcountry": "US" });
  for (const route of ["/join/judge-2", "/host/join/judge-2"]) {
    const r = await http(e, route, { match_id: m.body.match_id, seat: "alpha" }, { "cf-ipcountry": "YE", "cf-connecting-ip": "198.51.100.91" });
    assert.equal(r.status, 451, `${route}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /judge matches aren't offered there for now/);
  }
  const single = await http(e, "/matches", { tier: "judge", seats: ["alpha", "beta"], rules: RULES }, { "cf-ipcountry": "US" });
  const ve = await http(e, "/join/judge", { match_id: single.body.match_id, seat: "alpha" }, { "cf-ipcountry": "VE", "cf-connecting-ip": "198.51.100.92" });
  assert.equal(ve.status, 451);
  assert.match(ve.body.error, /judge matches aren't offered there for now/);
});

// ---------- judge trials: JUDGE_EXCLUDE (ccheez34, Oct 31 10:13: Mistral out; research\checks\judge-tier-build-2026-10-30\MISTRAL-LIVE-CHECK.md) ----------

test("judge trials: an excluded model is never drawn and naming it is refused before payment (400), in every panel form", async () => {
  const w = world();
  assert.ok(!judgePool(w.env).includes(MISTRAL));
  assert.ok(!judgeAllowed(w.env).includes(MISTRAL));
  for (const panel of [[LUNA, MISTRAL], [[LUNA, MISTRAL]]] as any[]) {
    const c = await create(w, { tier: "judge-2", panel });
    assert.equal(c.status, 400, JSON.stringify(c.body));
  }
  assert.equal((await create(w, { tier: "judge-3", panel: [LUNA, FLASH, MISTRAL] })).status, 400);
  assert.equal((await create(w, { tier: "judge-3", panel: { picks: { alpha: MISTRAL, beta: LUNA } } })).status, 400);
  // Even if it's put back in the pool by mistake, the exclusion wins.
  const back = world({ JUDGE_MODEL_POOL: [LUNA, ARGON, FLASH, MISTRAL].join(",") });
  for (let i = 0; i < 40; i++) {
    const c = await create(back, { tier: "judge-2", panel: "rotate" });
    assert.ok(!committed(c.body).includes(MISTRAL));
  }
});

test("judge trials: an excluded model in a tier's own default closes it with the trial reason, whatever the Claude switch says", () => {
  for (const on of ["false", "true"]) {
    const env = { ...SHIPPED, CLAUDE_JUDGES_ENABLED: on, PANEL_3_MODELS: [LUNA, FLASH, MISTRAL].join(",") };
    assert.match(String(judgeTierClosed(env, "judge-3")), /hasn't passed its judge trial/, on);
    assert.equal(judgeTierWaitsForCompany(env, "judge-3"), false, "not the wait that leaves /health ok");
  }
  assert.match(String(judgeTierClosed({ ...SHIPPED, JUDGE_MODEL: MISTRAL }, "judge")), /judge trial/);
  assert.equal(judgeTierClosed({ ...SHIPPED, JUDGE_EXCLUDE: undefined, PANEL_3_MODELS: [LUNA, FLASH, MISTRAL].join(",") }, "judge-3"), null, "without the exclusion, as before");
});

test("judge trials: reviews may still name the excluded model (a failed review isn't charged)", () => {
  assert.ok(allowedModels({ ...SHIPPED } as any).includes(MISTRAL));
});

routeTest("judge trials: the shipped settings leave /health ok and GET /judge lists the excluded model; an excluded default degrades /health", async () => {
  const h = await http(appEnv(), "/health");
  assert.equal(h.body.status, "ok", JSON.stringify(h.body));
  const j = await http(appEnv(), "/judge");
  assert.deepEqual(j.body.not_judging_for_now.models, [MISTRAL]);
  assert.ok(!j.body.opt_in_models.includes(MISTRAL));
  assert.ok(!j.body.model_pool.includes(MISTRAL));
  assert.match(j.body.panels["judge-3"].closed, /third AI company/);
  const bad = await http(appEnv({ PANEL_3_MODELS: [LUNA, FLASH, MISTRAL].join(",") }), "/health");
  assert.equal(bad.body.status, "degraded", JSON.stringify(bad.body));
  assert.ok(bad.body.reasons.includes("judge_closed"));
  const none = await http(appEnv({ JUDGE_EXCLUDE: undefined }), "/judge");
  assert.equal(none.body.not_judging_for_now, undefined);
});
