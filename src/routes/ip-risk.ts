import { Router, type Request, type Response } from "express";
import net from "node:net";
import { isDnsblListing, queryDns } from "../utils/dns-resolvers.js";
import { checkSsrf, ValidationError } from "../utils/validators.js";
import { pickRequestParam, IP_ALIASES } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const ipRiskRouter = Router();

// --- Constants ---

const TIMEOUT_MS = timeouts.ipRisk;

// DNSBLs checked (IPv4 only). lists_checked === DNSBLS.length.
const DNSBLS = [
  "zen.spamhaus.org",
  "bl.spamcop.net",
  "b.barracudacentral.org",
  "dnsbl.sorbs.net",
  "xbl.spamhaus.org",
  "pbl.spamhaus.org",
  "dnsbl-1.uceprotect.net",
  "dnsbl.dronebl.org",
];

const CLOUD_KEYWORDS = [
  "google", "amazon", "aws", "microsoft", "azure", "cloudflare",
  "digitalocean", "linode", "vultr", "oracle", "ibm cloud", "alibaba",
];

const HOSTING_KEYWORDS = [
  "hosting", "datacenter", "data center", "colocation", "colo",
  "server", "hetzner", "ovh", "leaseweb",
];

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

interface GeoData {
  status: string;
  country?: string;
  countryCode?: string;
  city?: string;
  timezone?: string;
  isp?: string;
  org?: string;
  as?: string;
  mobile?: boolean;
  proxy?: boolean;
  hosting?: boolean;
  query?: string;
}

interface GeoResult {
  available: boolean;
  data?: GeoData;
}

interface BlacklistResult {
  available: boolean;
  listed_on: string[];
}

// --- Helpers ---

