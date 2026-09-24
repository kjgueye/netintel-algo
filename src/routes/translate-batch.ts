import { Router, type Request, type Response } from "express";
import { signableAccepts } from "../accepts.js";
import { config, pricing, timeouts, translateBatch as batchPricing } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { resolveTargetField, resolveSourceField } from "../utils/translate-fields.js";
import { isAutoSource, resolveLanguage, resolveTarget, targetHint } from "../utils/translate-language.js";
// The translation engine, the placeholder validator, the structure validator, the
// glossary checker and the content-type detector are ALL owned by
// /translate/structured and imported here — this route contributes only the BATCH
// layer (fan-out, per-item verdicts, ordering, pricing). Nothing below re-implements
// tokenization or translation; a fix there is a fix here.
import {
  detectContentType,
  translateStructured,
  type TranslateResult,
} from "./translate-structured.js";

export const translateBatchRouter = Router();

// Caps enforced BEFORE any model call, so a hostile payload is never billed.
const MAX_ITEMS = 30;
const MAX_TOTAL_BYTES = 64 * 1024;
const MAX_ITEM_BYTES = 8 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_GLOSSARY_TERMS = 100;
const MAX_PROTECTED_VALUES = 100;
const MAX_ITEM_WARNINGS = 10;

// Items are independent, so they fan out — but a 200-item batch must not open 200
// sockets to the model at once. Waves of this size keep the concurrency bounded
// and give the batch deadline a natural place to be checked.
const CONCURRENCY = 6;

// Reported in the usage envelope only; the actual model call lives in
// /translate/structured's core (swapped to gpt-4o-mini 2026-09-02). Keep this in
// step with translate-structured's MODEL — batch runs that same core per item.
const MODEL = "gpt-4o-mini";

/** Why an item has status="failed". Mapped from the core's TranslateFailure codes. */
type FailureReason = "structure_broken" | "unparseable" | "truncated" | "llm_unavailable" | "timeout";

const REASON_BY_CODE: Record<string, FailureReason> = {
  STRUCTURE_BROKEN: "structure_broken",
  LLM_UNPARSEABLE: "unparseable",
  TRUNCATED_OUTPUT: "truncated",
  LLM_UNAVAILABLE: "llm_unavailable",
};

interface BatchItem {
  id: string;
  text: string;
  context: string | null;
}

interface ItemResult {
  id: string;
  status: "ok" | "failed";
  translated: string | null;
  detected_language: string | null;
  confidence: number | null;
  warnings: string[];
  reason?: FailureReason;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function gradeFromScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// INPUT
// ---------------------------------------------------------------------------

function parseItems(raw: unknown): BatchItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError(
      'items is required — a non-empty array of {id, text} objects, e.g. ' +
        '{"items":[{"id":"greeting","text":"Hello {{name}}"}],"target":"fr"}',
    );
  }
  if (raw.length > MAX_ITEMS) {
    throw new ValidationError(
      `items exceeds the maximum batch size of ${MAX_ITEMS} — split it into multiple requests`,
    );
  }

  const items: BatchItem[] = [];
  let totalBytes = 0;

  raw.forEach((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new ValidationError(
        `items[${i}] must be an object with an id and text — e.g. {"id":"greeting","text":"Hello"}`,
      );
    }
    const id = entry.id;
    const text = entry.text;

    if (typeof id !== "string" || id.trim() === "") {
      throw new ValidationError(
        `items[${i}].id is required — a non-empty string you use to match the translation back to your source string`,
      );
    }
    if (id.length > MAX_ID_LENGTH) {
      throw new ValidationError(`items[${i}].id exceeds the maximum length of ${MAX_ID_LENGTH} characters`);
    }
    if (typeof text !== "string" || text.trim() === "") {
      throw new ValidationError(`items[${i}].text is required — a non-empty string to translate`);
    }

    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_ITEM_BYTES) {
      throw new ValidationError(
        `items[${i}].text exceeds the per-item maximum of ${MAX_ITEM_BYTES / 1024}KB — ` +
          `use /translate/structured or /translate/long for a single large document`,
      );
    }
    totalBytes += bytes;

    const context = typeof entry.context === "string" && entry.context.trim() !== "" ? entry.context.trim() : null;
    items.push({ id: id.trim(), text, context });
  });

  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new ValidationError(
      `items exceed the total payload cap of ${MAX_TOTAL_BYTES / 1024}KB — split them into multiple requests`,
    );
  }

  return items;
}

function parseGlossary(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) {
    throw new ValidationError(
      'glossary must be an object of {term: translation} — e.g. {"glossary":{"dashboard":"tableau de bord"}}',
    );
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_GLOSSARY_TERMS) {
    throw new ValidationError(`glossary exceeds the maximum of ${MAX_GLOSSARY_TERMS} terms`);
  }
  const out: Record<string, string> = {};
  for (const [term, translation] of entries) {
    if (typeof translation !== "string" || translation.trim() === "") {
      throw new ValidationError(
        `glossary["${term}"] must be a non-empty string translation — e.g. {"glossary":{"dashboard":"tableau de bord"}}`,
      );
    }
    out[term] = translation;
  }
  return out;
}

