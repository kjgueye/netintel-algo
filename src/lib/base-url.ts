/**
 * Resolve the base URL that discovery artifacts (llms.txt, openapi.json,
 * /.well-known/x402, agent-card.json, the landing page) should ADVERTISE.
 *
 * Precedence:
 *   1. PUBLIC_BASE_URL (the canonical custom domain) — when set, every artifact
 *      advertises this host regardless of which hostname the request arrived on.
 *   2. The request's own scheme + Host header — the fallback, so the app keeps
 *      working on ANY hostname (the railway.app URL, the custom domain, or
 *      localhost) with zero configuration.
 *
 * This is purely about what URLs are *advertised*. It never affects which host
 * the app *responds* on — requests on any Host are served identically.
 */
export function resolveBaseUrl(
  publicBaseUrl: string | undefined,
  protocol: string,
  host: string | undefined
): string {
  const canonical = (publicBaseUrl || "").trim().replace(/\/+$/, "");
  if (canonical) return canonical;
  return `${protocol}://${host ?? ""}`;
}
