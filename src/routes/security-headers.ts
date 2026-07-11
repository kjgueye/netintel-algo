import { Router, type Request, type Response } from "express";
import { timeouts } from "../config.js";
import { checkSsrf, validateUrl, ValidationError } from "../utils/validators.js";
import { pickField } from "../utils/field-aliases.js";

export const securityHeadersRouter = Router();

// --- Interfaces ---

interface HeaderResult {
  present: boolean;
  raw_value: string | null;
  status: "pass" | "warn" | "fail" | "info";
  reason: string;
}

interface Deduction {
  reason: string;
  points: number; // positive internally, negated in output
}

interface AntiPattern {
  header: string;
  raw_value: string;
  severity: "warn" | "info";
  reason: string;
}

interface EvalResult {
  result: HeaderResult;
  deduction: Deduction | null;
}

// --- Header evaluators ---

function evaluateCsp(value: string | null): EvalResult {
  if (!value) {
    return {
      result: { present: false, raw_value: null, status: "fail", reason: "Content-Security-Policy not set — no XSS or injection protections" },
      deduction: { reason: "Content-Security-Policy not set", points: 25 },
    };
  }
  const lower = value.toLowerCase();
  const hasUnsafeInline = lower.includes("'unsafe-inline'");
  const hasUnsafeEval = lower.includes("'unsafe-eval'");
  if (hasUnsafeInline || hasUnsafeEval) {
    const issues: string[] = [];
    if (hasUnsafeInline) issues.push("unsafe-inline");
    if (hasUnsafeEval) issues.push("unsafe-eval");
    return {
      result: { present: true, raw_value: value, status: "warn", reason: `CSP present but includes ${issues.join(" and ")}, weakening XSS protection` },
      deduction: { reason: `Content-Security-Policy contains ${issues.join(" and ")}`, points: 10 },
    };
  }
  if (!lower.includes("default-src")) {
    return {
      result: { present: true, raw_value: value, status: "warn", reason: "CSP present but missing default-src directive" },
      deduction: { reason: "Content-Security-Policy missing default-src directive", points: 10 },
    };
  }
  return {
    result: { present: true, raw_value: value, status: "pass", reason: "Content-Security-Policy is set with a strong policy" },
    deduction: null,
  };
}

function evaluateHsts(value: string | null): EvalResult {
  if (!value) {
    return {
      result: { present: false, raw_value: null, status: "fail", reason: "Strict-Transport-Security not set — no HTTPS enforcement" },
      deduction: { reason: "Strict-Transport-Security not set", points: 20 },
    };
  }
  const match = value.match(/max-age=(\d+)/i);
  const maxAge = match ? parseInt(match[1], 10) : 0;
  if (maxAge < 15768000) {
    return {
      result: { present: true, raw_value: value, status: "warn", reason: `HSTS max-age is ${maxAge} — recommended minimum is 15768000 (6 months)` },
      deduction: { reason: `Strict-Transport-Security max-age too low (${maxAge})`, points: 10 },
    };
  }
  return {
    result: { present: true, raw_value: value, status: "pass", reason: `HSTS enabled with max-age=${maxAge}` },
    deduction: null,
  };
}

function evaluateXContentTypeOptions(value: string | null): EvalResult {
  if (!value) {
    return {
      result: { present: false, raw_value: null, status: "fail", reason: "X-Content-Type-Options not set — vulnerable to MIME-type sniffing" },
      deduction: { reason: "X-Content-Type-Options not set", points: 10 },
    };
  }
  if (value.toLowerCase().trim() === "nosniff") {
    return {
      result: { present: true, raw_value: value, status: "pass", reason: "X-Content-Type-Options is set to nosniff" },
      deduction: null,
    };
  }
  return {
    result: { present: true, raw_value: value, status: "warn", reason: `X-Content-Type-Options has unexpected value: ${value}` },
    deduction: { reason: `X-Content-Type-Options has unexpected value: ${value}`, points: 5 },
  };
}

