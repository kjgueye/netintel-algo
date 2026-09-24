import { Router, type Request, type Response } from "express";
import { pickField } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const currencyBatchRouter = Router();

// --- Aliases (house input-field-leniency rule) -------------------------------

const FROM_ALIASES = ["from", "base", "source", "source_currency", "from_currency"];
const TO_ALIASES = ["to", "targets", "symbols", "target", "to_currency", "target_currency"];
const AMOUNT_ALIASES = ["amount", "value"];

const MAX_TARGETS = 30;
// Coinbase spot is one fetch per crypto target — cap the concurrent in-flight legs.
const SPOT_CONCURRENCY = 8;

// --- Code space --------------------------------------------------------------

// ECB reference-rate currencies frankfurter can serve — same set as
// /currency-exchange/convert (this endpoint is its batch sibling and must match
// its rate semantics).
const ECB_FIAT = new Set(
  ("AUD BGN BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW " +
    "MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR HRK").split(" "),
);

// Full known-fiat code space (ISO 4217) — everything the fawazahmed0 CDN /
// er-api fallbacks can price, including the remittance-corridor tail
// (SAR, AED, COP, CLP, PHP) the single-convert logs surfaced.
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

// Major crypto tickers priced via Coinbase spot — same roster as /crypto/price
// (no symbol search: resolving unknown tickers upstream would burn the shared
// Railway-egress quota, the ip-geo failure mode this batch engineers out).
const CRYPTO = new Set(
  ("BTC ETH USDT BNB SOL USDC XRP DOGE TON ADA TRX AVAX SHIB LINK DOT BCH " +
    "NEAR POL LTC ICP UNI ETC APT XLM ATOM XMR FIL HBAR ARB VET IMX OP MKR " +
    "INJ GRT RENDER AAVE SUI SEI PEPE ALGO FTM STX RUNE FLOW KAS TIA JUP WLD " +
    "CRO LDO QNT GALA FET XTZ BONK").split(" "),
);

// --- Cache / cooldown state (house provider-chain pattern, inlined) ----------
// Fiat rate tables are daily ECB-cadence data: 1h TTL per BASE (never per
// request key — one CDN file covers all ~200 targets at once), stale ceiling
// 48h. Crypto legs are spot: 30s TTL per symbol, stale ceiling 10min.
const FIAT_TTL_MS = 60 * 60_000;
const FIAT_STALE_MAX_MS = 48 * 60 * 60_000;
const SPOT_TTL_MS = 30_000;
const SPOT_STALE_MAX_MS = 10 * 60_000;
const FIAT_BENCH_MS = 15 * 60_000; // daily-data providers
const SPOT_BENCH_MS = 5 * 60_000; // spot provider

interface FiatTable {
  rates: Record<string, number>; // UPPERCASE code → rate per 1 base unit
  date: string; // YYYY-MM-DD the table is dated
}

type FiatProvider = "frankfurter" | "currency-api" | "er-api";
const FIAT_PROVIDERS: FiatProvider[] = ["frankfurter", "currency-api", "er-api"];

const fiatCaches: Record<FiatProvider, Map<string, { at: number; table: FiatTable }>> = {
  frankfurter: new Map(),
  "currency-api": new Map(),
  "er-api": new Map(),
};
const spotCache = new Map<string, { at: number; price: number }>(); // key = SYM (USD-quoted)
const benchedUntil = new Map<string, number>(); // key = provider name

// Injectable clock so tests can advance time without sleeping.
let nowFn: () => number = Date.now;

/** Test-only: clear all module-level state (rate tables, spot cache, benches). */
export function __resetCurrencyBatchState(): void {
  for (const p of FIAT_PROVIDERS) fiatCaches[p].clear();
  spotCache.clear();
  benchedUntil.clear();
}

/** Test-only: override (or with no arg, restore) the clock. */
export function __setCurrencyBatchNow(fn?: () => number): void {
  nowFn = fn ?? Date.now;
}

// --- Helpers -----------------------------------------------------------------

interface Finding {
  rule: string;
  detail: string;
}

interface Leg {
  rate: number; // value of 1 `from` unit expressed in the target
  date: string;
  source: string;
  stale: boolean;
}

function isBenched(provider: string): boolean {
  const until = benchedUntil.get(provider);
  return until !== undefined && nowFn() < until;
}

