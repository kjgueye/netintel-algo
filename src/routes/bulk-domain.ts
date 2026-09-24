import { Router, type Request, type Response } from "express";
import { nsPresence } from "../utils/dns-resolvers.js";
import { checkSsrf, ValidationError } from "../utils/validators.js";
import { timeouts, pricing } from "../config.js";
import { signableAccepts } from "../accepts.js";

export const bulkDomainRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

interface Combination {
  name: string;
  tld: string;
  domain: string;
}

interface DomainResult {
  domain: string;
  name: string;
  tld: string;
  available: boolean;
  status: "available" | "registered";
  registrar: string | null;
  expires_at: string | null;
  days_until_expiry: number | null;
}

interface Bootstrap {
  services: string[][][];
}

// --- Constants ---

const DEFAULT_TLDS = [".com", ".net", ".org", ".io", ".co"];

const MAX_COMBINATIONS = 50;

// Name: alphanumeric + hyphens, 2-63 chars, no leading/trailing hyphen.
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])$/;

// TLD: 2-24 chars alphanumeric.
const TLD_RE = /^[a-z0-9]{2,24}$/;

// --- Helpers ---

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

function extractRegistrar(entities: unknown[]): string | null {
  if (!Array.isArray(entities)) return null;
  for (const entity of entities) {
    const e = entity as Record<string, unknown>;
    const roles = e.roles as string[] | undefined;
    if (!roles?.includes("registrar")) continue;

    const vcardArray = e.vcardArray as unknown[] | undefined;
    if (Array.isArray(vcardArray) && Array.isArray(vcardArray[1])) {
      for (const field of vcardArray[1] as unknown[][]) {
        if (Array.isArray(field) && field[0] === "fn") {
          return String(field[3]);
        }
      }
    }
  }
  return null;
}

function extractExpiry(events: unknown[]): string | null {
  if (!Array.isArray(events)) return null;
  for (const evt of events) {
    const e = evt as Record<string, unknown>;
    if (e.eventAction === "expiration") return e.eventDate as string;
  }
  return null;
}

async function getBootstrap(): Promise<Bootstrap> {
  const res = await fetch("https://data.iana.org/rdap/dns.json", {
    signal: AbortSignal.timeout(timeouts.bulkDomain),
  });
  return (await res.json()) as Bootstrap;
}

function findRdapServer(bootstrap: Bootstrap, tld: string): string | null {
  if (!Array.isArray(bootstrap.services)) return null;
  for (const service of bootstrap.services) {
    const tlds = service[0];
    const urls = service[1];
    if (Array.isArray(tlds) && tlds.includes(tld) && Array.isArray(urls) && urls.length > 0) {
      return urls[0].replace(/\/+$/, "");
    }
  }
  return null;
}

async function checkSingleDomain(combo: Combination, bootstrap: Bootstrap): Promise<DomainResult> {
  const { name, tld, domain } = combo;
  const now = new Date();

  // Method 1: RDAP lookup
  const rdapServer = findRdapServer(bootstrap, tld);
  if (rdapServer) {
    try {
      // SSRF guard on the RDAP endpoint before fetching.
      await checkSsrf(new URL(rdapServer).hostname);

      const rdapRes = await fetch(`${rdapServer}/domain/${domain}`, {
        signal: AbortSignal.timeout(timeouts.bulkDomain),
      });

      if (rdapRes.status === 404) {
        return {
          domain,
          name,
          tld,
          available: true,
          status: "available",
          registrar: null,
          expires_at: null,
          days_until_expiry: null,
        };
      }

      if (rdapRes.ok) {
        const data = (await rdapRes.json()) as Record<string, unknown>;
        const registrar = extractRegistrar(data.entities as unknown[]);
        const expiresAt = extractExpiry(data.events as unknown[]);
        const daysUntilExpiry = expiresAt ? daysBetween(now, new Date(expiresAt)) : null;

        return {
          domain,
          name,
          tld,
          available: false,
          status: "registered",
          registrar,
          expires_at: expiresAt,
          days_until_expiry: daysUntilExpiry,
        };
      }
    } catch {
      // RDAP failed (or SSRF blocked) — fall through to DNS fallback
    }
  }

  // Method 2: DNS NS record fallback. Only NXDOMAIN may claim "available" —
  // SERVFAIL means a registered-but-lame domain, and with RDAP already failed
  // an unverified claim of availability is the worse error, so anything short
  // of NXDOMAIN reports registered.
  if ((await nsPresence(domain)) !== "available") {
    return {
      domain,
      name,
      tld,
      available: false,
      status: "registered",
      registrar: null,
      expires_at: null,
      days_until_expiry: null,
    };
  }

  return {
    domain,
    name,
    tld,
    available: true,
    status: "available",
    registrar: null,
    expires_at: null,
    days_until_expiry: null,
  };
}

// --- Extracted check logic (shared with the domain-vet aggregator) ---

/**
 * RDAP bootstrap could not be fetched — the one failure the route reports as a
 * 500 with its own message rather than a generic "Internal server error".
 * A distinct class so callers (route + aggregators) can tell it apart from a
 * ValidationError without string-matching.
 */
