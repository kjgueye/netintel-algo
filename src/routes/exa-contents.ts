import { Router, type Request, type Response } from "express";
import { timeouts } from "../config.js";
import { ValidationError, validateUrl } from "../utils/validators.js";
import { pickField, pickRequestParam } from "../utils/field-aliases.js";

// GET|POST /exa/contents — Exa page-contents batch resale, the sibling of
// /exa/search (same key read, same error mapping, same llmUsage.costUsd
// stamp — see EXA-SEARCH-HANDOFF.md). Positioned as /web/extract's "when
// direct fetch fails" complement: Exa serves pages that block our egress
// (Cloudflare challenges), JS-rendered pages, and batches up to 3 URLs in one
// call — NOT a replacement for /web/extract's single-URL keyless fetch.
//
// Billing posture (locked): bill on a 2xx with >=1 result carrying non-empty
// text (200 billed, even on partial success — a failed URL's row carries
// status:"error"). A 2xx where EVERY URL failed -> 502 uncharged NO_CONTENT
// (an agent can't use zero pages, and Exa charges $0 for pages it didn't
// return). Exa 400 -> 400 uncharged; 401/403 -> 503; 429 -> 503 (+
// retry_after_seconds); 5xx -> 502; abort -> 504 UPSTREAM_TIMEOUT. Never
// forward caller headers to Exa; never echo costDollars or the key.
//
// We never fetch the caller's URLs ourselves — Exa does, so there is no SSRF
// surface here (see the spec's Gotchas). Do not add a direct-fetch fallback;
// that would reintroduce the SSRF surface this endpoint deliberately lacks.

export const exaContentsRouter = Router();

// The fetch global's Response type, recovered because the express Response
// type imported above shadows it (same pattern as exa-search.ts).
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

interface ContentResultOut {
  url: string;
  status: "success" | "error";
  title: string | null;
  author: string | null;
  published_date: string | null;
  text: string | null;
  char_count: number;
  truncated: boolean;
  error: string | null;
}

// --- Constants ---

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";

const MAX_URLS = 3;
const DEFAULT_MAX_CHARACTERS = 4000;
const MIN_MAX_CHARACTERS = 200;
const MAX_MAX_CHARACTERS = 20000;
const LIVECRAWL_TIMEOUT_MS = 10000;

const ALLOWED_LIVECRAWL = ["fallback", "always", "never", "preferred"] as const;

const URLS_ALIASES = ["urls", "url", "links", "targets"];
const MAX_CHARACTERS_ALIASES = ["max_characters", "maxCharacters", "max_chars", "limit"];
const LIVECRAWL_ALIASES = ["livecrawl", "live"];

const INSTRUCTIVE_URLS_400 =
  'urls is required — pass 1-3 URLs via ?urls=https://a.com,https://b.com (GET, comma-separated) or a JSON ' +
  'body {"urls":["https://a.com"]} (POST). A single URL may also be passed as ?url=. Also accepted: links, targets.';

// --- Param parsing helpers ---

// Normalize for de-dup / join purposes only — never sent upstream in place of
// the original URL (Exa echoes back whatever casing/slash it was given).
function normalizeForMatch(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.href;
  } catch {
    return url;
  }
}

function parseUrls(params: Record<string, unknown>): string[] {
  const raw = pickField(params, URLS_ALIASES);
  if (raw === undefined || raw === null || raw === "") {
    throw new ValidationError(INSTRUCTIVE_URLS_400);
  }
  let items: string[];
  if (Array.isArray(raw)) {
    items = raw.map((v) => String(v).trim()).filter(Boolean);
  } else if (typeof raw === "string") {
    items = raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  } else {
    throw new ValidationError(INSTRUCTIVE_URLS_400);
  }

  // Dedupe by normalized form, preserving first-seen order.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of items) {
    const key = normalizeForMatch(item);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  if (deduped.length === 0) {
    throw new ValidationError(INSTRUCTIVE_URLS_400);
  }
  if (deduped.length > MAX_URLS) {
    throw new ValidationError(
      `at most ${MAX_URLS} urls per call (received ${deduped.length}) — split into multiple calls so you know exactly which pages were fetched`,
    );
  }

  // Validate each is a well-formed http(s) URL (no SSRF check — Exa fetches
  // these, not us; they are data forwarded to a fixed upstream).
  return deduped.map((u) => validateUrl(u).href);
}

