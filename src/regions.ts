// Where requests come from, and which AI companies may serve them.
//
// The reviewer and judge models belong to companies that each limit where their models may be used. Anthropic's
// Supported Regions Policy, for one, restricts use "by persons while physically located in an unsupported region".
// So an AI-calling route refuses a request from a country (or region) that any of the request's models' companies
// don't serve, before payment and before any allowance is used. Cloudflare reports each request's country.
//
// Lists are ISO 3166-1 alpha-2 country codes, or "CC-SUB" ISO 3166-2 subdivisions (UA-43 is Crimea). Each list can
// be replaced with an env var (a comma-separated list, or "none" for an empty list); REGION_BLOCK=off turns it off.
// /health watches these settings (PLAN 0.4): a base list missing a sanctioned code, or a company list that no longer
// refuses CN, RU or HK, stops every service route (legal_pause); dropping a company's other codes is a warning. Opening
// CN, RU or HK to a company is therefore a code change (regionRulesProblems), reviewed, not a setting.
// Defaults checked Oct 2026 against each company's published list; re-check them now and then.

import { companyOf } from "./judge.ts";

/** Refused on every AI route whatever the models: comprehensive US sanctions, plus Tor (location unknown on purpose). */
export const BASE_BLOCKED = ["CU", "IR", "KP", "SY", "UA-43", "UA-40", "UA-14", "UA-09", "T1"];

/** Countries and regions each company doesn't serve, beyond BASE_BLOCKED. Other companies: BASE_BLOCKED only. */
export const COMPANY_BLOCKED: Record<string, string[]> = {
  // anthropic.com/supported-countries: no mainland China, Hong Kong, Macau, Russia, Belarus, Venezuela, Afghanistan,
  // Myanmar or Yemen; Ukraine except Crimea, Donetsk, Kherson, Luhansk and Zaporizhzhia.
  anthropic: ["AF", "BY", "CN", "HK", "MM", "MO", "RU", "VE", "YE", "UA-65", "UA-23"],
  // OpenAI's supported countries list: no mainland China, Hong Kong, Macau, Russia, Belarus or Venezuela.
  openai: ["BY", "CN", "HK", "MO", "RU", "VE"],
  // ai.google.dev/gemini-api/docs/available-regions: no mainland China, Hong Kong, Macau, Russia, Belarus,
  // Afghanistan or Myanmar.
  google: ["AF", "BY", "CN", "HK", "MM", "MO", "RU"],
};

export type Where = { country?: string; sub?: string };

/** The request's country (upper case) and subdivision ("CC-SUB"), from Cloudflare. Unknown: both undefined. */
export function whereFrom(req: Request, header: (name: string) => string | undefined): Where {
  const cf: any = (req as any).cf ?? {};
  const raw = String(cf.country || header("cf-ipcountry") || "").trim().toUpperCase();
  const country = /^[A-Z][A-Z0-9]$/.test(raw) && raw !== "XX" ? raw : undefined;
  const region = String(cf.regionCode ?? "").trim().toUpperCase();
  const sub = country && /^[A-Z0-9]{1,3}$/.test(region) ? `${country}-${region}` : undefined;
  return { country, sub };
}

/** An env list, or the default when it's unset, blank or has any code that isn't valid (a typo such as "CN;RU" must
 * never quietly empty a list). "none" is the only way to empty one. */
const listInvalid = (raw: string) => {
  const codes = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return !codes.length || codes.some((s) => !/^[A-Z][A-Z0-9](-[A-Z0-9]{1,3})?$/.test(s));
};
function listFrom(env: Record<string, unknown>, name: string, fallback: string[]): string[] {
  const raw = env[name];
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  if (raw.trim().toLowerCase() === "none") return [];
  const codes = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (listInvalid(raw)) {
    console.error(`${name} has a code that isn't valid; using the default list instead`);
    return fallback;
  }
  return codes;
}

