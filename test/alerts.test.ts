// PLAN 0.4, the legal-trigger alerts A1, A2, A4 and A8 (research\legal-risks-2026-10-28\ALERTS-spec.md and 2.0's review):
// detection and reporting on /health only. Whether routes also refuse (R1) and A5-A7 (SDN screening) come later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_BLOCKED, COMPANY_BLOCKED, regionRulesProblems } from "../src/regions.ts";
import { accountOf, isAccountProblem } from "../src/providers.ts";
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

test("A1: the region rules switched off or weakened", () => {
  assert.deepEqual(regionRulesProblems({}), [], "the defaults pass");
  assert.deepEqual(regionRulesProblems({ REGION_BLOCK: "off" }), ["region_rules_off"]);
  assert.deepEqual(regionRulesProblems({ REGION_BLOCK: " OFF " }), ["region_rules_off"]);
  assert.deepEqual(regionRulesProblems({ BLOCKED_REGIONS: "none" }), ["region_rules_off"]);
  const withoutIran = BASE_BLOCKED.filter((c) => c !== "IR").join(",");
  assert.deepEqual(regionRulesProblems({ BLOCKED_REGIONS: withoutIran }), ["region_rules_off"], "a list missing a sanctioned code");
  assert.deepEqual(regionRulesProblems({ BLOCKED_REGIONS: [...BASE_BLOCKED, "BY"].join(",") }), [], "adding codes is fine");
});

test("A2: the self-test probes every BASE_BLOCKED code, the companies' CN/RU/HK, and that the US stays open", () => {
  const off = regionRulesProblems({ BLOCKED_REGIONS_OPENAI: "none" });
  for (const code of ["CN", "RU", "HK"]) assert.ok(off.includes(`region_selftest_failed:${code}:openai`), `${code} with OpenAI's models`);
  assert.ok(!off.some((p) => p.includes(":anthropic") || p.includes(":google")), "the other companies still pass");
  // A list that adds the US to Google's codes leaves the US closed for every panel with a Google seat.
  assert.deepEqual(regionRulesProblems({ BLOCKED_REGIONS_GOOGLE: [...COMPANY_BLOCKED.google, "US"].join(",") }), ["region_selftest_failed:US:open"]);
  // Replacing Google's list with "US" alone also opens CN, RU and HK to Google's models: four failures.
  assert.deepEqual(regionRulesProblems({ BLOCKED_REGIONS_GOOGLE: "US" }), ["CN:google", "RU:google", "HK:google", "US:open"].map((f) => `region_selftest_failed:${f}`));
  // A typo never empties a list (listFrom falls back to the defaults), so the rules still hold and nothing is flagged.
  assert.deepEqual(regionRulesProblems({ BLOCKED_REGIONS: "CU;IR" }), []);
  // Sevastopol (UA-40) is in BASE_BLOCKED but wasn't in the spec's probe list (review R3): it's probed from the list.
  assert.ok(BASE_BLOCKED.includes("UA-40"));
});

test("A8: only account-level 401/403 answers count, and they're filed under the account that was used", () => {
  assert.equal(isAccountProblem(403, JSON.stringify({ error: { message: "Your account has been suspended." } })), true);
  assert.equal(isAccountProblem(403, "unsupported_country_region_territory"), true);
  assert.equal(isAccountProblem(401, "This organization has been disabled."), true);
  assert.equal(isAccountProblem(403, "Forbidden"), false, "a bare 403 isn't an account problem");
  assert.equal(isAccountProblem(401, "invalid x-api-key"), false, "a wrong key isn't a suspension");
  assert.equal(isAccountProblem(400, "account suspended"), false, "only 401 and 403");
  const flagged = JSON.stringify({ error: { code: 403, message: "openai/gpt-6-luna requires moderation on OpenRouter. Your input was flagged for violating the usage policy.", metadata: { reasons: ["harassment"] } } });
  assert.equal(isAccountProblem(403, flagged), false, "a moderation refusal is about the text, and anyone can cause one");
  assert.equal(accountOf("claude-opus-5-5"), "anthropic");
  assert.equal(accountOf("mistralai/mistral-large-4-0"), "openrouter");
});

