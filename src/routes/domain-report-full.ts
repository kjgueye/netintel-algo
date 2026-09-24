import { Router, type Request, type Response } from "express";
import { validateDomain, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";
import { runDnsLookup } from "./dns.js";
import { deliverableMxHosts } from "../utils/dns-resolvers.js";
import { runSslAnalyze } from "./ssl.js";
import { runWhoisRdap } from "./whois-rdap.js";
import { runCloudFingerprint } from "./cloud-fingerprint.js";
import { runTechFingerprint } from "./tech-fingerprint.js";
import { runSecurityHeaders } from "./security-headers.js";

export const domainReportFullRouter = Router();

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

/** Map a rejection reason to the standard failed-section error string. */
function errorOf(reason: unknown): "timeout" | "upstream_error" | "internal_error" {
  if (reason instanceof TimeoutError) return "timeout";
  if (reason instanceof Error) return "upstream_error";
  return "internal_error";
}

function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / (1000 * 60 * 60 * 24));
}

// --- Route handler ---

domainReportFullRouter.get("/domain-report/full", async (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string | undefined;
    if (!rawDomain) {
      res.status(400).json({ error: "domain is required" });
      return;
    }

    const domain = validateDomain(rawDomain);

    // All six sub-services run concurrently, each under its own per-sub-service
    // deadline. A slow or failing sub-service degrades to a failed section,
    // never a 500.
    const timeout = timeouts.domainReportFull;
    const [dnsR, sslR, whoisR, cloudR, techR, secR] = await Promise.allSettled([
      withTimeout(runDnsLookup(domain), timeout),
      withTimeout(runSslAnalyze(domain), timeout),
      withTimeout(runWhoisRdap(domain), timeout),
      withTimeout(runCloudFingerprint(domain), timeout),
      withTimeout(runTechFingerprint(domain), timeout),
      withTimeout(runSecurityHeaders(domain), timeout),
    ]);

    const dnsOk = dnsR.status === "fulfilled";
    const sslOk = sslR.status === "fulfilled";
    const whoisOk = whoisR.status === "fulfilled";
    const cloudOk = cloudR.status === "fulfilled";
    const techOk = techR.status === "fulfilled";
    const secOk = secR.status === "fulfilled";

    // --- Sections (standard partial-failure shape) ---
    const dnsData = dnsOk ? dnsR.value : null;
    // Real deliverable MX hosts only — a null MX (RFC 7505) is filtered out, so
    // we never emit mx_records:[""] or count it as mail infra.
    const deliverableMx = dnsData ? deliverableMxHosts(dnsData.records.MX) : [];
    const dns = dnsOk
      ? {
          available: true,
          a_records: dnsData!.records.A,
          mx_records: deliverableMx,
          ns_records: dnsData!.records.NS,
          txt_records: dnsData!.records.TXT,
        }
      : { available: false, error: errorOf((dnsR as PromiseRejectedResult).reason) };

    const sslData = sslOk ? sslR.value : null;
    const sslDaysUntilExpiry = sslOk ? daysUntil(sslData!.certificate.not_after) : null;
    const ssl = sslOk
      ? {
          available: true,
          issuer:
            sslData!.certificate.issuer.common_name ??
            sslData!.certificate.issuer.organization,
          valid_to: sslData!.certificate.not_after,
          days_until_expiry: sslDaysUntilExpiry,
        }
      : { available: false, error: errorOf((sslR as PromiseRejectedResult).reason) };

    const whoisData = whoisOk ? whoisR.value : null;
    const whois = whoisOk
      ? {
          available: true,
          registrar: whoisData!.registrar,
          created_at: whoisData!.created_at,
          expires_at: whoisData!.expires_at,
          days_until_expiry: whoisData!.days_until_expiry,
        }
      : { available: false, error: errorOf((whoisR as PromiseRejectedResult).reason) };

    const cloudData = cloudOk ? cloudR.value : null;
    const cloud = cloudOk
      ? {
          available: true,
          provider: cloudData!.hosting.provider ?? cloudData!.cdn.provider,
          cdn: cloudData!.cdn.provider,
          dns_provider: cloudData!.dns_provider.provider,
          grade: cloudData!.grade,
        }
      : { available: false, error: errorOf((cloudR as PromiseRejectedResult).reason) };

    const techData = techOk ? techR.value : null;
    const tech = techOk
      ? {
          available: true,
          server: techData!.server,
          cdn: techData!.cdn,
          cms: techData!.cms,
          waf: techData!.waf,
        }
      : { available: false, error: errorOf((techR as PromiseRejectedResult).reason) };

    const secData = secOk ? secR.value : null;
    const security_headers = secOk
      ? {
          available: true,
          grade: secData!.grade,
          hsts: secData!.hsts_present,
          csp: secData!.csp_present,
        }
      : { available: false, error: errorOf((secR as PromiseRejectedResult).reason) };

    const oks = [dnsOk, sslOk, whoisOk, cloudOk, techOk, secOk];
    const sectionsOk = oks.filter(Boolean).length;
    const sectionsFailed = oks.length - sectionsOk;

    // --- Scoring ---
    let score = 100;
    const findings: Finding[] = [];
    const deduct = (rule: string, amount: number, detail: string) => {
      findings.push({ rule, deduction: -amount, detail });
      score -= amount;
    };

    // Note every failed section (no content deduction — only a marker).
    const sectionStatus: Array<[string, boolean, PromiseSettledResult<unknown>]> = [
      ["dns", dnsOk, dnsR],
      ["ssl", sslOk, sslR],
      ["whois", whoisOk, whoisR],
      ["cloud", cloudOk, cloudR],
      ["tech", techOk, techR],
      ["security_headers", secOk, secR],
    ];
    for (const [name, ok, settled] of sectionStatus) {
      if (!ok) {
        const err = errorOf((settled as PromiseRejectedResult).reason);
        findings.push({ rule: "section_failed", deduction: 0, detail: `${name}: ${err}` });
      }
    }

    // Content-based deductions (only for sections that succeeded).
    if (whoisOk && whoisData!.days_until_expiry !== null && whoisData!.days_until_expiry < 30) {
      deduct("domain_expiring_soon", 20, `Domain expires in ${whoisData!.days_until_expiry} days`);
    }

    if (sslOk && sslDaysUntilExpiry !== null && sslDaysUntilExpiry < 14) {
      deduct("ssl_expiring_soon", 20, `SSL certificate expires in ${sslDaysUntilExpiry} days`);
    }

    if (!sslOk || !sslData!.certificate.not_after) {
      deduct("ssl_unavailable", 15, "SSL section failed or no certificate present");
    }

    if (dnsOk && deliverableMx.length === 0) {
      deduct("no_mx_records", 10, "DNS resolved but no deliverable MX records found");
    }

    if (secOk && !secData!.hsts_present && !secData!.csp_present) {
      deduct("missing_critical_headers", 10, "Both HSTS and CSP security headers are missing");
    }

    if (sectionsFailed >= 3) {
      deduct("many_sections_failed", 15, `${sectionsFailed} of ${oks.length} sections failed`);
    }

    score = Math.max(0, score);

    res.json({
      domain,
      generated_at: new Date().toISOString(),
      sections: {
        dns,
        ssl,
        whois,
        cloud,
        tech,
        security_headers,
      },
      sections_ok: sectionsOk,
      sections_failed: sectionsFailed,
      score,
      grade: calculateGrade(score),
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("domain-report-full error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
