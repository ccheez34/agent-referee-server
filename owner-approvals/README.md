# Owner approvals ("one place to say yes")

A small Cloudflare Worker, separate from Agent Referee, with its own Ed25519 key and the owner's own token. The owner approves one exact action for a limited time from his phone. Every gate, used by sessions from any AI company, checks the signed record against the pinned public key.

- **Design:** `research\specs\rules-in-code-2026-10-31\DESIGN.md`, part A.
- **The record format:** exactly the one 3.0's gate checks, `agent-referee-owner-approval-v2` (agent-referee-mcp 0.6.0, `gate/README.md`, "The approval record part A must produce"): each approval names the seat it's for and is used once. APPROVALS-FORMAT.md points there.
- **Tests:** `test/approvals.test.ts`, with the gate's own shape rules (copied from 0.6.0). A one-off run of the published gate's own code (0.6.0, `gate/src/approvals.mjs`) on these records (2.0, Nov 3) verified every one and refused another seat, a revoked one, another target hash, another policy version and an unpinned key.

**Nothing here is deployed.** Deploying it, and setting its token, is the owner's: installing a server is on his owner-only list.

## What it does
- `GET /`: the form for his phone. No outside scripts; the token is never stored; answers are shown as text; every button is off while a request is out, and a repeated "Sign" sends the same request id, so a double tap can't make two approvals.
- `POST /approve` (owner's token): signs `{format: "agent-referee-owner-approval-v2", type: "approval", member, action, target, target_sha256, policy_version, issued_at, expires_at, nonce, max_uses: 1}`.
  - `member`: the seat it's for, one of the policy's `members` (the gate of another seat refuses it).
  - `action`: one of the policy's owner-only actions (by default the seven every gate keeps, plus tag, rollback and feature_on).
  - `target` (plain printable characters, at most 200) and `target_sha256` (64 hex, or null) are compared exactly by the gate, so the exact version goes in one of them: for example `agent-referee-server:production@<40-hex commit>`, or a bundle's sha256.
  - An approval is used once. `count` 1 to 20 signs that many, each with its own nonce (a standing "deploy staging at most 3 times" is count 3). It expires 0.25 hours to the policy's `approval_max_hours` (at most 24) after it's made.
  - An optional `request_id`: the same id within a day gives the first approvals back, only if every field, the seat, the count, the length and the policy version match and they're still live. Otherwise it's refused (409) and nothing is approved.
- `POST /revoke` (owner's token): `{"nonce": ...}` signs `{format, type: "revocation", nonce, issued_at}` (no seat), where `nonce` is the approval's. A nonce with no approval on file is refused, so a typo can't look like a revocation. `{"all": true}` revokes every live approval, in one step: an approval made at the same moment lands wholly before it (revoked) or after it (live). In an emergency, freeze first.
- `POST /freeze` (owner's token): `{"on": true}` makes `GET /approvals` answer 503, so every gate refuses every owner-only step until `{"on": false}`. Revoking still works while frozen; approving doesn't.
- `POST /status` (owner's token): the live approvals, the policy and whether it's frozen. The page's "Show them" uses it, and fills the seats and actions from the policy.
- `POST /policy` (owner's token): `{version, members, actions?, approval_max_hours?}`, copied from the gate policy: its `version` (approvals carry it), every seat, its owner-only actions (they must include the seven baseline ones; left out: the ten usual ones) and its `approval_max_hours` (1 to 24; left out: 24). Nothing is approved before it's set.
- `GET /approvals`: open to anyone, as the design says; the signatures are what count. It returns `{"approvals": [...]}`, approvals and revocations in one list. Approvals are kept 7 days past expiry, revocations 8 days past issue, so a revocation always outlives its approval.
- `GET /pubkey`: open to anyone. The key is made inside the Worker's own store the first time it's needed, so the private key exists nowhere else, and the key records are signed with can't drift from the one served.
- **The store builds and signs every record itself,** in one step each, with its own clock and nonce: approvals only within the limits, under the current policy version and never while frozen. It signs nothing it's handed. The private key never leaves the store. Code deployed with the store's binding can still ask it for an approval within those limits, so deploying is the trust boundary (Setup, step 1).
- There's no lockout on wrong tokens: a token of 32 or more random characters can't be guessed, and a lockout would let anyone stop the owner from revoking.

## Setup (for the owner, when he says yes)
1. **Deploy it from a Cloudflare account that sessions can't use.** Whoever can deploy this Worker can change its code and make approvals. The safest is a separate Cloudflare account that is never logged in on the PC where sessions run (or log out of it right after the deploy). From this folder: `npx wrangler deploy`.
2. **Set the token from your phone,** never on the PC: Cloudflare dashboard, Workers, `owner-approvals`, Settings, Variables and Secrets, Add, type Secret, name `OWNER_TOKEN`, value 32 or more random characters from your password manager.
3. **Open the page on your phone** (bookmark it, and only type the token there). Under Policy, copy from the gate policy file its `version`, its `members` (1.0, 2.0, 3.0, 4.0, 5.0), and, if they differ from the usual, its owner-only actions and `approval_max_hours`.
4. **Pin the key:** open `/pubkey` on your phone and put its `public_key` in the gate policy's `approval_keys` (the policy file is yours).

## Limits to know
- **The list is public.** Anyone can see the targets and times of the last week's approvals. Don't put secrets in a target.
- **Request limits:** on Cloudflare's Free plan an account gets 100,000 Worker requests a day. A flood of requests could stop this Worker until midnight UTC. Gates then fail closed, so nothing opens, but you couldn't approve or revoke. The Paid plan, or a rate-limiting rule on `/approvals`, avoids that.
- **Uses are counted by each gate**, in its own state folder. Run one gate state folder for all sessions (part D), or a 1-use approval can be used once per folder.
- **Phishing:** a captured token works until you change it, so only type it on this Worker's own address. A passkey login is a later version.