function evaluateXFrameOptions(xfoValue: string | null, cspValue: string | null): EvalResult {
  const cspHasFrameAncestors = cspValue ? cspValue.toLowerCase().includes("frame-ancestors") : false;

  if (xfoValue) {
    const upper = xfoValue.toUpperCase().trim();
    if (upper === "DENY" || upper === "SAMEORIGIN") {
      return {
        result: { present: true, raw_value: xfoValue, status: "pass", reason: `X-Frame-Options is set to ${upper}` },
        deduction: null,
      };
    }
    if (upper.startsWith("ALLOW-FROM")) {
      return {
        result: { present: true, raw_value: xfoValue, status: "warn", reason: "X-Frame-Options uses deprecated ALLOW-FROM directive" },
        deduction: { reason: "X-Frame-Options uses deprecated ALLOW-FROM", points: 5 },
      };
    }
  }

  if (!xfoValue && cspHasFrameAncestors) {
    return {
      result: { present: false, raw_value: null, status: "pass", reason: "X-Frame-Options not set but CSP frame-ancestors provides equivalent protection" },
      deduction: null,
    };
  }

  return {
    result: { present: !!xfoValue, raw_value: xfoValue, status: "fail", reason: "No clickjacking protection — X-Frame-Options not set and CSP frame-ancestors not found" },
    deduction: { reason: "X-Frame-Options not set and no CSP frame-ancestors", points: 10 },
  };
}

function evaluateReferrerPolicy(value: string | null): EvalResult {
  const safe = ["no-referrer", "strict-origin-when-cross-origin", "same-origin", "strict-origin", "no-referrer-when-downgrade"];
  const partial = ["origin", "origin-when-cross-origin"];

  if (!value) {
    return {
      result: { present: false, raw_value: null, status: "fail", reason: "Referrer-Policy not set — browser uses default which may leak URLs" },
      deduction: { reason: "Referrer-Policy not set", points: 10 },
    };
  }

  const lower = value.toLowerCase().trim();
  if (lower === "unsafe-url") {
    return {
      result: { present: true, raw_value: value, status: "fail", reason: "Referrer-Policy set to unsafe-url — full URL is leaked in referrer" },
      deduction: { reason: "Referrer-Policy set to unsafe-url", points: 10 },
    };
  }
  if (partial.includes(lower)) {
    return {
      result: { present: true, raw_value: value, status: "warn", reason: `Referrer-Policy is ${value} — consider stricter policy` },
      deduction: { reason: `Referrer-Policy is ${value} — consider stricter policy`, points: 5 },
    };
  }
  if (safe.includes(lower)) {
    return {
      result: { present: true, raw_value: value, status: "pass", reason: `Referrer-Policy is set to ${value}` },
      deduction: null,
    };
  }
  return {
    result: { present: true, raw_value: value, status: "pass", reason: `Referrer-Policy is set to ${value}` },
    deduction: null,
  };
}

function evaluatePermissionsPolicy(value: string | null): EvalResult {
  if (!value) {
    return {
      result: { present: false, raw_value: null, status: "warn", reason: "Permissions-Policy not set — browser features not restricted" },
      deduction: { reason: "Permissions-Policy not set", points: 5 },
    };
  }
  if (value.trim() === "") {
    return {
      result: { present: true, raw_value: value, status: "warn", reason: "Permissions-Policy is set but empty" },
      deduction: { reason: "Permissions-Policy is empty", points: 2 },
    };
  }
  return {
    result: { present: true, raw_value: value, status: "pass", reason: "Permissions-Policy is set" },
    deduction: null,
  };
}

function evaluateXXssProtection(value: string | null): EvalResult {
  if (!value) {
    return {
      result: { present: false, raw_value: null, status: "info", reason: "X-XSS-Protection not set — modern browsers use CSP instead" },
      deduction: null,
    };
  }
  const trimmed = value.trim();
  if (trimmed === "0") {
    return {
      result: { present: true, raw_value: value, status: "pass", reason: "X-XSS-Protection explicitly disabled — correct for modern browsers with CSP" },
      deduction: null,
    };
  }
  if (trimmed.startsWith("1; mode=block")) {
    return {
      result: { present: true, raw_value: value, status: "info", reason: "X-XSS-Protection enabled with mode=block — legacy header, CSP preferred" },
      deduction: null,
    };
  }
  if (trimmed.startsWith("1")) {
    return {
      result: { present: true, raw_value: value, status: "warn", reason: "X-XSS-Protection enabled without mode=block — can introduce vulnerabilities" },
      deduction: { reason: "X-XSS-Protection enabled without mode=block", points: 2 },
    };
  }
  return {
    result: { present: true, raw_value: value, status: "info", reason: `X-XSS-Protection has value: ${value}` },
    deduction: null,
  };
}