function bench(provider: string, ms: number): void {
  benchedUntil.set(provider, nowFn() + ms);
}

function todayStr(): string {
  return new Date(nowFn()).toISOString().slice(0, 10);
}

function roundSig(value: number, sig = 8): number {
  if (!isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(sig));
}

// Fixed money precision matching /currency-exchange/convert: 2 decimals for
// fiat, ~8 significant figures for crypto so tiny amounts (USD→BTC) don't
// collapse to 0.00.
function roundMoney(value: number, currency: string): number {
  if (FIAT.has(currency)) return Math.round(value * 100) / 100;
  return roundSig(value);
}

/** Keep only finite positive numeric rates; uppercase the code keys. */
function normalizeRates(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k.toUpperCase()] = v;
  }
  return out;
}

// --- Fiat upstream fetchers --------------------------------------------------
// Each returns a table, null for a definite "base not covered here" miss (fall
// through the chain, per the frankfurter-404 gotcha), or throws on provider
// trouble (network/timeout/5xx/429) — the caller benches on throw.

async function fetchFrankfurter(base: string): Promise<FiatTable | null> {
  // Canonical Frankfurter host (api.frankfurter.dev/v1) per the single-convert
  // route — the legacy api.frankfurter.app host intermittently 5xxes. The full
  // per-base table (no `to` filter) keeps the 1h cache valid for ANY target set.
  const resp = await fetch(`https://api.frankfurter.dev/v1/latest?from=${encodeURIComponent(base)}`, {
    signal: AbortSignal.timeout(timeouts.currencyBatch),
  });
  if (resp.status === 404) return null; // unsupported base — not covered here, don't 502
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as { date?: string; rates?: Record<string, unknown> };
  if (!data?.rates || typeof data.rates !== "object") throw new Error("malformed response");
  return { rates: normalizeRates(data.rates), date: typeof data.date === "string" ? data.date : todayStr() };
}

