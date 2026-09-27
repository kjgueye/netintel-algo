// Paid-call event logger — a passive OBSERVER of the x402 settlement path,
// ported from NetIntel src/paid-call-logger.ts and adapted for x402-avm.
//
// It does NOT change how payment works. It registers before the x402
// paymentMiddleware so it brackets the whole request (including settlement,
// which @x402-avm/express performs AFTER the route handler and before flushing
// the buffered response), then on `res.finish` inspects the settlement header
// the middleware already produced:
//
//   - Response `PAYMENT-RESPONSE` (a.k.a. X-PAYMENT-RESPONSE): base64 JSON
//     SettleResponse { success, payer, transaction, network, errorReason? },
//     set on successful settlement AND on settlement failure.
//
// AVM delta vs the NetIntel/EVM original: the request X-PAYMENT payload is an
// opaque msgpack transaction group, so payer/tx/network come from the
// settlement response header and the price comes from the static `routes` map
// (all route keys are exact "METHOD /path" strings — revisit the lookup if a
// wildcard/param route is ever added).
//
// We log exactly one row per SETTLED paid call (success === true, status < 400)
// to the events store, and one row per FAILED paid attempt (payment header
// present, status >= 400) to the failures store. Free routes, /health,
// discovery paths and un-paid 402 challenges carry no payment header, so they
// are skipped without any route-specific logic.
//
// Writing is fire-and-forget with errors swallowed: a logging failure can never
// break or delay the customer's paid response.

import type { Request, Response, NextFunction } from "express";
import type { PaidCallEvent, PaidCallStore } from "./paid-call-store.js";
import { computeLlmCost, type LlmUsage } from "./llm-cost.js";
import { deriveErrorDetail, type ErrorDetail } from "./error-detail.js";

function safeDecodeBase64Json(value: unknown): any | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Static "METHOD /path" → decimal price map built once from the routes object,
 * e.g. "GET /currency-exchange/convert" → "0.010". The AVM payment payload is
 * not decodable, so the (fixed, per-route) price is the honest source anyway.
 */
export function buildPriceLookup(
  routes: Record<string, { accepts: unknown }>
): Map<string, string> {
  const m = new Map<string, string>();
  for (const [key, cfg] of Object.entries(routes)) {
    const accepts = Array.isArray(cfg.accepts) ? cfg.accepts[0] : cfg.accepts;
    // The SDK's Price type also allows numbers / dynamic objects; every route in
    // this service uses a "$0.010"-style string, but degrade gracefully if not.
    const price = (accepts as { price?: unknown } | undefined)?.price;
    if (typeof price === "string") m.set(key, price.replace(/^\$/, ""));
    else if (typeof price === "number") m.set(key, String(price));
  }
  return m;
}

/**
 * AVM shim for NetIntel's EVM-only helper of the same name.
 *
 * On Base, the payer address is read out of the request's X-PAYMENT header
 * (a signed EIP-3009 authorization whose `from` field is plain JSON). On
 * Algorand the payload is an OPAQUE MSGPACK transaction group, so the payer
 * simply is not recoverable from the request — it is only known after
 * settlement, from the PAYMENT-RESPONSE header (see readSettlement below).
 *
 * This exists so src/routes/ai-image-assets.ts stays a verbatim copy. It always
 * returns null, which means the WALLET_DENYLIST abuse control in
 * src/utils/abuse-controls.ts is INERT on Algorand: isWalletDenied(null) can
 * never match. That is a real gap, not a silent one — do not rely on
 * WALLET_DENYLIST for abuse prevention on this service.
 */
export function extractPayerFromRequest(_req: Request): string | null {
  return null;
}

interface SettlementInfo {
  success: boolean;
  payer: string | null;
  transaction: string | null;
  network: string | null;
  errorReason: string | null;
}

/** Decoded settlement result from the response header, or null if absent/invalid. */
export function readSettlement(res: Response): SettlementInfo | null {
  const raw =
    res.getHeader("PAYMENT-RESPONSE") ?? res.getHeader("X-PAYMENT-RESPONSE");
  const decoded = safeDecodeBase64Json(raw);
  if (!decoded) return null;
  return {
    success: decoded.success === true,
    payer: typeof decoded.payer === "string" ? decoded.payer : null,
    transaction:
      typeof decoded.transaction === "string" && decoded.transaction
        ? decoded.transaction
        : null,
    network: typeof decoded.network === "string" ? decoded.network : null,
    errorReason:
      typeof decoded.errorReason === "string" && decoded.errorReason
        ? decoded.errorReason
        : null,
  };
}

