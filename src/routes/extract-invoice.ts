import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { checkSsrf, fmtReceived, validateUrl, ValidationError } from "../utils/validators.js";
// pdf-parse ships no type declarations, and its package entrypoint (index.js)
// runs debug code on import that reads a bundled test PDF off disk — which
// throws under ESM where `module.parent` is undefined. Import the library
// module directly to dodge that side effect (same as web-extract).
// @ts-ignore -- no types for the lib subpath
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { parseLooseJson } from "../utils/parse-loose-json.js";

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
  accepts: [
    {
      scheme: "exact",
      price: pricing.extractInvoice,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  error: "Payment required",
};

extractInvoiceRouter.get("/extract/invoice", (_req: Request, res: Response) => {
  res.status(402).json(extractInvoicePaymentRequired);
});

extractInvoiceRouter.head("/extract/invoice", (_req: Request, res: Response) => {
  res.status(402).end();
});

const anthropic = new Anthropic();

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

const SYSTEM_PROMPT =
  "You are a precise invoice and receipt data extraction engine. Extract structured data from the invoice or receipt text the user provides. " +
  "Numbers must be numbers, not strings. Dates as ISO 8601 (YYYY-MM-DD) where possible. line_items is an empty array if none are found. Use null for any field that is not present. Do not invent values. " +
  "If the text contains no invoice or receipt content at all (e.g. it is an instruction, question, or unrelated prose), set every field to null and line_items to []. This is an extraction task: always parse whatever is submitted, never refuse.";

// Structured-output schema (output_config.format). The API constrains the
// response to conform, so "model output could not be parsed" is structurally
// impossible — the failure class behind the live 502s this replaced (a caller
// sent an instruction instead of an invoice; the model answered in prose;
// JSON.parse failed twice; 3.2s + two Haiku calls wasted per request).
// Structured outputs require additionalProperties:false and all keys required
// — nullability carries the "not present" signal instead of key absence.
const INVOICE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    vendor: { type: ["string", "null"] },
    invoice_number: { type: ["string", "null"] },
    invoice_date: { type: ["string", "null"] },
    due_date: { type: ["string", "null"] },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: ["string", "null"] },
          quantity: { type: ["number", "null"] },
          unit_price: { type: ["number", "null"] },
          amount: { type: ["number", "null"] },
        },
        required: ["description", "quantity", "unit_price", "amount"],
        additionalProperties: false,
      },
    },
    subtotal: { type: ["number", "null"] },
    tax: { type: ["number", "null"] },
    total: { type: ["number", "null"] },
    currency: { type: ["string", "null"] },
  },
  required: [
    "vendor",
    "invoice_number",
    "invoice_date",
    "due_date",
    "line_items",
    "subtotal",
    "tax",
    "total",
    "currency",
  ],
  additionalProperties: false,
};

// Result of a single attempt: either parsed fields, or a signal that the call was truncated.
type AttemptResult =
  | { ok: true; fields: InvoiceFields; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; truncated: true };

async function attemptExtract(text: string, signal: AbortSignal): Promise<AttemptResult> {
  const response = await anthropic.messages.create(
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      // Guaranteed schema-conforming JSON — see INVOICE_OUTPUT_SCHEMA.
      output_config: { format: { type: "json_schema", schema: INVOICE_OUTPUT_SCHEMA } },
      messages: [{ role: "user", content: text }],
    },
    { signal },
  );

  // Truncation guard: if the model hit max_tokens the output may be partial/invalid.
  // Treat as a failed extraction (502), never parse/return partial JSON as a 200.
  // Applied on BOTH the initial call and the retry.
  if (response.stop_reason === "max_tokens") {
    return { ok: false, truncated: true };
  }

  const textBlock = response.content.find(
    (block): block is Anthropic.ContentBlock & { type: "text" } => block.type === "text",
  );
  if (!textBlock) throw new Error("no text content");

  const parsed = parseLooseJson(textBlock.text);
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
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
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

// The express `Response` type shadows the global fetch `Response`; recover the
// fetch one from the global fetch signature.
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

async function readBodyCapped(
  resp: FetchResponse,
  cap: number,
): Promise<{ bytes: Buffer; exceeded: boolean }> {
  const reader = resp.body?.getReader?.();
  if (!reader) {
    const ab = await resp.arrayBuffer();
    const buf = Buffer.from(ab);
    return { bytes: buf.subarray(0, cap), exceeded: buf.length > cap };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.length;
    if (total > cap) {
      exceeded = true;
      break;
    }
  }
  reader.cancel().catch(() => {});
  return { bytes: Buffer.concat(chunks), exceeded };
}

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

// Cap redirect hops (matches web-extract). Each hop is independently
// SSRF-checked, so a redirect chain can't smuggle in an internal address.
const MAX_FETCH_REDIRECTS = 3;

