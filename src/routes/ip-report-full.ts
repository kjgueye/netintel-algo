import { Router, type Request, type Response } from "express";
import net from "node:net";
import { ValidationError } from "../utils/validators.js";
import { pickRequestParam, IP_ALIASES } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";
import { runIpGeo } from "./ip-geo.js";
import { runAsnLookup } from "./asn-lookup.js";
import { runIpBlacklist } from "./ip-blacklist.js";
import { runIpReputation } from "./ip-reputation.js";
import { runIpRisk } from "./ip-risk.js";

export const ipReportFullRouter = Router();

// --- Types ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

// --- Helpers ---

/** Sentinel so a per-sub-service timeout is distinguishable from any other failure. */
class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

/** Sentinel marking the IPv4-only blacklist section as skipped for an IPv6 input. */
class Ipv4OnlyError extends Error {
  constructor() {
    super("ipv4_only");
    this.name = "Ipv4OnlyError";
  }
}

/**
 * Race a promise against a per-sub-service deadline. Rejects with TimeoutError
 * if the deadline passes first. The timer is always cleared so it never keeps
 * the event loop alive.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), deadline]);
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

function recommendationFromScore(score: number): string {
  if (score >= 70) return "allow";
  if (score >= 40) return "review";
  return "block";
}

/** Map a rejection reason to the standard failed-section error string. */
function errorOf(reason: unknown): "timeout" | "ipv4_only" | "upstream_error" | "internal_error" {
  if (reason instanceof TimeoutError) return "timeout";
  if (reason instanceof Ipv4OnlyError) return "ipv4_only";
  if (reason instanceof Error) return "upstream_error";
  return "internal_error";
}