function evaluateCorp(value: string | null): EvalResult {
  if (!value) {
    return {
      result: { present: false, raw_value: null, status: "info", reason: "Cross-Origin-Resource-Policy not set" },
      deduction: { reason: "Cross-Origin-Resource-Policy not set", points: 2 },
    };
  }
  const lower = value.toLowerCase().trim();
  if (lower === "same-origin" || lower === "same-site") {
    return {
      result: { present: true, raw_value: value, status: "pass", reason: `Cross-Origin-Resource-Policy set to ${value}` },
      deduction: null,
    };
  }
  if (lower === "cross-origin") {
    return {
      result: { present: true, raw_value: value, status: "info", reason: "Cross-Origin-Resource-Policy set to cross-origin — permissive" },
      deduction: null,
    };
  }
  return {
    result: { present: true, raw_value: value, status: "info", reason: `Cross-Origin-Resource-Policy has value: ${value}` },
    deduction: null,
  };
}

function evaluateCoep(value: string | null): EvalResult {
  if (!value) {
    return {
      result: { present: false, raw_value: null, status: "info", reason: "Cross-Origin-Embedder-Policy not set" },
      deduction: { reason: "Cross-Origin-Embedder-Policy not set", points: 2 },
    };
  }
  const lower = value.toLowerCase().trim();
  if (lower === "require-corp" || lower === "credentialless") {
    return {
      result: { present: true, raw_value: value, status: "pass", reason: `Cross-Origin-Embedder-Policy set to ${value}` },
      deduction: null,
    };
  }
  return {
    result: { present: true, raw_value: value, status: "info", reason: `Cross-Origin-Embedder-Policy has value: ${value}` },
    deduction: null,
  };
}

function evaluateCoop(value: string | null): EvalResult {
  if (!value) {
    return {
      result: { present: false, raw_value: null, status: "info", reason: "Cross-Origin-Opener-Policy not set" },
      deduction: { reason: "Cross-Origin-Opener-Policy not set", points: 2 },
    };
  }
  const lower = value.toLowerCase().trim();
  if (lower === "same-origin" || lower === "same-origin-allow-popups") {
    return {
      result: { present: true, raw_value: value, status: "pass", reason: `Cross-Origin-Opener-Policy set to ${value}` },
      deduction: null,
    };
  }
  if (lower === "unsafe-none") {
    return {
      result: { present: true, raw_value: value, status: "info", reason: "Cross-Origin-Opener-Policy set to unsafe-none — no isolation" },
      deduction: null,
    };
  }
  return {
    result: { present: true, raw_value: value, status: "info", reason: `Cross-Origin-Opener-Policy has value: ${value}` },
    deduction: null,
  };
}

// --- Anti-pattern detection ---

function detectAntiPatterns(headers: Headers): { patterns: AntiPattern[]; deductions: Deduction[] } {
  const patterns: AntiPattern[] = [];
  const deductions: Deduction[] = [];

  const xPoweredBy = headers.get("x-powered-by");
  if (xPoweredBy) {
    patterns.push({
      header: "x-powered-by",
      raw_value: xPoweredBy,
      severity: "warn",
      reason: "Information leakage — reveals server framework",
    });
    deductions.push({ reason: "X-Powered-By header exposes server framework", points: 3 });
  }

  const server = headers.get("server");
  if (server) {
    if (/\/[\d]/.test(server)) {
      patterns.push({
        header: "server",
        raw_value: server,
        severity: "warn",
        reason: "Server header includes version — information leakage",
      });
      deductions.push({ reason: "Server header includes version number", points: 3 });
    } else {
      patterns.push({
        header: "server",
        raw_value: server,
        severity: "info",
        reason: "Server header present without version",
      });
    }
  }

  const acao = headers.get("access-control-allow-origin");
  if (acao === "*") {
    patterns.push({
      header: "access-control-allow-origin",
      raw_value: acao,
      severity: "info",
      reason: "CORS allows all origins",
    });
  }

  return { patterns, deductions };
}