function isPrivateIp(ip: string): boolean {
  // IPv4
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("0.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

function reverseIp(ip: string): string {
  return ip.split(".").reverse().join(".");
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

function getRecommendation(score: number): string {
  if (score >= 70) return "allow";
  if (score >= 40) return "review";
  return "block";
}

function matchesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function classify(asField: string, org: string, hosting: boolean): string {
  const text = `${asField} ${org}`;
  if (matchesAny(text, CLOUD_KEYWORDS)) return "cloud";
  if (hosting || matchesAny(text, HOSTING_KEYWORDS)) return "hosting";
  return "residential";
}

// "AS15169 Google LLC" -> { asn: "AS15169", organization: "Google LLC" }
function parseAs(asField: string | undefined): { asn: string | null; organization: string | null } {
  if (!asField) return { asn: null, organization: null };
  const spaceIdx = asField.indexOf(" ");
  if (spaceIdx === -1) return { asn: asField, organization: null };
  return { asn: asField.slice(0, spaceIdx), organization: asField.slice(spaceIdx + 1) };
}

// --- Sub-checks (run concurrently) ---

async function runGeo(ip: string): Promise<GeoResult> {
  const url =
    `http://ip-api.com/json/${encodeURIComponent(ip)}` +
    `?fields=status,country,countryCode,city,timezone,isp,org,as,mobile,proxy,hosting,query`;

  await checkSsrf(new URL(url).hostname);

  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const data = (await response.json()) as GeoData;

  if (data.status !== "success") {
    return { available: false };
  }
  return { available: true, data };
}

async function runBlacklist(ip: string, isIpv4: boolean): Promise<BlacklistResult> {
  if (!isIpv4) {
    return { available: false, listed_on: [] };
  }

  const reversed = reverseIp(ip);
  const results = await Promise.allSettled(
    DNSBLS.map(async (host) => {
      const answers = await queryDns(`${reversed}.${host}`, "A");
      // isDnsblListing filters Spamhaus in-band refusal codes (127.255.255.x)
      // — from Railway egress those otherwise read as false "listed" verdicts.
      const listed = answers.some(isDnsblListing);
      return { host, listed };
    })
  );

  const listed_on: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.listed) {
      listed_on.push(result.value.host);
    }
  }

  return { available: true, listed_on };
}

export interface IpRiskResult {
  ip: string;
  /**
   * 100 = clean/trusted, 0 = maximum risk — the same higher-is-better polarity
   * as grade/score everywhere else on this API. Named trust_score because
   * "risk_score" reads as higher-is-riskier (and /ip-reputation uses it that
   * way); the 2026-07-30 sweep audit flagged the clash.
   */
  trust_score: number;
  /** Deprecated alias of trust_score (same value), kept for existing consumers. */
  risk_score: number;
  grade: string;
  recommendation: string;
  geo: {
    available: boolean;
    country: string | null;
    country_code: string | null;
    city: string | null;
    timezone: string | null;
    isp: string | null;
    is_proxy: boolean;
    is_hosting: boolean;
    is_mobile: boolean;
  };
  network: {
    available: boolean;
    asn: string | null;
    organization: string | null;
    classification: string;
  };
  blacklist: {
    available: boolean;
    listed_count: number;
    lists_checked: number;
    listed_on: string[];
  };
  findings: Finding[];
}

/**
 * Core IP risk-scoring logic (geo + network + DNSBL synthesis), extracted so
 * aggregators (e.g. ip-report-full) can reuse it directly. Expects an
 * already-validated, non-private IP. Never throws for a failed sub-check — each
 * degrades to an unavailable section. The route handler below calls this unchanged.
 */
export async function runIpRisk(ip: string): Promise<IpRiskResult> {
    const isIpv4 = net.isIP(ip) === 4;

    // Run all sub-checks concurrently
    const [geoSettled, blacklistSettled] = await Promise.allSettled([
      runGeo(ip),
      runBlacklist(ip, isIpv4),
    ]);

    const geoResult: GeoResult =
      geoSettled.status === "fulfilled" ? geoSettled.value : { available: false };
    const blacklistResult: BlacklistResult =
      blacklistSettled.status === "fulfilled"
        ? blacklistSettled.value
        : { available: isIpv4, listed_on: [] };

    // --- Build geo + network sections ---
    const gd = geoResult.data;
    const geoAvailable = geoResult.available && !!gd;

    const isProxy = geoAvailable ? !!gd!.proxy : false;
    const isHosting = geoAvailable ? !!gd!.hosting : false;
    const isMobile = geoAvailable ? !!gd!.mobile : false;

    const { asn, organization: orgFromAs } = parseAs(gd?.as);
    const organization = orgFromAs || gd?.org || null;
    const classification = geoAvailable
      ? classify(gd!.as || "", organization || "", isHosting)
      : "unknown";

    const geo = {
      available: geoAvailable,
      country: geoAvailable ? gd!.country ?? null : null,
      country_code: geoAvailable ? gd!.countryCode ?? null : null,
      city: geoAvailable ? gd!.city ?? null : null,
      timezone: geoAvailable ? gd!.timezone ?? null : null,
      isp: geoAvailable ? gd!.isp ?? null : null,
      is_proxy: isProxy,
      is_hosting: isHosting,
      is_mobile: isMobile,
    };

    const network = {
      available: geoAvailable,
      asn: geoAvailable ? asn : null,
      organization: geoAvailable ? organization : null,
      classification,
    };

    const blacklist = {
      available: blacklistResult.available,
      listed_count: blacklistResult.listed_on.length,
      lists_checked: blacklistResult.available ? DNSBLS.length : 0,
      listed_on: blacklistResult.listed_on,
    };

    // --- Scoring ---
    let score = 100;
    const findings: Finding[] = [];

    if (blacklist.listed_count > 0) {
      const deduction = -15 * blacklist.listed_count;
      score += deduction;
      findings.push({
        rule: "on_blacklists",
        deduction,
        detail: `Listed on ${blacklist.listed_count} of ${blacklist.lists_checked} DNSBLs`,
      });
    }

    if (isProxy) {
      score -= 40;
      findings.push({ rule: "is_proxy", deduction: -40, detail: "IP detected as proxy/VPN" });
    }

    if (classification === "cloud") {
      score -= 20;
      findings.push({
        rule: "is_cloud",
        deduction: -20,
        detail: `IP belongs to known cloud provider${organization ? ` (${organization})` : ""}`,
      });
    } else if (isHosting) {
      // hosting and not already counted as cloud
      score -= 20;
      findings.push({ rule: "is_hosting", deduction: -20, detail: "IP is hosting/datacenter infrastructure" });
    }

    if (!geoAvailable) {
      score -= 10;
      findings.push({ rule: "geo_unavailable", deduction: -10, detail: "Geolocation check failed" });
    }

    if (!isIpv4) {
      findings.push({
        rule: "blacklist_skipped_ipv6",
        deduction: 0,
        detail: "DNSBL check is IPv4-only; skipped for IPv6 address",
      });
    }

    score = Math.max(0, score);

    return {
      ip,
      trust_score: score,
      risk_score: score, // deprecated alias — see IpRiskResult
      grade: calculateGrade(score),
      recommendation: getRecommendation(score),
      geo,
      network,
      blacklist,
      findings,
    };
}

// --- Route ---

ipRiskRouter.get("/ip-risk/score", async (req: Request, res: Response) => {
  try {
    // Tolerate the common synonyms and body-sent params agents use (see
    // field-aliases.ts) — every rejected synonym is a paid call that bounces.
    const ip = pickRequestParam(req, IP_ALIASES);

    if (!ip) {
      res.status(400).json({
        error:
          'ip is required — pass an IP address as the `ip` query param, ' +
          'e.g. /ip-risk/score?ip=8.8.8.8 (aliases accepted: target, address, host).',
      });
      return;
    }

    const ipVersion = net.isIP(ip);
    if (ipVersion === 0) {
      throw new ValidationError("Invalid IP address format");
    }

    if (isPrivateIp(ip)) {
      res.status(400).json({ error: "Private IP addresses cannot be risk-scored" });
      return;
    }

    res.json(await runIpRisk(ip));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("ip-risk error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
