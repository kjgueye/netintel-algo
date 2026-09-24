/**
 * config.ts — the ONE Algorand-specific adapter file.
 *
 * src/routes/* and src/utils/* are byte-identical copies of NetIntel's (Base).
 * They compile unchanged against this module because it exports exactly the same
 * symbols with the same member names as NetIntel's src/config.ts — only `config`
 * is rewritten to read Algorand env vars. Everything below `config` (pricing,
 * timeouts, limits, dnsResolvers, vendorRiskWeights) is copied verbatim from
 * NetIntel and is kept in step by `npm run sync:from-netintel`.
 *
 * Consequence: NetIntel's routes build their own 402 stubs from
 * pricing.* / config.network / config.payTo, and those now resolve to Algorand
 * values automatically — no per-route edits, no payment-stub helper.
 */
import { readFileSync } from "node:fs";

// Minimal .env loader (no dotenv dependency). Railway injects real env vars, so
// this is a no-op in production. Must run before the module-level reads below.
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

// --- Env-only payment config (never hardcode network or payTo) ---------------
// Flipping testnet<->mainnet is a config-only change: set X402_NETWORK and
// PAYTO_ADDRESS. The USDC ASA is derived from the CAIP-2 network by the SDK.
const rawNetwork = process.env.X402_NETWORK;
const rawPayTo = process.env.PAYTO_ADDRESS;

if (!rawNetwork) {
  throw new Error("X402_NETWORK is required (CAIP-2 network id). See .env.example.");
}
if (!rawNetwork.includes(":")) {
  throw new Error(`X402_NETWORK must be a CAIP-2 id like "algorand:<genesis>", got "${rawNetwork}".`);
}
if (!rawPayTo) {
  throw new Error("PAYTO_ADDRESS is required (Algorand payout address). See .env.example.");
}

export const config = {
  payTo: rawPayTo,
  // CAIP-2 template-literal type; the "chain:ref" shape is checked above.
  network: rawNetwork as `${string}:${string}`,
  port: parseInt(process.env.PORT || "3000", 10),
  devMode: process.env.DEV_MODE === "true",
  // Canonical origin advertised by the discovery artifacts. When unset they fall
  // back to the request's own scheme + Host (see src/base-url.ts).
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  securityContact: process.env.SECURITY_CONTACT || "mailto:security@netintel.dev",
  supportContact: process.env.SUPPORT_CONTACT || "support@netintel.dev",
  // NetIntel's routes/services branch on this to add a Solana rail; this
  // service settles on Algorand only, so it is never set here.
  solanaPayTo: "",
  // Algorand Global x402 Challenge tag, carried in every accept's `extra.tag`
  // (see src/accepts.ts). Set X402_CHALLENGE_TAG= (empty) to drop it.
  challengeTag: process.env.X402_CHALLENGE_TAG ?? "x402-global-challenge",
};

// Everything else — pricing, timeouts, limits, dnsResolvers, vendorRiskWeights,
// translateBatch… — is NetIntel's own config module, synced verbatim to
// src/netintel-config.ts (`npm run sync:from-netintel`). Its `config` export is
// shadowed by the Algorand binding above; nothing else is overridden, so
// Algorand and Base charge the same per call by construction.
export * from "./netintel-config.js";
