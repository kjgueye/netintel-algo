import { Router, type Request, type Response } from "express";
import net from "node:net";
import { ValidationError } from "../utils/validators.js";
import { pickRequestParam, IP_ALIASES } from "../utils/field-aliases.js";

export const ipReputationRouter = Router();

// --- Constants ---

const TIMEOUT_MS = 15000;
// OTX is best-effort enrichment and can be slow for heavily-reported IPs (Tor
// exits, botnet hosts), so it gets more headroom; if it still doesn't respond in
// time the endpoint degrades to AbuseIPDB-only rather than failing.
const OTX_TIMEOUT_MS = 20000;

const CATEGORY_MAP: Record<number, string> = {
  3: "fraud_orders",
  4: "ddos_attack",
  5: "ftp_brute_force",
  6: "ping_of_death",
  7: "phishing",
  8: "fraud_voip",
  9: "open_proxy",
  10: "web_spam",
  11: "email_spam",
  12: "blog_spam",
  13: "vpn_ip",
  14: "port_scan",
  15: "hacking",
  16: "sql_injection",
  17: "spoofing",
  18: "brute_force",
  19: "bad_web_bot",
  20: "exploited_host",
  21: "web_attack",
  22: "ssh_brute_force",
  23: "iot_targeted",
};

// --- Helpers ---

