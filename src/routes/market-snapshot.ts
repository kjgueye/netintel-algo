import { Router, type Request, type Response } from "express";
import { pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const marketSnapshotRouter = Router();

interface Finding {
  rule: string;
  detail: string;
}

// --- Symbol map (top ~50 assets, static for v1) ------------------------------
// Copied verbatim from crypto-price.ts per the Finance batch handoff: resolving
// unknown symbols via CoinGecko /search would burn the shared-Railway-egress
// rate budget — the exact failure mode that broke ip-geo.
const COINS: Record<string, { id: string; name: string }> = {
  BTC: { id: "bitcoin", name: "Bitcoin" },
  ETH: { id: "ethereum", name: "Ethereum" },
  USDT: { id: "tether", name: "Tether" },
  BNB: { id: "binancecoin", name: "BNB" },
  SOL: { id: "solana", name: "Solana" },
  USDC: { id: "usd-coin", name: "USDC" },
  XRP: { id: "ripple", name: "XRP" },
  DOGE: { id: "dogecoin", name: "Dogecoin" },
  TON: { id: "the-open-network", name: "Toncoin" },
  ADA: { id: "cardano", name: "Cardano" },
  TRX: { id: "tron", name: "TRON" },
  AVAX: { id: "avalanche-2", name: "Avalanche" },
  SHIB: { id: "shiba-inu", name: "Shiba Inu" },
  LINK: { id: "chainlink", name: "Chainlink" },
  DOT: { id: "polkadot", name: "Polkadot" },
  BCH: { id: "bitcoin-cash", name: "Bitcoin Cash" },
  NEAR: { id: "near", name: "NEAR Protocol" },
  POL: { id: "polygon-ecosystem-token", name: "Polygon" },
  LTC: { id: "litecoin", name: "Litecoin" },
  ICP: { id: "internet-computer", name: "Internet Computer" },
  UNI: { id: "uniswap", name: "Uniswap" },
  ETC: { id: "ethereum-classic", name: "Ethereum Classic" },
  APT: { id: "aptos", name: "Aptos" },
  XLM: { id: "stellar", name: "Stellar" },
  ATOM: { id: "cosmos", name: "Cosmos Hub" },
  XMR: { id: "monero", name: "Monero" },
  FIL: { id: "filecoin", name: "Filecoin" },
  HBAR: { id: "hedera-hashgraph", name: "Hedera" },
  ARB: { id: "arbitrum", name: "Arbitrum" },
  VET: { id: "vechain", name: "VeChain" },
  IMX: { id: "immutable-x", name: "Immutable" },
  OP: { id: "optimism", name: "Optimism" },
  MKR: { id: "maker", name: "Maker" },
  INJ: { id: "injective-protocol", name: "Injective" },
  GRT: { id: "the-graph", name: "The Graph" },
  RENDER: { id: "render-token", name: "Render" },
  AAVE: { id: "aave", name: "Aave" },
  SUI: { id: "sui", name: "Sui" },
  SEI: { id: "sei-network", name: "Sei" },
  PEPE: { id: "pepe", name: "Pepe" },
  ALGO: { id: "algorand", name: "Algorand" },
  FTM: { id: "fantom", name: "Fantom" },
  STX: { id: "blockstack", name: "Stacks" },
  RUNE: { id: "thorchain", name: "THORChain" },
  FLOW: { id: "flow", name: "Flow" },
  KAS: { id: "kaspa", name: "Kaspa" },
  TIA: { id: "celestia", name: "Celestia" },
  JUP: { id: "jupiter-exchange-solana", name: "Jupiter" },
  WLD: { id: "worldcoin-wld", name: "Worldcoin" },
  CRO: { id: "crypto-com-chain", name: "Cronos" },
  LDO: { id: "lido-dao", name: "Lido DAO" },
  QNT: { id: "quant-network", name: "Quant" },
  GALA: { id: "gala", name: "Gala" },
  FET: { id: "fetch-ai", name: "Fetch.ai" },
  XTZ: { id: "tezos", name: "Tezos" },
  BONK: { id: "bonk", name: "Bonk" },
};

const NAME_TO_SYMBOL = new Map(
  Object.entries(COINS).map(([sym, c]) => [c.name.toLowerCase(), sym]),
);

const SYMBOL_ALIASES = ["symbols", "coins", "tickers", "symbol", "coin", "ticker"];
const VS_ALIASES = ["vs", "currency", "fiat", "vs_currency"];
const SUPPORTED_VS = new Set(["USD", "EUR", "GBP"]);
const DEFAULT_SYMBOLS = ["BTC", "ETH", "SOL"];
const MAX_SYMBOLS = 6;

// The briefing's fixed fiat crosses (vs only re-quotes the crypto section).
const FIAT_PAIRS = ["USD/EUR", "USD/GBP", "USD/JPY", "EUR/GBP"] as const;

// Gas section covers the two chains x402 agents actually transact on.
const GAS_CHAINS: Record<string, string[]> = {
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
const TRANSFER_GAS_UNITS = 21_000;

// --- Cache / cooldown state (house provider-chain pattern, inlined) ----------
// The whole snapshot caches 60s; each section keeps its own inner cache so a
// snapshot rebuild after 60s mostly hits warm section caches. One slow section
// must never eat the overall budget: every upstream leg races SECTION_TIMEOUT_MS
// while timeouts.marketSnapshot bounds the composite.
const SNAPSHOT_TTL_MS = 60_000;
const SNAPSHOT_STALE_MAX_MS = 10 * 60_000;
const CRYPTO_TTL_MS = 30_000;
const FIAT_TTL_MS = 60 * 60_000;
const GAS_TTL_MS = 15_000;
const SENTIMENT_TTL_MS = 60 * 60_000;
const SPOT_TTL_MS = 60_000; // ETH-USD for the gas section's transfer_usd
const BENCH_MS = 5 * 60_000; // per-provider cooldown on 429/403/timeout/garbage
const SECTION_TIMEOUT_MS = 6_000;

interface CryptoRow {
  price: number;
  changePct: number | null;
  high24h: number | null;
  low24h: number | null;
  source: string;
}

interface FiatData {
  rates: Record<string, number>; // key = "USD/EUR"
  rateDate: string;
  source: string;
}

interface GasRow {
  gasPriceGwei: number;
  source: string;
}

interface SentimentData {
  value: number;
  classification: string;
  yesterday: number | null;
}

const snapshotCache = new Map<string, { at: number; body: Record<string, unknown> }>();
const cryptoCache = new Map<string, { at: number; row: CryptoRow }>(); // key = SYM:VS
const fiatCache = new Map<string, { at: number; data: FiatData }>(); // single key "fiat"
const gasCache = new Map<string, { at: number; row: GasRow }>(); // key = chain
const sentimentCache = new Map<string, { at: number; data: SentimentData }>(); // single key "fng"
const spotCache = new Map<string, { at: number; price: number }>(); // key = "ETH"
const benchedUntil = new Map<string, number>();

// Injectable clock so tests can advance time without sleeping.
let nowFn: () => number = Date.now;

/** Test-only: clear all module-level state (all caches, provider benches). */
export function __resetMarketSnapshotState(): void {
  snapshotCache.clear();
  cryptoCache.clear();
  fiatCache.clear();
  gasCache.clear();
  sentimentCache.clear();
  spotCache.clear();
  benchedUntil.clear();
}

/** Test-only: override (or with no arg, restore) the clock. */
export function __setMarketSnapshotNow(fn?: () => number): void {
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

function parseNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

/** Strict 0x-hex → bigint wei; anything else (error objects, garbage) is null. */
function parseHexWei(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) return null;
  return BigInt(v);
}

// --- Crypto section ----------------------------------------------------------

/**
 * One Coinbase Exchange leg: ticker (last price) + stats (24h open/high/low),
 * concurrent. change_24h_pct = price vs stats open — same math as
 * /crypto/market (stats has no change field). 404 = pair miss (fall through
 * for this symbol only); 429/403/timeout benches the provider.
 */
async function fetchCoinbaseRow(symbol: string, vs: string): Promise<CryptoRow | null> {
  const get = async (kind: "ticker" | "stats"): Promise<Record<string, unknown> | null> => {
    const resp = await fetch(
      `https://api.exchange.coinbase.com/products/${symbol}-${vs}/${kind}`,
      { signal: AbortSignal.timeout(SECTION_TIMEOUT_MS) },
    );
    if (resp.status === 429 || resp.status === 403) throw new Error("rate-limited");
    if (!resp.ok) return null; // unlisted pair → miss, not a bench
    return (await resp.json()) as Record<string, unknown>;
  };
  try {
    const [ticker, stats] = await Promise.all([get("ticker"), get("stats")]);
    const price = parseNum(ticker?.price);
    if (price === null) return null;
    const open = parseNum(stats?.open);
    return {
      price,
      changePct: open !== null && open !== 0 ? roundSig(((price - open) / open) * 100, 4) : null,
      high24h: parseNum(stats?.high),
      low24h: parseNum(stats?.low),
      source: "coinbase",
    };
  } catch {
    bench("coinbase-exchange");
    return null;
  }
}

/**
 * One Kraken Ticker call for the stragglers. BTC is XBT; result keys are
 * Kraken-internal — values are zipped back in request order (only safe on an
 * exact count match). h/l index 1 = trailing 24h; change approximated from
 * today's open (Kraken has no 24h-ago reference).
 */
async function fetchKrakenRows(symbols: string[], vs: string): Promise<Map<string, CryptoRow>> {
  const out = new Map<string, CryptoRow>();
  const pairs = symbols.map((s) => `${s === "BTC" ? "XBT" : s}${vs}`).join(",");
  try {
    const resp = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`, {
      signal: AbortSignal.timeout(SECTION_TIMEOUT_MS),
    });
    if (resp.status === 429 || resp.status === 403) {
      bench("kraken");
      return out;
    }
    if (!resp.ok) return out;
    const body = (await resp.json()) as {
      error?: unknown[];
      result?: Record<string, { c?: unknown[]; o?: unknown; h?: unknown[]; l?: unknown[] }>;
    };
    if (!body?.result || (Array.isArray(body.error) && body.error.length > 0)) return out;
    const rows = Object.values(body.result);
    if (rows.length !== symbols.length) return out;
    symbols.forEach((sym, i) => {
      const row = rows[i];
      const price = parseNum(Array.isArray(row?.c) ? row.c[0] : null);
      if (price === null) return;
      const open = parseNum(row?.o);
      out.set(sym, {
        price,
        changePct: open !== null && open !== 0 ? roundSig(((price - open) / open) * 100, 4) : null,
        high24h: parseNum(Array.isArray(row?.h) ? row.h[1] : null),
        low24h: parseNum(Array.isArray(row?.l) ? row.l[1] : null),
        source: "kraken",
      });
    });
    return out;
  } catch {
    bench("kraken");
    return out;
  }
}

/** ONE CoinGecko simple/price call for whatever is still missing — price + 24h change, no high/low. */
async function fetchGeckoRows(symbols: string[], vs: string): Promise<Map<string, CryptoRow>> {
  const out = new Map<string, CryptoRow>();
  const vsLower = vs.toLowerCase();
  const ids = symbols.map((s) => COINS[s].id).join(",");
  const headers: Record<string, string> = {};
  // Optional free demo key — moves the CoinGecko quota from the shared Railway
  // egress IP to a per-key budget. Best-effort without it.
  const key = process.env.COINGECKO_API_KEY;
  if (key) headers["x-cg-demo-api-key"] = key;
  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${vsLower}&include_24hr_change=true`,
      { headers, signal: AbortSignal.timeout(SECTION_TIMEOUT_MS) },
    );
    if (resp.status === 429 || resp.status === 403) {
      bench("coingecko");
      return out;
    }
    if (!resp.ok) return out;
    const data = (await resp.json()) as Record<string, Record<string, unknown>>;
    for (const sym of symbols) {
      const row = data?.[COINS[sym].id];
      const price = parseNum(row?.[vsLower]);
      if (price === null) continue;
      const chg = parseNum(row?.[`${vsLower}_24h_change`]);
      out.set(sym, {
        price,
        changePct: chg !== null ? roundSig(chg, 4) : null,
        high24h: null,
        low24h: null,
        source: "coingecko",
      });
    }
    return out;
  } catch {
    bench("coingecko");
    return out;
  }
}

async function cryptoSection(
  symbols: string[],
  vs: string,
  findings: Finding[],
): Promise<Array<Record<string, unknown>> | null> {
  const now = nowFn();
  const rows = new Map<string, CryptoRow>();
  const missing: string[] = [];
  for (const sym of symbols) {
    const hit = cryptoCache.get(`${sym}:${vs}`);
    if (hit && now - hit.at < CRYPTO_TTL_MS) rows.set(sym, hit.row);
    else missing.push(sym);
  }

  // Per-symbol provider chain, not per-section all-or-nothing: Coinbase legs
  // concurrently, then one Kraken and one CoinGecko batch for the stragglers.
  if (missing.length > 0 && !isBenched("coinbase-exchange")) {
    const settled = await Promise.allSettled(missing.map((sym) => fetchCoinbaseRow(sym, vs)));
    settled.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value !== null) rows.set(missing[i], r.value);
    });
  }
  let still = missing.filter((s) => !rows.has(s));
  if (still.length > 0 && !isBenched("kraken")) {
    for (const [sym, row] of await fetchKrakenRows(still, vs)) rows.set(sym, row);
  }
  still = missing.filter((s) => !rows.has(s));
  if (still.length > 0 && !isBenched("coingecko")) {
    for (const [sym, row] of await fetchGeckoRows(still, vs)) rows.set(sym, row);
    for (const sym of still) {
      if (rows.get(sym)?.source === "coingecko") {
        findings.push({
          rule: "high_low_unavailable",
          detail: `${sym}: priced via CoinGecko fallback — high_24h/low_24h are null`,
        });
      }
    }
  }

  for (const sym of missing) {
    const row = rows.get(sym);
    if (row) cryptoCache.set(`${sym}:${vs}`, { at: now, row });
  }

  const out: Array<Record<string, unknown>> = [];
  for (const sym of symbols) {
    const row = rows.get(sym);
    if (!row) {
      findings.push({
        rule: "symbol_unavailable",
        detail: `${sym}: every price provider failed for this call`,
      });
      continue;
    }
    out.push({
      symbol: sym,
      price: row.price,
      change_24h_pct: row.changePct,
      high_24h: row.high24h,
      low_24h: row.low24h,
      source: row.source,
    });
  }
  return out.length > 0 ? out : null;
}

