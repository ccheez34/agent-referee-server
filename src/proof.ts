// Proof receipts (research\specs\proof-receipts-2026-10-31\SPEC.md, v0.4): signed records that use no AI model.
//   L0 "stamp":   a claim and a hash the caller computed, signed as received ("claimed", never checked).
//   L1 "observe": public facts the service checked itself on GitHub ("observed"): a commit, or its checks.
// L2, the highest level, is an existing review-3 receipt with 3 of 3 "pass" votes; nothing here changes it.
// For now: team members only (POST /team/proof), free, unlisted (not in GET /, llms.txt or any tool text) until the
// experiment's last arm ends. A receipt never stands in for the owner's yes (deploys, payments, deletes, secrets,
// installing skills or servers, rule changes); the signed `limits` field says so, so it travels with the receipt.

export const PROOF_FORMAT = "agent-referee-proof-v1";
export const L0_NOTE = "claimed by the caller; not checked by Agent Referee";
export const NEVER_AN_APPROVAL =
  "A receipt can pass a quality step. It never stands in for the owner's yes: deploys, payments, deletes, secrets, installing skills or servers, and rule changes.";
// What each level proves, signed into the receipt (fresh read of Oct 31, #8: the warning must travel with it).
export const LIMITS = {
  L0: `Proves only that this claim and hash reached Agent Referee at issued_at from a holder of the team token, who named itself as caller.member (not verified). Not that the claim is true. ${NEVER_AN_APPROVAL}`,
  L1: `Proves only what Agent Referee itself read from GitHub's public API at observed_at, for the request of a holder of the team token, who named itself as caller.member (not verified). Commit times are as written by the committer, and anyone who can write to the repository can post a status. Not that the work is good. ${NEVER_AN_APPROVAL}`,
};
export const MAX_CLAIM = 500;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
// GitHub's own limits: owners up to 39 characters (letters, digits, hyphens), repository names up to 100. Names may
// start with a dot (owner/.github is real); only "." and ".." are refused.
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
    const name = repo.split("/")[1] ?? "";
    if (!REPO.test(repo) || name === "." || name === "..") return { ok: false, error: 'repo must be "owner/name" of a public GitHub repository.' };
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
const fail = (status: number, error: string) => ({ ok: false as const, status, error });

