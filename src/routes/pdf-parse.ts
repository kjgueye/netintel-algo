import { Router, type Request, type Response } from "express";
import { timeouts } from "../config.js";
import { validateUrl, ValidationError } from "../utils/validators.js";
import { safeFetch, FetchProblem, isTimeoutError, type SafeFetchResult } from "../utils/safe-fetch.js";
import { describeFetchFailure } from "../utils/fetch-failure.js";
import { pickRequestParam } from "../utils/field-aliases.js";
import { extractPdfText, looksLikePdf, parsePageSpec, PdfError } from "../services/pdf-text.js";

// POST /pdf/parse — a PDF (URL or base64) → Markdown with rebuilt paragraphs,
// per-page offsets, document metadata, and the pages with no text layer.
// Text layer only: no OCR (a scanned PDF is an uncharged 422). Every failure
// that is not a usable answer is a 4xx/5xx, so x402 never settles it.

export const pdfParseRouter = Router();

// Bound the main-thread work one call can cause (pdf.js has no worker in Node).
export const MAX_PAGES = 50;
export const FETCH_CAP_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 100_000;
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 400_000;
const MAX_REDIRECTS = 5;

const URL_ALIASES = ["url", "pdf_url", "document_url", "file_url", "link", "uri"];
const BASE64_ALIASES = ["file_base64", "pdf_base64", "base64", "file", "data", "content"];
// Honest identity, as /web/extract (PDFs are static files; no browser disguise).
const USER_AGENT = "Mozilla/5.0 (compatible; NetIntel/1.0; +https://netintel.dev)";

const EXAMPLE_URL = "https://netintel.dev/samples/pdf-parse-sample.pdf";
const NEED_INPUT =
  `url or file_base64 is required — send a link to the PDF ({"url":"${EXAMPLE_URL}"}) ` +
  `or the file itself as base64 ({"file_base64":"JVBERi0xLjQK…"}; up to ~700 KB, the 1 MB request limit). ` +
  `Optional: pages ("1-3,7", max ${MAX_PAGES}), max_chars (default ${DEFAULT_MAX_CHARS}).`;

type Fetched =
  | { ok: true; bytes: Uint8Array; finalUrl: string; contentType: string }
  | { ok: false; status: number; body: Record<string, unknown> };

function upstreamCode(status: number): string {
  if (status === 404 || status === 410) return "SOURCE_NOT_FOUND";
  if (status === 401 || status === 403 || status === 429) return "SOURCE_BLOCKED";
  return "UPSTREAM_ERROR";
}

