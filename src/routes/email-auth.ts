import { Router, type Request, type Response } from "express";
import { resolveTxt, domainHasMailInfra } from "../utils/dns-resolvers.js";
import { validateDomain, ValidationError } from "../utils/validators.js";
import { config, pricing } from "../config.js";
import { signableAccepts } from "../accepts.js";

export const emailAuthRouter = Router();

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404
const emailAuthPaymentRequired = {
  x402Version: 2,
  accepts: signableAccepts(pricing.emailAuth),
  error: "Payment required",
};

emailAuthRouter.get("/email-auth", (_req: Request, res: Response) => {
  res.status(402).json(emailAuthPaymentRequired);
});

emailAuthRouter.head("/email-auth", (_req: Request, res: Response) => {
  res.status(402).end();
});

// --- Interfaces ---

interface Issue {
  severity: "warn" | "fail" | "info";
  message: string;
  deduction: number;
}

interface Deduction {
  rule: string;
  points: number; // negative
  detail: string;
}

interface SpfResult {
  found: boolean;
  record: string | null;
  mechanisms: string[];
  all_qualifier: string | null;
  dns_lookup_count: number;
  issues: Issue[];
}

interface DkimRecord {
  selector: string;
  record: string;
  key_type: string;
  key_length_bits: number | null;
  issues: Issue[];
}

interface DkimResult {
  found: boolean;
  selectors_checked: string[];
  records: DkimRecord[];
  issues: Issue[];
}

interface DmarcResult {
  found: boolean;
  record: string | null;
  policy: string | null;
  subdomain_policy: string | null;
  pct: number | null;
  rua: string[];
  ruf: string[];
  issues: Issue[];
}

// --- Constants ---

const DEFAULT_SELECTORS = [
  "default", "google", "selector1", "selector2",
  "k1", "k2", "s1", "s2", "dkim", "mail",
  "smtp", "mandrill", "everlytickey1", "mxvault",
];

const DNS_LOOKUP_MECHANISMS = ["include", "a", "mx", "ptr", "exists", "redirect"];

const POLICY_STRENGTH: Record<string, number> = {
  reject: 3,
  quarantine: 2,
  none: 1,
};

// --- TXT record helpers ---

function parseTags(raw: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      tags[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }
  return tags;
}

// --- SPF check ---

function checkSpf(txtRecords: string[]): { spf: SpfResult; deductions: Deduction[] } {
  const spfRecords = txtRecords.filter((r) => r.startsWith("v=spf1"));
  const deductions: Deduction[] = [];
  const issues: Issue[] = [];

  if (spfRecords.length === 0) {
    deductions.push({ rule: "spf_missing", points: -25, detail: "No SPF record found" });
    return {
      spf: {
        found: false,
        record: null,
        mechanisms: [],
        all_qualifier: null,
        dns_lookup_count: 0,
        issues: [{ severity: "fail", message: "No SPF record found", deduction: -25 }],
      },
      deductions,
    };
  }

  if (spfRecords.length > 1) {
    deductions.push({ rule: "spf_multiple", points: -10, detail: "Multiple SPF records found (RFC 7208 violation)" });
    issues.push({ severity: "fail", message: "Multiple SPF records found (RFC 7208 violation)", deduction: -10 });
  }

  const record = spfRecords[0];
  const parts = record.split(/\s+/).slice(1); // skip "v=spf1"

  let allQualifier: string | null = null;
  const mechanisms: string[] = [];

  for (const p of parts) {
    if (["+all", "-all", "~all", "?all"].includes(p)) {
      allQualifier = p;
    } else {
      mechanisms.push(p);
    }
  }

  // Count DNS-lookup-causing mechanisms
  let dnsLookupCount = 0;
  let ptrUsed = false;
  for (const m of mechanisms) {
    const withoutQualifier = m.replace(/^[+\-~?]/, "");
    const mechName = withoutQualifier.split(/[:\/=]/)[0].toLowerCase();
    if (DNS_LOOKUP_MECHANISMS.includes(mechName)) {
      dnsLookupCount++;
    }
    if (mechName === "ptr") {
      ptrUsed = true;
    }
  }

  // all-qualifier deductions
  if (allQualifier === "+all") {
    deductions.push({ rule: "spf_plus_all", points: -20, detail: "SPF +all allows any server to send email" });
    issues.push({ severity: "fail", message: "SPF +all allows any server to send email", deduction: -20 });
  } else if (allQualifier === "?all") {
    deductions.push({ rule: "spf_neutral_all", points: -10, detail: "SPF ?all is neutral — provides no protection" });
    issues.push({ severity: "warn", message: "SPF ?all is neutral — provides no protection", deduction: -10 });
  } else if (allQualifier === "~all") {
    deductions.push({ rule: "spf_softfail", points: -5, detail: "Softfail (~all) instead of hardfail (-all)" });
    issues.push({ severity: "warn", message: "Softfail (~all) instead of hardfail (-all)", deduction: -5 });
  } else if (!allQualifier) {
    deductions.push({ rule: "spf_no_all", points: -10, detail: "No all mechanism — SPF result is ambiguous" });
    issues.push({ severity: "warn", message: "No all mechanism — SPF result is ambiguous", deduction: -10 });
  }

  if (dnsLookupCount > 10) {
    deductions.push({ rule: "spf_too_many_lookups", points: -5, detail: `${dnsLookupCount} DNS-causing mechanisms exceed the 10-lookup limit (RFC 7208)` });
    issues.push({ severity: "warn", message: `${dnsLookupCount} DNS-causing mechanisms exceed the 10-lookup limit (RFC 7208)`, deduction: -5 });
  }

  if (ptrUsed) {
    deductions.push({ rule: "spf_ptr_used", points: -3, detail: "Deprecated ptr mechanism used" });
    issues.push({ severity: "warn", message: "Deprecated ptr mechanism used", deduction: -3 });
  }

  return {
    spf: {
      found: true,
      record,
      mechanisms,
      all_qualifier: allQualifier,
      dns_lookup_count: dnsLookupCount,
      issues,
    },
    deductions,
  };
}

