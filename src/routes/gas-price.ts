import { Router, type Request, type Response } from "express";
import { pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const gasPriceRouter = Router();

interface Finding {
  rule: string;
  detail: string;
}

// --- Chain roster ------------------------------------------------------------
// Public keyless RPCs, rotated in order with per-PROVIDER cooldowns (a chain's
// first RPC failing must not skip the chain). Raw JSON-RPC over fetch — keyless
// base.org rejects big batches, ours is 2 calls. All hosts are fixed constants:
// no user-supplied URLs, no SSRF surface.
const CHAIN_RPCS: Record<string, string[]> = {
  base: [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
    "https://base.llamarpc.com",
    "https://1rpc.io/base",
  ],
  ethereum: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com",
    "https://1rpc.io/eth",
  ],
  arbitrum: [
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum-one-rpc.publicnode.com",
    "https://1rpc.io/arb",
  ],
  optimism: [
    "https://mainnet.optimism.io",
    "https://optimism-rpc.publicnode.com",
    "https://1rpc.io/op",
  ],
  polygon: [
    "https://polygon-rpc.com",
    "https://polygon-bor-rpc.publicnode.com",
    "https://1rpc.io/matic",
  ],
};
const CHAINS = Object.keys(CHAIN_RPCS);

const CHAIN_ALIASES: Record<string, string> = {
  eth: "ethereum",
  arb: "arbitrum",
  op: "optimism",
  matic: "polygon",
  pol: "polygon",
};

// base/optimism/arbitrum charge an L1 data fee on top of execution gas — the
// estimates here are execution-gas only, surfaced honestly as a finding.
const L2_CHAINS = new Set(["base", "optimism", "arbitrum"]);

// polygon's native token is POL (formerly MATIC) — POL-USD first, MATIC-USD
// fallback while Coinbase pair coverage settles.
const NATIVE_TOKEN: Record<string, string> = {
  base: "ETH",
  ethereum: "ETH",
  arbitrum: "ETH",
  optimism: "ETH",
  polygon: "POL",
};

const PARAM_ALIASES = ["chains", "chain", "network", "networks"];

// Canonical action costs in gas units for the USD estimates.
const GAS_UNITS = { transfer: 21_000, erc20_transfer: 65_000, swap: 200_000 } as const;

// --- Cache / cooldown state (house provider-chain pattern, inlined) ----------
// Gas moves fast and agents poll — 15s TTL per chain bounds upstream load to
// ~4 rounds/min/chain at any paid volume. Stale-serve last resort ceiling 10min.
const CACHE_TTL_MS = 15_000;
const STALE_MAX_MS = 10 * 60_000;
const BENCH_MS = 5 * 60_000; // per-provider cooldown on 429/403/timeout/garbage
const SPOT_TTL_MS = 60_000; // native-token USD price cache

interface ChainData {
  gasPriceGwei: number;
  baseFeeGwei: number | null;
  priorityFeeGwei: number | null;
  source: string;
  feeHistoryOk: boolean;
}

const chainCache = new Map<string, { at: number; data: ChainData }>();
const benchedUntil = new Map<string, number>(); // key = provider URL
const spotCache = new Map<string, { at: number; price: number }>(); // key = ETH | POL

// Injectable clock so tests can advance time without sleeping.
let nowFn: () => number = Date.now;

/** Test-only: clear all module-level state (chain cache, benches, spot cache). */
export function __resetGasPriceState(): void {
  chainCache.clear();
  benchedUntil.clear();
  spotCache.clear();
}

/** Test-only: override (or with no arg, restore) the clock. */
export function __setGasPriceNow(fn?: () => number): void {
  nowFn = fn ?? Date.now;
}

// --- Helpers -----------------------------------------------------------------

function roundSig(value: number, sig: number): number {
  if (!isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(sig));
}

/** Strict 0x-hex → bigint wei; anything else (error objects, garbage) is null. */
function parseHexWei(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) return null;
  return BigInt(v);
}

