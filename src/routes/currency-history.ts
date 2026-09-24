import { Router, type Request, type Response } from "express";
import { pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const currencyHistoryRouter = Router();

// --- Aliases (house input-field-leniency rule) -------------------------------

const FROM_ALIASES = ["from", "base", "source", "source_currency", "from_currency"];
const TO_ALIASES = ["to", "target", "quote", "target_currency", "to_currency"];
const START_ALIASES = ["start", "from_date", "start_date"];
const END_ALIASES = ["end", "to_date", "end_date"];
const DAYS_ALIASES = ["days", "period", "lookback"];

// --- Code space --------------------------------------------------------------
// Same pair space as /currency-exchange/convert and its batch sibling: ECB
// currencies get the frankfurter range path, the full ISO 4217 tail gets the
// per-date CDN path, crypto tickers get Coinbase daily candles.

const ECB_FIAT = new Set(
  ("AUD BGN BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW " +
    "MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR HRK").split(" "),
);

const FIAT = new Set(
  ("AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND " +
    "BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF " +
    "DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD " +
    "HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW " +
    "KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU " +
    "MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR " +
    "PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD " +
    "SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU " +
    "UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL").split(" "),
);

// Same roster as /crypto/price and /currency-exchange/batch — no symbol search.
const CRYPTO = new Set(
  ("BTC ETH USDT BNB SOL USDC XRP DOGE TON ADA TRX AVAX SHIB LINK DOT BCH " +
    "NEAR POL LTC ICP UNI ETC APT XLM ATOM XMR FIL HBAR ARB VET IMX OP MKR " +
    "INJ GRT RENDER AAVE SUI SEI PEPE ALGO FTM STX RUNE FLOW KAS TIA JUP WLD " +
    "CRO LDO QNT GALA FET XTZ BONK").split(" "),
);

// Coinbase Exchange lists daily candles for major pairs against these quotes.
const CRYPTO_VS = new Set(["USD", "EUR", "GBP"]);

const DAY_MS = 86_400_000;
// Range caps per path: frankfurter serves any range in one call (366 = a leap
// year of trend), the CDN path costs one fetch PER DATE (hence the tight cap),
// and Coinbase rejects requests implying more than 300 candles.
const MAX_DAYS_ECB = 366;
const MAX_DAYS_CDN = 90;
const MAX_DAYS_CRYPTO = 300;
// fawazahmed0 date-versioned files exist from this date onward.
const CDN_FLOOR_MS = Date.UTC(2024, 3, 1);
const CDN_FLOOR_STR = "2024-04-01";
const CDN_CONCURRENCY = 8;
// >10% of requested dates missing = data too holey to bill for.
const CDN_MISSING_TOLERANCE = 0.1;

// --- Cache / cooldown state (house provider-chain pattern, inlined) ----------
// History is immutable — only today's point churns, once a day — so 6h TTL per
// exact query, stale ceiling 48h. The ECB 90-day XML is one process-wide fetch
// cached 6h that serves every fallback query. Daily-data bench: 15 minutes.
const CACHE_TTL_MS = 6 * 60 * 60_000;
const STALE_MAX_MS = 48 * 60 * 60_000;
const BENCH_MS = 15 * 60_000;
const ECB_XML_TTL_MS = 6 * 60 * 60_000;
// The XML file only holds ~90 days of data — longer ranges would come back
// silently truncated, so the fallback is reserved for ranges it can cover.
const ECB_XML_MAX_DAYS = 90;

interface Point {
  date: string;
  rate: number;
}

interface Finding {
  rule: string;
  detail: string;
}

interface HistoryPayload {
  from: string;
  to: string;
  start: string;
  end: string;
  series: Point[];
  stats: {
    min: number;
    max: number;
    average: number;
    change_pct: number;
    volatility_pct: number;
  };
  point_count: number;
  source: string;
  findings: Finding[];
}

const historyCache = new Map<string, { at: number; payload: HistoryPayload }>(); // key = FROM:TO:start:end
const benchedUntil = new Map<string, number>(); // key = provider name
let ecbXmlCache: { at: number; table: Map<string, Record<string, number>> } | null = null;

// Injectable clock so tests can advance time without sleeping.
let nowFn: () => number = Date.now;

/** Test-only: clear all module-level state (result cache, XML cache, benches). */
export function __resetCurrencyHistoryState(): void {
  historyCache.clear();
  benchedUntil.clear();
  ecbXmlCache = null;
}

/** Test-only: override (or with no arg, restore) the clock. */
export function __setCurrencyHistoryNow(fn?: () => number): void {
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

function roundSig(value: number, sig = 8): number {
  if (!isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(sig));
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Strict YYYY-MM-DD → UTC-midnight ms, rejecting impossible calendar dates. */
function parseDate(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

function volatilityPct(rates: number[]): number {
  const changes: number[] = [];
  for (let i = 1; i < rates.length; i++) {
    if (rates[i - 1] !== 0) changes.push(((rates[i] - rates[i - 1]) / rates[i - 1]) * 100);
  }
  if (changes.length === 0) return 0;
  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((s, c) => s + (c - mean) ** 2, 0) / changes.length;
  return Math.sqrt(variance);
}

function computeStats(series: Point[]): HistoryPayload["stats"] {
  const rates = series.map((p) => p.rate);
  const first = rates[0];
  const last = rates[rates.length - 1];
  return {
    min: roundSig(Math.min(...rates)),
    max: roundSig(Math.max(...rates)),
    average: roundSig(rates.reduce((a, b) => a + b, 0) / rates.length),
    change_pct: first !== 0 ? Math.round(((last - first) / first) * 10000) / 100 : 0,
    volatility_pct: Math.round(volatilityPct(rates) * 100) / 100,
  };
}

// --- Upstream fetchers -------------------------------------------------------

/**
 * frankfurter native date-range API — one call for the whole series. Canonical
 * api.frankfurter.dev/v1 host per the sibling routes (the legacy .app host
 * intermittently 5xxes). Response keys rates by date: { rates: { "2026-07-02":
 * { EUR: 0.92 } } }. ECB publishes business days only — the series simply
 * contains fewer dates than the calendar range. Throws on any trouble.
 */
async function fetchFrankfurterRange(
  from: string,
  to: string,
  startStr: string,
  endStr: string,
): Promise<Point[]> {
  const resp = await fetch(
    `https://api.frankfurter.dev/v1/${startStr}..${endStr}?from=${from}&to=${to}`,
    { signal: AbortSignal.timeout(timeouts.currencyHistory) },
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as { rates?: Record<string, Record<string, unknown>> };
  if (!data?.rates || typeof data.rates !== "object") throw new Error("malformed response");
  const points: Point[] = [];
  for (const [date, byCur] of Object.entries(data.rates)) {
    const rate = byCur?.[to];
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      points.push({ date, rate: roundSig(rate) });
    }
  }
  if (points.length === 0) throw new Error("empty series");
  points.sort((a, b) => (a.date < b.date ? -1 : 1));
  return points;
}

/**
 * The ECB 90-day reference-rate XML, parsed with a string walk (no XML
 * dependency) into date → { CUR: rate-per-EUR }. One fetch serves every
 * fallback query for 6h — effectively unburnable. Throws on any trouble.
 */
async function getEcbXmlTable(): Promise<Map<string, Record<string, number>>> {
  const now = nowFn();
  if (ecbXmlCache && now - ecbXmlCache.at < ECB_XML_TTL_MS) return ecbXmlCache.table;
  const resp = await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml", {
    signal: AbortSignal.timeout(timeouts.currencyHistory),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const xml = await resp.text();
  const table = new Map<string, Record<string, number>>();
  const dayRe = /<Cube time="(\d{4}-\d{2}-\d{2})"[^>]*>([\s\S]*?)<\/Cube>/g;
  const rateRe = /<Cube currency="([A-Z]{3})" rate="([\d.]+)"/g;
  let dayMatch: RegExpExecArray | null;
  while ((dayMatch = dayRe.exec(xml)) !== null) {
    const rates: Record<string, number> = {};
    let rateMatch: RegExpExecArray | null;
    rateRe.lastIndex = 0;
    while ((rateMatch = rateRe.exec(dayMatch[2])) !== null) {
      const v = parseFloat(rateMatch[2]);
      if (Number.isFinite(v) && v > 0) rates[rateMatch[1]] = v;
    }
    if (Object.keys(rates).length > 0) table.set(dayMatch[1], rates);
  }
  if (table.size === 0) throw new Error("no parseable days in XML");
  ecbXmlCache = { at: now, table };
  return table;
}

/** FROM→TO series from the EUR-based XML table via EUR triangulation. */
function seriesFromEcbXml(
  table: Map<string, Record<string, number>>,
  from: string,
  to: string,
  startMs: number,
  endMs: number,
): Point[] {
  const points: Point[] = [];
  for (const [date, rates] of table) {
    const ms = parseDate(date);
    if (ms === null || ms < startMs || ms > endMs) continue;
    // EUR-based table: EUR→X = rates[X]; USD→EUR = 1 / rates[USD]; cross pairs
    // triangulate through EUR: FROM→TO = rates[TO] / rates[FROM].
    let rate: number | undefined;
    if (from === "EUR") rate = rates[to];
    else if (to === "EUR") rate = rates[from] ? 1 / rates[from] : undefined;
    else rate = rates[from] && rates[to] ? rates[to] / rates[from] : undefined;
    if (rate !== undefined && Number.isFinite(rate) && rate > 0) {
      points.push({ date, rate: roundSig(rate) });
    }
  }
  points.sort((a, b) => (a.date < b.date ? -1 : 1));
  return points;
}

/**
 * One fawazahmed0 CDN date file (jsdelivr, then the pages.dev mirror). HISTORY
 * pins the date-versioned URL per day — never the @latest alias. jsdelivr's
 * version tag is unpadded (2024.4.1); the mirror subdomain is ISO. Returns the
 * rate or null for a missing/unusable date — never throws (a static CDN has no
 * outage mode worth benching; a bad date is just a hole in the series).
 */
async function fetchCdnDate(fromLower: string, toLower: string, dateMs: number): Promise<number | null> {
  const d = new Date(dateMs);
  const tag = `${d.getUTCFullYear()}.${d.getUTCMonth() + 1}.${d.getUTCDate()}`;
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${tag}/v1/currencies/${fromLower}.json`,
    `https://${fmtDate(dateMs)}.currency-api.pages.dev/v1/currencies/${fromLower}.json`,
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(timeouts.currencyHistory) });
      if (!resp.ok) continue;
      const data = (await resp.json()) as Record<string, unknown>;
      const rates = data?.[fromLower];
      if (!rates || typeof rates !== "object") continue;
      const rate = (rates as Record<string, unknown>)[toLower];
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) return roundSig(rate);
    } catch {
      // fall through to the mirror / to null
    }
  }
  return null;
}

