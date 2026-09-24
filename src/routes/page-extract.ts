import { Router, type Request, type Response } from "express";
import { validateUrl, checkSsrf, ValidationError } from "../utils/validators.js";
import { safeFetch, FetchProblem } from "../utils/safe-fetch.js";
import { assessSource } from "../utils/source-usability.js";
import { timeouts } from "../config.js";

export const pageExtractRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

// --- HTML parsing helpers ---

function getMetaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match && match[1]) return match[1];
  }
  return null;
}

function getTitleTag(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match?.[1]?.trim() || null;
}

function parseTitle(html: string): string | null {
  return getMetaContent(html, "og:title")
    ?? getMetaContent(html, "twitter:title")
    ?? getTitleTag(html);
}

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
  // Handle numeric entities like &#123; and &#x1A;
  result = result.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return result;
}

function stripTagContents(html: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  return html.replace(re, "");
}

function stripBySelector(html: string, className: string): string {
  // Remove elements with class containing the given name
  const re = new RegExp(`<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/[^>]+>`, "gi");
  return html.replace(re, "");
}

function extractContent(html: string): string {
  // Normalize CRLF/CR to LF first — the collapses below match \n only, so
  // stray \r from CRLF-served pages leaked "\r\n\r\n" runs into content
  // (2026-07-30 sweep audit).
  let cleaned = html.replace(/\r\n?/g, "\n");

  // Step 1 — Strip noise elements (tag + contents)
  const noiseTags = ["script", "style", "nav", "header", "footer", "aside", "form", "iframe", "noscript"];
  for (const tag of noiseTags) {
    cleaned = stripTagContents(cleaned, tag);
  }

  // Strip figure but keep figcaption: replace <figure> with its figcaption content
  cleaned = cleaned.replace(/<figure[^>]*>([\s\S]*?)<\/figure>/gi, (_match, inner: string) => {
    const figcaptionMatch = inner.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
    return figcaptionMatch ? figcaptionMatch[1] : "";
  });

  // Strip elements with noise class names
  const noiseClasses = ["nav", "menu", "sidebar", "ad", "advertisement", "cookie", "popup", "modal", "related", "comments"];
  for (const cls of noiseClasses) {
    cleaned = stripBySelector(cleaned, cls);
  }

  // Step 2 — Extract paragraph text
  const paragraphs: string[] = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = pRegex.exec(cleaned)) !== null) {
    // Strip any remaining inline tags from paragraph content
    const text = match[1].replace(/<[^>]+>/g, "").trim();
    if (text.length >= 30) {
      paragraphs.push(text);
    }
  }

  // Step 3 — Clean the text
  let content = paragraphs.join("\n\n");
  content = decodeHtmlEntities(content);
  // Collapse multiple whitespace (but preserve paragraph breaks)
  content = content.replace(/[ \t]+/g, " ");
  content = content.replace(/\n{3,}/g, "\n\n");
  content = content.trim();

  return content;
}

function detectLanguage(content: string): string {
  const frChars = (content.match(/[éàâêîôûç]/gi) || []).length;
  const esChars = (content.match(/[ñ¿¡]/gi) || []).length;
  const deChars = (content.match(/[äöüß]/gi) || []).length;

  const max = Math.max(frChars, esChars, deChars);
  if (max === 0) return "en";
  if (frChars === max) return "fr";
  if (esChars === max) return "es";
  return "de";
}

function extractPreview(content: string): string[] {
  if (!content) return [];
  // Split on sentence-ending punctuation followed by space or end
  const sentences = content.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const meaningful = sentences
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return meaningful.slice(0, 3);
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

pageExtractRouter.get("/page-extract/read", async (req: Request, res: Response) => {
  try {
    const rawUrl = req.query.url as string | undefined;

    if (!rawUrl) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    const parsed = validateUrl(rawUrl);
    await checkSsrf(parsed.hostname);

    let finalUrl = parsed.href;
    let statusCode = 0;
    let html = "";

    // Retry once on transient fetch failures
    const maxAttempts = 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // safeFetch SSRF-checks every redirect hop before requesting it and
        // keeps one deadline over all hops + the 500 KB body read.
        const r = await safeFetch(parsed, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; NetIntel/1.0)",
            "Accept": "text/html",
          },
          timeoutMs: timeouts.pageExtract,
          maxBytes: 500 * 1024,
        });
        statusCode = r.status;
        finalUrl = r.finalUrl;
        html = r.text;
        break;
      } catch (err) {
        // A refused hop (private host, non-http scheme, too many redirects) is
        // a verdict, not a transient failure: never retried, never the generic
        // 500 — the outer catch maps it to its uncharged status.
        if (err instanceof ValidationError || err instanceof FetchProblem) throw err;
        if (attempt === maxAttempts - 1) {
          const cause = err instanceof Error && "cause" in err ? (err as any).cause : undefined;
          const message = cause?.message || (err instanceof Error ? err.message : String(err));
          console.error("Page extract fetch failed:", message, cause || err);
          res.status(500).json({ error: `Content extraction failed: ${message}` });
          return;
        }
        // Wait briefly before retry
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // Extract content
    const title = parseTitle(html);
    const content = extractContent(html);
    const preview = extractPreview(content);
    const words = content ? content.split(/\s+/).filter((w) => w.length > 0) : [];
    const wordCount = words.length;
    const readingTimeMinutes = wordCount > 0 ? Math.ceil(wordCount / 238) : 0;
    const language = detectLanguage(content);

    // Never bill for a miss: a bot challenge, a 404, or an empty extraction has
    // nothing to sell, and a graded-down 200 would still settle the payment
    // (x402 settles on <400). Answer 4xx instead — uncharged.
    const unusable = assessSource({
      status: statusCode,
      title,
      body: html,
      contentUnits: wordCount,
      noun: "content",
      // Same rule as web-extract: challenge status + <40 extracted words is a
      // refusal remnant, not the page — uncharged.
      thinFloor: 40,
      // JS-rendered / bot-walled pages are /exa/contents' job — point there.
      suggestRenderer: true,
    });
    if (unusable) {
      res.status(unusable.status).json({
        error: unusable.error,
        code: unusable.code,
        ...(unusable.hint ? { hint: unusable.hint } : {}),
        url: parsed.href,
        final_url: finalUrl,
        status_code: statusCode,
      });
      return;
    }

    // Grading
    let score = 100;
    const findings: Finding[] = [];

    if (statusCode !== 200) {
      findings.push({ rule: "fetch_failed", deduction: -40, detail: `HTTP status ${statusCode}` });
      score -= 40;
    }

    if (!title) {
      findings.push({ rule: "no_title", deduction: -15, detail: "No title found in page" });
      score -= 15;
    }

    if (wordCount < 50) {
      findings.push({ rule: "no_content_extracted", deduction: -60, detail: "Extracted content is empty or under 50 words — page may be JS-rendered or empty" });
      score -= 60;
    } else if (wordCount < 300) {
      findings.push({ rule: "short_content", deduction: -12, detail: "Extracted content is under 300 words — may be paywalled or JS-rendered" });
      score -= 12;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    res.json({
      url: parsed.href,
      final_url: finalUrl,
      title,
      content,
      preview,
      word_count: wordCount,
      reading_time_minutes: readingTimeMinutes,
      language,
      content_length_chars: content.length,
      status_code: statusCode,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof FetchProblem) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    console.error("Page extract error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