export class BulkDomainBootstrapError extends Error {
  constructor() {
    super("Failed to fetch RDAP bootstrap data");
    this.name = "BulkDomainBootstrapError";
  }
}

/**
 * Check every name × TLD combination for availability. Validates and normalizes
 * its inputs (throws ValidationError on bad input, BulkDomainBootstrapError when
 * IANA's RDAP bootstrap is unreachable) and returns the same object shape the
 * /bulk-domain/check route responds with.
 */
export async function runBulkDomain(rawNames: unknown, rawTlds?: unknown) {
    // Validate names presence
    if (!Array.isArray(rawNames) || rawNames.length === 0) {
      throw new ValidationError("names is required and must contain at least one name");
    }

    // Normalize + validate names
    const names: string[] = [];
    for (const raw of rawNames) {
      const name = String(raw).trim().toLowerCase();
      if (!NAME_RE.test(name)) {
        throw new ValidationError(`Invalid domain name format: ${raw}`);
      }
      names.push(name);
    }

    // Normalize + validate TLDs (default if absent)
    const tldSource =
      Array.isArray(rawTlds) && rawTlds.length > 0 ? rawTlds : DEFAULT_TLDS;
    const tlds: string[] = [];
    for (const raw of tldSource) {
      const tld = String(raw).trim().toLowerCase().replace(/^\./, "");
      if (!TLD_RE.test(tld)) {
        throw new ValidationError(`Invalid TLD format: ${raw}`);
      }
      tlds.push(tld);
    }

    // Build the full matrix of name × TLD combinations
    if (names.length * tlds.length > MAX_COMBINATIONS) {
      throw new ValidationError("Total domain combinations (names × tlds) cannot exceed 50");
    }

    const combinations: Combination[] = [];
    for (const name of names) {
      for (const tld of tlds) {
        combinations.push({ name, tld, domain: `${name}.${tld}` });
      }
    }

    // Fetch RDAP bootstrap ONCE and reuse across all combinations
    let bootstrap: Bootstrap;
    try {
      bootstrap = await getBootstrap();
    } catch {
      throw new BulkDomainBootstrapError();
    }

    // Check all combinations concurrently
    const settled = await Promise.allSettled(
      combinations.map((c) => checkSingleDomain(c, bootstrap)),
    );

    const results: DomainResult[] = settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      const c = combinations[i];
      return {
        domain: c.domain,
        name: c.name,
        tld: c.tld,
        available: true,
        status: "available" as const,
        registrar: null,
        expires_at: null,
        days_until_expiry: null,
      };
    });

    // Aggregate stats
    const totalChecked = results.length;
    const availableCount = results.filter((r) => r.available).length;
    const takenCount = totalChecked - availableCount;

    // Names available across ALL requested TLDs
    const namesAvailableAllTlds = names.filter((name) => {
      const forName = results.filter((r) => r.name === name);
      return forName.length > 0 && forName.every((r) => r.available);
    });
    // De-duplicate while preserving order
    const cleanNames = [...new Set(namesAvailableAllTlds)];

    // Grading — higher score = more naming opportunity
    let score = 100;
    const findings: Finding[] = [];
    const ratio = totalChecked > 0 ? availableCount / totalChecked : 0;

    if (availableCount === 0) {
      findings.push({
        rule: "nothing_available",
        deduction: -60,
        detail: "No requested domain combinations are available",
      });
      score -= 60;
    }

    if (ratio < 0.34) {
      findings.push({
        rule: "low_availability",
        deduction: -35,
        detail: `Only ${availableCount} of ${totalChecked} combinations available`,
      });
      score -= 35;
    } else if (ratio < 0.67) {
      findings.push({
        rule: "medium_availability",
        deduction: -15,
        detail: `${availableCount} of ${totalChecked} combinations available`,
      });
      score -= 15;
    }

    if (cleanNames.length === 0) {
      findings.push({
        rule: "no_clean_names",
        deduction: -10,
        detail: "No name is available across all requested TLDs",
      });
      score -= 10;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    return {
      total_checked: totalChecked,
      available_count: availableCount,
      taken_count: takenCount,
      names_available_all_tlds: cleanNames,
      results,
      score,
      grade,
      findings,
    };
}

// --- Route handler ---

// GET/HEAD return 402 so cold discovery probes see a payment challenge instead
// of a 405 (GET-only crawlers listed this as dead/priceless). Same pattern as classify.
const bulkDomainPaymentRequired = {
  x402Version: 2,
  accepts: signableAccepts(pricing.bulkDomain),
  error: "Payment required",
};
bulkDomainRouter.get("/bulk-domain/check", (_req: Request, res: Response) => {
  res.status(402).json(bulkDomainPaymentRequired);
});
bulkDomainRouter.head("/bulk-domain/check", (_req: Request, res: Response) => {
  res.status(402).end();
});

bulkDomainRouter.post("/bulk-domain/check", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    res.json(await runBulkDomain(body.names, body.tlds));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof BulkDomainBootstrapError) {
      res.status(500).json({ error: err.message });
      return;
    }
    console.error("Bulk domain error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
