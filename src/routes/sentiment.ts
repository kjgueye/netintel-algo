import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { parseLooseJson } from "../utils/parse-loose-json.js";

export const sentimentRouter = Router();

// Input cap shared across Batch-2 LLM endpoints: reject text over 10k words OR 50KB.
const MAX_WORDS = 10000;
const MAX_BYTES = 50 * 1024;

// Max number of caller-supplied aspects for aspect-based sentiment.
const MAX_ASPECTS = 10;

// Allowed polarity values for both overall and per-aspect sentiment.
const POLARITIES = ["positive", "negative", "neutral", "mixed"] as const;
type Polarity = (typeof POLARITIES)[number];

// Known emotion vocabulary — model output is filtered to this set to keep responses clean.
const EMOTIONS = ["joy", "anger", "sadness", "fear", "surprise", "disgust", "trust", "anticipation"] as const;

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404
const sentimentPaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      price: pricing.sentiment,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  error: "Payment required",
};

sentimentRouter.get("/sentiment/analyze", (_req: Request, res: Response) => {
  res.status(402).json(sentimentPaymentRequired);
});

sentimentRouter.head("/sentiment/analyze", (_req: Request, res: Response) => {
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

function normalizePolarity(value: unknown): Polarity | null {
  return typeof value === "string" && (POLARITIES as readonly string[]).includes(value)
    ? (value as Polarity)
    : null;
}

// Coerce a model-supplied number into [min, max], or fall back when it isn't a finite number.
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

sentimentRouter.post("/sentiment/analyze", async (req: Request, res: Response) => {
  try {
    const { text, aspects } = req.body ?? {};

    if (!text || typeof text !== "string" || text.trim() === "") {
      throw new ValidationError('text is required — e.g. {"text":"The delivery was fast but the packaging was terrible"}');
    }

    // aspects is optional, but when supplied it must be 1-10 non-empty strings.
    let aspectList: string[] | null = null;
    if (aspects !== undefined && aspects !== null) {
      if (
        !Array.isArray(aspects) ||
        aspects.length > MAX_ASPECTS ||
        !aspects.every((a) => typeof a === "string" && a.trim() !== "")
      ) {
        throw new ValidationError("aspects must be an array of up to 10 non-empty strings");
      }
      aspectList = aspects.map((a) => a.trim());
    }

    // Enforce the input cap before spending an LLM call.
    const wordCount = text.trim().split(/\s+/).length;
    const byteCount = Buffer.byteLength(text, "utf8");
    if (wordCount > MAX_WORDS || byteCount > MAX_BYTES) {
      throw new ValidationError("Input exceeds maximum size (10000 words or 50KB)");
    }

    const aspectInstruction = aspectList
      ? ` Also assess sentiment toward each of these aspects: ${aspectList.join(", ")}. Include an "aspects" object whose keys are EXACTLY those aspect names, each mapping to {"polarity":"positive|negative|neutral|mixed","score":-1.0..1.0}.`
      : "";

    const systemPrompt =
      `You are a precise sentiment analysis engine. Analyze the overall sentiment of the user's text. ` +
      `Respond with ONLY a JSON object (no markdown, no code fences) of the form ` +
      `{"polarity":"positive|negative|neutral|mixed","score":-1.0..1.0,"confidence":0.0..1.0,"emotions":["joy","anger",...]}. ` +
      `"score" is the sentiment polarity as a number from -1.0 (very negative) to 1.0 (very positive); 0 is neutral. ` +
      `"confidence" is 0.0-1.0. "emotions" lists detected emotions drawn from joy, anger, sadness, fear, surprise, disgust, trust, anticipation — empty if none are strong.` +
      aspectInstruction +
      ` This is an analysis task: classify whatever text is submitted, never refuse — you are labelling sentiment, not generating content.`;

    let parsed: any;
    try {
      const response = await Promise.race([
        anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user", content: text }],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeouts.sentiment),
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
        console.error("Sentiment LLM error:", err);
      } else {
        console.error("Sentiment parse error:", err);
      }
      res.status(502).json({ error: "Sentiment analysis failed" });
      return;
    }

    const polarity = normalizePolarity(parsed?.polarity);
    if (!parsed || typeof parsed !== "object" || polarity === null) {
      res.status(502).json({ error: "Sentiment analysis failed" });
      return;
    }

    // sentiment score: -1..1. Distinct from service_score below.
    const score = clampNumber(parsed.score, -1, 1, 0);
    const confidence = clampNumber(parsed.confidence, 0, 1, 0);

    const emotions = Array.isArray(parsed.emotions)
      ? parsed.emotions
          .filter((e: unknown): e is string => typeof e === "string")
          .map((e: string) => e.toLowerCase().trim())
          .filter((e: string) => (EMOTIONS as readonly string[]).includes(e))
      : [];
    // De-duplicate while preserving order.
    const uniqueEmotions = [...new Set(emotions)];

    // Per-aspect sentiment is only returned when the caller supplied aspects.
    let responseAspects: Record<string, { polarity: Polarity; score: number }> | undefined;
    if (aspectList) {
      responseAspects = {};
      const rawAspects =
        parsed.aspects && typeof parsed.aspects === "object" ? parsed.aspects : {};
      for (const name of aspectList) {
        const raw = rawAspects[name];
        responseAspects[name] = {
          polarity: normalizePolarity(raw?.polarity) ?? "neutral",
          score: clampNumber(raw?.score, -1, 1, 0),
        };
      }
    }

    // Endpoint health score (for grade/consistency with other endpoints) — SEPARATE from the
    // sentiment "score" above. 100 on success; the grade is derived from this.
    const service_score = 100;

    res.json({
      polarity,
      score,
      confidence,
      emotions: uniqueEmotions,
      ...(responseAspects ? { aspects: responseAspects } : {}),
      service_score,
      grade: gradeFromScore(service_score),
      findings: [],
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Sentiment error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
