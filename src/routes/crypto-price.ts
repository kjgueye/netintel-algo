import { Router, type Request, type Response } from "express";
import { pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const cryptoPriceRouter = Router();

// --- Symbol map (top ~50 assets by market cap, static for v1) ----------------
// Copied verbatim from crypto-market.ts per the Finance batch handoff: resolving
// unknown symbols via CoinGecko /search would burn the shared-Railway-egress
// rate budget — the exact failure mode that broke ip-geo. Revisit via the
// miss-log if unknown-symbol 400s cluster.
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

// Full display name (lowercase) → symbol, so ?symbols=bitcoin also resolves.
const NAME_TO_SYMBOL = new Map(
  Object.entries(COINS).map(([sym, c]) => [c.name.toLowerCase(), sym]),
);

const SYMBOL_ALIASES = ["symbols", "symbol", "coins", "coin", "tickers", "ticker", "assets"];
const VS_ALIASES = ["vs", "currency", "fiat", "vs_currency"];
const SUPPORTED_VS = new Set(["USD", "EUR", "GBP"]);
const MAX_SYMBOLS = 25;
// Coinbase spot is one fetch per symbol — cap the concurrent in-flight legs.
const COINBASE_CONCURRENCY = 8;

// --- Cache / cooldown state (house provider-chain pattern, inlined) ----------
// Spot moves fast and agents poll — 30s TTL per symbol bounds upstream load to
// ~2 rounds/min/symbol at any paid volume. Stale-serve last resort ceiling 10min.
const CACHE_TTL_MS = 30_000;
const STALE_MAX_MS = 10 * 60_000;
const BENCH_MS = 5 * 60_000; // per-provider cooldown on 429/403/timeout/garbage

interface PriceEntry {
  price: number;
  changePct: number | null;
  source: string;
}

const priceCache = new Map<string, { at: number; entry: PriceEntry }>(); // key = SYM:VS
const benchedUntil = new Map<string, number>(); // key = coinbase | coingecko | kraken

// Injectable clock so tests can advance time without sleeping.
let nowFn: () => number = Date.now;

/** Test-only: clear all module-level state (price cache, provider benches). */
export function __resetCryptoPriceState(): void {
  priceCache.clear();
  benchedUntil.clear();
}

/** Test-only: override (or with no arg, restore) the clock. */
export function __setCryptoPriceNow(fn?: () => number): void {
  nowFn = fn ?? Date.now;
}

// --- Helpers -----------------------------------------------------------------

interface Finding {
  rule: string;
  detail: string;
}

function isBenched(provider: string): boolean {
  const until = benchedUntil.get(provider);
  return until !== undefined && nowFn() < until;
}

function bench(provider: string): void {
  benchedUntil.set(provider, nowFn() + BENCH_MS);
}

// --- Upstream fetchers -------------------------------------------------------

/**
 * One Coinbase spot leg. A 404 is a definite pair miss (fall through to the
 * next provider for this symbol only); 429/403/timeout/garbage benches the
 * whole provider — never pay a dead provider's timeout on every call.
 * Coinbase amounts arrive as strings: parseFloat, NaN = missing not 0.
 */
async function fetchCoinbaseSpot(symbol: string, vs: string): Promise<number | null> {
  try {
    const resp = await fetch(`https://api.coinbase.com/v2/prices/${symbol}-${vs}/spot`, {
      signal: AbortSignal.timeout(timeouts.cryptoPrice),
    });
    if (resp.status === 429 || resp.status === 403) {
      bench("coinbase");
      return null;
    }
    if (!resp.ok) return null; // unlisted pair → miss for this symbol only
    const body = (await resp.json()) as { data?: { amount?: string } };
    const price = parseFloat(body?.data?.amount ?? "");
    return Number.isFinite(price) ? price : null;
  } catch {
    bench("coinbase");
    return null;
  }
}

/** ONE CoinGecko simple/price call for every still-missing symbol. Response is keyed by coingecko id — mapped back here. */
async function fetchGeckoBatch(symbols: string[], vs: string): Promise<Map<string, PriceEntry>> {
  const out = new Map<string, PriceEntry>();
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
      { headers, signal: AbortSignal.timeout(timeouts.cryptoPrice) },
    );
    if (resp.status === 429 || resp.status === 403) {
      bench("coingecko");
      return out;
    }
    if (!resp.ok) return out;
    const data = (await resp.json()) as Record<string, Record<string, unknown>>;
    for (const sym of symbols) {
      const row = data?.[COINS[sym].id];
      const price = row?.[vsLower];
      if (typeof price !== "number" || !Number.isFinite(price)) continue;
      const chg = row?.[`${vsLower}_24h_change`];
      out.set(sym, {
        price,
        changePct: typeof chg === "number" && Number.isFinite(chg) ? chg : null,
        source: "coingecko",
      });
    }
    return out;
  } catch {
    bench("coingecko");
    return out;
  }
}

