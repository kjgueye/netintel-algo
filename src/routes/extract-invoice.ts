import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { pricing, timeouts } from "../config.js";
import { fmtReceived, validateUrl, ValidationError } from "../utils/validators.js";
import { safeFetch, FetchProblem, isTimeoutError, type SafeFetchResult } from "../utils/safe-fetch.js";
// pdf-parse ships no type declarations, and its package entrypoint (index.js)
// runs debug code on import that reads a bundled test PDF off disk — which
// throws under ESM where `module.parent` is undefined. Import the library
// module directly to dodge that side effect (same as web-extract).
// @ts-ignore -- no types for the lib subpath
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { parseLooseJson } from "../utils/parse-loose-json.js";
import { signableAccepts } from "../accepts.js";
import { openaiJsonComplete, OpenAiCallError } from "../services/openai-json.js";

export const extractInvoiceRouter = Router();

// Input cap shared across the Batch-3 LLM extraction endpoints: reject input
// over 10k words OR 50KB, whichever trips first. A long invoice or receipt
// paste could realistically approach this, so the cap is enforced before any
// LLM call.
const MAX_WORDS = 10000;
const MAX_BYTES = 50 * 1024;

// Invoices have variable-length line-item lists — give the model room so a long
// itemized invoice does not get truncated mid-array.
const MAX_TOKENS = 2048;

// Swapped from Anthropic Haiku to gpt-4o-mini 2026-09-02 (see the pricing
// deep-dive / src/services/openai-json.ts); the shared helper self-manages the
// wall-clock timeout and aborts the upstream request.
const MODEL = "gpt-4o-mini";

// Sum of line-item amounts + tax must land within $0.02 of the stated total for
// the invoice to "reconcile".
const RECONCILE_TOLERANCE = 0.02;

const SERVICE_SLUG = "extract-invoice";

// URL mode: stop reading an upstream body past 5MB (PDFs can dwarf HTML); a
// runaway download must never balloon memory. Distinct from MAX_BYTES, which
// caps the EXTRACTED text fed to the LLM.
const FETCH_READ_CAP = 5 * 1024 * 1024;

// In-memory cache (best-effort, in-process Map ONLY — NOT Postgres, NOT Upstash).
// Postgres is the durable event log, not a cache. This is wiped on every
// deploy/restart and only ever holds successful (200) extractions, never errors.
// Keyed by serviceSlug + ":" + sha256(input); TTL 3600s; capped at MAX_CACHE_ENTRIES
// with FIFO eviction so a burst of unique inputs cannot balloon memory.
const CACHE_TTL_MS = 3600 * 1000;
const MAX_CACHE_ENTRIES = 500;
type CachedInvoice = {
  invoice: InvoiceFields;
  line_item_count: number;
  totals_reconcile: boolean | null;
  score: number;
  grade: string;
  findings: string[];
};
const cache = new Map<string, { value: CachedInvoice; expires: number }>();

function cacheKey(input: string): string {
  return SERVICE_SLUG + ":" + crypto.createHash("sha256").update(input).digest("hex");
}

function cacheGet(key: string): CachedInvoice | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: CachedInvoice): void {
  // FIFO eviction: drop the oldest inserted key once at capacity.
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

type LineItem = {
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  amount: number | null;
};

type InvoiceFields = {
  vendor: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  line_items: LineItem[];
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  currency: string | null;
};

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404
const extractInvoicePaymentRequired = {
  x402Version: 2,
  accepts: signableAccepts(pricing.extractInvoice),
  error: "Payment required",
};

extractInvoiceRouter.get("/extract/invoice", (_req: Request, res: Response) => {
  res.status(402).json(extractInvoicePaymentRequired);
});

extractInvoiceRouter.head("/extract/invoice", (_req: Request, res: Response) => {
  res.status(402).end();
});

function gradeFromScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function parseLineItems(value: unknown): LineItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const li = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      description: asStringOrNull(li.description),
      quantity: asNumberOrNull(li.quantity),
      unit_price: asNumberOrNull(li.unit_price),
      amount: asNumberOrNull(li.amount),
    };
  });
}