function isPrivateIp(ip: string): boolean {
  // IPv4
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

function getRiskLevel(score: number): string {
  if (score === 0) return "none";
  if (score <= 24) return "low";
  if (score <= 49) return "medium";
  if (score <= 74) return "high";
  return "critical";
}

/**
 * Thrown when AbuseIPDB/OTX are unreachable, return non-200, missing keys, or
 * return no data. The route maps this to a 503; aggregators treat it as a
 * failed section.
 */
export class UpstreamUnavailableError extends Error {
  constructor() {
    super("upstream service unavailable");
    this.name = "UpstreamUnavailableError";
  }
}

async function fetchWithTimeout(url: string, headers: Record<string, string>, timeoutMs: number = TIMEOUT_MS): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export interface IpReputationResult {
  ip: string;
  risk_score: number;
  risk_level: string;
  composite: {
    is_malicious: boolean;
    threat_categories: string[];
    first_seen: string | null;
    last_seen: string | null;
  };
  abuseipdb: {
    confidence_score: number;
    total_reports: number;
    distinct_reporters: number;
    last_reported_at: string | null;
    isp: string | null;
    usage_type: string | null;
    domain: string | null;
    categories: number[];
  };
  otx: {
    available: boolean;
    pulse_count: number;
    malware_families: string[];
    threat_types: string[];
    asn: string | null;
    country_code: string | null;
    reputation: number | null;
  };
}

/**
 * Core threat-reputation analysis (AbuseIPDB + AlienVault OTX), extracted so
 * aggregators (e.g. ip-report-full) can reuse it directly. Expects an
 * already-validated, non-private IP. Throws UpstreamUnavailableError when the
 * upstreams are unreachable, return non-200, lack data, or API keys are unset.
 * The route handler below calls this, mapping that error to a 503.
 */
export async function runIpReputation(ip: string): Promise<IpReputationResult> {
  const abuseipdbKey = process.env.ABUSEIPDB_API_KEY;
  const otxKey = process.env.OTX_API_KEY;

  if (!abuseipdbKey || !otxKey) {
    throw new UpstreamUnavailableError();
  }

  // AbuseIPDB is REQUIRED; OTX is best-effort enrichment. Both run in parallel,
  // but an OTX error/timeout/non-200 degrades to AbuseIPDB-only instead of
  // failing the whole call (OTX latency spikes badly on heavily-reported IPs —
  // exactly the ones callers most want to check).
  const abusePromise = fetchWithTimeout(
    `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90&verbose=true`,
    { Key: abuseipdbKey, Accept: "application/json" },
  ).then((r) => r.json());

  const otxPromise = fetchWithTimeout(
    `https://otx.alienvault.com/api/v1/indicators/IPv4/${encodeURIComponent(ip)}/general`,
    { "X-OTX-API-KEY": otxKey, Accept: "application/json" },
    OTX_TIMEOUT_MS,
  )
    .then((r) => r.json())
    .catch((err) => {
      console.warn(
        "ip-reputation: OTX unavailable, returning AbuseIPDB-only:",
        err instanceof Error ? err.message : err,
      );
      return null;
    });

  let abuseData: any;
  try {
    abuseData = await abusePromise;
  } catch (fetchErr) {
    console.error("ip-reputation AbuseIPDB error:", fetchErr);
    throw new UpstreamUnavailableError();
  }
  const abuse = abuseData?.data;
  if (!abuse) {
    throw new UpstreamUnavailableError();
  }

  const otxData: any = await otxPromise; // null when OTX is degraded/unavailable
  const otxAvailable = otxData != null;

    // --- AbuseIPDB ---
    const confidenceScore: number = abuse.abuseConfidenceScore ?? 0;
    const totalReports: number = abuse.totalReports ?? 0;
    const distinctReporters: number = abuse.numDistinctUsers ?? 0;
    const lastReportedAt: string | null = abuse.lastReportedAt ?? null;
    const isp: string | null = abuse.isp ?? null;
    const usageType: string | null = abuse.usageType ?? null;
    const abuseDomain: string | null = abuse.domain ?? null;

    // Collect raw category IDs from reports
    const rawCategories: number[] = [];
    if (Array.isArray(abuse.reports)) {
      for (const report of abuse.reports) {
        if (Array.isArray(report.categories)) {
          rawCategories.push(...report.categories);
        }
      }
    }
    const dedupedCategoryIds = [...new Set(rawCategories)];

    // Map to strings
    const threatCategories = [...new Set(
      dedupedCategoryIds
        .map((id) => CATEGORY_MAP[id])
        .filter(Boolean),
    )];

    // --- OTX (best-effort; zeros/empties when unavailable) ---
    const pulseCount: number = otxData?.pulse_info?.count ?? 0;
    const pulses = otxData?.pulse_info?.pulses ?? [];

    const malwareFamilies = [...new Set<string>(
      pulses
        .flatMap((p: any) => p.malware_families ?? [])
        .map((m: any) => (typeof m === "string" ? m : m.display_name ?? m.name ?? ""))
        .filter(Boolean),
    )];

    const threatTypes = [...new Set<string>(
      pulses
        .flatMap((p: any) => p.attack_ids ?? [])
        .map((a: any) => (typeof a === "string" ? a : a.display_name ?? a.name ?? ""))
        .filter(Boolean),
    )];

    const otxAsn: string | null = otxData?.asn ?? null;
    const otxCountryCode: string | null = otxData?.country_code ?? null;
    const otxReputation: number | null = otxData?.reputation ?? null;

    // --- Composite risk score ---
    // Blend both sources when OTX is available; fall back to AbuseIPDB's
    // confidence alone when it's degraded, so a slow OTX never artificially
    // lowers a risky IP's score.
    const riskScore = otxAvailable
      ? Math.round(confidenceScore * 0.6 + (Math.min(pulseCount, 50) / 50) * 100 * 0.4)
      : confidenceScore;
    const riskLevel = getRiskLevel(riskScore);

    // first_seen: earliest of AbuseIPDB lastReportedAt and OTX pulse created dates
    let firstSeen: string | null = lastReportedAt;
    if (Array.isArray(pulses) && pulses.length > 0) {
      const otxDates = pulses
        .map((p: any) => p.created)
        .filter(Boolean)
        .sort();
      if (otxDates.length > 0) {
        const otxEarliest = otxDates[0];
        if (!firstSeen || new Date(otxEarliest) < new Date(firstSeen)) {
          firstSeen = otxEarliest;
        }
      }
    }

  return {
    ip,
    risk_score: riskScore,
    risk_level: riskLevel,
    composite: {
      is_malicious: riskScore >= 25,
      threat_categories: threatCategories,
      first_seen: firstSeen,
      last_seen: lastReportedAt,
    },
    abuseipdb: {
      confidence_score: confidenceScore,
      total_reports: totalReports,
      distinct_reporters: distinctReporters,
      last_reported_at: lastReportedAt,
      isp,
      usage_type: usageType,
      domain: abuseDomain,
      categories: dedupedCategoryIds,
    },
    otx: {
      available: otxAvailable,
      pulse_count: pulseCount,
      malware_families: malwareFamilies,
      threat_types: threatTypes,
      asn: otxAsn,
      country_code: otxCountryCode,
      reputation: otxReputation,
    },
  };
}

// --- Route ---

ipReputationRouter.get("/ip-reputation/analyze", async (req: Request, res: Response) => {
  try {
    // Tolerate the common synonyms and body-sent params agents use (see
    // field-aliases.ts) — every rejected synonym is a paid call that bounces.
    const ip = pickRequestParam(req, IP_ALIASES);

    if (!ip) {
      res.status(400).json({
        error:
          'ip is required — pass an IP address as the `ip` query param, ' +
          'e.g. /ip-reputation/analyze?ip=8.8.8.8 (aliases accepted: target, address, host).',
      });
      return;
    }

    if (!net.isIP(ip)) {
      throw new ValidationError("invalid IP address format");
    }

    if (isPrivateIp(ip)) {
      res.status(400).json({ error: "private IP addresses are not supported" });
      return;
    }

    res.json(await runIpReputation(ip));
  } catch (err) {
    if (err instanceof UpstreamUnavailableError) {
      res.status(503).json({ error: "upstream service unavailable" });
      return;
    }
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("ip-reputation error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