/**
 * One Kraken Ticker call for the stragglers. Gotchas per the batch handoff:
 * BTC is XBT, and result keys are Kraken-internal (XXBTZUSD) — so values are
 * zipped back to the requested symbols in request order, never string-matched.
 */
async function fetchKrakenBatch(symbols: string[], vs: string): Promise<Map<string, PriceEntry>> {
  const out = new Map<string, PriceEntry>();
  const pairs = symbols.map((s) => `${s === "BTC" ? "XBT" : s}${vs}`).join(",");
  try {
    const resp = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`, {
      signal: AbortSignal.timeout(timeouts.cryptoPrice),
    });
    if (resp.status === 429 || resp.status === 403) {
      bench("kraken");
      return out;
    }
    if (!resp.ok) return out;
    const body = (await resp.json()) as {
      error?: unknown[];
      result?: Record<string, { c?: unknown[] }>;
    };
    // Kraken fails the WHOLE request if any pair is unknown — an error here
    // just means these stragglers stay unpriced, not a provider bench.
    if (!body?.result || (Array.isArray(body.error) && body.error.length > 0)) return out;
    const rows = Object.values(body.result);
    if (rows.length !== symbols.length) return out; // order-zip only safe on exact match
    symbols.forEach((sym, i) => {
      const c = rows[i]?.c;
      const price = Array.isArray(c) ? parseFloat(String(c[0])) : NaN;
      if (Number.isFinite(price)) out.set(sym, { price, changePct: null, source: "kraken" });
    });
    return out;
  } catch {
    bench("kraken");
    return out;
  }
}

// --- Route handler -----------------------------------------------------------

cryptoPriceRouter.get("/crypto/price", async (req: Request, res: Response) => {
  try {
    const raw = pickRequestParam(req, SYMBOL_ALIASES);
    if (!raw) {
      res.status(400).json({
        error:
          'Missing symbols. Pass ?symbols=BTC,ETH — a comma list of 1–25 tickers or full names like "bitcoin" ' +
          "(aliases: symbol, coins, coin, tickers, ticker, assets; a leading $ is fine).",
      });
      return;
    }
    const tokens = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (tokens.length === 0) {
      res.status(400).json({
        error: "No symbols found. Pass ?symbols=BTC,ETH — a comma list of 1–25 tickers.",
      });
      return;
    }
    if (tokens.length > MAX_SYMBOLS) {
      res.status(400).json({
        error: `Too many symbols: ${tokens.length}. Max ${MAX_SYMBOLS} per call — split the list across calls.`,
      });
      return;
    }

    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const token of tokens) {
      const cleaned = token.replace(/^\$/, "").trim();
      const symbol = COINS[cleaned.toUpperCase()]
        ? cleaned.toUpperCase()
        : NAME_TO_SYMBOL.get(cleaned.toLowerCase());
      if (symbol) {
        if (!resolved.includes(symbol)) resolved.push(symbol);
      } else if (!unresolved.includes(cleaned)) {
        unresolved.push(cleaned);
      }
    }
    if (resolved.length === 0) {
      // The full list rides in the 400 — an agent that guessed wrong should be
      // one retry away from right.
      res.status(400).json({
        error:
          `Unknown symbols: ${unresolved.join(", ")}. Full names like "bitcoin" also work. ` +
          `Supported symbols: ${Object.keys(COINS).join(", ")}.`,
      });
      return;
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

    // Batch response is assembled from cache + fresh fetches: per-symbol 30s
    // cache first, then the provider chain for whatever is missing.
    const cached = new Map<string, { entry: PriceEntry; ageMs: number }>();
    const missing: string[] = [];
    for (const sym of resolved) {
      const hit = priceCache.get(`${sym}:${vs}`);
      if (hit && now - hit.at < CACHE_TTL_MS) {
        cached.set(sym, { entry: hit.entry, ageMs: now - hit.at });
      } else {
        missing.push(sym);
      }
    }

    const found = new Map<string, PriceEntry>();

    // 1. Coinbase spot — one leg per symbol, in waves of 8. A mid-request bench
    // (429 on one leg) stops later waves; legs already in flight still land.
    for (let i = 0; i < missing.length; i += COINBASE_CONCURRENCY) {
      if (isBenched("coinbase")) break;
      const wave = missing.slice(i, i + COINBASE_CONCURRENCY);
      const settled = await Promise.allSettled(wave.map((sym) => fetchCoinbaseSpot(sym, vs)));
      settled.forEach((r, j) => {
        if (r.status === "fulfilled" && r.value !== null) {
          found.set(wave[j], { price: r.value, changePct: null, source: "coinbase" });
        }
      });
    }

    // 2. CoinGecko simple/price — ONE call for everything still missing.
    let still = missing.filter((s) => !found.has(s));
    if (still.length > 0 && !isBenched("coingecko")) {
      for (const [sym, entry] of await fetchGeckoBatch(still, vs)) found.set(sym, entry);
    }

    // 3. Kraken Ticker for the stragglers.
    still = missing.filter((s) => !found.has(s));
    if (still.length > 0 && !isBenched("kraken")) {
      for (const [sym, entry] of await fetchKrakenBatch(still, vs)) found.set(sym, entry);
    }

    for (const [sym, entry] of found) priceCache.set(`${sym}:${vs}`, { at: now, entry });

    const findings: Finding[] = [];
    const prices: Array<Record<string, unknown>> = [];
    const unavailable: string[] = [];
    let anyStale = false;

    for (const sym of resolved) {
      const freshHit = cached.get(sym);
      const fetched = found.get(sym);
      if (freshHit || fetched) {
        const entry = freshHit ? freshHit.entry : fetched!;
        const ageMs = freshHit ? freshHit.ageMs : 0;
        prices.push({
          symbol: sym,
          name: COINS[sym].name,
          price: entry.price,
          change_24h_pct: entry.changePct,
          source: entry.source,
          cache_age_seconds: Math.round(ageMs / 1000),
        });
        continue;
      }
      // Stale-serve last resort: younger than the ceiling → billed 200 + finding.
      const stale = priceCache.get(`${sym}:${vs}`);
      if (stale && now - stale.at <= STALE_MAX_MS) {
        anyStale = true;
        const ageS = Math.round((now - stale.at) / 1000);
        prices.push({
          symbol: sym,
          name: COINS[sym].name,
          price: stale.entry.price,
          change_24h_pct: stale.entry.changePct,
          source: stale.entry.source,
          cache_age_seconds: ageS,
        });
        findings.push({
          rule: "stale_data",
          detail: `${sym}: every provider failed this call — serving the last good price, ${ageS}s old`,
        });
      } else {
        unavailable.push(sym);
      }
    }

    if (prices.length === 0) {
      // No primary answer for ANY resolvable symbol — our miss, 502 uncharged.
      res.status(502).json({ error: "Upstream price data unavailable for all requested symbols" });
      return;
    }

    if (unresolved.length > 0) {
      findings.push({
        rule: "unresolved_symbols",
        detail:
          `${unresolved.join(", ")}: not in the supported symbol map — skipped. ` +
          'Full names like "bitcoin" also work; an all-unknown call returns the full supported list.',
      });
    }
    if (unavailable.length > 0) {
      findings.push({
        rule: "price_unavailable",
        detail: `${unavailable.join(", ")}: every provider failed and no stale copy under 10 minutes old was available`,
      });
    }

    res.json({ vs, prices, unresolved, stale: anyStale, findings });
  } catch (err) {
    console.error("Crypto price error:", err);
    res.status(500).json({ error: "Upstream price data unavailable" });
  }
});
