import { Router, type Request, type Response } from "express";
import { validateDomain, ValidationError } from "../utils/validators.js";

export const domainAppraiseRouter = Router();

// --- Interfaces ---

interface Factor {
  factor: string;
  impact: number;
  detail: string;
}

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

// --- Dictionary & keyword data ---

// ~300 common English words used for dictionary-word and two-word detection.
// Kept inline (no external API) — short, brandable, commerce-leaning words score well.
const DICTIONARY = new Set<string>([
  "the", "and", "for", "you", "all", "get", "got", "got", "new", "now", "one", "two", "top",
  "cloud", "data", "shop", "buy", "sell", "app", "tech", "web", "net", "link", "pay", "bank",
  "home", "auto", "food", "game", "play", "work", "jobs", "news", "blog", "store", "market",
  "money", "gold", "fast", "smart", "easy", "best", "top", "pro", "plus", "max", "min", "go",
  "get", "my", "me", "we", "us", "code", "dev", "byte", "bit", "data", "info", "site", "page",
  "host", "mail", "send", "chat", "talk", "call", "ping", "ring", "wave", "flow", "stream",
  "live", "view", "look", "see", "show", "find", "seek", "scan", "test", "check", "track",
  "trace", "tag", "map", "list", "grid", "box", "bin", "hub", "core", "base", "node", "edge",
  "loop", "sync", "swap", "shift", "drive", "ride", "fly", "jet", "ship", "boat", "car", "bike",
  "road", "path", "way", "trip", "tour", "trek", "move", "step", "jump", "leap", "run", "walk",
  "buy", "deal", "cart", "coin", "cash", "fund", "loan", "save", "earn", "spend", "trade",
  "stock", "share", "bond", "wealth", "rich", "prime", "elite", "royal", "crown", "king",
  "queen", "ace", "star", "sun", "moon", "sky", "sea", "ocean", "lake", "river", "wave",
  "fire", "flame", "spark", "bolt", "light", "bright", "glow", "shine", "ray", "beam",
  "green", "blue", "red", "black", "white", "gray", "rose", "lime", "mint", "sage",
  "tree", "leaf", "root", "seed", "grow", "farm", "garden", "field", "wood", "stone", "rock",
  "iron", "steel", "metal", "glass", "wire", "chip", "disk", "drive", "ram", "cpu",
  "love", "like", "joy", "happy", "smile", "dream", "hope", "wish", "magic", "wonder",
  "power", "force", "energy", "spirit", "soul", "mind", "brain", "idea", "think", "learn",
  "teach", "study", "school", "class", "book", "read", "write", "word", "text", "note",
  "art", "music", "song", "beat", "tune", "voice", "sound", "audio", "video", "photo",
  "image", "pic", "snap", "shot", "lens", "zoom", "focus", "frame", "scene", "stage",
  "team", "crew", "group", "club", "guild", "league", "squad", "force", "unit", "band",
  "city", "town", "place", "spot", "zone", "area", "land", "world", "globe", "earth",
  "time", "day", "week", "month", "year", "hour", "clock", "watch", "alarm", "timer",
  "health", "care", "cure", "heal", "med", "doc", "clinic", "fit", "gym", "sport",
  "tool", "kit", "gear", "craft", "build", "make", "fix", "repair", "design", "create",
  "shop", "deal", "sale", "price", "cost", "value", "worth", "free", "gift", "bonus",
  "ai", "data", "tech", "api", "dev", "code", "cyber", "byte", "bot", "robot", "auto",
  "crypto", "coin", "chain", "block", "token", "wallet", "vault", "ledger", "mint",
  "quick", "swift", "rapid", "turbo", "boost", "rush", "dash", "zip", "snap", "flash",
  "true", "real", "pure", "clear", "clean", "fresh", "bold", "brave", "wise", "keen",
  "open", "free", "easy", "simple", "basic", "solid", "strong", "tough", "hard", "soft",
]);