// gpt-4o-mini runs in response_format:json_object mode (via openaiJsonComplete),
// which requires the word "json" in the prompt and — unlike the previous Anthropic
// structured-output schema — no longer constrains the shape, so the prompt now
// enumerates the exact keys the parser reads. parseLooseJson + the defensive
// "not an object" guard cover any malformed reply.
const SYSTEM_PROMPT =
  "You are a precise invoice and receipt data extraction engine. Extract structured data from the invoice or receipt text the user provides. " +
  "Respond with ONLY a JSON object (no preamble, no markdown, no code fences) with exactly these keys: " +
  '{"vendor": str|null, "invoice_number": str|null, "invoice_date": str|null, "due_date": str|null, ' +
  '"line_items": [ {"description": str|null, "quantity": number|null, "unit_price": number|null, "amount": number|null} ], ' +
  '"subtotal": number|null, "tax": number|null, "total": number|null, "currency": str|null}. ' +
  "Numbers must be numbers, not strings. Dates as ISO 8601 (YYYY-MM-DD) where possible. line_items is an empty array if none are found. Use null for any field that is not present. Do not invent values. " +
  "If the text contains no invoice or receipt content at all (e.g. it is an instruction, question, or unrelated prose), set every field to null and line_items to []. This is an extraction task: always parse whatever is submitted, never refuse.";

// Result of a single attempt: either parsed fields, or a signal that the call was truncated.
type AttemptResult =
  | { ok: true; fields: InvoiceFields; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; truncated: true };

async function attemptExtract(text: string): Promise<AttemptResult> {
  // openaiJsonComplete self-manages a hard wall-clock timeout (aborts the
  // upstream request) — no caller-supplied AbortSignal needed.
  const { content, usage, truncated } = await openaiJsonComplete({
    modelId: MODEL,
    system: SYSTEM_PROMPT,
    user: text,
    maxTokens: MAX_TOKENS,
    timeoutMs: timeouts.extractInvoice,
  });

  // Truncation guard: if the model hit the output cap the JSON may be partial/invalid.
  // Treat as a failed extraction (502), never parse/return partial JSON as a 200.
  if (truncated) {
    return { ok: false, truncated: true };
  }

  const parsed = parseLooseJson(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("not an object");
  }

  const p = parsed as Record<string, unknown>;
  return {
    ok: true,
    fields: {
      vendor: asStringOrNull(p.vendor),
      invoice_number: asStringOrNull(p.invoice_number),
      invoice_date: asStringOrNull(p.invoice_date),
      due_date: asStringOrNull(p.due_date),
      line_items: parseLineItems(p.line_items),
      subtotal: asNumberOrNull(p.subtotal),
      tax: asNumberOrNull(p.tax),
      total: asNumberOrNull(p.total),
      currency: asStringOrNull(p.currency),
    },
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
  };
}

// --- URL input mode: fetch the invoice document and extract its text ---

// Attached per-request OUTSIDE the cached payload — two URLs can yield
// identical text (and share a cache entry), so `source` is never cached.
type SourceInfo = {
  type: "text" | "url";
  url: string | null;
  content_type: "pdf" | "html" | "text" | null;
};

const TEXT_SOURCE: SourceInfo = { type: "text", url: null, content_type: null };

// Regex-strip HTML down to plain text. Deliberately simple — invoices don't
// need document structure, only their visible text (amounts, dates, vendor).
function htmlToPlainText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ");
  // Block-ish boundaries become newlines so line items stay on their own lines.
  s = s.replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
  return s
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

type FetchedDoc =
  | { ok: true; text: string; contentType: "pdf" | "html" | "text" }
  | { ok: false; status: number; body: { error: string; code: string } };

// Cap redirect hops (matches web-extract). safeFetch SSRF-checks each hop
// before requesting it, so a redirect chain can't smuggle in an internal address.
const MAX_FETCH_REDIRECTS = 3;

