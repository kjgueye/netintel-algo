import { Router, type Request, type Response } from "express";
import dns from "node:dns/promises";
import tls from "node:tls";
import { queryDns, RECORD_TYPES, type DnsAnswer } from "../utils/dns-resolvers.js";
import { validateDomain, checkSsrf, ValidationError } from "../utils/validators.js";
import { safeFetch } from "../utils/safe-fetch.js";

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

// --- TLS probe ---

// Three cert facts only: who issued it, whether it covers a wildcard, and how
// many names it carries. Keeps its own tls.connect rather than importing one
// from ssl.ts / ssl-cert-quick.ts — those routes deliberately each own their
// handshake (see the note at the top of ssl-cert-quick.ts), and this probe
// needs a fraction of what they parse.
//
// NEVER rejects: the cert is a bonus signal for fingerprinting, so any
// failure (timeout, refused, handshake error, no cert) resolves to all-nulls
// and the rest of the fingerprint proceeds. Runs alongside the HTTP probes,
// so it costs no extra wall-clock. SSRF is already checked by the caller.
const TLS_PROBE_TIMEOUT_MS = 4000;

interface TlsSummary {
  issuer: string | null;
  wildcard: boolean | null;
  san_count: number | null;
}

const TLS_UNKNOWN: TlsSummary = { issuer: null, wildcard: null, san_count: null };

function certField(obj: tls.Certificate | undefined, key: string): string | null {
  if (!obj) return null;
  const val = (obj as unknown as Record<string, unknown>)[key];
  return typeof val === "string" ? val : null;
}

function probeTls(domain: string): Promise<TlsSummary> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (summary: TlsSummary, socket?: tls.TLSSocket) => {
      socket?.destroy();
      if (settled) return;
      settled = true;
      resolve(summary);
    };

    let socket: tls.TLSSocket;
    try {
      socket = tls.connect(
        {
          host: domain,
          port: 443,
          servername: domain,
          timeout: TLS_PROBE_TIMEOUT_MS,
          // We are reading the cert, not trusting it — an expired or
          // self-signed cert is a fingerprinting signal, not a reason to bail.
          rejectUnauthorized: false,
        },
        () => {
          const cert = socket.getPeerCertificate(false);
          if (!cert || !cert.subject) return finish(TLS_UNKNOWN, socket);

          const sans = (cert.subjectaltname ?? "")
            .split(",")
            .map((e) => e.trim())
            .filter((e) => e.startsWith("DNS:"))
            .map((e) => e.slice(4));

          const subjectCn = certField(cert.subject, "CN");
          // Organization first — "Let's Encrypt" identifies the issuer far
          // better than a CN like "R11" or "E5".
          const issuer = certField(cert.issuer, "O") ?? certField(cert.issuer, "CN");

          finish(
            {
              issuer,
              wildcard: sans.some((s) => s.startsWith("*.")) || (subjectCn?.startsWith("*.") ?? false),
              san_count: sans.length,
            },
            socket,
          );
        },
      );
    } catch {
      return finish(TLS_UNKNOWN);
    }

    socket.on("error", () => finish(TLS_UNKNOWN, socket));
    socket.on("timeout", () => finish(TLS_UNKNOWN, socket));
  });
}

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
  // false = neither the https nor the http probe got a response, so every
  // header-derived field below is "unknown", NOT "absent". Check this before
  // reading cdn/waf/http_fingerprint — see the scoring note further down.
  http_reachable: boolean;
  hosting: ProviderResult;
  cdn: ProviderResult;
  waf: WafResult[];
  dns_provider: ProviderResult;
  email_provider: ProviderResult;
  http_fingerprint: HttpFingerprint;
  tls: { issuer: string | null; wildcard: boolean | null; san_count: number | null };
  // null when http_reachable is false — we have no basis to grade a host we
  // could not reach. Callers must null-check: `score < 50` is true for null.
  score: number | null;
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

    const [httpsResult, httpResult, tlsResult] = await Promise.allSettled([
      // Follows redirects with every hop SSRF-checked before it is requested;
      // a blocked hop rejects and allSettled treats it like any probe failure.
      safeFetch(`https://${domain}`, { method: "HEAD", timeoutMs: 5000 }),
      // The http probe deliberately does NOT follow — it only inspects the
      // first hop's Location to judge https enforcement.
      fetch(`http://${domain}`, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      }),
      // Never rejects; resolves to all-nulls when there is no cert to read.
      probeTls(domain),
    ]);

    const tlsSummary: TlsSummary = tlsResult.status === "fulfilled" ? tlsResult.value : TLS_UNKNOWN;

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
    // A host can resolve in DNS and still answer nothing on 80/443 — internal
    // apps, VPN/gateway endpoints, and firewalled records are all published in
    // public DNS. When both probes fail we know NOTHING about its CDN, WAF or
    // headers, so scoring the absences would report "not detected" as "absent"
    // and hand back a confident D for a host we never touched. Grade only what
    // we actually observed; DNS-derived rules still apply.
    const httpReachable = httpsResult.status === "fulfilled" || httpResult.status === "fulfilled";

    let score = 100;
    const findings: Finding[] = [];

    if (!httpReachable) {
      findings.push({
        rule: "probe_unreachable",
        label: "Host did not respond on HTTP or HTTPS",
        impact: 0,
        detail:
          "The domain resolves, but neither https:// nor http:// returned a response within 5s — the host is firewalled, not serving the public internet, or not a web host. CDN, WAF and header fields are unknown (not absent) and no grade is issued.",
      });

      // A live TLS listener behind a silent HTTP layer is a real finding, not
      // a contradiction: mTLS-gated gateways, VPN/appliance endpoints and
      // IP-allowlisted apps all complete a handshake and then say nothing.
      // For a caller triaging hostnames this separates "dead record" from
      // "live service you cannot reach", so it is worth its own rule.
      if (tlsSummary.issuer !== null) {
        findings.push({
          rule: "tls_only",
          label: "TLS listener present but HTTP silent",
          impact: 0,
          detail: `Port 443 completed a TLS handshake (certificate issued by ${tlsSummary.issuer}) but no HTTP response followed — a live service that does not serve the public web.`,
        });
      }
    }

    if (httpReachable && cdn.provider === null) {
      findings.push({ rule: "no_cdn", label: "No CDN detected", impact: -25, detail: "No CDN/edge provider detected — origin server may be directly exposed" });
      score -= 25;
    }

    if (httpReachable && waf.length === 0) {
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
    const finalScore = httpReachable ? score : null;
    const grade = httpReachable ? calculateGrade(score) : "insufficient_data";

    return {
      domain,
      resolved_ips: resolvedIps,
      cname_chain: cnameChain,
      http_reachable: httpReachable,
      hosting,
      cdn,
      waf,
      dns_provider: dnsProvider,
      email_provider: emailProvider,
      http_fingerprint: httpFingerprint,
      tls: tlsSummary,
      score: finalScore,
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
