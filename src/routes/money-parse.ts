import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { pickField } from "../utils/field-aliases.js";

export const moneyParseRouter = Router();

// This is a money STRING, not a document — a tight cap keeps the deterministic
// fast path honest and stops anyone treating it like the bulk text endpoints.
const MAX_TEXT_CHARS = 1000;

// Small output budget: the LLM fallback returns a tiny JSON object. The
// truncation guard below still enforces it.
const MAX_TOKENS = 256;

// --- Static ISO 4217 + separator tables (bundled in-code, no external data) ---

// A pragmatic subset of ISO 4217 — every code we map a symbol/word to, plus the
// common majors agents pass as `default_currency`. Used to (a) detect a bare ISO
// code in the text and (b) validate `default_currency` / the LLM's currency.
const ISO_CODES = new Set([
  "USD", "EUR", "GBP", "JPY", "CNY", "CHF", "CAD", "AUD", "NZD", "SGD",
  "HKD", "MXN", "INR", "KRW", "RUB", "ILS", "THB", "TRY", "VND", "NGN",
  "PHP", "BRL", "SEK", "NOK", "DKK", "ISK", "PLN", "CZK", "HUF", "ZAR",
  "ARS", "CLP", "COP", "AED", "SAR", "IDR", "MYR", "RON", "BGN", "HRK",
  "TWD", "UAH", "EGP", "PKR", "BDT", "KES", "GHS", "MAD", "QAR", "KWD",
]);

// Unambiguous currency symbols → ISO 4217. Multi-char globs (R$) are detected
// before the bare "$" so they win.
const UNAMBIGUOUS_SYMBOLS: Array<[string, string]> = [
  ["R$", "BRL"],
  ["€", "EUR"],
  ["£", "GBP"],
  ["₹", "INR"],
  ["₩", "KRW"],
  ["₽", "RUB"],
  ["₪", "ILS"],
  ["฿", "THB"],
  ["₺", "TRY"],
  ["₫", "VND"],
  ["₦", "NGN"],
  ["₱", "PHP"],
];

// Currency words. Unambiguous words carry an `iso`; genuinely multi-country
// words carry a region map (for locale_hint) + an optional dominant default.
interface WordRule {
  re: RegExp;
  iso?: string;
  key?: string;
  regionMap?: Record<string, string>;
  dominant?: string | null;
}
const WORD_RULES: WordRule[] = [
  { re: /\beuros?\b/i, iso: "EUR" },
  { re: /\b(pounds?|sterling)\b/i, iso: "GBP" },
  { re: /\byen\b/i, iso: "JPY" },
  { re: /\b(yuan|renminbi|rmb)\b/i, iso: "CNY" },
  { re: /\brupees?\b/i, iso: "INR" },
  { re: /\bwon\b/i, iso: "KRW" },
  { re: /\bfrancs?\b/i, iso: "CHF" },
  { re: /\b(reais|real)\b/i, iso: "BRL" },
  {
    re: /\b(dollars?|bucks?)\b/i,
    key: "$",
    regionMap: { US: "USD", CA: "CAD", AU: "AUD", NZ: "NZD", SG: "SGD", HK: "HKD" },
    dominant: "USD",
  },
  {
    // SEK/NOK/DKK/ISK — no dominant default; do NOT guess one.
    re: /\b(kronor|kronur|kroner|krona|krone|kr)\b/i,
    key: "kr",
    regionMap: { SE: "SEK", NO: "NOK", DK: "DKK", IS: "ISK" },
    dominant: null,
  },
  {
    re: /\bpesos?\b/i,
    key: "peso",
    regionMap: { MX: "MXN", AR: "ARS", CL: "CLP", CO: "COP" },
    dominant: null,
  },
];

// Strip every currency marker (symbol, bare ISO code, currency word) from the
// text. Used to isolate the numeric core and to detect leftover natural-language
// content (which is what the LLM fallback is for).
const CURRENCY_WORDS_RE =
  /\b(euros?|pounds?|sterling|yen|yuan|renminbi|rmb|rupees?|won|francs?|reais|real|dollars?|bucks?|kronor|kronur|kroner|krona|krone|kr|pesos?)\b/gi;
const SYMBOLS_RE = /R\$|[$€£¥￥₹₩₽₪฿₺₫₦₱]/gi;

function stripCurrencyMarkers(text: string): string {
  return text
    .replace(/\b[A-Za-z]{3}\b/g, (m) => (ISO_CODES.has(m.toUpperCase()) ? " " : m))
    .replace(CURRENCY_WORDS_RE, " ")
    .replace(SYMBOLS_RE, " ");
}

// --- Locale helpers ---