// --- Fiat section ------------------------------------------------------------
// Same chain as /currency-exchange/batch: frankfurter (canonical .dev host —
// the legacy .app host intermittently 5xxes) → fawazahmed0 CDN (two mirror
// hosts, effectively unburnable) → open.er-api.com. One USD-based table
// derives all four crosses (EUR/GBP = USD/GBP ÷ USD/EUR).

function deriveFiatRates(usd: { eur: number; gbp: number; jpy: number }): Record<string, number> {
  return {
    "USD/EUR": roundSig(usd.eur, 6),
    "USD/GBP": roundSig(usd.gbp, 6),
    "USD/JPY": roundSig(usd.jpy, 6),
    "EUR/GBP": roundSig(usd.gbp / usd.eur, 6),
  };
}

async function fetchFiat(): Promise<FiatData | null> {
  if (!isBenched("frankfurter")) {
    try {
      const resp = await fetch("https://api.frankfurter.dev/v1/latest?from=USD", {
        signal: AbortSignal.timeout(SECTION_TIMEOUT_MS),
      });
      if (resp.status === 429 || resp.status === 403) bench("frankfurter");
      else if (resp.ok) {
        const body = (await resp.json()) as { date?: string; rates?: Record<string, unknown> };
        const eur = parseNum(body?.rates?.EUR);
        const gbp = parseNum(body?.rates?.GBP);
        const jpy = parseNum(body?.rates?.JPY);
        if (eur !== null && gbp !== null && jpy !== null) {
          return {
            rates: deriveFiatRates({ eur, gbp, jpy }),
            rateDate: body?.date ?? new Date(nowFn()).toISOString().slice(0, 10),
            source: "frankfurter",
          };
        }
      }
    } catch {
      bench("frankfurter");
    }
  }
  if (!isBenched("currency-api")) {
    // Static CDN files, lowercase codes; jsdelivr first, then the pages.dev mirror.
    for (const url of [
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
      "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
    ]) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(SECTION_TIMEOUT_MS) });
        if (!resp.ok) continue;
        const body = (await resp.json()) as { date?: string; usd?: Record<string, unknown> };
        const eur = parseNum(body?.usd?.eur);
        const gbp = parseNum(body?.usd?.gbp);
        const jpy = parseNum(body?.usd?.jpy);
        if (eur !== null && gbp !== null && jpy !== null) {
          return {
            rates: deriveFiatRates({ eur, gbp, jpy }),
            rateDate: body?.date ?? new Date(nowFn()).toISOString().slice(0, 10),
            source: "currency-api",
          };
        }
      } catch {
        // try the mirror before benching the provider
      }
    }
    bench("currency-api");
  }
  if (!isBenched("er-api")) {
    try {
      const resp = await fetch("https://open.er-api.com/v6/latest/USD", {
        signal: AbortSignal.timeout(SECTION_TIMEOUT_MS),
      });
      if (resp.status === 429 || resp.status === 403) bench("er-api");
      else if (resp.ok) {
        const body = (await resp.json()) as {
          time_last_update_utc?: string;
          rates?: Record<string, unknown>;
        };
        const eur = parseNum(body?.rates?.EUR);
        const gbp = parseNum(body?.rates?.GBP);
        const jpy = parseNum(body?.rates?.JPY);
        if (eur !== null && gbp !== null && jpy !== null) {
          return {
            rates: deriveFiatRates({ eur, gbp, jpy }),
            rateDate: new Date(nowFn()).toISOString().slice(0, 10),
            source: "er-api",
          };
        }
      }
    } catch {
      bench("er-api");
    }
  }
  return null;
}

