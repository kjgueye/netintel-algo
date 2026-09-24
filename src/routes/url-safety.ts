import { Router, type Request, type Response } from "express";
import { validateUrl, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";

export const urlSafetyRouter = Router();

// --- Constants ---

const SUSPICIOUS_TLDS = new Set([
  ".tk", ".ml", ".ga", ".cf", ".gq", ".xyz", ".top", ".click",
  ".loan", ".work", ".date", ".racing", ".win", ".download", ".stream", ".gdn",
]);

const BRAND_KEYWORDS = [
  "paypal", "apple", "microsoft", "google", "amazon", "facebook",
  "instagram", "netflix", "bank", "secure", "login", "signin",
  "account", "verify", "update", "confirm",
];

const BRAND_DOMAINS: Record<string, string> = {
  paypal: "paypal.com",
  apple: "apple.com",
  microsoft: "microsoft.com",
  google: "google.com",
  amazon: "amazon.com",
  facebook: "facebook.com",
  instagram: "instagram.com",
  netflix: "netflix.com",
};

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

// --- Heuristic analysis ---

function analyzeHeuristics(parsed: URL): string[] {
  const flags: string[] = [];
  const hostname = parsed.hostname.toLowerCase();

  // Suspicious TLD
  const lastDot = hostname.lastIndexOf(".");
  if (lastDot !== -1) {
    const tld = hostname.slice(lastDot);
    if (SUSPICIOUS_TLDS.has(tld)) {
      flags.push("suspicious_tld");
    }
  }

  // URL length
  if (parsed.href.length > 100) {
    flags.push("long_url");
  }

  // Excessive encoding in path
  const encodedMatches = parsed.pathname.match(/%[0-9A-Fa-f]{2}/g);
  if (encodedMatches && encodedMatches.length > 3) {
    flags.push("excessive_encoding");
  }

  // IP address as host
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    flags.push("ip_host");
  }

  // Subdomain depth
  const parts = hostname.split(".");
  // subdomains = total parts minus TLD minus main domain
  if (parts.length > 4) {
    flags.push("deep_subdomains");
  }

  // Brand impersonation
  for (const keyword of BRAND_KEYWORDS) {
    if (hostname.includes(keyword)) {
      const brandDomain = BRAND_DOMAINS[keyword];
      if (brandDomain) {
        // Check that hostname is NOT exactly the brand domain or a subdomain of it
        if (hostname !== brandDomain && !hostname.endsWith("." + brandDomain)) {
          flags.push("brand_impersonation");
          break;
        }
      } else {
        // Keywords without a specific domain (bank, secure, login, etc.)
        flags.push("brand_impersonation");
        break;
      }
    }
  }

  // Homograph / punycode
  if (hostname.includes("xn--")) {
    flags.push("homograph_risk");
  }

  return flags;
}

// --- Grading ---

function buildFindings(
  inUrlhaus: boolean,
  urlStatus: string | null,
  blacklistedGsb: boolean,
  heuristicFlags: string[],
  urlhausError: boolean,
): { findings: Finding[]; score: number; grade: string } {
  let score = 100;
  const findings: Finding[] = [];

  function deduct(rule: string, deduction: number, detail: string) {
    findings.push({ rule, deduction: -deduction, detail });
    score -= deduction;
  }

  if (inUrlhaus) {
    deduct("in_urlhaus_database", 60, "URL found in URLhaus malware database");
  }

  if (inUrlhaus && urlStatus === "online") {
    deduct("active_threat", 20, "URL is currently online and serving malware");
  }

  if (blacklistedGsb) {
    deduct("blacklisted_gsb", 30, "URL listed in Google Safe Browsing via URLhaus");
  }

  for (const flag of heuristicFlags) {
    switch (flag) {
      case "brand_impersonation":
        deduct("brand_impersonation", 25, "URL host contains brand keyword but is not the official domain");
        break;
      case "suspicious_tld":
        deduct("suspicious_tld", 15, "URL uses a TLD with high phishing correlation");
        break;
      case "ip_host":
        deduct("ip_host", 20, "URL uses an IP address instead of a domain name");
        break;
      case "excessive_encoding":
        deduct("excessive_encoding", 10, "URL path contains excessive percent-encoding");
        break;
      case "deep_subdomains":
        deduct("deep_subdomains", 10, "URL host has unusually deep subdomain nesting");
        break;
      case "long_url":
        deduct("long_url", 5, "URL length exceeds 100 characters");
        break;
      case "homograph_risk":
        deduct("homograph_risk", 20, "URL host contains punycode (xn--), possible homograph attack");
        break;
    }
  }

  if (urlhausError) {
    findings.push({ rule: "urlhaus_error", deduction: 0, detail: "URLhaus lookup failed — heuristic analysis only" });
  }

  score = Math.max(0, score);

  let grade: string;
  if (score >= 90) grade = "A";
  else if (score >= 75) grade = "B";
  else if (score >= 55) grade = "C";
  else if (score >= 30) grade = "D";
  else grade = "F";

  return { findings, score, grade };
}

