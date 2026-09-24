import type { NextFunction, Request, Response } from "express";

// Mirror the @x402/express v2 payment envelope into empty 402 JSON bodies.
//
// v2.18 moved the payment requirements to the base64 `payment-required`
// response header and sends a literal `{}` body. @x402 SDK clients read the
// header, but plenty of agent stacks (custom fetch wrappers, non-JS x402
// implementations) parse the 402 BODY for `accepts` — they saw `{}` on every
// middleware-paywalled route and bounced (external x402 compat scan,
// 2026-07-19: "28 endpoints keep accepts[] only in the header"; really all of
// them). Decoding the middleware's own envelope into the body keeps one
// source of truth — no drift, both transports served.
// The CDP facilitator reports an on-chain revert at settlement as
// "invalid_payload: contract call failed: unable to call contract: execution
// reverted" — and the middleware passes that string straight to the payer. It
// is actively misleading: the payload was VALID (it passed verification —
// payTo, network, amount, signature all correct); it's the USDC transfer that
// reverted, which in practice means the payer wallet can't cover the amount.
// Observed 2026-09-05: two SDK clients with drained wallets ($0.0006 / $0.00001
// USDC) read "invalid_payload" as "my payment is malformed" and retried blindly
// — 74× and 42× over a week, 0 settled — with no path to "fund the wallet".
export const SETTLEMENT_REVERT_RE = /execution reverted|transfer amount exceeds balance|insufficient (?:funds|balance)/i;

/** Atomic micro-USDC → "$0.060000 USDC", or a neutral phrase when unknown. */
export function formatNeededUsdc(atomicAmount: unknown): string {
  const atomic = Number(atomicAmount);
  if (!Number.isFinite(atomic) || atomic <= 0) return "the listed amount";
  return `$${(atomic / 1e6).toFixed(atomic % 1000 === 0 ? 3 : 6)} USDC`;
}

/**
 * The one wording for "your payment was fine, the on-chain transfer reverted".
 * Used on the verify-stage path (below) and by the settle-stage callback in
 * src/services/gateway-pricing.ts — @x402 2.18 sends an EMPTY body on a settle
 * failure unless a route supplies `settlementFailedResponseBody`, so without
 * that callback a revert reads as the generic transient message.
 */
export function settlementRevertText(need: string): string {
  return (
    "settlement_reverted: your payment payload was VALID (correct payTo, network, amount and signature) " +
    "but the on-chain USDC transfer reverted at settlement, so you were NOT charged. " +
    `The most common cause is an insufficient USDC balance in the payer wallet — this endpoint needs ${need}; ` +
    "check the payer wallet's USDC balance on the listed network and fund it. " +
    "Less commonly the authorization nonce was already used — never re-send the same signed payment; sign a fresh one. " +
    "Retrying without fixing the cause will keep failing."
  );
}

/** The one wording for a transient settlement failure (retrying IS the fix). */
export const SETTLEMENT_FAILED_TEXT =
  "settlement_failed: the payment could not be settled on-chain and you were NOT charged. " +
  "This is usually transient (e.g. several payments from one wallet landing in the same instant) — " +
  "the service is operating normally; retry with a freshly signed payment.";

function clarifySettlementRevert(body: Record<string, unknown>): Record<string, unknown> {
  const err = typeof body.error === "string" ? body.error : "";
  if (!SETTLEMENT_REVERT_RE.test(err)) return body;
  // Quote the exact USDC this endpoint needs, from the envelope's own accepts[]
  // (atomic micro-USDC, 6 decimals) so the payer can compare against a balance.
  const accepts = Array.isArray(body.accepts) ? (body.accepts as Array<Record<string, unknown>>) : [];
  return {
    ...body,
    error: settlementRevertText(formatNeededUsdc(accepts[0]?.amount)),
    facilitator_error: err,
  };
}

