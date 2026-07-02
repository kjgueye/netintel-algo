// Ported verbatim from NetIntel src/routes/domain-report.ts. Only deviation:
// helpers come from ./lib (inlined copies, no NetIntel imports).
import { Router, type Request, type Response } from "express";
import net from "node:net";
import tls from "node:tls";
import { timeouts } from "./lib/config.js";
import { checkSsrf, validateDomain, ValidationError } from "./lib/validators.js";
import { queryDns, resolveTxt } from "./lib/dns-resolvers.js";

export const domainReportRouter = Router();

export const DOMAIN_REPORT_PRICE = "$0.100";

// --- Types ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

interface WhoisSection {
  available: boolean;
  registrar: string | null;
  created_at: string | null;
  expires_at: string | null;
  days_until_expiry: number | null;
  status: string[];
}

interface DnsSection {
  available: boolean;
  a_records: string[];
  mx_records: string[];
  ns_records: string[];
  txt_records: string[];
}

interface SslSection {
  available: boolean;
  issuer: string | null;
  valid_from: string | null;
  valid_to: string | null;
  days_until_expiry: number | null;
  san_count: number;
}

interface TechSection {
  available: boolean;
  server: string | null;
  cdn: string | null;
  cms: string | null;
  waf: string | null;
}

interface BlacklistSection {
  available: boolean;
  listed_count: number;
  lists_checked: number;
  listed_on: string[];
}

// 5 fastest major DNSBLs — keeps total report latency reasonable
const DNSBLS = [
  "zen.spamhaus.org",
  "bl.spamcop.net",
  "b.barracudacentral.org",
  "dnsbl.sorbs.net",
  "xbl.spamhaus.org",
];

const USER_AGENT = "Mozilla/5.0 (compatible; NetIntel/1.0; +https://netintel.dev)";
const MAX_BODY_BYTES = 150 * 1024;

// --- Generic helpers ---

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