function classifyThreat(
  inUrlhaus: boolean,
  heuristicFlags: string[],
): { threat_classification: string; confidence: string } {
  if (inUrlhaus) {
    return { threat_classification: "malicious", confidence: "high" };
  }
  if (heuristicFlags.length >= 2) {
    return { threat_classification: "suspicious", confidence: "medium" };
  }
  if (heuristicFlags.length === 1) {
    return { threat_classification: "suspicious", confidence: "low" };
  }
  return { threat_classification: "clean", confidence: "none" };
}

// --- Extracted analysis logic (shared with the url-safety-full aggregator) ---

export interface UrlSafetyResult {
  url: string;
  in_urlhaus: boolean;
  urlhaus_status: string | null;
  threat_type: string | null;
  malware_families: string[];
  blacklisted_gsb: boolean;
  blacklisted_surbl: boolean;
  urlhaus_reference: string | null;
  heuristic_flags: string[];
  threat_classification: string;
  confidence: string;
  score: number;
  grade: string;
  findings: Finding[];
}

/**
 * Core URL-safety analysis: URLhaus lookup plus heuristic scoring. Deliberately
 * performs NO SSRF check — it is designed to inspect potentially malicious URLs
 * (it never fetches the target itself, only queries the URLhaus API). The route
 * handler below calls this unchanged.
 */
export async function runUrlSafety(rawUrl: string): Promise<UrlSafetyResult> {
  const parsed = validateUrl(rawUrl);

  // --- URLhaus lookup ---
  let inUrlhaus = false;
  let urlhausStatus: string | null = null;
  let threatType: string | null = null;
  let malwareFamilies: string[] = [];
  let blacklistedGsb = false;
  let blacklistedSurbl = false;
  let urlhausReference: string | null = null;
  let urlhausError = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeouts.urlSafety);

    const body = new URLSearchParams({ url: parsed.href });
    // Headers AND body are read under the same deadline: the timer used to be
    // cleared as soon as the headers arrived, so a body that stalled afterwards
    // outlived timeouts.urlSafety.
    let data: Record<string, any>;
    try {
      const response = await fetch("https://urlhaus-api.abuse.ch/v1/url/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });
      data = (await response.json()) as Record<string, any>;
    } finally {
      clearTimeout(timeout);
    }

    if (data.query_status === "is_url") {
      inUrlhaus = true;
      urlhausStatus = data.url_status ?? null;
      threatType = data.threat ?? null;
      urlhausReference = data.urlhaus_reference ?? null;

      // Extract malware families from tags and payloads
      const families = new Set<string>();
      if (Array.isArray(data.tags)) {
        for (const tag of data.tags) {
          if (typeof tag === "string") families.add(tag);
        }
      }
      if (Array.isArray(data.payloads)) {
        for (const payload of data.payloads) {
          if (payload?.signature && typeof payload.signature === "string") {
            families.add(payload.signature);
          }
        }
      }
      malwareFamilies = [...families];

      blacklistedGsb = data.blacklists?.gsb === "listed";
      blacklistedSurbl = data.blacklists?.surbl === "listed";
    }
  } catch {
    urlhausError = true;
  }

  // --- Heuristic analysis ---
  const heuristicFlags = analyzeHeuristics(parsed);

  // --- Build response ---
  const { threat_classification, confidence } = classifyThreat(inUrlhaus, heuristicFlags);
  const { findings, score, grade } = buildFindings(inUrlhaus, urlhausStatus, blacklistedGsb, heuristicFlags, urlhausError);

  return {
    url: parsed.href,
    in_urlhaus: inUrlhaus,
    urlhaus_status: urlhausStatus,
    threat_type: threatType,
    malware_families: malwareFamilies,
    blacklisted_gsb: blacklistedGsb,
    blacklisted_surbl: blacklistedSurbl,
    urlhaus_reference: urlhausReference,
    heuristic_flags: heuristicFlags,
    threat_classification,
    confidence,
    score,
    grade,
    findings,
  };
}

// --- Route handler ---

urlSafetyRouter.get("/url-safety/check", async (req: Request, res: Response) => {
  try {
    const rawUrl = req.query.url as string | undefined;

    if (!rawUrl) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    res.json(await runUrlSafety(rawUrl));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("URL safety error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

