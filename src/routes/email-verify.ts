import { Router, type Request, type Response } from "express";
import { pickRequestParam } from "../utils/field-aliases.js";
import { runEmailIntel, type EmailIntelResult } from "./email-intel.js";

export const emailVerifyRouter = Router();

// Thin boolean-first presentation of email-intel's existing deliverability
// logic, under the name/price agents actually search for ("email verify",
// $0.001 — see EXA-SEARCH-HANDOFF.md spec 24). Zero new heuristics: every
// field below is derived from runEmailIntel()'s output so this endpoint and
// /email-intel/analyze can never disagree.

const EMAIL_ALIASES = ["email", "address", "email_address", "emailAddress", "e", "q", "to"];

const INSTRUCTIVE_400 =
  'email is required — pass an email address via ?email=user@example.com (GET) or a JSON body ' +
  '{"email":"user@example.com"} (POST). Also accepted: address, email_address, emailAddress, e, q, to.';

type VerifyResult = "deliverable" | "risky" | "undeliverable";
type VerifyReason = "invalid_format" | "null_mx" | "no_mx_records" | "disposable_domain" | "role_account" | "ok";

/**
 * Deterministic translation from EmailIntelResult to the yes/no shape this
 * endpoint sells. Order matters: undeliverable (format/MX) beats risky
 * (disposable/role), which beats a clean "ok" — the same precedence as the
 * `reason` enum in the spec.
 */
function mapVerdict(intel: EmailIntelResult): { result: VerifyResult; reason: VerifyReason; riskFlags: string[] } {
  const riskFlags: string[] = [];
  if (intel.is_disposable) riskFlags.push("disposable");
  if (intel.is_role_based) riskFlags.push("role_based");
  if (intel.is_free_provider) riskFlags.push("free_provider");

  if (!intel.format_valid) {
    return { result: "undeliverable", reason: "invalid_format", riskFlags };
  }
  if (!intel.mx_records_found) {
    const isNullMx = intel.findings.some((f) => f.rule === "null_mx");
    return { result: "undeliverable", reason: isNullMx ? "null_mx" : "no_mx_records", riskFlags };
  }
  if (intel.is_disposable) {
    return { result: "risky", reason: "disposable_domain", riskFlags };
  }
  if (intel.is_role_based) {
    return { result: "risky", reason: "role_account", riskFlags };
  }
  return { result: "deliverable", reason: "ok", riskFlags };
}

async function handleEmailVerify(req: Request, res: Response): Promise<void> {
  try {
    const rawEmail = pickRequestParam(req, EMAIL_ALIASES);
    if (!rawEmail) {
      res.status(400).json({ error: INSTRUCTIVE_400 });
      return;
    }
    if (rawEmail.length < 3 || rawEmail.length > 320) {
      res.status(400).json({
        error: `email must be 3-320 characters (received ${rawEmail.length} characters). Also accepted: address, email_address, emailAddress, e, q, to.`,
      });
      return;
    }

    let intel: EmailIntelResult;
    try {
      intel = await runEmailIntel(rawEmail);
    } catch (err) {
      console.error("Email verify upstream error:", err);
      res.status(502).json({ error: "email verification temporarily unavailable" });
      return;
    }

    const { result, reason, riskFlags } = mapVerdict(intel);

    res.json({
      email: intel.email,
      deliverable: result !== "undeliverable",
      safe_to_send: result === "deliverable",
      result,
      reason,
      risk_flags: riskFlags,
      domain: intel.domain,
      format_valid: intel.format_valid,
      mx_found: intel.mx_records_found,
      mx_records: intel.mx_records.slice(0, 5),
      disposable: intel.is_disposable,
      role_based: intel.is_role_based,
      free_provider: intel.is_free_provider,
      smtp_checked: false,
    });
  } catch (err) {
    console.error("Email verify error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET (?email=) is canonical; POST carries {"email": …} in the body for
// agents that send one. Both share one handler and paired paid route entries
// (index.ts) — same dual-method pattern as web/fetch.
emailVerifyRouter.get("/email/verify", handleEmailVerify);
emailVerifyRouter.post("/email/verify", handleEmailVerify);
