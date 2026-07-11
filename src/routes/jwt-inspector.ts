import { Router, type Request, type Response } from "express";

export const jwtInspectorRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  label: string;
  impact: number;
  detail: string;
}

// --- Helpers ---

const STANDARD_CLAIMS = new Set(["iss", "sub", "aud", "exp", "iat", "nbf", "jti"]);

function base64urlDecode(segment: string): string {
  let base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64").toString("utf8");
}

function base64urlToHex(segment: string): string {
  let base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64").toString("hex");
}

function humanExpiry(secondsUntil: number): string {
  const abs = Math.abs(secondsUntil);
  const prefix = secondsUntil < 0 ? "expired " : "expires in ";
  const suffix = secondsUntil < 0 ? " ago" : "";

  if (abs < 60) return `${prefix}${abs} seconds${suffix}`;
  if (abs < 3600) {
    const mins = Math.floor(abs / 60);
    return `${prefix}${mins} ${mins === 1 ? "minute" : "minutes"}${suffix}`;
  }
  if (abs < 86400) {
    const hrs = Math.floor(abs / 3600);
    return `${prefix}${hrs} ${hrs === 1 ? "hour" : "hours"}${suffix}`;
  }
  const days = Math.floor(abs / 86400);
  return `${prefix}${days} ${days === 1 ? "day" : "days"}${suffix}`;
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

jwtInspectorRouter.get("/jwt-inspector/decode", (req: Request, res: Response) => {
  try {
    const raw = req.query.token as string | undefined;

    if (!raw || raw.trim() === "") {
      // Production data: 11 paid empty probes on this endpoint, ZERO later
      // conversions — the bare "token is required" taught agents nothing.
      res.status(400).json({
        code: "MISSING_FIELD",
        error:
          "token is required — pass the JWT as a query param, e.g. " +
          '?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig (a "Bearer " prefix is tolerated).',
      });
      return;
    }

    // Leniency: agents commonly send the token straight from an Authorization
    // header — with a "Bearer " prefix and/or surrounding whitespace. Strip both
    // so a copy-paste doesn't cost a failed, head-scratching call.
    const token = raw.trim().replace(/^Bearer\s+/i, "").trim();

    const segments = token.split(".");
    if (segments.length !== 3) {
      // A 5-segment token is a JWE (encrypted), not a malformed JWS. This endpoint
      // decodes signed JWS tokens only, so name it explicitly — otherwise the
      // agent retries the same encrypted token expecting it to decode.
      if (segments.length === 5) {
        res.status(400).json({
          code: "UNSUPPORTED_TOKEN",
          error:
            "Token has 5 segments — this looks like an encrypted JWE, which this endpoint cannot decode. " +
            "It decodes signed JWS tokens (header.payload.signature) only.",
        });
        return;
      }
      res.status(400).json({
        code: "VALIDATION_ERROR",
        error: `Invalid JWT structure: must have 3 segments (header.payload.signature), got ${segments.length}`,
      });
      return;
    }

    // Decode header
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(base64urlDecode(segments[0]));
    } catch {
      res.status(400).json({ code: "VALIDATION_ERROR", error: "Invalid JWT: could not parse header" });
      return;
    }

    // Decode payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(base64urlDecode(segments[1]));
    } catch {
      res.status(400).json({ code: "VALIDATION_ERROR", error: "Invalid JWT: could not parse payload" });
      return;
    }

    // Signature as hex
    const signatureHex = base64urlToHex(segments[2]);
    const signaturePresent = segments[2].length > 0;

    // Extract standard claims
    const iss = payload.iss as string | undefined ?? null;
    const sub = payload.sub as string | undefined ?? null;
    const aud = payload.aud ?? null;
    const exp = typeof payload.exp === "number" ? payload.exp : null;
    const iat = typeof payload.iat === "number" ? payload.iat : null;
    const nbf = typeof payload.nbf === "number" ? payload.nbf : null;
    const jti = payload.jti as string | undefined ?? null;

    // Custom claims
    const customClaims: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (!STANDARD_CLAIMS.has(key)) {
        customClaims[key] = value;
      }
    }

    // Timing
    const now = Math.floor(Date.now() / 1000);
    const isExpired = exp !== null ? exp < now : null;
    const secondsUntilExpiry = exp !== null ? exp - now : null;

    // Security flags & grading
    let score = 100;
    const findings: Finding[] = [];
    const securityFlags: string[] = [];

    const alg = typeof header.alg === "string" ? header.alg : "";

    if (alg.toLowerCase() === "none") {
      securityFlags.push("alg_none");
      findings.push({ rule: "alg_none", label: "Algorithm is 'none'", impact: -60, detail: "JWT uses 'none' algorithm — signature is not verified, critical security issue" });
      score -= 60;
    }

    if (["HS1", "RS1"].includes(alg)) {
      securityFlags.push("weak_algorithm");
      findings.push({ rule: "weak_algorithm", label: "Weak algorithm", impact: -20, detail: `JWT uses weak algorithm: ${alg}` });
      score -= 20;
    }

    if (exp === null) {
      securityFlags.push("no_expiry");
      findings.push({ rule: "no_expiry_claim", label: "No expiry claim", impact: -20, detail: "JWT has no exp claim — token never expires" });
      score -= 20;
    } else if (isExpired) {
      findings.push({ rule: "is_expired", label: "Token is expired", impact: -40, detail: `Token expired ${humanExpiry(secondsUntilExpiry!)}` });
      score -= 40;
    }

    if (exp !== null && exp > now + 365 * 24 * 3600) {
      securityFlags.push("expiry_too_far");
      findings.push({ rule: "expiry_too_far", label: "Expiry too far in future", impact: -15, detail: "Token expires more than 1 year from now" });
      score -= 15;
    }

    if (iat === null) {
      securityFlags.push("no_issued_at");
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    res.json({
      valid_structure: true,
      header: {
        algorithm: alg || null,
        token_type: (header.typ as string) || null,
        key_id: (header.kid as string) ?? null,
      },
      payload: {
        issuer: iss,
        subject: sub,
        audience: aud,
        expires_at: exp !== null ? new Date(exp * 1000).toISOString() : null,
        expires_at_unix: exp,
        issued_at: iat !== null ? new Date(iat * 1000).toISOString() : null,
        issued_at_unix: iat,
        not_before: nbf !== null ? new Date(nbf * 1000).toISOString() : null,
        jwt_id: jti,
        custom_claims: customClaims,
      },
      is_expired: isExpired,
      seconds_until_expiry: secondsUntilExpiry,
      human_expiry: secondsUntilExpiry !== null ? humanExpiry(secondsUntilExpiry) : null,
      signature_hex: signatureHex,
      signature_present: signaturePresent,
      security_flags: securityFlags,
      score,
      grade,
      findings,
    });
  } catch (err) {
    console.error("JWT inspector error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
