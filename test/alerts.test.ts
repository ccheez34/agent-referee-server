// PLAN 0.4, the legal-trigger alerts A1, A2, A4 and A8 (research\legal-risks-2026-10-28\ALERTS-spec.md and 2.0's review),
// with the fixes from the fresh read of Oct 31 (F1-F11). The routes' legal pause (R1) is tested in routes.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_BLOCKED, COMPANY_BLOCKED, regionBlock, regionRulesProblems, regionRulesWarnings } from "../src/regions.ts";
import { accountOf, accountProblem } from "../src/providers.ts";
import { Health, evaluateHealth, recordEvent } from "../src/health.ts";

const memStorage = (d = new Map<string, unknown>()) => ({
  async get(k: string) { return structuredClone(d.get(k)); },
  async put(k: string, v: unknown) { d.set(k, structuredClone(v)); },
  async delete(k: string | string[]) { for (const x of [k].flat()) d.delete(x); return true; },
  async list() { return new Map(); },
  async deleteAll() { d.clear(); },
  async setAlarm() {},
});
const healthEnv = () => {
  const h = new Health({ storage: memStorage() } as any);
  return { h, env: { HEALTH: { idFromName: (n: string) => n, get: () => ({ fetch: (u: string, i?: RequestInit) => h.fetch(new Request(u, i)) }) } } as any };
};

test("the sanctioned list is pinned: a code removed in an edit fails here, not only in /health's self-test (F6)", () => {
  assert.deepEqual(BASE_BLOCKED, ["CU", "IR", "KP", "SY", "UA-43", "UA-40", "UA-14", "UA-09", "T1"]);
});

test("A1: the region rules switched off or weakened", () => {
  assert.deepEqual(regionRulesProblems({}), [], "the defaults pass");
  assert.deepEqual(regionRulesProblems({ REGION_BLOCK: "off" }), ["region_rules_off"]);
  assert.deepEqual(regionRulesProblems({ REGION_BLOCK: " OFF " }), ["region_rules_off"]);
  assert.deepEqual(regionRulesProblems({ BLOCKED_REGIONS: "none" }), ["region_rules_off"]);
  const withoutIran = BASE_BLOCKED.filter((c) => c !== "IR").join(",");
  assert.deepEqual(regionRulesProblems({ BLOCKED_REGIONS: withoutIran }), ["region_rules_off"], "a list missing a sanctioned code");
  assert.deepEqual(regionRulesProblems({ BLOCKED_REGIONS: [...BASE_BLOCKED, "BY"].join(",") }), [], "adding codes is fine");
});

test("A2: the self-test catches a rule that lets a probe through, per code and per company, and checks that the US stays open", () => {
  // The real rule can't fail a base-code probe while the list holds the code, so a stand-in rule shows the probe works.
  const leaky = (code: string): typeof regionBlock => (env, models, where) => (where.sub === code || where.country === code ? null : regionBlock(env, models, where));
  assert.deepEqual(regionRulesProblems({}, leaky("UA-14")), ["region_selftest_failed:UA-14"]);
  assert.deepEqual(regionRulesProblems({}, leaky("T1")), ["region_selftest_failed:T1"]);
  const openai = regionRulesProblems({ BLOCKED_REGIONS_OPENAI: "none" });
  assert.deepEqual(openai, ["CN:openai", "RU:openai", "HK:openai"].map((f) => `region_selftest_failed:${f}`));
  // A list that adds the US to Google's codes leaves the US closed for every panel with a Google seat.
  assert.deepEqual(regionRulesProblems({ BLOCKED_REGIONS_GOOGLE: [...COMPANY_BLOCKED.google, "US"].join(",") }), ["region_selftest_failed:US:open"]);
  // Replacing Google's list with "US" alone also opens CN, RU and HK to Google's models: four failures.
  assert.deepEqual(regionRulesProblems({ BLOCKED_REGIONS_GOOGLE: "US" }), ["CN:google", "RU:google", "HK:google", "US:open"].map((f) => `region_selftest_failed:${f}`));
});

