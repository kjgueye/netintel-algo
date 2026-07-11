import { Router, type Request, type Response } from "express";
import { queryDns, RECORD_TYPES, type DnsAnswer } from "../utils/dns-resolvers.js";
import { fmtReceived, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";

export const nameGenRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

type Pattern = "prefix" | "suffix" | "blend" | "modification";

interface Candidate {
  name: string;
  pattern: Pattern;
}

interface Suggestion {
  name: string;
  domain: string;
  available: boolean;
  brandability: number;
  pattern: Pattern;
}

// --- Constants ---

const KEYWORD_RE = /^[a-z0-9]+$/;
const TLD_RE = /^[a-z0-9]{2,24}$/;

const PREFIXES = ["get", "try", "use", "go", "my", "the", "join", "hey"];
const SUFFIXES = [
  "ly", "ify", "io", "hub", "labs", "ai", "app", "hq",
  "base", "kit", "flow", "wise", "ster", "fy",
];
const VOWELS = new Set(["a", "e", "i", "o", "u"]);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 40;

// --- Generation ---

function generateCandidates(keyword: string, limit: number): Candidate[] {
  const ordered: Candidate[] = [];

  // Prefixes: get-, try-, use-, ...
  for (const p of PREFIXES) {
    ordered.push({ name: `${p}${keyword}`, pattern: "prefix" });
  }

  // Suffixes: -ly, -ify, -hub, ...
  for (const s of SUFFIXES) {
    ordered.push({ name: `${keyword}${s}`, pattern: "suffix" });
  }

  // Vowel / clip modifications
  const last = keyword[keyword.length - 1];
  // Drop trailing vowel
  if (VOWELS.has(last) && keyword.length > 2) {
    ordered.push({ name: keyword.slice(0, -1), pattern: "modification" });
  }
  // Double final consonant
  if (!VOWELS.has(last)) {
    ordered.push({ name: `${keyword}${last}`, pattern: "modification" });
  }
  // Replace trailing 'e' with 'a' / 'o'
  if (last === "e") {
    ordered.push({ name: `${keyword.slice(0, -1)}a`, pattern: "modification" });
    ordered.push({ name: `${keyword.slice(0, -1)}o`, pattern: "modification" });
  }

  // Blends — clipped keyword + tech endings (needs enough length)
  if (keyword.length >= 4) {
    const base4 = keyword.slice(0, 4);
    const base3 = keyword.slice(0, 3);
    ordered.push({ name: `${base4}dly`, pattern: "blend" });
    ordered.push({ name: `${base4}dio`, pattern: "blend" });
    ordered.push({ name: `${base3}sy`, pattern: "blend" });
    ordered.push({ name: `${base3}zo`, pattern: "blend" });
  }

  // Dedupe (first pattern wins), drop the bare keyword, cap at limit
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const c of ordered) {
    if (c.name === keyword) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    candidates.push(c);
    if (candidates.length >= limit) break;
  }
  return candidates;
}

// --- Brandability scoring ---

export function scoreBrandability(name: string): number {
  let score = 100;
  const len = name.length;

  // Length: ideal 5-9 chars, -5 per char outside that range
  if (len < 5) score -= (5 - len) * 5;
  else if (len > 9) score -= (len - 9) * 5;

  if (/[0-9]/.test(name)) score -= 20;
  if (name.includes("-")) score -= 30;

  // Hard to pronounce: 3+ consonants in a row
  if (/[bcdfghjklmnpqrstvwxyz]{3,}/.test(name)) score -= 15;

  // Very generic suffix (ly, io)
  if (/(?:ly|io)$/.test(name)) score -= 5;

  // Ends in a vowel — often more brandable
  if (VOWELS.has(name[name.length - 1])) score += 5;

  return Math.max(0, Math.min(100, score));
}

// --- Availability check (DNS NS) ---