type CandleOutcome = { status: "ok"; closes: Map<string, number> } | { status: "miss" } | { status: "fail" };

/**
 * Coinbase Exchange daily candles for SYM-VS. Rows arrive NEWEST first as
 * [time, low, high, open, close, volume]; the request end is the LAST candle
 * bucket because Coinbase treats both bounds as inclusive and rejects ranges
 * implying >300 candles. Returns date → daily close.
 */
async function fetchCoinbaseDailyCloses(
  sym: string,
  vs: string,
  startMs: number,
  endMs: number,
): Promise<CandleOutcome> {
  try {
    const qs = new URLSearchParams({
      granularity: "86400",
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    });
    const resp = await fetch(`https://api.exchange.coinbase.com/products/${sym}-${vs}/candles?${qs}`, {
      signal: AbortSignal.timeout(timeouts.currencyHistory),
    });
    if (resp.status === 429 || resp.status === 403) {
      bench("coinbase");
      return { status: "fail" };
    }
    if (resp.status === 404) return { status: "miss" }; // product never listed
    if (!resp.ok) return { status: "fail" };
    const body = (await resp.json()) as unknown;
    if (!Array.isArray(body)) return { status: "fail" };
    const closes = new Map<string, number>();
    for (const row of body) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const time = Number(row[0]);
      const close = Number(row[4]);
      if (!Number.isFinite(time) || !Number.isFinite(close) || close <= 0) continue;
      const ms = time * 1000;
      if (ms < startMs || ms > endMs) continue;
      closes.set(fmtDate(ms), close);
    }
    if (closes.size === 0) return { status: "miss" };
    return { status: "ok", closes };
  } catch {
    bench("coinbase");
    return { status: "fail" };
  }
}

