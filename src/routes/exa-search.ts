import { Router, type Request, type Response } from "express";
import { timeouts } from "../config.js";
import { ValidationError, validateDomain } from "../utils/validators.js";
import { pickField, pickRequestParam } from "../utils/field-aliases.js";

// GET|POST /exa/search + alias GET|POST /web/search — Exa neural web search
// resale. This is a brand-named resale endpoint (like /openai/<model>): the
// value is discovery (agents search the Bazaar by brand — "exa search" / "web
// search") and Solana + Base rails, not a new search engine. Both paths share
// this exact handler; only the discovery description differs (see index.ts).
//
// Billing posture (locked — see EXA-SEARCH-HANDOFF.md): bill ONLY on a 2xx
// with a parsable body, INCLUDING results:[] (a complete "nothing found"
// answer that Exa still charged us for). Exa 400 -> 400 uncharged (caller's
// fault); 401/403 -> 503 uncharged (ops problem, key never exposed); 429 ->
// 503 uncharged (+ retry_after_seconds); 5xx -> 502 uncharged; abort -> 504
// uncharged. Never forward caller headers to Exa; never echo costDollars,
// requestId, or the key.

export const exaSearchRouter = Router();

// The fetch global's Response type, recovered because the express Response
// type imported above shadows it (same pattern as web-fetch.ts).
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

interface SearchResultOut {
  title: string | null;
  url: string;
  published_date: string | null;
  author: string | null;
  score: number | null;
  highlights: string[] | null;
  text: string | null;
}

// --- Constants ---

const EXA_SEARCH_URL = "https://api.exa.ai/search";

// Whole-request payload safety net (query + body combined) — well above any
// legitimate call (a 20-hostname domain list + a 1000-char query is nowhere
// close), but a real 413 ceiling independent of the global 1mb body-parser
// limit in index.ts.
const MAX_REQUEST_BYTES = 16 * 1024;

const MAX_QUERY_CHARS = 1000;
const DEFAULT_NUM_RESULTS = 10;
// Exa list price (exa.ai/docs/reference/pricing, checked 2026-09-05): $0.007
// per request covers up to 10 results; every result above 10 adds $0.001. At
// our flat $0.01 that makes 10 the ceiling — 25 results would cost $0.022.
// Never let a caller cross it, regardless of what they ask for.
const MAX_NUM_RESULTS = 10;
const EXA_SEARCH_BASE_COST_USD = 0.007;
const EXA_PER_PAGE_COST_USD = 0.001;
// Each requested content page (highlights or text) adds $0.001 COGS, so once
// snippets are on, num_results is clamped further to bound worst-case cost
// ($0.007 + 2 x $0.001 = $0.009 against the $0.01 price).
const MAX_NUM_RESULTS_WITH_SNIPPETS = 2;
const MAX_DOMAINS = 20;

const ALLOWED_TYPES = ["auto", "neural", "keyword", "fast"] as const;
const ALLOWED_CATEGORIES = [
  "company",
  "research paper",
  "news",
  "pdf",
  "github",
  "tweet",
  "personal site",
  "linkedin profile",
  "financial report",
] as const;
const ALLOWED_SNIPPETS = ["none", "highlights", "text"] as const;

const QUERY_ALIASES = ["query", "q", "search", "prompt", "text"];
const NUM_RESULTS_ALIASES = ["num_results", "numResults", "limit", "n", "count"];
const TYPE_ALIASES = ["type", "search_type", "mode"];
const CATEGORY_ALIASES = ["category"];
const INCLUDE_DOMAIN_ALIASES = ["include_domains", "includeDomains", "domains", "site"];
const EXCLUDE_DOMAIN_ALIASES = ["exclude_domains", "excludeDomains"];
const START_DATE_ALIASES = ["start_published_date", "startPublishedDate", "since", "from_date"];
const END_DATE_ALIASES = ["end_published_date", "endPublishedDate", "until", "to_date"];
const SNIPPETS_ALIASES = ["snippets", "contents"];

const INSTRUCTIVE_QUERY_400 =
  'query is required — pass a search query via ?query= (GET) or a JSON body {"query":"..."} (POST). ' +
  "Also accepted: q, search, prompt, text.";

// --- Param parsing helpers ---

function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  return false;
}

function parseType(raw: unknown): (typeof ALLOWED_TYPES)[number] {
  if (raw === undefined || raw === null || raw === "") return "auto";
  const v = String(raw).trim().toLowerCase();
  if (!(ALLOWED_TYPES as readonly string[]).includes(v)) {
    throw new ValidationError(
      `type must be one of: ${ALLOWED_TYPES.join(", ")} (received ${JSON.stringify(String(raw))}). Aliases: search_type, mode.`,
    );
  }
  return v as (typeof ALLOWED_TYPES)[number];
}

function parseCategory(raw: unknown): (typeof ALLOWED_CATEGORIES)[number] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const normalized = String(raw).trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!(ALLOWED_CATEGORIES as readonly string[]).includes(normalized)) {
    throw new ValidationError(
      `category must be one of: ${ALLOWED_CATEGORIES.join(", ")} (received ${JSON.stringify(String(raw))})`,
    );
  }
  return normalized as (typeof ALLOWED_CATEGORIES)[number];
}

