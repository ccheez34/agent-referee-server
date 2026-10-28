// Notes on AI answers cut off at the token limit ("ran out of tokens"), so each model's answer budget can be raised.
// Every cut-off is counted per model per day (GET /admin/stats, "ran_out_of_tokens") and the last 100 are kept with
// the details that matter for tuning: the model, its token limit and how long the prompt was. Never the prompt itself.
import type { Env } from "./types.ts";
import { recordEvent } from "./health.ts";

export type CutOff = { where: "review" | "judge"; model: string; max_tokens: number; prompt_chars: number; try_number?: number };

/** Usage-count name for a model's cut-offs, e.g. "oot_openai-gpt-6-luna" (fits the ledger's stat-name pattern). */
export const cutoffStat = (model: string) => `oot_${model.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 44)}`;

/** Records one cut-off: counted every time, noted in the recent list, logged, and a /health warning. Never throws. */
export async function recordCutOff(env: Env, c: CutOff): Promise<void> {
  console.error(JSON.stringify({ ran_out_of_tokens: c }));
  const jobs: Promise<unknown>[] = [recordEvent(env, "out_of_tokens", `${c.where} ${c.model}: max_tokens ${c.max_tokens}, prompt ${c.prompt_chars} characters`)];
  if (env.LEDGER) {
    const stub = env.LEDGER.get(env.LEDGER.idFromName("global"));
    jobs.push(stub.fetch("https://ledger/cutoff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) }));
  }
  await Promise.allSettled(jobs);
}
