import { Router, type Request, type Response } from "express";
import { queryDns, type DnsAnswer } from "../utils/dns-resolvers.js";
import { validateDomain, ValidationError } from "../utils/validators.js";

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

    // Run all DNS queries concurrently
    const [dsResult, dnskeyResult, rrsigResult, nsecResult, nsec3Result, soaResult, tldDsResult] =
      await Promise.allSettled([
        queryDns(domain, "DS"),
        queryDns(domain, "DNSKEY"),
        queryDns(domain, "RRSIG"),
        queryDns(domain, "NSEC"),
        queryDns(domain, "NSEC3"),
        queryDns(domain, "SOA"),
        queryDns(tld, "DS"),
      ]);

    const dsAnswers = dsResult.status === "fulfilled" ? dsResult.value : [];
    const dnskeyAnswers = dnskeyResult.status === "fulfilled" ? dnskeyResult.value : [];
    const rrsigAnswers = rrsigResult.status === "fulfilled" ? rrsigResult.value : [];
    const nsecAnswers = nsecResult.status === "fulfilled" ? nsecResult.value : [];
    const nsec3Answers = nsec3Result.status === "fulfilled" ? nsec3Result.value : [];
    const tldDsAnswers = tldDsResult.status === "fulfilled" ? tldDsResult.value : [];

    const dsPresent = dsAnswers.length > 0;
    const dnskeyPresent = dnskeyAnswers.length > 0;
    const rrsigPresent = rrsigAnswers.length > 0;
    const nsecPresent = nsecAnswers.length > 0;
    const nsec3Present = nsec3Answers.length > 0;
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

    const dnssecEnabled = dnskeyPresent && rrsigPresent;

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
      signatures_found: rrsigAnswers.length,
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
      // No DNSSEC at all
      score -= 60;
      findings.push({ rule: "no_dnssec", deduction: -60, detail: "No DNSKEY and no RRSIG — DNSSEC not configured" });
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
