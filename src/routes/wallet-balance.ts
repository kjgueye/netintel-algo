import { Router, type Request, type Response } from "express";
import { pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const walletBalanceRouter = Router();

interface Finding {
  rule: string;
  detail: string;
}

// --- Chain roster ------------------------------------------------------------
// Public keyless RPCs, rotated in order with per-PROVIDER cooldowns. Raw
// JSON-RPC over fetch in batches of ≤10 — keyless base.org rejects fat batches.
// All hosts are fixed constants and the address is format-validated below: no
// user-supplied URLs, no SSRF surface.
const EVM_RPCS: Record<string, string[]> = {
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
// mainnet-beta is aggressively rate-limited — publicnode is the workhorse leg;
// benching (not drama) handles the 429s.
const SOLANA_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];

const CHAINS = ["base", "ethereum", "solana"];
const CHAIN_ALIASES: Record<string, string> = { eth: "ethereum", sol: "solana" };

const USDC_CONTRACT: Record<string, string> = {
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  ethereum: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
};
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6; // same on every supported chain

const NATIVE: Record<string, { symbol: string; decimals: number }> = {
  base: { symbol: "ETH", decimals: 18 },
  ethereum: { symbol: "ETH", decimals: 18 },
  solana: { symbol: "SOL", decimals: 9 },
};

const ADDRESS_ALIASES = ["address", "wallet", "account", "addr"];
const CHAIN_PARAM_ALIASES = ["chain", "network"];
const TOKENS_ALIASES = ["tokens"];

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ERC-20 selectors for the raw eth_call reads (USDC's symbol/decimals hardcoded).
const SELECTORS = { balanceOf: "0x70a08231", decimals: "0x313ce567", symbol: "0x95d89b41" } as const;

const MAX_TOKENS = 10; // public RPC batch ceiling
const RPC_BATCH_MAX = 10;

// --- Cache / cooldown state (house provider-chain pattern, inlined) ----------
// Balances churn but agents re-probe the same counterparties — 60s TTL per
// chain:address:tokens bounds upstream load at any paid volume. Stale ceiling 10min.
const CACHE_TTL_MS = 60_000;
const STALE_MAX_MS = 10 * 60_000;
const BENCH_MS = 5 * 60_000; // per-provider cooldown on 429/403/timeout/garbage
const SPOT_TTL_MS = 60_000; // ETH-USD / SOL-USD Coinbase spot cache

interface CacheEntry {
  at: number;
  data: Record<string, unknown>; // response body minus cache_age_seconds/stale/findings
  findings: Finding[];
}

const cache = new Map<string, CacheEntry>(); // key = chain:address:tokens
const benchedUntil = new Map<string, number>(); // key = RPC URL
const spotCache = new Map<string, { at: number; price: number }>(); // key = ETH | SOL

// Injectable clock so tests can advance time without sleeping.
let nowFn: () => number = Date.now;

/** Test-only: clear all module-level state (balance cache, benches, spot cache). */
export function __resetWalletBalanceState(): void {
  cache.clear();
  benchedUntil.clear();
  spotCache.clear();
}

/** Test-only: override (or with no arg, restore) the clock. */
export function __setWalletBalanceNow(fn?: () => number): void {
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

function roundSig(value: number, sig: number): number {
  if (!isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(sig));
}

/** Raw units → human number: BigInt divide via Number, float noise clipped. */
function formatUnits(raw: bigint, decimals: number): number {
  return roundSig(Number(raw) / 10 ** decimals, 12);
}

/** USD estimates round to cents — this is a probe, not an accounting feed. */
function usdRound(value: number): number {
  return Math.round(value * 100) / 100;
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

/** balanceOf(address) calldata: selector + address left-padded to 32 bytes (lowercase fine). */
function balanceOfData(address: string): string {
  return SELECTORS.balanceOf + address.slice(2).toLowerCase().padStart(64, "0");
}

// --- Upstream fetchers -------------------------------------------------------

interface TokenRead {
  address: string;
  symbol: string | null;
  raw: bigint | null;
  decimals: number | null;
}

interface EvmResult {
  nativeWei: bigint;
  usdcRaw: bigint | null;
  tokens: TokenRead[];
  source: string;
}

/**
 * One provider attempt: eth_getBalance + USDC balanceOf + (balanceOf/decimals/
 * symbol per requested token), chunked into sequential ≤10-item JSON-RPC
 * batches. A valid native balance is the success criterion — a reverted token
 * read (error entry or "0x") is a definite chain answer, not a provider
 * failure, and degrades that entry to null. Transport/HTTP/garbage-native
 * failures bench the provider and the rotation moves on.
 */
async function fetchEvm(chain: string, address: string, tokens: string[]): Promise<EvmResult | null> {
  const calls: Array<{ jsonrpc: "2.0"; id: number; method: string; params: unknown[] }> = [
    { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "eth_call",
      params: [{ to: USDC_CONTRACT[chain], data: balanceOfData(address) }, "latest"],
    },
  ];
  tokens.forEach((token, i) => {
    calls.push(
      { jsonrpc: "2.0", id: 3 * i + 3, method: "eth_call", params: [{ to: token, data: balanceOfData(address) }, "latest"] },
      { jsonrpc: "2.0", id: 3 * i + 4, method: "eth_call", params: [{ to: token, data: SELECTORS.decimals }, "latest"] },
      { jsonrpc: "2.0", id: 3 * i + 5, method: "eth_call", params: [{ to: token, data: SELECTORS.symbol }, "latest"] },
    );
  });
  const chunks: (typeof calls)[] = [];
  for (let i = 0; i < calls.length; i += RPC_BATCH_MAX) chunks.push(calls.slice(i, i + RPC_BATCH_MAX));

  for (const rpc of EVM_RPCS[chain]) {
    if (isBenched(rpc)) continue;
    try {
      const byId = new Map<number, unknown>();
      for (const chunk of chunks) {
        const resp = await fetch(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(timeouts.walletBalance),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const batch = (await resp.json()) as Array<{ id?: number; result?: unknown }>;
        if (!Array.isArray(batch)) throw new Error("non-batch reply");
        for (const entry of batch) {
          if (typeof entry?.id === "number") byId.set(entry.id, entry.result);
        }
      }

      const nativeWei = decodeUint(byId.get(1));
      if (nativeWei === null) throw new Error("invalid eth_getBalance");

      return {
        nativeWei,
        usdcRaw: decodeUint(byId.get(2)),
        tokens: tokens.map((token, i) => {
          const rawDecimals = decodeUint(byId.get(3 * i + 4));
          return {
            address: token,
            raw: decodeUint(byId.get(3 * i + 3)),
            decimals:
              rawDecimals !== null && rawDecimals >= 0n && rawDecimals <= 255n ? Number(rawDecimals) : null,
            symbol: decodeAbiString(byId.get(3 * i + 5)),
          };
        }),
        source: rpc,
      };
    } catch {
      bench(rpc);
    }
  }
  return null;
}

interface SolResult {
  lamports: bigint;
  usdcRaw: bigint;
  source: string;
}

/**
 * One provider attempt: getBalance + getTokenAccountsByOwner (USDC mint,
 * jsonParsed) in a 2-item JSON-RPC batch. One owner can hold MULTIPLE token
 * accounts for the same mint — amounts are SUMMED. A base58-shaped string that
 * isn't a real 32-byte pubkey comes back as an invalid-params error — that is
 * a definite input verdict ("invalid_address"), not a provider failure.
 */
async function fetchSolana(address: string): Promise<SolResult | "invalid_address" | null> {
  const body = JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "getTokenAccountsByOwner",
      params: [address, { mint: SOLANA_USDC_MINT }, { encoding: "jsonParsed" }],
    },
  ]);
  for (const rpc of SOLANA_RPCS) {
    if (isBenched(rpc)) continue;
    try {
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeouts.walletBalance),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const batch = (await resp.json()) as Array<{
        id?: number;
        result?: { value?: unknown };
        error?: { code?: number; message?: string };
      }>;
      if (!Array.isArray(batch)) throw new Error("non-batch reply");
      const entry = (id: number) => batch.find((r) => r?.id === id);

      const balEntry = entry(1);
      if (balEntry?.error) {
        if (balEntry.error.code === -32602 || /invalid/i.test(balEntry.error.message ?? "")) {
          return "invalid_address";
        }
        throw new Error("getBalance error");
      }
      const lamports = balEntry?.result?.value;
      if (typeof lamports !== "number" || !Number.isFinite(lamports)) throw new Error("invalid getBalance");

      const accEntry = entry(2);
      const accValue = accEntry?.result?.value;
      if (accEntry?.error || !Array.isArray(accValue)) {
        throw new Error("invalid getTokenAccountsByOwner");
      }
      let usdcRaw = 0n;
      for (const acc of accValue as Array<{
        account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: unknown } } } } };
      }>) {
        const amount = acc?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (typeof amount === "string" && /^\d+$/.test(amount)) usdcRaw += BigInt(amount);
      }

      return { lamports: BigInt(Math.round(lamports)), usdcRaw, source: rpc };
    } catch {
      bench(rpc);
    }
  }
  return null;
}