/** BigInt-parse then divide — keeps sub-gwei L2 precision (0.012 gwei is normal on Base). */
function weiToGwei(wei: bigint): number {
  return roundSig(Number(wei) / 1e9, 9);
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// --- Upstream fetchers -------------------------------------------------------

/**
 * One provider attempt: eth_gasPrice + eth_feeHistory(5 blocks, [25,50,75]) in
 * a single 2-item JSON-RPC batch. A usable gas price is the success criterion;
 * a malformed feeHistory degrades to nulls (finding) without failing the
 * provider. Any transport/HTTP/garbage-gasPrice failure benches the provider.
 */
async function fetchChainGas(chain: string): Promise<ChainData | null> {
  for (const rpc of CHAIN_RPCS[chain]) {
    const bench = benchedUntil.get(rpc);
    if (bench !== undefined && nowFn() < bench) continue;
    try {
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] },
          { jsonrpc: "2.0", id: 2, method: "eth_feeHistory", params: ["0x5", "latest", [25, 50, 75]] },
        ]),
        signal: AbortSignal.timeout(timeouts.gasPrice),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const batch = (await resp.json()) as Array<{ id?: number; result?: unknown }>;
      if (!Array.isArray(batch)) throw new Error("non-batch reply");

      const wei = parseHexWei(batch.find((r) => r?.id === 1)?.result);
      if (wei === null) throw new Error("invalid eth_gasPrice");
      const gasPriceGwei = weiToGwei(wei);

      let baseFeeGwei: number | null = null;
      let priorityFeeGwei: number | null = null;
      const fh = batch.find((r) => r?.id === 2)?.result as
        | { baseFeePerGas?: unknown; reward?: unknown }
        | undefined;
      if (fh && typeof fh === "object") {
        if (Array.isArray(fh.baseFeePerGas) && fh.baseFeePerGas.length > 0) {
          // last element is the NEXT block's base fee — the one a tx pays.
          const bf = parseHexWei(fh.baseFeePerGas[fh.baseFeePerGas.length - 1]);
          if (bf !== null) baseFeeGwei = weiToGwei(bf);
        }
        if (Array.isArray(fh.reward)) {
          const p50s = fh.reward
            .map((row) => (Array.isArray(row) ? parseHexWei(row[1]) : null))
            .filter((v): v is bigint => v !== null)
            .map(weiToGwei);
          const m = median(p50s);
          if (m !== null) priorityFeeGwei = roundSig(m, 9);
        }
      }

      return {
        gasPriceGwei,
        baseFeeGwei,
        priorityFeeGwei,
        source: rpc,
        feeHistoryOk: baseFeeGwei !== null || priorityFeeGwei !== null,
      };
    } catch {
      benchedUntil.set(rpc, nowFn() + BENCH_MS);
    }
  }
  return null;
}