async function fetchPdf(parsed: URL): Promise<Fetched> {
  let result: SafeFetchResult;
  try {
    result = await safeFetch(parsed, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/pdf, */*;q=0.5" },
      timeoutMs: timeouts.pdfParseFetch,
      maxRedirects: MAX_REDIRECTS,
      maxBytes: FETCH_CAP_BYTES,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      // Private/reserved/unresolvable target, on the input or any redirect hop.
      return { ok: false, status: 422, body: { error: `${err.message}. You were not charged.`, code: "SSRF_BLOCKED", url: parsed.href } };
    }
    if (err instanceof FetchProblem) {
      return { ok: false, status: err.status, body: { error: err.message, code: err.code, url: parsed.href, ...err.extra } };
    }
    if (isTimeoutError(err)) {
      return {
        ok: false,
        status: 504,
        body: { error: `The source did not finish responding within ${timeouts.pdfParseFetch} ms. You were not charged.`, code: "UPSTREAM_TIMEOUT", url: parsed.href },
      };
    }
    const failure = describeFetchFailure(err);
    console.error("PDF parse fetch failed:", failure.reason, err);
    return { ok: false, status: 502, body: { ...failure, url: parsed.href } };
  }

  if (result.status < 200 || result.status >= 300) {
    // Never mirror an upstream 402: on this surface a 402 is OUR paywall challenge.
    const status = result.status === 402 || (result.status >= 300 && result.status < 400) ? 502 : result.status;
    return {
      ok: false,
      status,
      body: {
        error: `The source returned HTTP ${result.status} — no PDF to parse. You were not charged.`,
        code: upstreamCode(result.status),
        upstream_status: result.status,
        url: parsed.href,
        final_url: result.finalUrl,
      },
    };
  }
  if (result.truncated) {
    return {
      ok: false,
      status: 413,
      body: { error: `The PDF is larger than ${FETCH_CAP_BYTES / 1024 / 1024} MB — too large to parse. You were not charged.`, code: "INPUT_TOO_LARGE", url: parsed.href },
    };
  }
  return { ok: true, bytes: result.bytes, finalUrl: result.finalUrl, contentType: result.contentType };
}

/** Raw base64 or a data: URL → bytes; null when it is not base64 at all. */
export function decodeBase64(raw: string): Uint8Array | null {
  const s = raw.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (!s || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buf.length ? new Uint8Array(buf) : null;
}

function readPagesParam(req: Request): string | undefined {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const v = body.pages ?? body.page ?? body.page_range ?? (req.query as Record<string, unknown>)?.pages;
  if (Array.isArray(v)) return v.join(",");
  if (typeof v === "number") return String(v);
  return typeof v === "string" ? v : undefined;
}

function readMaxChars(req: Request): number {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const v = body.max_chars ?? body.maxChars ?? body.max_length;
  if (v === undefined || v === null || v === "") return DEFAULT_MAX_CHARS;
  const n = Number(v);
  if (!Number.isInteger(n) || n < MIN_MAX_CHARS || n > MAX_MAX_CHARS) {
    throw new ValidationError(`max_chars must be an integer from ${MIN_MAX_CHARS} to ${MAX_MAX_CHARS} — got ${JSON.stringify(v)}`);
  }
  return n;
}

pdfParseRouter.post("/pdf/parse", async (req: Request, res: Response) => {
  try {
    const rawUrl = pickRequestParam(req, URL_ALIASES);
    const rawB64 = pickRequestParam(req, BASE64_ALIASES);
    if (rawUrl && rawB64) throw new ValidationError(`Send url OR file_base64, not both. ${NEED_INPUT}`);
    if (!rawUrl && !rawB64) throw new ValidationError(NEED_INPUT);
    const pages = parsePageSpec(readPagesParam(req), MAX_PAGES);
    const maxChars = readMaxChars(req);

    let bytes: Uint8Array;
    let source: Record<string, unknown>;
    if (rawUrl) {
      const parsed = validateUrl(rawUrl); // http(s) only, no credentials → 400
      const fetched = await fetchPdf(parsed);
      if (!fetched.ok) {
        res.status(fetched.status).json(fetched.body);
        return;
      }
      bytes = fetched.bytes;
      source = { type: "url", url: parsed.href, final_url: fetched.finalUrl, bytes: bytes.length };
      if (!looksLikePdf(bytes)) {
        const ct = fetched.contentType.split(";")[0].trim() || "unknown";
        res.status(415).json({
          error: `The url returned ${ct}, not a PDF (no %PDF- header). For web pages use /web/extract. You were not charged.`,
          code: "NOT_A_PDF",
          content_type: ct,
          url: parsed.href,
        });
        return;
      }
    } else {
      const decoded = decodeBase64(rawB64 as string);
      if (!decoded) throw new ValidationError(`file_base64 is not valid base64. ${NEED_INPUT}`);
      bytes = decoded;
      source = { type: "base64", bytes: bytes.length };
      if (!looksLikePdf(bytes)) {
        res.status(415).json({ error: "file_base64 does not decode to a PDF (no %PDF- header). You were not charged.", code: "NOT_A_PDF" });
        return;
      }
    }

    let doc;
    try {
      doc = await extractPdfText(bytes, { pages, maxPages: MAX_PAGES });
    } catch (err) {
      if (err instanceof PdfError) {
        res.status(422).json({ error: `${err.message}. You were not charged.`, code: err.code });
        return;
      }
      throw err; // ValidationError (page out of range) → 400 below
    }

    const scanned = doc.pages.filter((p) => !p.has_text).map((p) => p.page);
    if (scanned.length === doc.pages.length) {
      res.status(422).json({
        error:
          `None of the ${doc.pages.length} parsed page${doc.pages.length === 1 ? "" : "s"} has a text layer — this looks like a scanned (image-only) PDF. ` +
          "/pdf/parse reads the embedded text layer and does not OCR. You were not charged.",
        code: "NO_TEXT_LAYER",
        page_count: doc.page_count,
        pages_checked: doc.pages.map((p) => p.page),
      });
      return;
    }

    // Assemble one Markdown document with a marker before each page; record
    // each page's [char_start, char_end) so callers can slice and cite pages.
    let markdown = "";
    let truncated = false;
    const pageIndex: Array<{ page: number; word_count: number; has_text: boolean; char_start: number | null; char_end: number | null }> = [];
    for (const p of doc.pages) {
      const block = `<!-- page ${p.page} -->\n\n${p.has_text ? p.markdown : "_(no text layer on this page — likely a scanned image)_"}`;
      const sep = markdown ? "\n\n" : "";
      const room = maxChars - markdown.length - sep.length;
      if (truncated || room < 32) {
        truncated = true;
        pageIndex.push({ page: p.page, word_count: p.word_count, has_text: p.has_text, char_start: null, char_end: null });
        continue;
      }
      const piece = block.length > room ? block.slice(0, room) : block;
      if (piece.length < block.length) truncated = true;
      const start = markdown.length + sep.length;
      markdown += sep + piece;
      pageIndex.push({ page: p.page, word_count: p.word_count, has_text: p.has_text, char_start: start, char_end: markdown.length });
    }

    const findings: string[] = [];
    if (scanned.length) findings.push("scanned_pages_present");
    if (!pages && doc.page_count > MAX_PAGES) findings.push("page_limit_reached");
    if (truncated) findings.push("output_truncated");
    if (doc.failed_pages.length) findings.push("page_render_failed");
    if (doc.metadata.has_form) findings.push("fillable_form");

    res.json({
      source,
      page_count: doc.page_count,
      pages_parsed: doc.pages.length,
      metadata: doc.metadata,
      markdown,
      pages: pageIndex,
      word_count: doc.pages.reduce((n, p) => n + p.word_count, 0),
      char_count: markdown.length,
      scanned_pages: scanned,
      truncated,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message, code: "INVALID_INPUT" });
      return;
    }
    console.error("PDF parse error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
