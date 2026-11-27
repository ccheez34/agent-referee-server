// Builds the Worker without deploying (wrangler --dry-run) into a temp folder and fails if the bundle
// carries third-party wallet SDK code (x402's prebuilt browser paywall). Usage: npm run check:bundle
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "ar-bundle-"));
try {
  // Windows has npx only as npx.cmd, which needs a shell (his PC, Nov 26: "spawnSync npx ENOENT"); the arguments are fixed.
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", out], { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
  const js = readFileSync(join(out, "index.js"), "utf8");
  const banned = [/@metamask\//i, /@base-org\/account/i, /@cbhq\//i, /x402\/src\/paywall\/gen\/template/];
  const hits = banned.filter((re) => re.test(js)).map(String);
  const kib = (Buffer.byteLength(js) / 1024).toFixed(0);
  if (hits.length) { console.error(`bundle check FAILED (${kib} KiB): found ${hits.join(", ")}`); process.exit(1); }
  console.log(`bundle check passed: ${kib} KiB, no wallet SDK code`);
} finally { rmSync(out, { recursive: true, force: true }); }