function parseMaxCharacters(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MAX_CHARACTERS;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ValidationError(
      `max_characters must be a number between ${MIN_MAX_CHARACTERS} and ${MAX_MAX_CHARACTERS} (received ${JSON.stringify(String(raw))}). Aliases: maxCharacters, max_chars, limit.`,
    );
  }
  return Math.floor(n);
}

function parseLivecrawl(raw: unknown): (typeof ALLOWED_LIVECRAWL)[number] {
  if (raw === undefined || raw === null || raw === "") return "fallback";
  const v = String(raw).trim().toLowerCase();
  if (!(ALLOWED_LIVECRAWL as readonly string[]).includes(v)) {
    throw new ValidationError(
      `livecrawl must be one of: ${ALLOWED_LIVECRAWL.join(", ")} (received ${JSON.stringify(String(raw))}). Alias: live.`,
    );
  }
  return v as (typeof ALLOWED_LIVECRAWL)[number];
}

// --- Route handler (shared by GET and POST) ---

async function handleExaContents(req: Request, res: Response): Promise<void> {
  try {
    // Check FIRST, before any validation — a 503 after settlement would be a
    // refund headache.
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "page contents is not configured on this server" });
      return;
    }

    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const query = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
    // Query wins over body, matching pickRequestParam's convention.
    const params: Record<string, unknown> = { ...body, ...query };

    const urls = parseUrls(params);

    let maxCharacters = parseMaxCharacters(pickField(params, MAX_CHARACTERS_ALIASES));
    if (maxCharacters > MAX_MAX_CHARACTERS) maxCharacters = MAX_MAX_CHARACTERS;
    else if (maxCharacters < MIN_MAX_CHARACTERS) maxCharacters = MIN_MAX_CHARACTERS;

    const livecrawl = parseLivecrawl(pickField(params, LIVECRAWL_ALIASES));

    const exaBody: Record<string, unknown> = {
      urls,
      text: { maxCharacters },
      livecrawl,
      livecrawlTimeout: LIVECRAWL_TIMEOUT_MS,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeouts.exaContents);
    let response: FetchResponse;
    // The body is read under the SAME deadline as the headers: the timer used to
    // be cleared as soon as the headers arrived, so a body that stalled afterwards
    // outlived the advertised timeout. `bodyParsed` is false when the body was not
    // valid JSON — mapped per status below, exactly as the late read used to be.
    let data: any;
    let bodyParsed = false;
    try {
      response = await fetch(EXA_CONTENTS_URL, {
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
          error: `Exa did not respond within ${timeouts.exaContents} ms. You were not charged.`,
          code: "UPSTREAM_TIMEOUT",
        });
        return;
      }
      console.error("Exa contents request error:", err);
      res.status(502).json({ error: "Could not reach the page contents provider. You were not charged." });
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
      res.status(503).json({ error: "page contents provider authentication failed" });
      return;
    }
    if (response.status === 429) {
      const payload: Record<string, unknown> = {
        error: "page contents provider is rate-limiting requests — try again shortly",
      };
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter)) payload.retry_after_seconds = retryAfter;
      res.status(503).json(payload);
      return;
    }
    if (response.status >= 500) {
      res.status(502).json({ error: "page contents provider returned an upstream error. You were not charged." });
      return;
    }
    if (!response.ok) {
      res
        .status(502)
        .json({ error: `page contents provider returned HTTP ${response.status}. You were not charged.` });
      return;
    }

    if (!bodyParsed) {
      res
        .status(502)
        .json({ error: "page contents provider returned an unparsable response. You were not charged." });
      return;
    }

    const rawResults = Array.isArray(data?.results) ? data.results : [];
    const rawStatuses = Array.isArray(data?.statuses) ? data.statuses : [];

    // Join results/statuses by URL, normalized for trailing slash / host case
    // (Exa may reorder, and results[] only covers pages it actually got).
    // Index by BOTH url and id: when contents is requested by URL, Exa's `id`
    // is the URL as we sent it, while `url` may be the canonical/redirected
    // form (http->https, www) — a url-only join would miss those and 502 a
    // page Exa already returned (and charged for).
    const resultsByKey = new Map<string, any>();
    for (const r of rawResults) {
      if (typeof r?.url === "string") resultsByKey.set(normalizeForMatch(r.url), r);
      if (typeof r?.id === "string" && !resultsByKey.has(normalizeForMatch(r.id))) {
        resultsByKey.set(normalizeForMatch(r.id), r);
      }
    }
    // Exa's documented contents contract carries only `id` on statuses[], not
    // `url` — but when contents is requested BY url (as we always do), `id`
    // is the requested url itself. Accept either shape.
    const statusByKey = new Map<string, any>();
    for (const s of rawStatuses) {
      const raw = typeof s?.url === "string" ? s.url : typeof s?.id === "string" ? s.id : undefined;
      if (raw) statusByKey.set(normalizeForMatch(raw), s);
    }

    const findings: Finding[] = [];
    const failedUrls: string[] = [];
    let succeeded = 0;

    // Preserve caller order: output[i] corresponds to input urls[i].
    const results: ContentResultOut[] = urls.map((url) => {
      const key = normalizeForMatch(url);
      const r = resultsByKey.get(key);
      const text = typeof r?.text === "string" && r.text.length > 0 ? r.text : null;

      if (r && text) {
        succeeded++;
        const charCount = text.length;
        return {
          url,
          status: "success",
          title: typeof r?.title === "string" ? r.title : null,
          author: typeof r?.author === "string" ? r.author : null,
          published_date: typeof r?.publishedDate === "string" ? r.publishedDate : null,
          text,
          char_count: charCount,
          truncated: charCount >= maxCharacters,
          error: null,
        };
      }

      const statusEntry = statusByKey.get(key);
      const errorTag =
        typeof statusEntry?.error?.tag === "string" && statusEntry.error.tag ? statusEntry.error.tag : "NO_TEXT";
      failedUrls.push(url);
      return {
        url,
        status: "error",
        title: null,
        author: null,
        published_date: null,
        text: null,
        char_count: 0,
        truncated: false,
        error: errorTag,
      };
    });

    if (succeeded === 0) {
      res.status(502).json({
        error: "none of the requested pages could be retrieved",
        code: "NO_CONTENT",
        results,
      });
      return;
    }

    if (failedUrls.length > 0) {
      findings.push({
        rule: "partial_failure",
        deduction: 0,
        detail: `${failedUrls.length} of ${urls.length} url(s) could not be retrieved: ${failedUrls.join(", ")}`,
      });
    }
    if (results.some((r) => r.truncated)) {
      findings.push({
        rule: "text_truncated",
        deduction: 0,
        detail: `one or more pages hit the max_characters cap (${maxCharacters}) and were truncated by Exa`,
      });
    }

    // COGS stamp — billed path only. costDollars.total is Exa's actual charge;
    // fall back to $0.001/succeeded page when it's missing.
    let costUsd = Number(data?.costDollars?.total);
    if (!Number.isFinite(costUsd)) {
      costUsd = 0.001 * succeeded;
    }
    res.locals.llmUsage = { model: "exa-contents", inputTokens: 0, outputTokens: 0, costUsd };

    res.json({
      results,
      requested: urls.length,
      succeeded,
      provider: "exa",
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Exa contents error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

exaContentsRouter.get("/exa/contents", handleExaContents);
exaContentsRouter.post("/exa/contents", handleExaContents);
