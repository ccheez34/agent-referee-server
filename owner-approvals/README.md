# Owner approvals ("one place to say yes")

A small Cloudflare Worker, separate from Agent Referee, with its own Ed25519 key and the owner's own token. The owner approves one exact action for a limited time from his phone. Every gate, used by sessions from any AI company, checks the signed record against the pinned public key.

- **Design:** `research\specs\rules-in-code-2026-10-31\DESIGN.md`, part A.
- **The record format:** `research\specs\rules-in-code-2026-10-31\APPROVALS-FORMAT.md`, v1.
- **Tests:** `test/approvals.test.ts`.

**Nothing here is deployed.** Deploying it, and setting its secrets, is the owner's: installing a server is on his owner-only list.

## What it does
- `GET /`: the form (no outside scripts; the token is never stored).
- `POST /approve`: needs the owner's token. It signs `{record_format: "owner-approval-v1", approval_id, action, target, target_ref, uses, policy_version, issued_at, expires_at, nonce, note?}`.
- `POST /revoke`: needs the owner's token. It signs `{record_format: "owner-revocation-v1", revokes_nonce, issued_at, nonce}`.
- `POST /policy`: needs the owner's token. It sets the sha256 of the RULES.md in force; approvals carry it.
- `GET /approvals`: needs the read token when one is set. It lists the records.
- `GET /pubkey`: open to anyone.

## Setup (for the owner, when he says yes)
1. `node owner-approvals/scripts/gen-keys.mjs`. Put the printed public key into `owner-approvals/wrangler.jsonc` as `APPROVALS_PUBLIC_KEY`.
2. In `owner-approvals`, run each of these and paste the value when asked:
   - `npx wrangler secret put APPROVALS_SIGNING_KEY` (the key file's contents; then delete the file)
   - `npx wrangler secret put OWNER_TOKEN` (32 or more random characters, kept only by him)
   - `npx wrangler secret put READ_TOKEN` (another one, which the sessions' gates get)
3. `npx wrangler deploy`, from `owner-approvals`.
4. Open the page and set the rules version: the sha256 of RULES.md.

The owner token is never typed on the PC where sessions run, and never pasted in a chat.