// NS records exist → domain is taken; none → available.
async function checkAvailability(domain: string): Promise<boolean> {
  const TIMED_OUT = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeouts.nameGen);
  });

  try {
    const result = await Promise.race([queryDns(domain, RECORD_TYPES.NS), timeout]);
    if (result === TIMED_OUT) return false; // couldn't confirm — treat as taken
    return (result as DnsAnswer[]).length === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// --- Grading ---

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

nameGenRouter.get("/name-gen/suggest", async (req: Request, res: Response) => {
  try {
    const rawKeyword = req.query.keyword as string | undefined;

    if (rawKeyword === undefined || rawKeyword.trim() === "") {
      // Prefix must stay "keyword is required" — deriveField() anchors on it.
      res.status(400).json({
        error:
          "keyword is required — pass a seed word to generate names from, e.g. ?keyword=cloud (2-20 alphanumeric characters)",
      });
      return;
    }

    const keyword = rawKeyword.trim().toLowerCase();
    if (!KEYWORD_RE.test(keyword)) {
      throw new ValidationError(
        `keyword must be alphanumeric with no spaces, e.g. cloud — received ${fmtReceived(rawKeyword)}`
      );
    }
    if (keyword.length < 2 || keyword.length > 20) {
      throw new ValidationError(
        `keyword must be between 2 and 20 characters, e.g. cloud — received ${fmtReceived(keyword)} (${keyword.length} chars)`
      );
    }

    // TLD (default "com")
    const rawTld = req.query.tld as string | undefined;
    const tld = (rawTld ?? "com").trim().toLowerCase().replace(/^\./, "");
    if (!TLD_RE.test(tld)) {
      throw new ValidationError(
        `tld must be 2-24 alphanumeric characters, e.g. com, io, ai — optional, defaults to com (omit it to check .com); received ${fmtReceived(rawTld ?? "")}`
      );
    }

    // Limit (default 25, max 40)
    let limit = DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      const parsed = parseInt(req.query.limit as string, 10);
      if (Number.isNaN(parsed) || parsed < 1) {
        throw new ValidationError(
          `limit must be a positive integer (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}) — received ${fmtReceived(String(req.query.limit))}`
        );
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    // Generate candidates
    const candidates = generateCandidates(keyword, limit);

    // Check .{tld} availability for each, concurrently
    const settled = await Promise.allSettled(
      candidates.map((c) => checkAvailability(`${c.name}.${tld}`)),
    );

    const suggestions: Suggestion[] = candidates.map((c, i) => {
      const available = settled[i].status === "fulfilled" ? settled[i].value : false;
      return {
        name: c.name,
        domain: `${c.name}.${tld}`,
        available,
        brandability: scoreBrandability(c.name),
        pattern: c.pattern,
      };
    });

    // Sort: available first, then brandability descending
    suggestions.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return b.brandability - a.brandability;
    });

    const availableSuggestions = suggestions.filter((s) => s.available);
    const availableCount = availableSuggestions.length;

    // Top 3 available domains by brandability (already sorted overall)
    const topAvailable = [...availableSuggestions]
      .sort((a, b) => b.brandability - a.brandability)
      .slice(0, 3)
      .map((s) => s.domain);

    // --- Grading ---
    let score = 100;
    const findings: Finding[] = [];

    if (availableCount === 0) {
      findings.push({
        rule: "nothing_available",
        deduction: -60,
        detail: "No generated names are available for registration",
      });
      score -= 60;
    }

    if (availableCount < 3) {
      findings.push({
        rule: "few_available",
        deduction: -25,
        detail: `Only ${availableCount} available name${availableCount === 1 ? "" : "s"} found`,
      });
      score -= 25;
    }

    if (!availableSuggestions.some((s) => s.brandability >= 70)) {
      findings.push({
        rule: "no_high_brandability_available",
        deduction: -15,
        detail: "No available name scores 70+ for brandability",
      });
      score -= 15;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    res.json({
      keyword,
      tld,
      generated_count: suggestions.length,
      available_count: availableCount,
      suggestions,
      top_available: topAvailable,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Name generator error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
