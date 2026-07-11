// Miss-logger — a TERMINAL 404 handler that doubles as a product-discovery feed.
// Ported from NetIntel src/miss-log.ts.
//
// Registered AFTER every route, so it only runs when nothing matched: an agent
// asked for a capability we don't offer. We record what they wanted (path +
// query + whether they could pay) and answer with a machine-readable 404 that
// points them at the discovery manifest, so a well-behaved agent can self-
// correct instead of silently giving up.
//
// AVM delta: the request payment payload is opaque msgpack, so payer_wallet is
// always "" — `had_payment` (header presence) still carries the intent signal.
// Writing is fire-and-forget with errors swallowed — a logging hiccup must
// never change the 404 the caller receives.

import type { Request, Response, NextFunction } from "express";
import { type MissEvent, type MissStore, createMissStore } from "./miss-log-store.js";

/** Raw query string for a request ("" when there is none), without the "?". */
function rawQuery(req: Request): string {
  const i = req.originalUrl.indexOf("?");
  return i >= 0 ? req.originalUrl.slice(i + 1) : "";
}

/**
 * Build a miss event for an unmatched request. Pure (clock injected) so it is
 * easy to unit-test. `status` is the code we are about to return (404).
 */
export function buildMissEvent(req: Request, status: number, nowMs: number): MissEvent {
  const hadPayment = !!req.header("x-payment") || !!req.header("payment-signature");
  return {
    timestamp: new Date(nowMs).toISOString(),
    method: req.method,
    path: req.path,
    query: rawQuery(req),
    reason: "unknown_route",
    status_code: status,
    had_payment: hadPayment,
    payer_wallet: "", // AVM payload is not decodable client-side
    payer_ip: req.ip ?? "",
    client_ua: req.header("user-agent") ?? "",
    referer: req.header("referer") ?? req.header("referrer") ?? "",
    // Declared size only — the body itself is never read or stored.
    body_bytes: Number(req.header("content-length") ?? "") || 0,
    content_type: req.header("content-type") ?? "",
  };
}

export interface MissLoggerOptions {
  store?: MissStore;
  /** Override the write sink (used by tests). Defaults to store.write. */
  writeMiss?: (event: MissEvent) => Promise<void>;
  now?: () => number;
}

export function createMissLogger(opts: MissLoggerOptions = {}) {
  const store = opts.store ?? createMissStore();
  const writeMiss = opts.writeMiss ?? ((e: MissEvent) => store.write(e));
  const now = opts.now ?? Date.now;

  return function missLogger(req: Request, res: Response, _next: NextFunction): void {
    const status = 404;

    // Record the miss (fire-and-forget; never block or break the response).
    let event: MissEvent | null = null;
    try {
      event = buildMissEvent(req, status, now());
    } catch (err) {
      console.error("[miss-log] failed to build event:", err);
    }
    if (event) {
      Promise.resolve()
        .then(() => writeMiss(event as MissEvent))
        .catch((err) => console.error("[miss-log] write failed (swallowed):", err));
    }

    // Answer with a machine-readable 404 that helps a good agent self-correct.
    res.status(status).json({
      error: "Not found",
      path: req.path,
      hint: "No such endpoint. See /.well-known/x402 for the catalog of available services.",
    });
  };
}
