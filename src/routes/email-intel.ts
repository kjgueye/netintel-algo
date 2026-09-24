import { Router, type Request, type Response } from "express";
import { assessMx } from "../utils/dns-resolvers.js";

export const emailIntelRouter = Router();

// --- Disposable domain list ---

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "tempmail.com", "throwam.com",
  "yopmail.com", "trashmail.com", "sharklasers.com", "guerrillamailblock.com",
  "grr.la", "guerrillamail.info", "guerrillamail.biz", "guerrillamail.de",
  "guerrillamail.net", "guerrillamail.org", "spam4.me", "maildrop.cc",
  "dispostable.com", "fakeinbox.com", "mailnull.com", "spamgourmet.com",
  "trashmail.at", "trashmail.io", "trashmail.me", "discard.email",
  "temp-mail.org", "tempail.com", "tempr.email", "getairmail.com",
  "filzmail.com", "spamherelots.com", "binkmail.com", "mailnew.com",
  "cool.fr.nf", "jetable.fr.nf", "nospam.ze.tc", "nomail.xl.cx",
  "mega.zik.dj", "speed.1s.fr", "courriel.fr.nf", "moncourrier.fr.nf",
  "monemail.fr.nf", "monmail.fr.nf", "nowmymail.com", "spamfree24.org",
  "spamgob.com", "spamhole.com", "spamify.com", "spamthisplease.com",
  "stuffmail.de", "supergreatmail.com", "suremail.info", "tempalias.com",
  "tempe-mail.com", "tempinbox.co.uk", "tempinbox.com", "tempymail.com",
  "thanksnospam.info", "thisisnotmyrealemail.com", "tilien.com",
  "tmailinator.com", "tradermail.info", "trash-mail.com", "trayna.com",
  "trbvm.com", "trsh.me",
]);

// --- Free consumer domain list ---

const FREE_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com",
  "msn.com", "aol.com", "icloud.com", "me.com", "mac.com",
  "protonmail.com", "proton.me", "tutanota.com", "zoho.com",
  "yandex.com", "yandex.ru", "mail.com", "gmx.com", "gmx.net",
  "fastmail.com",
]);

// --- Role-based prefixes ---

const ROLE_PREFIXES = new Set([
  "admin", "administrator", "info", "contact", "support", "help",
  "sales", "marketing", "billing", "accounts", "accounting", "finance",
  "hr", "jobs", "careers", "press", "media", "news", "legal", "privacy",
  "security", "abuse", "postmaster", "webmaster", "hostmaster",
  "noreply", "no-reply", "donotreply", "do-not-reply", "bounce",
  "bounces", "mailer-daemon", "newsletter", "notifications", "alerts",
  "team", "office",
]);

// --- Helpers ---

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

export interface EmailIntelResult {
  email: string;
  domain: string;
  local_part: string;
  format_valid: boolean;
  mx_records_found: boolean;
  mx_records: string[];
  is_disposable: boolean;
  is_role_based: boolean;
  is_free_provider: boolean;
  is_business_email: boolean;
  deliverability: string;
  score: number;
  grade: string;
  findings: EmailIntelFinding[];
}

// Same {rule, deduction, detail} shape every other endpoint uses — email-intel
// was the one route emitting findings as bare strings (2026-07-30 sweep audit).
export interface EmailIntelFinding {
  rule: string;
  deduction: number;
  detail: string;
}

/**
 * Core email-intelligence logic, extracted so aggregators (e.g. email-report-full)
 * can reuse it directly. Operates on the full email address (format check, MX lookup,
 * disposable/role/free detection, deliverability + scoring). The route handler below
 * calls this unchanged.
 */
export async function runEmailIntel(email: string): Promise<EmailIntelResult> {
  const formatValid = EMAIL_REGEX.test(email);
  const atIndex = email.indexOf("@");
  const localPart = atIndex !== -1 ? email.slice(0, atIndex).toLowerCase() : email.toLowerCase();
  const domain = atIndex !== -1 ? email.slice(atIndex + 1).toLowerCase() : "";

  let score = 100;
  const findings: EmailIntelFinding[] = [];

  // Format check
  if (!formatValid) {
    score -= 60;
    findings.push({
      rule: "invalid_format",
      deduction: -60,
      detail: "Address does not match a valid email format",
    });
  }

  // MX lookup. assessMx filters an RFC 7505 null MX (MX 0 ".") — an explicit
  // "this domain accepts no mail" — so it is NOT counted as a deliverable MX.
  // (Before this, a null MX like example.com's graded "deliverable A/100".)
  let mxRecordsFound = false;
  let mxRecords: string[] = [];
  let nullMx = false;

  if (formatValid && domain) {
    const mx = await assessMx(domain);
    mxRecords = mx.deliverableHosts;
    mxRecordsFound = mx.deliverableHosts.length > 0;
    nullMx = mx.nullMx;
  }

  if (formatValid && !mxRecordsFound) {
    score -= 40;
    // Distinguish an explicit null MX from a plain absence — both are
    // undeliverable, but a null MX means the domain deliberately rejects mail.
    findings.push(
      nullMx
        ? {
            rule: "null_mx",
            deduction: -40,
            detail: "Domain publishes an RFC 7505 null MX — it deliberately accepts no mail",
          }
        : {
            rule: "no_mx_records",
            deduction: -40,
            detail: "No MX records found — mail cannot be delivered to this domain",
          }
    );
  }

  // Disposable check
  const isDisposable = DISPOSABLE_DOMAINS.has(domain);
  if (isDisposable) {
    score -= 50;
    findings.push({
      rule: "is_disposable",
      deduction: -50,
      detail: "Domain is a known disposable/temporary email provider",
    });
  }

  // Role-based check
  const isRoleBased = ROLE_PREFIXES.has(localPart);
  if (isRoleBased) {
    score -= 20;
    findings.push({
      rule: "is_role_based",
      deduction: -20,
      detail: "Local part is a role address (info@, admin@, …), not a person",
    });
  }

  // Free provider check
  const isFreeProvider = FREE_DOMAINS.has(domain);
  if (isFreeProvider) {
    score -= 10;
    findings.push({
      rule: "is_free_provider",
      deduction: -10,
      detail: "Domain is a free consumer email provider",
    });
  }

  // A working business address must also be able to RECEIVE mail — the old
  // check called undeliverable test@example.org a business email (2026-07-30
  // sweep audit).
  const isBusinessEmail = formatValid && mxRecordsFound && !isFreeProvider && !isDisposable;

  // Score floor
  score = Math.max(0, score);

  // Deliverability
  let deliverability: string;
  if (!formatValid) {
    deliverability = "invalid";
  } else if (!mxRecordsFound) {
    deliverability = "undeliverable";
  } else if (isFreeProvider || isRoleBased) {
    deliverability = "risky";
  } else {
    deliverability = "deliverable";
  }

  const grade = calculateGrade(score);

  return {
    email,
    domain,
    local_part: localPart,
    format_valid: formatValid,
    mx_records_found: mxRecordsFound,
    mx_records: mxRecords,
    is_disposable: isDisposable,
    is_role_based: isRoleBased,
    is_free_provider: isFreeProvider,
    is_business_email: isBusinessEmail,
    deliverability,
    score,
    grade,
    findings,
  };
}

emailIntelRouter.get("/email-intel/analyze", async (req: Request, res: Response) => {
  try {
    const email = req.query.email as string | undefined;

    if (!email) {
      res.status(400).json({ error: "email is required" });
      return;
    }

    res.json(await runEmailIntel(email));
  } catch (err) {
    console.error("Email intel error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
