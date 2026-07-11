import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";

export const normalizeJsonRouter = Router();

// Input cap shared across the Batch-4 transform endpoints: reject the DATA
// payload over 10k words OR 50KB, whichever trips first. Enforced BEFORE any LLM
// call so an oversized blob never reaches Haiku. When `data` is an object it is
// stringified first and the cap applies to that JSON string.
const MAX_WORDS = 10000;
const MAX_BYTES = 50 * 1024;

// The `schema` object is separate from the data payload and is guarded on its
// own: reject anything with more than 50 fields before the LLM call.
const MAX_SCHEMA_FIELDS = 50;

// Output JSON can be sizable depending on schema + data, so give the model room.
// The truncation guard catches the cases where even this is not enough rather
// than returning a half-formed object as a 200.
const MAX_TOKENS = 2048;

const SERVICE_SLUG = "normalize-json";

// Supported type tokens for the caller's field→type schema. On THIS endpoint the
// declared types are ENFORCED via coercion (the model coerces; code conforms the
// key set). Anything outside this set is a 400.
const SUPPORTED_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "date",
  "string[]",
  "number[]",
  "object",
]);

// In-memory cache (best-effort, in-process Map ONLY — NOT Postgres, NOT Upstash).
// Wiped on every deploy/restart and only ever holds successful (200) results,
// never errors. Keyed by SERVICE_SLUG + ":" + sha256(data + ":" + schema); TTL
// 3600s; capped at MAX_CACHE_ENTRIES with FIFO eviction so a burst of unique
// inputs cannot balloon memory.
const CACHE_TTL_MS = 3600 * 1000;
const MAX_CACHE_ENTRIES = 500;
type CachedNormalization = {
  normalized: Record<string, unknown>;
  fields_in_schema: number;
  fields_populated: number;
  fields_nulled: number;
  schema_match: boolean;
  score: number;
  grade: string;
  findings: string[];
};
const cache = new Map<string, { value: CachedNormalization; expires: number }>();

function cacheKey(dataString: string, schema: Record<string, unknown>): string {
  return (
    SERVICE_SLUG +
    ":" +
    crypto
      .createHash("sha256")
      .update(dataString + ":" + JSON.stringify(schema))
      .digest("hex")
  );
}

function cacheGet(key: string): CachedNormalization | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: CachedNormalization): void {
  // FIFO eviction: drop the oldest inserted key once at capacity.
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404
const normalizeJsonPaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      price: pricing.normalizeJson,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  error: "Payment required",
};

normalizeJsonRouter.get("/normalize/json", (_req: Request, res: Response) => {
  res.status(402).json(normalizeJsonPaymentRequired);
});

