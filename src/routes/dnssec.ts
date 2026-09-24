import { Router, type Request, type Response } from "express";
import { dohQuery, type DnsAnswer, type DohResult } from "../utils/dns-resolvers.js";
import { validateDomain, ValidationError } from "../utils/validators.js";

// DNSSEC record types come over DoH (dohQuery), NOT dns2/UDP: dns2 never sets
// the EDNS DO flag, so DS returned empty and DNSKEY truncated — every signed
// domain graded F (2026-07-18 sweep; example.com ground truth: signed).
// NSEC3 zones are detected via NSEC3PARAM at the apex (NSEC3 owner names are
// hashed, so querying NSEC3 directly at the apex finds nothing by design).

export const dnssecRouter = Router();

const ALGORITHM_MAP: Record<number, string> = {
  5: "RSASHA1",
  7: "RSASHA1-NSEC3-SHA1",
  8: "RSASHA256",
  10: "RSASHA512",
  13: "ECDSAP256SHA256",
  14: "ECDSAP384SHA384",
  15: "ED25519",
};

function extractAlgorithms(answers: DnsAnswer[]): string[] | undefined {
  const algos: string[] = [];
  for (const a of answers) {
    const raw = a.data ?? "";
    // DS record format: key_tag algorithm digest_type digest
    // DNSKEY record format: flags protocol algorithm key
    // Algorithm is the 2nd number for DS, 3rd for DNSKEY
    const nums = raw.match(/\b(\d+)\b/g);
    if (nums) {
      for (const n of nums) {
        const num = parseInt(n, 10);
        if (ALGORITHM_MAP[num]) {
          algos.push(ALGORITHM_MAP[num]);
          break; // take first matching algorithm per record
        }
      }
    }
  }
  return algos.length > 0 ? [...new Set(algos)] : undefined;
}

function extractKeyTypes(answers: DnsAnswer[]): string[] {
  const types: string[] = [];
  for (const a of answers) {
    const raw = a.data ?? "";
    // DNSKEY flag is typically the first number: 256=ZSK, 257=KSK
    const match = raw.match(/^(\d+)\s/);
    if (match) {
      const flag = parseInt(match[1], 10);
      if (flag === 257) types.push("KSK");
      else if (flag === 256) types.push("ZSK");
    }
  }
  return types.length > 0 ? types : [];
}

function assignGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

