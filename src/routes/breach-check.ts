import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { timeouts } from "../config.js";

export const breachCheckRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

// --- Helpers ---

function getRiskLevel(count: number): string {
  if (count === 0) return "safe";
  if (count <= 10) return "low";
  if (count <= 100) return "medium";
  if (count <= 1000) return "high";
  return "critical";
}

function getDeduction(count: number): { rule: string; deduction: number } | null {
  if (count > 1000) return { rule: "critical_breach", deduction: -100 };
  if (count >= 101) return { rule: "high_breach", deduction: -80 };
  if (count >= 11) return { rule: "medium_breach", deduction: -50 };
  if (count >= 1) return { rule: "low_breach", deduction: -20 };
  return null;
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

export interface BreachCheckResult {
  breached: boolean;
  breach_count: number;
  risk_level: string;
  score: number;
  grade: string;
  findings: Finding[];
}

/**
 * Thrown when the upstream HIBP API is unreachable or returns a non-OK status.
 * The route maps this to a 502; aggregators (e.g. email-report-full) can catch it
 * to degrade the breach section gracefully. The message never contains the password.
 */
export class BreachUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BreachUpstreamError";
  }
}

/**
 * Core password breach-check logic, extracted so aggregators can reuse it directly.
 * Queries HIBP Pwned Passwords with k-anonymity (only the 5-char SHA-1 prefix is sent).
 * Throws BreachUpstreamError if the upstream call fails. Expects a non-empty password.
 * The route handler below calls this unchanged.
 */
export async function runBreachCheck(password: string): Promise<BreachCheckResult> {
  // Compute SHA-1 hash
  const sha1 = crypto.createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = sha1.substring(0, 5);
  const suffix = sha1.substring(5);

  // Query HIBP Pwned Passwords API with k-anonymity
  let responseText: string;
  try {
    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: {
        "Add-Padding": "true",
        "User-Agent": "NetIntel/1.0",
      },
      signal: AbortSignal.timeout(timeouts.breachCheck),
    });

    if (!response.ok) {
      throw new Error(`HIBP API returned ${response.status}`);
    }

    responseText = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BreachUpstreamError(`Breach check failed: ${message}`);
  }

  // Parse response lines and find matching suffix
  let breachCount = 0;
  const lines = responseText.split("\n");
  for (const line of lines) {
    const [hashSuffix, countStr] = line.trim().split(":");
    if (hashSuffix && hashSuffix.toUpperCase() === suffix) {
      breachCount = parseInt(countStr, 10) || 0;
      break;
    }
  }

  const breached = breachCount > 0;
  const riskLevel = getRiskLevel(breachCount);

  let score = 100;
  const findings: Finding[] = [];

  const ded = getDeduction(breachCount);
  if (ded) {
    score = Math.max(0, score + ded.deduction);
    findings.push({
      rule: ded.rule,
      deduction: ded.deduction,
      detail: `Password found ${breachCount} times in known data breaches`,
    });
  }

  const grade = calculateGrade(score);

  return {
    breached,
    breach_count: breachCount,
    risk_level: riskLevel,
    score,
    grade,
    findings,
  };
}

breachCheckRouter.get("/breach-check/password", async (req: Request, res: Response) => {
  try {
    const password = req.query.password as string | undefined;

    if (!password || password.length === 0) {
      res.status(400).json({ error: "password is required" });
      return;
    }

    if (password.length > 500) {
      res.status(400).json({ error: "password must be 1-500 characters" });
      return;
    }

    res.json(await runBreachCheck(password));
  } catch (err) {
    if (err instanceof BreachUpstreamError) {
      res.status(502).json({ error: err.message });
      return;
    }
    console.error("Breach check error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
