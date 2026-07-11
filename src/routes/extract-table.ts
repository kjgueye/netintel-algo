import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { pickField } from "../utils/field-aliases.js";
import { parseLooseJson } from "../utils/parse-loose-json.js";

export const extractTableRouter = Router();

// Field-name leniency: agents send the table content under varied keys. Accept
// the common synonyms (canonical `text` first) so a differently-named key is a
// 200, not a 400. Matches the input-field-leniency pattern used elsewhere.
const TEXT_FIELDS = ["text", "content", "html", "csv", "table", "body", "markdown", "data"];

// Input cap shared across the Batch-3 LLM extraction endpoints: reject input
// over 10k words OR 50KB, whichever trips first. A large pasted table or HTML
// document could realistically approach this, so the cap is enforced before any
// LLM call.
const MAX_WORDS = 10000;
const MAX_BYTES = 50 * 1024;

// Tables vary wildly in size — give the model room so a large table does not get
// truncated mid-array. The truncation guard is especially important here: when a
// big table blows the budget we return TRUNCATED_OUTPUT so the agent can split
// the input, rather than silently dropping rows.
const MAX_TOKENS = 2048;

const SERVICE_SLUG = "extract-table";

// In-memory cache (best-effort, in-process Map ONLY — NOT Postgres, NOT Upstash).
// Postgres is the durable event log, not a cache. This is wiped on every
// deploy/restart and only ever holds successful (200) extractions, never errors.
// Keyed by serviceSlug + ":" + sha256(input); TTL 3600s; capped at MAX_CACHE_ENTRIES
// with FIFO eviction so a burst of unique inputs cannot balloon memory.
const CACHE_TTL_MS = 3600 * 1000;
const MAX_CACHE_ENTRIES = 500;
type CachedTable = {
  table: Table;
  column_count: number;
  score: number;
  grade: string;
  findings: string[];
};
const cache = new Map<string, { value: CachedTable; expires: number }>();

function cacheKey(input: string): string {
  return SERVICE_SLUG + ":" + crypto.createHash("sha256").update(input).digest("hex");
}

function cacheGet(key: string): CachedTable | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: CachedTable): void {
  // FIFO eviction: drop the oldest inserted key once at capacity.
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

// A single cell value, normalized to a string (or null for empty/absent cells).
type Cell = string | null;
// A row is an object keyed by column name.
type TableRow = Record<string, Cell>;
type Table = {
  columns: string[];
  rows: TableRow[];
  row_count: number;
};

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404
const extractTablePaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      price: pricing.extractTable,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  error: "Payment required",
};

extractTableRouter.get("/extract/table", (_req: Request, res: Response) => {
  res.status(402).json(extractTablePaymentRequired);
});

extractTableRouter.head("/extract/table", (_req: Request, res: Response) => {
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

// The model is prefilled with "{" (see attemptExtract) to force a JSON object, so
// a real reply continues the object WITHOUT the leading brace. Try with the brace
// restored first; fall back to the raw loose parse for replies that already carry
// their own braces (e.g. test fixtures, or a model that echoed the whole object).
// This is what lets a no-table / instruction-only input ("please extract the
// tables from this PDF") come back as a clean empty table instead of prose the
// parser chokes on → a misleading 502.
function parsePrefilledJson(text: string): unknown {
  try {
    return parseLooseJson("{" + text);
  } catch {
    return parseLooseJson(text);
  }
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

// Normalize a single cell to a string (or null). Tables are flat, so scalar
// values are stringified for a predictable, schema-conforming output; nested
// objects/arrays are dropped to null rather than leaking raw structure.
function normalizeCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function parseColumns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

function parseRows(value: unknown): TableRow[] {
  if (!Array.isArray(value)) return [];
  const rows: TableRow[] = [];
  for (const item of value) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const row: TableRow = {};
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        row[k] = normalizeCell(v);
      }
      rows.push(row);
    }
  }
  return rows;
}

const SYSTEM_PROMPT =
  "You are a precise table-extraction engine. From the messy text or HTML the user provides, detect the tabular structure and respond with ONLY a JSON object (no preamble, no markdown, no code fences) with exactly these keys: " +
  '{"columns": [str], "rows": [ {columnName: value, ...} ], "row_count": number}. ' +
  "Each row is an object keyed by column name. Infer column headers if they are not explicit. " +
  'If no tabular structure is detectable — INCLUDING when the input is only an instruction, question, ' +
  'request, or description with no data (e.g. "extract the tables from this report") — return ' +
  '{"columns": [], "rows": [], "row_count": 0}. ' +
  "Do not invent rows. This is an extraction task: always respond with the JSON object and nothing else — " +
  "never reply with prose, apologies, or explanations, and never refuse.";

