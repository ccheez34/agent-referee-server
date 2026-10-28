import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedStat, countryStat, regionBlock, regionRefusal, whereFrom } from "../src/regions.ts";

const where = (country?: string, regionCode?: string) => whereFrom({ cf: { country, regionCode } } as any, () => undefined);
const CLAUDE = "claude-sonnet-5-5";
const GPT = "openai/gpt-5.5";
const GEMINI = "google/gemini-4-argon";
const DEEPSEEK = "deepseek/deepseek-v4-pro-0813";

test("location: Cloudflare's cf object first, then the cf-ipcountry header; XX and junk are unknown", () => {
  assert.deepEqual(where("JP", "13"), { country: "JP", sub: "JP-13" });
  assert.deepEqual(whereFrom({} as any, (n) => (n === "cf-ipcountry" ? "sg" : undefined)), { country: "SG", sub: undefined });
  assert.deepEqual(where("XX"), { country: undefined, sub: undefined });
  assert.deepEqual(where("not a country"), { country: undefined, sub: undefined });
  assert.deepEqual(where("T1"), { country: "T1", sub: undefined }, "Tor is reported as T1");
  assert.equal(whereFrom({ cf: { country: "" } } as any, () => "HK").country, "HK", "an empty cf.country falls back to the header");
});

test("each company's own list: a single Claude review is refused in Hong Kong; an opt-in DeepSeek one isn't", () => {
  assert.deepEqual(regionBlock({}, [CLAUDE], where("HK")), { code: "HK", company: "anthropic" });
  assert.equal(regionBlock({}, [DEEPSEEK], where("HK")), null);
  assert.equal(regionBlock({}, [CLAUDE], where("JP")), null);
  assert.equal(regionBlock({}, [CLAUDE, GPT, GEMINI], where("US")), null);
});

test("companies differ: Afghanistan is refused for Claude and Gemini but not GPT; Venezuela for Claude and GPT, not Gemini", () => {
  assert.equal(regionBlock({}, [GPT], where("AF")), null);
  assert.equal(regionBlock({}, [GEMINI], where("AF"))?.company, "google");
  assert.equal(regionBlock({}, [CLAUDE], where("AF"))?.company, "anthropic");
  assert.equal(regionBlock({}, [GEMINI], where("VE")), null);
  assert.equal(regionBlock({}, [GPT], where("VE"))?.company, "openai");
  assert.ok(regionBlock({}, [CLAUDE, GPT, GEMINI], where("CN")), "review-3 in mainland China");
});

test("sanctions list applies to every model, and to routes with no models", () => {
  for (const cc of ["CU", "IR", "KP", "SY", "T1"]) {
    assert.deepEqual(regionBlock({}, [], where(cc)), { code: cc, company: "all" }, cc);
    assert.equal(regionBlock({}, [DEEPSEEK], where(cc))?.company, "all", cc);
  }
  assert.deepEqual(regionBlock({}, [], where("UA", "43")), { code: "UA-43", company: "all" }, "Crimea");
  assert.equal(regionBlock({}, [], where("UA", "30")), null, "Kyiv city");
  assert.equal(regionBlock({}, [GPT], where("UA", "65")), null, "Kherson: only Anthropic's list names it");
  assert.equal(regionBlock({}, [CLAUDE], where("UA", "65"))?.code, "UA-65");
});

test("unknown location is allowed; REGION_BLOCK=off turns it all off", () => {
  assert.equal(regionBlock({}, [CLAUDE], where(undefined)), null);
  assert.equal(regionBlock({ REGION_BLOCK: "off" }, [CLAUDE], where("IR")), null);
  assert.equal(regionBlock({ REGION_BLOCK: " Off " }, [CLAUDE], where("IR")), null, "spaces and case are ignored");
});

test("env lists replace the defaults; 'none' empties one; other companies get their own var", () => {
  assert.equal(regionBlock({ BLOCKED_REGIONS_ANTHROPIC: "none" }, [CLAUDE], where("HK")), null);
  assert.equal(regionBlock({ BLOCKED_REGIONS_ANTHROPIC: "fr, de" }, [CLAUDE], where("DE"))?.code, "DE");
  assert.equal(regionBlock({ BLOCKED_REGIONS: "none" }, [DEEPSEEK], where("IR")), null);
  assert.equal(regionBlock({ BLOCKED_REGIONS_DEEPSEEK: "CN" }, [DEEPSEEK], where("CN"))?.company, "deepseek");
  assert.equal(regionBlock({ BLOCKED_REGIONS_ANTHROPIC: "   " }, [CLAUDE], where("HK"))?.code, "HK", "blank keeps the default");
  // A typo never quietly empties a list: the whole override is ignored and the default stays.
  assert.equal(regionBlock({ BLOCKED_REGIONS_ANTHROPIC: "CN;RU" }, [CLAUDE], where("HK"))?.code, "HK");
  assert.equal(regionBlock({ BLOCKED_REGIONS: "CU,IRAN" }, [], where("KP"))?.code, "KP");
  assert.equal(regionBlock({ BLOCKED_REGIONS: "," }, [], where("KP"))?.code, "KP");
});

test("refusal is a 451 that says nothing was used; stat names fit the ledger's pattern", async () => {
  const r = regionRefusal({ code: "HK", company: "anthropic" }, "Nothing was charged.");
  assert.equal(r.status, 451);
  const body: any = await r.json();
  assert.match(body.error, /^not_available_in_region: .*anthropic.*Nothing was charged\.$/);
  assert.equal(body.region, "HK");
  for (const n of [countryStat(where("JP")), countryStat(where(undefined)), blockedStat("UA-43"), blockedStat("T1")])
    assert.match(n, /^[a-z0-9_-]{1,48}$/, n);
  assert.equal(countryStat(where(undefined)), "cc_xx");
});