function riskLevel(score: number): string {
  if (score >= 75) return "low";
  if (score >= 50) return "medium";
  return "high";
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

function reverseIp(ip: string): string {
  return ip.split(".").reverse().join(".");
}

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

// --- WHOIS / RDAP ---

function extractRegistrar(entities: unknown): string | null {
  if (!Array.isArray(entities)) return null;
  for (const entity of entities) {
    const e = entity as Record<string, unknown>;
    const roles = e.roles as string[] | undefined;
    if (!roles?.includes("registrar")) continue;
    const vcardArray = e.vcardArray as unknown[] | undefined;
    if (Array.isArray(vcardArray) && Array.isArray(vcardArray[1])) {
      for (const field of vcardArray[1] as unknown[][]) {
        if (Array.isArray(field) && field[0] === "fn") return String(field[3]);
      }
    }
  }
  return null;
}

function extractEvents(events: unknown): { created_at: string | null; expires_at: string | null } {
  const result = { created_at: null as string | null, expires_at: null as string | null };
  if (!Array.isArray(events)) return result;
  for (const evt of events) {
    const e = evt as Record<string, unknown>;
    if (e.eventAction === "registration") result.created_at = (e.eventDate as string) ?? null;
    else if (e.eventAction === "expiration") result.expires_at = (e.eventDate as string) ?? null;
  }
  return result;
}

function extractStatus(statusArr: unknown): string[] {
  if (!Array.isArray(statusArr)) return [];
  return statusArr
    .map((s) =>
      String(s)
        .replace(/https?:\/\/icann\.org\/epp#/i, "")
        .replace(/([A-Z])/g, " $1")
        .trim()
        .toLowerCase()
    )
    .filter((s) => s.length > 0);
}

const WHOIS_EMPTY: WhoisSection = {
  available: false,
  registrar: null,
  created_at: null,
  expires_at: null,
  days_until_expiry: null,
  status: [],
};

async function whoisCheck(domain: string): Promise<WhoisSection> {
  try {
    const tld = domain.slice(domain.lastIndexOf(".") + 1);

    const bootstrapRes = await fetch("https://data.iana.org/rdap/dns.json", {
      signal: AbortSignal.timeout(timeouts.domainReport),
    });
    if (!bootstrapRes.ok) return WHOIS_EMPTY;
    const bootstrap = (await bootstrapRes.json()) as { services: string[][][] };

    let rdapBaseUrl: string | null = null;
    if (Array.isArray(bootstrap.services)) {
      for (const service of bootstrap.services) {
        const tlds = service[0];
        const urls = service[1];
        if (Array.isArray(tlds) && tlds.includes(tld) && Array.isArray(urls) && urls.length > 0) {
          // length checked above; ! satisfies this repo's noUncheckedIndexedAccess
          rdapBaseUrl = urls[0]!.replace(/\/+$/, "");
          break;
        }
      }
    }
    if (!rdapBaseUrl) return WHOIS_EMPTY;

    await checkSsrf(new URL(rdapBaseUrl).hostname);

    const rdapRes = await fetch(`${rdapBaseUrl}/domain/${domain}`, {
      signal: AbortSignal.timeout(timeouts.domainReport),
    });
    if (!rdapRes.ok) return WHOIS_EMPTY;
    const data = (await rdapRes.json()) as Record<string, unknown>;

    const dates = extractEvents(data.events);
    const daysUntilExpiry = dates.expires_at
      ? daysBetween(new Date(), new Date(dates.expires_at))
      : null;

    return {
      available: true,
      registrar: extractRegistrar(data.entities),
      created_at: dates.created_at,
      expires_at: dates.expires_at,
      days_until_expiry: daysUntilExpiry,
      status: extractStatus(data.status),
    };
  } catch {
    return WHOIS_EMPTY;
  }
}

// --- DNS records ---

const DNS_EMPTY: DnsSection = {
  available: false,
  a_records: [],
  mx_records: [],
  ns_records: [],
  txt_records: [],
};

async function dnsCheck(domain: string): Promise<DnsSection> {
  try {
    const [aAnswers, mxAnswers, nsAnswers, txtRecords] = await Promise.all([
      queryDns(domain, "A"),
      queryDns(domain, "MX"),
      queryDns(domain, "NS"),
      resolveTxt(domain),
    ]);

    return {
      available: true,
      a_records: aAnswers.map((a) => a.address!).filter(Boolean),
      mx_records: mxAnswers.map((a) => (a.exchange || "").replace(/\.$/, "")).filter(Boolean),
      ns_records: nsAnswers.map((a) => (a.ns || "").replace(/\.$/, "")).filter(Boolean),
      txt_records: txtRecords,
    };
  } catch {
    return DNS_EMPTY;
  }
}

// --- SSL certificate ---

const SSL_EMPTY: SslSection = {
  available: false,
  issuer: null,
  valid_from: null,
  valid_to: null,
  days_until_expiry: null,
  san_count: 0,
};

function getCertField(obj: tls.Certificate | undefined, key: string): string | null {
  if (!obj) return null;
  const val = (obj as unknown as Record<string, unknown>)[key];
  return typeof val === "string" ? val : null;
}

function toIso(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toISOString();
}

function tlsConnect(host: string, port: number): Promise<tls.PeerCertificate> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, timeout: timeouts.domainReport, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate(true);
        socket.destroy();
        resolve(cert);
      }
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Connection timed out"));
    });
  });
}