export function mirror402Body(_req: Request, res: Response, next: NextFunction): void {
  // Turn an empty 402 body into something a body-reading client can act on:
  // prefer decoding the middleware's own payment-required envelope; when there
  // is NO envelope (observed 2026-07-25: the Solana settlement-failure path
  // emits a bare `{}` with no payment-required header — every Solana settle
  // failure on record went out as 2 unexplained bytes), synthesize an explicit
  // settlement-failed error so the payer learns the service is fine and they
  // were not charged, instead of blaming us for an empty response.
  const fill = (body?: unknown): unknown => {
    if (res.statusCode !== 402) return body;
    const empty =
      body == null ||
      (typeof body === "string" && (body.trim() === "" || body.trim() === "{}")) ||
      (typeof body === "object" && Object.keys(body as object).length === 0);
    if (!empty) {
      // Non-empty 402: pass through, except clarify a facilitator settlement
      // revert (object body, or a JSON-string body via res.send).
      if (typeof body === "object" && body !== null && !Array.isArray(body)) {
        return clarifySettlementRevert(body as Record<string, unknown>);
      }
      if (typeof body === "string" && SETTLEMENT_REVERT_RE.test(body)) {
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            // Only swap to an object when clarification actually changed it.
            // express's res.json stringifies and re-enters res.send, and the
            // clarified body still carries the trigger string in
            // `facilitator_error` — returning a fresh object there would loop
            // json→send→json forever. Same reference = already handled → pass
            // the string through untouched.
            const clarified = clarifySettlementRevert(parsed);
            return clarified === parsed ? body : clarified;
          }
        } catch {
          // not JSON — leave the string alone
        }
      }
      return body;
    }
    const hdr = res.getHeader("payment-required");
    if (typeof hdr === "string" && hdr.length > 0) {
      try {
        return JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
      } catch {
        // malformed header — fall through to the synthesized body
      }
    }
    return { x402Version: 2, error: SETTLEMENT_FAILED_TEXT };
  };
  // The OTHER direction: body → header.
  //
  // `fill` above covers header → body (the middleware's `{}` bodies). But the
  // hand-rolled cold-probe 402 stubs — GET/HEAD on the 54 POST-only paths, which
  // exist so catalog probers see a challenge instead of a 404 — are plain
  // `res.status(402).json(...)` calls that never set the header at all. Nothing
  // in this codebase set `payment-required` except the middleware, so a
  // header-reading client probing one of those paths with the wrong verb got a
  // 402 with no envelope anywhere it looks.
  //
  // That is what x402-list.com's `version_channel_coherent` check reads, and it
  // failed on all 54 while the other 70 passed — the public C grade. Our own
  // `npm run probe:402` could not catch it: it probes each path with the method
  // the manifest declares, so it never takes the mismatched-verb path.
  //
  // Mirror from the body we are about to send, so there is still exactly one
  // source of truth and the two transports cannot drift.
  const mirrorToHeader = (out: unknown): void => {
    if (res.statusCode !== 402 || res.headersSent) return;
    const existing = res.getHeader("payment-required");
    if (typeof existing === "string" && existing.length > 0) return; // middleware already set it
    if (!out || typeof out !== "object" || Array.isArray(out)) return;
    // Only a real challenge gets an envelope. The synthesized settlement-failed
    // body has no accepts[] and must NOT be advertised as payment requirements.
    if (!Array.isArray((out as { accepts?: unknown }).accepts)) return;
    try {
      res.setHeader("payment-required", Buffer.from(JSON.stringify(out), "utf8").toString("base64"));
    } catch {
      // Never let mirroring break the response itself.
    }
  };

  const origJson = res.json.bind(res);
  res.json = (body?: unknown): Response => {
    const out = fill(body);
    mirrorToHeader(out);
    return origJson(out);
  };
  // The settle-failure path may emit via res.send (string body) — cover it too.
  const origSend = res.send.bind(res);
  res.send = (body?: unknown): Response => {
    const out = fill(body);
    // A replaced body is always an object; express serializes it via res.json.
    if (out === body) {
      mirrorToHeader(out);
      return origSend(body as Parameters<typeof origSend>[0]);
    }
    return res.json(out); // re-enters the wrapper above, which mirrors
  };
  next();
}
