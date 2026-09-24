import { Router, type Request, type Response } from "express";
import { nsPresence } from "../utils/dns-resolvers.js";
import { validateDomain, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";

export const domainAvailabilityRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

interface DomainResult {
  domain: string;
  available: boolean;
  status: "available" | "registered";
  registrar: string | null;
  expires_at: string | null;
  days_until_expiry: number | null;
  expiring_soon: boolean;
}

// --- Constants ---

const DEFAULT_TLDS = [".com", ".net", ".org", ".io", ".co", ".dev", ".app", ".ai", ".xyz", ".me"];

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

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

async function getBootstrap(): Promise<{ services: string[][][] }> {
  const res = await fetch("https://data.iana.org/rdap/dns.json", {
    signal: AbortSignal.timeout(timeouts.domainAvailability),
  });
  return (await res.json()) as { services: string[][][] };
}

function findRdapServer(bootstrap: { services: string[][][] }, tld: string): string | null {
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

async function checkSingleDomain(fullDomain: string, bootstrap: { services: string[][][] }): Promise<DomainResult> {
  const tld = fullDomain.slice(fullDomain.lastIndexOf(".") + 1);
  const now = new Date();

  // Method 1: RDAP lookup
  const rdapServer = findRdapServer(bootstrap, tld);
  if (rdapServer) {
    try {
      const rdapRes = await fetch(`${rdapServer}/domain/${fullDomain}`, {
        signal: AbortSignal.timeout(timeouts.domainAvailability),
      });

      if (rdapRes.status === 404) {
        return {
          domain: fullDomain,
          available: true,
          status: "available",
          registrar: null,
          expires_at: null,
          days_until_expiry: null,
          expiring_soon: false,
        };
      }

      if (rdapRes.ok) {
        const data = (await rdapRes.json()) as Record<string, unknown>;
        const registrar = extractRegistrar(data.entities as unknown[]);
        const expiresAt = extractExpiry(data.events as unknown[]);
        let daysUntilExpiry: number | null = null;
        let expiringSoon = false;

        if (expiresAt) {
          daysUntilExpiry = daysBetween(now, new Date(expiresAt));
          expiringSoon = daysUntilExpiry < 90;
        }

        return {
          domain: fullDomain,
          available: false,
          status: "registered",
          registrar,
          expires_at: expiresAt,
          days_until_expiry: daysUntilExpiry,
          expiring_soon: expiringSoon,
        };
      }
    } catch {
      // RDAP failed, fall through to DNS fallback
    }
  }

  // Method 2: DNS NS record fallback. Only NXDOMAIN may claim "available" —
  // SERVFAIL means a registered-but-lame domain, and with RDAP already failed
  // an unverified claim of availability is the worse error, so anything short
  // of NXDOMAIN reports registered.
  if ((await nsPresence(fullDomain)) !== "available") {
    return {
      domain: fullDomain,
      available: false,
      status: "registered",
      registrar: null,
      expires_at: null,
      days_until_expiry: null,
      expiring_soon: false,
    };
  }

  return {
    domain: fullDomain,
    available: true,
    status: "available",
    registrar: null,
    expires_at: null,
    days_until_expiry: null,
    expiring_soon: false,
  };
}

// --- Extracted single-domain logic (shared with the domain-due-diligence aggregator) ---

export interface AvailabilityResult {
  is_available: boolean;
  status: "available" | "registered";
  registrar: string | null;
  expires_at: string | null;
}

/**
 * Resolve registration status for a single fully-qualified domain.
 * Throws if the RDAP bootstrap fetch fails (the caller treats that as a failed section).
 */
export async function runDomainAvailability(fullDomain: string): Promise<AvailabilityResult> {
  const bootstrap = await getBootstrap();
  const result = await checkSingleDomain(fullDomain, bootstrap);
  return {
    is_available: result.available,
    status: result.status,
    registrar: result.registrar,
    expires_at: result.expires_at,
  };
}

// --- Route handler ---

domainAvailabilityRouter.get("/domain-availability/check", async (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string | undefined;

    if (!rawDomain) {
      res.status(400).json({ error: "domain is required" });
      return;
    }

    const input = rawDomain.trim().toLowerCase();

    // Determine if TLD is present
    const hasTld = input.includes(".");
    let name: string;
    let domainsToCheck: string[];

    if (hasTld) {
      // Validate as full domain
      const validated = validateDomain(input);
      const dotIdx = validated.indexOf(".");
      name = validated.slice(0, dotIdx);
      domainsToCheck = [validated];
    } else {
      // Validate name part only
      if (!NAME_RE.test(input)) {
        throw new ValidationError("Invalid domain name format");
      }
      name = input;
      domainsToCheck = DEFAULT_TLDS.map((tld) => `${input}${tld}`);
    }

    // Fetch RDAP bootstrap
    let bootstrap: { services: string[][][] };
    try {
      bootstrap = await getBootstrap();
    } catch {
      res.status(500).json({ error: "Failed to fetch RDAP bootstrap data" });
      return;
    }

    // Check all domains concurrently
    const settled = await Promise.allSettled(
      domainsToCheck.map((d) => checkSingleDomain(d, bootstrap)),
    );

    const results: DomainResult[] = settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      return {
        domain: domainsToCheck[i],
        available: true,
        status: "available" as const,
        registrar: null,
        expires_at: null,
        days_until_expiry: null,
        expiring_soon: false,
      };
    });

    const availableTlds = results.filter((r) => r.available).map((r) => r.domain.slice(r.domain.indexOf(".")));
    const takenTlds = results.filter((r) => !r.available).map((r) => r.domain.slice(r.domain.indexOf(".")));

    // Grading
    let score = 100;
    const findings: Finding[] = [];

    const comResult = results.find((r) => r.domain.endsWith(".com"));
    if (comResult && !comResult.available) {
      findings.push({ rule: "com_taken", deduction: -20, detail: `${comResult.domain} is already registered` });
      score -= 20;
    }

    const netResult = results.find((r) => r.domain.endsWith(".net"));
    if (netResult && !netResult.available) {
      findings.push({ rule: "net_taken", deduction: -10, detail: `${netResult.domain} is already registered` });
      score -= 10;
    }

    const orgResult = results.find((r) => r.domain.endsWith(".org"));
    if (orgResult && !orgResult.available) {
      findings.push({ rule: "org_taken", deduction: -10, detail: `${orgResult.domain} is already registered` });
      score -= 10;
    }

    const ioResult = results.find((r) => r.domain.endsWith(".io"));
    if (comResult && !comResult.available && netResult && !netResult.available && orgResult && !orgResult.available && ioResult && !ioResult.available) {
      findings.push({ rule: "all_premium_taken", deduction: -20, detail: ".com, .net, .org, .io all taken" });
      score -= 20;
    }

    if (results.length > 0 && results.every((r) => !r.available)) {
      findings.push({ rule: "all_checked_taken", deduction: -40, detail: "Every TLD checked is registered" });
      score -= 40;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    res.json({
      name,
      results,
      available_tlds: availableTlds,
      taken_tlds: takenTlds,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Domain availability error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
