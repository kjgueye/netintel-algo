import { Router, type Request, type Response } from "express";
import { pickRequestParam } from "../utils/field-aliases.js";
import { validateDomain, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";
import { runEmailAuth, type EmailAuthResult } from "./email-auth.js";
import { runEmailIntel, type EmailIntelResult } from "./email-intel.js";
import { runBreachCheck, type BreachCheckResult } from "./breach-check.js";

export const emailReportFullRouter = Router();

// --- Types ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

// Contains @ and a dotted domain (mirrors email-intel's format check).
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/** Map a rejection reason to the standard failed-section error string. */
function errorOf(reason: unknown): "timeout" | "upstream_error" | "internal_error" {
  if (reason instanceof TimeoutError) return "timeout";
  if (reason instanceof Error) return "upstream_error";
  return "internal_error";
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

const handleEmailReportFull = async (req: Request, res: Response) => {
  try {
    const email = pickRequestParam(req, ["email", "address", "mail"]);
    if (!email) {
      res.status(400).json({ error: "email is required" });
      return;
    }

    if (!EMAIL_REGEX.test(email)) {
      res.status(400).json({ error: "email must be a valid email address (e.g. user@example.com)" });
      return;
    }

    // Domain part feeds the authentication section.
    const rawDomain = email.slice(email.indexOf("@") + 1);
    const domain = validateDomain(rawDomain);

    // The breach section only runs when the caller supplies a password to vet.
    // Optional password, same transport concern as /breach-check/password:
    // accept it in the BODY so it never has to appear in a URL.
    const rawPassword = pickRequestParam(req, ["password", "pass", "pwd"]);
    const password =
      typeof rawPassword === "string" && rawPassword.length > 0 ? rawPassword : null;

    // All requested sub-services run concurrently, each under its own per-sub-service
    // deadline. A slow or failing sub-service degrades to a failed section, never a 500.
    const timeout = timeouts.emailReportFull;
    const tasks: Promise<EmailAuthResult | EmailIntelResult | BreachCheckResult>[] = [
      withTimeout(runEmailAuth(domain), timeout),
      withTimeout(runEmailIntel(email), timeout),
    ];
    if (password) {
      tasks.push(withTimeout(runBreachCheck(password), timeout));
    }

    const settled = await Promise.allSettled(tasks);
    const authR = settled[0] as PromiseSettledResult<EmailAuthResult>;
    const intelR = settled[1] as PromiseSettledResult<EmailIntelResult>;
    const breachR = password
      ? (settled[2] as PromiseSettledResult<BreachCheckResult>)
      : null;

    const authOk = authR.status === "fulfilled";
    const intelOk = intelR.status === "fulfilled";
    const breachOk = breachR?.status === "fulfilled";

    // --- Authentication section ---
    const authData = authOk ? authR.value : null;
    const spfStr = authOk ? (authData!.spf.found ? "pass" : "missing") : null;
    const dkimStr = authOk ? (authData!.dkim.found ? "present" : "missing") : null;
    const dmarcStr = authOk
      ? authData!.dmarc.found
        ? `p=${authData!.dmarc.policy ?? "none"}`
        : "none"
      : null;
    const authentication = authOk
      ? { available: true, spf: spfStr, dkim: dkimStr, dmarc: dmarcStr }
      : { available: false, error: errorOf((authR as PromiseRejectedResult).reason) };

    // --- Intelligence section ---
    const intelData = intelOk ? intelR.value : null;
    const intelligence = intelOk
      ? {
          available: true,
          deliverability: intelData!.deliverability,
          is_disposable: intelData!.is_disposable,
          is_role_based: intelData!.is_role_based,
          is_free_provider: intelData!.is_free_provider,
        }
      : { available: false, error: errorOf((intelR as PromiseRejectedResult).reason) };

    // --- Breach section ---
    const breachData = breachOk ? breachR!.value : null;
    const breach = !password
      ? { available: false, error: "not_requested" }
      : breachOk
        ? {
            available: true,
            breached: breachData!.breached,
            breach_count: breachData!.breach_count,
            risk_level: breachData!.risk_level,
          }
        : { available: false, error: errorOf((breachR as PromiseRejectedResult).reason) };

    // Section counts. A not-requested breach is neither ok nor failed.
    const attempted: Array<[string, boolean, PromiseSettledResult<unknown>]> = [
      ["authentication", authOk, authR],
      ["intelligence", intelOk, intelR],
    ];
    if (password) attempted.push(["breach", !!breachOk, breachR!]);

    const sectionsOk = attempted.filter(([, ok]) => ok).length;
    const sectionsFailed = attempted.length - sectionsOk;

    // --- Scoring ---
    let score = 100;
    const findings: Finding[] = [];
    const deduct = (rule: string, amount: number, detail: string) => {
      findings.push({ rule, deduction: -amount, detail });
      score -= amount;
    };

    // Note every failed section (no content deduction — only a marker).
    for (const [name, ok, settledResult] of attempted) {
      if (!ok) {
        const err = errorOf((settledResult as PromiseRejectedResult).reason);
        findings.push({ rule: "section_failed", deduction: 0, detail: `${name}: ${err}` });
      }
    }

    // Authentication content deductions.
    const noDmarc = authOk && (dmarcStr === "none" || dmarcStr === "p=none");
    const noSpf = authOk && spfStr === "missing";
    if (noDmarc) deduct("no_dmarc", 15, "DMARC missing or set to none — no enforcement");
    if (noSpf) deduct("no_spf", 15, "SPF missing or failing");

    // Intelligence content deductions.
    if (intelOk && intelData!.is_disposable) {
      deduct("is_disposable", 40, "Email uses a disposable/temporary domain");
    }
    if (intelOk && intelData!.is_role_based) {
      deduct("is_role_based", 15, "Email is a role-based address (e.g. info@, support@)");
    }
    const undeliverable = intelOk && intelData!.deliverability === "undeliverable";
    if (undeliverable) deduct("undeliverable", 30, "Email address is undeliverable (no MX records)");

    // Breach content deduction (only when the section ran).
    const breachedPassword = breachOk && breachData!.breached;
    if (breachedPassword) {
      deduct("breached_password", 40, "Supplied password appears in known data breaches");
    }

    score = Math.max(0, score);

    // --- Trust verdict (synthesized) ---
    const weakAuth = noDmarc || noSpf;
    const disposableOrRole =
      intelOk && (intelData!.is_disposable || intelData!.is_role_based);

    let trust_verdict: "trusted" | "risky" | "untrusted";
    if (undeliverable || breachedPassword) {
      trust_verdict = "untrusted";
    } else if (disposableOrRole || weakAuth) {
      trust_verdict = "risky";
    } else {
      trust_verdict = "trusted";
    }

    res.json({
      email,
      domain,
      generated_at: new Date().toISOString(),
      sections: {
        authentication,
        intelligence,
        breach,
      },
      sections_ok: sectionsOk,
      sections_failed: sectionsFailed,
      trust_verdict,
      score,
      grade: calculateGrade(score),
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("email-report-full error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
};

emailReportFullRouter.get("/email-report/full", handleEmailReportFull);
emailReportFullRouter.post("/email-report/full", handleEmailReportFull);
