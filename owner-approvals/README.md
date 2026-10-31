# Owner approvals ("one place to say yes")

A small Cloudflare Worker, separate from Agent Referee, with its own Ed25519 key and the owner's own token. The owner approves one exact action for a limited time from his phone. Every gate, used by sessions from any AI company, checks the signed record against the pinned public key.

- **Design:** `research\specs\rules-in-code-2026-10-31\DESIGN.md`, part A.
- **The record format:** exactly the one 3.0's gate checks, `agent-referee-owner-approval-v1` (agent-referee-mcp, branch `gate-v0`, `gate/README.md`). APPROVALS-FORMAT.md v2 points there.
- **Tests:** `test/approvals.test.ts`, with the gate's own shape rules. One-off runs of the gate's real code on these records (2.0, Oct 31) accepted them.

**Nothing here is deployed.** Deploying it, and setting its token, is the owner's: installing a server is on his owner-only list.

## What it does
- `GET /`: the form for his phone. No outside scripts; the token is never stored; answers are shown as text; every button is off while a request is out, and a repeated "Sign" sends the same request id, so a double tap can't make two approvals.
- `POST /approve` (owner's token): signs `{format: "agent-referee-owner-approval-v1", type: "approval", action, target, target_sha256, policy_version, issued_at, expires_at, nonce, max_uses}`.
  - `action`: one of the gate policy's owner-only actions (deploy, publish, payment, delete, secret, install, rule_change).
  - `target` (plain printable characters, at most 200) and `target_sha256` (64 hex, or null) are compared exactly by the gate, so the exact version goes in one of them: for example `agent-referee-server:production@<40-hex commit>`, or a bundle's sha256.
  - `max_uses` 1 to 20; it expires 0.25 to 24 hours after it's made.
  - An optional `request_id`: the same id within a day gives the first approval back, only if every field, the length and the policy version match and it's still live. Otherwise it's refused (409) and nothing is approved.
- `POST /revoke` (owner's token): `{"nonce": ...}` signs `{format, type: "revocation", nonce, issued_at}`, where `nonce` is the approval's. A nonce with no approval on file is refused, so a typo can't look like a revocation. `{"all": true}` revokes every live approval, in one step: an approval made at the same moment lands wholly before it (revoked) or after it (live). In an emergency, freeze first.
- `POST /freeze` (owner's token): `{"on": true}` makes `GET /approvals` answer 503, so every gate refuses every owner-only step until `{"on": false}`. Revoking still works while frozen; approving doesn't.
- `POST /status` (owner's token): the live approvals, the policy version and whether it's frozen. The page's "Show them" uses it.
- `POST /policy` (owner's token): the policy version that approvals carry: the gate policy's `version`.
- `GET /approvals`: open to anyone, as the design says; the signatures are what count. It returns `{"approvals": [...]}`, approvals and revocations in one list. Approvals are kept 7 days past expiry, revocations 8 days past issue, so a revocation always outlives its approval.
- `GET /pubkey`: open to anyone. The key is made inside the Worker's own store the first time it's needed, so the private key exists nowhere else, and the key records are signed with can't drift from the one served.
- **The store builds and signs every record itself,** in one step each, with its own clock and nonce: approvals only within the limits, under the current policy version and never while frozen. It signs nothing it's handed. The private key never leaves the store. Code deployed with the store's binding can still ask it for an approval within those limits, so deploying is the trust boundary (Setup, step 1).
- There's no lockout on wrong tokens: a token of 32 or more random characters can't be guessed, and a lockout would let anyone stop the owner from revoking.

## Setup (for the owner, when he says yes)
1. **Deploy it from a Cloudflare account that sessions can't use.** Whoever can deploy this Worker can change its code and make approvals. The safest is a separate Cloudflare account that is never logged in on the PC where sessions run (or log out of it right after the deploy). From this folder: `npx wrangler deploy`.
2. **Set the token from your phone,** never on the PC: Cloudflare dashboard, Workers, `owner-approvals`, Settings, Variables and Secrets, Add, type Secret, name `OWNER_TOKEN`, value 32 or more random characters from your password manager.
3. **Open the page on your phone** (bookmark it, and only type the token there). Set the policy version: the gate policy's `version`.
4. **Pin the key:** open `/pubkey` on your phone and put its `public_key` in the gate policy's `approval_keys` (the policy file is yours).

## Limits to know
- **The list is public.** Anyone can see the targets and times of the last week's approvals. Don't put secrets in a target.
- **Request limits:** on Cloudflare's Free plan an account gets 100,000 Worker requests a day. A flood of requests could stop this Worker until midnight UTC. Gates then fail closed, so nothing opens, but you couldn't approve or revoke. The Paid plan, or a rate-limiting rule on `/approvals`, avoids that.
- **Uses are counted by each gate**, in its own state folder. Run one gate state folder for all sessions (part D), or a 1-use approval can be used once per folder.
- **Phishing:** a captured token works until you change it, so only type it on this Worker's own address. A passkey login is a later version.
