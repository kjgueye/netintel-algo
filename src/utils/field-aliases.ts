// Return the first present (non-null/undefined) value among a list of accepted
// field names, from a request body or query object. Lets endpoints tolerate the
// common synonyms agents send for a parameter instead of hard-400ing — the same
// pattern as translate-fields, generalized. Canonical name should be listed first.
export function pickField(obj: unknown, keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
  }
  return undefined;
}

// Resolve a request parameter to a non-empty trimmed string, tolerating
// synonyms and accepting the value from the query string OR a JSON body
// (query wins). Agents routinely send GET params as a body, or under the
// value's type name (`ip`, `domain`) instead of the documented key — both
// showed up as paid-intent 400 clusters in production. Returns undefined for
// missing/array/empty values so each endpoint's 400 guard still fires.
export function pickRequestParam(
  req: { query?: unknown; body?: unknown },
  keys: string[],
): string | undefined {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const query = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
  const v = pickField({ ...body, ...query }, keys);
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed !== "" ? trimmed : undefined;
}

// The synonyms agents send for an IP-address parameter, shared by the ip-*
// family (canonical `ip`). asn-lookup accepts domains too, so it fronts this
// list with its own domain-ish names.
export const IP_ALIASES = ["ip", "target", "ip_address", "ipAddress", "address", "host", "query", "q"];
