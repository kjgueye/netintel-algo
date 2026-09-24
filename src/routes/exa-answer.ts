import { Router, type Request, type Response } from "express";
import { timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { pickField, pickRequestParam } from "../utils/field-aliases.js";

// GET|POST /exa/answer — Exa web-grounded answer resale, the third sibling of
// /exa/search and /exa/contents (same key read, same error mapping, same
// llmUsage.costUsd stamp — see EXA-SEARCH-HANDOFF.md). Exa does BOTH the
// retrieval and the generation here — no OpenAI call on our side, so COGS is
// one fixed $0.005 per query (citation text included — Exa does not bill it,
// verified against a real costDollars.total on 2026-09-05).
//
// Billing posture (locked): a 2xx with a non-empty `answer` string bills 200,
// even with zero citations — Exa still produced (and charged for) an answer.
// A 2xx with an empty/missing `answer` -> 502 uncharged NO_ANSWER. Exa 400 ->
// 400 uncharged; 401/403 -> 503; 429 -> 503 (+ retry_after_seconds); 5xx ->
// 502; abort -> 504 UPSTREAM_TIMEOUT. Never forward caller headers to Exa;
// never echo costDollars or the key.
//
// `stream` is hard-coded false — a streamed body would hang the JSON parse
// until the abort timer and 504 a call Exa already charged for. We never
// strip the inline [n] markers from `answer`, and our citation `index`
// numbering follows Exa's citations[] order so the markers map correctly.

export const exaAnswerRouter = Router();

// The fetch global's Response type, recovered because the express Response
// type imported above shadows it (same pattern as exa-search.ts).
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

interface CitationOut {
  index: number;
  title: string | null;
  url: string;
  published_date: string | null;
  author: string | null;
  text: string | null;
}

// --- Constants ---

const EXA_ANSWER_URL = "https://api.exa.ai/answer";

// Whole-request payload safety net (query + body combined) — a real 413
// ceiling independent of the global 1mb body-parser limit in index.ts.
const MAX_REQUEST_BYTES = 8 * 1024;

const MIN_QUERY_CHARS = 3;
const MAX_QUERY_CHARS = 1000;

// Per-citation text cap when include_citation_text is on. This is a payload
// size guard, NOT a COGS guard: a paid prod probe on 2026-09-05 (8 citations,
// text:true) logged costDollars.total = $0.005 — Exa does not bill citation
// text on /answer. 8 x 4000 chars keeps the response ~32 KB worst case.
const CITATION_TEXT_MAX_CHARS = 4000;

// `text` is deliberately NOT a query alias here (unlike exa-search): it is the
// Exa-native name for the include_citation_text flag, and a bare {text:true}
// must not become the query "true".
const QUERY_ALIASES = ["query", "q", "question", "prompt"];
const CITATION_TEXT_ALIASES = ["include_citation_text", "text", "with_text"];

const INSTRUCTIVE_QUERY_400 =
  'query is required — pass a question via ?query= (GET) or a JSON body {"query":"..."} (POST). ' +
  "Also accepted: q, question, prompt.";

// --- Param parsing helpers ---

function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  return false;
}

// --- Route handler (shared by GET and POST) ---