// Result of a single attempt: either parsed table data, or a signal that the call was truncated.
type ParsedTable = { columns: string[]; rows: TableRow[]; model_row_count: number | null };
type AttemptResult =
  | { ok: true; data: ParsedTable; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; truncated: true };

async function attemptExtract(text: string, signal: AbortSignal): Promise<AttemptResult> {
  const response = await anthropic.messages.create(
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      // Prefill the assistant turn with "{" so the model cannot answer in prose —
      // it must continue a JSON object. This is the core fix for instruction-like
      // inputs (which previously made Haiku reply conversationally → 502).
      messages: [
        { role: "user", content: text },
        { role: "assistant", content: "{" },
      ],
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

  const parsed = parsePrefilledJson(textBlock.text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("not an object");
  }

  const p = parsed as Record<string, unknown>;
  return {
    ok: true,
    data: {
      columns: parseColumns(p.columns),
      rows: parseRows(p.rows),
      model_row_count: asNumberOrNull(p.row_count),
    },
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

extractTableRouter.post("/extract/table", async (req: Request, res: Response) => {
  try {
    const text = pickField(req.body, TEXT_FIELDS);

    if (typeof text !== "string" || text.trim() === "") {
      // Instructive 400: name the contract AND route the agent. The dominant
      // real-world miss is agents trying to hand this endpoint a PDF/URL — which
      // /web/extract already fetches (and converts PDFs to markdown).
      res.status(400).json({
        code: "MISSING_FIELD",
        error: 'text is required — pass the table as plain text, CSV, or HTML, e.g. {"text":"Name,Age\\nAlice,30\\nBob,25"}',
      });
      return;
    }

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

    // Serve from the best-effort in-memory cache when present.
    const key = cacheKey(text);
    const hit = cacheGet(key);
    if (hit) {
      res.json({ ...hit, cached: true });
      return;
    }

    // Bound the call(s) with an AbortController so a timeout actually CANCELS the
    // upstream request, not just the caller's promise.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeouts.extractTable);

    let data: ParsedTable;
    try {
      let attempt: AttemptResult;
      try {
        attempt = await attemptExtract(text, controller.signal);
      } catch (parseErr) {
        // Retry-once on malformed JSON. This is a DELIBERATE ENHANCEMENT over
        // schema-parse (which single-shots) — do NOT remove it to "match" that
        // route. API/abort errors are not retried here; they rethrow below.
        if (
          parseErr instanceof Anthropic.APIError ||
          (parseErr instanceof Error &&
            (parseErr.name === "AbortError" || parseErr.name === "APIUserAbortError"))
        ) {
          throw parseErr;
        }
        attempt = await attemptExtract(text, controller.signal);
      }

      // Truncation on either attempt is a hard failure — not a billable 200.
      if (!attempt.ok) {
        res.status(502).json({
          error: "Extraction truncated (response hit max_tokens) — input could not be parsed",
          code: "TRUNCATED_OUTPUT",
        });
        return;
      }
      data = attempt.data;
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
        console.error("Extract table LLM error:", err);
        res.status(502).json({ error: "Table extraction service unavailable" });
        return;
      }
      // JSON parse failed on both the initial call and the retry.
      console.error("Extract table parse error:", err);
      res.status(502).json({
        error: "Table extraction failed — model output could not be parsed",
        code: "INTERNAL_ERROR",
      });
      return;
    }
    clearTimeout(timer);

    // row_count is authoritative from rows.length — we trust the actual parsed
    // rows over whatever count the model self-reported.
    const row_count = data.rows.length;
    const column_count = data.columns.length;

    let score = 100;
    const findings: string[] = [];
    if (row_count === 0) {
      // No tabular structure detected in the input.
      score -= 30;
      findings.push("no_table_found");
    }
    if (data.model_row_count !== null && data.model_row_count !== row_count) {
      // The model's self-reported row_count disagreed with the rows it returned;
      // we trust rows.length and note the discrepancy.
      score -= 5;
      findings.push("count_mismatch");
    }

    const payload: CachedTable = {
      table: { columns: data.columns, rows: data.rows, row_count },
      column_count,
      score,
      grade: gradeFromScore(score),
      findings,
    };

    // Cache only successful 200 extractions.
    cacheSet(key, payload);

    res.json({ ...payload, cached: false });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Extract table error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
