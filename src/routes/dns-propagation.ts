import { Router, type Request, type Response } from "express";
import { queryDns, type DnsAnswer } from "../utils/dns-resolvers.js";
import { validateDomain, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";

export const dnsPropagationRouter = Router();

const VALID_RECORD_TYPES = new Set(["A", "AAAA", "MX", "TXT", "CNAME", "NS"]);

const RESOLVERS = [
  { name: "Google Primary", ip: "8.8.8.8" },
  { name: "Google Secondary", ip: "8.8.4.4" },
  { name: "Cloudflare Primary", ip: "1.1.1.1" },
  { name: "Cloudflare Secondary", ip: "1.0.0.1" },
  { name: "OpenDNS Primary", ip: "208.67.222.222" },
  { name: "OpenDNS Secondary", ip: "208.67.220.220" },
  { name: "Quad9", ip: "9.9.9.9" },
  { name: "Comodo Secure", ip: "8.26.56.26" },
  { name: "Verisign", ip: "64.6.64.6" },
  { name: "CleanBrowsing", ip: "185.228.168.168" },
] as const;

function extractRecords(answers: DnsAnswer[], recordType: string): string[] {
  return answers.map((a) => {
    if (recordType === "A" || recordType === "AAAA") return a.address || "";
    if (recordType === "MX") return `${a.priority} ${a.exchange}`;
    if (recordType === "CNAME") return a.data || "";
    if (recordType === "NS") return a.ns || "";
    if (recordType === "TXT") return a.data || "";
    return a.data || a.address || "";
  }).filter(Boolean);
}

function computeMajority(resolverResults: { records: string[]; status: string }[]): string[] {
  const counts = new Map<string, number>();
  for (const r of resolverResults) {
    if (r.status !== "success") continue;
    const key = JSON.stringify(r.records.slice().sort());
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let maxCount = 0;
  let majorityKey = "[]";
  for (const [key, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      majorityKey = key;
    }
  }
  return JSON.parse(majorityKey) as string[];
}

function assignGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

dnsPropagationRouter.get("/dns-propagation/check", async (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string | undefined;
    if (!rawDomain) {
      res.status(400).json({ error: "domain is required" });
      return;
    }

    const domain = validateDomain(rawDomain);

    const rawType = (req.query.record_type as string | undefined) || "A";
    const recordType = rawType.toUpperCase();
    if (!VALID_RECORD_TYPES.has(recordType)) {
      res.status(400).json({ error: "record_type must be one of: A, AAAA, MX, TXT, CNAME, NS" });
      return;
    }

    const timeout = timeouts.dnsPropagation;

    const results = await Promise.allSettled(
      RESOLVERS.map(async (resolver) => {
        const start = Date.now();
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeout)
        );
        const queryPromise = queryDns(domain, recordType, resolver.ip);
        const answers = await Promise.race([queryPromise, timeoutPromise]);
        const elapsed = Date.now() - start;
        return { resolver, answers, elapsed };
      })
    );

    const resolverResults: {
      name: string;
      ip: string;
      status: string;
      records: string[];
      matches_majority: boolean;
      response_time_ms: number | null;
    }[] = [];

    const intermediate: { records: string[]; status: string }[] = [];

    for (let i = 0; i < RESOLVERS.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        const records = extractRecords(r.value.answers, recordType);
        const entry = {
          name: RESOLVERS[i].name,
          ip: RESOLVERS[i].ip,
          status: "success" as string,
          records,
          matches_majority: false,
          response_time_ms: r.value.elapsed as number | null,
        };
        resolverResults.push(entry);
        intermediate.push({ records, status: "success" });
      } else {
        resolverResults.push({
          name: RESOLVERS[i].name,
          ip: RESOLVERS[i].ip,
          status: "timeout",
          records: [],
          matches_majority: false,
          response_time_ms: null,
        });
        intermediate.push({ records: [], status: "timeout" });
      }
    }

    const majorityValue = computeMajority(intermediate);
    const majorityKey = JSON.stringify(majorityValue.slice().sort());

    const successResults = intermediate.filter((r) => r.status === "success");
    const successWithRecords = successResults.filter((r) => r.records.length > 0);
    const matchingCount = successWithRecords.filter(
      (r) => JSON.stringify(r.records.slice().sort()) === majorityKey
    ).length;

    const propagationPercentage = (majorityValue.length === 0)
      ? 0
      : RESOLVERS.length > 0
        ? Math.round((matchingCount / RESOLVERS.length) * 100)
        : 0;

    // Set matches_majority
    for (let i = 0; i < resolverResults.length; i++) {
      if (intermediate[i].status === "success" && majorityValue.length > 0) {
        resolverResults[i].matches_majority =
          JSON.stringify(intermediate[i].records.slice().sort()) === majorityKey;
      }
    }

    const consistent = successWithRecords.length > 0 &&
      successWithRecords.every((r) => JSON.stringify(r.records.slice().sort()) === majorityKey);

    const divergentResolvers = resolverResults
      .filter((r) => !r.matches_majority)
      .map((r) => r.name);

    // Scoring
    let score = 100;
    const findings: { rule: string; deduction: number; detail: string }[] = [];

    const divergentCount = resolverResults.filter(
      (r) => r.status === "success" && !r.matches_majority
    ).length;
    const timeoutCount = resolverResults.filter((r) => r.status === "timeout").length;

    if (divergentCount > 0) {
      const deduction = -10 * divergentCount;
      score += deduction;
      findings.push({
        rule: "partial_propagation",
        deduction,
        detail: `${divergentCount} resolver${divergentCount > 1 ? "s" : ""} returned different or no result`,
      });
    }

    if (timeoutCount > 0) {
      const deduction = -8 * timeoutCount;
      score += deduction;
      findings.push({
        rule: "resolver_timeout",
        deduction,
        detail: `${timeoutCount} resolver${timeoutCount > 1 ? "s" : ""} timed out`,
      });
    }

    if (propagationPercentage < 50) {
      score += -20;
      findings.push({
        rule: "low_propagation",
        deduction: -20,
        detail: `Propagation percentage is ${propagationPercentage}%`,
      });
    }

    const allEmpty = successResults.length === 0 ||
      (successResults.length > 0 && successResults.every((r) => r.records.length === 0));
    if (allEmpty) {
      score += -60;
      findings.push({
        rule: "no_results_anywhere",
        deduction: -60,
        detail: "All resolvers returned empty or error",
      });
    }

    // Check for split-brain: 2+ different non-empty value sets
    const uniqueNonEmpty = new Set(
      successResults
        .filter((r) => r.records.length > 0)
        .map((r) => JSON.stringify(r.records.slice().sort()))
    );
    if (uniqueNonEmpty.size >= 2) {
      score += -15;
      findings.push({
        rule: "inconsistent_values",
        deduction: -15,
        detail: `${uniqueNonEmpty.size} different non-empty values returned`,
      });
    }

    score = Math.max(0, score);
    const grade = assignGrade(score);

    res.json({
      domain,
      record_type: recordType,
      propagation_percentage: propagationPercentage,
      consistent,
      majority_value: majorityValue,
      resolvers: resolverResults,
      divergent_resolvers: divergentResolvers,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("dns-propagation error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
