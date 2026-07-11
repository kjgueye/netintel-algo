import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { ValidationError, validateAgainstSchema } from "../utils/validators.js";

export const schemaParseRouter = Router();

// Input cap shared across Batch-2 LLM endpoints: reject text over 10k words OR 50KB.
const MAX_WORDS = 10000;
const MAX_BYTES = 50 * 1024;

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404
const schemaParsePaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      price: pricing.schemaParse,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  error: "Payment required",
};

schemaParseRouter.get("/schema-parse/extract", (_req: Request, res: Response) => {
  res.status(402).json(schemaParsePaymentRequired);
});

schemaParseRouter.head("/schema-parse/extract", (_req: Request, res: Response) => {
  res.status(402).end();
});

const anthropic = new Anthropic();

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

    // Bound the call with an AbortController so a timeout actually CANCELS the
    // upstream request (not just the caller's promise), and clear the timer on
    // completion. timeouts.schemaParse is unchanged (30s).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeouts.schemaParse);
    let response: Anthropic.Message;
    try {
      response = await anthropic.messages.create(
        {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4096,
          system: "You are a precise data extraction engine. Extract information from the provided text strictly according to the tool schema. If a field cannot be found, omit it or use null.",
          tools: [
            {
              name: "extract",
              description: "Extract structured data from the provided text",
              input_schema: { type: "object", ...target_schema } as Anthropic.Tool["input_schema"],
            },
          ],
          tool_choice: { type: "tool", name: "extract" },
          messages: [{ role: "user", content: raw_text }],
        },
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }

    // Truncation guard: if the model hit max_tokens, the tool output may be
    // partial/invalid. Fail (502 -> not charged) rather than return junk as 200.
    if (response.stop_reason === "max_tokens") {
      res.status(502).json({
        error: "Extraction truncated (response hit max_tokens) — reduce input or schema size",
      });
      return;
    }

    const toolBlock = response.content.find(
      (block): block is Anthropic.ContentBlock & { type: "tool_use" } =>
        block.type === "tool_use",
    );

    if (!toolBlock) {
      res.status(422).json({ error: "Model could not extract data matching the provided schema" });
      return;
    }

    // Confirm the caller's required fields are actually present before billing.
    // Presence-only and lenient: never rejects output that satisfies `required`,
    // and is a no-op when target_schema declares no required fields.
    const problems = validateAgainstSchema(toolBlock.input, target_schema);
    if (problems.length > 0) {
      res.status(422).json({
        error: "Extracted data did not match the requested schema",
        details: problems,
      });
      return;
    }

    // Record token usage for per-call cost/margin logging (read by the
    // paid-call logger at res.finish). Reuses the usage already surfaced below.
    res.locals.llmUsage = {
      model: "claude-haiku-4-5-20251001",
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    res.json({
      extracted: toolBlock.input,
      tokens_used: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (
      err instanceof Anthropic.APIError ||
      (err instanceof Error &&
        (err.name === "AbortError" || err.name === "APIUserAbortError"))
    ) {
      console.error("Schema parse extraction error:", err);
      res.status(502).json({ error: "Extraction service unavailable" });
      return;
    }
    console.error("Schema parse error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