// RFC 1918 + loopback + link-local + reserved ranges (IPv4 + IPv6).
function isPrivateIp(ip: string): boolean {
  // IPv4
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true;
  if (ip.startsWith("0.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("100.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 64 && second <= 127) return true;
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

// --- Route handler ---

ipReportFullRouter.get("/ip-report/full", async (req: Request, res: Response) => {
  try {
    // Tolerate the common synonyms and body-sent params agents use (see
    // field-aliases.ts) — every rejected synonym is a paid call that bounces.
    const ip = pickRequestParam(req, IP_ALIASES);
    if (!ip) {
      res.status(400).json({
        error:
          'ip is required — pass an IP address as the `ip` query param, ' +
          'e.g. /ip-report/full?ip=8.8.8.8 (aliases accepted: target, address, host).',
      });
      return;
    }

    if (net.isIP(ip) === 0) {
      throw new ValidationError("Invalid IP address format");
    }

    if (isPrivateIp(ip)) {
      res.status(400).json({ error: "Private IP addresses cannot be reported on" });
      return;
    }

    const isIpv4 = net.isIP(ip) === 4;

    // All five sub-services run concurrently, each under its own per-sub-service
    // deadline. A slow or failing sub-service degrades to a failed section,
    // never a 500. The DNSBL blacklist check is IPv4-only, so it is skipped
    // (marked ipv4_only) for IPv6 inputs while the other four still run.
    const timeout = timeouts.ipReportFull;
    const [geoR, asnR, blacklistR, repR, riskR] = await Promise.allSettled([
      withTimeout(runIpGeo(ip), timeout),
      withTimeout(runAsnLookup(ip), timeout),
      isIpv4 ? withTimeout(runIpBlacklist(ip), timeout) : Promise.reject(new Ipv4OnlyError()),
      withTimeout(runIpReputation(ip), timeout),
      withTimeout(runIpRisk(ip), timeout),
    ]);

    const geoOk = geoR.status === "fulfilled";
    const asnOk = asnR.status === "fulfilled";
    const blacklistOk = blacklistR.status === "fulfilled";
    const repOk = repR.status === "fulfilled";
    const riskOk = riskR.status === "fulfilled";

    // --- Sections (standard partial-failure shape) ---
    const geoData = geoOk ? geoR.value : null;
    // Geo "succeeds" even when the provider has no record for the IP (every field
    // null). Treat an all-null result as no usable data so it doesn't read as a
    // healthy section — it should count as failed and surface a finding.
    const geoHasData =
      geoOk && !!(geoData!.country || geoData!.city || geoData!.timezone || geoData!.isp);
    const geo = geoHasData
      ? {
          available: true,
          country: geoData!.country,
          city: geoData!.city,
          timezone: geoData!.timezone,
          isp: geoData!.isp,
        }
      : {
          available: false,
          error: geoOk ? "no_data" : errorOf((geoR as PromiseRejectedResult).reason),
        };

    const asnData = asnOk ? asnR.value : null;
    const network = asnOk
      ? {
          available: true,
          asn: asnData!.asn,
          organization: asnData!.organization,
          classification: asnData!.classification,
        }
      : { available: false, error: errorOf((asnR as PromiseRejectedResult).reason) };

    const blData = blacklistOk ? blacklistR.value : null;
    const blacklist = blacklistOk
      ? {
          available: true,
          listed_count: blData!.listed_count,
          lists_checked: blData!.total_checked,
          listed_on: blData!.blacklists.filter((b) => b.listed).map((b) => b.name),
        }
      : { available: false, error: errorOf((blacklistR as PromiseRejectedResult).reason) };

    const repData = repOk ? repR.value : null;
    const reputation = repOk
      ? {
          available: true,
          abuse_confidence: repData!.abuseipdb.confidence_score,
          otx_pulses: repData!.otx.pulse_count,
        }
      : { available: false, error: errorOf((repR as PromiseRejectedResult).reason) };

    const riskData = riskOk ? riskR.value : null;
    const risk = riskOk
      ? {
          available: true,
          risk_score: riskData!.risk_score,
          recommendation: riskData!.recommendation,
        }
      : { available: false, error: errorOf((riskR as PromiseRejectedResult).reason) };

    const oks = [geoHasData, asnOk, blacklistOk, repOk, riskOk];
    const sectionsOk = oks.filter(Boolean).length;
    const sectionsFailed = oks.length - sectionsOk;

    // --- Scoring ---
    let score = 100;
    const findings: Finding[] = [];
    const deduct = (rule: string, amount: number, detail: string) => {
      findings.push({ rule, deduction: -amount, detail });
      score -= amount;
    };

    // Note every failed/skipped section (no content deduction — only a marker).
    // Geo gets "no_data" when it succeeded but returned nothing usable.
    const sectionErrors: Array<[string, string | null]> = [
      ["geo", geoHasData ? null : geoOk ? "no_data" : errorOf((geoR as PromiseRejectedResult).reason)],
      ["network", asnOk ? null : errorOf((asnR as PromiseRejectedResult).reason)],
      ["blacklist", blacklistOk ? null : errorOf((blacklistR as PromiseRejectedResult).reason)],
      ["reputation", repOk ? null : errorOf((repR as PromiseRejectedResult).reason)],
      ["risk", riskOk ? null : errorOf((riskR as PromiseRejectedResult).reason)],
    ];
    for (const [name, err] of sectionErrors) {
      if (err) {
        findings.push({ rule: "section_failed", deduction: 0, detail: `${name}: ${err}` });
      }
    }

    // Content-based deductions (only for sections that succeeded).
    if (blacklistOk && blData!.listed_count > 0) {
      deduct(
        "on_blacklists",
        15 * blData!.listed_count,
        `Listed on ${blData!.listed_count} of ${blData!.total_checked} DNSBLs`,
      );
    }

    if (repOk && repData!.abuseipdb.confidence_score > 50) {
      deduct(
        "high_abuse_confidence",
        30,
        `AbuseIPDB confidence score is ${repData!.abuseipdb.confidence_score}`,
      );
    }

    if (asnOk && (asnData!.classification === "cloud" || asnData!.classification === "hosting")) {
      deduct(
        "is_proxy_or_hosting",
        20,
        `Network classified as ${asnData!.classification} infrastructure`,
      );
    }

    if (riskOk && riskData!.recommendation === "block") {
      deduct("risk_section_block", 40, "Risk section recommends blocking this IP");
    }

    if (sectionsFailed >= 3) {
      deduct("many_sections_failed", 15, `${sectionsFailed} of ${oks.length} sections failed`);
    }

    score = Math.max(0, score);

    // overall_recommendation: prefer the risk section's verdict; otherwise derive
    // from the aggregate score.
    const overallRecommendation = riskOk
      ? riskData!.recommendation
      : recommendationFromScore(score);

    res.json({
      ip,
      generated_at: new Date().toISOString(),
      sections: {
        geo,
        network,
        blacklist,
        reputation,
        risk,
      },
      sections_ok: sectionsOk,
      sections_failed: sectionsFailed,
      overall_recommendation: overallRecommendation,
      score,
      grade: calculateGrade(score),
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("ip-report-full error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