/**
 * L1: asks GitHub's public API, never anything else (spec §7): no credentials but the service's own optional read
 * token, 10 seconds per request, one redirect at most and only within api.github.com. Each answer is checked against
 * the commit asked about. The observation time is taken after the last answer (fresh read #3). A result is kept 10
 * minutes per check, repository and commit in this Worker instance, with its original observed_at, so a new receipt
 * can't make an old observation look new.
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
  if (hit && now() - hit.at < CACHE_MS) return structuredClone(hit.value);
  const doFetch = opts.fetch ?? fetch;
  const token = opts.token?.trim();
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "agent-referee-proof", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  // A failure keeps GitHub's own status as `upstream` where the caller needs it; a success says whether GitHub's Link
  // header offers another page (`more`).
  const get = async (path: string): Promise<{ ok: true; data: any; more: boolean } | { ok: false; status: number; error: string; upstream?: number }> => {
    let res: Response;
    try {
      res = await doFetch(`https://api.github.com${path}`, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
      // GitHub answers a renamed repository with a redirect inside its own API; follow one, and only there.
      if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
        const loc = res.headers.get("location");
        if (!loc) return fail(502, "couldn't observe: GitHub redirected without a location");
        const to = new URL(loc, "https://api.github.com");
        if (to.origin !== "https://api.github.com" || to.pathname === "/") return fail(502, "couldn't observe: GitHub redirected outside the repository's API");
        res = await doFetch(to.href, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
      }
    } catch (e: any) {
      return fail(503, `couldn't observe: GitHub didn't answer (${e?.name === "TimeoutError" ? "timed out" : "network"})`);
    }
    if (res.status === 404 || res.status === 422) return { ...fail(404, "not found: the repository is private or doesn't exist, or the commit isn't in it"), upstream: res.status };
    // 403 is usually the rate limit, but not always (code review 2): either way nothing is observed.
    if (res.status === 403 || res.status === 429) return fail(503, `couldn't observe: GitHub refused the request (${res.status}, usually its rate limit); try again later`);
    if (!res.ok) return fail(502, `couldn't observe: GitHub answered ${res.status}`);
    const data = await res.json().catch(() => null);
    return data && typeof data === "object" ? { ok: true, data, more: /rel="next"/.test(res.headers.get("link") ?? "") } : fail(502, "couldn't observe: GitHub's answer couldn't be read");
  };
  // The repository: public only (fresh read #5), and its default branch.
  const info = await get(`/repos/${repo}`);
  if (!info.ok) return info;
  if (info.data.private !== false) return fail(404, "not found: the repository isn't public");
  const named = String(info.data.full_name ?? "").toLowerCase() || repo;
  const defaultBranch = String(info.data.default_branch ?? "");
  const base = `/repos/${repo}/commits/${sha}`;
  const commit = await get(base);
  if (!commit.ok) return commit;
  const c = commit.data;
  if (String(c.sha ?? "").toLowerCase() !== sha) return fail(404, "not found: GitHub returned a different commit");
  // A commit can be served through a repository's API path although it lives only in a fork ("imposter commits"),
  // so say where it is in this repository (fresh read #1): on the default branch, and which branches have it as head.
  // null means GitHub couldn't say (no default branch, or the comparison wasn't found): not shown either way.
  let onDefault: boolean | null = null;
  if (defaultBranch) {
    const cmp = await get(`/repos/${repo}/compare/${encodeURIComponent(defaultBranch)}...${sha}`);
    if (!cmp.ok && cmp.status !== 404) return cmp;
    if (cmp.ok) {
      const contained = cmp.data.status === "behind" || cmp.data.status === "identical";
      // When the commit is on the default branch, the comparison's merge base is the commit itself (code review 1).
      if (contained && String(cmp.data.merge_base_commit?.sha ?? "").toLowerCase() !== sha) return fail(502, "couldn't observe: GitHub's comparison was about a different commit");
      onDefault = contained;
    }
  }
  // GitHub documents this list as every branch whose head is the commit, with no pages; "none" is a 200 with an empty
  // list (seen live, Oct 31). per_page and the Link header cover it if it ever pages (code review 2). A 404 or its 422
  // ("validation failed, or the endpoint has been spammed") means GitHub didn't say: branch_heads is then null, meaning
  // unknown, never an empty list (fresh read of a6bb530). Anything else gives no receipt.
  const heads = await get(`${base}/branches-where-head?per_page=100`);
  if (!heads.ok && heads.upstream !== 404 && heads.upstream !== 422) return heads;
  const headList: any[] | null = heads.ok ? heads.data : null;
  if (headList !== null && !Array.isArray(headList)) return fail(502, "couldn't observe: GitHub's answer about branches couldn't be read");
  if (headList?.some((b: any) => String(b?.commit?.sha ?? "").toLowerCase() !== sha)) return fail(502, "couldn't observe: GitHub answered about a different commit");
  const where = {
    default_branch: defaultBranch || null,
    on_default_branch: onDefault,
    branch_heads: headList === null ? null : headList.slice(0, 100).map((b: any) => String(b?.name ?? "")),
    ...(headList !== null && (headList.length > 100 || (heads.ok && heads.more)) ? { branch_heads_truncated: true } : {}),
  };
  let observed: Record<string, unknown>;
  if (check === "github_commit") {
    observed = {
      commit_sha: sha,
      tree_sha: String(c.commit?.tree?.sha ?? "").toLowerCase() || null,
      parents: Array.isArray(c.parents) ? c.parents.map((p: any) => String(p?.sha ?? "").toLowerCase()) : [],
      // As written in the commit by its author and committer (fresh read #7), not when it was pushed.
      author_time_as_written: c.commit?.author?.date ?? null,
      committer_time_as_written: c.commit?.committer?.date ?? null,
      ...where,
    };
  } else {
    const runs = await get(`${base}/check-runs?per_page=100`);
    if (!runs.ok) return runs;
    const status = await get(`${base}/status?per_page=100`);
    if (!status.ok) return status;
    const list = runs.data.check_runs;
    const statuses = status.data.statuses;
    // Every answer must be about the commit asked for, in the shape GitHub documents (fresh read #6).
    if (!Array.isArray(list) || !Array.isArray(statuses)) return fail(502, "couldn't observe: GitHub's answer about the checks couldn't be read");
    if (list.some((r: any) => String(r?.head_sha ?? "").toLowerCase() !== sha) || String(status.data.sha ?? "").toLowerCase() !== sha)
      return fail(502, "couldn't observe: GitHub answered about a different commit");
    const runsTotal = Number(runs.data.total_count ?? list.length);
    const statusesTotal = Number(status.data.total_count ?? statuses.length);
    observed = {
      commit_sha: sha,
      // Every run GitHub reports (the latest attempt of each), in-progress ones as such: status not "completed",
      // conclusion null. Never "passed".
      check_runs: list.map((r: any) => ({ name: String(r?.name ?? ""), app: r?.app?.slug ?? null, status: String(r?.status ?? ""), conclusion: r?.conclusion ?? null, completed_at: r?.completed_at ?? null })),
      check_runs_total: runsTotal,
      ...(runsTotal > list.length ? { check_runs_truncated: true } : {}),
      // Statuses can be posted by anyone who can write to the repository: `creator` says who did (fresh read #7).
      statuses: statuses.map((s: any) => ({ context: String(s?.context ?? ""), state: String(s?.state ?? ""), creator: s?.creator?.login ?? null, updated_at: s?.updated_at ?? null })),
      statuses_total: statusesTotal,
      ...(statusesTotal > statuses.length ? { statuses_truncated: true } : {}),
      // GitHub reports "pending" when a commit has no statuses at all; statuses_total says which.
      combined_status: status.data.state ?? null,
      ...where,
    };
  }
  const observed_at = new Date(now()).toISOString(); // after the last answer (fresh read #3)
  const value = { ok: true as const, repo: named, observed: { ...observed, observed_at, source: "api.github.com" } };
  cache.delete(key);
  cache.set(key, { at: now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return structuredClone(value);
}

/** The signed payload (spec §4). `claimed` and `observed` are always separate, and `limits` travels with it. */
export function proofPayload(input: { request: ProofRequest; member: string; id: string; issuedAt: string; observation?: { repo: string; observed: Record<string, unknown> } }) {
  const r = input.request;
  const common = { receipt_format: PROOF_FORMAT, type: "proof", service: "Agent Referee", receipt_id: input.id, level: r.level, check: r.check };
  // The member name arrives in a header next to the one team token, so it's declared, not verified (fresh read #2).
  const tail = { issued_at: input.issuedAt, caller: { member: input.member, verified: false }, funding: "team", price_micro: 0 };
  if (r.level === "L0") return { ...common, subject: { sha256: r.sha256 }, claimed: { text: r.claim }, note: L0_NOTE, limits: LIMITS.L0, ...tail };
  return { ...common, subject: { repo: input.observation!.repo, sha: r.sha }, observed: input.observation!.observed, limits: LIMITS.L1, ...tail };
}