dnssecRouter.get("/dnssec/validate", async (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string | undefined;
    if (!rawDomain) {
      res.status(400).json({ error: "domain is required" });
      return;
    }

    const domain = validateDomain(rawDomain);

    // Extract TLD for root trust anchor check
    const parts = domain.split(".");
    const tld = parts[parts.length - 1];

    // Run all DNS queries concurrently (dohQuery never rejects — failures
    // collapse to empty answers).
    const empty: DohResult = { answers: [], ad: false, rrsigCount: 0 };
    const [dsResult, dnskeyResult, rrsigResult, nsecResult, nsec3ParamResult, tldDsResult] =
      (await Promise.allSettled([
        dohQuery(domain, "DS"),
        dohQuery(domain, "DNSKEY"),
        dohQuery(domain, "RRSIG"),
        dohQuery(domain, "NSEC"),
        dohQuery(domain, "NSEC3PARAM"),
        dohQuery(tld, "DS"),
      ])).map((r) => (r.status === "fulfilled" ? r.value : empty));

    const dsAnswers = dsResult.answers;
    const dnskeyAnswers = dnskeyResult.answers;
    // Some resolvers refuse a direct RRSIG qtype — the do=1 flag also makes
    // signatures ride along with the other answers, so count both sources.
    const rideAlongRrsigs = Math.max(dsResult.rrsigCount, dnskeyResult.rrsigCount, nsecResult.rrsigCount);
    const rrsigCount = Math.max(rrsigResult.answers.length, rideAlongRrsigs);
    const nsecAnswers = nsecResult.answers;
    const nsec3ParamAnswers = nsec3ParamResult.answers;
    const tldDsAnswers = tldDsResult.answers;

    // The validating resolver's AD bit: authoritative proof the chain verifies.
    const resolverValidated = dsResult.ad || dnskeyResult.ad || rrsigResult.ad;

    const dsPresent = dsAnswers.length > 0;
    const dnskeyPresent = dnskeyAnswers.length > 0;
    const rrsigPresent = rrsigCount > 0;
    const nsecPresent = nsecAnswers.length > 0;
    const nsec3Present = nsec3ParamAnswers.length > 0;
    const tldDsPresent = tldDsAnswers.length > 0;

    // Chain of trust assessment
    let chainOfTrust: "complete" | "partial" | "none" | "broken";
    if (dsPresent && dnskeyPresent && rrsigPresent) {
      chainOfTrust = "complete";
    } else if (dsPresent && !dnskeyPresent) {
      chainOfTrust = "broken";
    } else if (dnskeyPresent || rrsigPresent || dsPresent) {
      chainOfTrust = "partial";
    } else {
      chainOfTrust = "none";
    }

    const dnssecEnabled = (dnskeyPresent && rrsigPresent) || resolverValidated;

    // Build components
    const dsAlgorithms = extractAlgorithms(dsAnswers);
    const dsRecord: Record<string, unknown> = {
      present: dsPresent,
      count: dsAnswers.length,
    };
    if (dsAlgorithms) dsRecord.algorithms = dsAlgorithms;

    const keyTypes = extractKeyTypes(dnskeyAnswers);
    const dnskeyRecord: Record<string, unknown> = {
      present: dnskeyPresent,
      count: dnskeyAnswers.length,
    };
    if (keyTypes.length > 0) dnskeyRecord.key_types = keyTypes;

    const rrsigRecord = {
      present: rrsigPresent,
      signatures_found: rrsigCount,
    };

    let nsecType: string | null = null;
    if (nsec3Present) nsecType = "NSEC3";
    else if (nsecPresent) nsecType = "NSEC";

    const nsecOrNsec3 = {
      present: nsecPresent || nsec3Present,
      type: nsecType,
    };

    // Scoring
    let score = 100;
    const findings: { rule: string; deduction: number; detail: string }[] = [];

    if (dsPresent && !dnskeyPresent) {
      // Broken chain is the worst case — DS at parent but no key at domain
      score -= 30;
      findings.push({ rule: "broken_chain", deduction: -30, detail: "DS present but DNSKEY missing — actively broken chain" });
    }

    if (!dnskeyPresent && !rrsigPresent && !dsPresent) {
      if (resolverValidated) {
        // The validating resolver proved the chain (AD bit) but our record
        // fetches came back empty — degraded visibility, NOT "no DNSSEC".
        score -= 10;
        findings.push({ rule: "records_unavailable", deduction: -10, detail: "Resolver validated the chain (AD bit set) but DNSSEC records could not be fetched — partial visibility" });
      } else {
        // No DNSSEC at all
        score -= 60;
        findings.push({ rule: "no_dnssec", deduction: -60, detail: "No DNSKEY and no RRSIG — DNSSEC not configured" });
      }
    }

    if (dnskeyPresent && !dsPresent) {
      score -= 25;
      findings.push({ rule: "ds_missing", deduction: -25, detail: "DNSKEY present but DS missing at parent — chain broken at parent" });
    }

    if (dnskeyPresent && !rrsigPresent) {
      score -= 25;
      findings.push({ rule: "rrsig_missing", deduction: -25, detail: "DNSKEY present but RRSIG missing — zone not signed" });
    }

    if (!nsecPresent && !nsec3Present) {
      score -= 10;
      findings.push({ rule: "nsec_missing", deduction: -10, detail: "Neither NSEC nor NSEC3 present" });
    }

    if (!tldDsPresent) {
      score -= 5;
      findings.push({ rule: "tld_ds_missing", deduction: -5, detail: "TLD DS record not found — weakens root trust anchor" });
    }

    score = Math.max(0, score);
    const grade = assignGrade(score);

    res.json({
      domain,
      dnssec_enabled: dnssecEnabled,
      resolver_validated: resolverValidated,
      chain_of_trust: chainOfTrust,
      components: {
        ds_record: dsRecord,
        dnskey_record: dnskeyRecord,
        rrsig_record: rrsigRecord,
        nsec_or_nsec3: nsecOrNsec3,
      },
      tld_ds_present: tldDsPresent,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("dnssec error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
