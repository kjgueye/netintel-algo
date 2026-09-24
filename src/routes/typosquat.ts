import { Router, type Request, type Response } from "express";
import { nsPresence } from "../utils/dns-resolvers.js";
import { validateDomain, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";

export const typosquatRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

type Technique =
  | "omission"
  | "duplication"
  | "transposition"
  | "adjacent_key"
  | "homoglyph"
  | "hyphenation"
  | "alternate_tld";

interface Variation {
  domain: string;
  technique: Technique;
  registered: boolean;
}

// --- Constants ---

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

// QWERTY adjacency map (hardcoded)
const QWERTY: Record<string, string[]> = {
  q: ["w", "a"], w: ["q", "e", "s"], e: ["w", "r", "d"], r: ["e", "t", "f"], t: ["r", "y", "g"],
  y: ["t", "u", "h"], u: ["y", "i", "j"], i: ["u", "o", "k"], o: ["i", "p", "l"], p: ["o", "l"],
  a: ["q", "s", "z"], s: ["a", "w", "d", "x"], d: ["s", "e", "f", "c"], f: ["d", "r", "g", "v"],
  g: ["f", "t", "h", "b"], h: ["g", "y", "j", "n"], j: ["h", "u", "k", "m"], k: ["j", "i", "l"],
  l: ["k", "o", "p"], z: ["a", "x"], x: ["z", "s", "c"], c: ["x", "d", "v"], v: ["c", "f", "b"],
  b: ["v", "g", "n"], n: ["b", "h", "m"], m: ["n", "j"],
};

// Visually similar, ASCII-safe substitutions (replace all occurrences)
const HOMOGLYPHS: Array<[string, string]> = [
  ["o", "0"], ["l", "1"], ["i", "1"], ["e", "3"], ["a", "@"],
];

// Alternate TLDs to swap the original name onto
const ALT_TLDS = ["net", "org", "io", "co", "app"];

// Cap on adjacent-key variants to keep counts under control
const ADJACENT_KEY_CAP = 10;

// --- Variation generation ---

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// Generate name-portion variants, one bucket per technique.
function generateNameVariants(name: string): Record<Exclude<Technique, "alternate_tld">, string[]> {
  const omission: string[] = [];
  const duplication: string[] = [];
  const transposition: string[] = [];
  const adjacent_key: string[] = [];
  const homoglyph: string[] = [];
  const hyphenation: string[] = [];

  for (let i = 0; i < name.length; i++) {
    // Omission — remove each character once
    omission.push(name.slice(0, i) + name.slice(i + 1));
    // Duplication — double each character once
    duplication.push(name.slice(0, i) + name[i] + name.slice(i));
    // Adjacent-key — replace each char with a QWERTY neighbor
    const neighbors = QWERTY[name[i]] ?? [];
    for (const n of neighbors) {
      adjacent_key.push(name.slice(0, i) + n + name.slice(i + 1));
    }
  }

  // Transposition — swap adjacent characters
  for (let i = 0; i < name.length - 1; i++) {
    const chars = name.split("");
    [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
    transposition.push(chars.join(""));
  }

  // Homoglyph — replace all occurrences of a visually similar char
  for (const [ch, sub] of HOMOGLYPHS) {
    if (name.includes(ch)) homoglyph.push(name.split(ch).join(sub));
  }

  // Hyphenation — insert a hyphen at each interior position
  for (let i = 1; i < name.length; i++) {
    hyphenation.push(name.slice(0, i) + "-" + name.slice(i));
  }

  // Dedupe within each bucket and drop anything equal to the original name
  const clean = (arr: string[]) => dedupe(arr).filter((v) => v !== name && v.length > 0);

  return {
    omission: clean(omission),
    duplication: clean(duplication),
    transposition: clean(transposition),
    adjacent_key: clean(adjacent_key).slice(0, ADJACENT_KEY_CAP),
    homoglyph: clean(homoglyph),
    hyphenation: clean(hyphenation),
  };
}

// Build the final, deduped list of {domain, technique} capped at limit.
function buildVariations(name: string, tld: string, limit: number): Array<{ domain: string; technique: Technique }> {
  const nameVariants = generateNameVariants(name);

  // Each bucket is a queue of full domains tagged with its technique.
  const buckets: Array<{ technique: Technique; items: string[] }> = [
    { technique: "omission", items: nameVariants.omission.map((v) => `${v}.${tld}`) },
    { technique: "duplication", items: nameVariants.duplication.map((v) => `${v}.${tld}`) },
    { technique: "transposition", items: nameVariants.transposition.map((v) => `${v}.${tld}`) },
    { technique: "adjacent_key", items: nameVariants.adjacent_key.map((v) => `${v}.${tld}`) },
    { technique: "homoglyph", items: nameVariants.homoglyph.map((v) => `${v}.${tld}`) },
    { technique: "hyphenation", items: nameVariants.hyphenation.map((v) => `${v}.${tld}`) },
    { technique: "alternate_tld", items: ALT_TLDS.filter((t) => t !== tld).map((t) => `${name}.${t}`) },
  ];

  const out: Array<{ domain: string; technique: Technique }> = [];
  const seen = new Set<string>([`${name}.${tld}`]); // never check the original domain

  // Round-robin across buckets so the cap spreads coverage across techniques.
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (const bucket of buckets) {
      if (out.length >= limit) break;
      const domain = bucket.items.shift();
      if (domain === undefined) continue;
      progressed = true;
      if (seen.has(domain)) continue;
      seen.add(domain);
      out.push({ domain, technique: bucket.technique });
    }
  }

  return out;
}

// --- Registration check (DNS NS) ---

// NS answers or NOERROR-without-NS → registered; SERVFAIL also counts as
// registered (a lame-delegated parked lookalike is still a registration — the
// old []-means-available read hid those from the threat count). NXDOMAIN or
// no verdict (timeout/refusal) → not registered.
async function isRegistered(domain: string): Promise<boolean> {
  const presence = await nsPresence(domain, timeouts.typosquat);
  return presence === "registered" || presence === "servfail";
}

// --- Grading ---

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Extracted scan logic (shared with the domain-vet aggregator) ---

/**
 * Generate look-alike variations of a domain and check which are registered.
 * Validates its inputs (throws ValidationError on a bad domain or limit) and
 * returns the same object shape the /typosquat/scan route responds with.
 */
export async function runTyposquat(rawDomain: string, rawLimit?: unknown) {
    const input = rawDomain.trim().toLowerCase();
    if (!input.includes(".")) {
      throw new ValidationError("domain must include a TLD");
    }
    const domain = validateDomain(input);

    // limit (default 30, max 50)
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = parseInt(rawLimit as string, 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        throw new ValidationError("limit must be between 1 and 50");
      }
      limit = parsed;
    }

    // Split into name + TLD at the first dot
    const dotIdx = domain.indexOf(".");
    const name = domain.slice(0, dotIdx);
    const tld = domain.slice(dotIdx + 1);

    // Generate and check variations
    const candidates = buildVariations(name, tld, limit);
    const settled = await Promise.allSettled(candidates.map((c) => isRegistered(c.domain)));

    const variations: Variation[] = candidates.map((c, i) => ({
      domain: c.domain,
      technique: c.technique,
      registered: settled[i].status === "fulfilled" ? (settled[i] as PromiseFulfilledResult<boolean>).value : false,
    }));

    const registeredLookalikes = variations.filter((v) => v.registered);
    const availableVariations = variations.filter((v) => !v.registered);

    const variationsChecked = variations.length;
    const registeredCount = registeredLookalikes.length;
    const availableCount = availableVariations.length;

    // --- Grading ---
    let score = 100;
    const findings: Finding[] = [];
    const ratio = variationsChecked > 0 ? registeredCount / variationsChecked : 0;

    if (ratio > 0.33) {
      findings.push({
        rule: "high_typosquat_exposure",
        deduction: -40,
        detail: `${registeredCount} of ${variationsChecked} look-alike domains are registered`,
      });
      score -= 40;
    } else if (ratio >= 0.15) {
      findings.push({
        rule: "medium_typosquat_exposure",
        deduction: -20,
        detail: `${registeredCount} of ${variationsChecked} look-alike domains are registered`,
      });
      score -= 20;
    }

    if (registeredLookalikes.some((v) => v.technique === "homoglyph")) {
      findings.push({
        rule: "homoglyph_registered",
        deduction: -15,
        detail: "A homoglyph look-alike domain is registered (highest phishing risk)",
      });
      score -= 15;
    }

    if (registeredLookalikes.some((v) => v.technique === "alternate_tld")) {
      findings.push({
        rule: "alt_tld_registered",
        deduction: -10,
        detail: "An alternate-TLD look-alike domain is registered",
      });
      score -= 10;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    return {
      domain,
      name,
      tld,
      variations_checked: variationsChecked,
      registered_count: registeredCount,
      available_count: availableCount,
      registered_lookalikes: registeredLookalikes,
      available_variations: availableVariations,
      score,
      grade,
      findings,
    };
}

// --- Route handler ---

typosquatRouter.get("/typosquat/scan", async (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string | undefined;

    if (rawDomain === undefined || rawDomain.trim() === "") {
      res.status(400).json({ error: "domain is required" });
      return;
    }

    res.json(await runTyposquat(rawDomain, req.query.limit));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Typosquat scan error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
