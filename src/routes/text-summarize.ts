import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { validateUrl, checkSsrf, ValidationError } from "../utils/validators.js";
import { parseLooseJson } from "../utils/parse-loose-json.js";

export const textSummarizeRouter = Router();

// Input cap shared across Batch-2 LLM endpoints: reject text over 10k words OR 50KB.
const MAX_WORDS = 10000;
const MAX_BYTES = 50 * 1024;

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge instead of 404
const textSummarizePaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      price: pricing.textSummarize,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  error: "Payment required",
};

textSummarizeRouter.get("/text-summarize", (_req: Request, res: Response) => {
  res.status(402).json(textSummarizePaymentRequired);
});

textSummarizeRouter.head("/text-summarize", (_req: Request, res: Response) => {
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

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

// Enforce the input cap before spending an LLM call.
function exceedsCap(text: string): boolean {
  return countWords(text) > MAX_WORDS || Buffer.byteLength(text, "utf8") > MAX_BYTES;
}

// --- HTML → readable text (mirrors the page-extract approach) ---

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#x27;": "'",
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };
  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.split(entity).join(char);
  }
  result = result.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return result;
}

function stripTagContents(html: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  return html.replace(re, "");
}

function extractContent(html: string): string {
  let cleaned = html;

  // Strip noise elements (tag + contents)
  const noiseTags = ["script", "style", "nav", "header", "footer", "aside", "form", "iframe", "noscript"];
  for (const tag of noiseTags) {
    cleaned = stripTagContents(cleaned, tag);
  }

  // Extract paragraph text
  const paragraphs: string[] = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pRegex.exec(cleaned)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, "").trim();
    if (text.length >= 30) {
      paragraphs.push(text);
    }
  }

  let content = paragraphs.join("\n\n");
  content = decodeHtmlEntities(content);
  content = content.replace(/[ \t]+/g, " ");
  content = content.replace(/\n{3,}/g, "\n\n");
  return content.trim();
}

async function fetchAndExtract(rawUrl: string): Promise<string> {
  const parsed = validateUrl(rawUrl);
  await checkSsrf(parsed.hostname);

  const controller = new AbortController();
  // URL fetch uses a fixed 10s timeout (distinct from the LLM timeout).
  const timeout = setTimeout(() => controller.abort(), 10000);

  let html = "";
  try {
    const response = await fetch(parsed.href, {
      method: "GET",
      headers: {
        "User-Agent": "NetIntel/1.0",
        "Accept": "text/html",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    // Read max 500KB
    const reader = response.body?.getReader();
    if (reader) {
      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      const maxSize = 500 * 1024;
      while (totalSize < maxSize) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalSize += value.length;
      }
      reader.cancel().catch(() => {});
      const decoder = new TextDecoder();
      html = chunks.map((c) => decoder.decode(c, { stream: true })).join("");
    }
  } finally {
    clearTimeout(timeout);
  }

  return extractContent(html);
}

textSummarizeRouter.post("/text-summarize", async (req: Request, res: Response) => {
  try {
    const { text, url, max_points } = req.body ?? {};

    const hasText = typeof text === "string" && text.trim() !== "";
    const hasUrl = typeof url === "string" && url.trim() !== "";

    // Exactly one of text or url is required.
    if (hasText === hasUrl) {
      throw new ValidationError('text or url is required (exactly one) — e.g. {"text":"…the article to summarize…"}');
    }

    // Number of key bullet points: default 5, clamped to [1, 10].
    let maxPoints = 5;
    if (max_points !== undefined && max_points !== null) {
      const n = Number(max_points);
      if (Number.isFinite(n)) {
        maxPoints = Math.max(1, Math.min(10, Math.floor(n)));
      }
    }

    const source = hasUrl ? "url" : "text";
    let content: string;

    if (hasUrl) {
      content = await fetchAndExtract(url);
      // Cap the EXTRACTED text before any LLM call.
      if (exceedsCap(content)) {
        throw new ValidationError("Input exceeds maximum size (10000 words or 50KB)");
      }
      if (countWords(content) < 50) {
        throw new ValidationError("Could not extract enough text from URL");
      }
    } else {
      content = text;
      // Cap the input text before any LLM call.
      if (exceedsCap(content)) {
        throw new ValidationError("Input exceeds maximum size (10000 words or 50KB)");
      }
    }

    const originalWordCount = countWords(content);

    let parsed: any;
    try {
      const response = await Promise.race([
        anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: `You are a precise text summarizer. Summarize the user's content into a concise 2-4 sentence summary plus exactly ${maxPoints} key bullet points. Respond with ONLY a JSON object (no markdown, no code fences) of the form {"summary": "2-4 sentence summary", "key_points": ["point 1", ...], "word_count_original": N}. "key_points" must contain at most ${maxPoints} short strings. Do not include any text outside the JSON object. If the input contains no actual content to summarize — e.g. it is only an instruction, question, or topic request (like "summarize X for me") without the underlying text — respond with ONLY {"error": "no summarizable content"}. Never reply in prose or ask for more information.`,
          messages: [{ role: "user", content }],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeouts.textSummarize),
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
        console.error("Text summarize LLM error:", err);
      } else {
        console.error("Text summarize parse error:", err);
      }
      res.status(502).json({ error: "Summarization failed" });
      return;
    }

    // Escape hatch: the model flags instruction-only input ("summarize X for me"
    // with no underlying text) as {"error": ...} — a client-input problem, so
    // answer 400 (unbilled) instead of a paid 200 refusal or a 502.
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.error === "string" &&
      typeof parsed.summary !== "string"
    ) {
      throw new ValidationError(
        'No summarizable content found — "text" must contain the actual content to summarize, not an instruction or topic. e.g. {"text":"…the full article text…"}; to summarize a web page, send {"url":"https://…"} instead.',
      );
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.summary !== "string" ||
      !Array.isArray(parsed.key_points)
    ) {
      res.status(502).json({ error: "Summarization failed" });
      return;
    }

    const summary = parsed.summary;
    const keyPoints = parsed.key_points
      .filter((p: unknown) => typeof p === "string" && p.trim() !== "")
      .slice(0, maxPoints);

    const summaryWordCount = countWords(summary);
    const compressionRatio =
      originalWordCount > 0
        ? Math.round((summaryWordCount / originalWordCount) * 100) / 100
        : 0;

    res.json({
      source,
      summary,
      key_points: keyPoints,
      original_word_count: originalWordCount,
      summary_word_count: summaryWordCount,
      compression_ratio: compressionRatio,
      score: 100,
      grade: gradeFromScore(100),
      findings: [],
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Text summarize error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
