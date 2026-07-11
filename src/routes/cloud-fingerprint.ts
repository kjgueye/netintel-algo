import { Router, type Request, type Response } from "express";
import dns from "node:dns/promises";
import { queryDns, RECORD_TYPES, type DnsAnswer } from "../utils/dns-resolvers.js";
import { validateDomain, checkSsrf, ValidationError } from "../utils/validators.js";

export const cloudFingerprintRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  label: string;
  impact: number;
  detail: string;
}

interface ProviderResult {
  provider: string | null;
  confidence: string | null;
  signals: string[];
}

interface WafResult {
  provider: string;
  confidence: string;
  signals: string[];
}

interface HttpFingerprint {
  https_enforced: boolean | null;
  server_header: string | null;
  server_version_exposed: boolean;
  x_powered_by: string | null;
  notable_headers: string[];
}

// --- Notable headers to look for ---

const NOTABLE_HEADER_NAMES = new Set([
  "cf-ray", "cf-cache-status", "cf-request-id", "x-amz-cf-id", "x-cache",
  "x-served-by", "x-vercel-id", "x-nf-request-id", "x-azure-ref",
  "x-check-cacheable", "x-cdn", "x-iinfo", "x-sucuri-id", "x-amzn-requestid",
]);

// --- Detection helpers ---

