import { Router, type Request, type Response } from "express";
import { pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const tokenInfoRouter = Router();

interface Finding {
  rule: string;
  detail: string;
}

// --- Chain roster ------------------------------------------------------------
// Public keyless RPCs, rotated in order with per-PROVIDER cooldowns. Raw
// JSON-RPC over fetch — keyless base.org rejects big batches, ours is 5 calls.
// All hosts are fixed constants and the address is hex-validated below: no
// user-supplied URLs, no SSRF surface.
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
};
const CHAINS = Object.keys(CHAIN_RPCS);
const CHAIN_ALIASES: Record<string, string> = { eth: "ethereum" };

const BLOCKSCOUT_HOST: Record<string, string> = {
  base: "base.blockscout.com",
  ethereum: "eth.blockscout.com",
};

const ADDRESS_ALIASES = ["address", "contract", "token", "contract_address"];
const CHAIN_PARAM_ALIASES = ["chain", "network"];

// ERC-20 function selectors for the raw eth_call reads.
const SELECTORS = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
} as const;

// --- Cache / cooldown state (house provider-chain pattern, inlined) ----------
// Token identity is immutable and only the market fields churn — 10min TTL per
// chain:address bounds upstream load at any paid volume. Stale ceiling 1h.
const CACHE_TTL_MS = 10 * 60_000;
const STALE_MAX_MS = 60 * 60_000;
const BENCH_MS = 5 * 60_000; // per-provider cooldown on 429/403/timeout/garbage

interface CacheEntry {
  at: number;
  data: Record<string, unknown>; // response body minus cache_age_seconds/stale/findings
  findings: Finding[];
}

const cache = new Map<string, CacheEntry>(); // key = chain:lowercased-address
const benchedUntil = new Map<string, number>(); // key = RPC URL | dexscreener | blockscout

// Injectable clock so tests can advance time without sleeping.
let nowFn: () => number = Date.now;

/** Test-only: clear all module-level state (token cache, provider benches). */
export function __resetTokenInfoState(): void {
  cache.clear();
  benchedUntil.clear();
}

/** Test-only: override (or with no arg, restore) the clock. */
export function __setTokenInfoNow(fn?: () => number): void {
  nowFn = fn ?? Date.now;
}

// --- Helpers -----------------------------------------------------------------

function isBenched(provider: string): boolean {
  const until = benchedUntil.get(provider);
  return until !== undefined && nowFn() < until;
}

function bench(provider: string): void {
  benchedUntil.set(provider, nowFn() + BENCH_MS);
}

/**
 * Decode an eth_call return that should be a string. Handles BOTH ABI layouts
 * in the wild: the standard dynamic string (offset word + length word + data)
 * and the MKR-style bytes32 (one fixed word, left-aligned, zero-padded) —
 * never hex→utf8 the whole blob. Trailing nulls stripped; empty/garbage → null.
 */
function decodeAbiString(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) return null;
  const h = value.slice(2);
  let bytesHex: string;
  if (h.length === 64) {
    bytesHex = h; // bytes32 return
  } else if (h.length >= 128) {
    const offset = Number.parseInt(h.slice(0, 64), 16) * 2;
    if (!Number.isFinite(offset) || offset + 64 > h.length) return null;
    const len = Number.parseInt(h.slice(offset, offset + 64), 16) * 2;
    if (!Number.isFinite(len) || len < 0 || offset + 64 + len > h.length) return null;
    bytesHex = h.slice(offset + 64, offset + 64 + len);
  } else {
    return null;
  }
  const buf = Buffer.from(bytesHex, "hex");
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  const s = buf.subarray(0, end).toString("utf8").replace(/�/g, "").trim();
  return s.length > 0 ? s : null;
}