async function fetchInvoiceDocument(rawUrl: string): Promise<FetchedDoc> {
  // Server-side fetch of a caller-controlled URL — SSRF check is mandatory.
  // validateUrl enforces http(s) + throws ValidationError (→ instructive 400).
  const parsed = validateUrl(rawUrl);

  let fetched: SafeFetchResult;
  try {
    // Shared hop-checked fetcher: EVERY hop is SSRF-checked before it is
    // requested (a public URL that 302s to 169.254.169.254 / an RFC-1918 host
    // is refused, never fetched), redirects are capped, and ONE deadline
    // covers every hop plus the capped body read.
    fetched = await safeFetch(parsed, {
      headers: { accept: "application/pdf, text/html, text/plain, */*" },
      timeoutMs: timeouts.extractInvoiceFetch,
      maxRedirects: MAX_FETCH_REDIRECTS,
      maxBytes: FETCH_READ_CAP,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      return {
        ok: false,
        status: 504,
        body: { error: "Could not fetch url — upstream fetch timed out", code: "UPSTREAM_TIMEOUT" },
      };
    }
    // The helper's per-hop SSRF check throws ValidationError on a private/
    // reserved redirect target; rethrow so the handler's catch renders the
    // instructive 400 (never leak it as a generic 502 — the caller should
    // learn the URL was blocked).
    if (err instanceof ValidationError) throw err;
    if (err instanceof FetchProblem) {
      if (err.code === "TOO_MANY_REDIRECTS") {
        return {
          ok: false,
          status: 502,
          body: { error: "Could not fetch url — too many redirects", code: "UPSTREAM_ERROR" },
        };
      }
      // Non-http(s) or unparseable Location — the helper's own status/code.
      return { ok: false, status: err.status, body: { error: err.message, code: err.code } };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 502,
      body: { error: `Could not fetch url — ${message}`, code: "UPSTREAM_ERROR" },
    };
  }

  if (!fetched.ok) {
    return {
      ok: false,
      status: 502,
      body: {
        error: `Could not fetch url — upstream returned HTTP ${fetched.status}`,
        code: "UPSTREAM_ERROR",
      },
    };
  }

  if (fetched.truncated) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "Fetched document exceeds the 5MB fetch cap — url must point to a reasonably sized invoice document",
        code: "INPUT_TOO_LARGE",
      },
    };
  }

  const ct = fetched.contentType.toLowerCase();
  // finalUrl is the last hop's URL (response.url when present, else the
  // requested hop) — the same precedence the manual loop used.
  let finalPathname = parsed.pathname.toLowerCase();
  try {
    finalPathname = new URL(fetched.finalUrl).pathname.toLowerCase();
  } catch {
    // keep the requested pathname
  }
  const head = fetched.bytes.subarray(0, 1024).toString("latin1");

  const looksPdf =
    ct.includes("application/pdf") ||
    finalPathname.endsWith(".pdf") ||
    parsed.pathname.toLowerCase().endsWith(".pdf") ||
    head.startsWith("%PDF");
  const looksHtml = ct.includes("text/html") || /^\s*<(?:!doctype|html|head|body)/i.test(head);

  if (looksPdf) {
    let parsedPdf: { text?: string };
    try {
      parsedPdf = await pdfParse(fetched.bytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 502,
        body: { error: `PDF parsing failed: ${message}`, code: "PDF_PARSE_ERROR" },
      };
    }
    return { ok: true, text: (parsedPdf.text || "").trim(), contentType: "pdf" };
  }
  if (looksHtml) {
    return { ok: true, text: htmlToPlainText(fetched.bytes.toString("utf8")), contentType: "html" };
  }
  if (ct.startsWith("text/") || ct.includes("application/json")) {
    return { ok: true, text: fetched.bytes.toString("utf8"), contentType: "text" };
  }
  return {
    ok: false,
    status: 400,
    body: {
      error: `Unsupported content type "${ct}" — url must point to a PDF, HTML, or plain-text invoice. Scanned-image invoices have no text layer; OCR them first and send the text.`,
      code: "UNSUPPORTED_CONTENT_TYPE",
    },
  };
}

// Shared NO_INVOICE_CONTENT message; PDFs get an OCR hint because the usual
// cause of a text-free PDF is a scan with no text layer.
function noInvoiceContentMessage(text: string, fromPdf: boolean): string {
  return (
    `No invoice content found — text must contain the invoice itself (email body, OCR dump, pasted PDF text), not an instruction about one. ` +
    `e.g. {"text":"Invoice #42 from Acme Inc\\n2x Widget @ $25.00 = $50.00\\nTotal: $50.00"}. Received: ${fmtReceived(text)}` +
    (fromPdf ? " (the PDF may be a scan with no text layer — OCR it first)" : "")
  );
}

