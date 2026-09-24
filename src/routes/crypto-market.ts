import { Router, type Request, type Response } from "express";
import { checkSsrf, ValidationError } from "../utils/validators.js";
import { pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const cryptoMarketRouter = Router();

// --- Symbol map (top ~50 assets by market cap, static for v1) ----------------
// symbol → CoinGecko id + display name. Static by design: resolving unknown
// symbols via CoinGecko /search would burn the shared-Railway-egress rate
// budget — the exact failure mode that broke ip-geo. Revisit via the miss-log
// if unknown-symbol 400s cluster.
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

// Full display name (lowercase) → symbol, so ?symbol=bitcoin also resolves.
const NAME_TO_SYMBOL = new Map(
  Object.entries(COINS).map(([sym, c]) => [c.name.toLowerCase(), sym]),
);

const SYMBOL_ALIASES = ["symbol", "coin", "ticker", "asset"];
const VS_ALIASES = ["vs", "currency", "fiat"];
// Coinbase Exchange has {SYM}-{VS} pairs for these; CoinGecko takes them as
// vs_currency. A coin missing an EUR/GBP Coinbase pair degrades to CoinGecko.
const SUPPORTED_VS = new Set(["USD", "EUR", "GBP"]);

// --- 60s merged-result cache -------------------------------------------------
// Mandatory, not an optimization: CoinGecko free is per-IP rate-limited and our
// Railway egress IP is shared, so the cache is what bounds upstream calls to
// ~1 round/min/symbol regardless of paid volume. Covers BOTH upstreams' merged
// result; cache_age_seconds in the response keeps the staleness honest.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; body: Record<string, unknown> }>();

// Injectable clock so tests can advance time without sleeping.
let nowFn: () => number = Date.now;

/** Test-only: clear the merged-result cache so cases don't bleed into one another. */
export function __resetCryptoMarketCache(): void {
  cache.clear();
}

/** Test-only: override (or with no arg, restore) the cache clock. */
export function __setCryptoMarketNow(fn?: () => number): void {
  nowFn = fn ?? Date.now;
}

// --- Upstream fetchers -------------------------------------------------------

interface Finding {
  rule: string;
  detail: string;
}

/** Coinbase numbers arrive as strings ("64749.68"); NaN → missing, never 0. */
function parseNum(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function roundSig(value: number, sig = 8): number {
  if (!isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(sig));
}

async function fetchJson(url: string): Promise<unknown | null> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeouts.cryptoMarket) });
  if (!resp.ok) return null;
  return resp.json();
}

interface CoinbaseData {
  price: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  /** 24h volume in BASE units (BTC, not USD) — converted to quote at merge. */
  volumeBase: number | null;
}

/** Coinbase Exchange ticker + stats for {SYM}-{VS}, concurrently. Null when the pair is unusable. */
async function fetchCoinbase(symbol: string, vs: string): Promise<CoinbaseData | null> {
  try {
    await checkSsrf("api.exchange.coinbase.com");
    const base = `https://api.exchange.coinbase.com/products/${symbol}-${vs}`;
    const [ticker, stats] = await Promise.all([
      fetchJson(`${base}/ticker`).catch(() => null),
      fetchJson(`${base}/stats`).catch(() => null),
    ]);
    const t = (ticker ?? {}) as Record<string, unknown>;
    const s = (stats ?? {}) as Record<string, unknown>;
    const data: CoinbaseData = {
      // stats `last` backs up the ticker price when only one call succeeded.
      price: parseNum(t.price) ?? parseNum(s.last),
      open: parseNum(s.open),
      high: parseNum(s.high),
      low: parseNum(s.low),
      volumeBase: parseNum(s.volume),
    };
    return data.price === null && data.open === null ? null : data;
  } catch {
    return null;
  }
}

interface GeckoData {
  price: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  changeAbs: number | null;
  changePct: number | null;
  marketCap: number | null;
  rank: number | null;
  circulating: number | null;
  total: number | null;
  max: number | null;
}

