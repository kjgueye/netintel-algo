import express from "express";
import { readFileSync } from "node:fs";
import { HTTPFacilitatorClient, x402ResourceServer, type RouteConfig } from "@x402-avm/core/server";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { paymentMiddleware, type Network } from "@x402-avm/express";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402-avm/extensions";
import { currencyExchangeRouter } from "./currency-exchange.js";

// --- Minimal .env loader (no dependency) -----------------------------------
// Loads KEY=VALUE lines from ./.env into process.env if not already set, so we
// don't need dotenv. Railway injects real env vars directly, so this is a no-op
// there (the file won't exist / vars already set).
function loadDotEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
  } catch {
    return; // no .env file (e.g. in production) — rely on real env vars
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

// --- Config (env-only; never hardcode network or payTo) --------------------
const FACILITATOR_URL = "https://facilitator.goplausible.xyz";
const PORT = Number(process.env.PORT ?? 3000);
const PAYTO_ADDRESS = process.env.PAYTO_ADDRESS;
const rawNetwork = process.env.X402_NETWORK;

if (!rawNetwork) {
  throw new Error("X402_NETWORK is required (CAIP-2 network id). See .env.example.");
}
if (!rawNetwork.includes(":")) {
  throw new Error(`X402_NETWORK must be a CAIP-2 id like "algorand:<genesis>", got "${rawNetwork}".`);
}
if (!PAYTO_ADDRESS) {
  throw new Error("PAYTO_ADDRESS is required (Algorand payout address). See .env.example.");
}
// Env is a plain string; Network is the CAIP-2 template-literal type. We've
// checked the "chain:ref" shape above, so this narrowing cast is safe.
const X402_NETWORK = rawNetwork as Network;

// --- x402 wiring -----------------------------------------------------------
// HTTPFacilitatorClient takes a custom URL via FacilitatorConfig.url (2.6.1).
// Receive-only seller: no createAuthHeaders / no signing key.
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// Register the AVM (Algorand) exact scheme on the resource server. The seller
// side needs no signer — settlement is performed by the payer's wallet + the
// facilitator. registerExactAvmScheme(server) wires the algorand:* wildcard.
const resourceServer = new x402ResourceServer(facilitatorClient);
registerExactAvmScheme(resourceServer);

// Bazaar discovery: enrich the PaymentRequired declaration so this endpoint
// lists richly (semantic description + input/output examples) in the
// facilitator's discovery catalog, instead of a bare URL+price entry. This is
// discovery metadata only — it does not touch payment verification/settlement.
resourceServer.registerExtension(bazaarResourceServerExtension);

// Discovery metadata for the convert route: how to call it and what it returns.
// The method (GET) is inferred by bazaarResourceServerExtension.enrichDeclaration
// from the actual route verb, so it is not declared here.
const convertDiscovery = declareDiscoveryExtension({
  input: { from: "USD", to: "EUR", amount: 100 },
  inputSchema: {
    properties: {
      from: {
        type: "string",
        description:
          "Source currency: an ISO 4217 fiat code (e.g. USD, EUR, GBP) or a crypto ticker (e.g. BTC, ETH, USDC). Also accepted as base/source.",
      },
      to: {
        type: "string",
        description:
          "Target currency: fiat code or crypto ticker. Also accepted as target/quote.",
      },
      amount: {
        type: "number",
        description: "Amount of `from` to convert. Optional; defaults to 1.",
      },
      date: {
        type: "string",
        description:
          "Optional YYYY-MM-DD for a historical fiat rate; omit for the latest rate. Not supported for crypto pairs.",
      },
    },
    required: ["from", "to"],
  },
  output: {
    example: {
      from: "USD",
      to: "EUR",
      amount: 100,
      converted_amount: 91.85,
      exchange_rate: 0.9185,
      inverse_rate: 1.0887,
      rate_date: "2026-07-01",
      is_historical: false,
      source: "ecb",
      score: 100,
      grade: "A",
      findings: [],
    },
  },
});

// One protected route. Price/network/payTo are config-driven (UNCHANGED).
// description/mimeType/extensions are discovery metadata surfaced in the catalog.
const routes: Record<string, RouteConfig> = {
  "GET /currency-exchange/convert": {
    accepts: {
      scheme: "exact",
      price: "$0.010",
      network: X402_NETWORK,
      payTo: PAYTO_ADDRESS,
    },
    description:
      "Convert an amount between two currencies. Fiat↔fiat pairs use European Central Bank (ECB) reference rates via Frankfurter and support historical rates by date; pairs involving crypto use the latest Coinbase spot rate. Keyless. Returns the converted amount, the exchange rate and its inverse, the rate date, and a structured result envelope (source, score, grade, findings).",
    mimeType: "application/json",
    extensions: { ...convertDiscovery },
  },
};

// --- App -------------------------------------------------------------------
const app = express();
app.use(express.json());

// Free, unprotected health check (Railway). Must be registered BEFORE the
// payment middleware doesn't matter (the middleware only guards matched routes),
// but keeping it first makes intent obvious and avoids any payment path for it.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", network: X402_NETWORK });
});

// Payment gate: only requests matching `routes` require payment; everything
// else (incl. /health) passes straight through to the next handler.
app.use(paymentMiddleware(routes, resourceServer));

// The actual protected handler (runs only after payment is satisfied).
app.use(currencyExchangeRouter);

// Bind 0.0.0.0 explicitly so the container is reachable on Railway's network.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`netintel-algo listening on 0.0.0.0:${PORT}`);
  console.log(`  facilitator: ${FACILITATOR_URL}`);
  console.log(`  network:     ${X402_NETWORK}`);
  console.log(`  payTo:       ${PAYTO_ADDRESS}`);
});