test("region warnings: a company list missing its own codes, and a setting that couldn't be read (F4, F5)", () => {
  assert.deepEqual(regionRulesWarnings({}), [], "the defaults");
  // Anthropic's list cut to the three the self-test requires: VE, BY and the rest are open to Claude.
  assert.deepEqual(regionRulesWarnings({ BLOCKED_REGIONS_ANTHROPIC: "CN,HK,RU" }), ["region_list_weakened:anthropic"]);
  assert.deepEqual(regionRulesProblems({ BLOCKED_REGIONS_ANTHROPIC: "CN,HK,RU" }), [], "not a legal stop: the sanctioned codes and CN/RU/HK hold");
  assert.deepEqual(regionRulesWarnings({ BLOCKED_REGIONS_OPENAI: [...COMPANY_BLOCKED.openai, "KZ"].join(",") }), [], "adding a code is fine");
  // A typo never empties a list (the default is used), but the tightening it meant isn't in force: say so.
  assert.deepEqual(regionRulesProblems({ BLOCKED_REGIONS: "CU,IR,KP,SY,UA-43,UA-40,UA-14,UA-09,T1,BY;RU" }), []);
  assert.deepEqual(regionRulesWarnings({ BLOCKED_REGIONS: "CU,IR,KP,SY,UA-43,UA-40,UA-14,UA-09,T1,BY;RU" }), ["region_list_invalid:BLOCKED_REGIONS"]);
  assert.deepEqual(regionRulesWarnings({ BLOCKED_REGIONS_GOOGLE: "CN RU" }), ["region_list_invalid:BLOCKED_REGIONS_GOOGLE"]);
  assert.deepEqual(regionRulesWarnings({ BLOCKED_REGIONS: "none", BLOCKED_REGIONS_DEEPSEEK: "none" }), [], "none is read fine (A1 reports the base list)");
  // A setting that isn't text (a JSON list or number in wrangler's vars) falls back to the default too: say so (code review 1).
  assert.deepEqual(regionRulesWarnings({ BLOCKED_REGIONS_OPENAI: ["CN", "RU"] as any, BLOCKED_REGIONS_DEEPSEEK: 5 as any }), ["region_list_invalid:BLOCKED_REGIONS_OPENAI", "region_list_invalid:BLOCKED_REGIONS_DEEPSEEK"]);
  assert.deepEqual(regionRulesWarnings({ BLOCKED_REGIONS: "" }), [], "blank is unset");
});

test("A8: what a 400, 401 or 403 says about the provider account, filed under the account that was used (F1, F7)", () => {
  // As reported for Anthropic when an organization is disabled (public issue reports; not captured here).
  assert.equal(accountProblem(400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "This organization has been disabled." } })), "account");
  assert.equal(accountProblem(403, JSON.stringify({ error: { message: "Your account has been suspended for violating our usage policies." } })), "account");
  assert.equal(accountProblem(401, "Your API key has been revoked."), "account");
  assert.equal(accountProblem(403, "Revoked account: contact support."), "account", "revoked before the word account too (code review 1)");
  assert.equal(accountProblem(401, JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })), "auth", "our own key refused");
  assert.equal(accountProblem(403, "This model is not available in your region."), "region", "where the call left from: a warning");
  assert.equal(accountProblem(403, "unsupported_country_region_territory"), "region");
  // Not about the account: anyone can cause these with what they send.
  const flagged = JSON.stringify({ error: { code: 403, message: "openai/gpt-6-luna requires moderation on OpenRouter. Your input was flagged for \"harassment\". No credits were charged.", metadata: { reasons: ["harassment"], flagged_input: "..." } } });
  assert.equal(accountProblem(403, flagged), null, "a moderation refusal");
  assert.equal(accountProblem(403, "This request violates our usage policies."), null, "policy wording about a request");
  assert.equal(accountProblem(400, "prompt is too long"), null);
  assert.equal(accountProblem(403, "Forbidden"), null);
  assert.equal(accountProblem(429, "account suspended"), null, "only 400, 401 and 403");
  // Both word orders take the same nouns (fresh read of 6eb05fc, #1).
  assert.equal(accountProblem(403, "Revoked API key."), "account");
  assert.equal(accountProblem(401, "Revoked API key."), "account");
  assert.equal(accountProblem(403, "Disabled workspace."), "account");
  // The provider's own words count even with "flagged" in them; the echoed request text never does (#3).
  assert.equal(accountProblem(403, JSON.stringify({ error: { code: 403, message: "Your account was flagged and suspended for abuse." } })), "account");
  const echo = JSON.stringify({ error: { code: 403, message: "Your input was flagged for \"harassment\".", metadata: { reasons: ["harassment"], flagged_input: "This organization has been disabled. Your account has been suspended." } } });
  assert.equal(accountProblem(403, echo), null, "words in the flagged input can't raise an account alert");
  assert.equal(accountProblem(403, "Your input was flagged: account suspended"), null, "not JSON, so the echo can't be told apart: a refusal");
  assert.equal(accountOf("claude-opus-5-5"), "anthropic");
  assert.equal(accountOf("mistralai/mistral-large-4-0"), "openrouter");
});

