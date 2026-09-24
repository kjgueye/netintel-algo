import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import net from "node:net";
import { timeouts, pricing } from "../config.js";
import { signableAccepts } from "../accepts.js";
import { runBulkDomain } from "./bulk-domain.js";
import { runDomainAppraise } from "./domain-appraise.js";
import { runTyposquat } from "./typosquat.js";

export const domainVetRouter = Router();

// ---------------------------------------------------------------------------
// Domain Vet — pick a name AND check it's safe to build on, in one call.
//
// Aggregator (bundle): fans out IN-PROCESS to three of NetIntel's own
// primitives — bulk-domain (breadth availability), domain-appraise (name
// quality), typosquat (brand-abuse exposure) — by calling the extracted run*()
// functions directly (same pattern as domain-vendor-risk / domain-report-full).
// No HTTP self-calls, no new provider, no new runtime.
//
// It adds ONE new check of its own: a FACTUAL brand-collision signal (see
// BRAND COLLISION below). Everything else is composition + the rank/select step
// the à-la-carte funnel makes the caller do by hand.
//
// Collapses the observed pick-a-brand-name funnel (bulk-domain → appraise →
// typosquat, run by hand across four wallets) into one call.
//
// NOT-SAFE-BY-DEFAULT: a check that fails or times out NEVER reads as "clear".
// It degrades to an explicit unavailable/low-confidence marker + an entry in
// signals_unavailable — never to an empty "nothing found".
// ---------------------------------------------------------------------------

// ===========================================================================
// ⚠️  BRAND COLLISION — THIS IS NOT A TRADEMARK CHECK AND NOT LEGAL ADVICE
// ===========================================================================
// This endpoint performs a FACTUAL name-similarity check ONLY: does the
// candidate closely resemble (a) domains that are already registered, or (b)
// a bundled, curated list of well-known brand STRINGS? It reports the
// resemblance and names what was resembled.
//
// It MUST NOT, now or in any future change:
//   - emit a "trademark_risk" / "legal_risk" / "clearance" field of any kind,
//   - say a name is "trademark clear", "safe", or "available to trademark",
//   - imply legal safety by omission (an EMPTY result is not a clear result).
//
// KNOWN_BRANDS is a curated in-code convenience set — NOT a marks database,
// not USPTO/EUIPO/WIPO, not exhaustive, and no substitute for a real search.
// The `note` below is emitted on EVERY brand_collision object, in both the
// available and the unavailable shape, and is asserted by the test suite.
// ===========================================================================
const COLLISION_NOTE =
  "Factual name-similarity signal only. Not a trademark search or legal clearance.";

// --- Input limits -----------------------------------------------------------

const MAX_CANDIDATES = 5;
const MAX_TLDS = 10;
const MAX_DEEP_CHECK = 3;
const DEFAULT_DEEP_CHECK = 1;
const DEFAULT_TLDS = ["com", "io", "dev", "app", "net"];

// Same shape bulk-domain accepts: alphanumeric + interior hyphens, 2-63 chars.
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])$/;
const TLD_RE = /^[a-z0-9]{2,24}$/;

// --- Brand-protection registrars --------------------------------------------
// The real tell that a name already belongs to somebody: these registrars sell
// corporate brand protection, not retail domains. A .com parked behind
// MarkMonitor is a brand holder's defensive registration — a hard down-rank
// signal that a plain "taken" flag would lose. Matched case-insensitively as a
// substring of the RDAP registrar name.
const BRAND_PROTECTION_REGISTRARS = [
  "markmonitor",
  "csc corporate domains",
  "cscglobal",
  "com laude",
  "comlaude",
  "safenames",
  "brandsight",
  "brandshelter",
  "nom-iq",
  "ipmirror",
  "netnames",
  "authentic web",
  "ebrandservices",
  "corporation service company",
  "lexsynergy",
];

