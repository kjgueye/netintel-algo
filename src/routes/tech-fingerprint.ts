import { Router, type Request, type Response } from "express";
import { timeouts } from "../config.js";
import { checkSsrf, validateUrl, ValidationError } from "../utils/validators.js";
import { pickRequestParam } from "../utils/field-aliases.js";

export const techFingerprintRouter = Router();

// The synonyms agents send for the URL parameter (canonical first) — same
// leniency pattern as the network family (see field-aliases.ts).
const URL_ALIASES = ["url", "target", "site", "domain", "website", "link", "host", "query", "q"];

// --- Detection types ---

interface Detection {
  name: string;
  category: string;
  confidence: "high" | "medium" | "low";
}

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

// --- Detection helpers ---

const USER_AGENT = "Mozilla/5.0 (compatible; NetIntel/1.0; +https://netintel.dev)";
const MAX_BODY_BYTES = 150 * 1024;

function detectServer(headers: Headers): Detection[] {
  const detections: Detection[] = [];
  const lower = (headers.get("server") ?? "").toLowerCase();

  if (lower.includes("nginx")) detections.push({ name: "Nginx", category: "server", confidence: "high" });
  if (lower.includes("apache")) detections.push({ name: "Apache", category: "server", confidence: "high" });
  if (lower.includes("cloudflare")) detections.push({ name: "Cloudflare", category: "server", confidence: "high" });
  if (lower.includes("amazons3")) detections.push({ name: "AWS S3", category: "server", confidence: "high" });
  if (lower.includes("awselbauthorservicemainmw")) detections.push({ name: "AWS ELB", category: "server", confidence: "high" });
  if (lower.includes("microsoft-iis")) detections.push({ name: "IIS", category: "server", confidence: "high" });

  // CDN-fronted sites name the edge in `server` (e.g. CloudFront) and leak
  // the origin stack via x-powered-by instead — rivian.com production miss.
  const poweredBy = (headers.get("x-powered-by") ?? "").toLowerCase();
  if (poweredBy.includes("express")) detections.push({ name: "Express", category: "server", confidence: "high" });
  if (poweredBy.includes("php")) detections.push({ name: "PHP", category: "server", confidence: "high" });
  if (poweredBy.includes("asp.net")) detections.push({ name: "ASP.NET", category: "server", confidence: "high" });

  return detections;
}

function detectCdn(headers: Headers): Detection[] {
  const detections: Detection[] = [];
  const server = (headers.get("server") ?? "").toLowerCase();
  const via = (headers.get("via") ?? "").toLowerCase();

  if (headers.has("cf-ray")) {
    detections.push({ name: "Cloudflare", category: "cdn", confidence: "high" });
  }

  // CloudFront announces itself several ways: `server: CloudFront`,
  // `via: …cloudfront.net (CloudFront)`, and x-amz-cf-* headers. Missed in
  // production on rivian.com (cdn: null despite all four signals).
  if (
    server.includes("cloudfront") ||
    via.includes("cloudfront") ||
    headers.has("x-amz-cf-id") ||
    headers.has("x-amz-cf-pop")
  ) {
    detections.push({ name: "CloudFront", category: "cdn", confidence: "high" });
  }

  const servedBy = headers.get("x-served-by") ?? "";
  if (servedBy.includes("cache-")) {
    detections.push({ name: "Fastly", category: "cdn", confidence: "high" });
  }

  if (server.includes("akamaighost")) {
    detections.push({ name: "Akamai", category: "cdn", confidence: "high" });
  }

  if (headers.has("x-vercel-id") || server.includes("vercel")) {
    detections.push({ name: "Vercel", category: "cdn", confidence: "high" });
  }

  if (headers.has("x-azure-ref")) {
    detections.push({ name: "Azure Front Door", category: "cdn", confidence: "high" });
  }

  const xCdn = headers.get("x-cdn") ?? "";
  if (xCdn.toLowerCase().includes("imperva")) {
    detections.push({ name: "Imperva", category: "cdn", confidence: "high" });
  }

  if (via.includes("varnish")) {
    detections.push({ name: "Varnish", category: "cdn", confidence: "medium" });
  }

  // Generic cache markers only count when no specific CDN matched — otherwise
  // e.g. CloudFront's own `x-cache: Miss from cloudfront` double-reports.
  const xCache = headers.get("x-cache") ?? "";
  if (detections.length === 0 && (xCache.includes("HIT") || xCache.includes("MISS"))) {
    detections.push({ name: "Generic CDN/cache", category: "cdn", confidence: "low" });
  }

  return detections;
}

