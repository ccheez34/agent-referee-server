// What each AI model costs this service, per million tokens, input and output, with the day each price starts.
//
// The service's tiers have fixed prices; it doesn't bill its users per token. This table is what checks a tier's price against
// what its reviewers can cost: the multi-part tiers' worst case (multipart.ts, and its test), and the rule that a new
// model (NEW_MODELS, judge.ts) is taken on review and review-3 only while its price is at or under the dearest model
// those tiers already take. A model with no row for a day is treated as unpriced that day: a new model is then refused.
//
// Every row names where it was read. Prices change on a date the providers announce, so each change is its own row.
// Dates are UTC days (a row starts at 00:00 UTC on its "from" day and ends where the next row starts, or at "until").

export type PriceRow = {
  /** First UTC day the price applies, "YYYY-MM-DD". */
  from: string;
  /** First UTC day it no longer applies, when the provider has announced an end but not (yet) the next price. */
  until?: string;
  /** Dollars per million input tokens. */
  in: number;
  /** Dollars per million output tokens. */
  out: number;
  /** Where the price was read, and when. */
  source: string;
};

export const MODEL_PRICES: Record<string, PriceRow[]> = {
  "claude-opus-5-5": [{ from: "2026-01-01", in: 4, out: 20, source: "Anthropic's list price (usagepricing.com rate card, layer3labs.io, read Oct 28, 2026)" }],
  "claude-sonnet-5-5": [{ from: "2026-01-01", in: 2, out: 10, source: "Anthropic's list price (usagepricing.com rate card, read Oct 28, 2026)" }],
  "openai/gpt-6-luna": [{ from: "2026-01-01", in: 0.1, out: 0.5, source: "OpenRouter's compare pages, read Oct 28, 2026" }],
  "google/gemini-4-argon": [
    { from: "2026-10-13", in: 2, out: 10, source: "Google's Gemini API pricing page: introductory through Nov 30, 2026 (as quoted by several outlets, re-read Nov 23)" },
    { from: "2026-12-01", in: 4, out: 20, source: "Google's Gemini API pricing page: from Dec 1, 2026 (as above)" },
  ],
  "google/gemini-3.7-flash": [
    { from: "2026-08-13", in: 0.75, out: 3.75, source: "Google's introductory price through Dec 31, 2026 (Google's 3.8 Flash post's footnote, as quoted; OpenRouter, Oct 28)" },
    { from: "2027-01-01", in: 1.5, out: 7.5, source: "Google: from Jan 1, 2027 (the same footnote, as quoted; read Nov 23, 2026)" },
  ],
  "google/gemini-3.8-flash": [
    { from: "2026-09-02", in: 0.75, out: 3.75, source: "Google's launch post: introductory through Dec 31, 2026 (as quoted by several outlets, read Nov 23, 2026)" },
    { from: "2027-01-01", in: 1.5, out: 7.5, source: "Google's launch post's footnote: from Jan 1, 2027 (as above)" },
  ],
  "google/gemini-4-carbon": [
    { from: "2026-11-10", in: 2, out: 10, source: "Google's Gemini API pricing page, through Nov 30, 2026 (as quoted; OpenRouter's page, read Nov 23, 2026)" },
    { from: "2026-12-01", in: 4, out: 20, source: "Google's Gemini API pricing page: from Dec 1, 2026 (as quoted, read Nov 23, 2026)" },
  ],
  "google/gemini-4-neon": [{ from: "2026-11-18", in: 3, out: 15, source: "Google's Nov 18 post; OpenRouter's page (read Nov 21 and Nov 23, 2026): no change on Dec 1" }],
  "google/gemini-4-hydrogen": [{ from: "2026-11-12", in: 1.5, out: 7.5, source: "OpenRouter's page (Google AI Studio and Vertex), read Nov 21 and Nov 23, 2026" }],
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (d: string) => Date.parse(`${d}T00:00:00Z`);

/**
 * The row that applies to this model at this time (ms since 1970), or null if none does: the row with the latest "from"
 * that has started, unless its own "until" has passed. An older row never comes back once a later one has started, so
 * after an announced end with no next price the model is unpriced, not back at an old price.
 */
export function priceOn(model: string, at: number = Date.now()): PriceRow | null {
  let latest: PriceRow | null = null;
  for (const row of MODEL_PRICES[model] ?? []) {
    if (dayStart(row.from) <= at && (!latest || dayStart(row.from) >= dayStart(latest.from))) latest = row;
  }
  return latest && (latest.until === undefined || at < dayStart(latest.until)) ? latest : null;
}

/** Whether a model has any price row at all (the settings check at start asks this of every new model). */
export const hasPriceRows = (model: string) => (MODEL_PRICES[model] ?? []).length > 0;

/** "$4 / $20 per million tokens (input / output)" */
export const priceText = (row: PriceRow) => `$${row.in} / $${row.out} per million tokens (input / output)`;

/** The table's own shape, checked by a test: days well formed, each model's rows in order, positive prices. */
export function priceTableProblems(table: Record<string, PriceRow[]> = MODEL_PRICES): string[] {
  const out: string[] = [];
  for (const [model, rows] of Object.entries(table)) {
    rows.forEach((r, i) => {
      if (!DAY.test(r.from) || Number.isNaN(dayStart(r.from))) out.push(`${model}: row ${i + 1}'s from isn't a YYYY-MM-DD day`);
      if (r.until !== undefined && (!DAY.test(r.until) || !(dayStart(r.until) > dayStart(r.from)))) out.push(`${model}: row ${i + 1}'s until isn't a later day`);
      if (!(r.in > 0) || !(r.out > 0)) out.push(`${model}: row ${i + 1}'s prices aren't positive`);
      if (!r.source) out.push(`${model}: row ${i + 1} names no source`);
      if (i > 0 && !(dayStart(r.from) > dayStart(rows[i - 1].from))) out.push(`${model}: rows out of order at ${i + 1}`);
    });
  }
  return out;
}
