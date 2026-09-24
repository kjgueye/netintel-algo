import { Router, type Request, type Response } from "express";
import { validateUrl, checkSsrf, ValidationError } from "../utils/validators.js";
import { safeFetch, FetchProblem } from "../utils/safe-fetch.js";
import { timeouts } from "../config.js";

export const rssParserRouter = Router();

// --- Helpers ---

function stripCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractTag(xml: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  return decodeEntities(stripCdata(m[1].trim()));
}

function extractAllTags(xml: string, tagName: string): string[] {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  const results: string[] = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(decodeEntities(stripCdata(m[1].trim())));
  }
  return results;
}

function extractBlocks(xml: string, tagName: string): string[] {
  const re = new RegExp(`<${tagName}[\\s>][\\s\\S]*?<\\/${tagName}>`, "gi");
  return xml.match(re) || [];
}

function extractAttr(tag: string, attrName: string): string | null {
  const re = new RegExp(`${attrName}\\s*=\\s*["']([^"']*)["']`, "i");
  const m = tag.match(re);
  return m ? decodeEntities(m[1]) : null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

interface Finding {
  rule: string;
  label: string;
  impact: number;
  detail: string;
}

interface FeedItem {
  title: string | null;
  url: string | null;
  description: string | null;
  author: string | null;
  published_at: string | null;
  categories: string[];
  has_full_content: boolean;
}

// --- RSS 2.0 parsing ---

function parseRss2(xml: string): {
  feed: { title: string | null; description: string | null; site_url: string | null; last_updated: string | null };
  items: FeedItem[];
  totalItems: number;
} {
  const channelMatch = xml.match(/<channel[\s>][\s\S]*<\/channel>/i);
  const channel = channelMatch ? channelMatch[0] : xml;

  const title = extractTag(channel, "title");
  const description = extractTag(channel, "description");
  const link = extractTag(channel, "link");
  const lastUpdated = extractTag(channel, "lastBuildDate") || extractTag(channel, "pubDate");

  const itemBlocks = extractBlocks(channel, "item");
  const items: FeedItem[] = itemBlocks.map((block) => {
    const itemTitle = extractTag(block, "title");
    const itemLink = extractTag(block, "link");
    const rawDesc = extractTag(block, "description");
    const author = extractTag(block, "author") || extractTag(block, "dc:creator");
    const pubDate = extractTag(block, "pubDate");
    const categories = extractAllTags(block, "category");
    const contentEncoded = extractTag(block, "content:encoded");

    return {
      title: itemTitle,
      url: itemLink,
      description: rawDesc ? truncate(rawDesc, 500) : null,
      author,
      published_at: pubDate,
      categories,
      has_full_content: contentEncoded !== null,
    };
  });

  return {
    feed: { title, description, site_url: link, last_updated: lastUpdated },
    items,
    totalItems: items.length,
  };
}

// --- Atom 1.0 parsing ---

function parseAtom(xml: string): {
  feed: { title: string | null; description: string | null; site_url: string | null; last_updated: string | null };
  items: FeedItem[];
  totalItems: number;
} {
  const title = extractTag(xml, "title");
  const subtitle = extractTag(xml, "subtitle");

  // Extract feed-level link with rel="alternate" or first link
  const feedLinkMatch = xml.match(/<link[^>]*rel\s*=\s*["']alternate["'][^>]*\/?>/i)
    || xml.match(/<link[^>]*href\s*=\s*["'][^"']*["'][^>]*\/?>/i);
  const siteUrl = feedLinkMatch ? extractAttr(feedLinkMatch[0], "href") : null;

  // Get feed-level <updated> but not entry-level ones
  // Remove all entry blocks first to get feed-level updated
  const feedWithoutEntries = xml.replace(/<entry[\s>][\s\S]*?<\/entry>/gi, "");
  const lastUpdated = extractTag(feedWithoutEntries, "updated");

  const entryBlocks = extractBlocks(xml, "entry");
  const items: FeedItem[] = entryBlocks.map((block) => {
    const entryTitle = extractTag(block, "title");

    // entry link
    const entryLinkMatch = block.match(/<link[^>]*href\s*=\s*["']([^"']*)["'][^>]*\/?>/i);
    const entryUrl = entryLinkMatch ? decodeEntities(entryLinkMatch[1]) : null;

    const summary = extractTag(block, "summary");
    const authorName = extractTag(block, "name"); // inside <author><name>
    const published = extractTag(block, "published") || extractTag(block, "updated");

    // categories: <category term="..."/>
    const catMatches = block.match(/<category[^>]*term\s*=\s*["']([^"']*)["'][^>]*\/?>/gi) || [];
    const categories = catMatches.map((c) => extractAttr(c, "term")).filter((c): c is string => c !== null);

    const content = extractTag(block, "content");

    return {
      title: entryTitle,
      url: entryUrl,
      description: summary ? truncate(summary, 500) : null,
      author: authorName,
      published_at: published,
      categories,
      has_full_content: content !== null,
    };
  });

  return {
    feed: { title, description: subtitle, site_url: siteUrl, last_updated: lastUpdated },
    items,
    totalItems: items.length,
  };
}

// --- Grading ---

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

rssParserRouter.get("/rss-parser/fetch", async (req: Request, res: Response) => {
  try {
    const rawUrl = req.query.url as string | undefined;
    if (!rawUrl) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    const parsed = validateUrl(rawUrl);
    await checkSsrf(parsed.hostname);

    // Validate limit
    let limit = 10;
    if (req.query.limit !== undefined) {
      const parsedLimit = parseInt(req.query.limit as string, 10);
      if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
        res.status(400).json({ error: "limit must be between 1 and 50" });
        return;
      }
      limit = parsedLimit;
    }

    // Fetch the feed — safeFetch SSRF-checks every redirect hop before
    // requesting it (the explicit check above covers hop 0 only).
    const r = await safeFetch(parsed, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; NetIntel/1.0)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml",
      },
      timeoutMs: timeouts.rssParser,
    });

    const xml = r.text;

    // Detect format
    let score = 100;
    const findings: Finding[] = [];
    let feedType: string;
    let feedMeta: { title: string | null; description: string | null; site_url: string | null; last_updated: string | null };
    let allItems: FeedItem[];
    let totalItems: number;

    const isRss = /<rss[\s>]/i.test(xml) || /<channel[\s>]/i.test(xml);
    const isAtom = /<feed[\s>]/i.test(xml);

    if (isRss) {
      feedType = "rss2";
      const result = parseRss2(xml);
      feedMeta = result.feed;
      allItems = result.items;
      totalItems = result.totalItems;
    } else if (isAtom) {
      feedType = "atom";
      const result = parseAtom(xml);
      feedMeta = result.feed;
      allItems = result.items;
      totalItems = result.totalItems;
    } else {
      // parse_failed
      score -= 80;
      findings.push({ rule: "parse_failed", label: "Not a valid RSS or Atom feed", impact: -80, detail: "Could not detect RSS or Atom format in the response" });
      feedType = "unknown";
      feedMeta = { title: null, description: null, site_url: null, last_updated: null };
      allItems = [];
      totalItems = 0;
    }

    // Apply grading rules (only if we parsed something)
    if (feedType !== "unknown") {
      if (totalItems === 0) {
        score -= 40;
        findings.push({ rule: "no_items", label: "Feed contains zero items", impact: -40, detail: "Feed parsed but contains zero items" });
      }
      if (!feedMeta.title) {
        score -= 10;
        findings.push({ rule: "no_feed_title", label: "Feed title missing", impact: -10, detail: "Feed-level title is missing" });
      }
      if (allItems.length > 0 && allItems.every((i) => !i.published_at)) {
        score -= 15;
        findings.push({ rule: "no_item_dates", label: "No item dates", impact: -15, detail: "None of the items have published_at dates" });
      }
      if (allItems.length > 0 && allItems.every((i) => !i.description)) {
        score -= 15;
        findings.push({ rule: "no_item_descriptions", label: "No item descriptions", impact: -15, detail: "None of the items have descriptions" });
      }
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    const itemsReturned = allItems.slice(0, limit);

    res.json({
      url: parsed.href,
      feed_type: feedType,
      feed: feedMeta,
      total_items_in_feed: totalItems,
      items_returned: itemsReturned.length,
      items: itemsReturned,
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
    console.error("RSS parser error:", err);
    res.status(500).json({ error: `Feed fetch failed: ${err instanceof Error ? err.message : String(err)}` });
  }
});