/** Coinbase spot for the chain's native token, 60s cache. Null → usd fields degrade, never blocks. */
async function getNativeUsd(symbol: string): Promise<number | null> {
  const now = nowFn();
  const hit = spotCache.get(symbol);
  if (hit && now - hit.at < SPOT_TTL_MS) return hit.price;
  try {
    const resp = await fetch(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`, {
      signal: AbortSignal.timeout(timeouts.walletBalance),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { data?: { amount?: string } };
    const price = parseFloat(body?.data?.amount ?? "");
    if (Number.isFinite(price)) {
      spotCache.set(symbol, { at: now, price });
      return price;
    }
  } catch {
    // a dead spot API only costs the usd fields
  }
  return null;
}

// --- Route handler -----------------------------------------------------------

walletBalanceRouter.get("/wallet/balance", async (req: Request, res: Response) => {
  try {
    const rawChain = pickRequestParam(req, CHAIN_PARAM_ALIASES);
    const chainToken = (rawChain ?? "base").trim().toLowerCase();
    const chain = CHAINS.includes(chainToken) ? chainToken : CHAIN_ALIASES[chainToken];
    if (!chain) {
      res.status(400).json({
        error:
          `Unsupported chain ${JSON.stringify(chainToken.slice(0, 48))}. Supported: ${CHAINS.join(", ")} ` +
          "(default base; eth/sol accepted; alias: network).",
      });
      return;
    }

    const rawAddress = pickRequestParam(req, ADDRESS_ALIASES);
    if (!rawAddress) {
      res.status(400).json({
        error:
          "Missing address. Pass ?address=0x… (EVM: 0x + 40 hex chars) or a base58 Solana address " +
          "with chain=solana. Aliases: wallet, account, addr.",
      });
      return;
    }
    // Chain/format mismatch gets an instructive 400, not a generic one.
    let address: string;
    if (chain === "solana") {
      if (EVM_ADDRESS_RE.test(rawAddress)) {
        res.status(400).json({
          error: `${rawAddress.slice(0, 48)} looks like an EVM address — pass chain=base or chain=ethereum.`,
        });
        return;
      }
      if (!SOLANA_ADDRESS_RE.test(rawAddress)) {
        res.status(400).json({
          error:
            `Invalid Solana address ${JSON.stringify(rawAddress.slice(0, 48))}. Expected 32–44 base58 chars ` +
            "(no 0, O, I, or l).",
        });
        return;
      }
      address = rawAddress; // base58 is case-sensitive — never lowercase
    } else {
      if (!EVM_ADDRESS_RE.test(rawAddress)) {
        if (SOLANA_ADDRESS_RE.test(rawAddress)) {
          res.status(400).json({
            error: `${rawAddress.slice(0, 48)} looks like a Solana address — pass chain=solana.`,
          });
          return;
        }
        res.status(400).json({
          error:
            `Invalid address ${JSON.stringify(rawAddress.slice(0, 48))}. Expected 0x + 40 hex chars ` +
            "(checksum case is ignored) on EVM chains.",
        });
        return;
      }
      // Checksum-insensitive: lowercased everywhere — cache key, upstream calls, response.
      address = rawAddress.toLowerCase();
    }

    const rawTokens = pickRequestParam(req, TOKENS_ALIASES);
    let tokens: string[] = [];
    if (rawTokens) {
      if (chain === "solana") {
        res.status(400).json({
          error: "tokens param is EVM-only in v1 — omit it for Solana wallets (USDC is always included).",
        });
        return;
      }
      tokens = rawTokens.split(",").map((s) => s.trim()).filter(Boolean);
      if (tokens.length > MAX_TOKENS) {
        res.status(400).json({
          error: `Too many tokens (${tokens.length}) — at most ${MAX_TOKENS} per call (public RPC batch ceiling).`,
        });
        return;
      }
      const bad = tokens.find((t) => !EVM_ADDRESS_RE.test(t));
      if (bad !== undefined) {
        res.status(400).json({
          error:
            `Invalid token contract ${JSON.stringify(bad.slice(0, 48))} in tokens. Each entry must be ` +
            "0x + 40 hex chars (checksum case is ignored).",
        });
        return;
      }
      tokens = tokens.map((t) => t.toLowerCase());
    }

    const now = nowFn();
    const key = `${chain}:${address}:${tokens.join(",")}`;

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

    const native = NATIVE[chain];
    const findings: Finding[] = [];

    let nativeRaw: bigint;
    let usdcRaw: bigint | null;
    let tokenReads: TokenRead[] = [];
    let source: string;

    if (chain === "solana") {
      const sol = await fetchSolana(address);
      if (sol === "invalid_address") {
        res.status(400).json({
          error: `${address.slice(0, 48)} failed Solana public-key validation — it decodes to the wrong byte length.`,
        });
        return;
      }
      if (sol === null) {
        serveStaleOr502(res, hit, now, chain);
        return;
      }
      nativeRaw = sol.lamports;
      usdcRaw = sol.usdcRaw;
      source = sol.source;
    } else {
      const evm = await fetchEvm(chain, address, tokens);
      if (evm === null) {
        serveStaleOr502(res, hit, now, chain);
        return;
      }
      nativeRaw = evm.nativeWei;
      usdcRaw = evm.usdcRaw;
      tokenReads = evm.tokens;
      source = evm.source;
    }

    const spot = await getNativeUsd(native.symbol);
    if (spot === null) {
      findings.push({
        rule: "native_price_unavailable",
        detail: `Coinbase spot price for ${native.symbol} unavailable — native.usd is null`,
      });
    }

    if (usdcRaw === null) {
      findings.push({
        rule: "usdc_unavailable",
        detail: "USDC balanceOf returned garbage from the answering RPC — usdc fields are null",
      });
    }

    const tokensOut = tokenReads.map((t) => {
      if (t.raw === null) {
        findings.push({
          rule: "token_unreadable",
          detail: `${t.address}: balanceOf reverted or returned garbage — not an ERC-20 contract on ${chain}? balance is null`,
        });
        return { address: t.address, symbol: t.symbol, raw: null, formatted: null, usd: null };
      }
      if (t.decimals === null) {
        findings.push({
          rule: "token_decimals_unavailable",
          detail: `${t.address}: decimals() reverted — formatted is null, raw is authoritative`,
        });
        return { address: t.address, symbol: t.symbol, raw: t.raw.toString(), formatted: null, usd: null };
      }
      return {
        address: t.address,
        symbol: t.symbol,
        raw: t.raw.toString(),
        formatted: formatUnits(t.raw, t.decimals),
        usd: null, // custom tokens are not priced in v1
      };
    });

    // A never-used address is a REAL answer — zeros, billed, flagged.
    const tokensAllZero = tokenReads.every((t) => t.raw === null || t.raw === 0n);
    if (nativeRaw === 0n && usdcRaw === 0n && tokensAllZero) {
      findings.push({
        rule: "no_activity_detected",
        detail: `no ${native.symbol} or USDC balance on ${chain} — the address may be unused on this chain`,
      });
    }

    const nativeFormatted = formatUnits(nativeRaw, native.decimals);
    const usdcFormatted = usdcRaw !== null ? formatUnits(usdcRaw, USDC_DECIMALS) : null;

    const data: Record<string, unknown> = {
      address,
      chain,
      native: {
        symbol: native.symbol,
        raw: nativeRaw.toString(),
        formatted: nativeFormatted,
        usd: spot !== null ? usdRound(nativeFormatted * spot) : null,
      },
      usdc: {
        raw: usdcRaw !== null ? usdcRaw.toString() : null,
        formatted: usdcFormatted,
        // USDC is hardcoded 1.0 — a dead spot API never degrades this leg.
        usd: usdcFormatted !== null ? usdRound(usdcFormatted) : null,
      },
      tokens: tokensOut,
      source,
    };

    cache.set(key, { at: now, data, findings });
    res.json({ ...data, cache_age_seconds: 0, stale: false, findings });
  } catch (err) {
    console.error("Wallet balance error:", err);
    res.status(500).json({ error: "Upstream balance data unavailable" });
  }
});

/** Stale-serve last resort: younger than the 10min ceiling → billed 200 + finding; else 502 uncharged. */
function serveStaleOr502(res: Response, hit: CacheEntry | undefined, now: number, chain: string): void {
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
}
