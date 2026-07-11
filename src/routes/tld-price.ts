import { Router, type Request, type Response } from "express";
import { ValidationError } from "../utils/validators.js";

export const tldPriceRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

interface TldPrice {
  register: number;
  renew: number;
  transfer: number;
}

interface Option {
  domain: string;
  tld: string;
  register: number;
  renew: number;
}

// --- Reference pricing table (USD, typical retail across major registrars) ---
// Reference data only — not a live per-registrar quote.
const PRICING: Record<string, TldPrice> = {
  com: { register: 10.99, renew: 14.99, transfer: 9.99 },
  net: { register: 12.99, renew: 16.99, transfer: 11.99 },
  org: { register: 11.99, renew: 15.99, transfer: 10.99 },
  io: { register: 39.99, renew: 49.99, transfer: 39.99 },
  co: { register: 24.99, renew: 29.99, transfer: 24.99 },
  ai: { register: 69.99, renew: 89.99, transfer: 69.99 },
  app: { register: 14.99, renew: 18.99, transfer: 14.99 },
  dev: { register: 14.99, renew: 16.99, transfer: 14.99 },
  xyz: { register: 1.99, renew: 13.99, transfer: 11.99 },
  me: { register: 8.99, renew: 24.99, transfer: 19.99 },
  "co.uk": { register: 7.99, renew: 9.99, transfer: 0 },
  info: { register: 3.99, renew: 21.99, transfer: 17.99 },
  biz: { register: 5.99, renew: 19.99, transfer: 16.99 },
  tech: { register: 4.99, renew: 49.99, transfer: 39.99 },
  store: { register: 4.99, renew: 59.99, transfer: 49.99 },
  online: { register: 1.99, renew: 39.99, transfer: 32.99 },
  site: { register: 2.99, renew: 34.99, transfer: 29.99 },
  cloud: { register: 9.99, renew: 21.99, transfer: 18.99 },
  shop: { register: 2.99, renew: 35.99, transfer: 29.99 },
  tv: { register: 24.99, renew: 29.99, transfer: 24.99 },
  us: { register: 4.99, renew: 9.99, transfer: 8.99 },
};

// TLDs considered "premium" / mainstream for cheapest_premium reporting.
const PREMIUM_TLDS = ["com", "net", "org", "io", "co", "ai"];

const CURRENCY = "USD";
const PREDATORY_MARKUP_THRESHOLD = 100; // renewal > 2x first-year register

// --- Validation ---

const TLD_RE = /^[a-z0-9]+(?:\.[a-z0-9]+)*$/;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const BOTH_OR_NEITHER_ERROR =
  "Provide either 'tld' (to compare registrars) or 'name' (to compare TLDs), but not both";

// --- Grading ---

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Mode A: single TLD across registrars ---

function compareTld(rawTld: string) {
  const tld = rawTld.trim().toLowerCase().replace(/^\./, "");
  if (!TLD_RE.test(tld)) {
    throw new ValidationError("Invalid tld");
  }

  const findings: Finding[] = [];
  let score = 100;

  const entry = PRICING[tld];
  if (!entry) {
    findings.push({
      rule: "unknown_tld",
      deduction: -60,
      detail: `'${tld}' is not in the reference pricing table`,
    });
    score -= 60;
    score = Math.max(0, score);
    return {
      mode: "tld" as const,
      tld,
      pricing: null,
      renewal_markup_pct: null,
      predatory_renewal: false,
      is_reference_pricing: true,
      score,
      grade: calculateGrade(score),
      findings,
    };
  }

  const renewalMarkupPct = Math.round(
    ((entry.renew - entry.register) / entry.register) * 100,
  );
  const predatoryRenewal = renewalMarkupPct > PREDATORY_MARKUP_THRESHOLD;

  return {
    mode: "tld" as const,
    tld,
    pricing: {
      register: entry.register,
      renew: entry.renew,
      transfer: entry.transfer,
      currency: CURRENCY,
    },
    renewal_markup_pct: renewalMarkupPct,
    predatory_renewal: predatoryRenewal,
    is_reference_pricing: true,
    score,
    grade: calculateGrade(score),
    findings,
  };
}

// --- Mode B: single name across TLDs ---

function compareName(rawName: string) {
  const name = rawName.trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new ValidationError("Invalid name — provide a domain name without a TLD");
  }

  const options: Option[] = Object.entries(PRICING)
    .map(([tld, price]) => ({
      domain: `${name}.${tld}`,
      tld,
      register: price.register,
      renew: price.renew,
    }))
    .sort((a, b) => a.register - b.register);

  const cheapest = { domain: options[0].domain, register: options[0].register };

  const premiumOptions = options.filter((o) => PREMIUM_TLDS.includes(o.tld));
  const cheapestPremium = premiumOptions.length
    ? { domain: premiumOptions[0].domain, register: premiumOptions[0].register }
    : null;

  return {
    mode: "name" as const,
    name,
    cheapest,
    cheapest_premium: cheapestPremium,
    options,
    is_reference_pricing: true,
    score: 100,
    grade: "A",
    findings: [] as Finding[],
  };
}

// --- Extracted dispatch logic (shared with the domain-due-diligence aggregator) ---

/**
 * Mode A (compare registrars for a TLD) when `tld` is given; Mode B (compare
 * TLDs for a name) when `name` is given. Exactly one must be provided — throws
 * ValidationError otherwise. Returns the same object the route responds with.
 */
export function runTldPrice(opts: { tld?: string; name?: string }) {
  const hasTld = opts.tld !== undefined && opts.tld.trim() !== "";
  const hasName = opts.name !== undefined && opts.name.trim() !== "";

  if (hasTld === hasName) {
    throw new ValidationError(BOTH_OR_NEITHER_ERROR);
  }

  return hasTld ? compareTld(opts.tld as string) : compareName(opts.name as string);
}

// --- Route handler ---

tldPriceRouter.get("/tld-price/compare", (req: Request, res: Response) => {
  try {
    const tld = req.query.tld as string | undefined;
    const name = req.query.name as string | undefined;

    const result = runTldPrice({ tld, name });
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("TLD price compare error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