/** Strict 0x-hex uint → bigint; reverts ("0x"), error objects, garbage → null. */
function decodeUint(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

// --- Upstream fetchers -------------------------------------------------------

interface OnChainResult {
  code: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null; // decimal string — can exceed Number.MAX_SAFE
  source: string;
}

/**
 * One provider attempt: eth_getCode + the four ERC-20 reads in a single 5-item
 * JSON-RPC batch. A valid getCode result is the success criterion — a reverted
 * eth_call (error entry or "0x") is a definite chain answer, not a provider
 * failure, and degrades that field to null. Transport/HTTP/garbage-getCode
 * failures bench the provider and the rotation moves on.
 */
async function fetchOnChain(chain: string, address: string): Promise<OnChainResult | null> {
  const calls = [
    { jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] },
    { jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: address, data: SELECTORS.name }, "latest"] },
    { jsonrpc: "2.0", id: 3, method: "eth_call", params: [{ to: address, data: SELECTORS.symbol }, "latest"] },
    { jsonrpc: "2.0", id: 4, method: "eth_call", params: [{ to: address, data: SELECTORS.decimals }, "latest"] },
    { jsonrpc: "2.0", id: 5, method: "eth_call", params: [{ to: address, data: SELECTORS.totalSupply }, "latest"] },
  ];
  for (const rpc of CHAIN_RPCS[chain]) {
    if (isBenched(rpc)) continue;
    try {
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(calls),
        signal: AbortSignal.timeout(timeouts.tokenInfo),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const batch = (await resp.json()) as Array<{ id?: number; result?: unknown }>;
      if (!Array.isArray(batch)) throw new Error("non-batch reply");
      const result = (id: number): unknown => batch.find((r) => r?.id === id)?.result;

      const code = result(1);
      if (typeof code !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(code)) {
        throw new Error("invalid eth_getCode");
      }

      const rawDecimals = decodeUint(result(4));
      const decimals =
        rawDecimals !== null && rawDecimals >= 0n && rawDecimals <= 255n ? Number(rawDecimals) : null;

      return {
        code,
        name: decodeAbiString(result(2)),
        symbol: decodeAbiString(result(3)),
        decimals,
        totalSupply: decodeUint(result(5))?.toString() ?? null,
        source: rpc,
      };
    } catch {
      bench(rpc);
    }
  }
  return null;
}

interface DexResult {
  ok: boolean; // provider answered (even if with no pools)
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  topPool: { dex: string; pair: string; url: string | null } | null;
}

const DEX_MISS: DexResult = { ok: false, priceUsd: null, liquidityUsd: null, volume24hUsd: null, topPool: null };

/**
 * DexScreener token lookup. Returns pairs across ALL chains AND pairs where the
 * token is only the quote asset — filtered to `chainId === chain` with the
 * token as baseToken (priceUsd is the BASE token's price), then the highest-
 * liquidity pool wins. ok:true with all-null fields = no matching pool, which
 * is a legitimate answer for unlisted tokens, not a provider failure.
 */
async function fetchDexScreener(chain: string, address: string): Promise<DexResult> {
  if (isBenched("dexscreener")) return DEX_MISS;
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      signal: AbortSignal.timeout(timeouts.tokenInfo),
    });
    if (resp.status === 429 || resp.status === 403) {
      bench("dexscreener");
      return DEX_MISS;
    }
    if (!resp.ok) return DEX_MISS;
    const body = (await resp.json()) as {
      pairs?: Array<{
        chainId?: string;
        dexId?: string;
        url?: string;
        baseToken?: { address?: string; symbol?: string };
        quoteToken?: { symbol?: string };
        priceUsd?: string;
        liquidity?: { usd?: number };
        volume?: { h24?: number };
      }> | null;
    };
    const candidates = (Array.isArray(body?.pairs) ? body.pairs : []).filter(
      (p) => p?.chainId === chain && p?.baseToken?.address?.toLowerCase() === address,
    );
    if (candidates.length === 0) {
      return { ok: true, priceUsd: null, liquidityUsd: null, volume24hUsd: null, topPool: null };
    }
    const top = candidates.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
    const price = parseFloat(top.priceUsd ?? "");
    const liquidity = top.liquidity?.usd;
    const volume = top.volume?.h24;
    return {
      ok: true,
      priceUsd: Number.isFinite(price) ? price : null,
      liquidityUsd: typeof liquidity === "number" && Number.isFinite(liquidity) ? liquidity : null,
      volume24hUsd: typeof volume === "number" && Number.isFinite(volume) ? volume : null,
      topPool: {
        dex: top.dexId ?? "unknown",
        pair: `${top.baseToken?.symbol ?? "?"}/${top.quoteToken?.symbol ?? "?"}`,
        url: top.url ?? null,
      },
    };
  } catch {
    bench("dexscreener");
    return DEX_MISS;
  }
}

