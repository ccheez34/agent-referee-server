// Proof receipts (research\specs\proof-receipts-2026-10-31\SPEC.md, v0.4): signed records that use no AI model.
//   L0 "stamp":   a claim and a hash the caller computed, signed as received ("claimed", never checked).
//   L1 "observe": one public fact the service checked itself on GitHub ("observed"): a commit, or its checks.
// L2, the highest level, is an existing review-3 receipt with 3 of 3 "pass" votes; nothing here changes it.
// For now: team members only (POST /team/proof), free, unlisted (not in GET /, llms.txt or any tool text) until the
// experiment's last arm ends. A receipt never stands in for the owner's yes (deploys, payments, deletes, secrets,
// installing skills or servers, rule changes).

export const PROOF_FORMAT = "agent-referee-proof-v1";
export const L0_NOTE = "claimed by the caller; not checked by Agent Referee";
export const NEVER_AN_APPROVAL =
  "A receipt can pass a quality step. It never stands in for the owner's yes: deploys, payments, deletes, secrets, installing skills or servers, and rule changes.";
export const MAX_CLAIM = 500;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
// GitHub's own limits: owners up to 39 characters (letters, digits, hyphens), repository names up to 100.
const REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;

export type ProofRequest =
  | { level: "L0"; check: "stamp"; sha256: string; claim: string }
  | { level: "L1"; check: "github_commit" | "github_checks"; repo: string; sha: string };

/** Checks and normalizes a request (spec §4): lower-case hex at full length, never abbreviated; owner/name lower-cased. */
export function parseProofRequest(body: any): { ok: true; value: ProofRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: 'Send JSON: {"level":"L0","check":"stamp","sha256":"<64 hex>","claim":"..."} or {"level":"L1","check":"github_commit" or "github_checks","repo":"owner/name","sha":"<40 hex>"}.' };
  if (body.level === "L0") {
    if (body.check !== undefined && body.check !== "stamp") return { ok: false, error: 'L0 has one check: "stamp".' };
    const sha256 = typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : "";
    if (!HEX64.test(sha256)) return { ok: false, error: "sha256 must be 64 hex characters: the full sha256 of the artifact, computed by you. The service never sees the artifact." };
    if (body.claim !== undefined && typeof body.claim !== "string") return { ok: false, error: "claim must be text." };
    const claim = body.claim ?? "";
    if (claim.length > MAX_CLAIM) return { ok: false, error: `claim can be at most ${MAX_CLAIM} characters.` };
    return { ok: true, value: { level: "L0", check: "stamp", sha256, claim } };
  }
  if (body.level === "L1") {
    if (body.check !== "github_commit" && body.check !== "github_checks") return { ok: false, error: 'L1 checks are "github_commit" and "github_checks" (url_sha256 comes later).' };
    const repo = typeof body.repo === "string" ? body.repo.trim().toLowerCase() : "";
    if (!REPO.test(repo) || repo.split("/")[1].startsWith(".")) return { ok: false, error: 'repo must be "owner/name" of a public GitHub repository.' };
    const sha = typeof body.sha === "string" ? body.sha.trim().toLowerCase() : "";
    if (!HEX40.test(sha)) return { ok: false, error: "sha must be the commit's full 40 hex characters; short shas are refused." };
    return { ok: true, value: { level: "L1", check: body.check, repo, sha } };
  }
  return { ok: false, error: 'level must be "L0" or "L1". (L2 is a review-3 receipt with 3 of 3 "pass" votes: POST /team/review-3.)' };
}

type Observation = { ok: true; repo: string; observed: Record<string, unknown> } | { ok: false; status: number; error: string };
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: Observation & { ok: true } }>();
/** Tests only. */
export const _clearProofCache = () => cache.clear();

/**
 * L1: asks GitHub's public API, never anything else (spec §7): no credentials but the service's own optional read
 * token, 10 seconds per request, redirects only within api.github.com. A result is kept 10 minutes per check, repo
 * and commit, with its original observed_at, so a new receipt can't make an old observation look new.
 */
