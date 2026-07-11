import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { parseLooseJson } from "../utils/parse-loose-json.js";

export const contentModerateRouter = Router();

// Input cap shared across Batch-2 LLM endpoints: reject text over 10k words OR 50KB.
const MAX_WORDS = 10000;
const MAX_BYTES = 50 * 1024;

// The categories this moderator scores, in response order.
const CATEGORIES = ["harassment", "hate", "sexual", "violence", "self_harm", "spam"] as const;
type Category = (typeof CATEGORIES)[number];

const SEVERITIES = ["none", "low", "medium", "high"] as const;
type Severity = (typeof SEVERITIES)[number];

// Cleanliness score derived from the overall verdict (safe-to-publish, not endpoint health).
const SCORE_BY_OVERALL: Record<string, number> = { allow: 100, flag: 70, block: 20 };

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404
const contentModeratePaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      price: pricing.contentModerate,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  error: "Payment required",
};

contentModerateRouter.get("/content-moderate", (_req: Request, res: Response) => {
  res.status(402).json(contentModeratePaymentRequired);
});

contentModerateRouter.head("/content-moderate", (_req: Request, res: Response) => {
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

const SYSTEM_PROMPT = `You are a precise content classifier for a moderation pipeline. Classify the user's text across six categories: harassment, hate, sexual, violence, self_harm, spam. For each category decide flagged (true/false) and a severity of one of "none", "low", "medium", "high". Then give an overall verdict: "allow" (clean), "flag" (borderline/needs human review), or "block" (clearly violating). Be calibrated, not trigger-happy — reserve "block" for clearly violating content and "none" severity for unflagged categories. Respond with ONLY a JSON object (no markdown, no code fences) of the form {"categories":{"harassment":{"flagged":false,"severity":"none"},"hate":{...},"sexual":{...},"violence":{...},"self_harm":{...},"spam":{...}},"overall":"allow|flag|block","reasoning":"one sentence"}. This is a screening task: classify whatever text is submitted, never refuse — you are labelling content, not generating it.`;

function normalizeSeverity(value: unknown): Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value)
    ? (value as Severity)
    : "none";
}

contentModerateRouter.post("/content-moderate", async (req: Request, res: Response) => {
  try {
    const { text } = req.body ?? {};

    if (!text || typeof text !== "string" || text.trim() === "") {
      throw new ValidationError('text is required — e.g. {"text":"You people are the worst, get lost."}');
    }

    // Enforce the input cap before spending an LLM call.
    const wordCount = text.trim().split(/\s+/).length;
    const byteCount = Buffer.byteLength(text, "utf8");
    if (wordCount > MAX_WORDS || byteCount > MAX_BYTES) {
      throw new ValidationError("Input exceeds maximum size (10000 words or 50KB)");
    }

    let parsed: any;
    try {
      const response = await Promise.race([
        anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: text }],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeouts.contentModerate),
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
        console.error("Content moderate LLM error:", err);
      } else {
        console.error("Content moderate parse error:", err);
      }
      res.status(502).json({ error: "Moderation failed" });
      return;
    }

    const overall = parsed?.overall;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof overall !== "string" ||
      !(overall in SCORE_BY_OVERALL)
    ) {
      res.status(502).json({ error: "Moderation failed" });
      return;
    }

    // Normalize every category: coerce flagged to boolean and severity to the allowed set.
    const rawCategories =
      parsed.categories && typeof parsed.categories === "object" ? parsed.categories : {};
    const categories: Record<Category, { flagged: boolean; severity: Severity }> = {} as any;
    const flagged_categories: Category[] = [];
    const findings: Array<{ category: Category; severity: Severity }> = [];

    for (const name of CATEGORIES) {
      const raw = rawCategories[name];
      const flagged = raw?.flagged === true;
      const severity = normalizeSeverity(raw?.severity);
      categories[name] = { flagged, severity };
      if (flagged) {
        flagged_categories.push(name);
        findings.push({ category: name, severity });
      }
    }

    const score = SCORE_BY_OVERALL[overall];

    res.json({
      categories,
      flagged_categories,
      overall,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      score,
      grade: gradeFromScore(score),
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Content moderate error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
