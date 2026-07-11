import { Router, type Request, type Response } from "express";
import { validateDomain, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";
import { runDomainAvailability, type AvailabilityResult } from "./domain-availability.js";
import { runDomainAppraise } from "./domain-appraise.js";
import { runTldPrice } from "./tld-price.js";

export const domainDueDiligenceRouter = Router();

// --- Types ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

interface AppraiseResult {
  value_tier: string;
  value_score: number;
}

interface TldPriceResult {
  cheapest: { domain: string; register: number };
  cheapest_premium: { domain: string; register: number } | null;
}

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
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    deadline,
  ]);
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

/** Map a rejection reason to the failed-section error string. */
function errorOf(reason: unknown): string {
  return reason instanceof TimeoutError ? "timeout" : "error";
}

// --- Route handler ---

domainDueDiligenceRouter.get("/domain-due-diligence", async (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string | undefined;
    if (!rawDomain) {
      res.status(400).json({ error: "domain is required" });
      return;
    }

    // Must include a TLD (e.g. acme.com) — validateDomain rejects bare names.
    const domain = validateDomain(rawDomain);
    const lastDot = domain.lastIndexOf(".");
    const name = domain.slice(0, lastDot);
    const tld = domain.slice(lastDot + 1);

    // All three sub-services run concurrently, each under its own 5s deadline.
    // A slow or failing sub-service degrades to a failed section, never a 500.
    const timeout = timeouts.domainDueDiligence;
    const [availR, apprR, tldR] = await Promise.allSettled([
      withTimeout(runDomainAvailability(domain), timeout),
      withTimeout(Promise.resolve().then(() => runDomainAppraise(domain)), timeout),
      withTimeout(Promise.resolve().then(() => runTldPrice({ name })), timeout),
    ]);

    const availOk = availR.status === "fulfilled";
    const availData: AvailabilityResult | null = availOk ? availR.value : null;
    const apprOk = apprR.status === "fulfilled";
    const apprData: AppraiseResult | null = apprOk ? apprR.value : null;
    const tldOk = tldR.status === "fulfilled";
    // Always Mode B here (we pass { name }), so the result carries cheapest/cheapest_premium.
    const tldData: TldPriceResult | null = tldOk
      ? (tldR.value as unknown as TldPriceResult)
      : null;

    // --- Sections (standard partial-failure shape) ---
    const availability = availOk
      ? {
          available: true,
          is_available: availData!.is_available,
          status: availData!.status,
          registrar: availData!.registrar,
          expires_at: availData!.expires_at,
        }
      : { available: false, error: errorOf((availR as PromiseRejectedResult).reason) };

    const appraisal = apprOk
      ? {
          available: true,
          value_tier: apprData!.value_tier,
          value_score: apprData!.value_score,
        }
      : { available: false, error: errorOf((apprR as PromiseRejectedResult).reason) };

    const tld_pricing = tldOk
      ? {
          available: true,
          cheapest: tldData!.cheapest,
          cheapest_premium: tldData!.cheapest_premium,
        }
      : { available: false, error: errorOf((tldR as PromiseRejectedResult).reason) };

    const sectionsOk = [availOk, apprOk, tldOk].filter(Boolean).length;
    const sectionsFailed = 3 - sectionsOk;

    // --- Synthesized verdict ---
    const strongOrPremium =
      apprOk && (apprData!.value_tier === "strong" || apprData!.value_tier === "premium");

    let verdict: string;
    if (!availOk) {
      verdict = "unknown";
    } else if (availData!.is_available) {
      verdict = strongOrPremium ? "available_strong" : "available_weak";
    } else {
      verdict = strongOrPremium ? "taken_premium" : "taken_low";
    }

    // --- Acquisition-opportunity scoring ---
    let score = 100;
    const findings: Finding[] = [];
    const deduct = (rule: string, amount: number, detail: string) => {
      findings.push({ rule, deduction: -amount, detail });
      score -= amount;
    };

    if (!availOk) {
      deduct("availability_unknown", 15, "Availability section failed");
    } else if (!availData!.is_available) {
      deduct("not_available", 20, `${domain} is already registered`);
    }

    if (apprOk) {
      if (apprData!.value_tier === "low") {
        deduct("low_value", 25, "Appraisal value tier is low");
      } else if (apprData!.value_tier === "moderate") {
        deduct("moderate_value", 10, "Appraisal value tier is moderate");
      }
    }

    if (tldOk && tldData!.cheapest && tldData!.cheapest.register > 20) {
      deduct(
        "no_cheap_option",
        10,
        `Cheapest registration ($${tldData!.cheapest.register}) exceeds $20`,
      );
    }

    score = Math.max(0, score);

    res.json({
      domain,
      name,
      tld,
      generated_at: new Date().toISOString(),
      sections: {
        availability,
        appraisal,
        tld_pricing,
      },
      sections_ok: sectionsOk,
      sections_failed: sectionsFailed,
      verdict,
      score,
      grade: calculateGrade(score),
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("domain-due-diligence error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
