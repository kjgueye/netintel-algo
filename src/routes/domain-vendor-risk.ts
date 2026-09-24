import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import net from "node:net";
import dns from "node:dns/promises";
import { timeouts, vendorRiskWeights, pricing } from "../config.js";
import { signableAccepts } from "../accepts.js";
import { runDomainAge } from "./domain-age.js";
import { runSslAnalyze } from "./ssl.js";
import { runDnsLookup } from "./dns.js";
import { deliverableMxHosts } from "../utils/dns-resolvers.js";
import { runEmailAuth } from "./email-auth.js";
import { runIpReputation } from "./ip-reputation.js";
import { runCertTransparency } from "./cert-transparency.js";

export const domainVendorRiskRouter = Router();

// ---------------------------------------------------------------------------
// Domain Vendor Risk Score — composite trust/risk verdict for a domain.
//
// Aggregator (bundle): fans out IN-PROCESS to six of NetIntel's own primitives
// (domain age, SSL, DNS health, email auth, IP reputation, cert transparency),
// maps each to a normalized 0-100 sub-score, and blends them into a single
// weighted composite + actionable flags. No scraping, no vendor API, no new
// runtime — it calls the extracted run*() functions directly (same pattern as
// domain-report-full / ip-risk).
//
// A false "safe" is the only costly error, so partial data NEVER reads as low
// risk: fewer than 3 signals ⇒ risk_band "unknown" + low_confidence flag.
// ---------------------------------------------------------------------------

const SIGNAL_KEYS = [
  "domain_age",
  "ssl",
  "dns",
  "email_auth",
  "ip_reputation",
  "cert_transparency",
] as const;
type SignalKey = (typeof SIGNAL_KEYS)[number];

interface SignalOutcome {
  score: number; // normalized 0-100 sub-score (higher = safer)
  detail: string; // short human breakdown string — PART OF THE PRODUCT
  flags: string[]; // flags this signal contributes to the agent branch surface
}

// Flags ranked most-decision-relevant first so the single strongest fraud
// signal (domain_age_under_90d) and hard blocks surface prominently in flags[].
const FLAG_ORDER = [
  "domain_age_under_90d",
  "all_signals_failed",
  "ip_blocklisted",
  "cert_expired",
  "domain_unresolved",
  "dmarc_missing",
  "spf_missing",
  "ssl_expiring_soon",
  "cert_anomaly",
  "no_mx_records",
  "domain_age_under_1yr",
  "low_confidence",
];

function orderFlags(flags: Iterable<string>): string[] {
  return [...flags].sort((a, b) => {
    const ai = FLAG_ORDER.indexOf(a);
    const bi = FLAG_ORDER.indexOf(b);
    return (ai === -1 ? FLAG_ORDER.length : ai) - (bi === -1 ? FLAG_ORDER.length : bi);
  });
}

// --- Input normalization -----------------------------------------------------

const HOSTNAME_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})*\.[a-z]{2,}$/;

/**
 * Strip scheme/path/port/leading-www and validate a bare registrable hostname.
 * Returns the clean domain, or null for IPs, URLs without a hostname, and
 * garbage — the caller maps null to a 400 INVALID_DOMAIN.
 */
function normalizeDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.split(/[/?#]/)[0]; // path / query / fragment
  s = s.replace(/:\d+$/, ""); // port
  s = s.replace(/^www\./, ""); // leading www.
  s = s.replace(/\.$/, ""); // trailing dot
  if (!s || s.length > 253) return null;
  if (net.isIP(s) !== 0) return null; // reject bare IPs
  if (!HOSTNAME_RE.test(s)) return null;
  return s;
}

// --- Per-signal deadline (partial-return on timeout) -------------------------

class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), deadline]);
}