// --- Extracted analysis logic (shared with the domain-report-full aggregator) ---

export interface SecurityHeadersResult {
  status_code: number;
  grade: string;
  score: number;
  hsts_present: boolean;
  csp_present: boolean;
  headers_missing: string[];
}

/**
 * Core security-headers analysis, reusing the same evaluators as the route
 * handler. Accepts a domain or full URL (bare domains are probed over https).
 * Throws on connection failure so the aggregator can mark the section failed.
 * The route handler keeps its own richer response shape unchanged.
 */
export async function runSecurityHeaders(target: string): Promise<SecurityHeadersResult> {
  const trimmed = target.trim();
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsedUrl = validateUrl(normalized);
  await checkSsrf(parsedUrl.hostname);

  const fetchResponse = await fetch(parsedUrl.toString(), {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(timeouts.securityHeaders),
    headers: { "User-Agent": "NetIntel/1.0 security-headers-audit" },
  });

  const headers = fetchResponse.headers;
  const cspValue = headers.get("content-security-policy");
  const csp = evaluateCsp(cspValue);
  const hsts = evaluateHsts(headers.get("strict-transport-security"));
  const xcto = evaluateXContentTypeOptions(headers.get("x-content-type-options"));
  const xfo = evaluateXFrameOptions(headers.get("x-frame-options"), cspValue);
  const rp = evaluateReferrerPolicy(headers.get("referrer-policy"));
  const pp = evaluatePermissionsPolicy(headers.get("permissions-policy"));
  const xxp = evaluateXXssProtection(headers.get("x-xss-protection"));
  const corp = evaluateCorp(headers.get("cross-origin-resource-policy"));
  const coep = evaluateCoep(headers.get("cross-origin-embedder-policy"));
  const coop = evaluateCoop(headers.get("cross-origin-opener-policy"));

  const evaluations = [csp, hsts, xcto, xfo, rp, pp, xxp, corp, coep, coop];

  const deductions: Deduction[] = [];
  for (const evaluation of evaluations) {
    if (evaluation.deduction) deductions.push(evaluation.deduction);
  }
  const { deductions: antiDeductions } = detectAntiPatterns(headers);
  deductions.push(...antiDeductions);

  let score = 100;
  for (const d of deductions) score -= d.points;
  score = Math.max(0, score);

  let grade: string;
  if (score >= 90) grade = "A";
  else if (score >= 75) grade = "B";
  else if (score >= 55) grade = "C";
  else if (score >= 30) grade = "D";
  else grade = "F";

  const headersMissing: string[] = [];
  if (!hsts.result.present) headersMissing.push("strict-transport-security");
  if (!csp.result.present) headersMissing.push("content-security-policy");

  return {
    status_code: fetchResponse.status,
    grade,
    score,
    hsts_present: hsts.result.present,
    csp_present: csp.result.present,
    headers_missing: headersMissing,
  };
}

// --- Route handler ---

