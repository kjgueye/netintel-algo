import { Router, type Request, type Response } from "express";
import { pricing } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { pickField } from "../utils/field-aliases.js";
import { signableAccepts } from "../accepts.js";

// POST /text/chunk — deterministic sliding-window text chunker for RAG
// ingestion. Pure function: no upstream, no LLM, no cache, no SSRF surface.
// Pairs with /v1/embeddings (chunk → embed).

export const textChunkRouter = Router();

// --- Limits ---

// Input cap in UTF-16 code units (JS string length). The global express.json()
// parser in index.ts allows 1mb bodies so this cap is reachable for any script;
// a body beyond THAT 413s at the parser (before the paywall — uncharged).
const MAX_TEXT_CHARS = 200_000;
// Unit-aware floor: 50 chars, but only 5 words (a 50-WORD floor would forbid the
// classic 10-word RAG window the spec itself exercises).
const MIN_CHUNK_SIZE: Record<"chars" | "words", number> = { chars: 50, words: 5 };
const MAX_CHUNK_SIZE = 20_000;
const DEFAULT_CHUNK_SIZE = 1000;
// Default overlap: 10% of chunk_size, capped at 100 (= exactly 100 at the
// default chunk_size of 1000). A flat 100 would self-clamp to chunk_size-1 on
// small chunk sizes and degrade to a step of 1 — a default must never do that.
const DEFAULT_OVERLAP_CAP = 100;
const DEFAULT_OVERLAP_RATIO = 0.1;
// Output guards — both are 400 uncharged, computed BEFORE any chunk is built.
const MAX_CHUNKS = 2000;
// Sum of all chunk lengths. Bounds the response size against absurd overlap
// ratios (a 99%-overlap window over 200k chars would otherwise emit ~40MB).
const MAX_OUTPUT_CHARS = 1_000_000;

const TEXT_KEYS = ["text", "content", "input", "body"];
const CHUNK_SIZE_KEYS = ["chunk_size", "size", "chunkSize"];
const OVERLAP_KEYS = ["overlap", "chunk_overlap", "chunkOverlap"];
const UNIT_KEYS = ["unit", "by", "mode"];

const EXAMPLE_BODY = '{"text":"...","chunk_size":1000,"overlap":100,"unit":"chars"}';

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404
const textChunkPaymentRequired = {
  x402Version: 2,
  accepts: signableAccepts(pricing.textChunk),
  error: "Payment required",
};

textChunkRouter.get("/text/chunk", (_req: Request, res: Response) => {
  res.status(402).json(textChunkPaymentRequired);
});

textChunkRouter.head("/text/chunk", (_req: Request, res: Response) => {
  res.status(402).end();
});

// --- Types ---

type Unit = "chars" | "words";

interface Finding {
  rule: string;
  detail: string;
}

interface Chunk {
  index: number;
  text: string;
  /** UTF-16 offset of the chunk's first character in the source text. */
  start: number;
  /** UTF-16 offset one past the chunk's last character in the source text. */
  end: number;
  /** chunk.text.length (chars). */
  length: number;
}

export interface TextChunkResult {
  unit: Unit;
  chunk_size: number;
  overlap: number;
  count: number;
  source_length: number;
  chunks: Chunk[];
  findings: Finding[];
}

// --- Parameter coercion ---

/** Number or numeric string → integer (floored). Undefined when absent; throws on junk. */
function toInteger(raw: unknown, name: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) {
    throw new ValidationError(`${name} must be a number, e.g. ${EXAMPLE_BODY}`);
  }
  return Math.floor(n);
}

function resolveUnit(raw: unknown, findings: Finding[]): Unit {
  if (raw === undefined || raw === null) return "chars";
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "chars" || s === "char" || s === "characters" || s === "character") return "chars";
  if (s === "words" || s === "word") return "words";
  findings.push({
    rule: "unit_unknown",
    detail: `unit ${JSON.stringify(raw)} is not recognized — expected "chars" or "words"; defaulted to "chars"`,
  });
  return "chars";
}

function resolveChunkSize(raw: unknown, unit: Unit, findings: Finding[]): number {
  const n = toInteger(raw, "chunk_size");
  if (n === undefined) return DEFAULT_CHUNK_SIZE;
  const min = MIN_CHUNK_SIZE[unit];
  if (n < min) {
    findings.push({
      rule: "chunk_size_clamped",
      detail: `chunk_size ${n} is below the minimum ${min} ${unit} — clamped to ${min}`,
    });
    return min;
  }
  if (n > MAX_CHUNK_SIZE) {
    findings.push({
      rule: "chunk_size_clamped",
      detail: `chunk_size ${n} is above the maximum ${MAX_CHUNK_SIZE} — clamped to ${MAX_CHUNK_SIZE}`,
    });
    return MAX_CHUNK_SIZE;
  }
  return n;
}

function resolveOverlap(raw: unknown, chunkSize: number, findings: Finding[]): number {
  const n = toInteger(raw, "overlap");
  if (n === undefined) {
    return Math.min(DEFAULT_OVERLAP_CAP, Math.floor(chunkSize * DEFAULT_OVERLAP_RATIO));
  }
  if (n < 0) {
    findings.push({ rule: "overlap_clamped", detail: `overlap ${n} is negative — clamped to 0` });
    return 0;
  }
  if (n >= chunkSize) {
    const max = chunkSize - 1;
    findings.push({
      rule: "overlap_clamped",
      detail: `overlap ${n} must be smaller than chunk_size ${chunkSize} — clamped to ${max}`,
    });
    return max;
  }
  return n;
}