function parseDomainList(raw: unknown, fieldName: string): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  let items: string[];
  if (Array.isArray(raw)) {
    items = raw.map((v) => String(v).trim()).filter(Boolean);
  } else if (typeof raw === "string") {
    items = raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  } else {
    throw new ValidationError(`${fieldName} must be a comma-separated string or an array of hostnames`);
  }
  if (items.length > MAX_DOMAINS) {
    throw new ValidationError(`${fieldName} accepts at most ${MAX_DOMAINS} hostnames (received ${items.length})`);
  }
  return items.map((d) => validateDomain(d));
}

function parseDateParam(raw: unknown, fieldName: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const str = String(raw).trim();
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(
      `${fieldName} must be a valid ISO 8601 date or datetime (received ${JSON.stringify(str)})`,
    );
  }
  return d.toISOString();
}

function parseNumResults(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_NUM_RESULTS;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ValidationError(
      `num_results must be a number between 1 and ${MAX_NUM_RESULTS} (received ${JSON.stringify(String(raw))}). Aliases: numResults, limit, n, count.`,
    );
  }
  return Math.floor(n);
}

function parseSnippets(params: Record<string, unknown>): (typeof ALLOWED_SNIPPETS)[number] {
  const raw = pickField(params, SNIPPETS_ALIASES);
  if (raw !== undefined && raw !== null && raw !== "") {
    const v = String(raw).trim().toLowerCase();
    if (!(ALLOWED_SNIPPETS as readonly string[]).includes(v)) {
      throw new ValidationError(
        `snippets must be one of: ${ALLOWED_SNIPPETS.join(", ")} (received ${JSON.stringify(String(raw))})`,
      );
    }
    return v as (typeof ALLOWED_SNIPPETS)[number];
  }
  if (truthy(params["include_text"])) return "text";
  if (truthy(params["include_highlights"])) return "highlights";
  return "none";
}

// --- Route handler (shared by GET and POST, /exa/search and /web/search) ---

