import { Router, type Request, type Response } from "express";
import { validateUrl, checkSsrf, ValidationError } from "../utils/validators.js";
import { safeFetch, FetchProblem } from "../utils/safe-fetch.js";
import { assessSource } from "../utils/source-usability.js";
import { timeouts } from "../config.js";

export const ogScraperRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

interface OgResult {
  url: string;
  final_url: string;
  status_code: number;
  title: string | null;
  description: string | null;
  image: string | null;
  favicon: string | null;
  site_name: string | null;
  canonical_url: string | null;
  content_type: string;
  author: string | null;
  published_at: string | null;
  modified_at: string | null;
  twitter_card: string | null;
  json_ld: unknown | null;
  score: number;
  grade: string;
  findings: Finding[];
}

// --- Parsing helpers ---

function getMetaContent(html: string, property: string): string | null {
  // Match both property="..." and name="..." attributes
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRegex(property)}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escapeRegex(property)}["']`, "i"),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match && match[1]) return match[1];
  }
  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getTitleTag(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match?.[1]?.trim() || null;
}

function getCanonicalUrl(html: string): string | null {
  const match = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i)
    || html.match(/<link[^>]+href=["']([^"']*)["'][^>]+rel=["']canonical["']/i);
  return match?.[1] || null;
}

function getFaviconUrl(html: string, baseUrl: string): string | null {
  const patterns = [
    /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']*)["']/i,
    /<link[^>]+href=["']([^"']*)["'][^>]+rel=["'](?:shortcut )?icon["']/i,
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match?.[1]) {
      return resolveUrl(match[1], baseUrl);
    }
  }
  // Fallback: /favicon.ico
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}/favicon.ico`;
  } catch {
    return null;
  }
}

function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

function extractJsonLd(html: string): unknown | null {
  const match = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function parseTitle(html: string): string | null {
  return getMetaContent(html, "og:title")
    ?? getMetaContent(html, "twitter:title")
    ?? getTitleTag(html);
}

function parseDescription(html: string): string | null {
  return getMetaContent(html, "og:description")
    ?? getMetaContent(html, "twitter:description")
    ?? getMetaContent(html, "description");
}

function parseImage(html: string): string | null {
  return getMetaContent(html, "og:image")
    ?? getMetaContent(html, "twitter:image");
}

function parseSiteName(html: string, finalUrl: string): string | null {
  const ogSiteName = getMetaContent(html, "og:site_name");
  if (ogSiteName) return ogSiteName;
  try {
    return new URL(finalUrl).hostname;
  } catch {
    return null;
  }
}

function parseAuthor(html: string, jsonLd: unknown): string | null {
  const metaAuthor = getMetaContent(html, "author");
  if (metaAuthor) return metaAuthor;

  const ogAuthor = getMetaContent(html, "article:author");
  if (ogAuthor) return ogAuthor;

  if (jsonLd && typeof jsonLd === "object") {
    const ld = jsonLd as Record<string, unknown>;
    if (typeof ld.author === "string") return ld.author;
    if (ld.author && typeof ld.author === "object") {
      const author = ld.author as Record<string, unknown>;
      if (typeof author.name === "string") return author.name;
    }
  }
  return null;
}

function parsePublishedAt(html: string, jsonLd: unknown): string | null {
  const ogPublished = getMetaContent(html, "article:published_time");
  if (ogPublished) return ogPublished;

  const metaPubdate = getMetaContent(html, "pubdate");
  if (metaPubdate) return metaPubdate;

  if (jsonLd && typeof jsonLd === "object") {
    const ld = jsonLd as Record<string, unknown>;
    if (typeof ld.datePublished === "string") return ld.datePublished;
  }
  return null;
}

function parseModifiedAt(html: string, jsonLd: unknown): string | null {
  const ogModified = getMetaContent(html, "article:modified_time");
  if (ogModified) return ogModified;

  if (jsonLd && typeof jsonLd === "object") {
    const ld = jsonLd as Record<string, unknown>;
    if (typeof ld.dateModified === "string") return ld.dateModified;
  }
  return null;
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

ogScraperRouter.get("/og-scraper/extract", async (req: Request, res: Response) => {
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
        // keeps one deadline over all hops + the 200 KB body read.
        const r = await safeFetch(parsed, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; NetIntel/1.0)",
            "Accept": "text/html",
          },
          timeoutMs: timeouts.ogScraper,
          maxBytes: 200 * 1024,
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
          const message = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: `Metadata extraction failed: ${message}` });
          return;
        }
        // Wait briefly before retry
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // Parse all metadata
    const jsonLd = extractJsonLd(html);
    const title = parseTitle(html);
    const description = parseDescription(html);
    const image = parseImage(html);
    // <link rel=canonical> first; og:url is an equally deliberate authorial
    // canonical signal (e.g. GitHub declares og:url but no canonical link).
    // No fallback to the fetched URL: the old `canonical ?? finalUrl` fill
    // made responses claim a canonical URL while the no_canonical finding
    // said none was found (2026-07-30 sweep audit) — absent now means null.
    const canonical = getCanonicalUrl(html) ?? getMetaContent(html, "og:url");
    const favicon = getFaviconUrl(html, finalUrl);
    const siteName = parseSiteName(html, finalUrl);
    const contentType = getMetaContent(html, "og:type") ?? "website";
    const author = parseAuthor(html, jsonLd);
    const publishedAt = parsePublishedAt(html, jsonLd);
    const modifiedAt = parseModifiedAt(html, jsonLd);
    const twitterCard = getMetaContent(html, "twitter:card");

    // Never bill for a miss: a bot challenge, a 404, or a page with zero real
    // metadata has nothing to sell, and a graded-down 200 would still settle the
    // payment (x402 settles on <400). Answer 4xx instead — uncharged.
    // Only genuinely EXTRACTED fields count as evidence; site_name, favicon and
    // content_type all have derived/default fallbacks and would mask an empty page.
    const extractedFields = [
      title,
      description,
      image,
      canonical,
      author,
      publishedAt,
      modifiedAt,
      twitterCard,
      jsonLd,
    ].filter((v) => v !== null && v !== undefined).length;

    const unusable = assessSource({
      status: statusCode,
      title,
      body: html,
      contentUnits: extractedFields,
      noun: "metadata",
    });
    if (unusable) {
      res.status(unusable.status).json({
        error: unusable.error,
        code: unusable.code,
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
      findings.push({ rule: "fetch_error_non_200", deduction: -40, detail: `HTTP status ${statusCode}` });
      score -= 40;
    }

    if (!title) {
      findings.push({ rule: "no_title", deduction: -25, detail: "No title found in page metadata" });
      score -= 25;
    }

    if (!description) {
      findings.push({ rule: "no_description", deduction: -15, detail: "No description found in page metadata" });
      score -= 15;
    }

    if (!image) {
      findings.push({ rule: "no_og_image", deduction: -10, detail: "No og:image or twitter:image found" });
      score -= 10;
    }

    if (!canonical) {
      findings.push({ rule: "no_canonical", deduction: -10, detail: "No canonical URL found" });
      score -= 10;
    }

    if (!jsonLd && contentType === "website" && !getMetaContent(html, "og:type")) {
      findings.push({ rule: "no_structured_data", deduction: -10, detail: "No JSON-LD or og:type found" });
      score -= 10;
    }

    if (contentType === "article") {
      if (!author) {
        findings.push({ rule: "no_author", deduction: -5, detail: "No author found for article" });
        score -= 5;
      }
      if (!publishedAt) {
        findings.push({ rule: "no_publish_date", deduction: -5, detail: "No publish date found for article" });
        score -= 5;
      }
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    const result: OgResult = {
      url: parsed.href,
      final_url: finalUrl,
      status_code: statusCode,
      title,
      description,
      image,
      favicon,
      site_name: siteName,
      canonical_url: canonical,
      content_type: contentType,
      author,
      published_at: publishedAt,
      modified_at: modifiedAt,
      twitter_card: twitterCard,
      json_ld: jsonLd,
      score,
      grade,
      findings,
    };

    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof FetchProblem) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    console.error("OG scraper error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