/**
 * Per-call signals, kept at parity with NetIntel's logger so the Mission Control
 * Algo tab can show the same drill-down as the Base/Solana Overview:
 *  - request/response byte sizes, a coarse outcome bucket, the Host;
 *  - LLM usage (model, tokens, cost_usdc) from res.locals.llmUsage;
 *  - failure reason: code/source/field from the res.json wrapper's errorDetail,
 *    else the settlement errorReason, else the PAYMENT-REQUIRED verify reason;
 *  - the request (content-type, query, redacted body, unparsed raw bytes) and
 *    the response body, redacted + size-capped — on success AND failure rows.
 * The payment-payload diagnostics of the EVM original are deliberately absent:
 * the AVM payload is opaque msgpack. Must never throw on this fire-and-forget path.
 */
export function buildMeta(req: Request, res: Response): Record<string, unknown> {
  const status = res.statusCode;
  const outcome =
    status < 400
      ? "ok"
      : status === 402
        ? "settlement_failed"
        : status < 500
          ? "client_error"
          : "upstream_error";
  const meta: Record<string, unknown> = {
    req_bytes: Number(req.header("content-length") ?? "") || 0,
    res_bytes: Number(res.getHeader("content-length") ?? "") || 0,
    outcome,
    host: req.headers?.host,
  };

  // LLM usage — ONE usage or an ARRAY (e.g. ai-image's render + metadata call).
  // The first entry's model/tokens are recorded; cost_usdc is the SUM, and any
  // unpriced entry keeps it absent (a partial cost would read as complete).
  try {
    const rawUsage = (res as { locals?: { llmUsage?: LlmUsage | LlmUsage[] } }).locals?.llmUsage;
    const usages = Array.isArray(rawUsage) ? rawUsage : rawUsage ? [rawUsage] : [];
    const primary = usages[0];
    if (primary && typeof primary.model === "string") {
      meta.model = primary.model;
      meta.input_tokens = primary.inputTokens;
      meta.output_tokens = primary.outputTokens;
      const costs = usages.map((u) => computeLlmCost(u));
      if (costs.every((c): c is string => c !== undefined)) {
        meta.cost_usdc = costs.reduce((sum, c) => sum + Number(c), 0).toFixed(6);
      }
    }
  } catch {
    /* swallow: usage capture must never affect logging */
  }

  try {
    if (status >= 400) {
      // Structured failure detail (stashed by the res.json wrapper); a failure
      // that bypassed res.json still gets a groupable code/source from status.
      let detail = (res as { locals?: { errorDetail?: ErrorDetail } }).locals?.errorDetail;
      if (!detail) detail = deriveErrorDetail(status, undefined);
      meta.error_code = detail.code;
      if (detail.field !== undefined) meta.failed_field = detail.field;
      meta.error_source = detail.source;
      // Handler-produced error body (stashed by the res.json wrapper).
      const bodyError = (res as { locals?: { errorMessage?: unknown } }).locals?.errorMessage;
      if (typeof bodyError === "string" && bodyError.length > 0) {
        meta.error_message = bodyError.slice(0, 200);
      } else if (typeof detail.message === "string" && detail.message.length > 0) {
        meta.error_message = detail.message.slice(0, 200);
      }
      // Settlement failure reason from the PAYMENT-RESPONSE header.
      if (meta.error_message === undefined) {
        const reason = readSettlement(res)?.errorReason;
        if (reason) meta.error_message = reason.slice(0, 200);
      }
      // Verify/challenge rejections carry the requirements (with the
      // facilitator's reason) base64-encoded in the PAYMENT-REQUIRED header.
      if (status === 402 && meta.error_message === undefined) {
        const required = safeDecodeBase64Json(res.getHeader?.("PAYMENT-REQUIRED"));
        const reason = required?.error;
        if (typeof reason === "string" && reason.length > 0) {
          meta.error_message = reason.slice(0, 200);
        }
      }
    }
  } catch {
    /* swallow: meta enrichment must never affect logging */
  }

  // Request + response payload capture (ALL rows). Stores real customer input
  // by design (quality audits read it); secret-looking keys are redacted at
  // every depth and every field is size-capped.
  try {
    const ct = req.header("content-type");
    if (ct) meta.req_content_type = ct;

    const query = captureObject(req.query, 1000);
    if (query !== undefined) meta.req_query = query;

    const body = (req as { body?: unknown }).body;
    const bodyKeys = body && typeof body === "object" ? Object.keys(body as object) : [];
    if (bodyKeys.length) meta.req_body_keys = bodyKeys.slice(0, 40);
    const capturedBody = captureObject(body, BODY_CAP);
    if (capturedBody !== undefined) meta.req_body = capturedBody;

    // Raw bytes that did NOT parse into req.body (Content-Type mismatch).
    const raw = (req as { rawBodySnippet?: string }).rawBodySnippet;
    if (typeof raw === "string" && raw.length > 0 && bodyKeys.length === 0) {
      meta.req_raw_unparsed = truncate(raw, BODY_CAP);
    }

    const respBody = (res as { locals?: { responseBody?: unknown } }).locals?.responseBody;
    if (typeof respBody === "string") {
      if (respBody.length) meta.res_body = truncate(respBody, BODY_CAP);
    } else {
      const capturedResp = captureObject(respBody, BODY_CAP);
      if (capturedResp !== undefined) meta.res_body = capturedResp;
    }
  } catch {
    /* swallow: payload capture must never affect logging */
  }
  return meta;
}