/** CoinGecko keyless /coins/markets row for the coin id. Null on any failure (never blocks the response). */
async function fetchGecko(id: string, vs: string): Promise<GeckoData | null> {
  try {
    await checkSsrf("api.coingecko.com");
    const data = await fetchJson(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${vs.toLowerCase()}&ids=${encodeURIComponent(id)}`,
    );
    if (!Array.isArray(data) || data.length === 0) return null;
    const row = data[0] as Record<string, unknown>;
    return {
      price: parseNum(row.current_price),
      high: parseNum(row.high_24h),
      low: parseNum(row.low_24h),
      volume: parseNum(row.total_volume),
      changeAbs: parseNum(row.price_change_24h),
      changePct: parseNum(row.price_change_percentage_24h),
      marketCap: parseNum(row.market_cap),
      rank: parseNum(row.market_cap_rank),
      circulating: parseNum(row.circulating_supply),
      total: parseNum(row.total_supply),
      max: parseNum(row.max_supply),
    };
  } catch {
    return null;
  }
}

// --- Route handler -----------------------------------------------------------

cryptoMarketRouter.get("/crypto/market", async (req: Request, res: Response) => {
  try {
    // Input-correction findings are per-REQUEST and merged into the response at
    // send time — never into the cached body, which is shared with callers who
    // passed the same (symbol, vs) explicitly.
    const inputFindings: Finding[] = [];

    const rawSymbol = pickRequestParam(req, SYMBOL_ALIASES);
    // Bare requests default to BTC instead of 400ing: Bazaar's pinned resource
    // URL strips query strings, so discovery-driven clients call the naked
    // /crypto/market — the observed #1 failure mode for this endpoint.
    let cleaned: string;
    if (!rawSymbol) {
      cleaned = "BTC";
      inputFindings.push({
        rule: "symbol_defaulted",
        detail:
          'no symbol provided — defaulted to BTC (pass ?symbol=…, aliases coin/ticker/asset; full names like "bitcoin" work)',
      });
    } else {
      cleaned = rawSymbol.replace(/^\$/, "").trim();
    }
    const symbol = COINS[cleaned.toUpperCase()]
      ? cleaned.toUpperCase()
      : NAME_TO_SYMBOL.get(cleaned.toLowerCase());
    if (!symbol) {
      // The full list rides in the 400 — there is nowhere else it's published,
      // and an agent that guessed wrong should be one retry away from right.
      res.status(400).json({
        error:
          `Unknown symbol "${cleaned}". Full names like "bitcoin" also work. ` +
          `Supported symbols: ${Object.keys(COINS).join(", ")}.`,
      });
      return;
    }
    const coin = COINS[symbol];

    const rawVs = pickRequestParam(req, VS_ALIASES);
    let vs = (rawVs ?? "USD").toUpperCase().trim();
    if (!SUPPORTED_VS.has(vs)) {
      // Symbol intent is clear; a garbage vs (LLM agents leak prompt text into
      // this optional slot) shouldn't cost the caller the whole answer.
      inputFindings.push({
        rule: "vs_defaulted",
        detail: `unrecognized vs ${JSON.stringify(String(rawVs).slice(0, 48))} — defaulted to USD (supported: USD, EUR, GBP)`,
      });
      vs = "USD";
    }

    const now = nowFn();
    const cacheKey = `${symbol}:${vs}`;
    const hit = cache.get(cacheKey);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      res.json({
        ...hit.body,
        cache_age_seconds: Math.round((now - hit.at) / 1000),
        findings: [...inputFindings, ...((hit.body.findings as Finding[]) ?? [])],
      });
      return;
    }

    const [cbResult, cgResult] = await Promise.allSettled([
      fetchCoinbase(symbol, vs),
      fetchGecko(coin.id, vs),
    ]);
    const cb = cbResult.status === "fulfilled" ? cbResult.value : null;
    const cg = cgResult.status === "fulfilled" ? cgResult.value : null;

    const price = cb?.price ?? cg?.price ?? null;
    if (price === null) {
      // Neither source produced a price — our miss, never billed (5xx uncharged).
      res.status(502).json({ error: "Upstream market data unavailable" });
      return;
    }

    const findings: Finding[] = [];
    if (!cb) {
      findings.push({
        rule: "trade_data_degraded",
        detail:
          "Coinbase Exchange did not answer for this pair — price and 24h stats served from CoinGecko; open_24h is unavailable there and is null",
      });
    }
    if (!cg) {
      findings.push({
        rule: "metadata_unavailable",
        detail:
          "CoinGecko metadata was unavailable this call (rate limit or outage) — market_cap, market_cap_rank and supply are null; price and 24h stats are from Coinbase",
      });
    }

    // change vs the 24h open when Coinbase served both legs; else CoinGecko's.
    let changeAbs: number | null = null;
    let changePct: number | null = null;
    if (cb?.price !== null && cb?.price !== undefined && cb.open !== null && cb.open !== 0) {
      changeAbs = roundSig(cb.price - cb.open);
      changePct = Math.round(((cb.price - cb.open) / cb.open) * 10000) / 100;
    } else if (cg) {
      changeAbs = cg.changeAbs;
      changePct = cg.changePct;
    }

    // Coinbase reports 24h volume in base units; convert at the current price so
    // volume_24h is always quoted in `vs`. NOTE it is then Coinbase-local volume
    // (one exchange), while the CoinGecko fallback is market-wide.
    const volume =
      cb?.volumeBase !== null && cb?.volumeBase !== undefined
        ? roundSig(cb.volumeBase * price)
        : cg?.volume ?? null;

    const body: Record<string, unknown> = {
      symbol,
      name: coin.name,
      vs,
      price,
      change_24h: changeAbs,
      change_24h_pct: changePct,
      high_24h: cb?.high ?? cg?.high ?? null,
      low_24h: cb?.low ?? cg?.low ?? null,
      open_24h: cb?.open ?? null,
      volume_24h: volume,
      market_cap: cg?.marketCap ?? null,
      market_cap_rank: cg?.rank ?? null,
      supply: {
        circulating: cg?.circulating ?? null,
        total: cg?.total ?? null,
        max: cg?.max ?? null,
      },
      last_updated: new Date(now).toISOString(),
      cache_age_seconds: 0,
      source: cb && cg ? "coinbase+coingecko" : cb ? "coinbase" : "coingecko",
      findings,
    };

    // Cache carries only the degradation findings; input corrections ride on
    // this response alone.
    cache.set(cacheKey, { at: now, body });
    res.json({ ...body, findings: [...inputFindings, ...findings] });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Crypto market error:", err);
    res.status(500).json({ error: "Upstream market data unavailable" });
  }
});