// Languages that use a comma as the decimal separator (CLDR-style). Anything not
// listed is treated as period-decimal (en, ja, zh, ko, th, ...).
const COMMA_DECIMAL_LANGS = new Set([
  "de", "fr", "es", "it", "nl", "pt", "ru", "pl", "sv", "da", "nb", "nn", "no",
  "fi", "tr", "cs", "sk", "hu", "ro", "bg", "hr", "sl", "lt", "lv", "et", "el",
  "is", "uk", "be", "ca", "eu", "gl", "af", "id", "vi",
]);

function localeLang(locale: string): string {
  return locale.split(/[-_]/)[0].toLowerCase();
}
function localeRegion(locale: string | undefined): string | null {
  if (!locale) return null;
  const parts = locale.split(/[-_]/);
  return parts.length > 1 ? parts[1].toUpperCase() : null;
}

// --- Currency detection ---

interface CurrencyDetection {
  currency: string | null;
  ambiguous: boolean;
  detected: boolean;
}

function resolveAmbiguous(
  regionMap: Record<string, string>,
  dominant: string | null,
  region: string | null,
  def: string | null,
): CurrencyDetection {
  // default_currency or locale_hint disambiguates → not ambiguous.
  if (def) return { currency: def, ambiguous: false, detected: true };
  if (region && regionMap[region]) return { currency: regionMap[region], ambiguous: false, detected: true };
  // No disambiguator: fall back to the dominant default (flagged ambiguous) or,
  // for genuinely multi-country symbols with no dominant, refuse to guess.
  if (dominant) return { currency: dominant, ambiguous: true, detected: true };
  return { currency: null, ambiguous: true, detected: true };
}

function detectCurrency(
  text: string,
  localeHint: string | undefined,
  def: string | null,
): CurrencyDetection {
  const region = localeRegion(localeHint);

  // 1. Bare ISO 4217 code (e.g. "USD 1.2M").
  const isoMatches = text.match(/\b[A-Za-z]{3}\b/g);
  if (isoMatches) {
    for (const m of isoMatches) {
      if (ISO_CODES.has(m.toUpperCase())) {
        return { currency: m.toUpperCase(), ambiguous: false, detected: true };
      }
    }
  }

  // 2. Unambiguous symbols.
  for (const [sym, iso] of UNAMBIGUOUS_SYMBOLS) {
    if (text.includes(sym)) return { currency: iso, ambiguous: false, detected: true };
  }

  // 3. Ambiguous symbols.
  if (text.includes("$")) {
    return resolveAmbiguous(
      { US: "USD", CA: "CAD", AU: "AUD", NZ: "NZD", SG: "SGD", HK: "HKD", MX: "MXN" },
      "USD",
      region,
      def,
    );
  }
  if (text.includes("¥") || text.includes("￥")) {
    return resolveAmbiguous({ JP: "JPY", CN: "CNY" }, "JPY", region, def);
  }

  // 4. Currency words.
  for (const w of WORD_RULES) {
    if (w.re.test(text)) {
      if (w.iso) return { currency: w.iso, ambiguous: false, detected: true };
      return resolveAmbiguous(w.regionMap ?? {}, w.dominant ?? null, region, def);
    }
  }

  return { currency: null, ambiguous: false, detected: false };
}

// --- Numeric core parsing ---

interface NumericParse {
  value: number;
  separatorAssumed: "us" | "eu" | "from_locale_hint" | "n/a";
}

function parseNumericCore(core: string, localeHint: string | undefined): NumericParse | null {
  // Spaces / NBSP are always grouping separators.
  const s = core.replace(/[\s ]/g, "");
  if (!/\d/.test(s)) return null;

  const hasDot = s.includes(".");
  const hasComma = s.includes(",");

  let decimalSep: "." | "," | null = null;
  let separatorAssumed: NumericParse["separatorAssumed"];

  if (localeHint) {
    decimalSep = COMMA_DECIMAL_LANGS.has(localeLang(localeHint)) ? "," : ".";
    separatorAssumed = "from_locale_hint";
  } else if (hasDot && hasComma) {
    // The LAST occurring separator is the decimal; the other is grouping.
    decimalSep = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    separatorAssumed = decimalSep === "." ? "us" : "eu";
  } else if (hasDot || hasComma) {
    const sep = hasDot ? "." : ",";
    const occurrences = s.split(sep).length - 1;
    const trailing = s.slice(s.lastIndexOf(sep) + 1);
    if (occurrences === 1 && trailing.length >= 1 && trailing.length <= 2) {
      decimalSep = sep; // e.g. "1.2", "1,5", "45.00"
      separatorAssumed = sep === "." ? "us" : "eu";
    } else {
      decimalSep = null; // grouping only, e.g. "1,234,567" / "1.234.567"
      separatorAssumed = sep === "." ? "eu" : "us";
    }
  } else {
    decimalSep = null;
    separatorAssumed = "n/a";
  }

  let numeric: string;
  if (decimalSep === ".") {
    numeric = s.replace(/,/g, "");
  } else if (decimalSep === ",") {
    numeric = s.replace(/\./g, "").replace(/,/g, ".");
  } else {
    numeric = s.replace(/[.,]/g, "");
  }

  const value = Number(numeric);
  if (!Number.isFinite(value)) return null;
  return { value, separatorAssumed };
}

