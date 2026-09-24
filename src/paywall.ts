/**
 * paywall.ts — the human-facing 402 page (Algorand-specific, like config.ts,
 * accepts.ts and index.ts; everything else is synced from NetIntel).
 *
 * Agents never see this: they get the JSON body / PAYMENT-REQUIRED header. It
 * is served only when the SDK decides the caller is a web browser. The SDK's
 * built-in page rounds the price to two decimals, so a $0.002 route reads
 * "$0.00 USDC" — wrong enough to undermine the whole pitch. This renders the
 * exact price plus the pointers a human needs: the JSON challenge, the catalog,
 * and the Bazaar row. Returned by the SDK verbatim via routeConfig.customPaywallHtml.
 */
import { config } from "./config.js";

interface PaywallAccept {
  price?: unknown;
  amount?: string;
  asset?: string;
  payTo?: string;
  network?: string;
  priceDisplay?: string;
  extra?: Record<string, string>;
}

interface PaywallRoute {
  accepts: PaywallAccept | PaywallAccept[];
  description?: string;
}

const NETWORK_LABEL: Record<string, string> = {
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": "Algorand MainNet",
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=": "Algorand TestNet",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The exact price, never rounded: "$0.002 USDC"; a DynamicPrice route shows its display range. */
export function priceLabel(a: PaywallAccept): string {
  if (typeof a.price === "string") return `${a.price} USDC`;
  if (a.priceDisplay) return `${a.priceDisplay} USDC`;
  return "varies per request (see the JSON challenge)";
}

export function renderPaywall(routeKey: string, route: PaywallRoute, baseUrl: string): string {
  const [method, path] = routeKey.split(" ");
  const a = (Array.isArray(route.accepts) ? route.accepts[0] : route.accepts) ?? {};
  const url = `${baseUrl}${path}`;
  const network = a.network ?? config.network;
  const netLabel = NETWORK_LABEL[network] ?? network;
  const rows: Array<[string, string]> = [
    ["Price", priceLabel(a)],
    ["Network", `${netLabel} (${network})`],
    ["Asset", a.asset ? `USDC, ASA ${a.asset}` : "USDC"],
    ["Pay to", a.payTo ?? config.payTo],
    ["Scheme", "x402 v2 · exact"],
  ];
  if (a.extra?.tag) rows.push(["Tag", a.extra.tag]);
  const table = rows
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td><code>${escapeHtml(v)}</code></td></tr>`)
    .join("");
  const merchantId = Buffer.from(config.payTo).toString("base64").replace(/=+$/, "").slice(0, 32);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>402 Payment Required — ${escapeHtml(method)} ${escapeHtml(path)}</title>
<style>
body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#1a1a1a;background:#fff}
h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:1.75rem 0 .5rem}
code,pre{font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{background:#f4f5f7;padding:12px 14px;border-radius:6px;overflow:auto}
table{border-collapse:collapse;width:100%}th{text-align:left;padding:6px 10px 6px 0;white-space:nowrap;vertical-align:top;font-weight:600}td{padding:6px 0;word-break:break-all}
.muted{color:#555}a{color:#2456d6}
@media (prefers-color-scheme:dark){body{background:#111;color:#e8e8e8}pre{background:#1d1f24}.muted{color:#aaa}a{color:#8ab4ff}}
</style></head><body>
<h1>402 Payment Required</h1>
<p class="muted"><code>${escapeHtml(method)} ${escapeHtml(url)}</code></p>
<p>${escapeHtml(route.description ?? "")}</p>
<table>${table}</table>
<h2>How to pay</h2>
<p>This endpoint is paid per call with <a href="https://x402.org">x402</a>. An x402 client reads the requirements from this response, signs a USDC transfer on ${escapeHtml(netLabel)} (gasless — the <a href="https://facilitator.goplausible.xyz">GoPlausible facilitator</a> sponsors the fee), and retries with the payment header. You are only charged when the call succeeds.</p>
<pre>curl -sS -H "Accept: application/json" "${escapeHtml(url)}"   # the machine-readable challenge</pre>
<h2>Links</h2>
<ul>
<li><a href="${escapeHtml(baseUrl)}/.well-known/x402">Catalog</a> · <a href="${escapeHtml(baseUrl)}/openapi.json">OpenAPI</a> · <a href="${escapeHtml(baseUrl)}/llms.txt">llms.txt</a></li>
<li><a href="https://facilitator.goplausible.xyz/discovery/resources?merchantId=${escapeHtml(merchantId)}&amp;limit=100">This service in the facilitator's Bazaar catalog</a></li>
</ul>
</body></html>`;
}