function parseProtectedValues(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ValidationError(
      'protected_values must be an array of strings — e.g. {"protected_values":["Acme","SKU-1234"]}',
    );
  }
  if (raw.length > MAX_PROTECTED_VALUES) {
    throw new ValidationError(`protected_values exceeds the maximum of ${MAX_PROTECTED_VALUES} entries`);
  }
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ValidationError('protected_values entries must be non-empty strings — e.g. ["Acme","SKU-1234"]');
    }
    out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PER-ITEM VERDICT
// ---------------------------------------------------------------------------

/**
 * Confidence is OUR verification confidence, not a model self-report: an item that
 * came back with every placeholder, tag, and protected value accounted for, and
 * every glossary term the caller asked for, is one we checked and can stand behind.
 * A missed glossary term is the model overriding an explicit instruction — the
 * translation is probably fine, but it is not what was asked for, so it scores lower.
 */
function itemConfidence(missedGlossary: number): number {
  return missedGlossary > 0 ? 0.85 : 0.98;
}

function toItemResult(item: BatchItem, result: TranslateResult): ItemResult {
  if (!result.ok) {
    const warnings: string[] = [];
    if (result.code === "STRUCTURE_BROKEN") {
      for (const token of result.missing) warnings.push(`dropped placeholder ${token}`);
      if (result.detail) warnings.push(result.detail);
    }
    return {
      id: item.id,
      status: "failed",
      translated: null,
      detected_language: null,
      confidence: null,
      warnings: warnings.slice(0, MAX_ITEM_WARNINGS),
      reason: REASON_BY_CODE[result.code] ?? "unparseable",
    };
  }

  const warnings: string[] = [];
  if (result.glossaryCompliance.missed.length > 0) {
    warnings.push(`glossary terms not applied: ${result.glossaryCompliance.missed.join(", ")}`);
  }

  return {
    id: item.id,
    status: "ok",
    // A JSON-shaped item comes back from the core as an object; the batch envelope
    // hands every item back as the string the caller sent in.
    translated: typeof result.translated === "string" ? result.translated : JSON.stringify(result.translated),
    detected_language: result.detectedLanguage,
    confidence: itemConfidence(result.glossaryCompliance.missed.length),
    warnings: warnings.slice(0, MAX_ITEM_WARNINGS),
  };
}

// ---------------------------------------------------------------------------
// ROUTE
// ---------------------------------------------------------------------------

const translateBatchPaymentRequired = {
  x402Version: 2,
  accepts: signableAccepts(pricing.translateBatch),
  error: "Payment required",
};

translateBatchRouter.get("/translate/batch", (_req: Request, res: Response) => {
  res.status(402).json(translateBatchPaymentRequired);
});

translateBatchRouter.head("/translate/batch", (_req: Request, res: Response) => {
  res.status(402).end();
});