// High-value commercial keyword categories. Checked in priority order
// (finance > tech > commerce); the first matching category sets the bonus.
const KEYWORD_CATEGORIES: { category: string; bonus: number; label: string; words: string[] }[] = [
  {
    category: "finance",
    bonus: 10,
    label: "Finance",
    words: ["bank", "pay", "coin", "crypto", "fund", "invest", "loan", "cash", "money"],
  },
  {
    category: "tech",
    bonus: 8,
    label: "Tech/AI",
    words: ["ai", "cloud", "data", "app", "tech", "api", "dev", "code", "cyber"],
  },
  {
    category: "commerce",
    bonus: 8,
    label: "Commerce",
    words: ["shop", "store", "buy", "sell", "deal", "market", "cart"],
  },
];

const VOWELS = new Set(["a", "e", "i", "o", "u"]);

// --- Helpers ---

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// Tier thresholds are aligned 1:1 with calculateGrade's bands so the two labels
// can never contradict (previously score 60 was tier "strong" AND grade "C").
// premium=A, strong=B, moderate=C, low=D/F.
function valueTier(score: number): string {
  if (score >= 90) return "premium";
  if (score >= 75) return "strong";
  if (score >= 55) return "moderate";
  return "low";
}

/** True when `name` can be split into two parts that are both dictionary words. */
function isTwoDictionaryWords(name: string): boolean {
  for (let i = 2; i <= name.length - 2; i++) {
    if (DICTIONARY.has(name.slice(0, i)) && DICTIONARY.has(name.slice(i))) {
      return true;
    }
  }
  return false;
}

/** True when any alphabetic run in `name` has 4+ consecutive consonants. */
function hasFourConsonantCluster(name: string): boolean {
  let run = 0;
  for (const ch of name) {
    if (ch >= "a" && ch <= "z") {
      if (VOWELS.has(ch)) {
        run = 0;
      } else {
        run += 1;
        if (run >= 4) return true;
      }
    } else {
      run = 0;
    }
  }
  return false;
}

// --- Extracted appraisal logic (shared with the domain-due-diligence aggregator) ---

/**
 * Compute the full heuristic appraisal for a domain. Validates the domain
 * (throws ValidationError on bad input) and returns the same object shape the
 * /domain-appraise/estimate route responds with.
 */