function detectCms(html: string): Detection[] {
  const detections: Detection[] = [];

  if (html.includes("/wp-content/") || html.includes("/wp-includes/")) {
    detections.push({ name: "WordPress", category: "cms", confidence: "high" });
  }
  if (html.includes("Drupal.settings") || html.includes("/sites/default/files/")) {
    detections.push({ name: "Drupal", category: "cms", confidence: "high" });
  }
  if (html.includes("Joomla") || html.includes("/media/jui/")) {
    detections.push({ name: "Joomla", category: "cms", confidence: "high" });
  }
  if (html.toLowerCase().includes("shopify") || html.includes("cdn.shopify.com")) {
    detections.push({ name: "Shopify", category: "cms", confidence: "high" });
  }
  if (html.includes("squarespace.com")) {
    detections.push({ name: "Squarespace", category: "cms", confidence: "high" });
  }
  if (html.includes("wix.com")) {
    detections.push({ name: "Wix", category: "cms", confidence: "high" });
  }

  // Generator meta tag
  const generatorMatch = html.match(/<meta\s+name=["']generator["']\s+content=["']([^"']+)["']/i);
  if (generatorMatch) {
    const existing = detections.find((d) => d.category === "cms");
    if (!existing) {
      detections.push({ name: generatorMatch[1], category: "cms", confidence: "medium" });
    }
  }

  return detections;
}

function detectJavascript(html: string, headers?: Headers): Detection[] {
  const detections: Detection[] = [];
  const lower = html.toLowerCase();

  if (lower.includes("react") || lower.includes("react.min.js")) {
    detections.push({ name: "React", category: "javascript", confidence: "medium" });
  }
  if (lower.includes("vue.js") || lower.includes("vue.min.js")) {
    detections.push({ name: "Vue.js", category: "javascript", confidence: "medium" });
  }
  if (lower.includes("angular.js") || lower.includes("angular.min.js")) {
    detections.push({ name: "AngularJS", category: "javascript", confidence: "medium" });
  }

  // Next.js: the x-nextjs-cache / x-powered-by headers and _next/static asset
  // paths are definitive (high); the bare framework name is only a hint.
  const poweredBy = (headers?.get("x-powered-by") ?? "").toLowerCase();
  if (headers?.has("x-nextjs-cache") || poweredBy.includes("next.js") || lower.includes("_next/static")) {
    detections.push({ name: "Next.js", category: "javascript", confidence: "high" });
  } else if (lower.includes("next.js")) {
    detections.push({ name: "Next.js", category: "javascript", confidence: "medium" });
  }

  if (lower.includes("jquery")) {
    detections.push({ name: "jQuery", category: "javascript", confidence: "medium" });
  }

  // Bootstrap: match real asset references only — webpack runtimes contain the
  // bare word "bootstrap" as a chunk-loading function name, which false-flagged
  // every bundled site (e.g. rivian.com) as Bootstrap.
  if (/bootstrap(?:\.bundle|\.min)*\.(?:css|js)|bootstrapcdn|\/npm\/bootstrap@/.test(lower)) {
    detections.push({ name: "Bootstrap", category: "javascript", confidence: "medium" });
  }

  return detections;
}

function detectAnalytics(html: string): Detection[] {
  const detections: Detection[] = [];

  if (html.includes("google-analytics.com") || html.includes("googletagmanager.com")) {
    detections.push({ name: "Google Analytics", category: "analytics", confidence: "high" });
  }
  if (html.includes("segment.com/analytics")) {
    detections.push({ name: "Segment", category: "analytics", confidence: "high" });
  }
  if (html.includes("hotjar.com")) {
    detections.push({ name: "Hotjar", category: "analytics", confidence: "high" });
  }
  if (html.includes("mixpanel.com")) {
    detections.push({ name: "Mixpanel", category: "analytics", confidence: "high" });
  }
  if (html.includes("clarity.ms")) {
    detections.push({ name: "Microsoft Clarity", category: "analytics", confidence: "high" });
  }

  return detections;
}

function detectWafSecurity(headers: Headers): Detection[] {
  const detections: Detection[] = [];

  if (headers.has("x-sucuri-id")) {
    detections.push({ name: "Sucuri WAF", category: "waf", confidence: "high" });
  }
  if (headers.has("x-firewall-protection")) {
    detections.push({ name: "Generic WAF", category: "waf", confidence: "medium" });
  }
  const server = (headers.get("server") ?? "").toLowerCase();
  if (server.includes("cloudflare")) {
    detections.push({ name: "Cloudflare WAF", category: "waf", confidence: "medium" });
  }
  if (headers.has("x-powered-by-imperva")) {
    detections.push({ name: "Imperva WAF", category: "waf", confidence: "high" });
  }

  const cookies = headers.get("set-cookie") ?? "";
  if (cookies.includes("__utmz") || cookies.includes("incap_ses")) {
    detections.push({ name: "Imperva", category: "waf", confidence: "medium" });
  }

  if (headers.has("x-security-header")) {
    detections.push({ name: "Generic security tool", category: "security", confidence: "low" });
  }

  return detections;
}

// --- Security header scoring ---

const SECURITY_HEADERS = [
  "Strict-Transport-Security",
  "Content-Security-Policy",
  "X-Frame-Options",
  "X-Content-Type-Options",
  "Referrer-Policy",
] as const;

const SECURITY_RULES: Array<{ rule: string; header: string; deduction: number; detail: string }> = [
  { rule: "missing_hsts", header: "strict-transport-security", deduction: -20, detail: "Strict-Transport-Security header missing" },
  { rule: "missing_csp", header: "content-security-policy", deduction: -20, detail: "Content-Security-Policy header missing" },
  { rule: "missing_x_frame", header: "x-frame-options", deduction: -10, detail: "X-Frame-Options header missing" },
  { rule: "missing_x_content_type", header: "x-content-type-options", deduction: -10, detail: "X-Content-Type-Options header missing" },
  { rule: "missing_referrer_policy", header: "referrer-policy", deduction: -10, detail: "Referrer-Policy header missing" },
];

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Extracted fingerprint logic (shared with the domain-report-full aggregator) ---

export interface TechFingerprintResult {
  url: string;
  status_code: number;
  server: string | null;
  cdn: string | null;
  cms: string | null;
  waf: string | null;
  javascript_frameworks: string[];
  analytics: string[];
  security_headers_present: string[];
  security_headers_missing: string[];
}

/**
 * Core technology fingerprint logic, reusing the same detection helpers as the
 * route handler. Accepts a domain or full URL (bare domains are probed over
 * https). Throws on connection failure so the aggregator can mark the section
 * failed. The route handler keeps its own richer error responses unchanged.
 */
export async function runTechFingerprint(target: string): Promise<TechFingerprintResult> {
  const normalized = /^https?:\/\//i.test(target.trim()) ? target.trim() : `https://${target.trim()}`;
  const parsedUrl = validateUrl(normalized);
  await checkSsrf(parsedUrl.hostname);

  let statusCode: number;
  let responseHeaders: Headers;
  let html = "";

  const headRes = await fetch(parsedUrl.toString(), {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(timeouts.techFingerprint),
    headers: { "User-Agent": USER_AGENT },
  });
  statusCode = headRes.status;
  responseHeaders = headRes.headers;

  try {
    const getRes = await fetch(parsedUrl.toString(), {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeouts.techFingerprint),
      headers: { "User-Agent": USER_AGENT },
    });
    statusCode = getRes.status;
    responseHeaders = getRes.headers;

    const reader = getRes.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      while (totalSize < MAX_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalSize += value.length;
      }
      reader.cancel().catch(() => {});
      const decoder = new TextDecoder();
      html = chunks.map((c) => decoder.decode(c, { stream: true })).join("");
      html = html.slice(0, MAX_BODY_BYTES);
    }
  } catch {
    // If GET fails, proceed with HEAD data only.
  }

  const detections: Detection[] = [
    ...detectServer(responseHeaders),
    ...detectCdn(responseHeaders),
    ...detectCms(html),
    ...detectJavascript(html, responseHeaders),
    ...detectAnalytics(html),
    ...detectWafSecurity(responseHeaders),
  ];

  const securityHeadersPresent: string[] = [];
  const securityHeadersMissing: string[] = [];
  for (const header of SECURITY_HEADERS) {
    if (responseHeaders.has(header.toLowerCase()) || responseHeaders.has(header)) {
      securityHeadersPresent.push(header);
    } else {
      securityHeadersMissing.push(header);
    }
  }

  return {
    url: parsedUrl.toString(),
    status_code: statusCode,
    server: detections.find((d) => d.category === "server")?.name ?? null,
    cdn: detections.find((d) => d.category === "cdn")?.name ?? null,
    cms: detections.find((d) => d.category === "cms")?.name ?? null,
    waf: detections.find((d) => d.category === "waf")?.name ?? null,
    javascript_frameworks: detections.filter((d) => d.category === "javascript").map((d) => d.name),
    analytics: detections.filter((d) => d.category === "analytics").map((d) => d.name),
    security_headers_present: securityHeadersPresent,
    security_headers_missing: securityHeadersMissing,
  };
}

// --- Route handler ---

techFingerprintRouter.get("/tech-fingerprint/analyze", async (req: Request, res: Response) => {
  try {
    const rawUrl = pickRequestParam(req, URL_ALIASES);

    if (!rawUrl) {
      res.status(400).json({
        error:
          'url is required — pass a URL as the `url` query param, ' +
          'e.g. /tech-fingerprint/analyze?url=https://example.com (aliases accepted: target, site, domain, link).',
      });
      return;
    }

    // Tolerate bare domains (same normalization as the shared core).
    const normalized = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const parsedUrl = validateUrl(normalized);
    await checkSsrf(parsedUrl.hostname);

    const start = Date.now();
    let statusCode: number;
    let responseHeaders: Headers;
    let html = "";

    // HEAD request first for headers
    try {
      const headRes = await fetch(parsedUrl.toString(), {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(timeouts.techFingerprint),
        headers: { "User-Agent": USER_AGENT },
      });
      statusCode = headRes.status;
      responseHeaders = headRes.headers;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Technology fingerprint failed: ${message}` });
      return;
    }

    // GET request for body
    try {
      const getRes = await fetch(parsedUrl.toString(), {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(timeouts.techFingerprint),
        headers: { "User-Agent": USER_AGENT },
      });
      statusCode = getRes.status;
      responseHeaders = getRes.headers;

      // Read body up to MAX_BODY_BYTES
      const reader = getRes.body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        while (totalSize < MAX_BODY_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalSize += value.length;
        }
        reader.cancel().catch(() => {});
        const decoder = new TextDecoder();
        html = chunks.map((c) => decoder.decode(c, { stream: true })).join("");
        html = html.slice(0, MAX_BODY_BYTES);
      }
    } catch {
      // If GET fails, we still have HEAD data — proceed with what we have
    }

    const responseTimeMs = Date.now() - start;

    // --- Run all detections ---
    const detections: Detection[] = [
      ...detectServer(responseHeaders),
      ...detectCdn(responseHeaders),
      ...detectCms(html),
      ...detectJavascript(html, responseHeaders),
      ...detectAnalytics(html),
      ...detectWafSecurity(responseHeaders),
    ];

    // --- Build summary ---
    const serverDetection = detections.find((d) => d.category === "server");
    const cdnDetection = detections.find((d) => d.category === "cdn");
    const cmsDetection = detections.find((d) => d.category === "cms");
    const wafDetection = detections.find((d) => d.category === "waf");
    const jsFrameworks = detections.filter((d) => d.category === "javascript").map((d) => d.name);
    const analytics = detections.filter((d) => d.category === "analytics").map((d) => d.name);

    // --- Security header checks ---
    const securityHeadersPresent: string[] = [];
    const securityHeadersMissing: string[] = [];
    for (const header of SECURITY_HEADERS) {
      if (responseHeaders.has(header.toLowerCase()) || responseHeaders.has(header)) {
        securityHeadersPresent.push(header);
      } else {
        securityHeadersMissing.push(header);
      }
    }

    // --- Scoring ---
    let score = 100;
    const findings: Finding[] = [];

    for (const rule of SECURITY_RULES) {
      if (!responseHeaders.has(rule.header)) {
        findings.push({ rule: rule.rule, deduction: rule.deduction, detail: rule.detail });
        score += rule.deduction;
      }
    }

    const hasWaf = detections.some((d) => d.category === "waf");
    if (!hasWaf) {
      // A CDN-fronted origin commonly runs a WAF we cannot see from outside
      // (e.g. AWS WAF behind CloudFront) — soften the deduction and say so
      // rather than docking the site's grade for our own blind spot.
      if (cdnDetection && cdnDetection.name !== "Generic CDN/cache") {
        findings.push({
          rule: "no_waf_detected",
          deduction: -5,
          detail: `No WAF visible externally — site is behind ${cdnDetection.name}, which commonly fronts an origin-side WAF (e.g. AWS WAF) that cannot be detected from responses`,
        });
        score -= 5;
      } else {
        findings.push({ rule: "no_waf_detected", deduction: -10, detail: "No WAF detected" });
        score -= 10;
      }
    }

    if (parsedUrl.protocol === "http:") {
      findings.push({ rule: "http_not_https", deduction: -20, detail: "URL uses http instead of https" });
      score -= 20;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    res.json({
      url: parsedUrl.toString(),
      status_code: statusCode,
      response_time_ms: responseTimeMs,
      detections,
      summary: {
        server: serverDetection?.name ?? null,
        cdn: cdnDetection?.name ?? null,
        cms: cmsDetection?.name ?? null,
        waf: wafDetection?.name ?? null,
        javascript_frameworks: jsFrameworks,
        analytics,
      },
      security_headers_present: securityHeadersPresent,
      security_headers_missing: securityHeadersMissing,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Tech fingerprint error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