// --- Fire-and-forget per-signal failure sink ---------------------------------
// Overridable so a throwing sink can be exercised in tests; the route wraps the
// call in try/catch so a logging failure is ALWAYS invisible to the caller.
export const failureSink = {
  record(signal: string, domain: string, reason: unknown): void {
    console.warn(
      `domain-vendor-risk: ${signal} signal unavailable for ${domain}:`,
      reason instanceof Error ? reason.message : reason,
    );
  },
};

// --- Signal collectors (native output → normalized sub-score) ----------------

async function collectDomainAge(domain: string): Promise<SignalOutcome> {
  const r = await runDomainAge(domain);
  const flags: string[] = [];
  const ageDays = r.age_days;

  let score: number;
  if (ageDays === null) score = 40; // could not date the domain — uncertain, not "safe"
  else if (ageDays < 30) score = 5;
  else if (ageDays < 90) score = 12;
  else if (ageDays < 180) score = 40;
  else if (ageDays < 365) score = 55;
  else if (ageDays < 730) score = 75;
  else if (ageDays < 1825) score = 90;
  else score = 100;

  // domain_age_under_90d is the single strongest fraud signal — surface it.
  if (ageDays !== null && ageDays < 90) flags.push("domain_age_under_90d");
  if (ageDays !== null && ageDays < 365) flags.push("domain_age_under_1yr");

  let detail: string;
  if (ageDays === null) {
    detail = "Registration date undetermined";
  } else {
    const created = r.created_at ? r.created_at.slice(0, 7) : "unknown";
    const yrs = r.age_years ?? Math.round((ageDays / 365.25) * 10) / 10;
    detail = `Registered ${created}, ${yrs} yrs`;
  }
  return { score, detail, flags };
}

const SSL_GRADE_SCORE: Record<string, number> = { A: 95, B: 80, C: 60, D: 45, F: 20 };

async function collectSsl(domain: string): Promise<SignalOutcome> {
  const r = await runSslAnalyze(domain);
  const flags: string[] = [];
  let score = SSL_GRADE_SCORE[r.grade] ?? 60;

  let daysLeft: number | null = null;
  if (r.certificate.not_after) {
    const t = new Date(r.certificate.not_after).getTime();
    if (!Number.isNaN(t)) daysLeft = Math.floor((t - Date.now()) / 86_400_000);
  }
  const expired = daysLeft !== null && daysLeft < 0;
  if (expired) {
    flags.push("cert_expired");
    score = Math.min(score, 15);
  } else if (daysLeft !== null && daysLeft <= 21) {
    flags.push("ssl_expiring_soon");
    score = Math.min(score, 60);
  }

  const proto = r.connection.protocol ?? "TLS";
  let detail: string;
  if (expired) detail = `Certificate expired ${Math.abs(daysLeft!)}d ago`;
  else if (daysLeft !== null) detail = `Valid, ${proto}, expires in ${daysLeft}d`;
  else detail = `Grade ${r.grade}, ${proto}`;
  return { score, detail, flags };
}

async function collectDns(domain: string): Promise<SignalOutcome> {
  const r = await runDnsLookup(domain);
  const flags: string[] = [];
  const addrCount = r.records.A.length + r.records.AAAA.length;
  const nsCount = r.records.NS.length;
  // Count only real deliverable MX — a null MX (RFC 7505) is not "MX healthy".
  const mxCount = deliverableMxHosts(r.records.MX).length;

  let score: number;
  let detail: string;
  if (addrCount === 0 && nsCount === 0) {
    score = 8;
    detail = "Domain does not resolve (no A/AAAA/NS)";
    flags.push("domain_unresolved");
  } else {
    score = 100;
    if (nsCount === 0) score -= 25;
    if (addrCount === 0) {
      score -= 20;
      flags.push("domain_unresolved");
    }
    if (mxCount === 0) {
      score -= 30;
      flags.push("no_mx_records");
    }
    score = Math.max(0, score);
    detail =
      mxCount > 0 && nsCount > 0 && addrCount > 0
        ? "MX + NS healthy"
        : `${nsCount > 0 ? "NS " : ""}${addrCount > 0 ? "A " : ""}${mxCount > 0 ? "MX " : ""}`.trim() +
          (mxCount === 0 ? " (no MX)" : "");
  }
  return { score, detail, flags };
}