translateBatchRouter.post("/translate/batch", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const items = parseItems(body.items ?? body.strings ?? body.texts);
    const target = resolveTargetField(body);
    const source = resolveSourceField(body);

    if (!target || typeof target !== "string" || target.trim() === "") {
      throw new ValidationError(
        'target is required — the target language as an ISO 639-1 code ("fr") or English name ("French"). ' +
          'Also accepted: target_lang, target_language, to, lang. ' +
          'Example: {"items":[{"id":"greeting","text":"Hello"}],"target":"fr"}',
      );
    }

    const glossary = parseGlossary(body.glossary ?? body.terms ?? body.term_map);
    const protectedValues = parseProtectedValues(body.protected_values ?? body.protectedValues ?? body.do_not_translate);

    const rawFormality = body.formality;
    let formality: "formal" | "informal" | null = null;
    if (rawFormality !== undefined && rawFormality !== null && rawFormality !== "") {
      const value = String(rawFormality).trim().toLowerCase();
      if (value !== "formal" && value !== "informal" && value !== "neutral") {
        throw new ValidationError('formality must be "formal", "informal", or "neutral" (default neutral)');
      }
      formality = value === "neutral" ? null : value;
    }

    const tone = typeof body.tone === "string" && body.tone.trim() !== "" ? body.tone.trim() : null;

    const targetResolution = resolveTarget(target);
    const explicitSource = typeof source === "string" && source.trim() !== "" && !isAutoSource(source);
    const sourceCode = explicitSource
      ? resolveLanguage(source as string) ?? (source as string).trim().toLowerCase()
      : null;

    // --- fan out -----------------------------------------------------------
    //
    // One model call per item. That is what buys the product: a per-item detected
    // language, a per-item placeholder verdict, and — the whole point of a batch
    // endpoint — PARTIAL SUCCESS. One item the model mangles fails alone; it never
    // takes the other 24 with it.
    const deadline = Date.now() + timeouts.translateBatch;
    const results = new Array<ItemResult>(items.length);
    let unsupportedTarget: string | null = null;
    // The code the model says it translated INTO — only interesting when we could
    // not pre-map the caller's target (e.g. "Wolof") and had to defer to the model.
    let modelTarget: string | null = null;
    const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };

    for (let start = 0; start < items.length; start += CONCURRENCY) {
      const wave = items.slice(start, start + CONCURRENCY);

      if (Date.now() > deadline) {
        // Out of wall-clock: the items we did translate are still the product, so
        // the rest come back as failed verdicts rather than a 504 for the batch.
        wave.forEach((item, i) => {
          results[start + i] = {
            id: item.id,
            status: "failed",
            translated: null,
            detected_language: null,
            confidence: null,
            warnings: [],
            reason: "timeout",
          };
        });
        continue;
      }

      const settled = await Promise.all(
        wave.map((item) =>
          translateStructured({
            content: item.text,
            contentType: detectContentType(item.text),
            target: targetResolution,
            sourceCode,
            glossary,
            protectedValues,
            formality,
            // The core takes free-form guidance as `tone`; a per-item `context`
            // ("button label", "error shown to admins") is exactly that, so it
            // rides alongside the batch-wide tone rather than duplicating a prompt.
            tone: [tone, item.context ? `Context for this string: ${item.context}` : null]
              .filter(Boolean)
              .join(". ") || null,
            locale: null,
          }).catch(
            (err): TranslateResult => {
              console.error("Translate (batch) item error:", err);
              return { ok: false, code: "LLM_UNAVAILABLE", error: "Translation service unavailable" };
            },
          ),
        ),
      );

      settled.forEach((result, i) => {
        const item = wave[i];
        if (result.ok) {
          if (result.usage) {
            usage.inputTokens += result.usage.inputTokens;
            usage.outputTokens += result.usage.outputTokens;
            usage.calls += 1;
          }
          if (!modelTarget && result.targetLanguage) modelTarget = result.targetLanguage;
        }
        // The target is batch-wide, so a target that names no real language makes
        // the ENTIRE batch meaningless — a 400 (uncharged), not 200 failed items.
        if (!result.ok && result.code === "UNSUPPORTED_TARGET") unsupportedTarget = result.error;
        results[start + i] = toItemResult(item, result);
      });

      if (unsupportedTarget) break;
    }

    if (unsupportedTarget) {
      res.status(400).json({ error: unsupportedTarget, code: "UNSUPPORTED_TARGET" });
      return;
    }

    // --- envelope ----------------------------------------------------------
    if (usage.calls > 0) {
      res.locals.llmUsage = { model: MODEL, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    }

    const succeeded = results.filter((r) => r.status === "ok").length;
    const failed = results.length - succeeded;
    const billedItems = results.length;
    const overageItems = Math.max(0, billedItems - batchPricing.includedItems);

    const warnings: string[] = [];
    const findings: Array<{ rule: string; deduction: number; detail: string }> = [];
    let score = 100;

    if (failed > 0 && succeeded > 0) {
      warnings.push(`${failed} of ${billedItems} items failed — see each item's status and reason`);
      findings.push({
        rule: "some_items_failed",
        deduction: 0,
        detail: `${failed} item(s) failed. Partial success is valid: the ${succeeded} translated item(s) are correct and verified.`,
      });
    }

    if (failed > 0 && succeeded === 0) {
      score -= 20;
      warnings.push("every item failed — see each item's reason");
      findings.push({
        rule: "all_items_failed",
        deduction: 20,
        detail: "No item in the batch translated successfully. The per-item reasons are in items[].reason.",
      });
    }

    // The target language actually used: the pre-mapped code, or the code the model
    // reported when it had to interpret the caller's value.
    const effectiveTarget = targetResolution.code ?? modelTarget ?? targetResolution.raw;
    if (targetResolution.code === null && modelTarget) {
      warnings.push(targetHint(targetResolution, effectiveTarget));
    }

    score = Math.max(0, score);

    res.json({
      target_language: effectiveTarget,
      item_count: results.length,
      succeeded,
      failed,
      items: results,
      billed_items: billedItems,
      pricing: {
        base_usd: pricing.translateBatch,
        included_items: batchPricing.includedItems,
        overage_items: overageItems,
        overage_per_item_usd: batchPricing.overagePerItem,
        overage_usd: Number((overageItems * batchPricing.overagePerItem).toFixed(6)),
      },
      usage: {
        model: MODEL,
        model_calls: usage.calls,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
      },
      warnings,
      score,
      grade: gradeFromScore(score),
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Translate (batch) error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