// --- Route handler -----------------------------------------------------------

currencyHistoryRouter.get("/currency-exchange/history", async (req: Request, res: Response) => {
  try {
    const fromRaw = pickRequestParam(req, FROM_ALIASES);
    const toRaw = pickRequestParam(req, TO_ALIASES);
    if (!fromRaw) {
      res.status(400).json({
        error:
          "from is required — pass the base currency code, e.g. ?from=USD&to=EUR&days=30 (aliases: base, source).",
      });
      return;
    }
    if (!toRaw) {
      res.status(400).json({
        error:
          "to is required — pass one target code, e.g. ?from=USD&to=EUR&days=30 (aliases: target, quote).",
      });
      return;
    }

    const from = fromRaw.replace(/^\$/, "").toUpperCase();
    const to = toRaw.replace(/^\$/, "").toUpperCase();
    for (const [name, code] of [["from", from], ["to", to]] as const) {
      if (!FIAT.has(code) && !CRYPTO.has(code)) {
        res.status(400).json({
          error: `Unsupported ${name} currency: ${code.slice(0, 12)}. Use an ISO 4217 fiat code (USD, EUR, SAR, …) or a major crypto ticker (BTC, ETH, SOL, …).`,
        });
        return;
      }
    }
    if (from === to) {
      res.status(400).json({
        error: `from and to are both ${from} — a same-currency series is 1.0 on every date. Pass two different codes.`,
      });
      return;
    }

    // --- Date range: explicit start/end, or a days lookback ending today. ---
    const now = nowFn();
    const todayMs = parseDate(fmtDate(now))!;

    const endRaw = pickRequestParam(req, END_ALIASES);
    let endMs = todayMs;
    let endClamped = false;
    if (endRaw !== undefined) {
      const parsed = parseDate(endRaw);
      if (parsed === null) {
        res.status(400).json({ error: `Invalid end date ${JSON.stringify(endRaw.slice(0, 24))} — use YYYY-MM-DD (alias: to_date).` });
        return;
      }
      endMs = parsed;
      if (endMs > todayMs) {
        endMs = todayMs;
        endClamped = true;
      }
    }

    const startRaw = pickRequestParam(req, START_ALIASES);
    const daysRaw = pickRequestParam(req, DAYS_ALIASES);
    let startMs: number;
    if (startRaw !== undefined) {
      const parsed = parseDate(startRaw);
      if (parsed === null) {
        res.status(400).json({ error: `Invalid start date ${JSON.stringify(startRaw.slice(0, 24))} — use YYYY-MM-DD (alias: from_date).` });
        return;
      }
      if (parsed > todayMs) {
        res.status(400).json({ error: `start ${fmtDate(parsed)} is in the future — history exists only for past dates.` });
        return;
      }
      startMs = parsed;
    } else {
      // Lookback window ending at `end`: days counts calendar dates inclusive.
      let days = 30;
      if (daysRaw !== undefined) {
        const n = Number(daysRaw);
        if (!Number.isFinite(n) || n < 1) {
          res.status(400).json({ error: `Invalid days ${JSON.stringify(daysRaw.slice(0, 24))} — pass a number of days >= 1 (alias: period), or explicit start/end dates.` });
          return;
        }
        days = Math.floor(n);
      }
      startMs = endMs - (days - 1) * DAY_MS;
    }
    if (startMs > endMs) {
      res.status(400).json({ error: `start ${fmtDate(startMs)} is after end ${fmtDate(endMs)} — swap them.` });
      return;
    }
    const dateCount = Math.round((endMs - startMs) / DAY_MS) + 1;

    // --- Pair classification → provider path + range cap. ---
    const fromCrypto = CRYPTO.has(from);
    const toCrypto = CRYPTO.has(to);
    let mode: "ecb" | "cdn" | "crypto";
    if (!fromCrypto && !toCrypto) {
      mode = ECB_FIAT.has(from) && ECB_FIAT.has(to) ? "ecb" : "cdn";
    } else if (fromCrypto && toCrypto) {
      res.status(400).json({
        error: `Crypto↔crypto history (${from}→${to}) is not supported — one side must be a fiat quote (USD, EUR or GBP). Cross two calls through USD instead.`,
      });
      return;
    } else {
      const vs = fromCrypto ? to : from;
      if (!CRYPTO_VS.has(vs)) {
        res.status(400).json({
          error: `Crypto history is quoted in USD, EUR or GBP only — ${vs} is not a supported quote. Fetch the pair vs USD and the ${vs} fiat series separately.`,
        });
        return;
      }
      mode = "crypto";
    }

    const cap = mode === "ecb" ? MAX_DAYS_ECB : mode === "cdn" ? MAX_DAYS_CDN : MAX_DAYS_CRYPTO;
    if (dateCount > cap) {
      const why =
        mode === "ecb"
          ? `ECB fiat ranges cap at ${MAX_DAYS_ECB} days`
          : mode === "cdn"
            ? `${from}→${to} needs one upstream fetch per date, so the range caps at ${MAX_DAYS_CDN} days`
            : `crypto ranges cap at ${MAX_DAYS_CRYPTO} days (one daily candle each)`;
      res.status(400).json({
        error: `Requested range spans ${dateCount} days — ${why}. Narrow start/end or lower days.`,
      });
      return;
    }
    if (mode === "cdn" && startMs < CDN_FLOOR_MS) {
      res.status(400).json({
        error: `History for non-ECB fiat pairs like ${from}→${to} starts at ${CDN_FLOOR_STR} (the daily-file archive floor) — move start to ${CDN_FLOOR_STR} or later.`,
      });
      return;
    }

    const startStr = fmtDate(startMs);
    const endStr = fmtDate(endMs);
    const cacheKey = `${from}:${to}:${startStr}:${endStr}`;
    const hit = historyCache.get(cacheKey);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      res.json({ ...hit.payload, cache_age_seconds: Math.round((now - hit.at) / 1000), stale: false });
      return;
    }

    // --- Resolve the series through the mode's provider chain. ---
    let series: Point[] | null = null;
    let source = "";
    const findings: Finding[] = [];
    if (endClamped) {
      findings.push({ rule: "end_clamped", detail: `requested end was in the future — clamped to today (${endStr})` });
    }

    if (mode === "ecb") {
      if (!isBenched("frankfurter")) {
        try {
          series = await fetchFrankfurterRange(from, to, startStr, endStr);
          source = "frankfurter";
        } catch {
          bench("frankfurter");
        }
      }
      if (!series && dateCount <= ECB_XML_MAX_DAYS && !isBenched("ecb-xml")) {
        try {
          const table = await getEcbXmlTable();
          const fallback = seriesFromEcbXml(table, from, to, startMs, endMs);
          if (fallback.length > 0) {
            series = fallback;
            source = "ecb-xml";
          }
        } catch {
          bench("ecb-xml");
        }
      }
      if (series && series.length < dateCount) {
        findings.push({
          rule: "non_trading_days_omitted",
          detail: "ECB publishes business days only — weekends and holidays have no reference rate and are omitted, never interpolated",
        });
      }
    } else if (mode === "cdn") {
      const fromLower = from.toLowerCase();
      const toLower = to.toLowerCase();
      const dates: number[] = [];
      for (let ms = startMs; ms <= endMs; ms += DAY_MS) dates.push(ms);
      const points: Point[] = [];
      for (let i = 0; i < dates.length; i += CDN_CONCURRENCY) {
        const wave = dates.slice(i, i + CDN_CONCURRENCY);
        const settled = await Promise.allSettled(wave.map((ms) => fetchCdnDate(fromLower, toLower, ms)));
        settled.forEach((r, j) => {
          if (r.status === "fulfilled" && r.value !== null) {
            points.push({ date: fmtDate(wave[j]), rate: r.value });
          }
        });
      }
      const missing = dateCount - points.length;
      // Data quality floor: a series with >10% holes (with a 2-date grace so
      // short ranges aren't failed by a single unpublished file) is not a
      // billable answer.
      const toleratedMissing = Math.max(2, Math.ceil(dateCount * CDN_MISSING_TOLERANCE));
      if (points.length > 0 && missing <= toleratedMissing) {
        points.sort((a, b) => (a.date < b.date ? -1 : 1));
        series = points;
        source = "currency-api";
        if (missing > 0) {
          findings.push({
            rule: "missing_dates_omitted",
            detail: `${missing} of ${dateCount} requested dates had no published rate file and were omitted, never interpolated`,
          });
        }
      }
    } else {
      const sym = fromCrypto ? from : to;
      const vs = fromCrypto ? to : from;
      if (!isBenched("coinbase")) {
        const r = await fetchCoinbaseDailyCloses(sym, vs, startMs, endMs);
        if (r.status === "miss") {
          res.status(400).json({
            error: `Coinbase Exchange has no daily candles for ${sym}-${vs}${vs !== "USD" ? " — try the pair vs USD" : ""}.`,
          });
          return;
        }
        if (r.status === "ok") {
          const points: Point[] = [];
          for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
            const close = r.closes.get(fmtDate(ms));
            if (close === undefined) continue;
            // rate = units of `to` per 1 `from`, matching /currency-exchange/convert:
            // BTC→USD is the close itself; USD→BTC is its inverse.
            points.push({ date: fmtDate(ms), rate: roundSig(fromCrypto ? close : 1 / close) });
          }
          if (points.length > 0) {
            series = points;
            source = "coinbase";
            if (points.length < dateCount) {
              findings.push({
                rule: "partial_window",
                detail: `${points.length} of ${dateCount} requested daily candles available — the window may predate the pair's listing on Coinbase`,
              });
            }
          }
        }
      }
    }

    if (series) {
      const payload: HistoryPayload = {
        from,
        to,
        start: startStr,
        end: endStr,
        series,
        stats: computeStats(series),
        point_count: series.length,
        source,
        findings,
      };
      historyCache.set(cacheKey, { at: now, payload });
      res.json({ ...payload, cache_age_seconds: 0, stale: false });
      return;
    }

    // Stale-serve last resort: younger than the 48h ceiling → billed 200 + finding.
    const stale = historyCache.get(cacheKey);
    if (stale && now - stale.at <= STALE_MAX_MS) {
      const ageS = Math.round((now - stale.at) / 1000);
      res.json({
        ...stale.payload,
        findings: [
          ...stale.payload.findings,
          { rule: "stale_data", detail: `every provider failed this call — serving the last good series, ${ageS}s old` },
        ],
        cache_age_seconds: ageS,
        stale: true,
      });
      return;
    }

    // No primary answer and nothing to stale-serve — our miss, 502 uncharged.
    res.status(502).json({ error: "Upstream exchange-rate history unavailable from every provider" });
  } catch (err) {
    console.error("Currency history error:", err);
    res.status(500).json({ error: "Upstream exchange-rate history unavailable" });
  }
});