// --- Known-brand strings (curated, NOT a marks database — see banner) --------
// `core` is always in scope. A `use_case` pulls in that vertical's set AND makes
// it MORE sensitive (a lower similarity threshold), because a fintech name
// colliding with a fintech brand matters more than the same string distance
// against an unrelated consumer brand.
const KNOWN_BRANDS: Record<string, string[]> = {
  core: [
    "google", "apple", "amazon", "microsoft", "meta", "facebook", "instagram",
    "whatsapp", "netflix", "spotify", "tesla", "twitter", "youtube", "tiktok",
    "linkedin", "uber", "airbnb", "adobe", "oracle", "samsung", "intel",
    "nvidia", "cisco", "ibm", "walmart", "nike", "adidas", "disney",
    "starbucks", "mcdonalds", "cocacola", "pepsi", "visa", "mastercard",
    "paypal", "shopify", "salesforce", "slack", "zoom", "dropbox", "github",
    "reddit", "pinterest", "snapchat", "ebay", "alibaba", "sony", "toyota",
    "verizon", "oracle", "openai", "anthropic",
  ],
  fintech: [
    "stripe", "plaid", "revolut", "monzo", "klarna", "venmo", "robinhood",
    "chime", "affirm", "brex", "ramp", "adyen", "marqeta", "sofi", "nubank",
    "starling", "wealthfront", "betterment", "square", "wise",
  ],
  crypto: [
    "coinbase", "binance", "kraken", "gemini", "metamask", "ledger", "uniswap",
    "opensea", "phantom", "solana", "ethereum", "polygon", "chainlink",
    "tether", "bitfinex", "bybit", "blockchain", "ripple",
  ],
  ai: [
    "openai", "anthropic", "claude", "chatgpt", "gemini", "midjourney",
    "huggingface", "perplexity", "cohere", "mistral", "deepmind", "copilot",
    "replicate", "llama",
  ],
  ecommerce: [
    "amazon", "shopify", "etsy", "ebay", "alibaba", "shein", "temu", "wayfair",
    "walmart", "target", "costco",
  ],
  health: [
    "pfizer", "moderna", "novartis", "roche", "bayer", "cigna", "aetna",
    "humana", "teladoc",
  ],
};

// A candidate is a "close match" at or above this normalized similarity.
const CLOSE_MATCH_THRESHOLD = 0.8;
// The use_case-weighted vertical set is held to a LOWER bar (more sensitive).
const WEIGHTED_MATCH_THRESHOLD = 0.72;
// Below this, a resemblance isn't worth reporting at all.
const REPORT_THRESHOLD = 0.65;

// --- Similarity --------------------------------------------------------------

// Leet/homoglyph substitutions, so "g00gle" and "goog1e" collide with "google"
// instead of sliding under the threshold on raw edit distance.
const HOMOGLYPH_FOLD: Record<string, string> = {
  "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s",
};

/** Fold a name to its comparison form: lowercase, de-leeted, hyphens dropped. */
function fold(name: string): string {
  return [...name.toLowerCase()]
    .map((c) => HOMOGLYPH_FOLD[c] ?? c)
    .join("")
    .replace(/-/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = [...curr];
  }
  return prev[b.length];
}

/**
 * Normalized 0-1 similarity between two names, on their folded forms. A name
 * that CONTAINS a brand string of 4+ chars ("getstripe") floors at 0.85 —
 * containment is a resemblance edit distance alone would miss on long names.
 */
function similarity(candidate: string, other: string): number {
  const a = fold(candidate);
  const b = fold(other);
  if (!a || !b) return 0;

  const max = Math.max(a.length, b.length);
  let sim = 1 - levenshtein(a, b) / max;

  if (b.length >= 4 && a.includes(b)) sim = Math.max(sim, 0.85);

  return Math.round(sim * 100) / 100;
}

// --- Types -------------------------------------------------------------------

interface SimilarTo {
  name: string;
  similarity: number;
  source: "typosquat_lookalike" | "known_brand";
}