async function fetchCurrencyApiCdn(base: string): Promise<FiatTable | null> {
  // fawazahmed0 static CDN: one file covers ~200 currencies at once. Keys are
  // lowercase. Two mirror hosts — try jsdelivr first, then pages.dev.
  const baseLower = base.toLowerCase();
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${baseLower}.json`,
    `https://latest.currency-api.pages.dev/v1/currencies/${baseLower}.json`,
  ];
  let lastErr: unknown = new Error("all mirrors failed");
  for (const url of urls) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(timeouts.currencyBatch) });
      if (resp.status === 404) return null; // no file for this base — definite miss
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as Record<string, unknown> & { date?: string };
      const raw = data?.[baseLower];
      if (!raw || typeof raw !== "object") throw new Error("malformed response");
      return {
        rates: normalizeRates(raw as Record<string, unknown>),
        date: typeof data.date === "string" ? data.date : todayStr(),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function fetchErApi(base: string): Promise<FiatTable | null> {
  const resp = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`, {
    signal: AbortSignal.timeout(timeouts.currencyBatch),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    result?: string;
    rates?: Record<string, unknown>;
    time_last_update_unix?: number;
  };
  if (data?.result !== "success" || !data.rates) return null; // e.g. unsupported-code — miss, not an outage
  const date =
    typeof data.time_last_update_unix === "number"
      ? new Date(data.time_last_update_unix * 1000).toISOString().slice(0, 10)
      : todayStr();
  return { rates: normalizeRates(data.rates), date };
}

const FIAT_FETCHERS: Record<FiatProvider, (base: string) => Promise<FiatTable | null>> = {
  frankfurter: fetchFrankfurter,
  "currency-api": fetchCurrencyApiCdn,
  "er-api": fetchErApi,
};

/**
 * A LIVE table for `base` from one provider: fresh cache hit, or a successful
 * fetch (cached). Returns null when benched, on a definite base miss, or on
 * failure (which benches the provider). Stale copies are NOT served here —
 * stale-serve is a last resort AFTER the whole chain, so a healthy fallback
 * provider always beats a dead primary's leftovers.
 */
async function getLiveTable(provider: FiatProvider, base: string): Promise<FiatTable | null> {
  const now = nowFn();
  const hit = fiatCaches[provider].get(base);
  if (hit && now - hit.at < FIAT_TTL_MS) return hit.table;
  if (isBenched(provider)) return null;
  try {
    const table = await FIAT_FETCHERS[provider](base);
    if (table) fiatCaches[provider].set(base, { at: now, table });
    return table;
  } catch {
    bench(provider, FIAT_BENCH_MS);
    return null;
  }
}

/** Stale last resort: the freshest cached table (any provider, ≤48h) that prices `target`. */
function staleFiatLeg(base: string, target: string): Leg | null {
  const now = nowFn();
  let best: { leg: Leg; ageMs: number } | null = null;
  for (const provider of FIAT_PROVIDERS) {
    const hit = fiatCaches[provider].get(base);
    if (!hit || now - hit.at > FIAT_STALE_MAX_MS) continue;
    const rate = hit.table.rates[target];
    if (!rate) continue;
    const ageMs = now - hit.at;
    if (!best || ageMs < best.ageMs) {
      best = { leg: { rate, date: hit.table.date, source: provider, stale: true }, ageMs };
    }
  }
  return best?.leg ?? null;
}

/**
 * Resolve fiat rates for `targets` against fiat `base` through the locked
 * chain: frankfurter (ECB currencies only) → fawazahmed0 CDN (one file, all
 * targets) → open.er-api.com → stale copies. Unresolvable targets are simply
 * absent from the result.
 */
async function resolveFiatLegs(base: string, targets: string[]): Promise<Map<string, Leg>> {
  const out = new Map<string, Leg>();
  if (targets.length === 0) return out;

  if (ECB_FIAT.has(base) && targets.some((t) => ECB_FIAT.has(t))) {
    const table = await getLiveTable("frankfurter", base);
    if (table) {
      for (const t of targets) {
        if (!ECB_FIAT.has(t)) continue;
        const rate = table.rates[t];
        if (rate) out.set(t, { rate, date: table.date, source: "frankfurter", stale: false });
      }
    }
  }

  for (const provider of ["currency-api", "er-api"] as const) {
    const remaining = targets.filter((t) => !out.has(t));
    if (remaining.length === 0) break;
    const table = await getLiveTable(provider, base);
    if (!table) continue;
    for (const t of remaining) {
      const rate = table.rates[t];
      if (rate) out.set(t, { rate, date: table.date, source: provider, stale: false });
    }
  }

  for (const t of targets) {
    if (out.has(t)) continue;
    const stale = staleFiatLeg(base, t);
    if (stale) out.set(t, stale);
  }
  return out;
}

/**
 * USD spot price for one crypto symbol via Coinbase, behind the 30s cache.
 * A non-2xx that isn't 429/403 is a definite pair miss (no bench);
 * 429/403/network/timeout benches the provider. Stale-serve ceiling 10min.
 */
async function getSpotUsd(sym: string): Promise<{ price: number; stale: boolean } | null> {
  const now = nowFn();
  const hit = spotCache.get(sym);
  if (hit && now - hit.at < SPOT_TTL_MS) return { price: hit.price, stale: false };
  if (!isBenched("coinbase")) {
    try {
      const resp = await fetch(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`, {
        signal: AbortSignal.timeout(timeouts.currencyBatch),
      });
      if (resp.status === 429 || resp.status === 403) {
        bench("coinbase", SPOT_BENCH_MS);
      } else if (resp.ok) {
        // Coinbase amounts arrive as strings: parseFloat, NaN = missing not 0.
        const body = (await resp.json()) as { data?: { amount?: string } };
        const price = parseFloat(body?.data?.amount ?? "");
        if (Number.isFinite(price) && price > 0) {
          spotCache.set(sym, { at: now, price });
          return { price, stale: false };
        }
      }
    } catch {
      bench("coinbase", SPOT_BENCH_MS);
    }
  }
  if (hit && now - hit.at <= SPOT_STALE_MAX_MS) return { price: hit.price, stale: true };
  return null;
}

// --- Route handler -----------------------------------------------------------

