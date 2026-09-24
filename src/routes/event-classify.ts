import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { parseLooseJson } from "../utils/parse-loose-json.js";
import { signableAccepts } from "../accepts.js";

export const eventClassifyRouter = Router();

// Input cap shared across the LLM endpoints: reject text over 10k words OR 50KB.
const MAX_WORDS = 10000;
const MAX_BYTES = 50 * 1024;

// Public-facing model label for the response envelope. The real SDK model id
// (claude-haiku-4-5-20251001) is matched to /schema-parse/extract.
const MODEL = "claude-haiku-4-5-20251001";
const MODEL_LABEL = "haiku-4.5";

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404
const eventClassifyPaymentRequired = {
  x402Version: 2,
  accepts: signableAccepts(pricing.eventClassify),
  error: "Payment required",
};

eventClassifyRouter.get("/event-classify", (_req: Request, res: Response) => {
  res.status(402).json(eventClassifyPaymentRequired);
});

eventClassifyRouter.head("/event-classify", (_req: Request, res: Response) => {
  res.status(402).end();
});

const anthropic = new Anthropic();

// The event definition, lifted verbatim from the proven /event-extract field
// description so this filter and the full extractor agree on what counts.
const SYSTEM_PROMPT =
  'You are a fast binary classifier that decides whether a piece of text announces a real-world event. ' +
  'is_event = true ONLY if this announces a specific, dateable real-world event someone could add to a calendar. ' +
  "A mood post, product photo, past-event recap, artist statement, or evergreen 'now open' post is NOT an event. " +
  'If posted_at is supplied, an event whose only date is in the past relative to it is NOT a dateable event (is_event=false). ' +
  "For vague or undated posts ('coming soon', 'stay tuned') there is no resolvable date, so is_event=false — do NOT over-claim a true. " +
  'Respond with ONLY a JSON object (no markdown, no code fences, no extra prose) of the form ' +
  '{"is_event": true|false, "confidence": 0.0-1.0, "reason": "one short line"}. ' +
  'reason is a terse tag for agent logging, e.g. "specific dated event", "past-event recap", "product post", "no resolvable date". ' +
  'Do NOT extract any event details — only the three fields above.';

interface Verdict {
  is_event: boolean;
  confidence: number;
  reason: string;
}

// Coerce the parsed model output into the minimal verdict shape. Returns null
// if the core field (is_event) is absent/wrong-typed → treated as malformed.
function coerceVerdict(parsed: unknown): Verdict | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.is_event !== "boolean") return null;

  const confidence =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? Math.min(1, Math.max(0, obj.confidence))
      : 0;

  const reason =
    typeof obj.reason === "string" && obj.reason.trim() !== ""
      ? obj.reason.trim()
      : obj.is_event
        ? "event"
        : "not an event";

  return { is_event: obj.is_event, confidence, reason };
}

eventClassifyRouter.post("/event-classify", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const { text, posted_at, timezone } = body;

    if (!text || typeof text !== "string" || text.trim() === "") {
      throw new ValidationError('text is required — e.g. {"text":"Join us for DevConf on Aug 15 at the Moscone Center"}');
    }

    // Enforce the input cap before spending an LLM call (UNCHARGED 400).
    const wordCount = text.trim().split(/\s+/).length;
    const byteCount = Buffer.byteLength(text, "utf8");
    if (wordCount > MAX_WORDS || byteCount > MAX_BYTES) {
      throw new ValidationError("Input exceeds maximum size (10000 words or 50KB)");
    }

    // Supply optional date context to the prompt only when present.
    const contextLines: string[] = [];
    if (typeof posted_at === "string" && posted_at.trim() !== "") {
      contextLines.push(`Posted at: ${posted_at.trim()}`);
    }
    if (typeof timezone === "string" && timezone.trim() !== "") {
      contextLines.push(`Timezone: ${timezone.trim()}`);
    }
    const userContent = contextLines.length
      ? `${contextLines.join("\n")}\n\n${text}`
      : text;

    // Single Haiku call, retried once on malformed JSON. A truncated response
    // (max_tokens) fails immediately — retrying would just burn another call.
    let verdict: Verdict | null = null;
    let lastUsage: Anthropic.Message["usage"] | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeouts.eventClassify);
      let response: Anthropic.Message;
      try {
        response = await anthropic.messages.create(
          {
            model: MODEL,
            max_tokens: 256,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userContent }],
          },
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
      }

      lastUsage = response.usage;

      // Truncation guard: a partial reply is unreliable — fail UNCHARGED (502).
      if (response.stop_reason === "max_tokens") {
        res.status(502).json({ error: "Classification truncated" });
        return;
      }

      const textBlock = response.content.find(
        (block): block is Anthropic.ContentBlock & { type: "text" } =>
          block.type === "text",
      );

      if (textBlock) {
        try {
          verdict = coerceVerdict(parseLooseJson(textBlock.text));
        } catch {
          verdict = null;
        }
      }

      if (verdict) break;
    }

    if (!verdict) {
      // Malformed after the retry → UNCHARGED 502.
      res.status(502).json({ error: "Classification failed" });
      return;
    }

    // Record token usage for per-call cost/margin logging (read at res.finish).
    if (lastUsage) {
      res.locals.llmUsage = {
        model: MODEL,
        inputTokens: lastUsage.input_tokens,
        outputTokens: lastUsage.output_tokens,
      };
    }

    res.json({
      data: {
        is_event: verdict.is_event,
        confidence: verdict.confidence,
        reason: verdict.reason,
      },
      meta: { model: MODEL_LABEL },
      score: 100,
      grade: "A",
      findings: [],
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
      console.error("Event classify LLM error:", err);
      res.status(502).json({ error: "Classification failed" });
      return;
    }
    console.error("Event classify error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