interface Candidate {
  raw: string;
  name: string;
  /** The candidate's own TLD when it was given as a full domain, else null. */
  tld: string | null;
}

/** Taken domains for one name, with the registrar RDAP reported (may be null). */
interface TakenEntry {
  domain: string;
  registrar: string | null;
}

// --- Brand collision ---------------------------------------------------------
// Exported as an object (not a bare function) so the suite can force the
// unavailable path — same trick as domain-vendor-risk's failureSink. The route
// calls it through this reference and NEVER inlines the logic.
export const brandCollision = {
  /**
   * FACTUAL name-similarity check. See the banner at the top of this file: this
   * is not a trademark search and its output must never be phrased as one.
   *
   * @param name       the bare candidate name (no TLD)
   * @param lookalikes registered look-alike domains from the typosquat scan, or
   *                   null when that scan was unavailable (lowers confidence —
   *                   it does NOT turn into "no collision")
   * @param useCase    optional vertical, weights that brand set more sensitively
   */
  run(
    name: string,
    lookalikes: string[] | null,
    useCase?: string,
  ): {
    available: true;
    has_close_match: boolean;
    similar_to: SimilarTo[];
    confidence: "high" | "medium";
    note: string;
    source: string;
  } {
    const similarTo: SimilarTo[] = [];

    // (a) Registered look-alikes the typosquat scan already surfaced. These are
    //     existing REGISTERED domains — the strongest factual resemblance there
    //     is, because they demonstrably exist.
    for (const domain of lookalikes ?? []) {
      const otherName = domain.split(".")[0];
      const sim = similarity(name, otherName);
      if (sim >= REPORT_THRESHOLD) {
        similarTo.push({ name: domain, similarity: sim, source: "typosquat_lookalike" });
      }
    }

    // (b) The curated well-known-brand strings. use_case pulls its vertical set
    //     into scope and holds it to a lower (more sensitive) threshold.
    const vertical = useCase ? KNOWN_BRANDS[useCase.trim().toLowerCase()] ?? [] : [];
    const weighted = new Set(vertical);
    const brands = new Set([...KNOWN_BRANDS.core, ...vertical]);

    for (const brand of brands) {
      const sim = similarity(name, brand);
      const threshold = weighted.has(brand) ? WEIGHTED_MATCH_THRESHOLD : CLOSE_MATCH_THRESHOLD;
      // Report anything above the reporting floor, but only a hit at or above
      // this brand's own threshold counts toward has_close_match.
      if (sim >= Math.min(threshold, REPORT_THRESHOLD)) {
        similarTo.push({ name: brand, similarity: sim, source: "known_brand" });
      }
    }

    similarTo.sort((a, b) => b.similarity - a.similarity);

    const hasCloseMatch = similarTo.some((s) => {
      if (s.source === "typosquat_lookalike") return s.similarity >= CLOSE_MATCH_THRESHOLD;
      const isWeighted = weighted.has(s.name);
      return s.similarity >= (isWeighted ? WEIGHTED_MATCH_THRESHOLD : CLOSE_MATCH_THRESHOLD);
    });

    return {
      available: true,
      has_close_match: hasCloseMatch,
      similar_to: similarTo.slice(0, 10),
      // Without the typosquat scan we only had the static brand set to compare
      // against — a partial view of reality, so say so.
      confidence: lookalikes === null ? "medium" : "high",
      note: COLLISION_NOTE,
      source: "domain-vet",
    };
  },
};

/** The ONLY shape emitted when the collision check could not run. Never an empty "no match". */
function collisionUnavailable() {
  return { available: false, reason: "unavailable", note: COLLISION_NOTE, source: "domain-vet" };
}

// --- Input normalization -----------------------------------------------------

class InputError extends Error {}

/**
 * Accept a bare name ("satsdesk") or a full domain ("satsdesk.com"), strip a
 * leading www./trailing dot, and reject everything else — IPs, URLs with a
 * scheme or path, whitespace, garbage. Rejection is a 400 BEFORE any work, so
 * a malformed call is never billed.
 */
