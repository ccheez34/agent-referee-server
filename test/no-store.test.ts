// The live-state GETs answer cache-control: no-store (5.0-D386; card B of 2.0's 1148), the settings' 503 included; other
// pages keep their own caching. And the CI notice counts both Node reporters (2.0-D1472).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

let app: any = null;
try {
  app = (await import("../src/index.ts")).default;
} catch (e) {
  console.log(`no-store route tests skipped (dependencies not installed here): ${String((e as any)?.message ?? e).slice(0, 120)}`);
}
const t = app ? test : test.skip;
const ctx = { waitUntil() {}, passThroughOnException() {} };
const get = (path: string, env: Record<string, unknown> = {}) => app.fetch(new Request(`https://x${path}`), { ...env }, ctx) as Promise<Response>;

t("GET /reviewers, /judge, /compare, /health and /consent answer cache-control: no-store", async () => {
  for (const p of ["/reviewers", "/judge", "/compare", "/health", "/consent"]) {
    const r = await get(p);
    assert.equal(r.headers.get("cache-control"), "no-store", p);
  }
});

t("the settings' 503 on those paths is no-store too, and other pages are left as they were", async () => {
  const bad = { REVIEW_MODEL: "google/gemini-4-carbon" }; // a new model as a default: the settings check refuses
  const r = await get("/reviewers", bad);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("cache-control"), "no-store");
  for (const p of ["/llms.txt", "/pubkey", "/"]) assert.notEqual((await get(p)).headers.get("cache-control"), "no-store", p);
});

test("the CI notice's grep counts Node 22's '# tests' and Node 24's 'ℹ tests' lines", async () => {
  const yml = await readFile(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8");
  const line = yml.split("\n").find((l) => l.includes("::notice::") && l.includes("grep -E"))!;
  const pattern = /grep -E '([^']+)'/.exec(line)![1];
  const sample = "# tests 384\n# pass 383\nℹ tests 384\nℹ pass 383\nℹ fail 0\nok 1 - x\n";
  const out = execFileSync("grep", ["-E", pattern], { input: sample, encoding: "utf8" });
  assert.equal(out.trim().split("\n").length, 5, out);
});
