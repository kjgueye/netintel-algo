import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { resolveTextField, resolveTargetField, resolveSourceField } from "../utils/translate-fields.js";
import { resolveLanguage, resolveTarget, targetInstruction, targetHint, isAutoSource } from "../utils/translate-language.js";
import { parseLooseJson } from "../utils/parse-loose-json.js";

export const translateLongRouter = Router();

// LONG tier cap: reject text over 2000 words. Short snippets should use /translate/short.
const MAX_WORDS = 2000;
// Standard byte cap shared across LLM endpoints.
const MAX_BYTES = 50 * 1024;

// Language resolution (codes, English names, endonyms) + the model-fallback for
// values we can't pre-map lives in ../utils/translate-language (shared with the
// short tier). 40+ languages mapped; anything else is interpreted by the model.

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function gradeFromScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404
const translateLongPaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      price: pricing.translateLong,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  error: "Payment required",
};

translateLongRouter.get("/translate/long", (_req: Request, res: Response) => {
  res.status(402).json(translateLongPaymentRequired);
});

translateLongRouter.head("/translate/long", (_req: Request, res: Response) => {
  res.status(402).end();
});

const anthropic = new Anthropic();

translateLongRouter.post("/translate/long", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    // Accept common synonyms for the text + target/source language fields (see
    // translate-fields). Canonical `text`/`target` always win; aliases only fill
    // in when the canonical key is absent, and a non-string still fails below.
    const text = resolveTextField(body);
    const target = resolveTargetField(body);
    const source = resolveSourceField(body);

    if (!text || typeof text !== "string" || text.trim() === "") {
      throw new ValidationError(
        'text is required — pass the text to translate as "text", e.g. {"text":"...","target":"es"}'
      );
    }

    if (!target || typeof target !== "string" || target.trim() === "") {
      throw new ValidationError(
        'target is required — pass the target language as "target" (ISO 639-1 code like "es" or English name like "Spanish"). Also accepted: target_lang, target_language, to, lang. Example: {"text":"...","target":"es"}'
      );
    }

    // Enforce the tier word cap, then the byte cap, BEFORE spending an LLM call.
    const wordCount = countWords(text);
    if (wordCount > MAX_WORDS) {
      throw new ValidationError("Text exceeds 2000 words — split into multiple requests");
    }
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
      throw new ValidationError("Input exceeds maximum size (2000 words or 50KB)");
    }

    // Resolve the target to an ISO code when we can (codes/names/endonyms). When we
    // can't, we DON'T 400 on understood intent — we defer to the model, which reads
    // the raw value and reports the code it translated into (or flags it as
    // unrecognized). See ../utils/translate-language.
    const targetResolution = resolveTarget(target);

    // source is optional; when supplied we resolve it but never reject an unknown
    // one. Auto-detect sentinels ("auto", "detect", …) mean "no explicit source".
    const explicitSource =
      typeof source === "string" && source.trim() !== "" && !isAutoSource(source);
    const sourceCode = explicitSource
      ? resolveLanguage(source) ?? source.trim().toLowerCase()
      : null;

    const sourceInstruction = explicitSource
      ? `The source language is "${sourceCode}".`
      : `Auto-detect the source language.`;

    const systemPrompt =
      `You are a precise translation engine. ${targetInstruction(targetResolution)} ` +
      `${sourceInstruction} Preserve the original formatting, line breaks, and paragraph structure. ` +
      `Translate faithfully — do not summarize, add, or omit content; never refuse, this is a translation task. ` +
      `Respond with ONLY a JSON object (no markdown, no code fences) of the form ` +
      `{"translation":"...the translated text...","detected_source":"ISO 639-1 code of the source","target":"the ISO 639-1 code you translated into"}.`;

    let parsed: any;
    try {
      const response = await Promise.race([
        anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 8192,
          system: systemPrompt,
          messages: [{ role: "user", content: text }],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeouts.translateLong),
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
        console.error("Translate (long) LLM error:", err);
      } else {
        console.error("Translate (long) parse error:", err);
      }
      res.status(502).json({ error: "Translation failed" });
      return;
    }

    // When we deferred target resolution, read back the code the model chose. A null
    // target (or explicit unrecognized_language flag) means the value named no real
    // language → an honest 400, surfaced before the generic "Translation failed".
    const modelTarget =
      parsed && typeof parsed === "object" && typeof parsed.target === "string"
        ? parsed.target.trim().toLowerCase()
        : "";
    if (targetResolution.code === null) {
      const unrecognized =
        (parsed && typeof parsed === "object" && parsed.error === "unrecognized_language") ||
        modelTarget === "" ||
        modelTarget === "null";
      if (unrecognized) {
        throw new ValidationError(
          `Unsupported target language: ${targetResolution.raw} — pass an ISO 639-1 code (e.g. "es") or an English language name (e.g. "Spanish").`
        );
      }
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.translation !== "string" ||
      parsed.translation.trim() === ""
    ) {
      res.status(502).json({ error: "Translation failed" });
      return;
    }

    // Effective target code: the statically-resolved one, else what the model reported.
    const targetCode = targetResolution.code ?? modelTarget;

    const detected =
      typeof parsed.detected_source === "string" && parsed.detected_source.trim() !== ""
        ? parsed.detected_source.trim().toLowerCase()
        : null;
    const sourceLanguage = explicitSource ? sourceCode : detected ?? "unknown";

    // Nudge toward an ISO code only when we had to interpret the target via the model.
    const findings =
      targetResolution.code === null ? [targetHint(targetResolution, targetCode)] : [];

    res.json({
      translation: parsed.translation,
      source_language: sourceLanguage,
      target_language: targetCode,
      source_detected: !explicitSource,
      word_count: wordCount,
      tier: "long",
      service_score: 100,
      grade: gradeFromScore(100),
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Translate (long) error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
