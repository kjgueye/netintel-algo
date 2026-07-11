import { Router, type Request, type Response } from "express";
import { validateDomain, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";

export const whoisRdapRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

// --- Helpers ---

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

const ABUSE_FLAGS = new Set([
  "pending delete",
  "redemption period",
  "client hold",
  "server hold",
]);

function extractRegistrar(entities: unknown[]): { name: string | null; iana_id: string | null } {
  if (!Array.isArray(entities)) return { name: null, iana_id: null };
  for (const entity of entities) {
    const e = entity as Record<string, unknown>;
    const roles = e.roles as string[] | undefined;
    if (!roles?.includes("registrar")) continue;

    let name: string | null = null;
    const vcardArray = e.vcardArray as unknown[] | undefined;
    if (Array.isArray(vcardArray) && Array.isArray(vcardArray[1])) {
      for (const field of vcardArray[1] as unknown[][]) {
        if (Array.isArray(field) && field[0] === "fn") {
          name = String(field[3]);
          break;
        }
      }
    }

    const publicIds = e.publicIds as Array<{ type: string; identifier: string }> | undefined;
    let ianaId: string | null = null;
    if (Array.isArray(publicIds)) {
      const ianaEntry = publicIds.find((p) => p.type === "IANA Registrar ID");
      if (ianaEntry) ianaId = ianaEntry.identifier;
    }

    return { name, iana_id: ianaId };
  }
  return { name: null, iana_id: null };
}

function extractEvents(events: unknown[]): { created_at: string | null; updated_at: string | null; expires_at: string | null } {
  const result = { created_at: null as string | null, updated_at: null as string | null, expires_at: null as string | null };
  if (!Array.isArray(events)) return result;
  for (const evt of events) {
    const e = evt as Record<string, unknown>;
    const action = e.eventAction as string;
    const date = e.eventDate as string;
    if (action === "registration") result.created_at = date;
    else if (action === "last changed") result.updated_at = date;
    else if (action === "expiration") result.expires_at = date;
  }
  return result;
}

function extractNameservers(nameservers: unknown[]): string[] {
  if (!Array.isArray(nameservers)) return [];
  return nameservers
    .map((ns) => {
      const n = ns as Record<string, unknown>;
      return (n.ldhName as string)?.toLowerCase() ?? null;
    })
    .filter((v): v is string => v !== null);
}

function extractStatus(statusArr: unknown): string[] {
  if (!Array.isArray(statusArr)) return [];
  return statusArr
    .map((s) => String(s).replace(/https?:\/\/icann\.org\/epp#/i, "").replace(/([A-Z])/g, " $1").trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

// ccTLD registries that RUN public RDAP servers but are absent from IANA's
// bootstrap file (ccTLDs aren't required to register there). Each entry was
// verified live to serve /domain/<name> with valid RDAP JSON. Production data:
// paid .io lookups 404'd "No RDAP server found" — a supported-looking TLD we
// could actually serve. Identity Digital runs the backend for all four.
const SUPPLEMENTAL_RDAP: Record<string, string> = {
  io: "https://rdap.identitydigital.services/rdap",
  me: "https://rdap.identitydigital.services/rdap",
  sh: "https://rdap.identitydigital.services/rdap",
  ac: "https://rdap.identitydigital.services/rdap",
};

/** RDAP base URL for a TLD: the IANA bootstrap first, then the supplemental map. */
function rdapServerForTld(
  bootstrapData: { services: string[][][] },
  tld: string
): string | null {
  if (Array.isArray(bootstrapData.services)) {
    for (const service of bootstrapData.services) {
      const tlds = service[0];
      const urls = service[1];
      if (Array.isArray(tlds) && tlds.includes(tld) && Array.isArray(urls) && urls.length > 0) {
        return urls[0].replace(/\/+$/, "");
      }
    }
  }
  return SUPPLEMENTAL_RDAP[tld] ?? null;
}

// --- Extracted RDAP logic (shared with the domain-report-full aggregator) ---

export interface WhoisRdapResult {
  registrar: string | null;
  registrar_iana_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  expires_at: string | null;
  days_until_expiry: number | null;
  name_servers: string[];
  status: string[];
}

/**
 * Resolve RDAP registration metadata for a single domain, reusing the same
 * parsing helpers as the route handler. Throws on any failure (no RDAP server,
 * SSRF rejection, non-200, fetch error) so the aggregator can mark the section
 * failed. The route handler keeps its own richer error responses unchanged.
 */
export async function runWhoisRdap(domain: string): Promise<WhoisRdapResult> {
  const tld = domain.slice(domain.lastIndexOf(".") + 1);

  const bootstrapRes = await fetch("https://data.iana.org/rdap/dns.json", {
    signal: AbortSignal.timeout(timeouts.whoisRdap),
  });
  const bootstrapData = (await bootstrapRes.json()) as { services: string[][][] };

  const rdapBaseUrl = rdapServerForTld(bootstrapData, tld);

  if (!rdapBaseUrl) {
    throw new Error(`No RDAP server found for TLD: .${tld}`);
  }

  const rdapUrl = `${rdapBaseUrl}/domain/${domain}`;
  const { checkSsrf } = await import("../utils/validators.js");
  await checkSsrf(new URL(rdapBaseUrl).hostname);

  const rdapRes = await fetch(rdapUrl, {
    signal: AbortSignal.timeout(timeouts.whoisRdap),
  });
  if (!rdapRes.ok) {
    throw new Error(`RDAP server returned ${rdapRes.status}`);
  }
  const rdapData = (await rdapRes.json()) as Record<string, unknown>;

  const registrar = extractRegistrar(rdapData.entities as unknown[]);
  const dates = extractEvents(rdapData.events as unknown[]);
  const nameServers = extractNameservers(rdapData.nameservers as unknown[]);
  const status = extractStatus(rdapData.status);

  let daysUntilExpiry: number | null = null;
  if (dates.expires_at) {
    daysUntilExpiry = daysBetween(new Date(), new Date(dates.expires_at));
  }

  return {
    registrar: registrar.name,
    registrar_iana_id: registrar.iana_id,
    created_at: dates.created_at,
    updated_at: dates.updated_at,
    expires_at: dates.expires_at,
    days_until_expiry: daysUntilExpiry,
    name_servers: nameServers,
    status,
  };
}

// --- Route handler ---

whoisRdapRouter.get("/whois-rdap/lookup", async (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string | undefined;

    if (!rawDomain) {
      res.status(400).json({
        error: 'domain is required — pass it as a query param, e.g. ?domain=example.com',
      });
      return;
    }

    const domain = validateDomain(rawDomain);
    const tld = domain.slice(domain.lastIndexOf(".") + 1);

    // Step 1: Fetch RDAP bootstrap registry
    let bootstrapData: { services: string[][][] };
    try {
      const bootstrapRes = await fetch("https://data.iana.org/rdap/dns.json", {
        signal: AbortSignal.timeout(timeouts.whoisRdap),
      });
      bootstrapData = (await bootstrapRes.json()) as { services: string[][][] };
    } catch (err) {
      res.status(500).json({ error: `RDAP lookup failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    // Find RDAP base URL for the TLD (IANA bootstrap, then supplemental ccTLDs)
    const rdapBaseUrl = rdapServerForTld(bootstrapData, tld);

    if (!rdapBaseUrl) {
      res.status(404).json({
        error:
          `No RDAP server found for TLD: .${tld} — this registry publishes no public RDAP service ` +
          `(it is not in the IANA bootstrap), so registration data is unavailable here.`,
      });
      return;
    }

    // Step 2: SSRF check on the dynamic RDAP URL
    const rdapUrl = `${rdapBaseUrl}/domain/${domain}`;
    let rdapHostname: string;
    try {
      rdapHostname = new URL(rdapBaseUrl).hostname;
    } catch {
      res.status(500).json({ error: "RDAP lookup failed: invalid RDAP server URL" });
      return;
    }

    // Import checkSsrf dynamically to keep it testable
    const { checkSsrf } = await import("../utils/validators.js");
    await checkSsrf(rdapHostname);

    // Step 3: Fetch RDAP data
    let rdapData: Record<string, unknown>;
    let rdapLookupFailed = false;
    try {
      const rdapRes = await fetch(rdapUrl, {
        signal: AbortSignal.timeout(timeouts.whoisRdap),
      });
      if (!rdapRes.ok) {
        rdapLookupFailed = true;
        rdapData = {};
      } else {
        rdapData = (await rdapRes.json()) as Record<string, unknown>;
      }
    } catch (err) {
      res.status(500).json({ error: `RDAP lookup failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    // Parse RDAP response
    const registrar = extractRegistrar(rdapData.entities as unknown[]);
    const dates = extractEvents(rdapData.events as unknown[]);
    const nameServers = extractNameservers(rdapData.nameservers as unknown[]);
    const status = extractStatus(rdapData.status);

    const now = new Date();
    let daysUntilExpiry: number | null = null;
    if (dates.expires_at) {
      const expiryDate = new Date(dates.expires_at);
      daysUntilExpiry = daysBetween(now, expiryDate);
    }

    let daysSinceCreation: number | null = null;
    if (dates.created_at) {
      const createdDate = new Date(dates.created_at);
      daysSinceCreation = daysBetween(createdDate, now);
    }

    const statusHasAbuseFlags = status.some((s) => ABUSE_FLAGS.has(s));

    // Scoring
    let score = 100;
    const findings: Finding[] = [];

    if (rdapLookupFailed) {
      findings.push({ rule: "rdap_lookup_failed", deduction: -50, detail: "RDAP server returned non-200 or unparseable response" });
      score -= 50;
    }

    if (!registrar.name) {
      findings.push({ rule: "no_registrar", deduction: -20, detail: "Registrar information is missing" });
      score -= 20;
    }

    if (daysUntilExpiry !== null) {
      if (daysUntilExpiry < 30) {
        findings.push({ rule: "expires_within_30_days", deduction: -40, detail: `Domain expires in ${daysUntilExpiry} days` });
        score -= 40;
      } else if (daysUntilExpiry < 90) {
        findings.push({ rule: "expires_within_90_days", deduction: -15, detail: `Domain expires in ${daysUntilExpiry} days` });
        score -= 15;
      }
    }

    if (daysSinceCreation !== null) {
      if (daysSinceCreation < 30) {
        findings.push({ rule: "registered_within_30_days", deduction: -30, detail: `Domain was registered ${daysSinceCreation} days ago` });
        score -= 30;
      } else if (daysSinceCreation < 90) {
        findings.push({ rule: "registered_within_90_days", deduction: -10, detail: `Domain was registered ${daysSinceCreation} days ago` });
        score -= 10;
      }
    }

    if (statusHasAbuseFlags) {
      findings.push({ rule: "abuse_status_flag", deduction: -25, detail: `Status contains abuse-related flags: ${status.filter((s) => ABUSE_FLAGS.has(s)).join(", ")}` });
      score -= 25;
    }

    if (nameServers.length === 0) {
      findings.push({ rule: "no_nameservers", deduction: -20, detail: "No nameservers found" });
      score -= 20;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    res.json({
      domain,
      tld,
      rdap_url: rdapUrl,
      registrar: registrar.name,
      registrar_iana_id: registrar.iana_id,
      created_at: dates.created_at,
      updated_at: dates.updated_at,
      expires_at: dates.expires_at,
      days_until_expiry: daysUntilExpiry,
      name_servers: nameServers,
      status,
      status_has_abuse_flags: statusHasAbuseFlags,
      score,
      grade,
      findings,
      raw_rdap_url: rdapUrl,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("WHOIS/RDAP error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
