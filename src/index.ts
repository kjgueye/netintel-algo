/**
 * index.ts — the Algorand resource server.
 *
 * One of the four Algorand-specific source files (with config.ts, accepts.ts
 * and paywall.ts). Everything under src/routes, src/utils and src/services is a
 * byte-identical copy of NetIntel's (Base), and src/route-table.ts — the
 * helper consts + `routes` map + every router — is generated from NetIntel's
 * index.ts. See src/SYNCED-FROM.txt and `npm run sync:from-netintel`.
 *
 * The route table needs no per-entry edits because every entry builds its
 * `accepts` through ./accepts.js (paidAccepts → one Algorand option) and reads
 * pricing.* / config.* from ./config.js, which binds them to Algorand env vars.
 * So the same declarations that price and describe the Base service price and
 * describe the Algorand one.
 *
 * The only deltas vs NetIntel are the payment rails:
 *   - @x402-avm/* instead of @x402/* + @coinbase/x402
 *   - the GoPlausible facilitator instead of the CDP one
 *   - registerExactAvmScheme (the algorand:* wildcard) instead of ExactEvmScheme
 * The seller is RECEIVE-ONLY: there is no signing key anywhere. Settlement is
 * performed by the payer's wallet and the facilitator.
 */
import express from "express";
import { HTTPFacilitatorClient, x402ResourceServer, type RouteConfig } from "@x402-avm/core/server";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { paymentMiddleware } from "@x402-avm/express";
import { bazaarResourceServerExtension } from "@x402-avm/extensions";
import { config } from "./config.js";
import { routes, routers } from "./route-table.js";
import { discoveryRouter, type DiscoveryRoute } from "./discovery.js";
import { createStore } from "./paid-call-store.js";
import { createPaidCallLogger, buildPriceLookup } from "./paid-call-logger.js";
import { createMissStore } from "./miss-log-store.js";
import { createMissLogger } from "./miss-log.js";
import { mirror402Body } from "./mirror-402-body.js";
import { headChallenge } from "./head-challenge.js";
import { renderPaywall } from "./paywall.js";

// Catch silent crashes
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

// github-intel accepts the repo via query (GET) OR JSON body (POST). Both methods
// share this one paid config so pricing, description, and discovery stay identical.

// --- x402 wiring (AVM / Algorand) -------------------------------------------
// Receive-only seller: no createAuthHeaders, no signing key. The payer's wallet
// plus the GoPlausible facilitator perform settlement.
const FACILITATOR_URL = "https://facilitator.goplausible.xyz";

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient);

// Registers the algorand:* wildcard exact scheme. The USDC ASA is DERIVED from
// the CAIP-2 network id by the SDK (mainnet -> 31566704, testnet -> 10458941),
// which is why flipping nets is a config-only change.
registerExactAvmScheme(resourceServer);

// Enriches the 402 PaymentRequired declaration with the input/output examples
// each route declares, so endpoints list richly in the facilitator's discovery
// catalog rather than as a bare URL+price. Discovery metadata only — it does
// not touch verification or settlement.
resourceServer.registerExtension(bazaarResourceServerExtension);

// --- App --------------------------------------------------------------------
const app = express();
// Behind Railway's proxy: trust X-Forwarded-Proto so req.protocol is "https"
// and the discovery artifacts advertise https URLs when PUBLIC_BASE_URL is unset.
app.set("trust proxy", true);
app.use(express.json());

// --- Paid-call analytics (passive observer; algo_* tables only) --------------
// Writes into the shared NetIntel Postgres but only ever into this service's own
// algo_paid_call_events / _failures / _misses tables — never the Base/EVM ones.
// Optional: without DATABASE_URL events fall back to NDJSON + tagged stdout.
// Init failures are non-fatal (receive-only resilience).
const paidCallStore = createStore(process.env);
const paidCallFailureStore = createStore(process.env, {
  table: "algo_paid_call_failures",
  fileName: "algo-paid-call-failures.ndjson",
  stdoutTag: "ALGO_PAID_CALL_FAILURE",
});
const missStore = createMissStore(process.env);
console.log(`Paid-call storage: ${paidCallStore.describe()}`);
for (const [name, s] of [
  ["events", paidCallStore],
  ["failures", paidCallFailureStore],
  ["misses", missStore],
] as const) {
  s.init()
    .then(() => console.log(`[paid-call] ${name} schema ready`))
    .catch((err) => console.error(`[paid-call] ${name} init failed (non-fatal):`, err));
}