interface BlockscoutResult {
  ok: boolean;
  holders: number | null;
  name: string | null;
  symbol: string | null;
}

/** Blockscout v2 token lookup — holder count + verified-name cross-fill, enrichment only. */
async function fetchBlockscout(chain: string, address: string): Promise<BlockscoutResult> {
  const miss: BlockscoutResult = { ok: false, holders: null, name: null, symbol: null };
  if (isBenched("blockscout")) return miss;
  try {
    const resp = await fetch(`https://${BLOCKSCOUT_HOST[chain]}/api/v2/tokens/${address}`, {
      signal: AbortSignal.timeout(timeouts.tokenInfo),
    });
    if (resp.status === 429 || resp.status === 403) {
      bench("blockscout");
      return miss;
    }
    if (!resp.ok) return miss;
    const body = (await resp.json()) as {
      holders?: unknown;
      holders_count?: unknown;
      name?: unknown;
      symbol?: unknown;
    };
    const rawHolders = body?.holders ?? body?.holders_count;
    const holders =
      typeof rawHolders === "number" ? rawHolders : typeof rawHolders === "string" ? parseInt(rawHolders, 10) : NaN;
    return {
      ok: true,
      holders: Number.isFinite(holders) ? holders : null,
      name: typeof body?.name === "string" && body.name !== "" ? body.name : null,
      symbol: typeof body?.symbol === "string" && body.symbol !== "" ? body.symbol : null,
    };
  } catch {
    bench("blockscout");
    return miss;
  }
}

// --- Route handler -----------------------------------------------------------

