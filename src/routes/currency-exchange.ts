import { Router, type Request, type Response } from "express";
import { checkSsrf, ValidationError } from "../utils/validators.js";
import { pickField } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const currencyExchangeRouter = Router();

// Synonyms agents send for the from/to currencies. Canonical `from`/`to` are
// listed first so an explicit value always wins; aliases are unambiguous
// currency synonyms only. Production data showed a `from is required` 400
// cluster (6 wallets, none retried) — paid intent, just a differently-named key.
const FROM_ALIASES = ["from", "base", "source", "source_currency", "from_currency", "fromCurrency"];
const TO_ALIASES = ["to", "target", "quote", "target_currency", "to_currency", "toCurrency"];

// Resolve a query field to a non-empty string, tolerating synonyms. Returns
// undefined for missing/array/empty values so the existing 400 guard still fires.
function queryString(query: unknown, keys: string[]): string | undefined {
  const v = pickField(query, keys);
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

// --- Constants ---

const SUPPORTED_CURRENCIES = new Set([
  "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP",
  "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR",
  "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD",
  "ZAR", "HRK",
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Legacy/alternate tickers Coinbase still lists under a different symbol. We try
// the requested ticker first, then the alias, so both spellings resolve.
const CRYPTO_ALIAS: Record<string, string> = { CELO: "CGLD" };

// Round to a fixed money precision: 2 decimals for fiat (in the ECB set), and
// ~8 significant figures for crypto/other so tiny amounts (e.g. USD→BTC) don't
// collapse to 0.00.
function roundMoney(value: number, currency: string): number {
  if (SUPPORTED_CURRENCIES.has(currency)) return Math.round(value * 100) / 100;
  return roundSig(value);
}
function roundSig(value: number, sig = 8): number {
  if (!isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(sig));
}

// --- Upstream rate cache (60s TTL) -----------------------------------------
// Collapses repeated upstream lookups into one request per ~60s window, keyed by
// URL. Especially effective for Coinbase, where every conversion sharing a base
// currency (e.g. all USD→crypto) hits the exact same URL — so a burst becomes a
// single upstream call. Bounds our exposure to upstream rate limits and serves
// cache hits instantly. Coinbase itself sets max-age=60, so 60s matches.
const RATE_CACHE_TTL_MS = 60_000;
const RATE_CACHE_MAX = 500; // simple bound; evict oldest insertion when exceeded
const rateCache = new Map<string, { at: number; data: unknown }>();

/** Test-only: clear the in-process rate cache so cases don't bleed into one another. */
export function __resetRateCache(): void {
  rateCache.clear();
}

type FetchResult = { ok: true; data: unknown } | { ok: false; status: number };

// Fetch JSON with the TTL cache. A non-2xx upstream returns { ok:false, status }
// (callers map 400→unsupported, else 502); network/timeout errors propagate to
// the caller's try/catch (→ 500), preserving prior behavior. Only 2xx is cached.
async function cachedFetchJson(url: string, timeoutMs: number): Promise<FetchResult> {
  const now = Date.now();
  const hit = rateCache.get(url);
  if (hit && now - hit.at < RATE_CACHE_TTL_MS) return { ok: true, data: hit.data };

  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) return { ok: false, status: resp.status };
  const data = await resp.json();

  if (rateCache.size >= RATE_CACHE_MAX) {
    const oldest = rateCache.keys().next().value;
    if (oldest !== undefined) rateCache.delete(oldest);
  }
  rateCache.set(url, { at: now, data });
  return { ok: true, data };
}

// Self-explanatory upstream-failure body. Names the cause, marks it transient,
// and states the call wasn't billed — these paths return 5xx and x402 settles
// only on status < 400, so the agent is never charged for an upstream miss. Keeps
// the stable "Exchange rate lookup failed" prefix for log grouping. `detail`
// should be a lowercase clause, e.g. "the upstream rate provider is temporarily
// unavailable (HTTP 520)".
function upstreamFailure(detail: string): { error: string } {
  return {
    error:
      `Exchange rate lookup failed — ${detail}. This is a transient upstream error, ` +
      `not a problem with your request; retry shortly. You were not charged.`,
  };
}

// --- CoinGecko fallback (long-tail tokens Coinbase doesn't list) -------------
// STRICTLY ADDITIVE: this is only ever invoked on the branches that already
// return "Unsupported currency code" today, and only when CURRENCY_FALLBACK is
// enabled. It NEVER throws into the handler — any failure (disabled, network,
// 429, ambiguous ticker, out-of-scope pair) returns null, so the caller falls
// back to the exact same 400 it returned before. The happy paths (ECB fiat,
// Coinbase-listed crypto) never reach here. Coinbase covers ~635 major coins;
// CoinGecko covers the long tail (e.g. AGIX). Scope: token↔vs-currency spot,
// plus cross rates for vs↔vs (via BTC, e.g. USD→SATS) and token↔token (via USD).

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const CG_META_TTL_MS = 24 * 60 * 60 * 1000; // coin list + vs-currency list change rarely

let coinListCache: { at: number; bySymbol: Map<string, string[]> } | null = null;
let vsCurrencyCache: { at: number; set: Set<string> } | null = null;

/** Test-only: clear CoinGecko metadata caches so cases don't bleed into one another. */
export function __resetCoinGeckoCache(): void {
  coinListCache = null;
  vsCurrencyCache = null;
}

/** Read the flag at call time so it can be toggled without a code change (Railway env). */
function fallbackEnabled(): boolean {
  const v = (process.env.CURRENCY_FALLBACK ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true";
}

/** GET CoinGecko JSON. Returns null on non-2xx (incl. 429); throws on network/timeout. */
async function cgFetchJson(path: string, timeoutMs: number): Promise<unknown | null> {
  await checkSsrf("api.coingecko.com");
  const key = process.env.COINGECKO_API_KEY;
  const resp = await fetch(`${COINGECKO_BASE}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: key ? { "x-cg-demo-api-key": key } : {},
  });
  if (!resp.ok) return null;
  return resp.json();
}

/** Lowercase set of currencies CoinGecko can price into (usd, eur, btc, eth, …). Cached 24h. */
async function getVsCurrencies(timeoutMs: number): Promise<Set<string>> {
  const now = Date.now();
  if (vsCurrencyCache && now - vsCurrencyCache.at < CG_META_TTL_MS) return vsCurrencyCache.set;
  const data = await cgFetchJson("/simple/supported_vs_currencies", timeoutMs);
  if (!Array.isArray(data)) throw new Error("vs-currency list unavailable");
  const set = new Set((data as unknown[]).filter((s): s is string => typeof s === "string").map((s) => s.toLowerCase()));
  vsCurrencyCache = { at: now, set };
  return set;
}

/** Resolve a ticker symbol → CoinGecko coin id; on ambiguity, pick the highest market cap. */
async function resolveCoinId(symbolLower: string, timeoutMs: number): Promise<string | null> {
  const now = Date.now();
  if (!coinListCache || now - coinListCache.at >= CG_META_TTL_MS) {
    const data = await cgFetchJson("/coins/list", timeoutMs);
    if (!Array.isArray(data)) throw new Error("coin list unavailable");
    const bySymbol = new Map<string, string[]>();
    for (const c of data as Array<{ id?: unknown; symbol?: unknown }>) {
      if (typeof c.id === "string" && typeof c.symbol === "string") {
        const s = c.symbol.toLowerCase();
        const arr = bySymbol.get(s) ?? [];
        arr.push(c.id);
        bySymbol.set(s, arr);
      }
    }
    coinListCache = { at: now, bySymbol };
  }
  const ids = coinListCache.bySymbol.get(symbolLower);
  if (!ids || ids.length === 0) return null;
  if (ids.length === 1) return ids[0];
  // Ambiguous ticker (several coins share the symbol): disambiguate by market cap.
  const markets = await cgFetchJson(
    `/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids.join(","))}&order=market_cap_desc&per_page=1&page=1`,
    timeoutMs,
  );
  if (Array.isArray(markets) && markets.length > 0 && typeof (markets[0] as { id?: unknown }).id === "string") {
    return (markets[0] as { id: string }).id;
  }
  return ids[0];
}

/**
 * Outcome of a fallback attempt:
 *   - "disabled": flag off → caller emits the exact original 400 (no behavior change).
 *   - "ok": a conversion body matching the crypto success shape.
 *   - "failed": flag on but no result; `reason` is a short diagnostic code the caller
 *     appends to the 400 so "not applied" vs "upstream unreachable" vs "ticker
 *     unknown" are distinguishable in production.
 */
type FallbackOutcome =
  | { status: "disabled" }
  | { status: "ok"; body: Record<string, unknown> }
  | { status: "failed"; reason: string };

/** A CoinGecko /simple/price quote: a positive finite number, or undefined. */
function cgQuote(data: unknown, id: string, vsSym: string): number | undefined {
  const v = (data as Record<string, Record<string, unknown>>)?.[id]?.[vsSym];
  return typeof v === "number" && isFinite(v) && v > 0 ? v : undefined;
}

/**
 * Attempt a conversion via CoinGecko for a pair Coinbase couldn't price. Covers
 * all three shapes: token↔vs-currency (single spot quote), vs↔vs (e.g. USD→SATS,
 * where both sides are quote units, not coins — crossed via BTC), and
 * token↔token (crossed via USD). Never throws — failures map to a "failed" reason.
 */
async function tryCoinGeckoFallback(
  fromUpper: string,
  toUpper: string,
  amount: number,
): Promise<FallbackOutcome> {
  if (!fallbackEnabled()) return { status: "disabled" };
  try {
    const timeoutMs = Math.min(timeouts.currencyExchange, 5000);
    const vs = await getVsCurrencies(timeoutMs);
    const fromL = fromUpper.toLowerCase();
    const toL = toUpper.toLowerCase();
    const fromIsVs = vs.has(fromL);
    const toIsVs = vs.has(toL);

    // rate = value of 1 `from` expressed in `to`.
    let rate: number;
    let detail: string;

    if (fromIsVs && toIsVs) {
      // Both sides are quote units (e.g. USD→SATS): neither has a coin id, so
      // quote BTC in both and cross. Production hit: "Unsupported currency
      // code: SATS (fallback: out_of_scope)".
      const priceData = await cgFetchJson(
        `/simple/price?ids=bitcoin&vs_currencies=${encodeURIComponent(`${fromL},${toL}`)}`,
        timeoutMs,
      );
      if (priceData === null) return { status: "failed", reason: "price_upstream_non2xx" };
      const btcInFrom = cgQuote(priceData, "bitcoin", fromL);
      const btcInTo = cgQuote(priceData, "bitcoin", toL);
      if (btcInFrom === undefined || btcInTo === undefined) {
        return { status: "failed", reason: "no_price" };
      }
      rate = btcInTo / btcInFrom;
      detail = `${fromUpper}→${toUpper} priced as a CoinGecko cross rate via BTC`;
    } else if (fromIsVs !== toIsVs) {
      // Exactly one side is a token: single spot quote in the vs-currency.
      const tokenIsFrom = !fromIsVs;
      const tokenSym = tokenIsFrom ? fromL : toL;
      const vsSym = tokenIsFrom ? toL : fromL;
      const id = await resolveCoinId(tokenSym, timeoutMs);
      if (!id) return { status: "failed", reason: `ticker_unknown:${tokenSym}` };

      const priceData = await cgFetchJson(
        `/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(vsSym)}`,
        timeoutMs,
      );
      if (priceData === null) return { status: "failed", reason: "price_upstream_non2xx" };
      // price = value of 1 TOKEN in the vs-currency.
      const price = cgQuote(priceData, id, vsSym);
      if (price === undefined) return { status: "failed", reason: "no_price" };
      rate = tokenIsFrom ? price : 1 / price;
      detail = `${tokenSym.toUpperCase()} is not listed on the primary exchange; priced via CoinGecko spot rate`;
    } else {
      // token↔token: quote both in USD and cross.
      const [idFrom, idTo] = await Promise.all([
        resolveCoinId(fromL, timeoutMs),
        resolveCoinId(toL, timeoutMs),
      ]);
      if (!idFrom) return { status: "failed", reason: `ticker_unknown:${fromL}` };
      if (!idTo) return { status: "failed", reason: `ticker_unknown:${toL}` };

      const priceData = await cgFetchJson(
        `/simple/price?ids=${encodeURIComponent(`${idFrom},${idTo}`)}&vs_currencies=usd`,
        timeoutMs,
      );
      if (priceData === null) return { status: "failed", reason: "price_upstream_non2xx" };
      const usdFrom = cgQuote(priceData, idFrom, "usd");
      const usdTo = cgQuote(priceData, idTo, "usd");
      if (usdFrom === undefined || usdTo === undefined) {
        return { status: "failed", reason: "no_price" };
      }
      rate = usdFrom / usdTo;
      detail = `${fromUpper}→${toUpper} priced as a CoinGecko cross rate via USD`;
    }

    if (!isFinite(rate) || rate <= 0) return { status: "failed", reason: "bad_rate" };

    return {
      status: "ok",
      body: {
        from: fromUpper,
        to: toUpper,
        amount,
        converted_amount: roundMoney(amount * rate, toUpper),
        exchange_rate: roundSig(rate),
        inverse_rate: roundSig(1 / rate),
        rate_date: new Date().toISOString().slice(0, 10),
        is_historical: false,
        source: "coingecko",
        score: 100,
        grade: "A",
        findings: [{ rule: "crypto_spot_fallback", detail }],
      },
    };
  } catch (err) {
    // Network/timeout or a metadata fetch that came back non-2xx (e.g. 429).
    return { status: "failed", reason: `upstream_error:${err instanceof Error ? err.message : "unknown"}` };
  }
}

// --- Route handler ---

currencyExchangeRouter.get("/currency-exchange/convert", async (req: Request, res: Response) => {
  try {
    // Accept the params from the query string OR a JSON body. Production data
    // showed a large `from and to are required` 400 cluster where agents sent
    // {"from":"USD","to":"EUR","amount":100} as a body instead of using
    // ?from=&to= — the data was there, just in the body we ignored. Merge both;
    // an explicit query param wins on conflict (the most deliberate signal).
    const body =
      req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const params: Record<string, unknown> = { ...body, ...(req.query as Record<string, unknown>) };

    const from = queryString(params, FROM_ALIASES);
    const to = queryString(params, TO_ALIASES);
    // amount/date may arrive as a JSON number/string from the body or a query
    // string; coerce to string so the existing Number()/regex guards still apply.
    const amountRaw = params.amount === undefined ? undefined : String(params.amount);
    const dateRaw = params.date === undefined ? undefined : String(params.date);

    // Name BOTH missing currencies at once (not first-only) and fold a concrete
    // working example + accepted aliases into the prose, matching the catalog's
    // GOOD house pattern (cf. /translate/short). Keeps the bare {error} envelope.
    if (!from && !to) {
      res.status(400).json({
        error:
          'from and to are required — pass the source and target currency codes, e.g. ?from=USD&to=EUR&amount=100 (amount optional, defaults to 1). Also accepted: base/source for "from", target/quote for "to".',
      });
      return;
    }
    if (!from) {
      res.status(400).json({
        error:
          'from is required — pass the source currency code as "from", e.g. ?from=USD&to=EUR&amount=100. Also accepted: base, source, source_currency.',
      });
      return;
    }
    if (!to) {
      res.status(400).json({
        error:
          'to is required — pass the target currency code as "to", e.g. ?from=USD&to=EUR&amount=100. Also accepted: target, quote, target_currency.',
      });
      return;
    }

    const fromUpper = from.toUpperCase();
    const toUpper = to.toUpperCase();
    // No early "unsupported" rejection: a fiat↔fiat pair goes to ECB; anything
    // else (crypto, or a fiat outside the ECB set) is tried via Coinbase spot
    // rates below. A genuinely unknown ticker still 400s — just after lookup.

    let amount = 1;
    if (amountRaw !== undefined) {
      amount = Number(amountRaw);
      if (isNaN(amount) || amount <= 0 || amount > 999999999) {
        res.status(400).json({ error: "amount must be a positive number up to 999999999" });
        return;
      }
    }

    let date = "latest";
    let isHistorical = false;
    if (dateRaw !== undefined) {
      if (!DATE_RE.test(dateRaw)) {
        res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
        return;
      }
      date = dateRaw;
      isHistorical = true;
    }

    // Same currency shortcut
    if (fromUpper === toUpper) {
      res.json({
        from: fromUpper,
        to: toUpper,
        amount,
        converted_amount: roundMoney(amount, toUpper),
        exchange_rate: 1.0,
        inverse_rate: 1.0,
        rate_date: date === "latest" ? new Date().toISOString().slice(0, 10) : date,
        is_historical: isHistorical,
        source: "same",
        score: 100,
        grade: "A",
        findings: [{ rule: "same_currency", detail: "Source and target currency are the same" }],
      });
      return;
    }

    const bothFiat =
      SUPPORTED_CURRENCIES.has(fromUpper) && SUPPORTED_CURRENCIES.has(toUpper);

    if (bothFiat) {
      // ---- Fiat ↔ fiat: ECB reference rates (supports historical) ----
      // Canonical Frankfurter host. The legacy api.frankfurter.app/<date> host is
      // deprecated: it 301s here when healthy but intermittently 5xxes (a USD→TRY
      // call hit a Cloudflare 520), so we call api.frankfurter.dev/v1 directly to
      // avoid the flaky redirect hop. Same response shape; supports historical via
      // /v1/<YYYY-MM-DD> and latest via /v1/latest.
      const url = `https://api.frankfurter.dev/v1/${date}?from=${fromUpper}&to=${toUpper}`;
      await checkSsrf("api.frankfurter.dev");

      const r = await cachedFetchJson(url, timeouts.currencyExchange);
      if (!r.ok) {
        res.status(502).json(
          upstreamFailure(`the upstream rate provider is temporarily unavailable (HTTP ${r.status})`),
        );
        return;
      }

      const data = r.data as {
        amount: number;
        base: string;
        date: string;
        rates: Record<string, number>;
      };

      const rate = data.rates[toUpper];
      if (rate === undefined) {
        res.status(502).json({ error: `Exchange rate lookup failed: no rate returned for ${toUpper}` });
        return;
      }

      res.json({
        from: fromUpper,
        to: toUpper,
        amount,
        converted_amount: roundMoney(amount * rate, toUpper),
        exchange_rate: rate,
        inverse_rate: roundSig(1 / rate),
        rate_date: data.date,
        is_historical: isHistorical,
        source: "ecb",
        score: 100,
        grade: "A",
        findings: [],
      });
      return;
    }

    // ---- Crypto involved: latest spot rate via Coinbase (ticker-keyed, keyless,
    // covers BTC/ETH/USDC/SOL/ICP/CELO/… and fiat). No historical for crypto —
    // but a `date` on a crypto pair is served at the latest spot rate with an
    // explicit finding, not rejected: the discovery schema already promises the
    // date is "ignored for crypto", and production showed agents sending dated
    // crypto requests and abandoning on the old 400. is_historical stays false
    // and rate_date is the spot date, so the substitution is never silent.
    const historicalNote = isHistorical
      ? {
          rule: "historical_unavailable_for_crypto",
          detail: `Historical rates are only available for fiat pairs (ECB reference rates); the requested date ${date} was ignored and the latest spot rate returned — see rate_date and is_historical:false`,
        }
      : null;
    const withHistoricalNote = (spotBody: Record<string, unknown>): Record<string, unknown> => {
      if (!historicalNote) return spotBody;
      const findings = Array.isArray(spotBody.findings) ? spotBody.findings : [];
      return { ...spotBody, findings: [historicalNote, ...findings] };
    };

    const baseTicker = CRYPTO_ALIAS[fromUpper] ?? fromUpper;
    await checkSsrf("api.coinbase.com");

    const cb = await cachedFetchJson(
      `https://api.coinbase.com/v2/exchange-rates?currency=${encodeURIComponent(baseTicker)}`,
      timeouts.currencyExchange
    );

    if (!cb.ok) {
      // Coinbase 400s on an unknown base currency — try the long-tail fallback
      // before surfacing the clean 400 (unchanged when the fallback is disabled).
      if (cb.status === 400) {
        const fb = await tryCoinGeckoFallback(fromUpper, toUpper, amount);
        if (fb.status === "ok") {
          res.json(withHistoricalNote(fb.body));
          return;
        }
        const suffix = fb.status === "failed" ? ` (fallback: ${fb.reason})` : "";
        res.status(400).json({ error: `Unsupported currency code: ${fromUpper}${suffix}` });
        return;
      }
      res.status(502).json(
        upstreamFailure(`the upstream rate provider is temporarily unavailable (HTTP ${cb.status})`),
      );
      return;
    }

    const cbData = cb.data as { data?: { rates?: Record<string, string> } };
    const rates = cbData?.data?.rates ?? {};
    const rateStr = rates[CRYPTO_ALIAS[toUpper] ?? toUpper] ?? rates[toUpper];
    if (rateStr === undefined) {
      // `from` priced fine but Coinbase has no rate for `to` — try the fallback
      // before the clean 400 (unchanged when the fallback is disabled).
      const fb = await tryCoinGeckoFallback(fromUpper, toUpper, amount);
      if (fb.status === "ok") {
        res.json(withHistoricalNote(fb.body));
        return;
      }
      const suffix = fb.status === "failed" ? ` (fallback: ${fb.reason})` : "";
      res.status(400).json({ error: `Unsupported currency code: ${toUpper}${suffix}` });
      return;
    }

    const rate = Number(rateStr);
    if (!isFinite(rate) || rate <= 0) {
      res.status(502).json({ error: `Exchange rate lookup failed: invalid rate for ${toUpper}` });
      return;
    }

    res.json(withHistoricalNote({
      from: fromUpper,
      to: toUpper,
      amount,
      converted_amount: roundMoney(amount * rate, toUpper),
      exchange_rate: roundSig(rate),
      inverse_rate: roundSig(1 / rate),
      rate_date: new Date().toISOString().slice(0, 10),
      is_historical: false,
      source: "coinbase",
      score: 100,
      grade: "A",
      findings: [{ rule: "crypto_spot", detail: "Crypto pair priced at the latest Coinbase spot rate; fiat pairs use ECB reference rates" }],
    }));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Currency exchange error:", err);
    res.status(500).json(
      upstreamFailure(
        `could not reach the upstream rate provider (${err instanceof Error ? err.message : String(err)})`,
      ),
    );
  }
});
