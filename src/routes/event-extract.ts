import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { parseLooseJson } from "../utils/parse-loose-json.js";

export const eventExtractRouter = Router();

// Input cap shared across the LLM endpoints: reject text over 10k words OR 50KB.
const MAX_WORDS = 10000;
const MAX_BYTES = 50 * 1024;

// Public-facing model label for the response envelope. The real SDK model id
// (claude-haiku-4-5-20251001) is matched to /schema-parse/extract.
const MODEL = "claude-haiku-4-5-20251001";
const MODEL_LABEL = "haiku-4.5";

// Grading deductions (see the spec's rubric). Score starts at 100.
const DEDUCT_DATE_BEFORE_POSTED = 15;
const DEDUCT_NAIVE_TIMEZONE = 5;

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404.
const eventExtractPaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      price: pricing.eventExtract,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  error: "Payment required",
};

eventExtractRouter.get("/event-extract", (_req: Request, res: Response) => {
  res.status(402).json(eventExtractPaymentRequired);
});

eventExtractRouter.head("/event-extract", (_req: Request, res: Response) => {
  res.status(402).end();
});

const anthropic = new Anthropic();

// The proven event field set is encoded internally — the caller does NOT supply
// a schema. The is_event definition is kept verbatim-aligned with /event-classify
// so the cheap front-end filter and this extractor agree on what counts.
const SYSTEM_PROMPT =
  "You are a precise calendar-event extractor. Given a caption, announcement, or page text, " +
  "decide whether it announces a real-world event and, if so, extract a normalized event record. " +
  "Respond with ONLY a single JSON object — no markdown, no code fences, no extra prose.\n\n" +
  "Fields:\n" +
  "- is_event (boolean): true ONLY if the text announces a specific, dateable real-world event " +
  "someone could add to a calendar. A mood post, product photo, past-event recap, artist statement, " +
  "or evergreen 'now open' post is NOT an event.\n" +
  "- confidence (number 0..1).\n" +
  "- reason (string): when is_event is false, a terse tag explaining why " +
  "(e.g. \"product post\", \"past-event recap\", \"no resolvable date\"). Omit when is_event is true.\n" +
  "- title (string): short event name.\n" +
  "- starts_at (string): ISO-8601 with timezone offset when a time is known. RESOLVE relative or " +
  "partial dates (\"this Saturday\", \"tonight\", \"7pm\") against the supplied \"Posted at\" anchor " +
  "and timezone. Use a bare date (YYYY-MM-DD) when only a date is known. If the year is absent, pick " +
  "the NEAREST FUTURE occurrence relative to the posted time. If you cannot anchor a date at all, use " +
  "null — do NOT invent one.\n" +
  "- ends_at (string): ISO-8601 end, or null if unknown.\n" +
  "- all_day (boolean): true when no specific clock time is given (gallery runs, multi-day fairs, " +
  "\"June 20\").\n" +
  "- timezone (string): the IANA timezone you actually resolved against. If none was supplied, infer " +
  "it from the city when possible (e.g. Los Angeles -> America/Los_Angeles); otherwise null.\n" +
  "- venue (string|null), address (string|null), city (string|null).\n" +
  "- price (string|null): \"Free\" if explicitly stated free, the stated price otherwise, null if not " +
  "mentioned — do NOT guess.\n" +
  "- url (string|null), organizer (string|null).\n" +
  "- date_resolved_from (string): \"explicit\" if an explicit year or full date appeared in the text, " +
  "\"posted_at\" if you resolved a relative/partial date against the posted time, \"none\" if you could " +
  "not anchor a date.\n\n" +
  "When is_event is false, set every event field (title, starts_at, ends_at, all_day, timezone, venue, " +
  "address, city, price, url, organizer) to null — do NOT fabricate.";

type DateResolvedFrom = "posted_at" | "explicit" | "none";

interface Extraction {
  is_event: boolean;
  confidence: number;
  reason: string | null;
  title: string | null;
  starts_at: string | null;
  ends_at: string | null;
  all_day: boolean;
  timezone: string | null;
  venue: string | null;
  address: string | null;
  city: string | null;
  price: string | null;
  url: string | null;
  organizer: string | null;
  date_resolved_from: DateResolvedFrom;
}

// Read an optional string field: a non-empty string, else null.
function optStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// Coerce the parsed model output into the Extraction shape. Returns null if the
// core field (is_event) is absent/wrong-typed → treated as malformed.
function coerceExtraction(parsed: unknown): Extraction | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.is_event !== "boolean") return null;

  const confidence =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? Math.min(1, Math.max(0, obj.confidence))
      : 0;

  const drf = obj.date_resolved_from;
  const date_resolved_from: DateResolvedFrom =
    drf === "posted_at" || drf === "explicit" || drf === "none" ? drf : "none";

  return {
    is_event: obj.is_event,
    confidence,
    reason: optStr(obj.reason),
    title: optStr(obj.title),
    starts_at: optStr(obj.starts_at),
    ends_at: optStr(obj.ends_at),
    all_day: obj.all_day === true,
    timezone: optStr(obj.timezone),
    venue: optStr(obj.venue),
    address: optStr(obj.address),
    city: optStr(obj.city),
    price: optStr(obj.price),
    url: optStr(obj.url),
    organizer: optStr(obj.organizer),
    date_resolved_from,
  };
}

