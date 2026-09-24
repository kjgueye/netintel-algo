import { Router, type Request, type Response } from "express";
import { pricing, timeouts } from "../config.js";
import { ValidationError, validateAgainstSchema } from "../utils/validators.js";
import { signableAccepts } from "../accepts.js";
import { openaiExtract, OpenAiCallError } from "../services/openai-json.js";

export const schemaParseRouter = Router();

// gpt-4o-mini via forced function-call: worst-case COGS at the 10k-word cap
// (~14k in + 4096 out) ≈ $0.0046, under the $0.01 flat price. Swapped from Haiku
// 2026-09-02 (which forced $0.10) — see the pricing deep-dive. gpt-4o-mini is
// function-calling-native and strong at JSON extraction.
const MODEL = "gpt-4o-mini";

// Input cap shared across Batch-2 LLM endpoints: reject text over 10k words OR 50KB.
const MAX_WORDS = 10000;
const MAX_BYTES = 50 * 1024;

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404
const schemaParsePaymentRequired = {
  x402Version: 2,
  accepts: signableAccepts(pricing.schemaParse),
  error: "Payment required",
};

schemaParseRouter.get("/schema-parse/extract", (_req: Request, res: Response) => {
  res.status(402).json(schemaParsePaymentRequired);
});

schemaParseRouter.head("/schema-parse/extract", (_req: Request, res: Response) => {
  res.status(402).end();
});

schemaParseRouter.post("/schema-parse/extract", async (req: Request, res: Response) => {
  try {
    const { raw_text, target_schema } = req.body ?? {};

    if (!raw_text || typeof raw_text !== "string" || raw_text.trim() === "") {
      // Keep this example JSON-Schema-shaped (with `required`) — the shorthand
      // {"name":"string"} form passes validation but produces an unconstrained,
      // still-billed extraction.
      throw new ValidationError('raw_text and target_schema are required — e.g. {"raw_text":"John Doe, Acme Inc, john@acme.com","target_schema":{"type":"object","properties":{"name":{"type":"string"},"company":{"type":"string"},"email":{"type":"string"}},"required":["name","email"]}}');
    }

    if (
      target_schema === null ||
      target_schema === undefined ||
      typeof target_schema !== "object" ||
      Array.isArray(target_schema)
    ) {
      throw new ValidationError("target_schema must be a plain object");
    }

    // Enforce the input cap before spending an LLM call.
    const wordCount = raw_text.trim().split(/\s+/).length;
    const byteCount = Buffer.byteLength(raw_text, "utf8");
    if (wordCount > MAX_WORDS || byteCount > MAX_BYTES) {
      throw new ValidationError("Input exceeds maximum size (10000 words or 50KB)");
    }

    // Forced function-call extraction with a hard wall-clock timeout (the helper
    // aborts the upstream request on timeout). timeouts.schemaParse unchanged (30s).
    let result;
    try {
      result = await openaiExtract({
        modelId: MODEL,
        system: "You are a precise data extraction engine. Extract information from the provided text strictly according to the tool schema. If a field cannot be found, omit it or use null.",
        user: raw_text,
        schema: target_schema,
        maxTokens: 4096,
        timeoutMs: timeouts.schemaParse,
      });
    } catch (err) {
      console.error("Schema parse extraction error:", err);
      res.status(502).json({ error: "Extraction service unavailable" });
      return;
    }

    // Truncation guard: if the model hit the output cap, the tool output may be
    // partial/invalid. Fail (502 -> not charged) rather than return junk as 200.
    if (result.truncated) {
      res.status(502).json({
        error: "Extraction truncated (response hit max_tokens) — reduce input or schema size",
      });
      return;
    }

    if (!result.hasCall) {
      res.status(422).json({ error: "Model could not extract data matching the provided schema" });
      return;
    }

    // Confirm the caller's required fields are actually present before billing.
    // Presence-only and lenient: never rejects output that satisfies `required`,
    // and is a no-op when target_schema declares no required fields.
    const problems = validateAgainstSchema(result.args, target_schema);
    if (problems.length > 0) {
      res.status(422).json({
        error: "Extracted data did not match the requested schema",
        details: problems,
      });
      return;
    }

    // Record token usage for per-call cost/margin logging (read by the
    // paid-call logger at res.finish).
    res.locals.llmUsage = {
      model: MODEL,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    };

    res.json({
      extracted: result.args,
      tokens_used: {
        input: result.usage.inputTokens,
        output: result.usage.outputTokens,
      },
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof OpenAiCallError) {
      console.error("Schema parse extraction error:", err);
      res.status(502).json({ error: "Extraction service unavailable" });
      return;
    }
    console.error("Schema parse error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
