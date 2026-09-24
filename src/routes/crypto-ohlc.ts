import { Router, type Request, type Response } from "express";
import { pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const cryptoOhlcRouter = Router();

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

// Full display name (lowercase) → symbol, so ?symbol=bitcoin also resolves.
const NAME_TO_SYMBOL = new Map(
  Object.entries(COINS).map(([sym, c]) => [c.name.toLowerCase(), sym]),
);

const SYMBOL_ALIASES = ["symbol", "coin", "ticker", "asset"];
const INTERVAL_ALIASES = ["interval", "granularity", "timeframe"];
const DAYS_ALIASES = ["days", "period"];
// `limit` = number of most-recent candles — the universal candle-API parameter
// (Binance/Coinbase/Kraken all use it). Added after two paying agents on
// 2026-08-24 passed limit= and had it silently ignored (they got the default
// window, not the candle count they asked for). We convert it to a window.
const LIMIT_ALIASES = ["limit", "count", "candles", "num_candles"];
const DATE_ALIASES = ["date"];
const VS_ALIASES = ["vs", "currency", "fiat", "vs_currency"];
const SUPPORTED_VS = new Set(["USD", "EUR", "GBP"]);

const INTERVALS: Record<string, "1h" | "1d"> = {
  "1h": "1h",
  hour: "1h",
  hourly: "1h",
  "1d": "1d",
  day: "1d",
  daily: "1d",
};
// Both caps land on Coinbase's 300-candles-per-request ceiling — pre-validated
// here so OUR 400 (instructive) fires before Coinbase's (opaque).
const MAX_DAYS: Record<"1h" | "1d", number> = { "1h": 12, "1d": 300 };
// Max candles per interval = MAX_DAYS converted to candle count (Coinbase's
// 300/request ceiling): 12d×24 = 288 hourly, 300 daily.
const MAX_CANDLES: Record<"1h" | "1d", number> = { "1h": 288, "1d": 300 };
const DAY_SEC = 86400;
// Coinbase Exchange has no meaningful crypto candle data before this.
const MIN_DATE_MS = Date.UTC(2015, 0, 1);

// --- Cache / cooldown state (house provider-chain pattern, inlined) ----------
// History is immutable — only the newest candle churns — so a 5min TTL keyed by
// the quantized window bounds upstream load to ~1 round/5min/query shape at any
// paid volume. Stale-serve last resort ceiling 1h; daily-data bench 15min.
const CACHE_TTL_MS = 5 * 60_000;
const STALE_MAX_MS = 60 * 60_000;
const BENCH_MS = 15 * 60_000; // per-provider cooldown on 429/403/timeout/garbage

interface Candle {
  time: number; // unix seconds, candle open
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Finding {
  rule: string;
  detail: string;
}

interface OhlcPayload {
  symbol: string;
  vs: string;
  interval: "1h" | "1d";
  start: string;
  end: string;
  candles: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }>;
  stats: {
    open: number;
    close: number;
    change_pct: number | null;
    period_high: number;
    period_low: number;
    avg_volume: number;
  };
  price?: number; // date mode only: the requested day's close
  candle_count: number;
  source: string;
  findings: Finding[];
}

const ohlcCache = new Map<string, { at: number; payload: OhlcPayload }>(); // key = SYM:VS:interval:start:end
const benchedUntil = new Map<string, number>(); // key = coinbase | kraken

// Injectable clock so tests can advance time without sleeping.
let nowFn: () => number = Date.now;

/** Test-only: clear all module-level state (window cache, provider benches). */
export function __resetCryptoOhlcState(): void {
  ohlcCache.clear();
  benchedUntil.clear();
}

/** Test-only: override (or with no arg, restore) the clock. */
export function __setCryptoOhlcNow(fn?: () => number): void {
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

/** Window bounds render as dates for daily candles, full ISO for hourly. */
function fmtBoundary(sec: number, interval: "1h" | "1d"): string {
  const iso = new Date(sec * 1000).toISOString();
  return interval === "1d" ? iso.slice(0, 10) : iso;
}

// --- Upstream fetchers -------------------------------------------------------
// Outcome semantics matter for billing: "miss" is a DEFINITE pair-not-listed
// answer (product 404 / Kraken unknown-pair / zero candles), "fail" is an
// outage. Only an all-miss chain earns the 400; outages go stale-serve → 502.

type FetchOutcome = { status: "ok"; candles: Candle[] } | { status: "miss" } | { status: "fail" };

/**
 * Coinbase Exchange candles. Arrays arrive NEWEST first as
 * [time, low, high, open, close, volume] — the low/high/open order is not
 * ohlc-alphabetical; mapped positionally here. start/end are ISO strings; the
 * request end is the LAST candle bucket (endSec - granSec) because Coinbase
 * treats both bounds as inclusive and rejects ranges implying >300 candles.
 */
async function fetchCoinbaseCandles(
  symbol: string,
  vs: string,
  granSec: number,
  startSec: number,
  endSec: number,
): Promise<FetchOutcome> {
  try {
    const qs = new URLSearchParams({
      granularity: String(granSec),
      start: new Date(startSec * 1000).toISOString(),
      end: new Date((endSec - granSec) * 1000).toISOString(),
    });
    const resp = await fetch(
      `https://api.exchange.coinbase.com/products/${symbol}-${vs}/candles?${qs}`,
      { signal: AbortSignal.timeout(timeouts.cryptoOhlc) },
    );
    if (resp.status === 429 || resp.status === 403) {
      bench("coinbase");
      return { status: "fail" };
    }
    if (resp.status === 404) return { status: "miss" }; // product never listed
    if (!resp.ok) return { status: "fail" };
    const body = (await resp.json()) as unknown;
    if (!Array.isArray(body)) return { status: "fail" };
    const candles: Candle[] = [];
    for (const row of body) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const [time, low, high, open, close, volume] = row.map(Number);
      if (![time, low, high, open, close, volume].every(Number.isFinite)) continue;
      if (time < startSec || time >= endSec) continue;
      candles.push({ time, open, high, low, close, volume });
    }
    if (candles.length === 0) return { status: "miss" };
    candles.sort((a, b) => a.time - b.time); // normalize ascending-by-time
    return { status: "ok", candles };
  } catch {
    bench("coinbase");
    return { status: "fail" };
  }
}

/**
 * Kraken OHLC fallback. Gotchas per the batch handoff: BTC is XBT; the result
 * key is Kraken-internal (XXBTZUSD) so the single non-"last" key of result is
 * read, never string-matched; `since` is SECONDS; and Kraken returns up to 720
 * recent candles regardless — sliced to the requested window here. Values are
 * strings: parseFloat, NaN = missing not 0.
 */
async function fetchKrakenOhlc(
  symbol: string,
  vs: string,
  granSec: number,
  startSec: number,
  endSec: number,
): Promise<FetchOutcome> {
  const pair = `${symbol === "BTC" ? "XBT" : symbol}${vs}`;
  const krakenInterval = granSec === 3600 ? 60 : 1440;
  try {
    const resp = await fetch(
      `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${krakenInterval}&since=${startSec - granSec}`,
      { signal: AbortSignal.timeout(timeouts.cryptoOhlc) },
    );
    if (resp.status === 429 || resp.status === 403) {
      bench("kraken");
      return { status: "fail" };
    }
    if (!resp.ok) return { status: "fail" };
    const body = (await resp.json()) as {
      error?: unknown[];
      result?: Record<string, unknown>;
    };
    if (Array.isArray(body?.error) && body.error.length > 0) {
      // Unknown pair is a definite miss; any other Kraken error is an outage.
      return body.error.map(String).join(" ").includes("Unknown asset pair")
        ? { status: "miss" }
        : { status: "fail" };
    }
    const resultKey = Object.keys(body?.result ?? {}).find((k) => k !== "last");
    const rows = resultKey ? body!.result![resultKey] : undefined;
    if (!Array.isArray(rows)) return { status: "fail" };
    const candles: Candle[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 7) continue;
      // Kraken rows: [time, open, high, low, close, vwap, volume, count]
      const time = Number(row[0]);
      const open = parseFloat(String(row[1]));
      const high = parseFloat(String(row[2]));
      const low = parseFloat(String(row[3]));
      const close = parseFloat(String(row[4]));
      const volume = parseFloat(String(row[6]));
      if (![time, open, high, low, close, volume].every(Number.isFinite)) continue;
      if (time < startSec || time >= endSec) continue; // slice 720-candle tail to window
      candles.push({ time, open, high, low, close, volume });
    }
    if (candles.length === 0) return { status: "miss" };
    candles.sort((a, b) => a.time - b.time);
    return { status: "ok", candles };
  } catch {
    bench("kraken");
    return { status: "fail" };
  }
}