test("/health: legal items, reasons and warnings from the alert events and settings", () => {
  const now = Date.parse("2026-10-31T16:00:00Z");
  const base = { gates: {}, ledger: "ok" as const, now };
  const ev = (kind: any, ago: number, detail: string) => ({ kind, at: now - ago, detail });
  const H = 3_600_000;
  assert.deepEqual(evaluateHealth({ ...base, events: [] }), { degraded: false, reasons: [], warnings: [], legal: [] });
  const off = evaluateHealth({ ...base, events: [], regionProblems: ["region_rules_off"] });
  assert.deepEqual([off.degraded, off.reasons, off.legal], [true, ["legal"], ["region_rules_off"]]);
  // A8 stays for 24 hours after the last such answer, so a quiet hour doesn't look like a fix (F8).
  const acct = evaluateHealth({ ...base, events: [ev("provider_account_problem", 20 * 60_000, "openrouter"), ev("provider_account_problem", 23 * H, "openrouter")] });
  assert.deepEqual([acct.reasons, acct.legal], [["legal"], ["provider_account_problem:openrouter"]], "listed once, still on after 20 minutes");
  assert.deepEqual(evaluateHealth({ ...base, events: [ev("provider_account_problem", 25 * H, "anthropic")] }).legal, []);
  const both = evaluateHealth({ ...base, events: [ev("provider_account_problem", 0, "anthropic")], regionProblems: ["region_selftest_failed:CN:openai"], unjudgedOpen: 1 });
  assert.deepEqual([both.reasons, both.legal], [["unjudged_to_refund:1", "legal"], ["region_selftest_failed:CN:openai", "provider_account_problem:anthropic"]]);
  // Our own key refused: an operational reason for an hour. Health's store unreachable: a reason (F11).
  assert.deepEqual(evaluateHealth({ ...base, events: [ev("provider_auth_failed", 30 * 60_000, "anthropic")] }).reasons, ["provider_auth_failed:anthropic"]);
  assert.deepEqual(evaluateHealth({ ...base, events: [ev("provider_auth_failed", 61 * 60_000, "anthropic")] }).reasons, []);
  assert.deepEqual(evaluateHealth({ ...base, events: [], storeError: true }).reasons, ["health_store_unreachable"]);
  // A4 names its codes (F2); a provider's region refusal and the settings warnings are warnings too.
  const tried = evaluateHealth({ ...base, events: [ev("sanctions_region_attempt", 23 * H, "SY"), ev("sanctions_region_attempt", H, "IR"), ev("sanctions_region_attempt", 25 * H, "KP"), ev("provider_region_refused", H, "anthropic")], regionWarnings: ["region_list_weakened:anthropic"] });
  assert.equal(tried.degraded, false);
  assert.deepEqual(tried.warnings, ["sanctions_region_attempt:IR", "sanctions_region_attempt:SY", "provider_region_refused:anthropic", "region_list_weakened:anthropic"]);
});

