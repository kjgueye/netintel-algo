import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { parseLooseJson } from "../utils/parse-loose-json.js";

export const entityExtractRouter = Router();

// Input cap shared across Batch-2 LLM endpoints: reject text over 10k words OR 50KB.
const MAX_WORDS = 10000;
const MAX_BYTES = 50 * 1024;

// The entity types this extractor knows, in canonical response order.
const ENTITY_TYPES = [
  "person",
  "organization",
  "location",
  "date",
  "email",
  "url",
  "money",
  "product",
  "phone",
] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404
const entityExtractPaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      price: pricing.entityExtract,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  error: "Payment required",
};

entityExtractRouter.get("/entity-extract", (_req: Request, res: Response) => {
  res.status(402).json(entityExtractPaymentRequired);
});

entityExtractRouter.head("/entity-extract", (_req: Request, res: Response) => {
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

// Coerce a model-supplied value into a deduped array of non-empty strings, preserving order.
function normalizeEntityArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

entityExtractRouter.post("/entity-extract", async (req: Request, res: Response) => {
  try {
    const { text, types } = req.body ?? {};

    if (!text || typeof text !== "string" || text.trim() === "") {
      throw new ValidationError('text is required — e.g. {"text":"Tim Cook met Angela Merkel in Berlin on June 3, 2024"}');
    }

    // Resolve the set of types to extract — caller subset, or all when omitted.
    let activeTypes: EntityType[] = [...ENTITY_TYPES];
    if (types !== undefined && types !== null) {
      if (
        !Array.isArray(types) ||
        types.length === 0 ||
        !types.every((t) => typeof t === "string" && (ENTITY_TYPES as readonly string[]).includes(t))
      ) {
        throw new ValidationError(
          `types must be a non-empty subset of: ${ENTITY_TYPES.join(", ")}`,
        );
      }
      // Preserve canonical order and dedupe the requested subset.
      activeTypes = ENTITY_TYPES.filter((t) => types.includes(t));
    }

    // Enforce the input cap before spending an LLM call.
    const wordCount = text.trim().split(/\s+/).length;
    const byteCount = Buffer.byteLength(text, "utf8");
    if (wordCount > MAX_WORDS || byteCount > MAX_BYTES) {
      throw new ValidationError("Input exceeds maximum size (10000 words or 50KB)");
    }

    const typeList = activeTypes.join(", ");
    const systemPrompt = `You are a precise named-entity extraction engine. Extract entities from the user's text for exactly these types: ${typeList}. Respond with ONLY a JSON object (no markdown, no code fences) whose keys are exactly ${typeList} and whose values are arrays of unique strings exactly as they appear in the text. Use an empty array for any type with no entities. Never include duplicates within an array and never add types beyond the listed ones. This is an extraction task — label whatever text is submitted, never refuse.`;

    let parsed: any;
    try {
      const response = await Promise.race([
        anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: "user", content: text }],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeouts.entityExtract),
        ),
      ]);

      const textBlock = response.content.find(
        (block): block is Anthropic.ContentBlock & { type: "text" } =>
          block.type === "text",
      );
      if (!textBlock) throw new Error("no text content");

      parsed = parseLooseJson(textBlock.text);

      // Record token usage for per-call cost/margin logging (read at res.finish).
      res.locals.llmUsage = {
        model: "claude-haiku-4-5-20251001",
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (err) {
      if (err instanceof Anthropic.APIError || (err instanceof Error && err.message === "timeout")) {
        console.error("Entity extract LLM error:", err);
      } else {
        console.error("Entity extract parse error:", err);
      }
      res.status(502).json({ error: "Entity extraction failed" });
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      res.status(502).json({ error: "Entity extraction failed" });
      return;
    }

    // Build the entities object for only the active types, normalizing each array.
    const entities: Record<string, string[]> = {};
    let totalEntities = 0;
    for (const type of activeTypes) {
      const arr = normalizeEntityArray(parsed[type]);
      entities[type] = arr;
      totalEntities += arr.length;
    }

    // Zero entities is a valid result, but without an explanation callers read
    // it as a silent failure and retry the same paid call (seen in production).
    const findings: string[] = [];
    if (totalEntities === 0) {
      findings.push(
        `No entities of the extracted types (${activeTypes.join(", ")}) were found in the text. ` +
          `This is a valid result, not an error. This endpoint extracts entities FROM the supplied text — ` +
          `it does not answer questions or perform tasks described in it. If you expected entities, ` +
          `check that "text" contains the document to analyze.`,
      );
    }

    const score = 100;
    res.json({
      entities,
      total_entities: totalEntities,
      types_extracted: activeTypes,
      score,
      grade: gradeFromScore(score),
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Entity extract error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