securityHeadersRouter.get("/security-headers/analyze", async (req: Request, res: Response) => {
  try {
    // Accept `url` as an alias for `target` (agents commonly send `url`).
    const target = (pickField(req.query, ["target", "url"]) as string) || "";
    if (!target) {
      res.status(400).json({
        error: 'target is required — pass the URL to analyze as "target" (or "url"), e.g. ?target=https://example.com',
      });
      return;
    }

    if (target.length > 2048) {
      throw new ValidationError("URL exceeds maximum length of 2048 characters");
    }

    // Normalize: trim, reject non-http schemes, strip fragments, prepend https:// for bare domains
    let normalized = target.trim();
    const fragmentIdx = normalized.indexOf("#");
    if (fragmentIdx !== -1) {
      normalized = normalized.slice(0, fragmentIdx);
    }

    if (/^https?:\/\//i.test(normalized)) {
      // Already has http:// or https:// — proceed
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
      // Has a scheme, but it's not http/https (e.g. ftp://, file://, javascript:, data:)
      throw new ValidationError("Only http and https schemes are supported");
    } else {
      // Bare domain — prepend https://
      normalized = `https://${normalized}`;
    }

    const parsedUrl = validateUrl(normalized);

    await checkSsrf(parsedUrl.hostname);

    const start = Date.now();

    let fetchResponse: globalThis.Response;
    try {
      fetchResponse = await fetch(parsedUrl.toString(), {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(timeouts.securityHeaders),
        headers: { "User-Agent": "NetIntel/1.0 security-headers-audit" },
      });
    } catch (fetchErr) {
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      res.status(503).json({ error: `Connection failed: ${message}` });
      return;
    }

    const durationMs = Date.now() - start;
    const headers = fetchResponse.headers;

    // Evaluate all headers
    const cspValue = headers.get("content-security-policy");
    const csp = evaluateCsp(cspValue);
    const hsts = evaluateHsts(headers.get("strict-transport-security"));
    const xcto = evaluateXContentTypeOptions(headers.get("x-content-type-options"));
    const xfo = evaluateXFrameOptions(headers.get("x-frame-options"), cspValue);
    const rp = evaluateReferrerPolicy(headers.get("referrer-policy"));
    const pp = evaluatePermissionsPolicy(headers.get("permissions-policy"));
    const xxp = evaluateXXssProtection(headers.get("x-xss-protection"));
    const corp = evaluateCorp(headers.get("cross-origin-resource-policy"));
    const coep = evaluateCoep(headers.get("cross-origin-embedder-policy"));
    const coop = evaluateCoop(headers.get("cross-origin-opener-policy"));

    const evaluations = [csp, hsts, xcto, xfo, rp, pp, xxp, corp, coep, coop];

    // Collect deductions from header evaluations
    const deductions: Deduction[] = [];
    for (const evaluation of evaluations) {
      if (evaluation.deduction) {
        deductions.push(evaluation.deduction);
      }
    }

    // Anti-patterns
    const { patterns: antiPatterns, deductions: antiDeductions } = detectAntiPatterns(headers);
    deductions.push(...antiDeductions);

    // Score + grade
    let score = 100;
    for (const d of deductions) {
      score -= d.points;
    }
    score = Math.max(0, score);

    let grade: string;
    if (score >= 90) grade = "A";
    else if (score >= 75) grade = "B";
    else if (score >= 55) grade = "C";
    else if (score >= 30) grade = "D";
    else grade = "F";

    // Summary counts
    const allResults = evaluations.map((e) => e.result);
    const summary = {
      pass: allResults.filter((r) => r.status === "pass").length,
      warn: allResults.filter((r) => r.status === "warn").length,
      fail: allResults.filter((r) => r.status === "fail").length,
      info: allResults.filter((r) => r.status === "info").length,
    };

    // Warnings
    const warnings: string[] = [];
    if (fetchResponse.status >= 400) {
      warnings.push(`Target returned HTTP ${fetchResponse.status} — headers evaluated on error response`);
    }
    const finalUrl = fetchResponse.url || parsedUrl.toString();
    try {
      const finalHostname = new URL(finalUrl).hostname;
      if (finalHostname !== parsedUrl.hostname) {
        warnings.push(`Target redirected to different domain: ${finalUrl}`);
      }
    } catch {
      // ignore URL parse failure on final_url
    }
    const contentType = headers.get("content-type");
    if (contentType && !contentType.toLowerCase().includes("text/html")) {
      warnings.push(`Response content-type is ${contentType} — security header standards still apply`);
    }

    res.json({
      service: "security-headers",
      target,
      timestamp: new Date().toISOString(),
      grade,
      score,
      deductions: deductions.map((d) => ({ reason: d.reason, points: -d.points })),
      results: {
        final_url: finalUrl,
        status_code: fetchResponse.status,
        content_type: contentType,
        summary,
        headers: {
          "content-security-policy": csp.result,
          "strict-transport-security": hsts.result,
          "x-content-type-options": xcto.result,
          "x-frame-options": xfo.result,
          "referrer-policy": rp.result,
          "permissions-policy": pp.result,
          "x-xss-protection": xxp.result,
          "cross-origin-resource-policy": corp.result,
          "cross-origin-embedder-policy": coep.result,
          "cross-origin-opener-policy": coop.result,
        },
        anti_patterns: antiPatterns,
      },
      warnings,
      errors: [],
      meta: { duration_ms: durationMs },
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Security headers analyze error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