// --- Windowing ---

/** Number of sliding windows of `size` advancing by `step` over `total` units (final partial kept). */
function windowCount(total: number, size: number, step: number): number {
  if (total <= size) return 1;
  return 1 + Math.ceil((total - size) / step);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Character windows over UTF-16 code units. A boundary that would split a
 * surrogate pair (emoji, many CJK-extension chars) is nudged one unit right so
 * no chunk ever starts or ends with a lone surrogate — such a chunk may be one
 * unit longer than chunk_size and its overlap one unit shorter.
 */
function chunkByChars(text: string, size: number, step: number): Chunk[] {
  const n = text.length;
  const chunks: Chunk[] = [];
  let start = 0;
  for (;;) {
    let end = Math.min(start + size, n);
    if (end < n && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
      end += 1;
    }
    const slice = text.slice(start, end);
    chunks.push({ index: chunks.length, text: slice, start, end, length: slice.length });
    if (end >= n) break;
    let next = start + step;
    if (isLowSurrogate(text.charCodeAt(next)) && isHighSurrogate(text.charCodeAt(next - 1))) {
      next += 1;
    }
    start = next;
  }
  return chunks;
}

interface WordSpan {
  start: number;
  end: number;
}

/** Whitespace-delimited word spans (character offsets into the source). */
function wordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/** Word windows: `size` words advancing by `step`, re-joined with single spaces. */
function chunkByWords(text: string, spans: WordSpan[], size: number, step: number): Chunk[] {
  const total = spans.length;
  const chunks: Chunk[] = [];
  for (let s = 0; ; s += step) {
    const e = Math.min(s + size, total);
    const words: string[] = [];
    for (let i = s; i < e; i++) words.push(text.slice(spans[i].start, spans[i].end));
    const joined = words.join(" ");
    chunks.push({
      index: chunks.length,
      text: joined,
      start: spans[s].start,
      end: spans[e - 1].end,
      length: joined.length,
    });
    if (e >= total) break;
  }
  return chunks;
}

/** Total characters the windows will emit (for the output-size guard). */
function projectedOutputChars(
  unit: Unit,
  text: string,
  spans: WordSpan[],
  size: number,
  step: number,
  count: number,
): number {
  let total = 0;
  if (unit === "chars") {
    const n = text.length;
    for (let i = 0; i < count; i++) {
      const start = i * step;
      total += Math.min(start + size, n) - start;
    }
    return total;
  }
  for (let i = 0; i < count; i++) {
    const s = i * step;
    const e = Math.min(s + size, spans.length);
    // Upper bound: source span (single-space joining can only shrink it).
    total += spans[e - 1].end - spans[s].start;
  }
  return total;
}

// --- Core (exported for reuse/tests) ---

export function chunkText(
  text: string,
  opts: { chunkSize: number; overlap: number; unit: Unit },
  findings: Finding[] = [],
): TextChunkResult {
  const { chunkSize, overlap, unit } = opts;
  const step = chunkSize - overlap;
  const spans = unit === "words" ? wordSpans(text) : [];
  const total = unit === "words" ? spans.length : text.length;

  const count = windowCount(total, chunkSize, step);
  if (count > MAX_CHUNKS) {
    throw new ValidationError(
      `chunk_size/overlap would produce >${MAX_CHUNKS} chunks (${count}) — raise chunk_size or lower overlap`,
    );
  }
  const projected = projectedOutputChars(unit, text, spans, chunkSize, step, count);
  if (projected > MAX_OUTPUT_CHARS) {
    throw new ValidationError(
      `chunk_size/overlap would emit ~${projected} characters across ${count} chunks (max ${MAX_OUTPUT_CHARS}) — lower overlap or raise chunk_size`,
    );
  }

  const chunks =
    unit === "words" ? chunkByWords(text, spans, chunkSize, step) : chunkByChars(text, chunkSize, step);

  return {
    unit,
    chunk_size: chunkSize,
    overlap,
    count: chunks.length,
    source_length: text.length,
    chunks,
    findings,
  };
}

// --- Route handler ---

textChunkRouter.post("/text/chunk", (req: Request, res: Response) => {
  try {
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const query = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
    const params = { ...body, ...query };

    const rawText = pickField(params, TEXT_KEYS);
    if (rawText === undefined || (typeof rawText === "string" && rawText.trim() === "")) {
      res.status(400).json({
        error: `text is required — pass the text to chunk as "text", e.g. ${EXAMPLE_BODY} (aliases: content, input, body)`,
      });
      return;
    }
    if (typeof rawText !== "string") {
      throw new ValidationError(`text must be a string, e.g. ${EXAMPLE_BODY}`);
    }
    if (rawText.length > MAX_TEXT_CHARS) {
      res.status(413).json({
        error: `text exceeds the ${MAX_TEXT_CHARS}-character limit (got ${rawText.length}) — split the input and call again. You were not charged.`,
      });
      return;
    }

    const findings: Finding[] = [];
    const unit = resolveUnit(pickField(params, UNIT_KEYS), findings);
    const chunkSize = resolveChunkSize(pickField(params, CHUNK_SIZE_KEYS), unit, findings);
    const overlap = resolveOverlap(pickField(params, OVERLAP_KEYS), chunkSize, findings);

    res.json(chunkText(rawText, { chunkSize, overlap, unit }, findings));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Text chunk error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