async function collectEmailAuth(domain: string): Promise<SignalOutcome> {
  const r = await runEmailAuth(domain);
  const flags: string[] = [];
  const spf = r.spf.found;
  const dmarc = r.dmarc.found;
  const policy = r.dmarc.policy;
  const enforcing = dmarc && (policy === "reject" || policy === "quarantine");

  let score: number;
  if (enforcing && spf) score = 92;
  else if (enforcing) score = 80;
  else if (dmarc && spf) score = 60; // DMARC p=none + SPF
  else if (dmarc) score = 50;
  else if (spf) score = 42;
  else score = 12;

  if (!dmarc) flags.push("dmarc_missing");
  if (!spf) flags.push("spf_missing");

  const detail = `${spf ? "SPF ok" : "SPF missing"}, ${dmarc ? `DMARC ${policy ?? "present"}` : "DMARC missing"}`;
  return { score, detail, flags };
}

/** First IPv4 for the domain, or throw so the ip_reputation signal is unavailable. */
async function resolvePrimaryIp(domain: string): Promise<string> {
  const addrs = await dns.resolve4(domain);
  if (!addrs || addrs.length === 0) throw new Error("domain has no A record");
  return addrs[0];
}

async function collectIpReputation(domain: string): Promise<SignalOutcome> {
  const ip = await resolvePrimaryIp(domain);
  const r = await runIpReputation(ip);
  const flags: string[] = [];
  const risk = typeof r.risk_score === "number" ? r.risk_score : 0;
  let score = Math.max(0, Math.min(100, 100 - risk));

  const cats = r.composite.threat_categories ?? [];
  const confidence = r.abuseipdb.confidence_score ?? 0;
  const blocklisted = r.composite.is_malicious || confidence >= 50;
  if (blocklisted) {
    flags.push("ip_blocklisted");
    score = Math.min(score, 25);
  }

  let detail: string;
  if (blocklisted) {
    detail = cats.length
      ? `Flagged (${cats.slice(0, 3).join(", ")}) on ${ip}`
      : `Flagged: AbuseIPDB ${confidence}% on ${ip}`;
  } else {
    detail = `Clean, no blocklist hits (${ip})`;
  }
  return { score, detail, flags };
}

async function collectCertTransparency(domain: string): Promise<SignalOutcome> {
  const r = await runCertTransparency(domain, { limit: 25 });
  const flags: string[] = [];
  const total = r.total_certs_found;
  const rules = new Set(r.findings.map((f) => f.rule));

  let score: number;
  if (total === 0) {
    score = 45;
    flags.push("cert_anomaly");
  } else {
    score = 85;
    if (rules.has("cert_already_expired")) {
      flags.push("cert_expired");
      score -= 15;
    }
    if (rules.has("recently_issued_suspicious") || rules.has("excessive_issuers")) {
      flags.push("cert_anomaly");
      score -= 15;
    }
    score = Math.max(0, Math.min(100, score));
  }

  const anomalies = flags.length;
  const detail =
    total === 0
      ? "No certificates in CT logs"
      : `${total} certs, ${anomalies === 0 ? "none anomalous" : `${anomalies} anomal${anomalies === 1 ? "y" : "ies"}`}`;
  return { score, detail, flags };
}

const COLLECTORS: Record<SignalKey, (domain: string) => Promise<SignalOutcome>> = {
  domain_age: collectDomainAge,
  ssl: collectSsl,
  dns: collectDns,
  email_auth: collectEmailAuth,
  ip_reputation: collectIpReputation,
  cert_transparency: collectCertTransparency,
};

// --- Route handler -----------------------------------------------------------