async function sslCheck(domain: string): Promise<SslSection> {
  try {
    await checkSsrf(domain);
    const cert = await tlsConnect(domain, 443);
    if (!cert || !cert.valid_to) return SSL_EMPTY;

    const validTo = new Date(cert.valid_to);
    const daysUntilExpiry = isNaN(validTo.getTime()) ? null : daysBetween(new Date(), validTo);

    let sanCount = 0;
    if (cert.subjectaltname) {
      sanCount = cert.subjectaltname
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("DNS:")).length;
    }

    return {
      available: true,
      issuer: getCertField(cert.issuer, "O") ?? getCertField(cert.issuer, "CN"),
      valid_from: toIso(cert.valid_from),
      valid_to: toIso(cert.valid_to),
      days_until_expiry: daysUntilExpiry,
      san_count: sanCount,
    };
  } catch {
    return SSL_EMPTY;
  }
}

// --- Tech fingerprint ---

const TECH_EMPTY: TechSection = {
  available: false,
  server: null,
  cdn: null,
  cms: null,
  waf: null,
};

function detectCdn(headers: Headers): string | null {
  if (headers.has("cf-ray")) return "Cloudflare";
  if ((headers.get("server") ?? "").toLowerCase().includes("akamaighost")) return "Akamai";
  if ((headers.get("x-served-by") ?? "").includes("cache-")) return "Fastly";
  return null;
}

function detectCms(html: string): string | null {
  if (html.includes("/wp-content/") || html.includes("/wp-includes/")) return "WordPress";
  if (html.toLowerCase().includes("shopify")) return "Shopify";
  if (html.includes("Drupal.settings")) return "Drupal";
  if (html.includes("squarespace.com")) return "Squarespace";
  if (html.includes("wix.com")) return "Wix";
  const generator = html.match(/<meta\s+name=["']generator["']\s+content=["']([^"']+)["']/i);
  return generator ? generator[1] ?? null : null;
}

function detectWaf(headers: Headers): string | null {
  if (headers.has("cf-ray") || (headers.get("server") ?? "").toLowerCase().includes("cloudflare")) {
    return "Cloudflare WAF";
  }
  if (headers.has("x-sucuri-id")) return "Sucuri WAF";
  if (headers.has("x-powered-by-imperva")) return "Imperva WAF";
  return null;
}

async function techCheck(domain: string): Promise<TechSection> {
  try {
    await checkSsrf(domain);
    const res = await fetch(`https://${domain}`, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeouts.domainReport),
      headers: { "User-Agent": USER_AGENT },
    });

    let html = "";
    try {
      html = (await res.text()).slice(0, MAX_BODY_BYTES);
    } catch {
      // Body unavailable — header-based detections still apply
    }

    return {
      available: true,
      server: res.headers.get("server") || null,
      cdn: detectCdn(res.headers),
      cms: detectCms(html),
      waf: detectWaf(res.headers),
    };
  } catch {
    return TECH_EMPTY;
  }
}

// --- IP blacklist ---

const BLACKLIST_EMPTY: BlacklistSection = {
  available: false,
  listed_count: 0,
  lists_checked: 0,
  listed_on: [],
};

async function blacklistCheck(domain: string): Promise<BlacklistSection> {
  try {
    const aAnswers = await queryDns(domain, "A");
    const ip = aAnswers.map((a) => a.address!).filter(Boolean)[0];
    if (!ip || !net.isIPv4(ip)) return BLACKLIST_EMPTY;

    const reversed = reverseIp(ip);
    const results = await Promise.allSettled(
      DNSBLS.map(async (host) => {
        const answers = await queryDns(`${reversed}.${host}`, "A");
        const listed = answers.some((a) => a.address?.startsWith("127."));
        return { host, listed };
      })
    );

    const listedOn: string[] = [];
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.listed) listedOn.push(r.value.host);
    }

    return {
      available: true,
      listed_count: listedOn.length,
      lists_checked: DNSBLS.length,
      listed_on: listedOn,
    };
  } catch {
    return BLACKLIST_EMPTY;
  }
}

// --- Route handler ---

