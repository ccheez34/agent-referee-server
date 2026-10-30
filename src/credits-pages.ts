// Credit packs: the plain pages a buyer sees (spec v2 §4, §5.3). No scripts at all: each page is sent with a CSP that
// allows none, and forms post only to this service or to Stripe's hosted Checkout. Every page is no-store and
// no-referrer, so a session id or a key never lands in a cache or another site's logs.
import { MICRO_PER_USD } from "./credits-ledger.ts";

export const CREDITS_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'";

/** Headers for every credits page and key-bearing answer. */
export const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } as const;
export const PAGE_HEADERS = { ...NO_STORE, "content-security-policy": CREDITS_CSP, "content-type": "text/html; charset=utf-8" } as const;

const CONTACT = "hello@agentreferee.ai";

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
export const usdFromMicro = (micro: number) => `$${(Math.max(0, micro) / MICRO_PER_USD).toFixed(2)}`;
export const usdFromCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function shell(title: string, body: string, refreshS?: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
${refreshS ? `<meta http-equiv="refresh" content="${refreshS}">` : ""}<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1b1b1f;--bg:#fbfbfa;--muted:#5d5d66;--line:#d9d9de;--accent:#2f5bd3;--warn:#8a5a00;--warnbg:#fff4dc}
@media (prefers-color-scheme:dark){:root{--fg:#ececf0;--bg:#16161a;--muted:#a3a3ad;--line:#33333b;--accent:#8fb0ff;--warn:#ffcf70;--warnbg:#2c2410}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.6rem;margin:0 0 .5rem}h2{font-size:1.15rem;margin:2rem 0 .5rem}
p,li{color:var(--fg)}.muted{color:var(--muted)}ul{padding-left:1.2rem}
.note{background:var(--warnbg);color:var(--warn);border-radius:8px;padding:10px 12px}
form{margin:.5rem 0}button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
input,select{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);max-width:100%}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
pre{background:rgba(127,127,127,.12);padding:12px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
table{border-collapse:collapse}td{padding:4px 12px 4px 0}
</style></head><body><main>
${body}
</main></body></html>`;
}

/** GET /credits: the packs, what credits are and aren't, buy and top-up forms, how to spend, and the claim form. */
export function buyPage(o: { packs: [string, number][]; test: boolean; prices: Record<string, string>; base: string; maxBalanceMicro: number; maxDailyMicro: number }): string {
  const packs = o.packs
    .map(([name, cents]) => `<form method="post" action="/credits/checkout"><input type="hidden" name="pack" value="${esc(name)}"><button type="submit">Buy ${esc(name)}: ${usdFromCents(cents)}</button></form>`)
    .join("\n");
  const options = o.packs.map(([name, cents]) => `<option value="${esc(name)}">${esc(name)}: ${usdFromCents(cents)}</option>`).join("");
  const prices = Object.entries(o.prices)
    .map(([tier, price]) => `<tr><td><code>POST /credits/${esc(tier)}</code></td><td>${esc(price)}</td></tr>`)
    .join("");
  return shell(
    "Agent Referee credits",
    `<h1>Agent Referee credits</h1>
${o.test ? `<p class="note"><strong>Test mode.</strong> No real money moves. Pay with Stripe's test card 4242 4242 4242 4242, any future date and any CVC.</p>` : ""}
<p>Prepaid credits for Agent Referee's sealed reviews, bought by card through Stripe. Your agent spends them with a credits key, instead of paying for each review in USDC.</p>
<ul>
<li>$1 buys $1 of credits at list price. No bonus credits, no fees, and credits don't expire.</li>
<li>Credits are spent only on Agent Referee's own services. They can't be withdrawn, cashed out or transferred.</li>
<li>The key is a bearer secret: whoever holds it can spend the balance. Keep it like a password. It's shown once.</li>
<li>A review's price is held while it runs. If the review fails or is refused, nothing is used.</li>
<li>Each account holds at most ${usdFromMicro(o.maxBalanceMicro)} (balance, reviews in progress and open checkouts together) and buys at most ${usdFromMicro(o.maxDailyMicro)} a day.</li>
<li>Questions about a purchase: email ${CONTACT} with your Stripe receipt.</li>
</ul>
<h2>Buy a pack</h2>
${packs || `<p class="muted">No packs are on sale right now.</p>`}
<h2>Top up an account</h2>
<form method="post" action="/credits/checkout"><select name="pack" aria-label="Pack">${options}</select>
<input type="password" name="key" placeholder="arc_… your credits key" autocomplete="off" aria-label="Credits key" required size="34">
<button type="submit">Top up</button></form>
<h2>Spend them</h2>
<p>Send the key as <code>x-credits-key</code> with the same body as the paid routes:</p>
<pre>curl -X POST ${esc(o.base)}/credits/review \\
  -H "x-credits-key: arc_…" -H "content-type: application/json" \\
  -d '{"task": "What the agent was asked to do", "output": "What it produced"}'</pre>
<table>${prices}</table>
<p class="muted">Your balance: <code>GET /credits/account</code> with the same header. Out of credits answers 429 and uses nothing.</p>
<h2>Lost your key?</h2>
<p>Email ${CONTACT} with your Stripe receipt. You'll get a one-time claim code (valid 24 hours) to swap for a new key here:</p>
<form method="post" action="/credits/claim"><input name="code" placeholder="arcc_…" autocomplete="off" aria-label="Claim code" required size="34"> <button type="submit">Get a new key</button></form>`,
  );
}

export type DoneState =
  | { state: "not_found" }
  | { state: "open" }
  | { state: "expired" }
  | { state: "adding" }
  | { state: "held" }
  | { state: "fulfilled"; credits_micro: number; balance_micro: number | null; created_account: boolean; key_available: boolean; session_id: string };

/** GET /credits/done: never says "failed". A payment that went through is either added, being added, or held for a
 * check by hand. */
export function donePage(o: DoneState): string {
  if (o.state === "not_found") return shell("Not found", `<h1>Not found</h1><p>There's no checkout here. <a href="/credits">Buy credits</a>.</p>`);
  if (o.state === "open") return shell("Not paid yet", `<h1>Not paid yet</h1><p>This checkout hasn't been paid. Nothing was charged. If you closed the payment page, <a href="/credits">start again</a>.</p>`);
  if (o.state === "expired") return shell("Checkout expired", `<h1>Checkout expired</h1><p>This checkout expired before it was paid. Nothing was charged. <a href="/credits">Start again</a>.</p>`);
  if (o.state === "adding") return shell("Credits being added", `<h1>Payment received</h1><p>Your credits are being added. This page refreshes every 10 seconds.</p>`, 10);
  if (o.state === "held")
    return shell(
      "Payment received",
      `<h1>Payment received</h1><p>Before the credits are added, this payment is being checked by hand. Nothing is lost. If you haven't heard back within two business days, email ${CONTACT} with your Stripe receipt.</p>`,
    );
  const reveal = o.key_available
    ? `<h2>Your credits key</h2><p>It's shown once, only in the browser you paid from, and never stored in readable form.</p>
<form method="post" action="/credits/done/reveal"><input type="hidden" name="session_id" value="${esc(o.session_id)}"><button type="submit">Reveal my key</button></form>`
    : o.created_account
      ? `<p>Your key has already been shown. If you lost it, email ${CONTACT} with your Stripe receipt.</p>`
      : `<p>Added to your account. Your key stays the same.</p>`;
  return shell(
    "Credits added",
    `<h1>Credits added</h1><p>Added: <strong>${usdFromMicro(o.credits_micro)}</strong>.${o.balance_micro !== null ? ` Balance: <strong>${usdFromMicro(o.balance_micro)}</strong>.` : ""}</p>
${reveal}`,
  );
}

/** The key, once (POST /credits/done/reveal and POST /credits/claim), or why it can't be shown. */
export function keyPage(o: { key: string; balance_micro?: number } | { problem: string }): string {
  if ("problem" in o) return shell("Key not available", `<h1>Key not available</h1><p>${esc(o.problem)}</p><p><a href="/credits">Back to credits</a></p>`);
  return shell(
    "Your credits key",
    `<h1>Your credits key</h1>
<pre>${esc(o.key)}</pre>
<p><strong>Copy it now.</strong> It's shown once and never stored in readable form. Anyone holding it can spend the balance${o.balance_micro !== undefined ? ` (${usdFromMicro(o.balance_micro)})` : ""}.</p>
<p>Send it as the <code>x-credits-key</code> header to <code>POST /credits/review</code> (or review-3, review-3x2, review-3x3). Balance: <code>GET /credits/account</code>.</p>`,
  );
}

/** A plain message page (a form post that was refused). */
export function messagePage(title: string, text: string): string {
  return shell(title, `<h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/credits">Back to credits</a></p>`);
}