tokenInfoRouter.get("/token/info", async (req: Request, res: Response) => {
  try {
    const rawAddress = pickRequestParam(req, ADDRESS_ALIASES);
    if (!rawAddress) {
      res.status(400).json({
        error:
          "Missing address. Pass ?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 — a 0x-prefixed " +
          "40-hex-char ERC-20 contract address (aliases: contract, token, contract_address).",
      });
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(rawAddress)) {
      res.status(400).json({
        error:
          `Invalid address ${JSON.stringify(rawAddress.slice(0, 48))}. Expected 0x + 40 hex chars ` +
          "(checksum case is ignored), e.g. 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.",
      });
      return;
    }
    // Checksum-insensitive: lowercased everywhere — cache key, upstream calls, response.
    const address = rawAddress.toLowerCase();

    const rawChain = pickRequestParam(req, CHAIN_PARAM_ALIASES);
    const chainToken = (rawChain ?? "base").trim().toLowerCase();
    const chain = CHAIN_RPCS[chainToken] ? chainToken : CHAIN_ALIASES[chainToken];
    if (!chain) {
      res.status(400).json({
        error:
          `Unsupported chain ${JSON.stringify(chainToken.slice(0, 48))}. Supported: ${CHAINS.join(", ")} ` +
          "(default base; eth accepted for ethereum; alias: network).",
      });
      return;
    }

    const now = nowFn();
    const key = `${chain}:${address}`;

    // Fresh cache hit → no upstream calls at all.
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      res.json({
        ...hit.data,
        cache_age_seconds: Math.round((now - hit.at) / 1000),
        stale: false,
        findings: hit.findings,
      });
      return;
    }

    const onchain = await fetchOnChain(chain, address);
    if (onchain === null) {
      // Every RPC failed. Stale-serve last resort: younger than the 1h ceiling
      // → billed 200 + finding; otherwise our miss, 502 uncharged.
      if (hit && now - hit.at <= STALE_MAX_MS) {
        const ageS = Math.round((now - hit.at) / 1000);
        res.json({
          ...hit.data,
          cache_age_seconds: ageS,
          stale: true,
          findings: [
            ...hit.findings,
            {
              rule: "stale_data",
              detail: `every ${chain} RPC failed this call — serving the last good result, ${ageS}s old`,
            },
          ],
        });
        return;
      }
      res.status(502).json({ error: `Upstream RPC data unavailable for ${chain}` });
      return;
    }

    if (onchain.code === "0x") {
      // Definite answer about wrong input — 400 uncharged.
      res.status(400).json({
        error: `No contract at ${address} on ${chain} — is this the right chain? Supported: ${CHAINS.join(", ")}.`,
      });
      return;
    }

    const [dex, scout] = await Promise.all([
      fetchDexScreener(chain, address),
      fetchBlockscout(chain, address),
    ]);

    const findings: Finding[] = [];

    // Blockscout's verified name/symbol only fill on-chain nulls — the chain
    // itself stays authoritative when both answer.
    const name = onchain.name ?? scout.name;
    const symbol = onchain.symbol ?? scout.symbol;
    if (onchain.name === null && onchain.symbol === null) {
      findings.push({
        rule: "erc20_identity_unavailable",
        detail: "contract exposes neither name() nor symbol() — it may not implement the ERC-20 interface",
      });
    }
    if (onchain.decimals === null) {
      findings.push({
        rule: "decimals_unavailable",
        detail: "decimals() reverted or returned garbage — decimals and total_supply_formatted are null",
      });
    }
    if (!dex.ok) {
      findings.push({
        rule: "dex_unavailable",
        detail: "DexScreener was unavailable — price_usd, liquidity_usd, volume_24h_usd, and top_pool are null",
      });
    } else if (dex.priceUsd === null && dex.topPool === null) {
      findings.push({
        rule: "no_dex_liquidity",
        detail: `no ${chain} DEX pool quotes this token as its base asset — a legitimate answer for unlisted tokens; price_usd, liquidity_usd, volume_24h_usd, and top_pool are null`,
      });
    }
    if (!scout.ok || scout.holders === null) {
      findings.push({
        rule: "holders_unavailable",
        detail: "Blockscout holder data was unavailable — holders is null",
      });
    }

    const totalSupplyFormatted =
      onchain.totalSupply !== null && onchain.decimals !== null
        ? Number(BigInt(onchain.totalSupply)) / 10 ** onchain.decimals
        : null;

    const sourceParts = ["rpc"];
    if (dex.ok && dex.topPool !== null) sourceParts.push("dexscreener");
    if (scout.ok && scout.holders !== null) sourceParts.push("blockscout");

    const data: Record<string, unknown> = {
      address,
      chain,
      name,
      symbol,
      decimals: onchain.decimals,
      total_supply: onchain.totalSupply,
      total_supply_formatted: totalSupplyFormatted,
      price_usd: dex.priceUsd,
      liquidity_usd: dex.liquidityUsd,
      volume_24h_usd: dex.volume24hUsd,
      top_pool: dex.topPool,
      holders: scout.holders,
      is_contract: true,
      source: sourceParts.join("+"),
    };

    cache.set(key, { at: now, data, findings });
    res.json({ ...data, cache_age_seconds: 0, stale: false, findings });
  } catch (err) {
    console.error("Token info error:", err);
    res.status(500).json({ error: "Upstream token data unavailable" });
  }
});