test("/health: A1/A2 and A8 go in their own legal list (plus the reason \"legal\"); A4 is a 24-hour warning, not a reason", () => {
  const now = Date.parse("2026-10-31T16:00:00Z");
  const base = { gates: {}, ledger: "ok" as const, now };
  assert.deepEqual(evaluateHealth({ ...base, events: [] }), { degraded: false, reasons: [], warnings: [], legal: [] });
  const off = evaluateHealth({ ...base, events: [], regionProblems: ["region_rules_off"] });
  assert.deepEqual([off.degraded, off.reasons, off.legal], [true, ["legal"], ["region_rules_off"]]);
  const acct = evaluateHealth({ ...base, events: [{ kind: "provider_account_problem", at: now - 60_000, detail: "openrouter" }, { kind: "provider_account_problem", at: now - 30_000, detail: "openrouter" }] });
  assert.deepEqual([acct.reasons, acct.legal], [["legal"], ["provider_account_problem:openrouter"]], "listed once");
  const both = evaluateHealth({ ...base, events: [{ kind: "provider_account_problem", at: now, detail: "anthropic" }], regionProblems: ["region_selftest_failed:CN:openai"], unjudgedOpen: 1 });
  assert.deepEqual([both.reasons, both.legal], [["unjudged_to_refund:1", "legal"], ["region_selftest_failed:CN:openai", "provider_account_problem:anthropic"]]);
  assert.equal(evaluateHealth({ ...base, events: [{ kind: "provider_account_problem", at: now - 20 * 60_000, detail: "openrouter" }] }).degraded, false, "after 15 minutes without another one");
  const tried = evaluateHealth({ ...base, events: [{ kind: "sanctions_region_attempt", at: now - 23 * 3_600_000, detail: "IR" }] });
  assert.equal(tried.degraded, false);
  assert.deepEqual(tried.warnings, ["sanctions_region_attempt"]);
  assert.deepEqual(evaluateHealth({ ...base, events: [{ kind: "sanctions_region_attempt", at: now - 25 * 3_600_000, detail: "IR" }] }).warnings, []);
});

test("A4: the Health store keeps one sanctions-region attempt per code per hour", async () => {
  const { h, env } = healthEnv();
  const post = (kind: string, detail: string) => h.fetch(new Request("https://health/event", { method: "POST", body: JSON.stringify({ kind, detail }) }));
  assert.equal((await (await post("sanctions_region_attempt", "IR")).json() as any).ok, true);
  assert.equal((await (await post("sanctions_region_attempt", "IR")).json() as any).deduped, true, "the same code within the hour");
  await post("sanctions_region_attempt", "KP");
  const events: any[] = await (await h.fetch(new Request("https://health/events"))).json();
  assert.deepEqual(events.map((e) => e.detail), ["IR", "KP"]);
  // recordEvent throttles per code, so a second code right after the first still gets through.
  await recordEvent(env, "sanctions_region_attempt", "SY");
  await recordEvent(env, "sanctions_region_attempt", "CU");
  const after: any[] = await (await h.fetch(new Request("https://health/events"))).json();
  assert.deepEqual(after.map((e) => e.detail), ["IR", "KP", "SY", "CU"]);
});

test("A8 wiring: the reviewer and judge calls report an account-level 401/403 once, under the right account", async () => {
  const { runOneReviewer } = await import("../src/review.ts");
  const { runOneJudge } = await import("../src/judge.ts");
  const orig = globalThis.fetch;
  let answer = { status: 403, body: "" };
  globalThis.fetch = (async () => new Response(answer.body, { status: answer.status })) as any;
  const seen: string[] = [];
  const opts = { sleep: async () => {}, onAccountProblem: (a: string) => void seen.push(a) };
  const input = { task: "Add 2 and 2 and give only the number.", output: "4" };
  try {
    answer = { status: 403, body: JSON.stringify({ type: "error", error: { type: "permission_error", message: "Your organization has been disabled." } }) };
    await assert.rejects(runOneReviewer({ ANTHROPIC_API_KEY: "a" }, "claude-opus-5-5", 1, input, undefined, opts), /403/);
    answer = { status: 403, body: JSON.stringify({ error: { code: 403, message: "This model is not available in your region." } }) };
    await assert.rejects(runOneReviewer({ OPENROUTER_API_KEY: "o" }, "openai/gpt-6-luna", 2, input, undefined, opts), /403/);
    answer = { status: 403, body: "Forbidden" };
    await assert.rejects(runOneReviewer({ OPENROUTER_API_KEY: "o" }, "google/gemini-4-argon", 3, input, undefined, opts), /403/);
    assert.deepEqual(seen, ["anthropic", "openrouter"], "the bare 403 isn't reported");
    seen.length = 0;
    answer = { status: 401, body: JSON.stringify({ error: { message: "Your account has been suspended for violating our usage policies." } }) };
    const judge = { keys: { OPENROUTER_API_KEY: "o" }, model: "mistralai/mistral-large-4-0", formatVersion: "agent-referee-judge-v4", panelist: 1, order: "sorted" as const, rules: "Pick the cheaper plan.", submissions: { alpha: "A", beta: "B" }, ...opts };
    await assert.rejects(runOneJudge(judge), /401/);
    assert.deepEqual(seen, ["openrouter"], "a 4xx isn't retried, so it's reported once");
  } finally {
    globalThis.fetch = orig;
  }
});
