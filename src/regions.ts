// Where requests come from, and which AI companies may serve them.
//
// The reviewer and judge models belong to companies that each limit where their models may be used. Anthropic's
// Supported Regions Policy, for one, restricts use "by persons while physically located in an unsupported region".
// So an AI-calling route refuses a request from a country (or region) that any of the request's models' companies
// don't serve, before payment and before any allowance is used. Cloudflare reports each request's country.
//
// Lists are ISO 3166-1 alpha-2 country codes, or "CC-SUB" ISO 3166-2 subdivisions (UA-43 is Crimea). Each list can
// be replaced with an env var (a comma-separated list, or "none" for an empty list); REGION_BLOCK=off turns it off.
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
  const raw = String(cf.country ?? header("cf-ipcountry") ?? "").trim().toUpperCase();
  const country = /^[A-Z][A-Z0-9]$/.test(raw) && raw !== "XX" ? raw : undefined;
  const region = String(cf.regionCode ?? "").trim().toUpperCase();
  const sub = country && /^[A-Z0-9]{1,3}$/.test(region) ? `${country}-${region}` : undefined;
  return { country, sub };
}

function listFrom(env: Record<string, unknown>, name: string, fallback: string[]): string[] {
  const raw = env[name];
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  if (raw.trim().toLowerCase() === "none") return [];
  return raw.split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9](-[A-Z0-9]{1,3})?$/.test(s));
}

/** BLOCKED_REGIONS_<COMPANY>, e.g. BLOCKED_REGIONS_ANTHROPIC or BLOCKED_REGIONS_DEEPSEEK. */
const companyVar = (company: string) => `BLOCKED_REGIONS_${company.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/**
 * Whether a request from `where` may use these models. Returns null when it may, or which code matched and which
 * company (or "all") rules it out. An unknown location is allowed: blocking it would also block local tools and
 * tests, and Cloudflare knows the country for nearly every real request.
 */
export function regionBlock(env: Record<string, unknown>, models: string[], where: Where): { code: string; company: string } | null {
  if (String(env.REGION_BLOCK ?? "").toLowerCase() === "off" || !where.country) return null;
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

/** The refusal: HTTP 451. Nothing charged, nothing used. */
export function regionRefusal(block: { code: string; company: string }, suffix: string) {
  const who = block.company === "all" ? "" : ` (${block.company}'s models aren't offered there)`;
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