export async function observeGithub(
  check: "github_commit" | "github_checks",
  repo: string,
  sha: string,
  opts: { token?: string; fetch?: typeof fetch; now?: () => number } = {},
): Promise<Observation> {
  const now = opts.now ?? Date.now;
  const key = `${check}:${repo}:${sha}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_MS) return hit.value;
  const doFetch = opts.fetch ?? fetch;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "agent-referee-proof", "x-github-api-version": "2022-11-28", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) };
  const get = async (path: string): Promise<{ ok: true; data: any } | { ok: false; status: number; error: string }> => {
    let res: Response;
    try {
      res = await doFetch(`https://api.github.com${path}`, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
      // GitHub answers a renamed repository with a redirect inside its own API; follow one, and only there.
      if (res.status === 301 || res.status === 302 || res.status === 307) {
        const to = new URL(res.headers.get("location") ?? "", "https://api.github.com");
        if (to.origin !== "https://api.github.com") return { ok: false, status: 502, error: "couldn't observe: GitHub redirected outside its API" };
        res = await doFetch(to.href, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
      }
    } catch (e: any) {
      return { ok: false, status: 503, error: `couldn't observe: GitHub didn't answer (${e?.name === "TimeoutError" ? "timed out" : "network"})` };
    }
    if (res.status === 404 || res.status === 422) return { ok: false, status: 404, error: "not found: the repository is private or doesn't exist, or the commit isn't in it" };
    if (res.status === 403 || res.status === 429) return { ok: false, status: 503, error: "couldn't observe: GitHub's rate limit; try again later" };
    if (!res.ok) return { ok: false, status: 502, error: `couldn't observe: GitHub answered ${res.status}` };
    const data = await res.json().catch(() => null);
    return data && typeof data === "object" ? { ok: true, data } : { ok: false, status: 502, error: "couldn't observe: GitHub's answer couldn't be read" };
  };
  const base = `/repos/${repo}/commits/${sha}`;
  const commit = await get(base);
  if (!commit.ok) return commit;
  const c = commit.data;
  if (String(c.sha ?? "").toLowerCase() !== sha) return { ok: false, status: 404, error: "not found: GitHub returned a different commit" };
  // The repository's name as GitHub spells it, lower-cased (spec §4), from the commit's own page address.
  const named = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/commit\//.exec(String(c.html_url ?? ""))?.[1]?.toLowerCase() ?? repo;
  const observed_at = new Date(now()).toISOString();
  let observed: Record<string, unknown>;
  if (check === "github_commit") {
    observed = {
      commit_sha: sha,
      tree_sha: String(c.commit?.tree?.sha ?? "").toLowerCase() || null,
      parents: Array.isArray(c.parents) ? c.parents.map((p: any) => String(p?.sha ?? "").toLowerCase()) : [],
      author_time: c.commit?.author?.date ?? null,
      committer_time: c.commit?.committer?.date ?? null,
    };
  } else {
    const runs = await get(`${base}/check-runs?per_page=100`);
    if (!runs.ok) return runs;
    const status = await get(`${base}/status`);
    if (!status.ok) return status;
    const list = Array.isArray(runs.data.check_runs) ? runs.data.check_runs : [];
    observed = {
      commit_sha: sha,
      // Every run GitHub reports, in-progress ones as such (status not "completed", conclusion null): never "passed".
      check_runs: list.map((r: any) => ({ name: String(r?.name ?? ""), app: r?.app?.slug ?? null, status: String(r?.status ?? ""), conclusion: r?.conclusion ?? null, completed_at: r?.completed_at ?? null })),
      check_runs_total: Number(runs.data.total_count ?? list.length),
      ...(Number(runs.data.total_count ?? 0) > list.length ? { check_runs_truncated: true } : {}),
      statuses: (Array.isArray(status.data.statuses) ? status.data.statuses : []).map((s: any) => ({ context: String(s?.context ?? ""), state: String(s?.state ?? ""), updated_at: s?.updated_at ?? null })),
      combined_status: status.data.state ?? null,
    };
  }
  const value = { ok: true as const, repo: named, observed: { ...observed, observed_at, source: "api.github.com" } };
  cache.set(key, { at: now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}

/** The signed payload (spec §4). `claimed` and `observed` are always separate. */
export function proofPayload(input: { request: ProofRequest; member: string; id: string; issuedAt: string; observation?: { repo: string; observed: Record<string, unknown> } }) {
  const r = input.request;
  const common = { format: PROOF_FORMAT, type: "proof", service: "Agent Referee", receipt_id: input.id, level: r.level, check: r.check };
  const tail = { issued_at: input.issuedAt, caller: { member: input.member }, funding: "team", price_micro: 0 };
  if (r.level === "L0") return { ...common, subject: { sha256: r.sha256 }, claimed: { text: r.claim }, note: L0_NOTE, ...tail };
  return { ...common, subject: { repo: input.observation!.repo, sha: r.sha }, observed: input.observation!.observed, ...tail };
}