function normalizeCandidate(raw: unknown): Candidate {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new InputError("candidates must be non-empty strings, e.g. [\"satsdesk\", \"payloop.com\"]");
  }

  const s = raw.trim().toLowerCase();

  // Reject URLs/emails outright rather than silently salvaging a name from them:
  // a caller who sent a URL meant something we can't safely guess at.
  if (/[:/?#@\s]/.test(s)) {
    throw new InputError(
      `Invalid candidate: ${JSON.stringify(raw)} — expected a bare name or domain, e.g. "satsdesk" or "satsdesk.com" (no scheme, path, or spaces)`,
    );
  }

  const cleaned = s.replace(/^www\./, "").replace(/\.$/, "");
  if (net.isIP(cleaned) !== 0) {
    throw new InputError(`Invalid candidate: ${JSON.stringify(raw)} — IP addresses are not domain candidates`);
  }

  const dot = cleaned.indexOf(".");
  const name = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const tld = dot === -1 ? null : cleaned.slice(dot + 1);

  if (!NAME_RE.test(name)) {
    throw new InputError(
      `Invalid candidate: ${JSON.stringify(raw)} — the name must be 2-63 chars, letters/digits/interior hyphens only`,
    );
  }
  if (tld !== null && !TLD_RE.test(tld)) {
    throw new InputError(`Invalid candidate: ${JSON.stringify(raw)} — unrecognized TLD ".${tld}"`);
  }

  return { raw, name, tld };
}

function normalizeTlds(rawTlds: unknown): string[] {
  if (rawTlds === undefined || rawTlds === null) return [...DEFAULT_TLDS];
  if (!Array.isArray(rawTlds) || rawTlds.length === 0) {
    throw new InputError("tlds must be a non-empty array, e.g. [\".com\", \".io\"]");
  }
  if (rawTlds.length > MAX_TLDS) {
    throw new InputError(`tlds cannot exceed ${MAX_TLDS} entries`);
  }

  const out: string[] = [];
  for (const raw of rawTlds) {
    if (typeof raw !== "string") throw new InputError(`Invalid TLD: ${JSON.stringify(raw)}`);
    const tld = raw.trim().toLowerCase().replace(/^\./, "");
    if (!TLD_RE.test(tld)) {
      throw new InputError(`Invalid TLD: ${JSON.stringify(raw)} — expected e.g. ".com" or "io"`);
    }
    if (!out.includes(tld)) out.push(tld);
  }
  return out;
}

function normalizeDeepCheck(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_DEEP_CHECK;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DEEP_CHECK) {
    throw new InputError(`deep_check_top_n must be an integer between 1 and ${MAX_DEEP_CHECK}`);
  }
  return n;
}

// --- Wall-clock budget -------------------------------------------------------

class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

// Share of the wall-clock the breadth pass may consume before it is cut loose.
//
// WHY THIS EXISTS: bulk-domain runs its own budget (an 8s RDAP-bootstrap fetch,
// THEN up to 8s per RDAP lookup — see timeouts.bulkDomain), so on a slow-RDAP
// day it can legitimately outlast this endpoint's entire 12s wall-clock. Giving
// it the whole budget means a cold/slow run returns an all-unavailable shell for
// a $0.20 call. Capping it at 70% leaves a hard floor for the drill-down, whose
// two most valuable checks (appraise + brand-collision) are pure compute and
// always land — so a degraded run still returns real product value.
// Observed live: a cold container burned all 12s here; a warm one, ~6s.
const BREADTH_BUDGET_RATIO = 0.7;