// --- Payload redaction (verbatim from NetIntel src/paid-call-logger.ts) -------

// Max captured size for request/response bodies; query strings stay at 1 KB.
const BODY_CAP = 8000;

// Keys whose values are redacted wherever they appear in captured query/body.
const SENSITIVE_KEY_RE =
  /pass|secret|token|api[-_]?key|authorization|auth|private|mnemonic|seed|credential/i;
// …EXCEPT keys that only LOOK sensitive: boolean verdicts (is_private), token
// COUNTS (max_tokens — plural "tokens" is never a credential) and author(s).
const SAFE_KEY_RE = /^(?:is|has|was)_|^authors?$|(?:^|_)tokens(?:_|$)/i;

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}…[truncated]` : s;
}

/** True for a key whose VALUE must never be stored. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key) && !SAFE_KEY_RE.test(key);
}

const REDACT_MAX_DEPTH = 16;

/** Redact secret-looking keys at EVERY depth — objects and arrays alike. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= REDACT_MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? "[redacted]" : redactDeep(v, depth + 1);
  }
  return out;
}

/** Redact then JSON-stringify with a cap; undefined for empty/non-objects. */
function captureObject(obj: unknown, maxLen: number): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  if (Object.keys(obj as object).length === 0) return undefined;
  try {
    return truncate(JSON.stringify(redactDeep(obj)), maxLen);
  } catch {
    return undefined; // non-serializable (circular, etc.)
  }
}

/**
 * Build the event for a finished request, or null if it was not a successfully
 * settled paid call. Pure (clock injected) so it is easy to unit-test.
 */
export function buildPaidCallEvent(
  req: Request,
  res: Response,
  startMs: number,
  nowMs: number,
  priceLookup: Map<string, string>,
  defaultNetwork: string
): PaidCallEvent | null {
  const settle = readSettlement(res);
  if (!settle || !settle.success) return null; // only settled paid calls
  if (res.statusCode >= 400) return null; // never on error responses

  return {
    timestamp: new Date(nowMs).toISOString(),
    endpoint: req.path,
    method: req.method,
    price_usdc: priceLookup.get(`${req.method} ${req.path}`) ?? "",
    payer_wallet: settle.payer ?? "",
    payer_ip: req.ip ?? "",
    client_ua: req.header("user-agent") ?? "",
    status_code: res.statusCode,
    duration_ms: Math.max(0, nowMs - startMs),
    // No route sets a cache header today; honoured if one ever does.
    cached: String(res.getHeader("x-cache") ?? "").toUpperCase() === "HIT",
    tx_hash: settle.transaction,
    network: settle.network ?? defaultNetwork,
    meta: buildMeta(req, res),
  };
}

/**
 * Build a FAILURE event for a finished request, or null if it should not be
 * recorded. A failure is a paid attempt (a payment header was present on the
 * request) that did NOT succeed (statusCode >= 400) — i.e. settlement was
 * skipped because the handler errored (4xx/5xx) or settlement/verification
 * itself failed (402). Un-paid probes carry no payment header and are skipped.
 *
 * The AVM request payload is not decodable, so payer comes from the settlement
 * header when present (settlement failures still carry it), else "". There is
 * no settlement, so tx_hash is always null.
 */
export function buildFailureEvent(
  req: Request,
  res: Response,
  startMs: number,
  nowMs: number,
  priceLookup: Map<string, string>,
  defaultNetwork: string
): PaidCallEvent | null {
  const paymentAttempted =
    !!req.header("x-payment") || !!req.header("payment-signature");
  if (!paymentAttempted) return null; // not a paid attempt
  if (res.statusCode < 400) return null; // not a failure (success path handles 2xx)

  const settle = readSettlement(res);
  return {
    timestamp: new Date(nowMs).toISOString(),
    endpoint: req.path,
    method: req.method,
    price_usdc: priceLookup.get(`${req.method} ${req.path}`) ?? "",
    payer_wallet: settle?.payer ?? "",
    payer_ip: req.ip ?? "",
    client_ua: req.header("user-agent") ?? "",
    status_code: res.statusCode,
    duration_ms: Math.max(0, nowMs - startMs),
    cached: false,
    tx_hash: null, // no settlement on a failed call
    network: settle?.network ?? defaultNetwork,
    meta: buildMeta(req, res),
  };
}

export interface PaidCallLoggerOptions {
  store: PaidCallStore;
  /** Durable sink for failed paid attempts (separate table/file). */
  failureStore: PaidCallStore;
  /** "METHOD /path" → decimal price map (see buildPriceLookup). */
  priceLookup: Map<string, string>;
  /** CAIP-2 fallback when the settlement header carries no network. */
  network: string;
  now?: () => number;
}

export function createPaidCallLogger(opts: PaidCallLoggerOptions) {
  const { store, failureStore, priceLookup, network } = opts;
  const now = opts.now ?? Date.now;

  return function paidCallLogger(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const start = now();

    // Wrap res.json once to stash the response body (payload capture) and, on
    // >= 400, the error string + derived detail for buildMeta. Best-effort — the
    // caller's response is sacred and is always sent unchanged.
    const originalJson = res.json.bind(res);
    res.json = function (body?: unknown) {
      try {
        (res.locals as Record<string, unknown>).responseBody = body;
        const err = (body as { error?: unknown } | null | undefined)?.error;
        if (res.statusCode >= 400 && typeof err === "string") {
          (res.locals as Record<string, unknown>).errorMessage = err;
        }
        if (res.statusCode >= 400) {
          (res.locals as Record<string, unknown>).errorDetail = deriveErrorDetail(
            res.statusCode,
            body
          );
        }
      } catch {
        /* swallow: capture must never affect the response */
      }
      return originalJson(body as Parameters<typeof originalJson>[0]);
    } as typeof res.json;

    res.on("finish", () => {
      const at = now();
      // Success path: a settled, non-error paid call.
      let event: PaidCallEvent | null = null;
      try {
        event = buildPaidCallEvent(req, res, start, at, priceLookup, network);
      } catch (err) {
        console.error("[paid-call-logger] failed to build event:", err);
      }
      if (event) {
        // Fire-and-forget; never throw into the response path.
        Promise.resolve()
          .then(() => store.write(event as PaidCallEvent))
          .catch((err) =>
            console.error("[paid-call-logger] write failed (swallowed):", err)
          );
        return; // success and failure are mutually exclusive
      }

      // Failure path: a paid attempt that did not settle (>= 400).
      let failure: PaidCallEvent | null = null;
      try {
        failure = buildFailureEvent(req, res, start, at, priceLookup, network);
      } catch (err) {
        console.error("[paid-call-logger] failed to build failure event:", err);
        return;
      }
      if (!failure) return;
      Promise.resolve()
        .then(() => failureStore.write(failure as PaidCallEvent))
        .catch((err) =>
          console.error("[paid-call-logger] failure write failed (swallowed):", err)
        );
    });
    next();
  };
}