// --- Magnitude suffix ---

// A number immediately followed by a magnitude suffix (letter or word form).
const MAGNITUDE_RE =
  /(\d(?:[\d.,\s ]*\d)?)\s*(billion|bn|mrd|million|mio|mln|mn|thousand|k|m|b)\b/i;

function magnitudeOf(tok: string): { factor: number; label: "K" | "M" | "B" } {
  const t = tok.toLowerCase();
  if (t === "billion" || t === "bn" || t === "mrd" || t === "b") return { factor: 1e9, label: "B" };
  if (t === "million" || t === "mio" || t === "mln" || t === "mn" || t === "m") return { factor: 1e6, label: "M" };
  return { factor: 1e3, label: "K" };
}

// --- Deterministic pass (NEVER calls an LLM) ---

interface DeterministicResult {
  parsed: boolean;
  amount: number | null;
  currency: string | null;
  ambiguous: boolean;
  separatorAssumed: NumericParse["separatorAssumed"];
  magnitudeApplied: "K" | "M" | "B" | null;
  signConvention: "parentheses_negative" | "explicit_negative" | "none";
  // Only set when parsed=false.
  failReason: "currency_symbol_only" | "no_numeric_amount" | null;
}

function runDeterministic(
  text: string,
  localeHint: string | undefined,
  def: string | null,
): DeterministicResult {
  const cur = detectCurrency(text, localeHint, def);

  // No marker at all → fall back to default_currency (a stated assumption, not a
  // guess, so not ambiguous), else null.
  let currency = cur.currency;
  let ambiguous = cur.ambiguous;
  if (!cur.detected && def) currency = def;

  const stripped = stripCurrencyMarkers(text);
  const hasDigit = /\d/.test(text);
  const strippedLetters = /[a-zA-Z]/.test(stripped);

  // Sign convention.
  let sign = 1;
  let signConvention: DeterministicResult["signConvention"] = "none";
  if (/\([^()]*\d[^()]*\)/.test(text)) {
    sign = -1;
    signConvention = "parentheses_negative";
  }

  // Magnitude + numeric token, both pulled from the currency-stripped string.
  let magnitudeFactor = 1;
  let magnitudeApplied: DeterministicResult["magnitudeApplied"] = null;
  let numToken: string | null = null;

  const magMatch = stripped.match(MAGNITUDE_RE);
  if (magMatch) {
    numToken = magMatch[1];
    const mag = magnitudeOf(magMatch[2]);
    magnitudeFactor = mag.factor;
    magnitudeApplied = mag.label;
  } else {
    const nm = stripped.match(/\d[\d.,\s ]*\d|\d/);
    if (nm) numToken = nm[0];
  }

  if (numToken === null) {
    const failReason =
      cur.detected && !hasDigit && !strippedLetters ? "currency_symbol_only" : "no_numeric_amount";
    return {
      parsed: false,
      amount: null,
      currency,
      ambiguous,
      separatorAssumed: "n/a",
      magnitudeApplied: null,
      signConvention,
      failReason,
    };
  }

  // Explicit leading negative (only when not already parenthesised).
  if (signConvention === "none") {
    const before = stripped.slice(0, stripped.indexOf(numToken));
    if (/-\s*$/.test(before)) {
      sign = -1;
      signConvention = "explicit_negative";
    }
  }

  const num = parseNumericCore(numToken, localeHint);
  if (num === null) {
    return {
      parsed: false,
      amount: null,
      currency,
      ambiguous,
      separatorAssumed: "n/a",
      magnitudeApplied: null,
      signConvention,
      failReason: "no_numeric_amount",
    };
  }

  // Round only to kill float artifacts (1e-6 precision) — never to 2dp, so
  // locale decimals like "1,234" → 1.234 survive intact.
  const amount = Math.round(sign * num.value * magnitudeFactor * 1e6) / 1e6;

  return {
    parsed: true,
    amount,
    currency,
    ambiguous,
    separatorAssumed: num.separatorAssumed,
    magnitudeApplied,
    signConvention,
    failReason: null,
  };
}

