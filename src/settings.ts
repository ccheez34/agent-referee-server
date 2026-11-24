// The settings checked before anything is served (PLAN revision 4 of the panels' new models, 2.0's point 3). A problem
// here stops the service: every route answers 503 with the entries named, and /health shows them (index.ts).
//
// Today's checks are the new models' (judge.ts NEW_MODELS): each entry must come from a company already in the pool,
// have a price, and sit in no other list; and no setting, set or left at the code's default, may make one a default
// model. That last rule is what keeps a new model from judging, or being drawn, before its trials: adding one to
// JUDGE_MODEL_POOL or a panel's list stops the service, rather than quietly making it a judge.

import { DEFAULT_MODEL_POOL, companyOf, modelPool, newModels, optInModels, panelModels, tierModels, trialedJudges, type JudgeEnv } from "./judge.ts";
import { reviewModels } from "./review.ts";
import { hasPriceRows } from "./prices.ts";

export type SettingsEnv = JudgeEnv & { REVIEW_MODEL?: string; REVIEW_3_MODELS?: string };
const split = (s?: string) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

/** Each setting that picks default models, with the models it gives: as set, or the code's own default for it. */
export function defaultModelsBySetting(env: SettingsEnv): Record<string, string[]> {
  return {
    MODEL_POOL: modelPool(env),
    REVIEW_MODEL: reviewModels("review", env),
    REVIEW_3_MODELS: reviewModels("review-3", env),
    JUDGE_MODEL: tierModels(env, "judge"),
    PANEL_MODELS: split(env.PANEL_MODELS),
    PANEL_2_MODELS: panelModels(env, "judge-2"),
    PANEL_3_MODELS: panelModels(env, "judge-3"),
    JUDGE_MODEL_POOL: split(env.JUDGE_MODEL_POOL || env.MODEL_POOL || DEFAULT_MODEL_POOL),
  };
}

/** What the service won't start with, each line naming its entry. Empty when the settings are fine. */
export function newModelsProblems(env: SettingsEnv): string[] {
  const companies = new Set(modelPool(env).map(companyOf));
  const optIn = optInModels(env);
  const news = newModels(env);
  const out: string[] = [];
  for (const m of news) {
    if (!companies.has(companyOf(m))) out.push(`NEW_MODELS: ${m}'s company (${companyOf(m)}) has no model in MODEL_POOL. Take it out of NEW_MODELS ("" turns new models off); a new company comes in through OPT_IN_MODELS.`);
    if (optIn.includes(m)) out.push(`NEW_MODELS: ${m} is also in OPT_IN_MODELS. Keep it in one of the two.`);
    if (!hasPriceRows(m)) out.push(`NEW_MODELS: ${m} has no row in the price table (src/prices.ts). Add its price there, or take it out of NEW_MODELS.`);
  }
  for (const [key, models] of Object.entries(defaultModelsBySetting(env)))
    for (const m of new Set(models)) if (news.includes(m)) out.push(`${key} gives ${m}, a new model (NEW_MODELS): a new model is never drawn and never a default. Change ${key}, or take ${m} out of NEW_MODELS once its trials are done.`);
  for (const m of trialedJudges(env)) if (!news.includes(m)) out.push(`TRIALED_JUDGES: ${m} isn't in NEW_MODELS. TRIALED_JUDGES lists only new models that passed a judge trial.`);
  return out;
}