// --- DKIM check ---

async function checkDkim(
  domain: string,
  selectors: string[],
): Promise<{ dkim: DkimResult; deductions: Deduction[] }> {
  const deductions: Deduction[] = [];
  const topIssues: Issue[] = [];

  const probes = await Promise.all(
    selectors.map(async (selector) => {
      const txtRecords = await resolveTxt(`${selector}._domainkey.${domain}`);
      if (txtRecords.length === 0) return null;

      const record = txtRecords[0];
      const tags = parseTags(record);

      const keyType = tags["k"] || "rsa";
      const publicKey = tags["p"] ?? "";
      const testingMode = tags["t"] === "y";

      // Revoked key: p= is empty string
      if (publicKey === "") {
        return { selector, record, key_type: keyType, key_length_bits: null as number | null, revoked: true, testing: testingMode };
      }

      // Key length: base64-decode p= value, byte length * 8
      let keyLengthBits: number | null = null;
      try {
        const decoded = Buffer.from(publicKey, "base64");
        keyLengthBits = decoded.length * 8;
      } catch {
        // Can't decode — leave as null
      }

      return { selector, record, key_type: keyType, key_length_bits: keyLengthBits, revoked: false, testing: testingMode };
    }),
  );

  const records: DkimRecord[] = [];
  let hasShortKey = false;
  let has1024Key = false;
  let hasTestingMode = false;
  let nonRevokedCount = 0;

  for (const probe of probes) {
    if (!probe) continue; // selector returned no TXT records — skip

    if (probe.revoked) {
      records.push({
        selector: probe.selector,
        record: probe.record,
        key_type: probe.key_type,
        key_length_bits: null,
        issues: [{ severity: "info", message: "Key revoked (empty p= tag)", deduction: 0 }],
      });
      continue;
    }

    nonRevokedCount++;
    const issues: Issue[] = [];

    if (probe.key_length_bits !== null) {
      if (probe.key_length_bits < 1024) {
        hasShortKey = true;
        issues.push({ severity: "fail", message: `Key length ${probe.key_length_bits} bits is below minimum 1024`, deduction: -15 });
      } else if (probe.key_length_bits < 2048) {
        has1024Key = true;
        issues.push({ severity: "warn", message: `Key length ${probe.key_length_bits} bits — 2048+ recommended`, deduction: -5 });
      }
    }

    if (probe.testing) {
      hasTestingMode = true;
      issues.push({ severity: "warn", message: "DKIM record in testing mode (t=y)", deduction: -5 });
    }

    records.push({
      selector: probe.selector,
      record: probe.record,
      key_type: probe.key_type,
      key_length_bits: probe.key_length_bits,
      issues,
    });
  }

  if (nonRevokedCount === 0) {
    deductions.push({ rule: "dkim_none_found", points: -20, detail: "No DKIM record found for any selector" });
    topIssues.push({ severity: "fail", message: "No DKIM record found for any selector", deduction: -20 });
  } else {
    if (hasShortKey) {
      deductions.push({ rule: "dkim_key_short", points: -15, detail: "DKIM key shorter than 1024 bits" });
    }
    if (has1024Key) {
      deductions.push({ rule: "dkim_key_1024", points: -5, detail: "DKIM key is 1024 bits — 2048+ recommended" });
    }
    if (hasTestingMode) {
      deductions.push({ rule: "dkim_testing_mode", points: -5, detail: "DKIM record in testing mode (t=y)" });
    }
  }

  return {
    dkim: {
      found: nonRevokedCount > 0,
      selectors_checked: selectors,
      records,
      issues: topIssues,
    },
    deductions,
  };
}