function containsAny(value: string, patterns: string[]): boolean {
  const lower = value.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function detectCdnHosting(
  cnames: string[],
  headers: Headers | null,
  ptr: string | null,
): { cdn: ProviderResult; hosting: ProviderResult } {
  const signals: string[] = [];
  let cdnProvider: string | null = null;
  let hostingProvider: string | null = null;

  const cnameStr = cnames.map((c) => c.toLowerCase());
  const ptrLower = ptr?.toLowerCase() ?? "";

  // CDN detection (first match wins)
  const cdnChecks: Array<{ name: string; check: () => string[] }> = [
    {
      name: "Cloudflare",
      check: () => {
        const s: string[] = [];
        if (cnameStr.some((c) => c.includes("cloudflare.net"))) s.push("CNAME contains cloudflare.net");
        if (headers?.has("cf-ray")) s.push("cf-ray header present");
        if (ptrLower.includes("cloudflare.net")) s.push("PTR contains cloudflare.net");
        return s;
      },
    },
    {
      name: "CloudFront",
      check: () => {
        const s: string[] = [];
        if (cnameStr.some((c) => c.includes("cloudfront.net"))) s.push("CNAME contains cloudfront.net");
        if (headers?.has("x-amz-cf-id")) s.push("x-amz-cf-id header present");
        if (ptrLower.includes("cloudfront.net")) s.push("PTR contains cloudfront.net");
        return s;
      },
    },
    {
      name: "Fastly",
      check: () => {
        const s: string[] = [];
        if (cnameStr.some((c) => c.includes("fastly.net"))) s.push("CNAME contains fastly.net");
        if (headers?.has("x-served-by")) s.push("x-served-by header present");
        if (ptrLower.includes("fastly.net")) s.push("PTR contains fastly.net");
        return s;
      },
    },
    {
      name: "Akamai",
      check: () => {
        const s: string[] = [];
        if (cnameStr.some((c) => c.includes("akamaiedge.net") || c.includes("akamaihd.net")))
          s.push("CNAME contains akamai domain");
        if (headers?.has("x-check-cacheable")) s.push("x-check-cacheable header present");
        return s;
      },
    },
    {
      name: "Azure CDN",
      check: () => {
        const s: string[] = [];
        if (cnameStr.some((c) => c.includes("azureedge.net"))) s.push("CNAME contains azureedge.net");
        if (headers?.has("x-azure-ref")) s.push("x-azure-ref header present");
        return s;
      },
    },
    {
      name: "Vercel",
      check: () => {
        const s: string[] = [];
        if (cnameStr.some((c) => c.includes("vercel.app"))) s.push("CNAME contains vercel.app");
        if (headers?.has("x-vercel-id")) s.push("x-vercel-id header present");
        return s;
      },
    },
    {
      name: "Netlify",
      check: () => {
        const s: string[] = [];
        if (cnameStr.some((c) => c.includes("netlify.app") || c.includes("netlify.com")))
          s.push("CNAME contains netlify domain");
        if (headers?.has("x-nf-request-id")) s.push("x-nf-request-id header present");
        return s;
      },
    },
    {
      name: "GCP",
      check: () => {
        const s: string[] = [];
        if (cnameStr.some((c) => c.includes("appspot.com") || c.includes("run.app")))
          s.push("CNAME contains GCP domain");
        if (ptrLower.includes("googleusercontent.com")) s.push("PTR contains googleusercontent.com");
        return s;
      },
    },
    {
      name: "AWS EC2",
      check: () => {
        const s: string[] = [];
        if (ptrLower.includes("compute.amazonaws.com") || ptrLower.includes("compute-1.amazonaws.com"))
          s.push("PTR contains AWS compute domain");
        return s;
      },
    },
    {
      name: "Azure VM",
      check: () => {
        const s: string[] = [];
        if (cnameStr.some((c) => c.includes("azurewebsites.net"))) s.push("CNAME contains azurewebsites.net");
        return s;
      },
    },
  ];

  for (const { name, check } of cdnChecks) {
    const matched = check();
    if (matched.length > 0) {
      // CDN providers vs hosting-only providers
      const hostingOnly = ["AWS EC2", "Azure VM"];
      if (hostingOnly.includes(name)) {
        hostingProvider = name;
      } else {
        cdnProvider = name;
        // Also set as hosting provider if not already set
        hostingProvider = name;
      }
      signals.push(...matched);
      break;
    }
  }

  const cdnConfidence = cdnProvider ? getConfidence(signals.length) : null;
  const hostingConfidence = hostingProvider ? getConfidence(signals.length) : null;

  return {
    cdn: { provider: cdnProvider, confidence: cdnConfidence, signals: cdnProvider ? [...signals] : [] },
    hosting: { provider: hostingProvider, confidence: hostingConfidence, signals: hostingProvider ? [...signals] : [] },
  };
}

function detectWaf(headers: Headers | null): WafResult[] {
  if (!headers) return [];

  const results: WafResult[] = [];

  // Cloudflare WAF
  if (headers.has("cf-ray")) {
    results.push({
      provider: "Cloudflare WAF",
      confidence: "medium",
      signals: ["cf-ray header present"],
    });
  }

  // Imperva
  if (headers.get("x-cdn")?.toLowerCase() === "imperva" || headers.has("x-iinfo")) {
    const signals: string[] = [];
    if (headers.get("x-cdn")?.toLowerCase() === "imperva") signals.push("x-cdn equals Imperva");
    if (headers.has("x-iinfo")) signals.push("x-iinfo header present");
    results.push({ provider: "Imperva", confidence: getConfidence(signals.length), signals });
  }

  // Sucuri
  if (headers.has("x-sucuri-id")) {
    results.push({
      provider: "Sucuri",
      confidence: "medium",
      signals: ["x-sucuri-id header present"],
    });
  }

  // AWS WAF
  const awsWafSignals: string[] = [];
  headers.forEach((_value, key) => {
    if (key.toLowerCase().startsWith("x-amzn-waf-")) {
      awsWafSignals.push(`${key} header present`);
    }
  });
  if (awsWafSignals.length > 0) {
    results.push({
      provider: "AWS WAF",
      confidence: getConfidence(awsWafSignals.length),
      signals: awsWafSignals,
    });
  }

  return results;
}

function detectDnsProvider(nsRecords: string[]): ProviderResult {
  const route53Re = /\.awsdns-\d+\.(com|net|org|co\.uk)$/i;

  for (const ns of nsRecords) {
    const lower = ns.toLowerCase();

    if (lower.includes("cloudflare.com"))
      return { provider: "Cloudflare DNS", confidence: "high", signals: [`NS ${ns} contains cloudflare.com`] };

    if (route53Re.test(lower))
      return { provider: "Route 53", confidence: "high", signals: [`NS ${ns} matches Route 53 pattern`] };

    if (lower.includes("googledomains.com"))
      return { provider: "Google Cloud DNS", confidence: "high", signals: [`NS ${ns} contains googledomains.com`] };

    if (lower.includes("azure-dns."))
      return { provider: "Azure DNS", confidence: "high", signals: [`NS ${ns} contains azure-dns`] };

    if (lower.includes("vercel-dns.com"))
      return { provider: "Vercel DNS", confidence: "high", signals: [`NS ${ns} contains vercel-dns.com`] };

    if (lower.includes("nsone.net"))
      return { provider: "Netlify DNS", confidence: "high", signals: [`NS ${ns} contains nsone.net`] };
  }

  return { provider: null, confidence: null, signals: [] };
}

function detectEmailProvider(mxRecords: string[]): ProviderResult {
  for (const mx of mxRecords) {
    const lower = mx.toLowerCase();

    if (lower.includes("google.com") || lower.includes("aspmx.l.google.com"))
      return { provider: "Google Workspace", confidence: "high", signals: [`MX ${mx} contains Google domain`] };

    if (lower.includes("protection.outlook.com"))
      return { provider: "Microsoft 365", confidence: "high", signals: [`MX ${mx} contains protection.outlook.com`] };

    if (lower.includes("protonmail.ch"))
      return { provider: "ProtonMail", confidence: "high", signals: [`MX ${mx} contains protonmail.ch`] };

    if (lower.includes("fastmail.com"))
      return { provider: "Fastmail", confidence: "high", signals: [`MX ${mx} contains fastmail.com`] };

    if (lower.includes("zoho.com"))
      return { provider: "Zoho", confidence: "high", signals: [`MX ${mx} contains zoho.com`] };
  }

  return { provider: null, confidence: null, signals: [] };
}

function getConfidence(signalCount: number): string {
  if (signalCount >= 2) return "high";
  if (signalCount === 1) return "medium";
  return "low";
}

function calculateGrade(score: number): string {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 50) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

export interface CloudFingerprintResult {
  domain: string;
  resolved_ips: string[];
  cname_chain: string[];
  hosting: ProviderResult;
  cdn: ProviderResult;
  waf: WafResult[];
  dns_provider: ProviderResult;
  email_provider: ProviderResult;
  http_fingerprint: HttpFingerprint;
  tls: { issuer: string | null; wildcard: boolean | null; san_count: number | null };
  score: number;
  grade: string;
  findings: Finding[];
}

/**
 * Core cloud-fingerprint logic, extracted so aggregators (e.g. domain-report-full)
 * can reuse it directly. Performs the SSRF check and all probes; expects an
 * already-validated domain. The route handler below calls this unchanged.
 */
export async function runCloudFingerprint(domain: string): Promise<CloudFingerprintResult> {
  await checkSsrf(domain);

  // --- Run DNS probes in parallel ---
    const [aAnswers, cnameAnswers, nsAnswers, mxAnswers] = await Promise.allSettled([
      queryDns(domain, RECORD_TYPES.A),
      queryDns(domain, RECORD_TYPES.CNAME),
      queryDns(domain, RECORD_TYPES.NS),
      queryDns(domain, RECORD_TYPES.MX),
    ]);

    const aRecords = aAnswers.status === "fulfilled" ? aAnswers.value : [];
    const cnameRecords = cnameAnswers.status === "fulfilled" ? cnameAnswers.value : [];
    const nsRecords = nsAnswers.status === "fulfilled" ? nsAnswers.value : [];
    const mxRecords = mxAnswers.status === "fulfilled" ? mxAnswers.value : [];

    const resolvedIps = aRecords.filter((a) => a.address).map((a) => a.address!);
    const cnameChain = cnameRecords.filter((c) => c.data).map((c) => c.data!);
    const nsNames = nsRecords.filter((n) => n.ns).map((n) => n.ns!);
    const mxNames = mxRecords.filter((m) => m.exchange).map((m) => m.exchange!);

    // --- PTR lookup on first resolved IP ---
    let ptr: string | null = null;
    if (resolvedIps.length > 0) {
      try {
        const ptrResults = await dns.reverse(resolvedIps[0]);
        ptr = ptrResults.length > 0 ? ptrResults[0] : null;
      } catch {
        ptr = null;
      }
    }

    // --- HTTP probes in parallel ---
    let httpsHeaders: Headers | null = null;
    let httpsEnforced: boolean | null = null;
    let serverHeader: string | null = null;
    let xPoweredBy: string | null = null;

    const [httpsResult, httpResult] = await Promise.allSettled([
      fetch(`https://${domain}`, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`http://${domain}`, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      }),
    ]);

    if (httpsResult.status === "fulfilled") {
      httpsHeaders = httpsResult.value.headers;
      serverHeader = httpsHeaders.get("server") ?? null;
      xPoweredBy = httpsHeaders.get("x-powered-by") ?? null;
    }

    if (httpResult.status === "fulfilled") {
      const httpResponse = httpResult.value;
      const status = httpResponse.status;
      const location = httpResponse.headers.get("location") ?? "";
      if (status >= 300 && status < 400 && location.toLowerCase().startsWith("https://")) {
        httpsEnforced = true;
      } else {
        httpsEnforced = false;
      }
    } else {
      httpsEnforced = null;
    }

    // --- Detection ---
    const { cdn, hosting } = detectCdnHosting(cnameChain, httpsHeaders, ptr);
    const waf = detectWaf(httpsHeaders);
    const dnsProvider = detectDnsProvider(nsNames);
    const emailProvider = detectEmailProvider(mxNames);

    // --- HTTP fingerprint ---
    const serverVersionExposed = serverHeader !== null && /\/[\d.]+/.test(serverHeader);
    const notableHeaders: string[] = [];
    if (httpsHeaders) {
      httpsHeaders.forEach((_value, key) => {
        if (NOTABLE_HEADER_NAMES.has(key.toLowerCase())) {
          notableHeaders.push(key.toLowerCase());
        }
      });
    }

    const httpFingerprint: HttpFingerprint = {
      https_enforced: httpsEnforced,
      server_header: serverHeader,
      server_version_exposed: serverVersionExposed,
      x_powered_by: xPoweredBy,
      notable_headers: notableHeaders,
    };

    // --- Grading ---
    let score = 100;
    const findings: Finding[] = [];

    if (cdn.provider === null) {
      findings.push({ rule: "no_cdn", label: "No CDN detected", impact: -25, detail: "No CDN/edge provider detected — origin server may be directly exposed" });
      score -= 25;
    }

    if (waf.length === 0) {
      findings.push({ rule: "no_waf", label: "No WAF detected", impact: -20, detail: "No Web Application Firewall detected" });
      score -= 20;
    }

    if (httpsEnforced === false) {
      findings.push({ rule: "https_not_enforced", label: "HTTPS not enforced", impact: -20, detail: "HTTP does not redirect to HTTPS" });
      score -= 20;
    }

    if (serverVersionExposed) {
      findings.push({ rule: "server_version_exposed", label: "Server version exposed", impact: -10, detail: `Server header exposes version: ${serverHeader}` });
      score -= 10;
    }

    if (xPoweredBy !== null) {
      findings.push({ rule: "x_powered_by_present", label: "X-Powered-By present", impact: -5, detail: `X-Powered-By header exposes technology: ${xPoweredBy}` });
      score -= 5;
    }

    if (cdn.provider !== null && ptr !== null && !containsAny(ptr, [cdn.provider.toLowerCase().split(" ")[0]])) {
      findings.push({ rule: "origin_ip_exposed", label: "Origin IP may be exposed", impact: -10, detail: `PTR record (${ptr}) does not match CDN provider (${cdn.provider})` });
      score -= 10;
    }

    if (dnsProvider.provider === null) {
      findings.push({ rule: "no_managed_dns", label: "No managed DNS", impact: -10, detail: "DNS provider could not be identified as a managed service" });
      score -= 10;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    return {
      domain,
      resolved_ips: resolvedIps,
      cname_chain: cnameChain,
      hosting,
      cdn,
      waf,
      dns_provider: dnsProvider,
      email_provider: emailProvider,
      http_fingerprint: httpFingerprint,
      tls: { issuer: null, wildcard: null, san_count: null },
      score,
      grade,
      findings,
    };
}

cloudFingerprintRouter.get("/cloud-fingerprint/analyze", async (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string | undefined;

    if (!rawDomain) {
      res.status(400).json({ error: "domain is required — e.g. /cloud-fingerprint/analyze?domain=example.com" });
      return;
    }

    const domain = validateDomain(rawDomain);
    res.json(await runCloudFingerprint(domain));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Cloud fingerprint error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
