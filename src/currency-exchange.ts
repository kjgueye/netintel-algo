import { Router, type Request, type Response } from "express";
import dns from "node:dns/promises";

// ---------------------------------------------------------------------------
// Inlined helpers (ported from the NetIntel project so this service has NO
// dependency on it — fully self-contained).
// ---------------------------------------------------------------------------

// Upstream request timeout (ms). In NetIntel this came from config.timeouts.
const CURRENCY_EXCHANGE_TIMEOUT_MS = 8000;

/** Thrown by input/SSRF validation; mapped to a 400 by the handler. */
class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// --- SSRF guard (inlined from utils/validators.ts) --------------------------
// RFC 1918 + loopback + link-local + reserved ranges. We resolve the upstream
// hostname and refuse to call it if it points at a private/reserved address.

const PRIVATE_RANGES_V4 = [
  { prefix: "10.", mask: 8 },
  { prefix: "127.", mask: 8 },
  { prefix: "169.254.", mask: 16 },
  { prefix: "192.168.", mask: 16 },
];

function isPrivateIPv4(ip: string): boolean {
  if (ip.startsWith("0.")) return true;
  for (const range of PRIVATE_RANGES_V4) {
    if (ip.startsWith(range.prefix)) return true;
  }
  // 172.16.0.0 - 172.31.255.255
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1] ?? "", 10);
    if (second >= 16 && second <= 31) return true;
  }
  // 100.64.0.0/10 (CGNAT)
  if (ip.startsWith("100.")) {
    const second = parseInt(ip.split(".")[1] ?? "", 10);
    if (second >= 64 && second <= 127) return true;
  }
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
}

async function checkSsrf(hostname: string): Promise<void> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new ValidationError(`Cannot resolve hostname: ${hostname}`);
  }

  for (const { address, family } of addresses) {
    const isPrivate = family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
    if (isPrivate) {
      throw new ValidationError("Target resolves to a private/reserved address");
    }
  }
}

// Return the first present (non-null/undefined) value among a list of accepted
// field names (inlined from utils/field-aliases.ts). Canonical name listed first.
function pickField(obj: unknown, keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
  }
  return undefined;
}

// ---------------------------------------------------------------------------

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

      const r = await cachedFetchJson(url, CURRENCY_EXCHANGE_TIMEOUT_MS);
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
    // covers BTC/ETH/USDC/SOL/ICP/CELO/… and fiat). No historical for crypto. ----
    if (isHistorical) {
      res.status(400).json({
        error: "Historical rates are only available between fiat currencies; crypto pairs return the latest spot rate only",
      });
      return;
    }

    const baseTicker = CRYPTO_ALIAS[fromUpper] ?? fromUpper;
    await checkSsrf("api.coinbase.com");

    const cb = await cachedFetchJson(
      `https://api.coinbase.com/v2/exchange-rates?currency=${encodeURIComponent(baseTicker)}`,
      CURRENCY_EXCHANGE_TIMEOUT_MS
    );

    if (!cb.ok) {
      // Coinbase 400s on an unknown base currency — surface the clean 400.
      if (cb.status === 400) {
        res.status(400).json({ error: `Unsupported currency code: ${fromUpper}` });
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
      // `from` priced fine but Coinbase has no rate for `to` — clean 400.
      res.status(400).json({ error: `Unsupported currency code: ${toUpper}` });
      return;
    }

    const rate = Number(rateStr);
    if (!isFinite(rate) || rate <= 0) {
      res.status(502).json({ error: `Exchange rate lookup failed: invalid rate for ${toUpper}` });
      return;
    }

    res.json({
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
    });
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