// --- DMARC check ---

function checkDmarc(txtRecords: string[]): { dmarc: DmarcResult; deductions: Deduction[] } {
  const dmarcRecords = txtRecords.filter((r) => r.startsWith("v=DMARC1"));
  const deductions: Deduction[] = [];
  const issues: Issue[] = [];

  if (dmarcRecords.length === 0) {
    deductions.push({ rule: "dmarc_missing", points: -25, detail: "No DMARC record found" });
    return {
      dmarc: {
        found: false,
        record: null,
        policy: null,
        subdomain_policy: null,
        pct: null,
        rua: [],
        ruf: [],
        issues: [{ severity: "fail", message: "No DMARC record found", deduction: -25 }],
      },
      deductions,
    };
  }

  const record = dmarcRecords[0];
  const tags = parseTags(record);

  const policy = tags["p"] || null;
  const subdomainPolicy = tags["sp"] || null;
  const pctRaw = tags["pct"];
  const pct = pctRaw !== undefined ? parseInt(pctRaw, 10) : 100;
  const rua = tags["rua"] ? tags["rua"].split(",").map((s) => s.trim()).filter(Boolean) : [];
  const ruf = tags["ruf"] ? tags["ruf"].split(",").map((s) => s.trim()).filter(Boolean) : [];

  if (policy === "none") {
    deductions.push({ rule: "dmarc_policy_none", points: -15, detail: "DMARC policy is none — no enforcement" });
    issues.push({ severity: "fail", message: "DMARC policy is none — no enforcement", deduction: -15 });
  } else if (policy === "quarantine") {
    deductions.push({ rule: "dmarc_policy_quarantine", points: -5, detail: "DMARC policy is quarantine — reject is stronger" });
    issues.push({ severity: "warn", message: "DMARC policy is quarantine — reject is stronger", deduction: -5 });
  }

  if (pct < 100) {
    deductions.push({ rule: "dmarc_pct_low", points: -5, detail: `DMARC pct=${pct} — not applied to all messages` });
    issues.push({ severity: "warn", message: `DMARC pct=${pct} — not applied to all messages`, deduction: -5 });
  }

  if (rua.length === 0) {
    deductions.push({ rule: "dmarc_no_rua", points: -5, detail: "No aggregate report URI (rua) configured" });
    issues.push({ severity: "warn", message: "No aggregate report URI (rua) configured", deduction: -5 });
  }

  if (ruf.length === 0) {
    deductions.push({ rule: "dmarc_no_ruf", points: -3, detail: "No forensic report URI (ruf) configured" });
    issues.push({ severity: "info", message: "No forensic report URI (ruf) configured", deduction: -3 });
  }

  if (policy && subdomainPolicy) {
    const pStrength = POLICY_STRENGTH[policy] || 0;
    const spStrength = POLICY_STRENGTH[subdomainPolicy] || 0;
    if (spStrength < pStrength) {
      deductions.push({ rule: "dmarc_sp_weaker", points: -3, detail: `Subdomain policy (${subdomainPolicy}) is weaker than domain policy (${policy})` });
      issues.push({ severity: "warn", message: `Subdomain policy (${subdomainPolicy}) is weaker than domain policy (${policy})`, deduction: -3 });
    }
  }

  return {
    dmarc: {
      found: true,
      record,
      policy,
      subdomain_policy: subdomainPolicy,
      pct,
      rua,
      ruf,
      issues,
    },
    deductions,
  };
}

