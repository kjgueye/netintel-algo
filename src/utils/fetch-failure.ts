// Turn a connection-level fetch failure into something the caller can act on.
//
// Node's fetch reports every transport failure as the same opaque
// `TypeError: fetch failed`. The real reason lives one level down, on
// `err.cause` — and until 2026-09-23 /web/extract surfaced only the outer
// message, so a caller got:
//
//   {"error":"Upstream fetch failed: fetch failed"}
//
// Production, 2026-09-23 06:01: a recurring macro-research agent fetched
// worldgovernmentbonds.com, whose TLS certificate expired 2024-10-28 — 694 days
// earlier. Node handed us `cause.code = "CERT_HAS_EXPIRED"` and
// `cause.message = "certificate has expired"`; we threw both away. From the
// caller's side an expired certificate, a DNS failure and our own service being
// broken are indistinguishable, and the natural reading of "fetch failed" is
// that the fault is ours.
//
// Same defect class as the facilitator's "invalid_payload" message
// (see mirror-402-body.ts): an unhelpful upstream string passed straight to the
// payer. The fix is the same — say what actually happened and who can fix it.
//
// `code` stays UPSTREAM_ERROR for every case so existing clients that branch on
// it are unaffected; the specific machine-readable value is ADDED as `reason`.

export type FetchFailure = {
  /** Unchanged from before this helper existed — do not repurpose. */
  code: "UPSTREAM_ERROR";
  /** Node/undici's own cause code, e.g. CERT_HAS_EXPIRED. Additive field. */
  reason: string;
  /** One sentence the caller can act on, always ending in the billing fact. */
  error: string;
};

const NOT_CHARGED = "You were not charged.";

/** cause.code → what a caller needs to know. Keep each to one actionable line. */
const REASONS: Record<string, string> = {
  CERT_HAS_EXPIRED:
    "the source's TLS certificate has EXPIRED, so the connection was refused before any request was sent. " +
    "This is a fault on the source's side that only they can fix; every HTTPS client rejects it, not just us.",
  CERT_NOT_YET_VALID:
    "the source's TLS certificate is not valid yet (its start date is in the future), so the connection was refused.",
  ERR_TLS_CERT_ALTNAME_INVALID:
    "the source's TLS certificate does not cover the hostname requested, so the connection was refused.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    "the source's TLS certificate chain could not be verified (an intermediate certificate is missing or untrusted).",
  DEPTH_ZERO_SELF_SIGNED_CERT:
    "the source presents a self-signed TLS certificate, which cannot be verified.",
  SELF_SIGNED_CERT_IN_CHAIN:
    "the source's TLS certificate chain contains a self-signed certificate, which cannot be verified.",
  ENOTFOUND: "the hostname does not resolve in DNS — check the spelling, or the domain no longer exists.",
  EAI_AGAIN: "the hostname could not be resolved right now (temporary DNS failure). Retrying later may work.",
  ECONNREFUSED: "the source refused the connection — nothing is listening on that host and port.",
  ECONNRESET: "the source closed the connection mid-request. Retrying later may work.",
  EHOSTUNREACH: "the source's host is unreachable from the public internet.",
  ENETUNREACH: "the source's network is unreachable from the public internet.",
  ETIMEDOUT: "the source did not answer in time. Retrying later may work.",
  EPROTO: "the TLS handshake with the source failed (protocol or cipher mismatch).",
  UND_ERR_CONNECT_TIMEOUT: "the connection to the source timed out before it answered. Retrying later may work.",
  UND_ERR_SOCKET: "the connection to the source was lost. Retrying later may work.",
};

/**
 * Describe a thrown fetch error for a paid caller.
 *
 * Only for TRANSPORT failures — a source that answers with an HTTP status has
 * not failed here and belongs to source-usability.ts instead.
 */
export function describeFetchFailure(err: unknown): FetchFailure {
  const cause =
    err instanceof Error && "cause" in err
      ? (err as { cause?: { code?: unknown; message?: unknown } }).cause
      : undefined;

  const rawCode = typeof cause?.code === "string" ? cause.code : "";
  const causeMessage = typeof cause?.message === "string" ? cause.message : "";
  const outer = err instanceof Error ? err.message : String(err);

  const explained = rawCode ? REASONS[rawCode] : undefined;
  if (explained) {
    return { code: "UPSTREAM_ERROR", reason: rawCode, error: `Could not reach the source: ${explained} ${NOT_CHARGED}` };
  }

  // Unmapped but we still have the cause — never fall back to "fetch failed",
  // which is the string that made this helper necessary.
  const detail = causeMessage || (outer && outer !== "fetch failed" ? outer : "");
  return {
    code: "UPSTREAM_ERROR",
    reason: rawCode || "UNKNOWN",
    error: detail
      ? `Could not reach the source: ${detail}. ${NOT_CHARGED}`
      : `Could not reach the source: the connection failed before any response was received. ${NOT_CHARGED}`,
  };
}
