// Failure-reason derivation — turns the error response a route already produced
// (status + JSON body) into a small, queryable {code, message, field, source}
// shape. The paid-call logger sets this on res.locals.errorDetail via a central,
// exception-safe res.json interceptor; buildMeta folds it into
// paid_call_failures.meta so "WHY does /X fail" becomes a GROUP BY.
//
// Pure module, no I/O. Captures the REASON, never request/response bodies. The
// message mirrors exactly what was already returned to the caller (capped), so it
// is no more sensitive than the response itself.

export interface ErrorDetail {
  /** Stable, machine-groupable code (route-supplied body.code, or derived). */
  code: string;
  /** Human-readable reason, capped — the same string returned to the caller. */
  message?: string;
  /** The offending field for validation failures, when derivable. */
  field?: string;
  /** Normalized origin: validation | upstream | internal | settlement. */
  source: ErrorSource;
}

export type ErrorSource = "validation" | "upstream" | "internal" | "settlement";

const MESSAGE_CAP = 200;

// Known machine codes → normalized origin. Route-supplied codes are preserved as
// error_code; this only normalizes their source. INTERNAL_ERROR is mapped to
// `upstream` because the codebase pairs it with 502 (a model/upstream failure),
// not a 500.
const CODE_SOURCE: Record<string, ErrorSource> = {
  VALIDATION_ERROR: "validation",
  MISSING_FIELD: "validation",
  INPUT_TOO_LARGE: "validation",
  SCHEMA_TOO_LARGE: "validation",
  UNPROCESSABLE_OUTPUT: "upstream",
  TRUNCATED_OUTPUT: "upstream",
  INTERNAL_ERROR: "upstream",
  UPSTREAM_ERROR: "upstream",
  UPSTREAM_UNAVAILABLE: "upstream",
  UPSTREAM_TIMEOUT: "upstream",
  SETTLEMENT_FAILED: "settlement",
  VERIFICATION_FAILED: "settlement",
  UNHANDLED_ERROR: "internal",
};

/** Default code when a route returned no machine code of its own. */
function codeFromStatus(status: number, isMissingField: boolean): string {
  if (status === 402) return "SETTLEMENT_FAILED";
  if (status === 400) return isMissingField ? "MISSING_FIELD" : "VALIDATION_ERROR";
  if (status === 422) return "UNPROCESSABLE_OUTPUT";
  if (status === 503) return "UPSTREAM_UNAVAILABLE";
  if (status === 504) return "UPSTREAM_TIMEOUT";
  if (status === 500) return "UNHANDLED_ERROR";
  if (status >= 500) return "UPSTREAM_ERROR"; // 502 and other 5xx
  return "VALIDATION_ERROR"; // any other 4xx is client-side
}

/** Normalized origin from a code (preferred) or the status as a fallback. */
export function sourceFor(code: string, status: number): ErrorSource {
  if (code in CODE_SOURCE) return CODE_SOURCE[code];
  if (status === 402) return "settlement";
  if (status === 500) return "internal";
  if (status >= 500) return "upstream"; // 502/503/504
  if (status === 422) return "upstream"; // model ran but output didn't conform
  return "validation"; // 400 and other 4xx
}

function extractMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const err = (body as { error?: unknown }).error;
  let msg: string | undefined;
  if (typeof err === "string") msg = err;
  else if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    msg = (err as { message: string }).message;
  }
  // The x402 middleware reports settlement failures as
  // { error: "Settlement failed", details: <facilitator reason> } — the reason
  // lives in `details`, so fold it in; a bare "Settlement failed" groups every
  // distinct facilitator rejection into one useless bucket.
  const details = (body as { details?: unknown }).details;
  if (typeof details === "string" && details.length > 0 && details !== msg) {
    msg = msg !== undefined ? `${msg}: ${details}` : details;
  }
  if (msg === undefined) return undefined;
  return msg.length > MESSAGE_CAP ? msg.slice(0, MESSAGE_CAP) : msg;
}

function extractCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

// Conservative field extraction from the dominant validation message shapes.
// Returns the field name, or undefined when no pattern matches. The required
// pattern is prefix-anchored only: the house 400 style appends an instructive
// clause ("text is required — pass ..."), which must still yield the field.
const REQUIRED_RE = /^([A-Za-z_][\w-]*) is required\b/;
const MISSING_PARAM_RE = /^Missing required parameter:\s*([A-Za-z_][\w-]*)/;

export function deriveField(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const m = REQUIRED_RE.exec(message) ?? MISSING_PARAM_RE.exec(message);
  return m ? m[1] : undefined;
}

/**
 * Derive the failure detail from the response status and the JSON body the route
 * produced. Never throws on malformed input — callers still treat it as
 * best-effort, but defensiveness here keeps the interceptor's passthrough simple.
 */
export function deriveErrorDetail(status: number, body: unknown): ErrorDetail {
  const message = extractMessage(body);
  const field = deriveField(message);
  const code = extractCode(body) ?? codeFromStatus(status, field !== undefined);
  const source = sourceFor(code, status);
  return { code, ...(message !== undefined ? { message } : {}), ...(field !== undefined ? { field } : {}), source };
}
