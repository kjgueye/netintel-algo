// Miss-logger — a TERMINAL 404 handler that doubles as a product-discovery feed.
//
// Registered AFTER every route, so it only runs when nothing matched: an agent
// asked for a capability we don't offer. We record what they wanted (path +
// query + whether they could pay) and answer with a machine-readable 404 that
// points them at the discovery manifest, so a well-behaved agent can self-
// correct instead of silently giving up.
//
// It reuses extractPayerFromRequest from the paid-call-logger so payer
// attribution is identical to the revenue/failure paths. Writing is
// fire-and-forget with errors swallowed — a logging hiccup must never change
// the 404 the caller receives.

import type { Request, Response, NextFunction } from "express";
import { type MissEvent, type MissStore, createMissStore } from "./miss-log-store.js";
import { extractPayerFromRequest } from "./paid-call-logger.js";

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
    payer_wallet: extractPayerFromRequest(req) ?? "",
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
  /**
   * Real route paths to fuzzy-match against for a `did_you_mean` suggestion.
   * Agents flatten separators and guess (observed live: GET /wallet_balance and
   * /wallet-balance the day /wallet/balance shipped) — a suggestion turns that
   * permanent failure mode into a one-retry fix.
   */
  knownPaths?: string[];
}

/** Separator-insensitive normal form: /Wallet_Balance/ → wallet/balance. */
function normalizePath(p: string): string {
  return p.toLowerCase().replace(/[-_]/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "").replace(/^\//, "");
}

function editDistance(a: string, b: string): number {
  // Small strings only (paths); classic DP is plenty.
  const m: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
    }
  }
  return m[a.length][b.length];
}

/**
 * Best catalog suggestion for a missed path, or null when nothing is close
 * enough to say with confidence. Exported for direct unit-testing.
 */
export function suggestPath(missed: string, knownPaths: string[]): string | null {
  const target = normalizePath(missed);
  if (!target) return null;
  // 1. Separator-insensitive exact match (/wallet_balance → /wallet/balance).
  for (const known of knownPaths) {
    if (normalizePath(known) === target) return known;
  }
  // 2. Sub-path probe of a real endpoint (/domain/vet/pay → /domain/vet).
  let bestParent: string | null = null;
  for (const known of knownPaths) {
    if (target.startsWith(normalizePath(known) + "/")) {
      if (!bestParent || known.length > bestParent.length) bestParent = known;
    }
  }
  if (bestParent) return bestParent;
  // 3. Small typo (≤2 edits on the normal form, guarded so short paths like
  //    /ip can never "match" an unrelated endpoint).
  if (target.length < 6) return null;
  let best: string | null = null;
  let bestDist = 3;
  for (const known of knownPaths) {
    const d = editDistance(target, normalizePath(known));
    if (d < bestDist) {
      bestDist = d;
      best = known;
    }
  }
  return best;
}

export function createMissLogger(opts: MissLoggerOptions = {}) {
  const store = opts.store ?? createMissStore();
  const writeMiss = opts.writeMiss ?? ((e: MissEvent) => store.write(e));
  const now = opts.now ?? Date.now;
  const knownPaths = opts.knownPaths ?? [];

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
    let didYouMean: string | null = null;
    try {
      didYouMean = suggestPath(req.path, knownPaths);
    } catch {
      // suggestion is best-effort garnish — never let it change the 404
    }
    res.status(status).json({
      error: "Not found",
      path: req.path,
      ...(didYouMean ? { did_you_mean: didYouMean } : {}),
      hint: "No such endpoint. See /.well-known/x402 for the catalog of available services.",
    });
  };
}
