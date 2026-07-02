// NetIntel pattern: paid POST endpoints also answer GET/HEAD with a 402 so the
// Bazaar health prober sees a payment challenge instead of a 404. (The POST is
// paywalled by paymentMiddleware; these stubs never settle anything.) In the
// main repo the body is built from config.network/config.payTo — here those
// come from the same env vars server.ts validates at boot.
export function paymentRequiredStub(price: string): Record<string, unknown> {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        price,
        network: process.env.X402_NETWORK,
        payTo: process.env.PAYTO_ADDRESS,
      },
    ],
    error: "Payment required",
  };
}