extractInvoiceRouter.post("/extract/invoice", async (req: Request, res: Response) => {
  try {
    const { text: rawText, url: rawUrl } = req.body ?? {};

    const textParam =
      typeof rawText === "string" && rawText.trim() !== "" ? rawText : undefined;
    const urlParam = typeof rawUrl === "string" && rawUrl.trim() !== "" ? rawUrl : undefined;

    if (textParam !== undefined && urlParam !== undefined) {
      throw new ValidationError(
        'Provide exactly one of text or url, not both — send the invoice content itself ({"text":"Invoice #42 …"}) or a link to it ({"url":"https://vendor.example/invoice-42.pdf"})',
      );
    }
    if (textParam === undefined && urlParam === undefined) {
      throw new ValidationError(
        'text or url is required — send the invoice content itself ({"text":"Invoice #42 …"}) or a link to it ({"url":"https://vendor.example/invoice-42.pdf"})',
      );
    }

    // Resolve the input to invoice text. URL mode fetches + extracts, then the
    // result flows through the exact same pipeline as pasted text.
    let text: string;
    let source: SourceInfo;
    if (urlParam !== undefined) {
      const fetched = await fetchInvoiceDocument(urlParam);
      if (!fetched.ok) {
        res.status(fetched.status).json(fetched.body);
        return;
      }
      text = fetched.text;
      source = { type: "url", url: urlParam, content_type: fetched.contentType };
    } else {
      text = textParam as string;
      source = TEXT_SOURCE;
    }
    const fromPdf = source.content_type === "pdf";

    // Enforce the input cap before spending an LLM call.
    const wordCount = text.trim().split(/\s+/).length;
    const byteCount = Buffer.byteLength(text, "utf8");
    if (wordCount > MAX_WORDS || byteCount > MAX_BYTES) {
      res.status(400).json({
        error: "Input exceeds maximum size (10000 words or 50KB)",
        code: "INPUT_TOO_LARGE",
      });
      return;
    }

    // Zero-cost pre-guard: an invoice always contains digits (amounts, invoice
    // number, dates). Digit-free text is an instruction/question, not invoice
    // content — seen live: {"text":"could you parse this invoice and extract
    // the line items for a report"}. Reject instructively before any LLM spend.
    if (!/\d/.test(text)) {
      res.status(400).json({
        error: noInvoiceContentMessage(text, fromPdf),
        code: "NO_INVOICE_CONTENT",
      });
      return;
    }

    // Serve from the best-effort in-memory cache when present. Keyed on the
    // EXTRACTED text, so a URL fetch and an identical pasted text share one
    // entry; `source` is attached per-request below, never cached.
    const key = cacheKey(text);
    const hit = cacheGet(key);
    if (hit) {
      res.json({ ...hit, cached: true, source });
      return;
    }

    let fields: InvoiceFields;
    try {
      // Single-shot: json_object mode + parseLooseJson. (Upstream/transport
      // errors surface as OpenAiCallError; the helper self-manages timeout.)
      const attempt: AttemptResult = await attemptExtract(text);

      // Truncation is a hard failure — not a billable 200.
      if (!attempt.ok) {
        res.status(502).json({
          error: "Extraction truncated (response hit max_tokens) — input could not be parsed",
          code: "TRUNCATED_OUTPUT",
        });
        return;
      }
      fields = attempt.fields;
      // Record token usage for per-call cost/margin logging (read at res.finish).
      res.locals.llmUsage = {
        model: MODEL,
        inputTokens: attempt.usage.inputTokens,
        outputTokens: attempt.usage.outputTokens,
      };
    } catch (err) {
      if (err instanceof OpenAiCallError) {
        console.error("Extract invoice LLM error:", err);
        res.status(502).json({ error: "Invoice extraction service unavailable" });
        return;
      }
      // Model output could not be parsed as JSON.
      console.error("Extract invoice parse error:", err);
      res.status(502).json({
        error: "Invoice extraction failed — model output could not be parsed",
        code: "INTERNAL_ERROR",
      });
      return;
    }

    // Nothing extracted at all ⇒ the text wasn't an invoice. Per the
    // /money/parse precedent the product here is the extraction, so "no
    // invoice found" is an instructive 400 (uncharged), not a billable
    // all-null 200. Real-but-sparse invoices always yield at least a total,
    // a vendor, an invoice number, or line items.
    const nothingExtracted =
      fields.vendor === null &&
      fields.invoice_number === null &&
      fields.invoice_date === null &&
      fields.due_date === null &&
      fields.subtotal === null &&
      fields.tax === null &&
      fields.total === null &&
      fields.currency === null &&
      fields.line_items.length === 0;
    if (nothingExtracted) {
      res.status(400).json({
        error: noInvoiceContentMessage(text, fromPdf),
        code: "NO_INVOICE_CONTENT",
      });
      return;
    }

    const line_item_count = fields.line_items.length;

    // totals_reconcile: sum(line_items.amount) + tax ≈ total, within tolerance.
    // Null when we cannot meaningfully check (subtotal or total missing); tax and
    // missing line-item amounts are treated as 0 for the sum.
    let totals_reconcile: boolean | null;
    if (fields.total === null || fields.subtotal === null) {
      totals_reconcile = null;
    } else {
      const itemsSum = fields.line_items.reduce((acc, li) => acc + (li.amount ?? 0), 0);
      const computed = itemsSum + (fields.tax ?? 0);
      totals_reconcile = Math.abs(computed - fields.total) <= RECONCILE_TOLERANCE;
    }

    let score = 100;
    const findings: string[] = [];
    if (fields.total === null) {
      score -= 15;
      findings.push("no_total_found");
    }
    if (totals_reconcile === false) {
      score -= 10;
      findings.push("totals_mismatch");
    }

    const payload: CachedInvoice = {
      invoice: fields,
      line_item_count,
      totals_reconcile,
      score,
      grade: gradeFromScore(score),
      findings,
    };

    // Cache only successful 200 extractions (without `source` — per-request).
    cacheSet(key, payload);

    res.json({ ...payload, cached: false, source });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Extract invoice error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
