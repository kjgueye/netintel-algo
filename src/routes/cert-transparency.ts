import { Router, type Request, type Response } from "express";
import { validateDomain, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";

export const certTransparencyRouter = Router();

interface CrtShEntry {
  id: number;
  issuer_ca_id: number;
  issuer_name: string;
  common_name: string;
  name_value: string;
  not_before: string;
  not_after: string;
  entry_timestamp: string;
}

interface CertResult {
  id: number;
  common_name: string;
  issuer: string;
  not_before: string;
  not_after: string;
  sans: string[];
  is_wildcard: boolean;
  is_expired: boolean;
  days_until_expiry: number;
}

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

function extractIssuerName(issuerDn: string): string {
  const match = issuerDn.match(/O=([^,]+)/);
  return match ? match[1].trim() : issuerDn;
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// Short success cache for crt.sh lookups. CT log data changes slowly, and
// crt.sh is the flakiest upstream in the catalog (production: paid 502s from
// transient crt.sh 502/404s) — serving a recent result beats re-rolling those
// dice. Keyed by the full crt.sh URL (domain + subdomain flag).
const CRT_CACHE_TTL_MS = 5 * 60_000;
const CRT_CACHE_MAX = 200;
const crtCache = new Map<string, { at: number; data: CrtShEntry[] }>();

/** Test-only: clear the crt.sh cache so cases don't bleed into one another. */
export function __resetCrtCache(): void {
  crtCache.clear();
}

// --- Fallback CT provider: sslmate certspotter ---------------------------------
// crt.sh is the flakiest upstream in the catalog — it periodically 5xx's on every
// query and times out on high-volume domains (prod: mongodb.com hit the 30s
// timeout). certspotter is keyless, fast, and reliable, so when crt.sh times out
// or exhausts its retries we query it before giving up. Its issuances are mapped
// to the crt.sh entry shape so all scoring below is unchanged. Caveat: certspotter
// returns one page (~100 recent issuances), so total_certs_found can be lower than
// crt.sh's on very large domains — an acceptable tradeoff for a fallback.
const CERTSPOTTER_TIMEOUT_MS = 12_000;

interface CertspotterIssuance {
  id: string;
  dns_names?: string[];
  issuer?: { name?: string; friendly_name?: string };
  not_before?: string;
  not_after?: string;
}

async function fetchFromCertspotter(domain: string, includeSubdomains: boolean): Promise<CrtShEntry[]> {
  const params = new URLSearchParams({ domain });
  if (includeSubdomains) params.set("include_subdomains", "true");
  // certspotter omits these fields unless explicitly expanded.
  const url = `https://api.certspotter.com/v1/issuances?${params.toString()}&expand=dns_names&expand=issuer&expand=not_before&expand=not_after`;

  const response = await fetch(url, { signal: AbortSignal.timeout(CERTSPOTTER_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`certspotter returned ${response.status}`);
  const issuances = (await response.json()) as CertspotterIssuance[];
  if (!Array.isArray(issuances)) throw new Error("certspotter returned a non-array body");

  return issuances.map((iss) => {
    const names = Array.isArray(iss.dns_names) ? iss.dns_names : [];
    return {
      id: Number(iss.id) || 0,
      issuer_ca_id: 0,
      // issuer.name is the full DN (extractIssuerName pulls O=…); fall back to the
      // friendly name when the DN is absent.
      issuer_name: iss.issuer?.name || iss.issuer?.friendly_name || "Unknown",
      common_name: names[0] ?? "",
      // crt.sh delivers SANs as a newline-joined string; match that so the SAN /
      // subdomain / wildcard parsing below is identical for both providers.
      name_value: names.join("\n"),
      not_before: iss.not_before ?? "",
      not_after: iss.not_after ?? "",
      // certspotter carries no CT-log entry timestamp; not_before is a close proxy
      // for the "recently issued" heuristic.
      entry_timestamp: iss.not_before ?? "",
    };
  });
}

// --- Extracted cert-transparency logic (shared with the domain-vendor-risk aggregator) ---

export interface CertTransparencyResult {
  domain: string;
  total_certs_found: number;
  unique_subdomains: string[];
  unique_subdomain_count: number;
  issuers: string[];
  wildcard_certs: string[];
  expiring_within_30_days: string[];
  recently_issued: string[];
  certs: CertResult[];
  score: number;
  grade: string;
  findings: Finding[];
}

/**
 * Thrown when crt.sh is unreachable, times out, returns non-200 on every
 * attempt, or returns an unparseable body. Carries the exact status + client
 * message the route handler emitted before extraction (504 for timeouts, 502
 * otherwise) so the /cert-transparency/lookup responses are byte-for-byte
 * unchanged. Aggregators (e.g. domain-vendor-risk) just treat any throw as a
 * failed section.
 */
export class CertTransparencyUnavailableError extends Error {
  constructor(
    public readonly status: number,
    public readonly clientMessage: string,
  ) {
    super(clientMessage);
    this.name = "CertTransparencyUnavailableError";
  }
}

/**
 * Core certificate-transparency logic (crt.sh fetch with cache/retry + scoring),
 * extracted so aggregators can reuse it directly. Expects an already-validated
 * domain. Throws CertTransparencyUnavailableError when the upstream cannot be
 * read. The route handler below calls this and serializes the result unchanged.
 */
export async function runCertTransparency(
  domain: string,
  opts: { includeSubdomains?: boolean; limit?: number } = {},
): Promise<CertTransparencyResult> {
    const includeSubdomains = opts.includeSubdomains !== false;
    let limit = opts.limit ?? 100;
    if (!Number.isFinite(limit) || limit < 1) limit = 100;
    if (limit > 500) limit = 500;

    // Build crt.sh query
    const query = includeSubdomains ? `%25.${domain}` : domain;
    const crtUrl = `https://crt.sh/?q=${query}&output=json`;

    let crtData: CrtShEntry[];

    // crt.sh is notoriously slow/flaky — retry FAST failures (5xx/parse) up to
    // twice, with a short pause so a transient blip clears. Timeouts are NOT
    // retried: one attempt already burned the full time budget, and stacking
    // attempts would hold a paid request open for minutes.
    const maxAttempts = 3;
    const retryPauseMs = 250;
    let lastError: unknown;
    let fetched = false;
    crtData = [];

    const cached = crtCache.get(crtUrl);
    const cacheFresh = cached !== undefined && Date.now() - cached.at < CRT_CACHE_TTL_MS;
    if (cacheFresh) {
      crtData = cached.data;
      fetched = true;
    }

    for (let attempt = 0; !fetched && attempt < maxAttempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retryPauseMs));
      try {
        const response = await fetch(crtUrl, {
          signal: AbortSignal.timeout(timeouts.certTransparency),
        });

        if (!response.ok) {
          lastError = new Error(`crt.sh returned ${response.status}`);
          continue;
        }

        try {
          crtData = await response.json() as CrtShEntry[];
          fetched = true;
          break;
        } catch {
          lastError = new Error("Failed to parse response");
          continue;
        }
      } catch (err) {
        lastError = err;
        if (err instanceof Error && err.name === "TimeoutError") break;
        continue;
      }
    }

    // crt.sh exhausted (timeout or 5xx/parse across every attempt) — fall back to
    // certspotter before giving up so a crt.sh outage doesn't take the endpoint
    // (or the aggregators that reuse this) down. Keep crt.sh's lastError so the
    // status/message below is chosen from the PRIMARY failure if the fallback
    // also fails (byte-for-byte-unchanged 504/502 responses).
    if (!fetched) {
      try {
        crtData = await fetchFromCertspotter(domain, includeSubdomains);
        fetched = true;
      } catch {
        /* both providers failed — status decided from lastError below */
      }
    }

    if (fetched && Array.isArray(crtData) && !cacheFresh) {
      if (crtCache.size >= CRT_CACHE_MAX) {
        const oldest = crtCache.keys().next().value;
        if (oldest !== undefined) crtCache.delete(oldest);
      }
      crtCache.set(crtUrl, { at: Date.now(), data: crtData });
    }

    if (!fetched) {
      if (lastError instanceof Error && lastError.name === "TimeoutError") {
        throw new CertTransparencyUnavailableError(504, "Certificate transparency lookup failed: request timed out");
      }
      throw new CertTransparencyUnavailableError(502, `Certificate transparency lookup failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }

    if (!Array.isArray(crtData)) {
      throw new CertTransparencyUnavailableError(502, "Failed to parse certificate transparency response");
    }

    const now = new Date();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    // Process certs
    const allSubdomains = new Set<string>();
    const wildcardCerts = new Set<string>();
    const issuersSet = new Set<string>();
    const expiringWithin30: Set<string> = new Set();
    const recentlyIssued: Set<string> = new Set();
    const findings: Finding[] = [];

    let hasExpiredCert = false;
    let expiredCertCount = 0;
    let expiringCertCount = 0;
    let hasRecentlyIssued = false;

    const certs: CertResult[] = [];

    for (const entry of crtData) {
      const sans = entry.name_value
        ? entry.name_value.split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean)
        : [];

      const isWildcard = sans.some((s) => s.startsWith("*.")) || Boolean(entry.common_name && entry.common_name.startsWith("*."));

      // Track wildcards
      if (isWildcard) {
        const wildcardNames = sans.filter((s) => s.startsWith("*."));
        if (entry.common_name && entry.common_name.startsWith("*.")) {
          wildcardCerts.add(entry.common_name.toLowerCase());
        }
        for (const w of wildcardNames) {
          wildcardCerts.add(w);
        }
      }

      // Build subdomains (strip leading *.)
      for (const san of sans) {
        const cleaned = san.startsWith("*.") ? san.slice(2) : san;
        if (cleaned && cleaned !== domain) {
          allSubdomains.add(cleaned);
        }
      }

      // Track issuer
      const issuerName = extractIssuerName(entry.issuer_name);
      issuersSet.add(issuerName);

      // Calculate expiry
      const notAfter = new Date(entry.not_after);
      const notBefore = new Date(entry.not_before);
      const diffMs = notAfter.getTime() - now.getTime();
      const daysUntilExpiry = Math.floor(diffMs / (24 * 60 * 60 * 1000));
      const isExpired = diffMs < 0;

      if (isExpired) {
        hasExpiredCert = true;
        expiredCertCount++;
      }

      if (!isExpired && diffMs <= thirtyDaysMs) {
        expiringCertCount++;
        for (const san of sans) {
          const cleaned = san.startsWith("*.") ? san.slice(2) : san;
          expiringWithin30.add(cleaned);
        }
      }

      // Check recently issued
      const entryTimestamp = new Date(entry.entry_timestamp);
      const ageSinceEntry = now.getTime() - entryTimestamp.getTime();
      if (ageSinceEntry >= 0 && ageSinceEntry <= sevenDaysMs) {
        hasRecentlyIssued = true;
        for (const san of sans) {
          const cleaned = san.startsWith("*.") ? san.slice(2) : san;
          recentlyIssued.add(cleaned);
        }
      }

      certs.push({
        id: entry.id,
        common_name: entry.common_name,
        issuer: issuerName,
        not_before: notBefore.toISOString(),
        not_after: notAfter.toISOString(),
        sans,
        is_wildcard: isWildcard,
        is_expired: isExpired,
        days_until_expiry: daysUntilExpiry,
      });
    }

    // Grading
    let score = 100;

    if (crtData.length === 0) {
      findings.push({ rule: "no_certs_found", deduction: -30, detail: "No certificates found in transparency logs" });
      score -= 30;
    }

    if (wildcardCerts.size > 0) {
      findings.push({
        rule: "wildcard_cert_present",
        deduction: -15,
        detail: `Wildcard cert found: ${[...wildcardCerts].join(", ")}`,
      });
      score -= 15;
    }

    for (let i = 0; i < expiringCertCount; i++) {
      findings.push({
        rule: "cert_expiring_soon",
        deduction: -20,
        detail: `Certificate expiring within 30 days`,
      });
      score -= 20;
    }

    for (let i = 0; i < expiredCertCount; i++) {
      findings.push({
        rule: "cert_already_expired",
        deduction: -10,
        detail: `Expired certificate found`,
      });
      score -= 10;
    }

    if (hasRecentlyIssued) {
      findings.push({
        rule: "recently_issued_suspicious",
        deduction: -10,
        detail: "Certificate issued within last 7 days",
      });
      score -= 10;
    }

    if (issuersSet.size > 3) {
      findings.push({
        rule: "excessive_issuers",
        deduction: -10,
        detail: `${issuersSet.size} different CAs issued certificates (fragmented cert management)`,
      });
      score -= 10;
    }

    score = Math.max(0, Math.min(100, score));
    const grade = calculateGrade(score);

    const uniqueSubdomains = [...allSubdomains].sort();
    const truncatedCerts = certs.slice(0, limit);

    return {
      domain,
      total_certs_found: crtData.length,
      unique_subdomains: uniqueSubdomains,
      unique_subdomain_count: uniqueSubdomains.length,
      issuers: [...issuersSet],
      wildcard_certs: [...wildcardCerts],
      expiring_within_30_days: [...expiringWithin30],
      recently_issued: [...recentlyIssued],
      certs: truncatedCerts,
      score,
      grade,
      findings,
    };
}

// --- Route handler ---

certTransparencyRouter.get("/cert-transparency/lookup", async (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string | undefined;

    if (!rawDomain) {
      res.status(400).json({ error: "domain is required" });
      return;
    }

    const domain = validateDomain(rawDomain);

    const includeSubdomains = req.query.include_subdomains !== "false";
    let limit = parseInt(req.query.limit as string, 10);
    if (isNaN(limit)) limit = 100;

    res.json(await runCertTransparency(domain, { includeSubdomains, limit }));
  } catch (err) {
    if (err instanceof CertTransparencyUnavailableError) {
      res.status(err.status).json({ error: err.clientMessage });
      return;
    }
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Cert transparency error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