// GET/HEAD return 402 so cold discovery probes see a payment challenge instead
// of a 405 (GET-only crawlers listed this as dead/priceless). Same pattern as classify.
const vendorRiskPaymentRequired = {
  x402Version: 2,
  accepts: signableAccepts(pricing.domainVendorRisk),
  error: "Payment required",
};
domainVendorRiskRouter.get("/domain/vendor-risk", (_req: Request, res: Response) => {
  res.status(402).json(vendorRiskPaymentRequired);
});
domainVendorRiskRouter.head("/domain/vendor-risk", (_req: Request, res: Response) => {
  res.status(402).end();
});

domainVendorRiskRouter.post("/domain/vendor-risk", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const runId = crypto.randomUUID();
  try {
    // JSON body is the documented input; also accept ?domain= for leniency.
    const rawDomain =
      (req.body && typeof req.body.domain === "string" ? req.body.domain : undefined) ??
      (typeof req.query.domain === "string" ? req.query.domain : undefined);

    if (typeof rawDomain !== "string" || rawDomain.trim() === "") {
      res.status(400).json({ error: "Invalid domain", code: "INVALID_DOMAIN" });
      return;
    }

    const domain = normalizeDomain(rawDomain);
    if (!domain) {
      res.status(400).json({ error: "Invalid domain", code: "INVALID_DOMAIN" });
      return;
    }

    // Fan out to all six signals concurrently, each under its own deadline.
    const perSignalTimeout = timeouts.domainVendorRisk;
    const settled = await Promise.allSettled(
      SIGNAL_KEYS.map((k) => withTimeout(COLLECTORS[k](domain), perSignalTimeout)),
    );

    const signals: Record<string, { score: number; detail: string }> = {};
    const signalsUnavailable: string[] = [];
    const flagSet = new Set<string>();
    const available: SignalKey[] = [];

    settled.forEach((r, i) => {
      const key = SIGNAL_KEYS[i];
      if (r.status === "fulfilled") {
        available.push(key);
        signals[key] = { score: r.value.score, detail: r.value.detail };
        for (const f of r.value.flags) flagSet.add(f);
      } else {
        signalsUnavailable.push(key);
        // Best-effort only: a logging failure must never affect the response.
        try {
          failureSink.record(key, domain, r.reason);
        } catch {
          /* swallow — fire-and-forget */
        }
      }
    });

    // Composite = weighted average of AVAILABLE sub-scores, weights (from config)
    // re-normalized across only the signals that returned.
    let riskScore: number | null = null;
    if (available.length > 0) {
      let weightedSum = 0;
      let totalWeight = 0;
      for (const key of available) {
        const w = vendorRiskWeights[key];
        weightedSum += w * signals[key].score;
        totalWeight += w;
      }
      riskScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null;
    }

    let confidence: "full" | "partial" | "low";
    if (available.length === 6) confidence = "full";
    else if (available.length >= 3) confidence = "partial";
    else confidence = "low";

    // MINIMUM-SIGNAL-CONFIDENCE: fewer than 3 signals (or none) must NOT read as a
    // computed low/medium/high verdict — "couldn't check" ≠ "genuinely safe".
    let riskBand: "low" | "medium" | "high" | "unknown";
    if (available.length < 3 || riskScore === null) {
      riskBand = "unknown";
      flagSet.add("low_confidence");
    } else if (riskScore >= 70) riskBand = "low";
    else if (riskScore >= 40) riskBand = "medium";
    else riskBand = "high";

    if (available.length === 0) flagSet.add("all_signals_failed");

    res.json({
      domain,
      risk_score: riskScore,
      risk_band: riskBand,
      signals,
      flags: orderFlags(flagSet),
      signals_unavailable: signalsUnavailable,
      confidence,
      run_id: runId,
      duration_ms: Date.now() - startedAt,
      // Endpoint-health envelope fields (distinct from risk_score, the product
      // value). 100/A on any successful run — even a low-confidence one, the
      // endpoint did its job.
      score: 100,
      grade: "A",
      findings: [],
    });
  } catch (err) {
    console.error("domain-vendor-risk error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