// --- Route handler ---

export interface EmailAuthResult {
  domain: string;
  resolves: boolean;
  grade: string;
  score: number;
  spf: SpfResult;
  dkim: DkimResult;
  dmarc: DmarcResult;
  deductions: Deduction[];
}

/**
 * Core email-authentication logic, extracted so aggregators (e.g. email-report-full)
 * can reuse it directly. Performs the SSRF check, SPF/DKIM/DMARC probes, and scoring;
 * expects an already-validated domain. The route handler below calls this unchanged.
 */
export async function runEmailAuth(
  domain: string,
  selectors: string[] = DEFAULT_SELECTORS,
): Promise<EmailAuthResult> {
  // A non-resolving domain is a MEANINGFUL anti-spam/anti-phishing answer, not
  // an error — this endpoint only issues DNS lookups (it never connects to the
  // domain), so no SSRF connect-guard is needed. Probe mail infrastructure so we
  // can flag domains that cannot authenticate mail at all.
  const resolves = await domainHasMailInfra(domain);

  // 1. SPF — query TXT records for the domain
  const txtRecords = await resolveTxt(domain);
  const { spf, deductions: spfDeductions } = checkSpf(txtRecords);

  // 2. DKIM — probe all selectors concurrently
  const { dkim, deductions: dkimDeductions } = await checkDkim(domain, selectors);

  // 3. DMARC — query TXT records for _dmarc.{domain}
  const dmarcTxtRecords = await resolveTxt(`_dmarc.${domain}`);
  const { dmarc, deductions: dmarcDeductions } = checkDmarc(dmarcTxtRecords);

  // Combine deductions and calculate score
  const allDeductions = [...spfDeductions, ...dkimDeductions, ...dmarcDeductions];

  // No mail infrastructure AND no email-auth records at all → the domain does
  // not exist for email; surface it explicitly for fraud/anti-spoofing callers.
  if (!resolves && txtRecords.length === 0 && dmarcTxtRecords.length === 0) {
    allDeductions.unshift({
      rule: "no-mail-infrastructure",
      points: -100,
      detail:
        "Domain has no MX or A/AAAA record and publishes no SPF/DMARC — no mail infrastructure. Any email claiming to be from this domain cannot be authenticated and is almost certainly spoofed.",
    });
  }

  let score = 100;
  for (const d of allDeductions) {
    score += d.points;
  }
  score = Math.max(0, score);

  let grade: string;
  if (score >= 90) grade = "A";
  else if (score >= 75) grade = "B";
  else if (score >= 55) grade = "C";
  else if (score >= 30) grade = "D";
  else grade = "F";

  return {
    domain,
    resolves,
    grade,
    score,
    spf,
    dkim,
    dmarc,
    deductions: allDeductions,
  };
}

emailAuthRouter.post("/email-auth", async (req: Request, res: Response) => {
  try {
    const { domain: rawDomain, dkim_selectors: rawSelectors } = req.body || {};

    if (!rawDomain) {
      res.status(400).json({ error: 'domain is required — e.g. {"domain":"example.com"}' });
      return;
    }

    if (typeof rawDomain !== "string") {
      throw new ValidationError("domain must be a string");
    }

    const domain = validateDomain(rawDomain);

    // Validate dkim_selectors if provided
    let selectors: string[];
    if (rawSelectors !== undefined) {
      if (
        !Array.isArray(rawSelectors) ||
        rawSelectors.length === 0 ||
        !rawSelectors.every((s: unknown) => typeof s === "string")
      ) {
        throw new ValidationError("dkim_selectors must be a non-empty array of strings");
      }
      selectors = rawSelectors;
    } else {
      selectors = DEFAULT_SELECTORS;
    }

    res.json(await runEmailAuth(domain, selectors));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Email auth validation error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