/** Coinbase spot for the chain's native token, 60s cache. Null → usd fields degrade, never blocks. */
async function getNativeUsd(symbol: string): Promise<number | null> {
  const now = nowFn();
  const hit = spotCache.get(symbol);
  if (hit && now - hit.at < SPOT_TTL_MS) return hit.price;
  const pairs = symbol === "POL" ? ["POL-USD", "MATIC-USD"] : [`${symbol}-USD`];
  for (const pair of pairs) {
    try {
      const resp = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`, {
        signal: AbortSignal.timeout(timeouts.gasPrice),
      });
      if (!resp.ok) continue; // POL-USD 404 → fall through to MATIC-USD
      const body = (await resp.json()) as { data?: { amount?: string } };
      const price = parseFloat(body?.data?.amount ?? "");
      if (Number.isFinite(price)) {
        spotCache.set(symbol, { at: now, price });
        return price;
      }
    } catch {
      // try the next pair; a dead spot API only costs the usd fields
    }
  }
  return null;
}

// --- Route handler -----------------------------------------------------------

gasPriceRouter.get("/gas/price", async (req: Request, res: Response) => {
  try {
    const raw = pickRequestParam(req, PARAM_ALIASES);
    let requested: string[] = [...CHAINS];
    if (raw) {
      const parts = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (parts.length > 0) {
        requested = [];
        for (const p of parts) {
          const chain = CHAIN_RPCS[p] ? p : CHAIN_ALIASES[p];
          if (!chain) {
            res.status(400).json({
              error:
                `Unknown chain ${JSON.stringify(p)}. Supported: ${CHAINS.join(", ")} ` +
                `(aliases: eth, arb, op, matic, pol). Pass ?chains=base,ethereum — or omit chains for all 5.`,
            });
            return;
          }
          if (!requested.includes(chain)) requested.push(chain);
        }
      }
    }

    const now = nowFn();

    // Chains and spot prices concurrently; a failed leg is a finding, never a throw.
    const neededSymbols = [...new Set(requested.map((c) => NATIVE_TOKEN[c]))];
    const [results, spotEntries] = await Promise.all([
      Promise.all(
        requested.map(async (chain) => {
          const hit = chainCache.get(chain);
          if (hit && now - hit.at < CACHE_TTL_MS) {
            return { chain, data: hit.data as ChainData | null, ageMs: now - hit.at, stale: false };
          }
          const fresh = await fetchChainGas(chain).catch(() => null);
          if (fresh) {
            chainCache.set(chain, { at: now, data: fresh });
            return { chain, data: fresh as ChainData | null, ageMs: 0, stale: false };
          }
          // Stale-serve last resort: younger than the ceiling → billed 200 + finding.
          if (hit && now - hit.at <= STALE_MAX_MS) {
            return { chain, data: hit.data as ChainData | null, ageMs: now - hit.at, stale: true };
          }
          return { chain, data: null, ageMs: 0, stale: false };
        }),
      ),
      Promise.all(neededSymbols.map(async (sym) => [sym, await getNativeUsd(sym)] as const)),
    ]);

    if (results.every((r) => r.data === null)) {
      // No primary answer for ANY requested chain — our miss, 502 uncharged.
      res.status(502).json({ error: "Upstream gas data unavailable for all requested chains" });
      return;
    }

    const spot = new Map<string, number | null>(spotEntries);
    const findings: Finding[] = [];

    const l2s = requested.filter((c) => L2_CHAINS.has(c));
    if (l2s.length > 0) {
      findings.push({
        rule: "l2_data_fee_excluded",
        detail: `${l2s.join("/")} estimates are execution-gas only and exclude the L1 data fee`,
      });
    }
    const missingSpot = new Set<string>();

    const chains: Record<string, unknown> = {};
    let anyStale = false;
    for (const r of results) {
      if (r.data === null) {
        chains[r.chain] = null;
        findings.push({
          rule: "chain_unavailable",
          detail: `${r.chain}: every RPC in the rotation failed and no stale copy under 10 minutes old was available`,
        });
        continue;
      }
      const symbol = NATIVE_TOKEN[r.chain];
      const usd = spot.get(symbol) ?? null;
      if (usd === null) missingSpot.add(symbol);
      const est = (units: number): number | null =>
        usd === null ? null : roundSig((r.data!.gasPriceGwei * units * usd) / 1e9, 6);
      chains[r.chain] = {
        gas_price_gwei: r.data.gasPriceGwei,
        base_fee_gwei: r.data.baseFeeGwei,
        priority_fee_gwei: r.data.priorityFeeGwei,
        usd_estimates: {
          transfer: est(GAS_UNITS.transfer),
          erc20_transfer: est(GAS_UNITS.erc20_transfer),
          swap: est(GAS_UNITS.swap),
        },
        native_token: symbol,
        native_usd: usd,
        source: r.data.source,
        cache_age_seconds: Math.round(r.ageMs / 1000),
      };
      if (r.stale) {
        anyStale = true;
        findings.push({
          rule: "stale_data",
          detail: `${r.chain}: all RPCs failed this call — serving the last good result, ${Math.round(r.ageMs / 1000)}s old`,
        });
      }
      if (!r.data.feeHistoryOk) {
        findings.push({
          rule: "fee_history_unavailable",
          detail: `${r.chain}: eth_feeHistory was unavailable or malformed — base_fee_gwei and priority_fee_gwei are null`,
        });
      }
    }

    for (const symbol of missingSpot) {
      findings.push({
        rule: "native_price_unavailable",
        detail: `Coinbase spot price for ${symbol} unavailable — native_usd and usd_estimates are null for its chains`,
      });
    }

    res.json({ chains, stale: anyStale, findings });
  } catch (err) {
    console.error("Gas price error:", err);
    res.status(500).json({ error: "Upstream gas data unavailable" });
  }
});