/** BLOCKED_REGIONS_<COMPANY>, e.g. BLOCKED_REGIONS_ANTHROPIC or BLOCKED_REGIONS_DEEPSEEK. */
const companyVar = (company: string) => `BLOCKED_REGIONS_${company.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/**
 * Whether a request from `where` may use these models. Returns null when it may, or which code matched and which
 * company (or "all") rules it out. An unknown location is allowed: blocking it would also block local tools and
 * tests, and Cloudflare knows the country for nearly every real request.
 */
export function regionBlock(env: Record<string, unknown>, models: string[], where: Where): { code: string; company: string } | null {
  if (String(env.REGION_BLOCK ?? "").trim().toLowerCase() === "off" || !where.country) return null;
  const codes = [where.country, where.sub].filter(Boolean) as string[];
  const hit = (list: string[]) => codes.find((c) => list.includes(c));
  const base = hit(listFrom(env, "BLOCKED_REGIONS", BASE_BLOCKED));
  if (base) return { code: base, company: "all" };
  for (const company of [...new Set(models.map(companyOf))]) {
    const h = hit(listFrom(env, companyVar(company), COMPANY_BLOCKED[company] ?? []));
    if (h) return { code: h, company };
  }
  return null;
}

/**
 * The judge routes' rule. Anthropic's list still applies to them, whatever CLAUDE_JUDGES_ENABLED says, so taking Claude
 * off the panels, or turning Claude judges back on, opens no country as a side effect (judge-tier spec v2.2, §5, D3).
 * ccheez34 can open them later, after the lawyer. Such a refusal says "judge matches aren't offered there for now"
 * rather than naming Anthropic.
 */
export function judgeRegionBlock(env: Record<string, unknown>, models: string[], where: Where): { code: string; company: string } | null {
  const block = regionBlock(env, models, where);
  if (block || models.some((m) => companyOf(m) === "anthropic")) return block;
  const kept = regionBlock(env, ["anthropic/judges-off"], where);
  return kept ? { code: kept.code, company: "judges" } : null;
}

/** The refusal: HTTP 451. Nothing charged, nothing used. */
export function regionRefusal(block: { code: string; company: string }, suffix: string) {
  const who = block.company === "all" ? "" : block.company === "judges" ? " (judge matches aren't offered there for now)" : ` (${block.company}'s models aren't offered there)`;
  return new Response(
    JSON.stringify({
      error: `not_available_in_region: this service can't serve requests from your location${who}. ${suffix}`.trim(),
      region: block.code,
    }),
    { status: 451, headers: { "content-type": "application/json" } },
  );
}

/** Usage-count names for GET /admin/stats: "cc_jp" (requests by country), "rb_cn" / "rb_ua-43" (refused by region). */
export const countryStat = (where: Where) => `cc_${(where.country ?? "xx").toLowerCase()}`;
export const blockedStat = (code: string) => `rb_${code.toLowerCase()}`;

/**
 * PLAN 0.4, alerts A1 and A2 (research\legal-risks-2026-10-28\ALERTS-spec.md): what /health reports about the region
 * rules themselves. Pure and cheap, so /health and every route can run it on every call: while it isn't empty, the
 * routes refuse with legal_pause (review R1, agreed by 4.0 at 09:34; index.ts, legalPause).
 * - "region_rules_off" (A1): REGION_BLOCK=off, or a BLOCKED_REGIONS setting that leaves out any BASE_BLOCKED code.
 * - "region_selftest_failed:<probe>" (A2): the rule itself, run against fixed locations, lets one through. Probes:
 *   every BASE_BLOCKED code (from the list itself, so it can't fall behind), with no models and with each company's;
 *   CN, RU and HK with each company that doesn't serve them; and the US, which must stay open.
 */
export function regionRulesProblems(env: Record<string, unknown>, block: typeof regionBlock = regionBlock): string[] {
  const base = listFrom(env, "BLOCKED_REGIONS", BASE_BLOCKED);
  if (String(env.REGION_BLOCK ?? "").trim().toLowerCase() === "off" || BASE_BLOCKED.some((c) => !base.includes(c))) return ["region_rules_off"];
  const at = (code: string): Where => (code.includes("-") ? { country: code.split("-")[0], sub: code } : { country: code });
  const sample: Record<string, string> = { anthropic: "claude-sonnet-5-5", openai: "openai/gpt-6-luna", google: "google/gemini-4-argon" };
  const failed: string[] = [];
  for (const code of BASE_BLOCKED) {
    if (!block(env, [], at(code))) failed.push(code);
    else for (const co of Object.keys(sample)) if (!block(env, [sample[co]], at(code))) { failed.push(`${code}:${co}`); break; }
  }
  for (const code of ["CN", "RU", "HK"])
    for (const co of Object.keys(sample)) if (COMPANY_BLOCKED[co]?.includes(code) && !block(env, [sample[co]], at(code))) failed.push(`${code}:${co}`);
  if (block(env, Object.values(sample), { country: "US" })) failed.push("US:open");
  return failed.map((f) => `region_selftest_failed:${f}`);
}

/**
 * Warnings about the region settings (fresh read of Oct 31, F4 and F5), shown on /health; they don't stop anything.
 * - "region_list_weakened:<company>": that company's list in force leaves out one of its default codes (the companies'
 *   own lists, beyond the CN, RU and HK that the self-test requires).
 * - "region_list_invalid:<setting>": a BLOCKED_REGIONS setting couldn't be read, so its default list is used instead
 *   (a typo must never empty a list), and whatever the setting meant to add isn't in force.
 */
export function regionRulesWarnings(env: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [co, defaults] of Object.entries(COMPANY_BLOCKED)) {
    const list = listFrom(env, companyVar(co), defaults);
    if (defaults.some((c) => !list.includes(c))) out.push(`region_list_weakened:${co}`);
  }
  for (const [name, raw] of Object.entries(env))
    if (/^BLOCKED_REGIONS(_[A-Z0-9_]+)?$/.test(name) && typeof raw === "string" && raw.trim() && raw.trim().toLowerCase() !== "none" && listInvalid(raw))
      out.push(`region_list_invalid:${name}`);
  return out;
}
