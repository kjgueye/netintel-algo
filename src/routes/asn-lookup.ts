import { Router, type Request, type Response } from "express";
import dns from "node:dns/promises";
import net from "node:net";
import { validateDomain, ValidationError } from "../utils/validators.js";
import { pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const asnLookupRouter = Router();

// Agents commonly send the lookup value under its type name (ip/domain/host)
// rather than the canonical `target`. Production showed an `ip`-keyed 400
// (wallet 0x5958…5036) — paid intent, just a differently-named key. Canonical
// first so an explicit `target` always wins.
const TARGET_ALIASES = ["target", "ip", "ip_address", "ipAddress", "address", "domain", "host", "hostname", "query", "q"];

// --- Cloud/Hosting/VPN keyword lists ---

const CLOUD_KEYWORDS = [
  "google", "amazon", "aws", "microsoft", "azure", "cloudflare",
  "digitalocean", "linode", "vultr", "oracle cloud", "ibm cloud", "alibaba",
];

const HOSTING_KEYWORDS = [
  "hosting", "datacenter", "data center", "colocation", "colo",
  "server", "hetzner", "ovh", "leaseweb",
];

const VPN_KEYWORDS = [
  "vpn", "nordvpn", "expressvpn", "mullvad", "proton", "hide.me", "surfshark",
];

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

/**
 * A failure reaching/parsing the upstream network-ownership provider (ipinfo).
 * Carries the HTTP status the route should return and a stable machine code so
 * agents can tell a *transient upstream* problem (retry) apart from a *bad input*
 * (fix the request) — the old code collapsed both into an opaque 500.
 */
export class UpstreamError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

// --- Helpers ---

function matchesAny(org: string, keywords: string[]): boolean {
  const lower = org.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function classifyOrg(org: string): {
  is_cloud: boolean;
  is_hosting: boolean;
  is_vpn: boolean;
  classification: string;
} {
  const isVpn = matchesAny(org, VPN_KEYWORDS);
  const isCloud = matchesAny(org, CLOUD_KEYWORDS);
  const isHostingDirect = matchesAny(org, HOSTING_KEYWORDS);
  const isHosting = isCloud || isHostingDirect;

  let classification: string;
  if (isVpn) classification = "vpn";
  else if (isCloud) classification = "cloud";
  else if (isHostingDirect) classification = "hosting";
  else classification = "residential";

  return { is_cloud: isCloud, is_hosting: isHosting, is_vpn: isVpn, classification };
}

function parseOrg(org: string | undefined): { asn: string | null; asn_number: number | null; organization: string | null } {
  if (!org) return { asn: null, asn_number: null, organization: null };
  const spaceIdx = org.indexOf(" ");
  if (spaceIdx === -1) return { asn: org, asn_number: parseInt(org.replace(/^AS/i, ""), 10) || null, organization: null };
  const asnPart = org.slice(0, spaceIdx);
  const orgPart = org.slice(spaceIdx + 1);
  const asnNum = parseInt(asnPart.replace(/^AS/i, ""), 10);
  return { asn: asnPart, asn_number: isNaN(asnNum) ? null : asnNum, organization: orgPart };
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

function isValidIp(value: string): boolean {
  return net.isIPv4(value) || net.isIPv6(value);
}

function getIpVersion(ip: string): number {
  return net.isIPv4(ip) ? 4 : 6;
}

// --- Core analysis (extracted for reuse by aggregators) ---

export interface AsnLookupCore {
  ip: string;
  ip_version: number;
  hostname: string | null;
  asn: string | null;
  asn_number: number | null;
  organization: string | null;
  network: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  is_hosting: boolean;
  is_cloud: boolean;
  is_vpn: boolean;
  classification: string;
}

/**
 * Core ASN/network-ownership lookup for a single IP, extracted so aggregators
 * (e.g. ip-report-full) can reuse it directly. Fetches ipinfo.io and classifies
 * the owning organization. Throws if the upstream fetch fails. The route handler
 * below calls this, then applies its own scoring and domain-target framing.
 */
export async function runAsnLookup(ip: string): Promise<AsnLookupCore> {
  const url = `https://ipinfo.io/${ip}/json`;

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeouts.asnLookup) });
  } catch (err) {
    // Network failure or our own timeout firing before ipinfo responded.
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new UpstreamError(
      isTimeout ? 504 : 502,
      isTimeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
      isTimeout
        ? "the network-ownership provider did not respond in time"
        : "could not reach the network-ownership provider",
    );
  }

  if (!response.ok) {
    // ipinfo serves the unauthenticated tier with a daily rate limit; a 429 here
    // is the dominant real-world failure and must NOT leak through as a billable
    // 200 with empty data (the pre-fix behavior).
    const isRateLimited = response.status === 429;
    throw new UpstreamError(
      503,
      isRateLimited ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
      isRateLimited
        ? "the network-ownership provider rate-limited this lookup"
        : `the network-ownership provider returned HTTP ${response.status}`,
    );
  }

  let ipinfoData: Record<string, unknown>;
  try {
    ipinfoData = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new UpstreamError(502, "UPSTREAM_ERROR", "the network-ownership provider returned a malformed response");
  }

  // Some rate-limit / error conditions arrive as HTTP 200 with an `error`
  // envelope instead of a non-2xx status — treat those as upstream failures too,
  // so they don't degrade into a silent "unknown" classification on a paid call.
  if (ipinfoData && typeof ipinfoData === "object" && ipinfoData.error != null) {
    throw new UpstreamError(503, "UPSTREAM_UNAVAILABLE", "the network-ownership provider declined the lookup");
  }

  const { asn, asn_number, organization } = parseOrg(ipinfoData.org as string | undefined);

  const { is_cloud, is_hosting, is_vpn, classification } = organization
    ? classifyOrg(organization)
    : { is_cloud: false, is_hosting: false, is_vpn: false, classification: "unknown" };

  return {
    ip,
    ip_version: getIpVersion(ip),
    hostname: (ipinfoData.hostname as string) || null,
    asn,
    asn_number,
    organization,
    network: (ipinfoData.network as string) || null,
    country: (ipinfoData.country as string) || null,
    region: (ipinfoData.region as string) || null,
    city: (ipinfoData.city as string) || null,
    is_hosting,
    is_cloud,
    is_vpn,
    classification,
  };
}