async function handleExaAnswer(req: Request, res: Response): Promise<void> {
  try {
    // Check FIRST, before any validation — a 503 after settlement would be a
    // refund headache.
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) {
      res.status(503).json({ error: "web answers are not configured on this server" });
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
        error: `Request payload exceeds the ${MAX_REQUEST_BYTES}-byte limit (~${approxBytes} bytes received). Send a smaller query. You were not charged.`,
      });
      return;
    }

    const rawQuery = pickRequestParam(req, QUERY_ALIASES);
    if (!rawQuery) {
      res.status(400).json({ error: INSTRUCTIVE_QUERY_400 });
      return;
    }
    if (rawQuery.length < MIN_QUERY_CHARS) {
      res.status(400).json({
        error: `query must be at least ${MIN_QUERY_CHARS} characters (received ${rawQuery.length})`,
      });
      return;
    }
    if (rawQuery.length > MAX_QUERY_CHARS) {
      res.status(400).json({
        error: `query must be ${MAX_QUERY_CHARS} characters or fewer (received ${rawQuery.length})`,
      });
      return;
    }

    const includeCitationText = truthy(pickField(params, CITATION_TEXT_ALIASES));

    const exaBody: Record<string, unknown> = {
      query: rawQuery,
      text: includeCitationText,
      stream: false,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeouts.exaAnswer);
    let response: FetchResponse;
    // The body is read under the SAME deadline as the headers: the timer used to
    // be cleared as soon as the headers arrived, so a body that stalled afterwards
    // outlived the advertised timeout. `bodyParsed` is false when the body was not
    // valid JSON — mapped per status below, exactly as the late read used to be.
    let data: any;
    let bodyParsed = false;
    try {
      response = await fetch(EXA_ANSWER_URL, {
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
          error: `Exa did not respond within ${timeouts.exaAnswer} ms. You were not charged.`,
          code: "UPSTREAM_TIMEOUT",
        });
        return;
      }
      console.error("Exa answer request error:", err);
      res.status(502).json({ error: "Could not reach the answer provider. You were not charged." });
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
      res.status(503).json({ error: "answer provider authentication failed" });
      return;
    }
    if (response.status === 429) {
      const payload: Record<string, unknown> = {
        error: "answer provider is rate-limiting requests — try again shortly",
      };
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter)) payload.retry_after_seconds = retryAfter;
      res.status(503).json(payload);
      return;
    }
    if (response.status >= 500) {
      res.status(502).json({ error: "answer provider returned an upstream error. You were not charged." });
      return;
    }
    if (!response.ok) {
      res.status(502).json({ error: `answer provider returned HTTP ${response.status}. You were not charged.` });
      return;
    }

    if (!bodyParsed) {
      res.status(502).json({ error: "answer provider returned an unparsable response. You were not charged." });
      return;
    }

    const answer = typeof data?.answer === "string" ? data.answer.trim() : "";
    if (!answer) {
      res.status(502).json({ error: "the search provider returned no answer", code: "NO_ANSWER" });
      return;
    }

    const rawCitations = Array.isArray(data?.citations) ? data.citations : [];
    const findings: Finding[] = [];

    if (rawCitations.length === 0) {
      findings.push({
        rule: "no_citations",
        deduction: 0,
        detail: "Exa produced an answer with zero supporting citations",
      });
    }

    let truncatedCount = 0;
    const citations: CitationOut[] = rawCitations.map((c: any, i: number) => {
      let text: string | null =
        includeCitationText && typeof c?.text === "string" && c.text.length > 0 ? c.text : null;
      if (text && text.length > CITATION_TEXT_MAX_CHARS) {
        text = text.slice(0, CITATION_TEXT_MAX_CHARS);
        truncatedCount++;
      }
      return {
        index: i + 1,
        title: typeof c?.title === "string" ? c.title : null,
        url: typeof c?.url === "string" ? c.url : "",
        published_date: typeof c?.publishedDate === "string" ? c.publishedDate : null,
        author: typeof c?.author === "string" ? c.author : null,
        text,
      };
    });

    if (truncatedCount > 0) {
      findings.push({
        rule: "citation_text_truncated",
        deduction: 0,
        detail: `${truncatedCount} citation text(s) exceeded ${CITATION_TEXT_MAX_CHARS} characters and were truncated`,
      });
    }

    // COGS stamp — billed path only. costDollars.total is Exa's actual charge;
    // fall back to the $0.005 list price when it's missing (citation text is
    // not billed — verified against a real costDollars.total, see above).
    let costUsd = Number(data?.costDollars?.total);
    if (!Number.isFinite(costUsd)) {
      costUsd = 0.005;
    }
    res.locals.llmUsage = { model: "exa-answer", inputTokens: 0, outputTokens: 0, costUsd };

    res.json({
      query: rawQuery,
      answer,
      citations,
      citation_count: citations.length,
      provider: "exa",
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Exa answer error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

exaAnswerRouter.get("/exa/answer", handleExaAnswer);
exaAnswerRouter.post("/exa/answer", handleExaAnswer);