export function runDomainAppraise(rawDomain: string) {
    const domain = validateDomain(rawDomain);

    // Split into name + TLD on the final dot.
    const lastDot = domain.lastIndexOf(".");
    const name = domain.slice(0, lastDot);
    const tld = domain.slice(lastDot + 1);

    const factors: Factor[] = [];
    let score = 50; // base

    // --- Length (name without TLD) ---
    const length = name.length;
    if (length <= 3) {
      score += 35;
      factors.push({ factor: "length", impact: 35, detail: `${length}-character name (ultra premium)` });
    } else if (length <= 5) {
      score += 25;
      factors.push({ factor: "length", impact: 25, detail: `${length}-character name (short)` });
    } else if (length <= 8) {
      score += 12;
      factors.push({ factor: "length", impact: 12, detail: `${length}-character name (compact)` });
    } else if (length <= 12) {
      // neutral — no factor recorded
    } else if (length <= 18) {
      score -= 10;
      factors.push({ factor: "length", impact: -10, detail: `${length}-character name (long)` });
    } else {
      score -= 25;
      factors.push({ factor: "length", impact: -25, detail: `${length}-character name (very long)` });
    }

    // --- TLD value ---
    let tldImpact = 0;
    let tldDetail = "";
    if (tld === "com") {
      tldImpact = 25;
      tldDetail = ".com TLD";
    } else if (tld === "net" || tld === "org") {
      tldImpact = 10;
      tldDetail = `.${tld} TLD`;
    } else if (tld === "io" || tld === "ai" || tld === "co") {
      tldImpact = 12;
      tldDetail = `.${tld} TLD (tech-premium)`;
    } else if (tld === "app" || tld === "dev") {
      tldImpact = 5;
      tldDetail = `.${tld} TLD`;
    }
    if (tldImpact !== 0) {
      score += tldImpact;
      factors.push({ factor: "tld", impact: tldImpact, detail: tldDetail });
    }

    // --- Dictionary word ---
    const isSingleWord = DICTIONARY.has(name);
    const isTwoWords = !isSingleWord && isTwoDictionaryWords(name);
    if (isSingleWord) {
      score += 20;
      factors.push({ factor: "dictionary_word", impact: 20, detail: "Exact dictionary word" });
    } else if (isTwoWords) {
      score += 12;
      factors.push({ factor: "dictionary_word", impact: 12, detail: "Two dictionary words concatenated" });
    }
    const isDictionaryWord = isSingleWord || isTwoWords;

    // --- Pronounceability ---
    const letters = name.replace(/[^a-z]/g, "");
    const vowelCount = [...letters].filter((c) => VOWELS.has(c)).length;
    const vowelRatio = letters.length > 0 ? vowelCount / letters.length : 0;
    const fourConsonants = hasFourConsonantCluster(name);
    const pronounceable = !fourConsonants && vowelCount > 0;
    if (!fourConsonants && vowelRatio >= 0.3 && vowelRatio <= 0.5) {
      score += 10;
      factors.push({ factor: "pronounceability", impact: 10, detail: "Balanced vowel ratio, easy to pronounce" });
    } else if (fourConsonants) {
      score -= 10;
      factors.push({ factor: "pronounceability", impact: -10, detail: "Contains a 4+ consonant cluster (hard to pronounce)" });
    }

    // --- Penalties ---
    const findings: Finding[] = [];

    const hasHyphen = name.includes("-");
    if (hasHyphen) {
      score -= 20;
      factors.push({ factor: "hyphen", impact: -20, detail: "Name contains a hyphen" });
      findings.push({ rule: "hyphen", deduction: -20, detail: "Name contains a hyphen" });
    }

    // Count distinct numeric runs, not raw digits: "402" is ONE number, so it
    // takes the single-number penalty — not the harsher "multiple numbers" one
    // that only fits several separate numbers (e.g. "a12b34"). Previously this
    // counted digits, mislabeling "402" as "multiple numbers" and over-docking it.
    const numberRuns = name.match(/[0-9]+/g) || [];
    const numberCount = numberRuns.length;
    const hasNumber = numberCount > 0;
    if (numberCount >= 2) {
      score -= 25;
      factors.push({ factor: "number", impact: -25, detail: "Name contains multiple separate numbers" });
      findings.push({ rule: "multiple_numbers", deduction: -25, detail: "Name contains multiple separate numbers" });
    } else if (numberCount === 1) {
      score -= 15;
      factors.push({ factor: "number", impact: -15, detail: "Name contains a number" });
      findings.push({ rule: "number", deduction: -15, detail: "Name contains a number" });
    }

    // --- Keyword category bonus (highest-priority matching category only) ---
    for (const cat of KEYWORD_CATEGORIES) {
      const matched = cat.words.find((w) => name.includes(w));
      if (matched) {
        score += cat.bonus;
        factors.push({
          factor: "keyword_category",
          impact: cat.bonus,
          detail: `${cat.label} keyword: ${matched}`,
        });
        break;
      }
    }

    // --- Clamp & derive ---
    score = Math.max(0, Math.min(100, score));
    const valueScore = score;
    const tier = valueTier(score);
    const grade = calculateGrade(score);

    return {
      domain,
      name,
      tld,
      value_score: valueScore,
      value_tier: tier,
      factors,
      characteristics: {
        length,
        is_dictionary_word: isDictionaryWord,
        has_hyphen: hasHyphen,
        has_number: hasNumber,
        pronounceable,
      },
      score,
      grade,
      findings,
    };
}

// --- Route handler ---

domainAppraiseRouter.get("/domain-appraise/estimate", (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string | undefined;
    if (!rawDomain) {
      res.status(400).json({ error: "domain is required" });
      return;
    }

    res.json(runDomainAppraise(rawDomain));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Domain appraise error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