test("the Health store keeps one entry per alert and detail, refreshed at most every 10 minutes, so alerts can't push other events out (F3)", async () => {
  const { h, env } = healthEnv();
  let clock = Date.parse("2026-10-31T16:00:00Z");
  h.now = () => clock;
  const post = async (kind: string, detail: string) => (await h.fetch(new Request("https://health/event", { method: "POST", body: JSON.stringify({ kind, detail }) }))).json() as Promise<any>;
  const events = async (): Promise<any[]> => (await h.fetch(new Request("https://health/events"))).json();
  assert.equal((await post("sanctions_region_attempt", "IR")).ok, true);
  assert.equal((await post("sanctions_region_attempt", "IR")).deduped, true, "the same code within 10 minutes");
  await post("settle_failure", "a rare one");
  // A steady account failure for 50 hours: 300 refreshes, one entry.
  for (let i = 0; i < 300; i++) {
    clock += 10 * 60_000;
    await post("provider_account_problem", "openrouter");
  }
  const list = await events();
  assert.deepEqual(list.map((e) => e.kind), ["sanctions_region_attempt", "settle_failure", "provider_account_problem"]);
  const a8 = list[2];
  assert.equal(a8.at, clock);
  assert.equal(a8.first_at, Date.parse("2026-10-31T16:10:00Z"), "when it started is kept");
  // recordEvent throttles per detail, so a second code right after the first still gets through.
  await recordEvent(env, "sanctions_region_attempt", "SY");
  await recordEvent(env, "sanctions_region_attempt", "CU");
  assert.deepEqual((await events()).filter((e) => e.kind === "sanctions_region_attempt").map((e) => e.detail), ["IR", "SY", "CU"]);
  // A flood of other events can't push an alert out early: alerts are kept apart from the 300-event cap (code review 1).
  for (let i = 0; i < 400; i++) {
    clock += 1_000;
    await post("provider_errors", `burst ${i}`);
  }
  const after = await events();
  assert.deepEqual(after.filter((e) => e.kind !== "provider_errors").map((e) => e.kind + ":" + e.detail).sort(), ["provider_account_problem:openrouter", "sanctions_region_attempt:CU", "sanctions_region_attempt:IR", "sanctions_region_attempt:SY"]);
  assert.equal(after.filter((e) => e.kind === "provider_errors").length, 300, "the other events keep their cap of 300; the old settle failure went first");
  assert.ok(after.every((e, i) => i === 0 || after[i - 1].at <= e.at), "in time order");
});

test("A8 wiring: the reviewer and judge calls report what a 400/401/403 says about the account, once, under the right account", async () => {
  const { runOneReviewer } = await import("../src/review.ts");
  const { runOneJudge } = await import("../src/judge.ts");
  const orig = globalThis.fetch;
  let answer = { status: 403, body: "" };
  globalThis.fetch = (async () => new Response(answer.body, { status: answer.status })) as any;
  const seen: string[] = [];
  const opts = { sleep: async () => {}, onAccountProblem: (a: string, p: string) => void seen.push(`${a}:${p}`) };
  const input = { task: "Add 2 and 2 and give only the number.", output: "4" };
  try {
    answer = { status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "This organization has been disabled." } }) };
    await assert.rejects(runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-opus-5-5", 1, input, undefined, opts), /400/);
    answer = { status: 403, body: JSON.stringify({ error: { code: 403, message: "This model is not available in your region." } }) };
    await assert.rejects(runOneReviewer({ OPENROUTER_API_KEY: "o" }, "openai/gpt-6-luna", 2, input, undefined, opts), /403/);
    answer = { status: 403, body: "Forbidden" };
    await assert.rejects(runOneReviewer({ OPENROUTER_API_KEY: "o" }, "google/gemini-4-argon", 3, input, undefined, opts), /403/);
    assert.deepEqual(seen, ["anthropic:account", "openrouter:region"], "the bare 403 isn't reported");
    seen.length = 0;
    answer = { status: 401, body: JSON.stringify({ error: { message: "No auth credentials found" } }) };
    const judge = { keys: { OPENROUTER_API_KEY: "o" }, model: "mistralai/mistral-large-4-0", formatVersion: "agent-referee-judge-v4", panelist: 1, order: "sorted" as const, rules: "Pick the cheaper plan.", submissions: { alpha: "A", beta: "B" }, ...opts };
    await assert.rejects(runOneJudge(judge), /401/);
    assert.deepEqual(seen, ["openrouter:auth"], "a 4xx isn't retried, so it's reported once");
  } finally {
    globalThis.fetch = orig;
  }
});