// --- Payload assembly --------------------------------------------------------

function buildPayload(
  symbol: string,
  vs: string,
  interval: "1h" | "1d",
  startSec: number,
  endSec: number,
  granSec: number,
  raw: Candle[],
  source: string,
  dateMode: boolean,
  findings: Finding[],
): OhlcPayload {
  const first = raw[0];
  const last = raw[raw.length - 1];
  const payload: OhlcPayload = {
    symbol,
    vs,
    interval,
    start: fmtBoundary(startSec, interval),
    end: fmtBoundary(endSec - granSec, interval),
    candles: raw.map((c) => ({
      time: new Date(c.time * 1000).toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
    stats: {
      open: first.open,
      close: last.close,
      change_pct:
        first.open !== 0 ? Math.round(((last.close - first.open) / first.open) * 10000) / 100 : null,
      period_high: Math.max(...raw.map((c) => c.high)),
      period_low: Math.min(...raw.map((c) => c.low)),
      avg_volume: Math.round((raw.reduce((s, c) => s + c.volume, 0) / raw.length) * 100) / 100,
    },
    candle_count: raw.length,
    source,
    findings,
  };
  if (dateMode) payload.price = last.close;
  return payload;
}

// --- Route handler -----------------------------------------------------------

cryptoOhlcRouter.get("/crypto/ohlc", async (req: Request, res: Response) => {
  try {
    const rawSymbol = pickRequestParam(req, SYMBOL_ALIASES);
    if (!rawSymbol) {
      res.status(400).json({
        error:
          'Missing symbol. Pass ?symbol=BTC — one ticker or a full name like "bitcoin" ' +
          "(aliases: coin, ticker, asset; a leading $ is fine).",
      });
      return;
    }
    const cleaned = String(rawSymbol).replace(/^\$/, "").trim();
    const symbol = COINS[cleaned.toUpperCase()]
      ? cleaned.toUpperCase()
      : NAME_TO_SYMBOL.get(cleaned.toLowerCase());
    if (!symbol) {
      // The full list rides in the 400 — an agent that guessed wrong should be
      // one retry away from right.
      res.status(400).json({
        error:
          `Unknown symbol ${JSON.stringify(cleaned.slice(0, 48))}. Full names like "bitcoin" also work. ` +
          `Supported symbols: ${Object.keys(COINS).join(", ")}.`,
      });
      return;
    }

    const rawInterval = pickRequestParam(req, INTERVAL_ALIASES);
    let interval: "1h" | "1d" = "1d";
    if (rawInterval) {
      const mapped = INTERVALS[String(rawInterval).trim().toLowerCase()];
      if (!mapped) {
        res.status(400).json({
          error:
            `Unsupported interval ${JSON.stringify(String(rawInterval).slice(0, 48))}. ` +
            "Supported: 1h (hour, hourly) or 1d (day, daily; the default). Aliases: granularity, timeframe.",
        });
        return;
      }
      interval = mapped;
    }
    const granSec = interval === "1h" ? 3600 : DAY_SEC;

    const rawVs = pickRequestParam(req, VS_ALIASES);
    const vs = (rawVs ?? "USD").trim().toUpperCase();
    if (!SUPPORTED_VS.has(vs)) {
      res.status(400).json({
        error: `Unsupported vs ${JSON.stringify(String(rawVs).slice(0, 48))}. Supported: USD, EUR, GBP (aliases: currency, fiat, vs_currency).`,
      });
      return;
    }

    const rawDate = pickRequestParam(req, DATE_ALIASES);
    const rawDays = pickRequestParam(req, DAYS_ALIASES);
    const rawLimit = pickRequestParam(req, LIMIT_ALIASES);
    const hasLimit = rawLimit !== undefined && rawLimit !== null && String(rawLimit).trim() !== "";
    const hasDays = rawDays !== undefined && rawDays !== null && String(rawDays).trim() !== "";
    if (rawDate && (hasDays || hasLimit)) {
      res.status(400).json({
        error:
          "date is mutually exclusive with days/limit — date returns the single daily candle for that day; days/limit return a lookback window. Pass one.",
      });
      return;
    }

    const now = nowFn();
    const nowSec = Math.floor(now / 1000);
    let startSec: number;
    let endSec: number;
    let dateMode = false;
    // Set when a `limit` request exceeds the per-interval ceiling and we cap it,
    // so the response can flag it instead of silently returning fewer candles.
    let limitCappedTo: number | null = null;

    if (rawDate) {
      if (rawInterval && interval === "1h") {
        res.status(400).json({
          error: "date mode returns the single DAILY candle for that day — omit interval or pass 1d.",
        });
        return;
      }
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(rawDate).trim());
      if (!m) {
        res.status(400).json({
          error: `Invalid date ${JSON.stringify(String(rawDate).slice(0, 48))}. Use YYYY-MM-DD, e.g. date=2026-07-15.`,
        });
        return;
      }
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const ms = Date.UTC(y, mo - 1, d);
      const check = new Date(ms);
      if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
        res.status(400).json({ error: `Invalid calendar date ${m[0]} — that day does not exist.` });
        return;
      }
      if (ms > now) {
        res.status(400).json({ error: `date ${m[0]} is in the future — candles exist only for past days.` });
        return;
      }
      if (ms < MIN_DATE_MS) {
        res.status(400).json({ error: `date ${m[0]} predates coverage — earliest supported date is 2015-01-01.` });
        return;
      }
      dateMode = true;
      startSec = ms / 1000;
      endSec = startSec + DAY_SEC;
    } else if (hasLimit) {
      // `limit` = number of most-recent candles (the universal candle-API param).
      // Convert to a window; cap at the per-interval ceiling and flag if capped
      // rather than erroring — agents expect limit to clamp, not reject.
      const n = Number(String(rawLimit).trim());
      if (!Number.isFinite(n) || n < 1) {
        res.status(400).json({
          error: `Invalid limit ${JSON.stringify(String(rawLimit).slice(0, 48))} — pass a number of candles >= 1 (aliases: count, candles).`,
        });
        return;
      }
      let count = Math.floor(n);
      if (count > MAX_CANDLES[interval]) {
        limitCappedTo = MAX_CANDLES[interval];
        count = MAX_CANDLES[interval];
      }
      // Quantize to candle boundaries for a stable cache key.
      endSec = Math.floor(nowSec / granSec) * granSec + granSec;
      startSec = endSec - count * granSec;
    } else {
      // Default 30 days; the 1h default is its own 12-day cap so an interval-only
      // call never trips the cap it did not choose.
      let days = interval === "1h" ? 12 : 30;
      if (hasDays) {
        const n = Number(String(rawDays).trim());
        if (!Number.isFinite(n) || n < 1) {
          res.status(400).json({
            error: `Invalid days ${JSON.stringify(String(rawDays).slice(0, 48))} — pass a number of days >= 1 (alias: period).`,
          });
          return;
        }
        days = Math.floor(n);
      }
      if (days > MAX_DAYS[interval]) {
        res.status(400).json({
          error:
            interval === "1h"
              ? `days caps at 12 for 1h candles (288 candles; got ${days}) — use interval=1d for longer lookbacks, or limit=N for a candle count.`
              : `days caps at 300 for 1d candles (300 candles; got ${days}).`,
        });
        return;
      }
      // Quantize the window to candle boundaries so the cache key is stable for
      // the life of the newest candle; the 5min TTL handles its churn.
      endSec = Math.floor(nowSec / granSec) * granSec + granSec;
      startSec = endSec - days * DAY_SEC;
    }

    const cacheKey = `${symbol}:${vs}:${interval}:${startSec}:${endSec}`;
    const hit = ohlcCache.get(cacheKey);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      res.json({ ...hit.payload, cache_age_seconds: Math.round((now - hit.at) / 1000), stale: false });
      return;
    }

    const outcomes: Array<"miss" | "fail"> = [];
    let success: { candles: Candle[]; source: string } | null = null;

    if (!isBenched("coinbase")) {
      const r = await fetchCoinbaseCandles(symbol, vs, granSec, startSec, endSec);
      if (r.status === "ok") success = { candles: r.candles, source: "coinbase" };
      else outcomes.push(r.status);
    }
    if (!success && !isBenched("kraken")) {
      const r = await fetchKrakenOhlc(symbol, vs, granSec, startSec, endSec);
      if (r.status === "ok") success = { candles: r.candles, source: "kraken" };
      else outcomes.push(r.status);
    }

    if (success) {
      const findings: Finding[] = [];
      if (limitCappedTo !== null) {
        findings.push({
          rule: "limit_capped",
          detail: `limit exceeds the ${interval} ceiling — returned the most recent ${limitCappedTo} candles (max for ${interval}; use interval=1d for a longer span).`,
        });
      }
      const expected = dateMode ? 1 : Math.round((endSec - startSec) / granSec);
      if (success.candles.length < expected) {
        findings.push({
          rule: "partial_window",
          detail: `${success.candles.length} of ${expected} requested candles available — the window may predate the pair's listing on ${success.source}`,
        });
      }
      const payload = buildPayload(
        symbol, vs, interval, startSec, endSec, granSec,
        success.candles, success.source, dateMode, findings,
      );
      ohlcCache.set(cacheKey, { at: now, payload });
      res.json({ ...payload, cache_age_seconds: 0, stale: false });
      return;
    }

    // Every provider that responded gave a DEFINITE pair miss → instructive 400
    // uncharged. Any outage in the mix falls through to stale-serve instead.
    if (outcomes.length > 0 && outcomes.every((o) => o === "miss")) {
      res.status(400).json({
        error:
          `Unknown or unlisted pair ${symbol}-${vs} — neither Coinbase Exchange nor Kraken has candles for it` +
          `${vs !== "USD" ? "; try vs=USD" : ""}.`,
      });
      return;
    }

    // Stale-serve last resort: younger than the 1h ceiling → billed 200 + finding.
    const stale = ohlcCache.get(cacheKey);
    if (stale && now - stale.at <= STALE_MAX_MS) {
      const ageS = Math.round((now - stale.at) / 1000);
      res.json({
        ...stale.payload,
        findings: [
          ...stale.payload.findings,
          {
            rule: "stale_data",
            detail: `every provider failed this call — serving the last good window, ${ageS}s old`,
          },
        ],
        cache_age_seconds: ageS,
        stale: true,
      });
      return;
    }

    // No primary answer and nothing to stale-serve — our miss, 502 uncharged.
    res.status(502).json({ error: "Upstream OHLC data unavailable from every provider" });
  } catch (err) {
    console.error("Crypto OHLC error:", err);
    res.status(500).json({ error: "Upstream OHLC data unavailable" });
  }
});