// --- Route handler ---

asnLookupRouter.get("/asn-lookup/analyze", async (req: Request, res: Response) => {
  try {
    const target = pickRequestParam(req, TARGET_ALIASES);

    if (!target) {
      res.status(400).json({
        error:
          'target is required — pass an IP address or domain as the `target` query param, ' +
          'e.g. /asn-lookup/analyze?target=172.217.14.206 (aliases accepted: ip, domain, host, address).',
      });
      return;
    }

    const trimmed = target.trim();
    let ip: string;
    let isDomain = false;

    if (isValidIp(trimmed)) {
      ip = trimmed;
    } else {
      // Try as domain
      let domain: string;
      try {
        domain = validateDomain(trimmed);
      } catch {
        throw new ValidationError("target must be a valid IP address or domain name");
      }

      isDomain = true;
      try {
        const addresses = await dns.resolve4(domain);
        if (addresses.length === 0) {
          res.status(400).json({ error: `Could not resolve domain: ${trimmed}` });
          return;
        }
        ip = addresses[0];
      } catch {
        res.status(400).json({ error: `Could not resolve domain: ${trimmed}` });
        return;
      }
    }

    // Core ipinfo lookup + classification (shared with aggregators)
    let core: AsnLookupCore;
    try {
      core = await runAsnLookup(ip);
    } catch (err) {
      // Upstream failures return a transient 5xx with a machine code + actionable
      // message — NOT a 500 ("our bug, give up"). x402 settles only on status <
      // 400, so these are never billed. Keep the "ASN lookup failed" prefix stable
      // for log grouping.
      const up = err instanceof UpstreamError
        ? err
        : new UpstreamError(502, "UPSTREAM_ERROR", "the network-ownership provider is temporarily unavailable");
      res.status(up.httpStatus).json({
        code: up.code,
        error:
          `ASN lookup failed — ${up.message}. This is a transient upstream error, ` +
          `not a problem with your request; retry shortly. You were not charged.`,
      });
      return;
    }

    const { asn, asn_number, organization, network, hostname, region, city, is_cloud, is_hosting, is_vpn, classification } = core;

    // Scoring
    let score = 100;
    const findings: Finding[] = [];

    if (is_vpn) {
      findings.push({ rule: "is_vpn", deduction: -40, detail: `IP belongs to VPN provider (${organization})` });
      score -= 40;
    }

    if (is_cloud) {
      findings.push({ rule: "cloud_infrastructure", deduction: -20, detail: `IP belongs to known cloud provider (${organization})` });
      score -= 20;
    }

    if (is_hosting && !is_cloud) {
      findings.push({ rule: "hosting_provider", deduction: -10, detail: `IP is classified as hosting infrastructure (${organization})` });
      score -= 10;
    }

    if (asn === null) {
      findings.push({ rule: "no_asn_data", deduction: -30, detail: "No ASN/organization data returned for this IP" });
      score -= 30;
    }

    const country = core.country;
    if (country && country !== "US") {
      findings.push({ rule: "non_us_country", deduction: -5, detail: `IP geolocated to ${country} (non-US)` });
      score -= 5;
    }

    if (isDomain) {
      findings.push({ rule: "domain_resolution_partial", deduction: -10, detail: "Target was domain, only first A record used" });
      score -= 10;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    res.json({
      target: trimmed,
      ip,
      ip_version: getIpVersion(ip),
      hostname,
      asn,
      asn_number,
      organization,
      network,
      country,
      region,
      city,
      is_hosting,
      is_cloud,
      is_vpn,
      classification,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("ASN lookup error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
