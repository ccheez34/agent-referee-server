// New models (src/judge.ts NEW_MODELS; PLAN revision 4 of the panels' new models, with 2.0's five points): a model from
// a company already in the pool, too new for a record here. A request may name it on review and review-3 while its price
// is at or under the dearest model those tiers already take; it's never drawn, never a default, never a judge until a
// judge trial lists it, and not taken on the multi-part tiers. It ships switched off: until NEW_MODELS_ENABLED is "true"
// only a team-allowance call may name one. Bad settings stop the service, with the entry named.
// The price table (src/prices.ts) has dated rows, and the multi-part reviews' two cost measures are checked against the
// prices on each day it knows a change. Route tests need the installed dependencies, as in routes.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchRoom } from "../src/match.ts";
import { Health, _resetHealthCaches } from "../src/health.ts";
import { Gate } from "../src/gate.ts";
import { Ledger } from "../src/ledger.ts";
import { _clearSnapshots } from "../src/gateclient.ts";
import { randomToken } from "../src/logic.ts";
import {
  DEFAULT_MODEL_POOL, DEFAULT_NEW_MODELS, DEFAULT_OPT_IN_MODELS, allowedModels, choosePanel, companyOf, defaultJudgeModels, isNewModel, judgeAllowed, judgePool, judgeTierClosed,
  modelPool, newModelPriceProblem, newModels, newModelsNotOpen, newModelsOpen, newUntrialed, optInModels, trialedJudges,
} from "../src/judge.ts";
import { defaultModelsBySetting, newModelsProblems } from "../src/settings.ts";
import { DEFAULT_REVIEW_3_MODELS, reviewCommitment, reviewModels } from "../src/review.ts";
import {
  DEFAULT_MULTI_PART_EXCLUDE, LIVE_TEST_LONGEST_ANSWERS, MULTI_DEFAULT_PRICES, MULTI_TIERS, multiCommitment, multiExcluded, multiModels, multiReviewCostsUsd, multiReviewInputTokens, panelForcedCaseUsd, panelWorstCaseUsd,
} from "../src/multipart.ts";
import { MODEL_PRICES, hasPriceRows, priceOn, priceTableProblems } from "../src/prices.ts";

let app: any = null;
try {
  app = (await import("../src/index.ts")).default;
} catch (e) {
  console.log(`new-models route tests skipped (dependencies not installed here): ${String((e as any)?.message ?? e).slice(0, 120)}`);
}
const routeTest = app ? test : test.skip;
const ctx = { waitUntil() {}, passThroughOnException() {} };

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };

const OPUS = "claude-opus-5-5", SONNET = "claude-sonnet-5-5", HAIKU = "claude-haiku-5-5";
const LUNA = "openai/gpt-6-luna", ARGON = "google/gemini-4-argon", FLASH = "google/gemini-3.7-flash";
const CARBON = "google/gemini-4-carbon", NEON = "google/gemini-4-neon", HYDROGEN = "google/gemini-4-hydrogen", FLASH38 = "google/gemini-3.8-flash";
const MISTRAL = "mistralai/mistral-large-4-0", KIMI = "moonshotai/kimi-k3";
const NEW = [CARBON, NEON, HYDROGEN, FLASH38];
/** The judge settings wrangler.jsonc ships (as in judge-no-claude.test.ts). */
const SHIPPED = { JUDGE_MODEL: FLASH, JUDGE_MODEL_POOL: [LUNA, ARGON, FLASH].join(","), JUDGE_EXCLUDE: MISTRAL, PANEL_2_MODELS: [LUNA, ARGON].join(","), PANEL_3_MODELS: [LUNA, FLASH].join(","), REVIEW_3_MODELS: [OPUS, LUNA, FLASH].join(",") };

/** New models open to every caller (the switch on), and a team-allowance caller (who may name one while it's off). */
const OPEN = { NEW_MODELS_ENABLED: "true" };
const TEAM_CALL = { team: true };

const at = (iso: string) => Date.parse(iso);
const NOV_24 = at("2026-11-24T12:00:00Z");
const NOV_30_LAST = at("2026-11-30T23:59:59Z");
const DEC_1 = at("2026-12-01T00:00:00Z");
const JAN_1 = at("2027-01-01T00:00:00Z");
/** Runs f with the clock at t (the code under test reads Date.now() where a route gives it no time). */
async function atTime<T>(t: number, f: () => T | Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => t;
  try {
    return await f();
  } finally {
    Date.now = real;
  }
}
/** Adds price rows for a stand-in model while f runs. */
async function withPrice<T>(model: string, rows: typeof MODEL_PRICES[string], f: () => T | Promise<T>): Promise<T> {
  const before = MODEL_PRICES[model];
  MODEL_PRICES[model] = rows;
  try {
    return await f();
  } finally {
    if (before === undefined) delete MODEL_PRICES[model];
    else MODEL_PRICES[model] = before;
  }
}

// ---------- the class ----------

test("new models: the default list is Carbon, Neon, Hydrogen and 3.8 Flash; NEW_MODELS replaces it, and \"\" turns them off", () => {
  assert.deepEqual(newModels({}), NEW);
  assert.equal(DEFAULT_NEW_MODELS, NEW.join(","));
  assert.deepEqual(newModels({ NEW_MODELS: `${NEON}, ${CARBON}` }), [NEON, CARBON]);
  assert.deepEqual(newModels({ NEW_MODELS: "" }), []);
  for (const m of NEW) assert.ok(isNewModel({}, m), m);
  for (const m of [OPUS, LUNA, ARGON, FLASH, MISTRAL]) assert.ok(!isNewModel({}, m), m);
  // No default list holds a new model, and the shipped settings give no problem.
  for (const list of [DEFAULT_MODEL_POOL, DEFAULT_OPT_IN_MODELS, DEFAULT_REVIEW_3_MODELS, DEFAULT_MULTI_PART_EXCLUDE]) for (const m of NEW) assert.ok(!list.split(",").includes(m), `${m} in a default list`);
  assert.deepEqual(newModelsProblems({}), []);
  assert.deepEqual(newModelsProblems(SHIPPED), []);
});