/** Race a sub-call against whatever is left of the request's wall-clock budget. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new TimeoutError());
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), deadline]);
}

// --- Route handler -----------------------------------------------------------

// GET/HEAD return 402 so cold discovery probes see a payment challenge instead
// of a 405 — GET-only crawlers listed this endpoint as dead/priceless (the
// ~3.6k-entry scanner blind spot reported in the CDP Discord, 2026-08-08; this
// was one of the exact paths external mappers probed). Same pattern as classify.
const domainVetPaymentRequired = {
  x402Version: 2,
  accepts: signableAccepts(pricing.domainVet),
  error: "Payment required",
};
domainVetRouter.get("/domain/vet", (_req: Request, res: Response) => {
  res.status(402).json(domainVetPaymentRequired);
});
domainVetRouter.head("/domain/vet", (_req: Request, res: Response) => {
  res.status(402).end();
});

domainVetRouter.post("/domain/vet", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const runId = crypto.randomUUID();

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // 1. Validate + normalize EVERYTHING before any work — a bad call is a free 400.
    let candidates: Candidate[];
    let tlds: string[];
    let deepCheckTopN: number;
    let useCase: string | undefined;

    try {
      // `names` accepted as an alias — it is what bulk-domain calls this, and
      // agents arriving from that endpoint send it.
      const rawCandidates = body.candidates ?? body.names;
      if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
        throw new InputError(
          "candidates is required and must contain at least one name, e.g. {\"candidates\": [\"satsdesk\", \"payloop\"]}",
        );
      }
      if (rawCandidates.length > MAX_CANDIDATES) {
        throw new InputError(`candidates cannot exceed ${MAX_CANDIDATES} entries — received ${rawCandidates.length}`);
      }

      candidates = rawCandidates.map(normalizeCandidate);
      tlds = normalizeTlds(body.tlds);
      deepCheckTopN = normalizeDeepCheck(body.deep_check_top_n);

      if (body.use_case !== undefined && body.use_case !== null) {
        if (typeof body.use_case !== "string") throw new InputError("use_case must be a string, e.g. \"fintech\"");
        useCase = body.use_case;
      }
    } catch (err) {
      if (err instanceof InputError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    // De-duplicate names while preserving the caller's order.
    const seen = new Set<string>();
    const uniq = candidates.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));

    const budget = timeouts.domainVet;
    const deadline = startedAt + budget;
    const remaining = () => deadline - Date.now();

    const signalsUnavailable = new Set<string>();
    const flags = new Set<string>();

    // 2. Breadth pass — every candidate × every TLD, one bulk-domain call.
    //    Bounded to BREADTH_BUDGET_RATIO of the wall-clock so it can never
    //    starve the drill-down (see the constant).
    let bulk: Awaited<ReturnType<typeof runBulkDomain>> | null = null;
    try {
      const breadthBudget = Math.min(remaining(), Math.floor(budget * BREADTH_BUDGET_RATIO));
      bulk = await withTimeout(runBulkDomain(uniq.map((c) => c.name), tlds), breadthBudget);
    } catch (err) {
      // Availability is the ranking signal. Losing it does NOT fail the call and
      // it does NOT read as "available" — every candidate goes unavailable.
      signalsUnavailable.add("bulk-domain");
      flags.add("availability_unavailable");
      console.warn(
        "domain-vet: bulk-domain unavailable:",
        err instanceof Error ? err.message : err,
      );
    }

    // 3. Rank. Availability decides, EXCEPT a name whose registration sits behind
    //    a brand-protection registrar — that is an existing brand holder, so it
    //    is flagged and hard down-ranked no matter how many TLDs are free.
    interface Ranked {
      c: Candidate;
      availability: Record<string, unknown>;
      preferredDomain: string;
      brandProtected: boolean;
      anyAvailable: boolean;
      rank: number;
    }

    const ranked: Ranked[] = uniq.map((c) => {
      const primaryTld = c.tld && tlds.includes(c.tld) ? c.tld : tlds[0];

      if (!bulk) {
        return {
          c,
          availability: { available: false, reason: "unavailable", source: "bulk-domain" },
          preferredDomain: `${c.name}.${primaryTld}`,
          brandProtected: false,
          anyAvailable: false,
          rank: -1, // unknown availability must never outrank a known-good name
        };
      }

      const rows = bulk.results.filter((r) => r.name === c.name);
      const takenRows = rows.filter((r) => !r.available);
      const taken: TakenEntry[] = takenRows.map((r) => ({ domain: r.domain, registrar: r.registrar }));

      const brandProtected = takenRows.some((r) => {
        const reg = (r.registrar ?? "").toLowerCase();
        return reg !== "" && BRAND_PROTECTION_REGISTRARS.some((b) => reg.includes(b));
      });

      const availableRows = rows.filter((r) => r.available);
      const allAvailable = rows.length > 0 && takenRows.length === 0;
      const score = rows.length > 0 ? Math.round((availableRows.length / rows.length) * 100) : 0;

      // The domain we would actually register: the caller's own TLD if it is free,
      // else the first requested TLD that is.
      const preferred =
        availableRows.find((r) => r.tld === primaryTld)?.domain ??
        tlds.map((t) => availableRows.find((r) => r.tld === t)?.domain).find(Boolean) ??
        `${c.name}.${primaryTld}`;

      if (brandProtected) flags.add("brand_protected_registrar");

      return {
        c,
        availability: {
          all_tlds_available: allAvailable,
          taken,
          brand_protected_registrar: brandProtected,
          score,
          source: "bulk-domain",
        },
        preferredDomain: preferred,
        brandProtected,
        anyAvailable: availableRows.length > 0,
        // Brand-protected .com ⇒ a real brand holder exists. -60 sinks it below
        // any name that is merely partially taken.
        rank: score - (brandProtected ? 60 : 0),
      };
    });

    const order = ranked
      .map((r, i) => ({ r, i }))
      .sort((x, y) => y.r.rank - x.r.rank || x.i - y.i) // stable: caller order breaks ties
      .map((x) => x.r);

    // 4. Drill down on the top N only — that is what the observed funnel does
    //    (agents deep-check the winner, not the field), and it is what keeps the
    //    bundle inside its wall-clock. "Winner" means the top USABLE candidates
    //    (the ones eligible for a recommendation); only when none are usable —
    //    or availability is unknown — does the raw ranking decide, so an
    //    all-avoid field still comes back with detail on why.
    const usable = order.filter((r) => !r.brandProtected && r.anyAvailable);
    const deepPool = bulk && usable.length > 0 ? usable : order;
    const deepTargets = deepPool.slice(0, deepCheckTopN);
    const deep = new Map<string, { appraisal: unknown; typosquat: unknown; brand_collision: unknown }>();

    await Promise.all(
      deepTargets.map(async (t) => {
        const domain = t.preferredDomain;

        const [appraiseRes, typoRes] = await Promise.allSettled([
          withTimeout(Promise.resolve().then(() => runDomainAppraise(domain)), remaining()),
          withTimeout(runTyposquat(domain), remaining()),
        ]);

        let appraisal: unknown = null;
        if (appraiseRes.status === "fulfilled") {
          const a = appraiseRes.value;
          const chars = a.characteristics;
          const detail = [
            `${chars.length} chars`,
            chars.pronounceable ? "pronounceable" : "hard to pronounce",
            chars.has_hyphen || chars.has_number
              ? `contains ${[chars.has_hyphen && "hyphen", chars.has_number && "number"].filter(Boolean).join(" + ")}`
              : "no hyphens/numbers",
          ].join(", ");
          appraisal = {
            score: a.value_score,
            tier: a.value_tier,
            detail,
            source: "domain-appraise",
          };
        } else {
          signalsUnavailable.add("domain-appraise");
          appraisal = { available: false, reason: "unavailable", source: "domain-appraise" };
        }

        // The typosquat scan feeds the collision check; when it fails, collision
        // still runs against the static brand set at LOWER confidence.
        let typosquat: unknown;
        let lookalikes: string[] | null = null;
        if (typoRes.status === "fulfilled") {
          const t2 = typoRes.value;
          lookalikes = t2.registered_lookalikes.map((v) => v.domain);
          const ratio = t2.variations_checked > 0 ? t2.registered_count / t2.variations_checked : 0;
          typosquat = {
            registered_lookalikes: t2.registered_count,
            available_defensive: t2.available_count,
            risk: ratio > 0.33 ? "high" : ratio >= 0.15 ? "medium" : "low",
            source: "typosquat",
          };
        } else {
          signalsUnavailable.add("typosquat");
          typosquat = { available: false, reason: "unavailable", source: "typosquat" };
        }

        // ⚠️ Factual similarity only — see the banner. An exception here degrades
        // to an explicit unavailable, NEVER to an empty "no collision found".
        let collision: unknown;
        try {
          collision = brandCollision.run(t.c.name, lookalikes, useCase);
        } catch (err) {
          signalsUnavailable.add("brand-collision");
          collision = collisionUnavailable();
          console.warn(
            "domain-vet: brand-collision unavailable:",
            err instanceof Error ? err.message : err,
          );
        }

        if ((collision as { has_close_match?: boolean }).has_close_match) {
          flags.add("brand_collision_hit");
        }

        deep.set(t.c.name, { appraisal, typosquat, brand_collision: collision });
      }),
    );

    // 5. Verdicts + the pick. The recommendation goes to the best-ranked
    //    candidate that is actually usable — NOT blindly to rank #1: a
    //    brand-protected name with high raw availability can out-rank a viable
    //    rival even after the -60, and an "avoid" must never leave the pick
    //    null while a viable candidate exists.
    let recommendedDomain: string | null = null;
    const firstUsableIdx = bulk
      ? order.findIndex((r) => !r.brandProtected && r.anyAvailable)
      : -1;

    const out = order.map((r, idx) => {
      const d = deep.get(r.c.name);

      let verdict: "recommended" | "viable" | "avoid" | "unavailable";
      if (!bulk) {
        verdict = "unavailable"; // availability unknown ⇒ never a recommendation
      } else if (r.brandProtected || !r.anyAvailable) {
        verdict = "avoid";
      } else if (idx === firstUsableIdx) {
        verdict = "recommended";
      } else {
        verdict = "viable";
      }

      if (verdict === "recommended") recommendedDomain = r.preferredDomain;

      return {
        name: r.c.name,
        preferred_domain: r.preferredDomain,
        availability: r.availability,
        // null = not deep-checked (outside deep_check_top_n) — distinct from an
        // unavailable object, which means it WAS checked and the check failed.
        appraisal: d?.appraisal ?? null,
        typosquat: d?.typosquat ?? null,
        brand_collision: d?.brand_collision ?? null,
        verdict,
      };
    });

    if (bulk && out.every((c) => c.verdict === "avoid")) flags.add("no_viable_candidate");
    if (signalsUnavailable.size > 0) flags.add("signals_degraded");
    if (remaining() <= 0) flags.add("deadline_exceeded");

    // Envelope health, NOT product judgement: a successful composite run scores
    // 100/A even when it is partial or turns up a collision — the endpoint did
    // its job. Both rules below are informational (-0), per the rubric.
    const findings: Array<{ rule: string; deduction: number; detail: string }> = [];
    if (flags.has("brand_collision_hit")) {
      findings.push({
        rule: "brand_collision_hit",
        deduction: 0,
        detail: "A candidate factually resembles an existing registered domain or a well-known brand string (informational)",
      });
    }
    if (signalsUnavailable.size > 0) {
      findings.push({
        rule: "signals_degraded",
        deduction: 0,
        detail: `Sub-check(s) unavailable: ${[...signalsUnavailable].join(", ")}`,
      });
    }

    res.json({
      recommended: recommendedDomain,
      candidates: out,
      flags: [...flags],
      signals_unavailable: [...signalsUnavailable],
      run_id: runId,
      duration_ms: Date.now() - startedAt,
      score: 100,
      grade: "A",
      findings,
    });
  } catch (err) {
    console.error("domain-vet error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