// True if the timestamp string carries an explicit UTC offset (Z or ±hh:mm).
// A bare date or a naive timestamp has none → time is "floating".
function hasOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim());
}

interface Finding {
  rule: string;
  detail: string;
}

function gradeFor(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

eventExtractRouter.post("/event-extract", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const { text, posted_at, timezone, city } = body;

    if (!text || typeof text !== "string" || text.trim() === "") {
      throw new ValidationError('text is required — e.g. {"text":"Join us for DevConf on Aug 15 at 9am at the Moscone Center, SF"}');
    }

    // Enforce the input cap before spending an LLM call (UNCHARGED 400).
    const wordCount = text.trim().split(/\s+/).length;
    const byteCount = Buffer.byteLength(text, "utf8");
    if (wordCount > MAX_WORDS || byteCount > MAX_BYTES) {
      throw new ValidationError("Input exceeds maximum size (10000 words or 50KB)");
    }

    // Build the anchored prompt: feed the model the date/locale context when supplied.
    const contextLines: string[] = [];
    const postedAt = optStr(posted_at);
    const tz = optStr(timezone);
    const cityHint = optStr(city);
    if (postedAt) contextLines.push(`Posted at: ${postedAt}`);
    if (tz) contextLines.push(`Timezone: ${tz}`);
    if (cityHint) contextLines.push(`City: ${cityHint}`);
    const userContent = contextLines.length
      ? `${contextLines.join("\n")}\n\n${text}`
      : text;

    // Single Haiku call, retried once on malformed JSON. A truncated response
    // (max_tokens) fails immediately — retrying would just burn another call.
    let extraction: Extraction | null = null;
    let lastUsage: Anthropic.Message["usage"] | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeouts.eventExtract);
      let response: Anthropic.Message;
      try {
        response = await anthropic.messages.create(
          {
            model: MODEL,
            max_tokens: 1024,
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
        res.status(502).json({ error: "Extraction truncated" });
        return;
      }

      const textBlock = response.content.find(
        (block): block is Anthropic.ContentBlock & { type: "text" } =>
          block.type === "text",
      );

      if (textBlock) {
        try {
          extraction = coerceExtraction(parseLooseJson(textBlock.text));
        } catch {
          extraction = null;
        }
      }

      if (extraction) break;
    }

    if (!extraction) {
      // Malformed after the retry → UNCHARGED 502.
      res.status(502).json({ error: "Extraction failed" });
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

    // Non-event verdict: return early with all event fields null. Still CHARGED.
    if (!extraction.is_event) {
      res.json({
        data: {
          is_event: false,
          confidence: extraction.confidence,
          reason: extraction.reason ?? "not an event",
          title: null,
          starts_at: null,
          ends_at: null,
          all_day: null,
          timezone: null,
          venue: null,
          address: null,
          city: null,
          price: null,
          url: null,
          organizer: null,
        },
        meta: {
          model: MODEL_LABEL,
          date_resolved_from: "none",
          date_before_posted: false,
        },
        score: 100,
        grade: "A",
        findings: [],
      });
      return;
    }

    // --- Post-process an event verdict --------------------------------------
    const findings: Finding[] = [];
    let score = 100;
    let confidence = extraction.confidence;
    let dateBeforePosted = false;

    // §6 Date sanity: if the resolved start is BEFORE posted_at and the year was
    // not explicit in the text, the model likely mis-resolved a past recap as
    // upcoming. Flag it + lower confidence rather than silently emitting a past
    // event as upcoming.
    if (
      postedAt &&
      extraction.starts_at &&
      extraction.date_resolved_from !== "explicit"
    ) {
      const startMs = Date.parse(extraction.starts_at);
      const postedMs = Date.parse(postedAt);
      if (
        Number.isFinite(startMs) &&
        Number.isFinite(postedMs) &&
        startMs < postedMs
      ) {
        dateBeforePosted = true;
        confidence = Math.round(confidence * 0.5 * 100) / 100;
        score -= DEDUCT_DATE_BEFORE_POSTED;
        findings.push({
          rule: "date_before_posted",
          detail:
            "Resolved start is before posted_at with no explicit year — possible past-event recap mis-resolved as upcoming.",
        });
      }
    }

    // naive_timezone: a timed event with no resolvable timezone leaves the start
    // floating (no offset). Deduct a little so callers know the instant is naive.
    if (
      !extraction.all_day &&
      extraction.starts_at &&
      !hasOffset(extraction.starts_at) &&
      !extraction.timezone
    ) {
      score -= DEDUCT_NAIVE_TIMEZONE;
      findings.push({
        rule: "naive_timezone",
        detail:
          "No timezone supplied or inferable; the resolved time is naive (no UTC offset).",
      });
    }

    res.json({
      data: {
        is_event: true,
        confidence,
        title: extraction.title,
        starts_at: extraction.starts_at,
        ends_at: extraction.ends_at,
        all_day: extraction.all_day,
        timezone: extraction.timezone,
        venue: extraction.venue,
        address: extraction.address,
        city: extraction.city,
        price: extraction.price,
        url: extraction.url,
        organizer: extraction.organizer,
      },
      meta: {
        model: MODEL_LABEL,
        date_resolved_from: extraction.date_resolved_from,
        date_before_posted: dateBeforePosted,
      },
      score,
      grade: gradeFor(score),
      findings,
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
      console.error("Event extract LLM error:", err);
      res.status(502).json({ error: "Extraction failed" });
      return;
    }
    console.error("Event extract error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