normalizeJsonRouter.head("/normalize/json", (_req: Request, res: Response) => {
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

const SYSTEM_PROMPT =
  "You are a precise JSON normalization engine. You are given a target schema (a JSON object mapping field name → type token) and a messy input data payload. " +
  "Produce a single JSON object whose keys are EXACTLY the field names in the target schema — no more, no fewer. " +
  "For each schema field, find the semantically matching value in the input even if the key differs (e.g. \"fullName\"/\"name\"/\"full_name\" all map to a \"full_name\" field) and coerce it to the declared type: " +
  "string → text; number → a JSON number (\"42\" → 42); boolean → true/false (\"true\"/\"yes\"/1 → true, \"false\"/\"no\"/0 → false); date → an ISO 8601 date string (YYYY-MM-DD); " +
  "string[] / number[] → a JSON array of that element type (wrap a single value, or split a delimited string); object → a nested JSON object. " +
  "If a schema field has no corresponding value in the input, set it to null. Drop any input fields that are not in the schema. " +
  "Return ONLY the JSON object — no preamble, no explanation, and do NOT wrap it in a markdown code fence.";

// Strip an accidental markdown code fence the model may have wrapped the JSON in
// (```json ... ```), then parse. Conservative: only removes an obvious wrapping
// fence, never touches the JSON body itself.
function stripFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return text.trim();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

normalizeJsonRouter.post("/normalize/json", async (req: Request, res: Response) => {
  try {
    const { data, schema } = req.body ?? {};

    // --- data: string OR already-parsed object ---
    if (data === null || data === undefined) {
      throw new ValidationError('data and schema are required — e.g. {"data":{"FullName":"Jane Doe"},"schema":{"full_name":"string"}}');
    }
    if (typeof data !== "string" && typeof data !== "object") {
      throw new ValidationError("data must be a JSON string or object");
    }
    if (typeof data === "string" && data.trim() === "") {
      throw new ValidationError('data and schema are required — e.g. {"data":{"FullName":"Jane Doe"},"schema":{"full_name":"string"}}');
    }

    // --- schema: field→type map, plain object ---
    if (!isPlainObject(schema)) {
      throw new ValidationError(
        "schema must be a plain object mapping field names to type tokens",
      );
    }
    const schemaFields = Object.keys(schema);
    if (schemaFields.length === 0) {
      throw new ValidationError("schema must declare at least one field");
    }

    // Schema-size guard — checked before the LLM call.
    if (schemaFields.length > MAX_SCHEMA_FIELDS) {
      res.status(400).json({
        error: `schema exceeds maximum of ${MAX_SCHEMA_FIELDS} fields`,
        code: "SCHEMA_TOO_LARGE",
      });
      return;
    }

    // Validate every declared type token before spending an LLM call.
    for (const field of schemaFields) {
      const token = (schema as Record<string, unknown>)[field];
      if (typeof token !== "string" || !SUPPORTED_TYPES.has(token)) {
        throw new ValidationError(`Unsupported type in schema: ${token}`);
      }
    }

    // When data is an object, stringify for the cap check AND the LLM input.
    // When it's a string, the cap applies to the raw string length.
    const dataString = typeof data === "string" ? data : JSON.stringify(data);

    // Enforce the input cap on the DATA payload before spending an LLM call.
    const wordCount = dataString.trim().split(/\s+/).length;
    const byteCount = Buffer.byteLength(dataString, "utf8");
    if (wordCount > MAX_WORDS || byteCount > MAX_BYTES) {
      res.status(400).json({
        error: "Input data exceeds maximum size (10000 words or 50KB)",
        code: "INPUT_TOO_LARGE",
      });
      return;
    }

    // Serve from the best-effort in-memory cache when present. The key folds in
    // both data and schema, so the same data against a different schema misses.
    const key = cacheKey(dataString, schema as Record<string, unknown>);
    const hit = cacheGet(key);
    if (hit) {
      res.json({ ...hit, cached: true });
      return;
    }

    const userMessage =
      `Target schema (field → type):\n${JSON.stringify(schema)}\n\n` +
      `Input data to normalize:\n${dataString}`;

    // Retry-once on malformed JSON. schema-parse single-shots; this batch is
    // intentionally more resilient — a deliberate enhancement, NOT a copy of
    // schema-parse. If the model's output fails JSON.parse (after stripping an
    // accidental code fence) we retry the LLM call exactly ONCE; a second failure
    // is a 502 INTERNAL_ERROR. The truncation guard is applied on BOTH calls.
    let parsed: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
      // Bound the call with an AbortController so a timeout actually CANCELS the
      // upstream request, not just the caller's promise.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeouts.normalizeJson);

      let response: Anthropic.Message;
      try {
        response = await anthropic.messages.create(
          {
            model: "claude-haiku-4-5-20251001",
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userMessage }],
          },
          { signal: controller.signal },
        );
      } catch (err) {
        clearTimeout(timer);
        // An API/abort error is terminal — there is no JSON to retry-parse.
        if (
          err instanceof Anthropic.APIError ||
          (err instanceof Error &&
            (err.name === "AbortError" || err.name === "APIUserAbortError"))
        ) {
          console.error("Normalize JSON LLM error:", err);
          res.status(502).json({
            error: "JSON normalization service unavailable",
            code: "INTERNAL_ERROR",
          });
          return;
        }
        throw err;
      }
      clearTimeout(timer);

      // Truncation guard (applied on the initial call AND the retry): if the
      // model hit max_tokens the JSON was cut off mid-object. Returning a partial
      // object as a 200 is exactly the silent-partial-output bug we prevent.
      if (response.stop_reason === "max_tokens") {
        res.status(502).json({
          error: "Normalized output truncated (response hit max_tokens) — reduce data or schema size",
          code: "TRUNCATED_OUTPUT",
        });
        return;
      }

      // Record token usage for per-call cost/margin logging (read at res.finish).
      // Reassigned each retry, so the final value reflects the billed call.
      res.locals.llmUsage = {
        model: "claude-haiku-4-5-20251001",
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };

      const textBlock = response.content.find(
        (block): block is Anthropic.ContentBlock & { type: "text" } =>
          block.type === "text",
      );
      const rawText = textBlock ? textBlock.text : "";

      try {
        const candidate = JSON.parse(stripFences(rawText));
        // Only a JSON object is usable; an array/scalar is treated as malformed.
        if (isPlainObject(candidate)) {
          parsed = candidate;
        }
      } catch {
        // Malformed JSON — fall through to retry (or to INTERNAL_ERROR below).
      }
    }

    // Both attempts failed to yield a parseable JSON object.
    if (parsed === null) {
      res.status(502).json({
        error: "Model did not return valid JSON after a retry",
        code: "INTERNAL_ERROR",
      });
      return;
    }

    // Force-conform the model output to the schema's key set: keep only schema
    // keys (drop extras), add any missing schema key as null. schema_match is
    // true only when the model's RAW output keys were exactly the schema's.
    const fields_in_schema = schemaFields.length;
    const modelKeys = Object.keys(parsed);
    const extraKeys = modelKeys.filter((k) => !schemaFields.includes(k));
    const missingKeys = schemaFields.filter((k) => !(k in parsed));
    const schema_match = extraKeys.length === 0 && missingKeys.length === 0;

    const normalized: Record<string, unknown> = {};
    for (const k of schemaFields) {
      normalized[k] = k in parsed && parsed[k] !== undefined ? parsed[k] : null;
    }

    const fields_populated = schemaFields.filter(
      (k) => normalized[k] !== null,
    ).length;
    const fields_nulled = fields_in_schema - fields_populated;

    let score = 100;
    const findings: string[] = [];

    if (!schema_match) {
      // Model added/dropped keys; code force-conformed to the schema.
      score -= 10;
      findings.push("schema_mismatch_corrected");
    }

    if (fields_in_schema > 0 && fields_nulled / fields_in_schema > 0.5) {
      // More than half the schema came back empty — likely a poor source match.
      score -= 15;
      findings.push("mostly_nulled");
    }

    const payload: CachedNormalization = {
      normalized,
      fields_in_schema,
      fields_populated,
      fields_nulled,
      schema_match,
      score,
      grade: gradeFromScore(score),
      findings,
    };

    // Cache only successful 200 results.
    cacheSet(key, payload);

    res.json({ ...payload, cached: false });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Normalize JSON error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