test("new models, once open: a request may name one on review and review-3 (an exact list, an agreed set), and the receipt's selection says so", async () => {
  for (const m of NEW) {
    assert.ok(allowedModels({}).includes(m));
    const one = await reviewCommitment("review", OPEN, [m], undefined, 0, NOV_24);
    assert.deepEqual(one.models, [m]);
    assert.equal(one.panel_selection?.mode, "custom");
    const three = await reviewCommitment("review-3", OPEN, [OPUS, LUNA, m], undefined, 0, NOV_24);
    assert.deepEqual(three.models, [OPUS, LUNA, m]);
  }
  const set = await reviewCommitment("review-3", OPEN, [[SONNET, LUNA, NEON], [OPUS, LUNA, HYDROGEN]], () => 0.99, 0, NOV_24);
  assert.deepEqual(set.models, [OPUS, LUNA, HYDROGEN]);
  assert.equal(set.panel_selection?.mode, "random_set");
  // With new models off altogether (NEW_MODELS ""), naming one is refused as outside the pool, as before this change.
  await assert.rejects(reviewCommitment("review", { ...OPEN, NEW_MODELS: "" }, [NEON], undefined, 0, NOV_24), /Not in the approved model pool: google\/gemini-4-neon/);
});

test("new models ship switched off: until NEW_MODELS_ENABLED is exactly \"true\", only a team-allowance call may name one", async () => {
  assert.equal(newModelsOpen({}), false);
  assert.equal(newModelsOpen(OPEN), true);
  for (const v of ["TRUE", "True", "1", "yes", "on", " true", "false", ""]) assert.equal(newModelsOpen({ NEW_MODELS_ENABLED: v }), false, JSON.stringify(v));
  for (const env of [{}, { NEW_MODELS_ENABLED: "false" }, { NEW_MODELS_ENABLED: "TRUE" }, { NEW_MODELS_ENABLED: "1" }]) {
    // A public (or free) request: refused, with the reason, in every panel form that names one.
    await assert.rejects(reviewCommitment("review", env, [NEON], undefined, 0, NOV_24), /^Error: google\/gemini-4-neon is a new model that isn't open yet: the service is trying it first\. GET \/reviewers lists new_models and says when they open\.$/);
    await assert.rejects(reviewCommitment("review-3", env, [OPUS, LUNA, CARBON], undefined, 0, NOV_24), /google\/gemini-4-carbon is a new model that isn't open yet/);
    await assert.rejects(reviewCommitment("review-3", env, [OPUS, LUNA, HYDROGEN], undefined, 0, NOV_24, {}), /isn't open yet/);
    await assert.rejects(reviewCommitment("review-3", env, [OPUS, LUNA, HYDROGEN], undefined, 0, NOV_24, { team: false }), /isn't open yet/);
    // An agreed set that names one is refused whichever set the draw would take: every named model is checked.
    for (const r of [0, 0.5, 0.99])
      await assert.rejects(reviewCommitment("review-3", env, [[SONNET, LUNA, ARGON], [OPUS, LUNA, HYDROGEN], [OPUS, LUNA, FLASH38]], () => r, 0, NOV_24), /google\/gemini-4-hydrogen, google\/gemini-3\.8-flash are new models that aren't open yet: the service is trying them first/);
    // A team-allowance call (the owner's own sessions): taken, for the trials.
    for (const m of NEW) assert.deepEqual((await reviewCommitment("review-3", env, [OPUS, LUNA, m], undefined, 0, NOV_24, TEAM_CALL)).models, [OPUS, LUNA, m]);
    assert.deepEqual((await reviewCommitment("review", env, [NEON], undefined, 0, NOV_24, TEAM_CALL)).models, [NEON]);
    // Requests that name none are as before, for everyone.
    assert.deepEqual((await reviewCommitment("review-3", env, [OPUS, LUNA, ARGON], undefined, 0, NOV_24)).models, [OPUS, LUNA, ARGON]);
    assert.deepEqual((await reviewCommitment("review-3", env, undefined, undefined, 0, NOV_24)).models, [OPUS, LUNA, FLASH]);
    assert.equal((await reviewCommitment("review-3", env, "rotate", undefined, 0, NOV_24)).models.length, 3);
  }
  assert.equal(newModelsNotOpen([NEON]), "google/gemini-4-neon is a new model that isn't open yet: the service is trying it first. GET /reviewers lists new_models and says when they open.");
});

test("new models: never drawn (the draw's candidates are the pool alone, checked on the candidate list) and never a default", async () => {
  // "rotate" draws from modelPool, and the commitment records the candidates it drew from.
  for (const tier of ["review", "review-3"] as const) {
    const c = await reviewCommitment(tier, {}, "rotate", undefined, 0, NOV_24);
    assert.deepEqual(c.panel_selection?.pool, modelPool({}), `${tier}: the candidates`);
    for (const m of NEW) assert.ok(!c.panel_selection!.pool!.includes(m), `${tier}: ${m} among the candidates`);
  }
  for (const m of NEW) assert.ok(!modelPool({}).includes(m) && !optInModels({}).includes(m));
  // Every value the random source can give draws a pool model (each company's every model reached).
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) {
    const vals = [i / 40, j / 40, (i + j) / 80, (i * 7 % 40) / 40, (j * 3 % 40) / 40, 0.5];
    let k = 0;
    for (const m of choosePanel("rotate", 3, modelPool({}), () => vals[k++ % vals.length], allowedModels({})).models) seen.add(m);
  }
  assert.deepEqual([...seen].sort(), [...modelPool({})].sort(), "every pool model can be drawn, and nothing else");
  // Defaults: the tiers' own models with no settings and with the shipped ones.
  for (const env of [{}, SHIPPED]) {
    for (const m of [...reviewModels("review", env), ...reviewModels("review-3", env)]) assert.ok(!NEW.includes(m), `${m} is a review default`);
  }
  for (const tier of ["judge", "judge-2"] as const) for (const m of defaultJudgeModels({ ...SHIPPED }, tier)) assert.ok(!NEW.includes(m), `${m} is a ${tier} default`);
});

// ---------- 2.0's point 3: the settings checked at start ----------

test("new models: each bad setting is a problem that names its entry", () => {
  const p = (env: Record<string, string>) => newModelsProblems(env).join(" | ");
  // a company with no model in the pool
  assert.match(p({ NEW_MODELS: "mistralai/mistral-next" }), /NEW_MODELS: mistralai\/mistral-next's company \(mistralai\) has no model in MODEL_POOL/);
  assert.match(p({ MODEL_POOL: [OPUS, LUNA].join(",") }), /NEW_MODELS: google\/gemini-4-carbon's company \(google\) has no model in MODEL_POOL/, "the default list, against a pool without Google");
  assert.equal(p({ MODEL_POOL: [OPUS, LUNA].join(","), NEW_MODELS: "" }), "", "and off, it's fine");
  // also in the pool (as set, or the code's default), or in the opt-in list
  assert.match(p({ MODEL_POOL: `${DEFAULT_MODEL_POOL},${NEON}` }), /MODEL_POOL gives google\/gemini-4-neon, a new model \(NEW_MODELS\): a new model is never drawn and never a default/);
  assert.match(p({ NEW_MODELS: ARGON }), /MODEL_POOL gives google\/gemini-4-argon, a new model/, "a model of the default pool listed as new");
  assert.match(p({ OPT_IN_MODELS: `${MISTRAL},${NEON}` }), /NEW_MODELS: google\/gemini-4-neon is also in OPT_IN_MODELS/);
  // no price row
  assert.match(p({ NEW_MODELS: "google/gemini-5-unpriced" }), /NEW_MODELS: google\/gemini-5-unpriced has no row in the price table/);
  // a default of any tier: each setting that picks default models, a list or a single model
  for (const key of ["REVIEW_3_MODELS", "PANEL_MODELS", "PANEL_2_MODELS", "PANEL_3_MODELS", "JUDGE_MODEL_POOL"])
    assert.match(p({ [key]: `${LUNA},${HYDROGEN}` }), new RegExp(`${key} gives google/gemini-4-hydrogen, a new model \\(NEW_MODELS\\)`), key);
  for (const key of ["REVIEW_MODEL", "JUDGE_MODEL"]) assert.match(p({ [key]: HYDROGEN }), new RegExp(`${key} gives google/gemini-4-hydrogen, a new model`), key);
  // ... and the code's own defaults count: a default reviewer or judge listed as new, with a pool that doesn't hold it
  assert.match(p({ MODEL_POOL: [SONNET, LUNA, ARGON].join(","), NEW_MODELS: OPUS }), /REVIEW_3_MODELS gives claude-opus-5-5, a new model/);
  assert.match(p({ MODEL_POOL: [OPUS, LUNA, ARGON].join(","), NEW_MODELS: HAIKU }), /JUDGE_MODEL gives claude-haiku-5-5, a new model/);
  assert.deepEqual(Object.keys(defaultModelsBySetting({})), ["MODEL_POOL", "REVIEW_MODEL", "REVIEW_3_MODELS", "JUDGE_MODEL", "PANEL_MODELS", "PANEL_2_MODELS", "PANEL_3_MODELS", "JUDGE_MODEL_POOL"]);
  // a trialed judge that isn't new
  assert.match(p({ TRIALED_JUDGES: ARGON }), /TRIALED_JUDGES: google\/gemini-4-argon isn't in NEW_MODELS/);
  assert.equal(p({ TRIALED_JUDGES: NEON }), "");
  // several at once: every one is named
  const many = newModelsProblems({ ...SHIPPED, NEW_MODELS: `mistralai/mistral-next,${NEON}`, JUDGE_MODEL: NEON, TRIALED_JUDGES: ARGON });
  assert.deepEqual(many.map((x) => x.split(/[:,]| gives /)[0]), ["NEW_MODELS", "NEW_MODELS", "JUDGE_MODEL", "TRIALED_JUDGES"], many.join(" | "));
});

routeTest("new models: a bad setting stops the service on every route with the entry named, and /health says why", async () => {
  const bad = { ...keys, ...SHIPPED, JUDGE_MODEL_POOL: [LUNA, ARGON, FLASH, NEON].join(",") };
  for (const path of ["/", "/reviewers", "/judge", "/llms.txt", "/review", "/matches"]) {
    const res = await app.fetch(new Request(`https://x${path}`, path === "/review" || path === "/matches" ? { method: "POST", body: "{}" } : {}), bad, ctx);
    assert.equal(res.status, 503, path);
    const body = await res.json();
    assert.match(body.error, /settings have a problem.*Nothing was charged/);
    assert.deepEqual(body.settings_problems, ["JUDGE_MODEL_POOL gives google/gemini-4-neon, a new model (NEW_MODELS): a new model is never drawn and never a default. Change JUDGE_MODEL_POOL, or take google/gemini-4-neon out of NEW_MODELS once its trials are done."]);
  }
  const health = await app.fetch(new Request("https://x/health"), bad, ctx);
  assert.equal(health.status, 503);
  const h = await health.json();
  assert.equal(h.ok, false);
  assert.equal(h.status, "down");
  assert.equal(h.checks.settings, "problem");
  assert.match(h.settings_problems[0], /^JUDGE_MODEL_POOL gives google\/gemini-4-neon/);
  // The control: the same settings without the bad entry serve, and /health shows the check as ok.
  const good = { ...keys, ...SHIPPED };
  assert.equal((await app.fetch(new Request("https://x/reviewers"), good, ctx)).status, 200);
  const ok = await (await app.fetch(new Request("https://x/health"), good, ctx)).json();
  assert.equal(ok.checks.settings, "ok");
  assert.equal(ok.settings_problems, undefined);
});

// ---------- 2.0's point 2: judging off by construction ----------

function mem() {
  const d = new Map<string, unknown>();
  return { storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); }, async delete(k: any) { for (const x of [k].flat()) d.delete(x); }, async setAlarm() {}, async deleteAlarm() {}, async getAlarm() { return null; } } };
}
function ns<T extends { fetch(r: Request): Promise<Response> }>(make: () => T) {
  const objs = new Map<string, T>();
  return { objs, idFromName: (x: string) => x, get: (id: string) => ({ fetch: async (u: string, i?: RequestInit) => { if (!objs.has(id)) objs.set(id, make()); return objs.get(id)!.fetch(new Request(u, i)); } }) };
}
function world(extra: Record<string, unknown> = {}) {
  _clearSnapshots();
  const env: any = { ...keys, ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o", ...SHIPPED, HEALTH: ns(() => new Health(mem() as any)), ...extra };
  const rooms = new Map<string, MatchRoom>();
  const call = async (id: string, action: string, body?: unknown) => {
    const room = rooms.get(id) ?? (rooms.set(id, new MatchRoom(mem() as any, env)), rooms.get(id)!);
    room.m = undefined;
    const res = await room.fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as any };
  };
  return { env, call };
}
const create = (w: ReturnType<typeof world>, input: Record<string, unknown>) => {
  const id = randomToken(12);
  return w.call(id, "create", { id, input: { seats: ["alpha", "beta"], rules: "Pick the cheaper plan; if equal, the faster one.", ...input } }).then((r) => ({ id, ...r }));
};
const committed = (body: any): string[] => (body.match?.judge ?? body.judge)?.panel?.map((p: any) => p.model) ?? [(body.match?.judge ?? body.judge)?.model];

test("new models: none may judge, named or drawn, in any panel form; the judges' lists leave them out", async () => {
  for (const env of [{}, SHIPPED, { CLAUDE_JUDGES_ENABLED: "true" }]) {
    for (const m of NEW) {
      assert.ok(newUntrialed(env, m), m);
      assert.ok(!judgePool(env).includes(m) && !judgeAllowed(env).includes(m), `${m} offered as a judge`);
    }
  }
  const w = world();
  const forms: Record<string, unknown>[] = [
    { tier: "judge-2", panel: [LUNA, NEON] },
    { tier: "judge-2", panel: [[LUNA, ARGON], [LUNA, CARBON]] },
    { tier: "judge-3", panel: [LUNA, HYDROGEN, MISTRAL] },
    { tier: "judge-3", panel: { picks: { alpha: LUNA, beta: FLASH38 } } },
  ];
  for (const input of forms) {
    const c = await create(w, input);
    assert.equal(c.status, 400, JSON.stringify(input));
    assert.match(c.body.error, /Not in the approved model pool: google\/gemini-(4-neon|4-carbon|4-hydrogen|3\.8-flash)/, JSON.stringify(c.body));
  }
  // Drawn: the candidates of a judge draw are the judge pool, which holds no new model (checked on the candidate list).
  for (let i = 0; i < 20; i++) {
    const c = await create(w, { tier: "judge-2", panel: "rotate" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const pool = (c.body.match?.judge ?? c.body.judge).panel_selection.pool;
    assert.deepEqual(pool, [LUNA, ARGON, FLASH]);
    assert.ok(committed(c.body).every((m) => !NEW.includes(m)));
  }
});

test("new models: one judges only once TRIALED_JUDGES lists it, and then only while its price is at or under the judge pool's dearest", async () => {
  assert.deepEqual(trialedJudges({}), []);
  assert.deepEqual(trialedJudges({ TRIALED_JUDGES: `${HYDROGEN}, ${NEON}` }), [HYDROGEN, NEON]);
  const env = { ...SHIPPED, TRIALED_JUDGES: HYDROGEN };
  assert.ok(!newUntrialed(env, HYDROGEN) && newUntrialed(env, NEON));
  assert.ok(judgeAllowed(env).includes(HYDROGEN), "a trialed new model may be named");
  assert.ok(!judgePool(env).includes(HYDROGEN), "and still isn't drawn");
  assert.ok(!judgeAllowed(env).includes(NEON));
  const w = world({ TRIALED_JUDGES: `${HYDROGEN},${NEON}` });
  const ok = await create(w, { tier: "judge-2", panel: [LUNA, HYDROGEN] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(committed(ok.body), [LUNA, HYDROGEN]);
  // Neon ($3 / $15) is above the judge pool's dearest today (Argon, $2 / $10) and at or under it from Dec 1 ($4 / $20).
  const dear = await atTime(NOV_24, () => create(w, { tier: "judge-2", panel: [LUNA, NEON] }));
  assert.equal(dear.status, 400, JSON.stringify(dear.body));
  assert.match(dear.body.error, /google\/gemini-4-neon isn't taken on judge-2 for now: its price \(\$3 \/ \$15 per million tokens \(input \/ output\)\) is above the dearest model this tier already takes \(\$2 \/ \$10\)/);
  const later = await atTime(DEC_1, () => create(w, { tier: "judge-2", panel: [LUNA, NEON] }));
  assert.equal(later.status, 201, JSON.stringify(later.body));
  // Every named model is checked, not only a drawn set: agreed sets with one too-dear judge are refused every time
  // (30 tries: a check of the drawn set alone would let about half of them through).
  for (let i = 0; i < 30; i++) {
    const sets = await atTime(NOV_24, () => create(w, { tier: "judge-2", panel: [[LUNA, ARGON], [LUNA, NEON]] }));
    assert.equal(sets.status, 400, JSON.stringify(sets.body));
    assert.match(sets.body.error, /google\/gemini-4-neon isn't taken on judge-2 for now/);
  }
  // A default that names an untrialed new model can't be reached (the settings check stops the service); the tier's own
  // rule closes it too.
  assert.match(String(judgeTierClosed({ ...SHIPPED, JUDGE_MODEL: NEON }, "judge")), /hasn't passed its judge trial/);
  assert.equal(judgeTierClosed({ ...SHIPPED, JUDGE_MODEL: NEON, TRIALED_JUDGES: NEON }, "judge"), null);
});

// ---------- 2.0's point 1: the money path ----------

test("the price table: well formed, every pool and new model priced today, and each dated change applies from its day", () => {
  assert.deepEqual(priceTableProblems(), []);
  assert.deepEqual(priceTableProblems({ x: [{ from: "2026-13-01", in: 1, out: 1, source: "s" }, { from: "2026-01-01", in: 0, out: 1, source: "" }] }).length, 4);
  for (const m of [...modelPool({}).filter((x) => x !== HAIKU), ...NEW]) {
    assert.ok(hasPriceRows(m), `${m} has no price row`);
    assert.ok(priceOn(m, NOV_24), `${m} has no price today`);
  }
  assert.equal(priceOn("nobody/unknown", NOV_24), null);
  assert.equal(priceOn(CARBON, at("2026-11-09T23:59:59Z")), null, "before a model's first row it has no price");
  for (const m of [ARGON, CARBON]) {
    assert.deepEqual([priceOn(m, at("2026-11-30T23:59:59Z"))!.in, priceOn(m, at("2026-11-30T23:59:59Z"))!.out], [2, 10], m);
    assert.deepEqual([priceOn(m, DEC_1)!.in, priceOn(m, DEC_1)!.out], [4, 20], m);
  }
  for (const m of [FLASH, FLASH38]) {
    assert.deepEqual([priceOn(m, at("2026-12-31T23:59:59Z"))!.in, priceOn(m, at("2026-12-31T23:59:59Z"))!.out], [0.75, 3.75], m);
    assert.deepEqual([priceOn(m, JAN_1)!.in, priceOn(m, JAN_1)!.out], [1.5, 7.5], m);
  }
  assert.deepEqual([priceOn(NEON, DEC_1)!.in, priceOn(NEON, DEC_1)!.out], [3, 15]);
  assert.deepEqual([priceOn(HYDROGEN, DEC_1)!.in, priceOn(HYDROGEN, DEC_1)!.out], [1.5, 7.5]);
  // an announced end with no next price: unpriced from that day
  withPrice("google/stand-in", [{ from: "2026-11-01", until: "2026-12-01", in: 1, out: 5, source: "test" }], () => {
    assert.ok(priceOn("google/stand-in", at("2026-11-30T23:59:59Z")));
    assert.equal(priceOn("google/stand-in", DEC_1), null);
  });
});

test("the money rule on review and review-3: a new model is taken while its price is at or under the dearest pool model, on the day", async () => {
  // Today all four pass; on Dec 1 Carbon costs what Opus does ($4 / $20) and still passes.
  for (const t of [NOV_24, DEC_1, JAN_1]) for (const m of NEW) assert.equal(newModelPriceProblem({}, m, "review-3", t), null, `${m} at ${new Date(t).toISOString()}`);
  // A model that isn't new is never refused here, priced or not.
  for (const m of [OPUS, HAIKU, MISTRAL, "nobody/unknown"]) assert.equal(newModelPriceProblem({}, m, "review", NOV_24), null, m);
  // A stand-in above Opus on output only, on input only, and on both: refused before payment, with the reason.
  const DEAR = "google/stand-in-dear";
  for (const [i, o] of [[4, 25], [5, 20], [5, 25]]) {
    await withPrice(DEAR, [{ from: "2026-11-01", in: i, out: o, source: "test" }], async () => {
      const env = { ...OPEN, NEW_MODELS: DEAR };
      assert.deepEqual(newModelsProblems(env), []);
      assert.match(String(newModelPriceProblem(env, DEAR, "review-3", NOV_24)), new RegExp(`its price \\(\\$${i} / \\$${o} per million tokens \\(input / output\\)\\) is above the dearest model this tier already takes \\(\\$4 / \\$20\\)`));
      await assert.rejects(reviewCommitment("review-3", env, [OPUS, LUNA, DEAR], undefined, 0, NOV_24), /google\/stand-in-dear isn't taken on review-3 for now: its price/);
      await assert.rejects(reviewCommitment("review", env, [DEAR], undefined, 0, NOV_24), /isn't taken on review for now/);
    });
  }
  // On the day: a stand-in at $2 / $10 that doubles to $5 / $25 is taken the day before and refused from its day.
  const RISES = "google/stand-in-rises";
  await withPrice(RISES, [{ from: "2026-11-01", in: 2, out: 10, source: "test" }, { from: "2026-12-01", in: 5, out: 25, source: "test" }], async () => {
    const env = { ...OPEN, NEW_MODELS: RISES };
    assert.deepEqual((await reviewCommitment("review", env, [RISES], undefined, 0, at("2026-11-30T23:59:59Z"))).models, [RISES]);
    await assert.rejects(reviewCommitment("review", env, [RISES], undefined, 0, DEC_1), /isn't taken on review for now: its price \(\$5 \/ \$25/);
    // The money rule binds a team-allowance call too (with the switch off), and every named model, not only a drawn set.
    await assert.rejects(reviewCommitment("review", { NEW_MODELS: RISES }, [RISES], undefined, 0, DEC_1, TEAM_CALL), /isn't taken on review for now: its price/);
    for (const r of [0, 0.99])
      await assert.rejects(reviewCommitment("review-3", env, [[OPUS, LUNA, ARGON], [OPUS, LUNA, RISES]], () => r, 0, DEC_1), /google\/stand-in-rises isn't taken on review-3 for now/);
  });
  // No price that day: refused (an unknown cost is never taken).
  await withPrice(RISES, [{ from: "2026-11-01", until: "2026-12-01", in: 2, out: 10, source: "test" }], async () => {
    assert.match(String(newModelPriceProblem({ NEW_MODELS: RISES }, RISES, "review", DEC_1)), /has no recorded price for today/);
  });
  // The comparison is against the pool as set: with a pool whose dearest is Sonnet ($2 / $10), Neon ($3 / $15) is refused.
  const cheapPool = { MODEL_POOL: [SONNET, LUNA, FLASH].join(",") };
  assert.match(String(newModelPriceProblem(cheapPool, NEON, "review-3", NOV_24)), /above the dearest model this tier already takes \(\$2 \/ \$10\)/);
  assert.equal(newModelPriceProblem(cheapPool, HYDROGEN, "review-3", NOV_24), null);
  // A pool with no priced model at all: nothing to compare with, so refused.
  assert.match(String(newModelPriceProblem({ MODEL_POOL: "google/unpriced-a" }, NEON, "review", NOV_24)), /no model of the pool has a recorded price/);
});

routeTest("new models: the routes list them (GET /reviewers and GET /judge), each list in its own field", async () => {
  const env = { ...keys, ...SHIPPED };
  const r = await (await app.fetch(new Request("https://x/reviewers"), env, ctx)).json();
  assert.deepEqual(r.new_models, NEW);
  assert.equal(r.new_models_open, false, "shipped switched off");
  assert.match(r.new_models_note, /While new_models_open is false they aren't offered yet: the service is trying them first, and a request that names one is refused before payment\./);
  assert.match(r.new_models_note, /never drawn by "rotate" and never a default, don't judge until they pass a judge trial, and aren't taken on the multi-part tiers/);
  assert.equal((await (await app.fetch(new Request("https://x/reviewers"), { ...env, ...OPEN }, ctx)).json()).new_models_open, true);
  for (const m of NEW) assert.ok(!r.model_pool.includes(m) && !r.opt_in_models.includes(m), `${m} in another list`);
  assert.deepEqual(r.opt_in_models, optInModels({}), "opt_in_models keeps its form");
  const j = await (await app.fetch(new Request("https://x/judge"), env, ctx)).json();
  assert.deepEqual(j.new_models, [], "no new model has passed a judge trial");
  assert.match(j.new_models_note, /passed a judge trial: only they may judge/);
  for (const m of NEW) assert.ok(!j.model_pool.includes(m) && !j.opt_in_models.includes(m));
  const trialed = await (await app.fetch(new Request("https://x/judge"), { ...env, TRIALED_JUDGES: HYDROGEN }, ctx)).json();
  assert.deepEqual(trialed.new_models, [HYDROGEN]);
  assert.ok(!trialed.opt_in_models.includes(HYDROGEN) && !trialed.model_pool.includes(HYDROGEN));
  const off = await (await app.fetch(new Request("https://x/reviewers"), { ...env, NEW_MODELS: "" }, ctx)).json();
  assert.deepEqual(off.new_models, []);
});

// ---------- shipped switched off: the routes ----------

/** A whole service for route tests, as in routes.test.ts: fake AI answers, no payments, its own storage. */
function memFull() {
  const d = new Map<string, unknown>();
  return { storage: { async get(k: string) { return structuredClone(d.get(k)); }, async put(k: string, v: unknown) { d.set(k, structuredClone(v)); }, async delete(k: any) { for (const x of [k].flat()) d.delete(x); return true; }, async list(o: { prefix?: string } = {}) { return new Map([...d.keys()].filter((k) => k.startsWith(o.prefix ?? "")).sort().map((k) => [k, structuredClone(d.get(k))])); }, async deleteAll() { d.clear(); }, async setAlarm() {} } };
}
const TEAM_TOKEN = "t".repeat(40);
function service(extra: Record<string, unknown> = {}) {
  _clearSnapshots();
  _resetHealthCaches();
  const e: any = {
    ...keys, ...SHIPPED,
    PAY_TO: "0x0000000000000000000000000000000000000001", NETWORK: "base-sepolia", PAYMENTS_ENABLED: "false", STAGING: "true",
    FAKE_AI: "true", FAKE_AI_DELAY_MS: "1-5", ANTHROPIC_API_KEY: "fake", OPENROUTER_API_KEY: "fake",
    FREE_REVIEW_DAILY_BUDGET_USD: "3.00",
    TEAM_TOKEN, TEAM_MEMBERS: "1.0,2.0,3.0,4.0,5.0", TEAM_MEMBER_DAILY_USD: "5.00", TEAM_DAILY_USD: "8.00",
    GATES: ns(() => new Gate(memFull() as any)),
    HEALTH: ns(() => new Health(memFull() as any)),
    ...extra,
  };
  e.LEDGER = ns(() => new Ledger(memFull() as any, e));
  e.MATCHES = ns(() => new MatchRoom(memFull() as any, e));
  return e;
}
const post = async (e: any, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await app.fetch(new Request(`https://x${path}`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers }, body: JSON.stringify(body) }), e, ctx);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const asTeam = { "x-team-token": TEAM_TOKEN, "x-team-member": "5.0" };
const WORK = { task: "Add 2 and 2 and give only the number.", output: "4" };

routeTest("shipped switched off, on the routes: a public or free request naming a new model is refused before anything runs; a team-allowance call runs it; the switch opens it", async () => {
  const off = service();
  // Public, paid route: refused before payment and before any AI call, with the reason.
  for (const [path, panel] of [["/review", [NEON]], ["/review-3", [OPUS, LUNA, CARBON]], ["/review-3", [[OPUS, LUNA, ARGON], [OPUS, LUNA, HYDROGEN]]]] as const) {
    const r = await post(off, path, { ...WORK, panel });
    assert.equal(r.status, 400, `${path}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /new model that isn't open yet: the service is trying it first\. GET \/reviewers lists new_models and says when they open\. Nothing was charged\.$/);
  }
  // Free route: the same, and the free review isn't used up.
  const free = await post(off, "/free/review", { ...WORK, panel: [NEON] });
  assert.equal(free.status, 400, JSON.stringify(free.body));
  assert.match(free.body.error, /google\/gemini-4-neon is a new model that isn't open yet.* Your free review wasn't used\.$/);
  // The hosted MCP server's route follows the public rule too (it's off here: no INTERNAL_TOKEN), so nothing to name.
  // The same service still serves requests that name none.
  assert.equal((await post(off, "/review", WORK)).status, 200);
  // A team-allowance call: it runs, the new model sits where it was named, and the receipt says so.
  for (const m of NEW) {
    const t = await post(off, "/team/review-3", { ...WORK, panel: [OPUS, LUNA, m] }, asTeam);
    assert.equal(t.status, 200, `${m}: ${JSON.stringify(t.body).slice(0, 300)}`);
    assert.deepEqual(t.body.receipt.payload.reviewers.models, [OPUS, LUNA, m]);
    assert.equal(t.body.receipt.payload.funding, "team");
    assert.equal(t.body.receipt.payload.votes[2].model, m);
  }
  const solo = await post(off, "/team/review", { ...WORK, panel: [HYDROGEN] }, asTeam);
  assert.equal(solo.status, 200, JSON.stringify(solo.body).slice(0, 300));
  assert.deepEqual(solo.body.receipt.payload.reviewers.models, [HYDROGEN]);
  // A team token that doesn't match never opens it (401, as for any team call).
  assert.equal((await post(off, "/team/review", { ...WORK, panel: [NEON] }, { "x-team-token": "x".repeat(40), "x-team-member": "5.0" })).status, 401);
  // The team's multi-part routes refuse a new model like anyone's (not taken on those tiers at all).
  const pieces = [{ text: "piece one" }, { text: "piece two" }];
  const multi = await post(service({ MULTI_PART_ENABLED: "true" }), "/team/review-3x2", { task: WORK.task, pieces, panel: [SONNET, LUNA, NEON] }, asTeam);
  assert.equal(multi.status, 400, JSON.stringify(multi.body).slice(0, 300));
  assert.match(multi.body.error, /Not eligible for multi-part reviews: google\/gemini-4-neon/);
  // Switched on (its own deploy): the public and the free routes take it.
  const on = service(OPEN);
  const open = await post(on, "/review-3", { ...WORK, panel: [OPUS, LUNA, NEON] });
  assert.equal(open.status, 200, JSON.stringify(open.body).slice(0, 300));
  assert.deepEqual(open.body.receipt.payload.reviewers.models, [OPUS, LUNA, NEON]);
  assert.equal((await post(on, "/free/review", { ...WORK, panel: [NEON] })).status, 200);
  // "TRUE" isn't "true": still off.
  assert.equal((await post(service({ NEW_MODELS_ENABLED: "TRUE" }), "/review", { ...WORK, panel: [NEON] })).status, 400);
});

// ---------- the multi-part tiers ----------

test("new models: not taken on the multi-part tiers, by name or by MULTI_PART_OPT_IN, and never among their candidates", async () => {
  for (const who of ["review", "judge"] as const) {
    for (const env of [{}, { MULTI_PART_OPT_IN: NEW.join(",") }, { MULTI_PART_OPT_IN: NEW.join(","), TRIALED_JUDGES: NEW.join(","), CLAUDE_JUDGES_ENABLED: "true" }]) {
      const m = multiModels(env, who);
      for (const x of NEW) assert.ok(!m.eligible.includes(x) && !m.drawable.includes(x), `${who}: ${x} eligible`);
    }
  }
  for (const tier of MULTI_TIERS) {
    await assert.rejects(atTime(NOV_24, () => multiCommitment(tier, {}, [SONNET, LUNA, HYDROGEN])), /Not eligible for multi-part reviews: google\/gemini-4-hydrogen\..*new models aren't taken on these tiers until their live cost test/);
    await assert.rejects(atTime(NOV_24, () => multiCommitment(tier, { MULTI_PART_OPT_IN: NEON }, [[SONNET, LUNA, NEON]])), /Not eligible for multi-part reviews: google\/gemini-4-neon/);
  }
});

test("the multi-part reviews against their prices: the worst case under them through Nov 30; from Dec 1 over them only by Argon's new price, as the owner accepted, with what an agent can force still under", () => {
  const price = (tier: (typeof MULTI_TIERS)[number]) => Number(MULTI_DEFAULT_PRICES[tier].replace("$", ""));
  const WITHOUT_ARGON = { MULTI_PART_EXCLUDE: `${OPUS},${ARGON}` };
  const fmt = (x: number | null) => (x === null ? "unknown" : `$${x.toFixed(3)}`);
  for (const tier of MULTI_TIERS) {
    // Argon is on these tiers on every day: nothing leaves by itself (the owner, Oct 30, 2026: "argon can stay").
    assert.deepEqual(multiExcluded({}), [OPUS]);
    assert.deepEqual(multiModels({}).eligible, [SONNET, LUNA, ARGON, FLASH]);
    // Through Nov 30: the worst case is under the price (option B, Oct 28).
    for (const t of [NOV_24, NOV_30_LAST]) {
      const { worst, forced } = multiReviewCostsUsd(tier, {}, t);
      assert.ok(worst !== null && worst > 0 && worst < price(tier), `${tier} at ${new Date(t).toISOString()}: worst case ${fmt(worst)} is not under $${price(tier)}`);
      assert.ok(forced !== null && forced > 0 && forced < worst);
    }
    // From Dec 1 (Argon at $4 / $20) and from Jan 1 (Flash at $1.50 / $7.50 too):
    for (const t of [DEC_1, at("2026-12-31T23:59:59Z"), JAN_1]) {
      const { worst, forced } = multiReviewCostsUsd(tier, {}, t);
      // ... the worst case is over the price. The owner accepted it ("a price increase is okay until profit gets closer
      // to 0"; "argon can stay ... price increase is okay"). If a later change brings it back under, this line fails:
      // then take the exception out of the code's comment and of this test.
      assert.ok(worst !== null && worst > price(tier), `${tier} at ${new Date(t).toISOString()}: worst case ${fmt(worst)} was expected over $${price(tier)} (the accepted exception)`);
      // ... what an agent can force stays well under it (his rule's measure): under 60% of the price.
      assert.ok(forced !== null && forced < 0.6 * price(tier), `${tier} at ${new Date(t).toISOString()}: what an agent can force, ${fmt(forced)}, is not under 60% of $${price(tier)}`);
      // ... and it's Argon's price alone: with Argon left out (one setting, his to choose), the worst case is under.
      const without = multiReviewCostsUsd(tier, WITHOUT_ARGON, t).worst;
      assert.ok(without !== null && without < price(tier), `${tier} at ${new Date(t).toISOString()}: without Argon the worst case ${fmt(without)} is not under $${price(tier)}`);
    }
  }
  // The numbers themselves. The worst cases are those worst-case-dec1.ts printed on Nov 21 (the same formula, then with
  // its own table), and COST-CHECK.md's of Oct 30; the forced case on Dec 1 is the $0.33 of $0.70 relayed that day.
  const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 0.0006, `${a} isn't ${b}`);
  near(multiReviewCostsUsd("review-3x2", {}, NOV_24).worst, 0.586);
  near(multiReviewCostsUsd("review-3x3", {}, NOV_24).worst, 0.685);
  near(multiReviewCostsUsd("review-3x2", {}, DEC_1).worst, 0.794);
  near(multiReviewCostsUsd("review-3x3", {}, DEC_1).worst, 0.941);
  near(multiReviewCostsUsd("review-3x2", WITHOUT_ARGON, DEC_1).worst, 0.456);
  near(multiReviewCostsUsd("review-3x3", WITHOUT_ARGON, DEC_1).worst, 0.525);
  near(multiReviewCostsUsd("review-3x3", {}, DEC_1).forced, 0.33);
  assert.equal(multiReviewInputTokens("review-3x2"), 31_998);
  assert.equal(multiReviewInputTokens("review-3x3"), 43_998);
  // An unpriced model, or (for the forced case) one with no live-test answer, makes the cost unknown, never small.
  assert.equal(panelWorstCaseUsd([SONNET, "nobody/unknown"], 1000, NOV_24), null);
  assert.equal(panelForcedCaseUsd([SONNET, "nobody/unknown"], 1000, NOV_24), null);
  assert.equal(LIVE_TEST_LONGEST_ANSWERS[HYDROGEN], undefined);
  assert.equal(panelForcedCaseUsd([SONNET, HYDROGEN], 1000, NOV_24), null, "priced, but never run in the live cost test");
  assert.ok(panelWorstCaseUsd([SONNET, HYDROGEN], 1000, NOV_24)! > 0);
  // One seat per company, each company's dearest model: Opus over Sonnet, and Argon over Flash.
  const one = (m: string) => panelWorstCaseUsd([m], 10_000, NOV_24)!;
  assert.equal(panelWorstCaseUsd([OPUS, SONNET, ARGON, FLASH, LUNA], 10_000, NOV_24), one(OPUS) + one(ARGON) + one(LUNA));
  assert.ok(companyOf(OPUS) === companyOf(SONNET) && one(OPUS) > one(SONNET) && one(ARGON) > one(FLASH));
  // The forced case is one try at the longest live answer: for Sonnet, 10,000 in at $2 and 4,216 out at $10.
  near(panelForcedCaseUsd([SONNET], 10_000, NOV_24), (10_000 * 2 + 4_216 * 10) / 1e6);
  near(panelWorstCaseUsd([SONNET], 10_000, NOV_24), (2 * (10_000 * 2 + 12_000 * 10)) / 1e6);
});
