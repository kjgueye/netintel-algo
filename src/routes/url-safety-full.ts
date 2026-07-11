import { Router, type Request, type Response } from "express";
import { validateUrl, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";
import { runRedirectTrace } from "./redirect.js";
import { runUrlSafety } from "./url-safety.js";
import { runSecurityHeaders } from "./security-headers.js";
import { runSslAnalyze } from "./ssl.js";

export const urlSafetyFullRouter = Router();

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

/** Approximate registrable domain (eTLD+1) using the last two labels. */
function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split(".");
  if (parts.length <= 2) return host.toLowerCase();
  return parts.slice(-2).join(".");
}

// --- Route handler ---

urlSafetyFullRouter.get("/url-safety/full", async (req: Request, res: Response) => {
  try {
    const rawUrl = req.query.url as string | undefined;
    if (!rawUrl) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    const parsed = validateUrl(rawUrl);

    // All four sub-services run concurrently on the INPUT url, each under its own
    // per-sub-service deadline. Running them in parallel (rather than waiting on
    // the redirect chain to find the final destination) keeps latency low; the
    // final_url is surfaced separately so an agent can re-check the destination.
    const timeout = timeouts.urlSafetyFull;
    const [redirR, malR, secR, sslR] = await Promise.allSettled([
      withTimeout(runRedirectTrace(parsed.href), timeout),
      withTimeout(runUrlSafety(parsed.href), timeout),
      withTimeout(runSecurityHeaders(parsed.href), timeout),
      withTimeout(runSslAnalyze(parsed.hostname), timeout),
    ]);

    const redirOk = redirR.status === "fulfilled";
    const malOk = malR.status === "fulfilled";
    const secOk = secR.status === "fulfilled";
    const sslOk = sslR.status === "fulfilled";

    // --- Redirects section ---
    const redirData = redirOk ? redirR.value : null;
    let finalUrl = parsed.href;
    let finalUrlDiffers = false;
    let openRedirect = false;
    if (redirOk) {
      finalUrl = redirData!.final_url;
      finalUrlDiffers = finalUrl !== parsed.href;
      let finalHost = parsed.hostname;
      try {
        finalHost = new URL(finalUrl).hostname;
      } catch {
        finalHost = parsed.hostname;
      }
      // Treat a cross-registrable-domain redirect as an open-redirect signal;
      // a mere subdomain/path change (e.g. example.com -> www.example.com) is not.
      openRedirect =
        redirData!.total_hops > 0 &&
        registrableDomain(finalHost) !== registrableDomain(parsed.hostname);
    }
    const redirects = redirOk
      ? {
          available: true,
          hops: redirData!.total_hops,
          final_url: finalUrl,
          open_redirect: openRedirect,
        }
      : { available: false, error: errorOf((redirR as PromiseRejectedResult).reason) };

    // --- Malware section ---
    const malData = malOk ? malR.value : null;
    const malware = malOk
      ? {
          available: true,
          in_urlhaus: malData!.in_urlhaus,
          threat_classification: malData!.threat_classification,
          heuristic_flags: malData!.heuristic_flags,
        }
      : { available: false, error: errorOf((malR as PromiseRejectedResult).reason) };

    // --- Security headers section ---
    const secData = secOk ? secR.value : null;
    const headersPresent: string[] = [];
    const headersMissing: string[] = [];
    if (secOk) {
      if (secData!.hsts_present) headersPresent.push("Strict-Transport-Security");
      else headersMissing.push("Strict-Transport-Security");
      if (secData!.csp_present) headersPresent.push("Content-Security-Policy");
      else headersMissing.push("Content-Security-Policy");
    }
    const security_headers = secOk
      ? {
          available: true,
          present: headersPresent,
          missing: headersMissing,
        }
      : { available: false, error: errorOf((secR as PromiseRejectedResult).reason) };

    // --- SSL section ---
    const sslData = sslOk ? sslR.value : null;
    // grade "F" is the SSL service's signal for an expired or self-signed cert.
    const sslValid = sslOk ? sslData!.grade !== "F" : false;
    const sslDaysUntilExpiry = sslOk ? daysUntil(sslData!.certificate.not_after) : null;
    const ssl = sslOk
      ? {
          available: true,
          valid: sslValid,
          issuer:
            sslData!.certificate.issuer.common_name ??
            sslData!.certificate.issuer.organization,
          days_until_expiry: sslDaysUntilExpiry,
        }
      : { available: false, error: errorOf((sslR as PromiseRejectedResult).reason) };

    const oks = [redirOk, malOk, secOk, sslOk];
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
      ["redirects", redirOk, redirR],
      ["malware", malOk, malR],
      ["security_headers", secOk, secR],
      ["ssl", sslOk, sslR],
    ];
    for (const [name, ok, settled] of sectionStatus) {
      if (!ok) {
        const err = errorOf((settled as PromiseRejectedResult).reason);
        findings.push({ rule: "section_failed", deduction: 0, detail: `${name}: ${err}` });
      }
    }

    // Content-based deductions (only for sections that succeeded).
    if (malOk && malData!.in_urlhaus) {
      deduct("in_malware_db", 60, "URL is listed in the URLhaus malware database");
    }
    if (malOk && malData!.threat_classification === "malicious") {
      deduct("malicious_heuristics", 25, "URL classified as malicious");
    }
    if (redirOk && openRedirect) {
      deduct("open_redirect", 25, `URL redirects to a different registrable domain (${finalUrl})`);
    }
    if (sslOk && !sslValid) {
      deduct("ssl_invalid", 25, "SSL certificate is invalid (expired or self-signed)");
    }
    if (sslOk && sslDaysUntilExpiry !== null && sslDaysUntilExpiry < 14) {
      deduct("ssl_expiring", 15, `SSL certificate expires in ${sslDaysUntilExpiry} days`);
    }
    if (secOk && !secData!.hsts_present) {
      deduct("missing_hsts", 10, "Strict-Transport-Security header is missing");
    }

    // Informational only — the other three sub-services ran against the input
    // url; if the final destination differs, the agent may want to re-check it.
    if (redirOk && finalUrlDiffers) {
      findings.push({
        rule: "redirects_elsewhere",
        deduction: 0,
        detail: "URL redirects to a different final destination — consider re-checking final_url",
      });
    }

    score = Math.max(0, score);

    // --- Safety verdict ---
    const isDangerous =
      malOk && (malData!.in_urlhaus || malData!.threat_classification === "malicious");
    const isSuspicious =
      (malOk && malData!.heuristic_flags.length > 0) ||
      (redirOk && openRedirect) ||
      (sslOk && (!sslValid || (sslDaysUntilExpiry !== null && sslDaysUntilExpiry < 14)));
    let safety_verdict: "safe" | "suspicious" | "dangerous" = "safe";
    if (isDangerous) safety_verdict = "dangerous";
    else if (isSuspicious) safety_verdict = "suspicious";

    res.json({
      url: parsed.href,
      generated_at: new Date().toISOString(),
      sections: {
        redirects,
        malware,
        security_headers,
        ssl,
      },
      sections_ok: sectionsOk,
      sections_failed: sectionsFailed,
      final_url: finalUrl,
      safety_verdict,
      score,
      grade: calculateGrade(score),
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("url-safety-full error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
