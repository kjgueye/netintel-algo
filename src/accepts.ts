/**
 * accepts.ts — the Algorand rail adapter (one of the three Algorand-specific
 * source files, with config.ts and index.ts; everything else is a verbatim copy
 * of NetIntel's — see src/SYNCED-FROM.txt).
 *
 * NetIntel's routes, services and route table never name a payment rail: every
 * `accepts` array is built by paidAccepts()/signableAccepts() from THIS module,
 * which NetIntel binds to Base (+ Solana) and this repo binds to Algorand. Same
 * exported names and shapes as NetIntel's src/accepts.ts, so the synced files
 * compile unchanged.
 */
import type { HTTPRequestContext } from "@x402-avm/core/server";
import { config } from "./config.js";

// The SDK's per-request context (what a DynamicPrice callback receives). The
// synced gateway pricing service imports it from here, never from the SDK.
export type { HTTPRequestContext };

export interface PaymentOption {
  scheme: "exact";
  price: string;
  /** Canonical atomic-unit amount (USDC has 6 decimals: "$0.005" → "5000"). */
  amount: string;
  /** USDC ASA id on this network (mainnet 31566704, testnet 10458941). */
  asset: string;
  network: `${string}:${string}`;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, string>;
}

// USDC ASA per Algorand network, keyed by CAIP-2 id. Settlement never reads
// this (the AVM scheme derives the ASA from the network id itself); it makes
// our hand-rolled 402 bodies and discovery rows spec-complete, the same way
// NetIntel's copy carries the Base/Solana USDC addresses.
const USDC_ASA: Record<string, string> = {
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": "31566704", // mainnet
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=": "10458941", // testnet
};

/** "$0.005" → micro-USDC atomic string "5000" (6 decimals). */
export function atomicUsdc(price: string): string {
  return String(Math.round(Number(price.replace(/[^0-9.]/g, "")) * 1_000_000));
}

/**
 * The single Algorand payment option for a route. `extra.tag` carries the
 * Algorand Global x402 Challenge tag (config.challengeTag): the GoPlausible
 * facilitator copies a route's `extra` into its catalog row, and the
 * challenge's hackathon filter + leaderboard select on that tag — 1,808 of the
 * 2,208 catalog rows carried it on 2026-09-24; ours carried none.
 */
export function paidAccepts(price: string): PaymentOption[] {
  return [
    {
      scheme: "exact",
      price,
      amount: atomicUsdc(price),
      asset: USDC_ASA[config.network] ?? "",
      network: config.network,
      payTo: config.payTo,
      ...(config.challengeTag ? { extra: { tag: config.challengeTag } } : {}),
    },
  ];
}

const COLD_PROBE_MAX_TIMEOUT_SECONDS = 300;

/**
 * paidAccepts + the maxTimeoutSeconds the payment middleware injects for real
 * requests. For the hand-rolled GET/HEAD cold-probe 402 stubs in the synced
 * route files (they bypass the middleware). Never use for a real routeConfig.
 */
export function signableAccepts(price: string): PaymentOption[] {
  return paidAccepts(price).map((a) => ({
    ...a,
    maxTimeoutSeconds: COLD_PROBE_MAX_TIMEOUT_SECONDS,
  }));
}