currencyBatchRouter.get("/currency-exchange/batch", async (req: Request, res: Response) => {
  try {
    // Query OR JSON body, even on GET (query wins) — the /currency-exchange/convert
    // production 400 clusters showed agents sending these as a body.
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const params: Record<string, unknown> = { ...body, ...(req.query as Record<string, unknown>) };

    const fromRaw = pickField(params, FROM_ALIASES);
    const toRaw = pickField(params, TO_ALIASES);

    if (typeof fromRaw !== "string" || fromRaw.trim() === "") {
      res.status(400).json({
        error:
          "from is required — pass the base currency code, e.g. ?from=USD&to=EUR,GBP,BTC&amount=100 (aliases: base, source).",
      });
      return;
    }
    // A JSON array of targets is as clear as a comma list — accept both.
    const toStr = Array.isArray(toRaw) ? toRaw.map((v) => String(v)).join(",") : toRaw;
    if (typeof toStr !== "string" || toStr.trim() === "") {
      res.status(400).json({
        error:
          "to is required — pass a comma list of 1–30 target codes, e.g. ?from=USD&to=EUR,GBP,BTC (aliases: targets, symbols).",
      });
      return;
    }

    const from = fromRaw.trim().replace(/^\$/, "").toUpperCase();
    if (!FIAT.has(from) && !CRYPTO.has(from)) {
      res.status(400).json({
        error: `Unsupported from currency: ${from.slice(0, 12)}. Use an ISO 4217 fiat code (USD, EUR, SAR, …) or a major crypto ticker (BTC, ETH, SOL, …). Aliases: base, source.`,
      });
      return;
    }

    const amountRaw = pickField(params, AMOUNT_ALIASES);
    let amount = 1;
    if (amountRaw !== undefined) {
      amount = Number(typeof amountRaw === "string" ? amountRaw.trim() : amountRaw);
      if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: "amount must be a finite number greater than 0 (alias: value); it defaults to 1 when omitted." });
        return;
      }
    }

    const targets: string[] = [];
    for (const token of toStr.split(",")) {
      const code = token.trim().replace(/^\$/, "").toUpperCase();
      if (code !== "" && !targets.includes(code)) targets.push(code);
    }
    if (targets.length === 0) {
      res.status(400).json({
        error: "to contained no target codes — pass a comma list of 1–30, e.g. ?from=USD&to=EUR,GBP,BTC.",
      });
      return;
    }
    if (targets.length > MAX_TARGETS) {
      res.status(400).json({
        error: `Too many targets: ${targets.length}. Max ${MAX_TARGETS} per call — split the list across calls.`,
      });
      return;
    }

    const fiatTargets: string[] = [];
    const cryptoTargets: string[] = [];
    const unknownCodes: string[] = [];
    for (const t of targets) {
      if (t === from) continue; // from in `to` is rate 1, handled at assembly
      else if (FIAT.has(t)) fiatTargets.push(t);
      else if (CRYPTO.has(t)) cryptoTargets.push(t);
      else unknownCodes.push(t);
    }
    if (unknownCodes.length === targets.length) {
      // Nothing to price at all — instructive 400, uncharged.
      res.status(400).json({
        error:
          `Unknown target codes: ${unknownCodes.join(", ")}. ` +
          "Use ISO 4217 fiat codes (USD, EUR, SAR, AED, …) or major crypto tickers (BTC, ETH, SOL, …).",
      });
      return;
    }

    // --- Resolve legs. rate = value of 1 `from` unit in the target. ---
    const legs = new Map<string, Leg>();

    if (FIAT.has(from)) {
      // Fiat base: one fiat-table chain covers every fiat target; crypto
      // targets cross through USD (from→T = (from→USD) / T-USD spot).
      const fiatNeeds = [...fiatTargets];
      if (cryptoTargets.length > 0 && from !== "USD" && !fiatNeeds.includes("USD")) fiatNeeds.push("USD");
      const fiatLegs = await resolveFiatLegs(from, fiatNeeds);
      for (const t of fiatTargets) {
        const leg = fiatLegs.get(t);
        if (leg) legs.set(t, leg);
      }

      const usdBridge: Leg | null =
        from === "USD" ? { rate: 1, date: todayStr(), source: "same", stale: false } : fiatLegs.get("USD") ?? null;
      if (usdBridge) {
        for (let i = 0; i < cryptoTargets.length; i += SPOT_CONCURRENCY) {
          const wave = cryptoTargets.slice(i, i + SPOT_CONCURRENCY);
          const settled = await Promise.allSettled(wave.map((sym) => getSpotUsd(sym)));
          settled.forEach((r, j) => {
            if (r.status !== "fulfilled" || !r.value) return;
            legs.set(wave[j], {
              rate: usdBridge.rate / r.value.price,
              date: todayStr(), // spot-dated: the crypto leg is the fresher constraint
              source: from === "USD" ? "coinbase" : `${usdBridge.source}+coinbase`,
              stale: r.value.stale || usdBridge.stale,
            });
          });
        }
      }
    } else {
      // Crypto base: every leg crosses through the FROM-USD spot
      // (from→fiat = spot × USD→T; from→crypto = spot / T-USD spot).
      const fromSpot = await getSpotUsd(from);
      if (fromSpot) {
        const fiatNeeds = fiatTargets.filter((t) => t !== "USD");
        const fiatLegs = await resolveFiatLegs("USD", fiatNeeds);
        for (const t of fiatTargets) {
          if (t === "USD") {
            legs.set(t, { rate: fromSpot.price, date: todayStr(), source: "coinbase", stale: fromSpot.stale });
            continue;
          }
          const usdLeg = fiatLegs.get(t);
          if (usdLeg) {
            legs.set(t, {
              rate: fromSpot.price * usdLeg.rate,
              date: todayStr(),
              source: `coinbase+${usdLeg.source}`,
              stale: fromSpot.stale || usdLeg.stale,
            });
          }
        }
        for (let i = 0; i < cryptoTargets.length; i += SPOT_CONCURRENCY) {
          const wave = cryptoTargets.slice(i, i + SPOT_CONCURRENCY);
          const settled = await Promise.allSettled(wave.map((sym) => getSpotUsd(sym)));
          settled.forEach((r, j) => {
            if (r.status !== "fulfilled" || !r.value) return;
            legs.set(wave[j], {
              rate: fromSpot.price / r.value.price,
              date: todayStr(),
              source: "coinbase",
              stale: fromSpot.stale || r.value.stale,
            });
          });
        }
      }
    }

    // --- Assemble in request order. ---
    const rates: Array<Record<string, unknown>> = [];
    const unavailable: string[] = [];
    const failed: string[] = [];
    let anyStale = false;
    let priced = 0;

    for (const t of targets) {
      if (unknownCodes.includes(t)) continue; // not a currency — unavailable only, no rate row
      if (t === from) {
        rates.push({ to: t, rate: 1, converted_amount: roundMoney(amount, t), rate_date: todayStr(), source: "same" });
        priced++;
        continue;
      }
      const leg = legs.get(t);
      if (leg) {
        if (leg.stale) anyStale = true;
        rates.push({
          to: t,
          rate: roundSig(leg.rate),
          converted_amount: roundMoney(amount * leg.rate, t),
          rate_date: leg.date,
          source: leg.source,
        });
        priced++;
      } else {
        failed.push(t);
        rates.push({ to: t, rate: null, converted_amount: null, rate_date: null, source: null });
      }
    }

    if (priced === 0) {
      // No primary answer for ANY priceable target — our miss, 502 uncharged.
      res.status(502).json({ error: "Upstream exchange-rate data unavailable for all requested targets" });
      return;
    }

    const findings: Finding[] = [];
    if (unknownCodes.length > 0) {
      unavailable.push(...unknownCodes);
      findings.push({
        rule: "unknown_codes",
        detail:
          `${unknownCodes.join(", ")}: not a recognized fiat code or crypto ticker — skipped. ` +
          "Fiat uses ISO 4217 codes (USD, EUR, SAR, …); crypto uses tickers (BTC, ETH, SOL, …).",
      });
    }
    if (failed.length > 0) {
      unavailable.push(...failed);
      findings.push({
        rule: "unavailable",
        detail: `${failed.join(", ")}: every rate provider failed for these targets — rate is null; retry shortly`,
      });
    }
    if (anyStale) {
      findings.push({
        rule: "stale_data",
        detail: "one or more rates were served from the last good copy after every live provider failed — see per-entry rate_date",
      });
    }

    res.json({ from, amount, rates, unavailable, stale: anyStale, findings });
  } catch (err) {
    console.error("Currency batch error:", err);
    res.status(500).json({ error: "Upstream exchange-rate data unavailable" });
  }
});
