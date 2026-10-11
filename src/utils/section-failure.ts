// One vocabulary for "this section of a composite report could not be
// produced". Until 2026-10-11 both domain reports labelled every failure
// `upstream_error` (/full) or said nothing at all (/analyze), so "no RDAP
// server exists for .nz", "the host does not resolve" and "the registry timed
// out" were indistinguishable to the caller — and to us when auditing.
//
// `error` is a small closed set a client can branch on; `detail` is the short
// human reason (the underlying message, trimmed) for logs and operators.

export type SectionFailureCode =
  | "timeout"
  | "unsupported_tld" // no RDAP/WHOIS service exists for this TLD
  | "not_found" // the registry/upstream has no record of the name
  | "dns_unresolvable" // the host does not resolve (NXDOMAIN/EAI_AGAIN/no A record)
  | "connection_failed" // TCP-level refusal/reset/unreachable
  | "tls_failed" // handshake/certificate problems
  | "blocked" // our SSRF/policy guard refused the target
  | "upstream_http_error" // the upstream answered with a non-2xx status
  | "upstream_error" // some other error from the upstream call
  | "internal_error"; // a non-Error rejection

export interface SectionFailure {
  available: false;
  error: SectionFailureCode;
  detail: string;
}

const MAX_DETAIL = 160;

function trim(msg: string): string {
  const oneLine = msg.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_DETAIL ? `${oneLine.slice(0, MAX_DETAIL)}…` : oneLine;
}

/** Build a failure with a known code (when the caller already knows why). */
export function sectionFailure(error: SectionFailureCode, detail: string): SectionFailure {
  return { available: false, error, detail: trim(detail) };
}

/** Classify a thrown/rejected reason into the closed failure vocabulary. */
export function classifySectionFailure(reason: unknown): SectionFailure {
  if (!(reason instanceof Error)) {
    return sectionFailure("internal_error", reason === undefined ? "unknown failure" : String(reason));
  }
  const code = (reason as NodeJS.ErrnoException).code ?? "";
  const msg = reason.message || reason.name || "error";
  const m = msg.toLowerCase();

  if (reason.name === "TimeoutError" || reason.name === "AbortError" || code === "ETIMEDOUT" || /timed? ?out|deadline|timeout/.test(m)) {
    return sectionFailure("timeout", msg);
  }
  if (/no rdap server|no public rdap|unsupported tld|no whois server/.test(m)) {
    return sectionFailure("unsupported_tld", msg);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /getaddrinfo|enotfound|nxdomain|does not resolve|cannot resolve|could not resolve|unable to resolve/.test(m)) {
    return sectionFailure("dns_unresolvable", msg);
  }
  // Our own guards (validators.checkSsrf / safeFetch): "Target resolves to a
  // private/reserved address", refused schemes, embedded credentials, …
  if (reason.name === "ValidationError" || /ssrf|private\/reserved|private (network|address|ip)|reserved address|blocked|not allowed|disallowed|refused to follow/.test(m)) {
    return sectionFailure("blocked", msg);
  }
  if (/econnrefused|econnreset|ehostunreach|enetunreach|epipe|socket hang up|connection refused|connection reset/.test(`${code} ${m}`.toLowerCase())) {
    return sectionFailure("connection_failed", msg);
  }
  if (/certificate|handshake|tls|ssl|alert |self.signed|cert_/.test(`${code} ${m}`.toLowerCase())) {
    return sectionFailure("tls_failed", msg);
  }
  if (/\b(returned|status|http)\s*[45]\d\d\b|\b[45]\d\d\b.*(response|status)/.test(m)) {
    return sectionFailure("upstream_http_error", msg);
  }
  if (/not found|404/.test(m)) {
    return sectionFailure("not_found", msg);
  }
  return sectionFailure("upstream_error", msg);
}