// --- Response envelope ---

function gradeFromScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

interface BuildArgs {
  parsed: boolean;
  amount: number | null;
  currency: string | null;
  raw: string;
  reason: string | null;
  method: "deterministic" | "llm" | "none";
  ambiguous: boolean;
  separatorAssumed: string;
  magnitudeApplied: "K" | "M" | "B" | null;
  signConvention: string;
  confidence: number;
  usedLlm: boolean;
}

function buildResponse(a: BuildArgs) {
  let score = 100;
  const findings: Array<{ rule: string; detail: string }> = [];

  if (!a.parsed) {
    score -= 30;
    findings.push({
      rule: "not_parsed",
      detail: "Could not parse a numeric money amount from the input",
    });
  }
  if (a.ambiguous) {
    score -= 10;
    findings.push({
      rule: "currency_ambiguous",
      detail: "Currency symbol/word maps to multiple ISO 4217 codes; resolution is best-effort",
    });
  }
  score = Math.max(0, score);

  return {
    data: {
      parsed: a.parsed,
      amount: a.amount,
      currency: a.currency,
      raw: a.raw,
      reason: a.reason,
    },
    meta: {
      method: a.method,
      currency_ambiguous: a.ambiguous,
      separator_assumed: a.separatorAssumed,
      magnitude_applied: a.magnitudeApplied,
      sign_convention: a.signConvention,
      confidence: a.confidence,
      used_llm: a.usedLlm,
    },
    score,
    grade: gradeFromScore(score),
    findings,
  };
}

// --- GET/HEAD return 402 so the Bazaar health prober sees a payment challenge ---

const moneyParsePaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      price: pricing.moneyParse,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  error: "Payment required",
};

moneyParseRouter.get("/money/parse", (_req: Request, res: Response) => {
  res.status(402).json(moneyParsePaymentRequired);
});

moneyParseRouter.head("/money/parse", (_req: Request, res: Response) => {
  res.status(402).end();
});

const anthropic = new Anthropic();

const LLM_SYSTEM_PROMPT =
  "You normalize a natural-language money amount into a typed value. " +
  "Reply with ONLY a JSON object (no markdown, no code fence, no prose) of the form " +
  '{"amount": number|null, "currency": "ISO 4217 code or null", "confidence": 0.0-1.0}. ' +
  "amount is the numeric value as a plain number (apply any magnitude words like " +
  '"hundred"/"thousand"/"million"). currency is the 3-letter ISO 4217 code if one is ' +
  "named or strongly implied, else null. If the text is not a money amount, return " +
  '{"amount": null, "currency": null, "confidence": 0}. Never guess wildly.';

function stripFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return text.trim();
}

