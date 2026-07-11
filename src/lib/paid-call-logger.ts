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
 * Universal, non-PII derived signals: request/response byte sizes (declared
 * Content-Length; bodies are never read), a coarse outcome bucket, and the Host
 * the request arrived on (canonical algo.netintel.dev vs the railway.app
 * fallback). Failures additionally record WHY when a reason is available: the
 * handler's JSON `error` string (stashed by the res.json wrapper below), the
 * settlement errorReason, or the verify rejection reason from the
 * PAYMENT-REQUIRED header. Must never throw on this fire-and-forget path.
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

  try {
    if (status >= 400) {
      // Handler-produced error body (stashed by the res.json wrapper).
      const bodyError = (res as { locals?: { errorMessage?: unknown } }).locals?.errorMessage;
      if (typeof bodyError === "string" && bodyError.length > 0) {
        meta.error_message = bodyError.slice(0, 200);
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
  return meta;
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

    // Minimal failure-reason capture: every handler produces errors via
    // res.status(...).json({ error }). Wrap res.json once to stash the error
    // string for buildMeta. Best-effort — the caller's response is sacred and
    // is always sent unchanged.
    const originalJson = res.json.bind(res);
    res.json = function (body?: unknown) {
      try {
        const err = (body as { error?: unknown } | null | undefined)?.error;
        if (res.statusCode >= 400 && typeof err === "string") {
          (res.locals as Record<string, unknown>).errorMessage = err;
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