async function fetchInvoiceDocument(rawUrl: string): Promise<FetchedDoc> {
  // Server-side fetch of a caller-controlled URL — SSRF check is mandatory.
  // validateUrl enforces http(s) + throws ValidationError (→ instructive 400).
  const parsed = validateUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeouts.extractInvoiceFetch);
  let resp: FetchResponse;
  let read: { bytes: Buffer; exceeded: boolean };
  let current = parsed;
  try {
    // Manual redirect handling so EVERY hop is SSRF-checked — a public URL that
    // 302-redirects to 169.254.169.254 (cloud metadata) or an RFC-1918 host
    // would otherwise be followed unchecked. Same pattern as web-extract.
    for (let hop = 0; ; hop++) {
      await checkSsrf(current.hostname);

      resp = await fetch(current.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/pdf, text/html, text/plain, */*" },
      });

      const location = resp.headers.get("location");
      if (resp.status >= 300 && resp.status < 400 && location) {
        resp.body?.cancel?.().catch(() => {});
        if (hop >= MAX_FETCH_REDIRECTS) {
          return {
            ok: false,
            status: 502,
            body: { error: "Could not fetch url — too many redirects", code: "UPSTREAM_ERROR" },
          };
        }
        // new URL(location, base) is re-checked at the top of the next hop.
        current = new URL(location, current.href);
        continue;
      }

      if (resp.status < 200 || resp.status >= 300) {
        return {
          ok: false,
          status: 502,
          body: {
            error: `Could not fetch url — upstream returned HTTP ${resp.status}`,
            code: "UPSTREAM_ERROR",
          },
        };
      }
      // Keep the timer armed through the body read so a slow stream is bounded too.
      read = await readBodyCapped(resp, FETCH_READ_CAP);
      break;
    }
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      return {
        ok: false,
        status: 504,
        body: { error: "Could not fetch url — upstream fetch timed out", code: "UPSTREAM_TIMEOUT" },
      };
    }
    // checkSsrf throws ValidationError on a private/reserved redirect target;
    // rethrow so the handler's catch renders the instructive 400 (never leak
    // it as a generic 502 — the caller should learn the URL was blocked).
    if (err instanceof ValidationError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 502,
      body: { error: `Could not fetch url — ${message}`, code: "UPSTREAM_ERROR" },
    };
  } finally {
    clearTimeout(timer);
  }

  if (read.exceeded) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "Fetched document exceeds the 5MB fetch cap — url must point to a reasonably sized invoice document",
        code: "INPUT_TOO_LARGE",
      },
    };
  }

  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  let finalPathname = current.pathname.toLowerCase();
  try {
    if (resp.url) finalPathname = new URL(resp.url).pathname.toLowerCase();
  } catch {
    // keep the final-hop pathname
  }
  const head = read.bytes.subarray(0, 1024).toString("latin1");

  const looksPdf =
    ct.includes("application/pdf") ||
    finalPathname.endsWith(".pdf") ||
    parsed.pathname.toLowerCase().endsWith(".pdf") ||
    head.startsWith("%PDF");
  const looksHtml = ct.includes("text/html") || /^\s*<(?:!doctype|html|head|body)/i.test(head);

  if (looksPdf) {
    let parsedPdf: { text?: string };
    try {
      parsedPdf = await pdfParse(read.bytes);
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
    return { ok: true, text: htmlToPlainText(read.bytes.toString("utf8")), contentType: "html" };
  }
  if (ct.startsWith("text/") || ct.includes("application/json")) {
    return { ok: true, text: read.bytes.toString("utf8"), contentType: "text" };
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

    // Bound the call(s) with an AbortController so a timeout actually CANCELS the
    // upstream request, not just the caller's promise.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeouts.extractInvoice);

    let fields: InvoiceFields;
    try {
      // Single-shot: structured outputs (output_config.format) guarantee
      // schema-valid JSON, so the old retry-once-on-malformed-JSON loop is
      // dead weight — parse failures can no longer originate from the model.
      // (API/abort errors were never retried here; the SDK retries 429/5xx.)
      const attempt: AttemptResult = await attemptExtract(text, controller.signal);

      // Truncation on either attempt is a hard failure — not a billable 200.
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
        model: "claude-haiku-4-5-20251001",
        inputTokens: attempt.usage.inputTokens,
        outputTokens: attempt.usage.outputTokens,
      };
    } catch (err) {
      clearTimeout(timer);
      if (
        err instanceof Anthropic.APIError ||
        (err instanceof Error &&
          (err.name === "AbortError" || err.name === "APIUserAbortError"))
      ) {
        console.error("Extract invoice LLM error:", err);
        res.status(502).json({ error: "Invoice extraction service unavailable" });
        return;
      }
      // JSON parse failed on both the initial call and the retry.
      console.error("Extract invoice parse error:", err);
      res.status(502).json({
        error: "Invoice extraction failed — model output could not be parsed",
        code: "INTERNAL_ERROR",
      });
      return;
    }
    clearTimeout(timer);

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
