# Owner approvals ("one place to say yes")

A small Cloudflare Worker, separate from Agent Referee, with its own Ed25519 key and the owner's own token. The owner approves one exact action for a limited time from his phone. Every gate, used by sessions from any AI company, checks the signed record against the pinned public key.

- **Design:** `research\specs\rules-in-code-2026-10-31\DESIGN.md`, part A.
- **The record format:** exactly the one 3.0's gate checks, `agent-referee-owner-approval-v1` (agent-referee-mcp, branch `gate-v0`, `gate/README.md`). APPROVALS-FORMAT.md v2 points there.
- **Tests:** `test/approvals.test.ts`, with the gate's own shape rules. A one-off run of the gate's real code on these records (2.0, Oct 31, 11:29) accepted them.

**Nothing here is deployed.** Deploying it, and setting its secrets, is the owner's: installing a server is on his owner-only list.

## What it does
- `GET /`: the form (no outside scripts; the token is never stored).
- `POST /approve`: needs the owner's token. It signs `{format: "agent-referee-owner-approval-v1", type: "approval", action, target, target_sha256, policy_version, issued_at, expires_at, nonce, max_uses}`.
  - `action`: one of the gate policy's owner-only actions (deploy, publish, payment, delete, secret, install, rule_change).
  - `target` and `target_sha256` (64 hex, or null) are compared exactly by the gate, so the exact version goes in one of them: for example `agent-referee-server:production@<40-hex commit>`, or a bundle's sha256.
  - `max_uses` 1 to 20; it expires 0.25 to 24 hours after it's made.
- `POST /revoke`: needs the owner's token. It signs `{format, type: "revocation", nonce, issued_at}`, where `nonce` is the approval's. A nonce with no approval on file is refused, so a typo can't look like a revocation.
- `POST /policy`: needs the owner's token. It sets the policy version that approvals carry: the gate policy's `version`.
- `GET /approvals`: open to anyone, as the design says; the signatures are what count. It returns `{"approvals": [...]}`, approvals and revocations in one list, kept 7 days past expiry or issue.
- `GET /pubkey`: open to anyone.

## Setup (for the owner, when he says yes)
1. `node owner-approvals/scripts/gen-keys.mjs`. Put the printed public key into `owner-approvals/wrangler.jsonc` as `APPROVALS_PUBLIC_KEY`.
2. In `owner-approvals`, run each of these and paste the value when asked:
   - `npx wrangler secret put APPROVALS_SIGNING_KEY` (the key file's contents; then delete the file)
   - `npx wrangler secret put OWNER_TOKEN` (32 or more random characters, kept only by him)
3. `npx wrangler deploy`, from `owner-approvals`.
4. Open the page and set the policy version: the gate policy's `version`.

The owner token is never typed on the PC where sessions run, and never pasted in a chat.