domainReportRouter.get("/domain-report/analyze", async (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string | undefined;
    if (!rawDomain) {
      res.status(400).json({ error: "domain is required" });
      return;
    }

    const domain = validateDomain(rawDomain);

    // All five checks run concurrently — a slow or failing check never blocks the others.
    const [whoisR, dnsR, sslR, techR, blacklistR] = await Promise.allSettled([
      whoisCheck(domain),
      dnsCheck(domain),
      sslCheck(domain),
      techCheck(domain),
      blacklistCheck(domain),
    ]);

    const whois = settledValue(whoisR, WHOIS_EMPTY);
    const dns = settledValue(dnsR, DNS_EMPTY);
    const ssl = settledValue(sslR, SSL_EMPTY);
    const tech = settledValue(techR, TECH_EMPTY);
    const blacklist = settledValue(blacklistR, BLACKLIST_EMPTY);

    // --- Aggregate risk scoring across all five dimensions ---
    let score = 100;
    const findings: Finding[] = [];
    const deduct = (rule: string, amount: number, detail: string) => {
      findings.push({ rule, deduction: -amount, detail });
      score -= amount;
    };

    // WHOIS
    if (!whois.available) {
      deduct("whois_unavailable", 10, "WHOIS/RDAP registration data unavailable");
    } else {
      if (whois.days_until_expiry !== null && whois.days_until_expiry < 30) {
        deduct("domain_expiring_soon", 20, `Domain expires in ${whois.days_until_expiry} days`);
      }
      if (whois.created_at) {
        const daysSinceCreation = daysBetween(new Date(whois.created_at), new Date());
        if (daysSinceCreation >= 0 && daysSinceCreation < 30) {
          deduct("recently_registered", 25, `Domain was registered ${daysSinceCreation} days ago`);
        }
      }
    }

    // SSL
    if (!ssl.available) {
      deduct("ssl_missing", 25, "SSL certificate could not be retrieved");
    } else if (ssl.days_until_expiry !== null && ssl.days_until_expiry < 14) {
      deduct("ssl_expiring_soon", 20, `SSL certificate expires in ${ssl.days_until_expiry} days`);
    }

    // Blacklist — one deduction per listing
    for (const host of blacklist.listed_on) {
      deduct("ip_blacklisted", 15, `Resolved IP is listed on ${host}`);
    }

    // DNS
    if (dns.available) {
      if (dns.mx_records.length === 0) {
        deduct("no_mx_records", 10, "Domain has no MX records");
      }
      if (!dns.txt_records.some((t) => t.startsWith("v=spf1"))) {
        deduct("no_spf", 10, "No SPF (v=spf1) TXT record found");
      }
    }

    score = Math.max(0, score);

    if (findings.length === 0) {
      findings.push({ rule: "section_ok", deduction: 0, detail: "All five checks completed" });
    }

    res.json({
      domain,
      resolved_ip: dns.a_records[0] ?? null,
      overall_score: score,
      grade: calculateGrade(score),
      risk_level: riskLevel(score),
      sections: {
        whois: {
          available: whois.available,
          registrar: whois.registrar,
          created_at: whois.created_at,
          expires_at: whois.expires_at,
          days_until_expiry: whois.days_until_expiry,
          status: whois.status,
        },
        dns: {
          available: dns.available,
          a_records: dns.a_records,
          mx_records: dns.mx_records,
          ns_records: dns.ns_records,
          txt_records: dns.txt_records,
        },
        ssl: {
          available: ssl.available,
          issuer: ssl.issuer,
          valid_from: ssl.valid_from,
          valid_to: ssl.valid_to,
          days_until_expiry: ssl.days_until_expiry,
          san_count: ssl.san_count,
        },
        tech: {
          available: tech.available,
          server: tech.server,
          cdn: tech.cdn,
          cms: tech.cms,
          waf: tech.waf,
        },
        blacklist: {
          available: blacklist.available,
          listed_count: blacklist.listed_count,
          lists_checked: blacklist.lists_checked,
          listed_on: blacklist.listed_on,
        },
      },
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("domain-report error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