// Registered BEFORE the payment middleware so it brackets the whole request
// (verification + handler + settlement) and can read PAYMENT-RESPONSE at
// res.finish. Observer only — payment behavior is unchanged.
app.use(
  createPaidCallLogger({
    store: paidCallStore,
    failureStore: paidCallFailureStore,
    priceLookup: buildPriceLookup(routes),
    network: config.network,
  })
);

// Free, unprotected health check (Railway probes this).
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", network: config.network });
});

// Free agent-discovery surfaces (/.well-known/x402, api-catalog, agent card,
// apis.json, ai-plugin.json, openapi.json, llms.txt, security.txt, robots.txt,
// and the / + /api on-ramps). Generated from the same `routes` object that
// drives the payment middleware, so the catalogs can never drift from what is
// actually served and priced. See src/discovery.ts.
app.use(
  discoveryRouter(routes as unknown as Record<string, DiscoveryRoute>, {
    network: config.network,
    payTo: config.payTo,
    facilitatorUrl: FACILITATOR_URL,
    publicBaseUrl: config.publicBaseUrl || undefined,
    supportContact: config.supportContact,
    securityContact: config.securityContact,
  })
);

// Pin every route's x402 resource URL to the canonical host (NetIntel does the
// same). Without this the SDK derives the resource from the incoming Host
// header, so a settlement that arrives on the raw *.railway.app hostname
// registers a DUPLICATE Bazaar listing under that host. Serving is unaffected —
// the middleware matches by path, never by host.
const canonicalBase = config.publicBaseUrl.trim().replace(/\/+$/, "");
if (canonicalBase) {
  for (const [key, cfg] of Object.entries(routes)) {
    (cfg as { resource?: string }).resource = `${canonicalBase}${key.split(" ")[1]}`;
  }
}

// Payment gate: only requests matching `routes` require payment. Everything else
// (health, discovery) has already been served above and passes straight through.
// Mirror the v2 payment-required header envelope into the middleware's empty
// 402 bodies (body-reading x402 clients otherwise see `{}` — the SDK answers
// header-only; see mirror-402-body.ts). Registered BEFORE the paywall so its
// res.json wrapper is in place when the middleware responds.
// Human-facing 402 (browsers only; agents get JSON/header): the SDK's built-in
// page rounds the price to two decimals — "$0.00 USDC" for a $0.002 route — so
// every route carries its own page with the exact price (src/paywall.ts).
for (const [key, cfg] of Object.entries(routes)) {
  (cfg as { customPaywallHtml?: string }).customPaywallHtml = renderPaywall(
    key,
    cfg as Parameters<typeof renderPaywall>[1],
    canonicalBase || `http://localhost:${config.port}`
  );
}
app.use(mirror402Body);
const paywall = paymentMiddleware(routes as Record<string, RouteConfig>, resourceServer);
// HEAD on a paid path → the paywall's own 402 (header, no body), never the
// handler unpaid. After mirror402Body, before the paywall (head-challenge.ts).
app.use(headChallenge(routes, paywall));
app.use(paywall);

// --- The paid handlers (reached only once payment is satisfied) --------------
// Every route router, in NetIntel's declaration order (src/route-table.ts).
for (const router of routers) app.use(router);

// Terminal 404: nothing matched. Record the miss (what agents ask us for that we
// don't offer — a product-discovery feed) and answer with a machine-readable 404
// pointing at the discovery manifest.
app.use(
  createMissLogger({
    store: missStore,
    // Paid routes + key free docs, for did_you_mean suggestions on near-miss
    // paths (same behavior as the NetIntel Base app).
    knownPaths: [
      ...new Set(Object.keys(routes).map((k) => k.split(" ")[1])),
      "/.well-known/x402",
      "/llms.txt",
      "/openapi.json",
    ],
  })
);

// Bind 0.0.0.0 explicitly so the container is reachable on Railway's network.
app.listen(config.port, "0.0.0.0", () => {
  const paidCount = Object.keys(routes).length;
  console.log(`netintel-algo listening on 0.0.0.0:${config.port}`);
  console.log(`  facilitator: ${FACILITATOR_URL}`);
  console.log(`  network:     ${config.network}`);
  console.log(`  payTo:       ${config.payTo}`);
  console.log(`  paid routes: ${paidCount}`);
});