async function fiatSection(): Promise<Array<Record<string, unknown>> | null> {
  const now = nowFn();
  const hit = fiatCache.get("fiat");
  let data: FiatData | null =
    hit && now - hit.at < FIAT_TTL_MS ? hit.data : await fetchFiat();
  if (data && (!hit || data !== hit.data)) fiatCache.set("fiat", { at: now, data });
  if (!data) return null;
  const d = data;
  return FIAT_PAIRS.map((pair) => ({ pair, rate: d.rates[pair], rate_date: d.rateDate }));
}

// --- Gas section -------------------------------------------------------------

/** eth_gasPrice via the chain's RPC rotation; per-provider benches. */
async function fetchGasRow(chain: string): Promise<GasRow | null> {
  for (const rpc of GAS_CHAINS[chain]) {
    if (isBenched(rpc)) continue;
    try {
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
        signal: AbortSignal.timeout(SECTION_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = (await resp.json()) as { result?: unknown };
      const wei = parseHexWei(body?.result);
      if (wei === null) throw new Error("invalid eth_gasPrice");
      // Keep sub-gwei L2 precision (0.012 gwei is normal on Base).
      return { gasPriceGwei: roundSig(Number(wei) / 1e9, 9), source: rpc };
    } catch {
      bench(rpc);
    }
  }
  return null;
}

/** Coinbase spot ETH-USD for the transfer_usd estimate; null only degrades the usd field. */
async function getEthUsd(): Promise<number | null> {
  const now = nowFn();
  const hit = spotCache.get("ETH");
  if (hit && now - hit.at < SPOT_TTL_MS) return hit.price;
  try {
    const resp = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", {
      signal: AbortSignal.timeout(SECTION_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { data?: { amount?: string } };
    const price = parseNum(body?.data?.amount);
    if (price !== null) spotCache.set("ETH", { at: now, price });
    return price;
  } catch {
    return null;
  }
}

async function gasSection(findings: Finding[]): Promise<Array<Record<string, unknown>> | null> {
  const now = nowFn();
  const [rows, ethUsd] = await Promise.all([
    Promise.all(
      Object.keys(GAS_CHAINS).map(async (chain) => {
        const hit = gasCache.get(chain);
        if (hit && now - hit.at < GAS_TTL_MS) return { chain, row: hit.row as GasRow | null };
        const fresh = await fetchGasRow(chain);
        if (fresh) gasCache.set(chain, { at: now, row: fresh });
        return { chain, row: fresh };
      }),
    ),
    getEthUsd(),
  ]);
  if (ethUsd === null) {
    findings.push({
      rule: "native_price_unavailable",
      detail: "ETH-USD spot unavailable — gas transfer_usd estimates are null",
    });
  }
  const out: Array<Record<string, unknown>> = [];
  for (const { chain, row } of rows) {
    if (!row) {
      findings.push({ rule: "chain_unavailable", detail: `${chain}: every RPC in the rotation failed` });
      continue;
    }
    out.push({
      chain,
      gas_price_gwei: row.gasPriceGwei,
      transfer_usd:
        ethUsd === null
          ? null
          : roundSig((row.gasPriceGwei * TRANSFER_GAS_UNITS * ethUsd) / 1e9, 6),
    });
  }
  return out.length > 0 ? out : null;
}

// --- Sentiment section -------------------------------------------------------
// Single-source garnish (alternative.me fear/greed) — a failure is a null +
// finding, NEVER retried elsewhere. Values arrive as strings; limit=2 gives
// today (data[0]) and yesterday (data[1]).

async function sentimentSection(): Promise<SentimentData | null> {
  const now = nowFn();
  const hit = sentimentCache.get("fng");
  if (hit && now - hit.at < SENTIMENT_TTL_MS) return hit.data;
  if (isBenched("alternative-me")) return null;
  try {
    const resp = await fetch("https://api.alternative.me/fng/?limit=2", {
      signal: AbortSignal.timeout(SECTION_TIMEOUT_MS),
    });
    if (resp.status === 429 || resp.status === 403) {
      bench("alternative-me");
      return null;
    }
    if (!resp.ok) return null;
    const body = (await resp.json()) as {
      data?: Array<{ value?: unknown; value_classification?: unknown }>;
    };
    const today = body?.data?.[0];
    const value = parseNum(today?.value);
    if (value === null) return null;
    const data: SentimentData = {
      value: Math.round(value),
      classification: typeof today?.value_classification === "string" ? today.value_classification : "Unknown",
      yesterday: (() => {
        const y = parseNum(body?.data?.[1]?.value);
        return y === null ? null : Math.round(y);
      })(),
    };
    sentimentCache.set("fng", { at: now, data });
    return data;
  } catch {
    bench("alternative-me");
    return null;
  }
}

// --- Route handler -----------------------------------------------------------

marketSnapshotRouter.get("/market/snapshot", async (req: Request, res: Response) => {
  try {
    const rawSymbols = pickRequestParam(req, SYMBOL_ALIASES);
    let symbols = [...DEFAULT_SYMBOLS];
    const dropped: string[] = [];
    if (rawSymbols) {
      const tokens = rawSymbols.split(",").map((s) => s.trim()).filter(Boolean);
      if (tokens.length > MAX_SYMBOLS) {
        res.status(400).json({
          error: `Too many symbols: ${tokens.length}. Max ${MAX_SYMBOLS} for the snapshot — use /crypto/price for bigger lists.`,
        });
        return;
      }
      const resolved: string[] = [];
      for (const token of tokens) {
        const cleaned = token.replace(/^\$/, "").trim();
        const symbol = COINS[cleaned.toUpperCase()]
          ? cleaned.toUpperCase()
          : NAME_TO_SYMBOL.get(cleaned.toLowerCase());
        if (symbol) {
          if (!resolved.includes(symbol)) resolved.push(symbol);
        } else if (!dropped.includes(cleaned)) {
          dropped.push(cleaned);
        }
      }
      if (resolved.length === 0 && tokens.length > 0) {
        res.status(400).json({
          error:
            `Unknown symbols: ${dropped.join(", ")}. Full names like "bitcoin" also work. ` +
            `Supported symbols: ${Object.keys(COINS).join(", ")}.`,
        });
        return;
      }
      if (resolved.length > 0) symbols = resolved;
    }

    const rawVs = pickRequestParam(req, VS_ALIASES);
    const vs = (rawVs ?? "USD").trim().toUpperCase();
    if (!SUPPORTED_VS.has(vs)) {
      res.status(400).json({
        error: `Unsupported vs ${JSON.stringify(String(rawVs).slice(0, 48))}. Supported: USD, EUR, GBP (aliases: currency, fiat, vs_currency).`,
      });
      return;
    }

    const now = nowFn();
    const cacheKey = `${symbols.join(",")}:${vs}`;

    const cachedSnap = snapshotCache.get(cacheKey);
    if (cachedSnap && now - cachedSnap.at < SNAPSHOT_TTL_MS) {
      res.json({ ...cachedSnap.body, cache_age_seconds: Math.round((now - cachedSnap.at) / 1000) });
      return;
    }

    const findings: Finding[] = [];
    // All four sections concurrently — a dead section is a null + finding.
    const [crypto, fiat, gas, sentiment] = await Promise.all([
      cryptoSection(symbols, vs, findings).catch(() => null),
      fiatSection().catch(() => null),
      gasSection(findings).catch(() => null),
      sentimentSection().catch(() => null),
    ]);

    const sections: Array<[string, unknown]> = [
      ["crypto", crypto],
      ["fiat", fiat],
      ["gas", gas],
      ["sentiment", sentiment],
    ];
    const sectionsOk = sections.filter(([, v]) => v !== null).length;

    if (sectionsOk === 0) {
      // Whole-snapshot stale-serve last resort, then our miss → 502 uncharged.
      if (cachedSnap && now - cachedSnap.at <= SNAPSHOT_STALE_MAX_MS) {
        const ageS = Math.round((now - cachedSnap.at) / 1000);
        const staleFindings = [
          ...((cachedSnap.body.findings as Finding[] | undefined) ?? []),
          {
            rule: "stale_data",
            detail: `every section failed this call — serving the last good snapshot, ${ageS}s old`,
          },
        ];
        res.json({ ...cachedSnap.body, stale: true, cache_age_seconds: ageS, findings: staleFindings });
        return;
      }
      res.status(502).json({ error: "Upstream market data unavailable for every section" });
      return;
    }

    for (const [name, value] of sections) {
      if (value === null) {
        findings.push({ rule: "section_unavailable", detail: `${name}: section upstreams failed for this call` });
      }
    }
    if (dropped.length > 0) {
      findings.push({
        rule: "unresolved_symbols",
        detail: `${dropped.join(", ")}: not in the supported symbol map — skipped`,
      });
    }

    const body: Record<string, unknown> = {
      generated_at: new Date(now).toISOString(),
      vs,
      crypto,
      fiat,
      gas,
      sentiment,
      sections_ok: sectionsOk,
      stale: false,
      cache_age_seconds: 0,
      findings,
    };
    snapshotCache.set(cacheKey, { at: now, body });
    res.json(body);
  } catch (err) {
    console.error("Market snapshot error:", err);
    res.status(500).json({ error: "Upstream market data unavailable" });
  }
});