function clampConfidence(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

// Returned (at HTTP 400) whenever `text` is present but NO monetary amount could
// be extracted from it — neither the deterministic pass nor the LLM fallback
// found a number. This MUST be a 4xx: @x402/express settles payment only when the
// final status is < 400, so a 200 here would bill the agent for input we couldn't
// parse (i.e. for our own miss). 400 leaves the call uncharged.
//
// Body shape matches the catalog house style for validation 400s — a single
// `error` string with the fix + a concrete example folded into the prose (same
// pattern as /translate/short, /classify, etc.) — so it is indistinguishable from
// every other endpoint's 400.
//
// NOTE: this is the opposite stance from /phone-intel and /cron-parser, where an
// "invalid" verdict IS the paid product. Here the product is an *amount*; with no
// amount there is nothing to sell, so it is a failure, not a verdict. The line is
// drawn at "was a number extracted?" — a successful parse with currency:null (no
// currency named) still has an amount, so it stays 200 and is charged.
const NO_AMOUNT_400 = {
  error:
    'could not parse a monetary amount from the provided text — pass text containing a money value, e.g. {"text":"$1,234.56"} or {"text":"USD 1.2M"}',
};

moneyParseRouter.post("/money/parse", async (req: Request, res: Response) => {
  try {
    const text = pickField(req.body ?? {}, ["text", "value", "string", "input"]);

    // --- Pre-work validation (UNCHARGED → 400) ---
    if (text === undefined || text === null || typeof text !== "string" || text.trim() === "") {
      throw new ValidationError('text is required — e.g. {"text":"€1.234,56"}');
    }
    if (text.length > MAX_TEXT_CHARS) {
      throw new ValidationError("text exceeds 1000 characters");
    }

    const { locale_hint, default_currency } = req.body ?? {};
    const localeHint =
      typeof locale_hint === "string" && locale_hint.trim() !== "" ? locale_hint.trim() : undefined;
    const def =
      typeof default_currency === "string" && ISO_CODES.has(default_currency.toUpperCase())
        ? default_currency.toUpperCase()
        : null;
    // allow_llm defaults true; only an explicit false disables the fallback.
    const allowLlm = req.body?.allow_llm !== false;

    const raw = text.trim();

    // --- DETERMINISTIC PASS (no LLM) ---
    const det = runDeterministic(raw, localeHint, def);

    if (det.parsed) {
      res.json(
        buildResponse({
          parsed: true,
          amount: det.amount,
          currency: det.currency,
          raw,
          reason: null,
          method: "deterministic",
          ambiguous: det.ambiguous,
          separatorAssumed: det.separatorAssumed,
          magnitudeApplied: det.magnitudeApplied,
          signConvention: det.signConvention,
          confidence: det.ambiguous ? 0.5 : 1.0,
          usedLlm: false,
        }),
      );
      return;
    }

    // Deterministic failed. Only escalate to the LLM for genuine natural-language
    // amounts (failReason "no_numeric_amount") when allowed — a bare currency
    // symbol has nothing for the model to parse.
    const escalate = allowLlm && det.failReason === "no_numeric_amount";

    if (!escalate) {
      // Deterministic found no amount and we won't escalate (bare currency
      // symbol, or allow_llm=false): no amount → 400 uncharged (see NO_AMOUNT_400).
      res.status(400).json(NO_AMOUNT_400);
      return;
    }

    // --- LLM FALLBACK (Haiku 4.5) ---
    // Retry-once on malformed JSON; the truncation guard applies to BOTH calls.
    // These guards apply ONLY here — the deterministic path returns no JSON.
    type LlmJson = { amount: unknown; currency: unknown; confidence: unknown };
    let parsedJson: LlmJson | null = null;
    for (let attempt = 0; attempt < 2 && parsedJson === null; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeouts.moneyParse);

      let response: Anthropic.Message;
      try {
        response = await anthropic.messages.create(
          {
            model: "claude-haiku-4-5-20251001",
            max_tokens: MAX_TOKENS,
            system: LLM_SYSTEM_PROMPT,
            messages: [{ role: "user", content: raw }],
          },
          { signal: controller.signal },
        );
      } catch (err) {
        clearTimeout(timer);
        // An API/abort error is terminal — there is no JSON to retry-parse.
        if (
          err instanceof Anthropic.APIError ||
          (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError"))
        ) {
          console.error("Money parse LLM error:", err);
          res.status(502).json({ error: "Parse failed" });
          return;
        }
        throw err;
      }
      clearTimeout(timer);

      // Truncation guard.
      if (response.stop_reason === "max_tokens") {
        res.status(502).json({ error: "Parse truncated" });
        return;
      }

      // Record token usage for per-call cost/margin logging (read at res.finish).
      res.locals.llmUsage = {
        model: "claude-haiku-4-5-20251001",
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };

      const textBlock = response.content.find(
        (block): block is Anthropic.ContentBlock & { type: "text" } => block.type === "text",
      );
      const rawText = textBlock ? textBlock.text : "";

      try {
        const candidate = JSON.parse(stripFences(rawText));
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          parsedJson = candidate as LlmJson;
        }
      } catch {
        // Malformed JSON — fall through to retry (or the 502 below).
      }
    }

    if (parsedJson === null) {
      res.status(502).json({ error: "Parse failed" });
      return;
    }

    const llmAmount = parsedJson.amount;
    const llmConfidence = clampConfidence(parsedJson.confidence);
    const llmCurrency =
      typeof parsedJson.currency === "string" && ISO_CODES.has(parsedJson.currency.toUpperCase())
        ? parsedJson.currency.toUpperCase()
        : null;

    if (typeof llmAmount === "number" && Number.isFinite(llmAmount)) {
      res.json(
        buildResponse({
          parsed: true,
          amount: Math.round(llmAmount * 1e6) / 1e6,
          currency: llmCurrency,
          raw,
          reason: null,
          method: "llm",
          ambiguous: false,
          separatorAssumed: "n/a",
          magnitudeApplied: null,
          signConvention: "none",
          confidence: llmConfidence,
          usedLlm: true,
        }),
      );
      return;
    }

    // LLM ran but produced no numeric amount — "this isn't money". No amount to
    // return → 400 uncharged (see NO_AMOUNT_400). We still incurred the model
    // cost (logged via res.locals.llmUsage above); we eat it rather than bill the
    // agent for input that yielded no result.
    res.status(400).json(NO_AMOUNT_400);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Money parse error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
