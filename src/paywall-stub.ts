// Stands in for "x402/paywall" in the Worker bundle (wrangler "alias"), so x402's prebuilt browser
// paywall page, which carries third-party wallet code, is neither bundled nor served.
// Agents pay with the X-PAYMENT header as before; a browser without a payment gets this short page.
export function getPaywallHtml(_opts: unknown): string {
  return '<!doctype html><meta charset="utf-8"><title>Payment required</title>' +
    '<p>This endpoint is paid per call by AI agents with the x402 protocol (USDC). ' +
    'There is no browser checkout. See the API documentation for how an agent pays.</p>';
}
