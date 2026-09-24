import type { Request } from "express";

// THE payment-header aliases, in one place.
//
// x402 clients send the signed payload as `X-PAYMENT`; @x402/express also
// accepts `PAYMENT-SIGNATURE`, and both are in the wild against this service.
// Five call sites used to spell the pair out by hand (the HEAD challenge, the
// miss log, the paid-call logger, the rejection log, and now the gateway
// precheck), which is five chances for one of them to learn about a new alias
// and the others not to. "Did this request carry payment?" must have exactly one
// answer everywhere, because the answer decides which log a request lands in and
// — since the discovery fix — whether it is answered before the paywall at all.

/** Lower-case header names that carry a signed x402 payment payload. */
export const PAYMENT_HEADER_NAMES = ["x-payment", "payment-signature"] as const;

/** True when the request carries a payment payload under ANY supported alias. */
export function hasPaymentHeader(req: Pick<Request, "header">): boolean {
  return PAYMENT_HEADER_NAMES.some((h) => {
    const v = req.header(h);
    return typeof v === "string" && v.length > 0;
  });
}

/** The payload from whichever alias carried it, or undefined. */
export function paymentHeaderValue(req: Pick<Request, "header">): string | undefined {
  for (const h of PAYMENT_HEADER_NAMES) {
    const v = req.header(h);
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