async function handleExaSearch(req: Request, res: Response): Promise<void> {
  try {
    // Check FIRST, before any validation — ops needs to see this immediately,
    // and a 503 after settlement would be a refund headache.
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "web search is not configured on this server" });
      return;
    }

    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const query = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
    // Query wins over body, matching pickRequestParam's convention.
    const params: Record<string, unknown> = { ...body, ...query };

    const approxBytes = Buffer.byteLength(JSON.stringify(params), "utf8");
    if (approxBytes > MAX_REQUEST_BYTES) {
      res.status(413).json({
        error: `Request payload exceeds the ${MAX_REQUEST_BYTES}-byte limit (~${approxBytes} bytes received). Send a smaller query/filter set. You were not charged.`,
      });
      return;
    }

    const rawQuery = pickRequestParam(req, QUERY_ALIASES);
    if (!rawQuery) {
      res.status(400).json({ error: INSTRUCTIVE_QUERY_400 });
      return;
    }
    if (rawQuery.length > MAX_QUERY_CHARS) {
      res.status(400).json({
        error: `query must be ${MAX_QUERY_CHARS} characters or fewer (received ${rawQuery.length})`,
      });
      return;
    }

    const findings: Finding[] = [];
    const type = parseType(pickField(params, TYPE_ALIASES));
    const category = parseCategory(pickField(params, CATEGORY_ALIASES));
    const includeDomains = parseDomainList(pickField(params, INCLUDE_DOMAIN_ALIASES), "include_domains");
    const excludeDomains = parseDomainList(pickField(params, EXCLUDE_DOMAIN_ALIASES), "exclude_domains");
    const startPublishedDate = parseDateParam(pickField(params, START_DATE_ALIASES), "start_published_date");
    const endPublishedDate = parseDateParam(pickField(params, END_DATE_ALIASES), "end_published_date");
    const snippets = parseSnippets(params);

    let numResults = parseNumResults(pickField(params, NUM_RESULTS_ALIASES));
    if (numResults > MAX_NUM_RESULTS) {
      findings.push({
        rule: "num_results_clamped",
        deduction: 0,
        detail: `num_results ${numResults} exceeds the ${MAX_NUM_RESULTS}-result maximum and was clamped to ${MAX_NUM_RESULTS}`,
      });
      numResults = MAX_NUM_RESULTS;
    } else if (numResults < 1) {
      numResults = 1;
    }
    if (snippets !== "none" && numResults > MAX_NUM_RESULTS_WITH_SNIPPETS) {
      findings.push({
        rule: "snippets_clamps_results",
        deduction: 0,
        detail: `snippets=${snippets} requests page content (+$0.001/result COGS), which clamps num_results to ${MAX_NUM_RESULTS_WITH_SNIPPETS}; requested ${numResults}`,
      });
      numResults = MAX_NUM_RESULTS_WITH_SNIPPETS;
    }

    // Build the Exa body from ONLY the validated fields above — never spread
    // the caller's raw body, or they could smuggle numResults:100 or a
    // contents block requesting every content type at once.
    const exaBody: Record<string, unknown> = {
      query: rawQuery,
      type,
      numResults,
    };
    if (category) exaBody.category = category;
    if (includeDomains.length) exaBody.includeDomains = includeDomains;
    if (excludeDomains.length) exaBody.excludeDomains = excludeDomains;
    if (startPublishedDate) exaBody.startPublishedDate = startPublishedDate;
    if (endPublishedDate) exaBody.endPublishedDate = endPublishedDate;
    if (snippets === "text") {
      exaBody.contents = { text: { maxCharacters: 1500 } };
    } else if (snippets === "highlights") {
      exaBody.contents = { highlights: { numSentences: 2, highlightsPerUrl: 2 } };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeouts.exaSearch);
    let response: FetchResponse;
    // The body is read under the SAME deadline as the headers: the timer used to
    // be cleared as soon as the headers arrived, so a body that stalled afterwards
    // outlived the advertised timeout. `bodyParsed` is false when the body was not
    // valid JSON — mapped per status below, exactly as the late read used to be.
    let data: any;
    let bodyParsed = false;
    try {
      response = await fetch(EXA_SEARCH_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(exaBody),
        signal: controller.signal,
      });
      try {
        data = await response.json();
        bodyParsed = true;
      } catch (err) {
        // Our deadline abort landing mid-body is a timeout, not a parse failure.
        if ((err as { name?: string })?.name === "AbortError") throw err;
      }
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "AbortError") {
        res.status(504).json({
          error: `Exa did not respond within ${timeouts.exaSearch} ms. You were not charged.`,
          code: "UPSTREAM_TIMEOUT",
        });
        return;
      }
      console.error("Exa search request error:", err);
      res.status(502).json({ error: "Could not reach the search provider. You were not charged." });
      return;
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 400) {
      let message = "Exa rejected the request";
      if (bodyParsed) {
        const errBody = data as { error?: unknown; message?: unknown };
        if (typeof errBody?.error === "string") message = errBody.error;
        else if (typeof errBody?.message === "string") message = errBody.message;
      } // else: unparsable error body → the generic message
      res.status(400).json({ error: message });
      return;
    }
    if (response.status === 401 || response.status === 403) {
      // Never expose the key or hint at auth internals — this is an ops problem.
      res.status(503).json({ error: "search provider authentication failed" });
      return;
    }
    if (response.status === 429) {
      const payload: Record<string, unknown> = {
        error: "search provider is rate-limiting requests — try again shortly",
      };
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter)) payload.retry_after_seconds = retryAfter;
      res.status(503).json(payload);
      return;
    }
    if (response.status >= 500) {
      res.status(502).json({ error: "search provider returned an upstream error. You were not charged." });
      return;
    }
    if (!response.ok) {
      res.status(502).json({ error: `search provider returned HTTP ${response.status}. You were not charged.` });
      return;
    }

    if (!bodyParsed) {
      res.status(502).json({ error: "search provider returned an unparsable response. You were not charged." });
      return;
    }

    const rawResults = Array.isArray(data?.results) ? data.results : [];
    const mapped: SearchResultOut[] = rawResults.map((r: any) => ({
      title: typeof r?.title === "string" ? r.title : null,
      url: typeof r?.url === "string" ? r.url : "",
      published_date: typeof r?.publishedDate === "string" ? r.publishedDate : null,
      author: typeof r?.author === "string" ? r.author : null,
      score: typeof r?.score === "number" ? r.score : null,
      highlights: snippets === "highlights" ? (Array.isArray(r?.highlights) ? r.highlights : []) : null,
      text: snippets === "text" ? (typeof r?.text === "string" ? r.text : null) : null,
    }));

    if (mapped.length === 0) {
      findings.push({
        rule: "no_results",
        deduction: 0,
        detail: "Exa returned zero results for this query/filter combination",
      });
    }

    // COGS stamp — billed path only. costDollars.total is Exa's actual charge;
    // fall back to the list-price estimate when it's missing (base request +
    // $0.001 per result above 10 + $0.001 per content page when snippets on).
    let costUsd = Number(data?.costDollars?.total);
    if (!Number.isFinite(costUsd)) {
      costUsd =
        EXA_SEARCH_BASE_COST_USD +
        Math.max(0, mapped.length - 10) * EXA_PER_PAGE_COST_USD +
        (snippets !== "none" ? mapped.length * EXA_PER_PAGE_COST_USD : 0);
    }
    res.locals.llmUsage = { model: "exa-search", inputTokens: 0, outputTokens: 0, costUsd };

    res.json({
      query: rawQuery,
      search_type: typeof data?.resolvedSearchType === "string" ? data.resolvedSearchType : type,
      num_results: mapped.length,
      results: mapped,
      provider: "exa",
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Exa search error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

exaSearchRouter.get("/exa/search", handleExaSearch);
exaSearchRouter.post("/exa/search", handleExaSearch);
exaSearchRouter.get("/web/search", handleExaSearch);
exaSearchRouter.post("/web/search", handleExaSearch);
