import { Router, type Request, type Response } from "express";
import { validateUrl, validateDomain, checkSsrf, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";

export const sitemapParserRouter = Router();

// --- Interfaces ---

interface SitemapUrl {
  url: string;
  last_modified: string | null;
  change_frequency: string | null;
  priority: number | null;
}

interface Finding {
  rule: string;
  label: string;
  impact: number;
  detail: string;
}

// --- Helpers ---

const USER_AGENT = "Mozilla/5.0 (compatible; NetIntel/1.0)";

async function safeFetch(url: string): Promise<{ status: number; text: string }> {
  const parsed = new URL(url);
  await checkSsrf(parsed.hostname);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/xml, text/xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeouts.sitemapParser),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

function parseUrlset(xml: string): SitemapUrl[] {
  const urls: SitemapUrl[] = [];
  const urlBlockRe = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  let match: RegExpExecArray | null;
  while ((match = urlBlockRe.exec(xml)) !== null) {
    const block = match[1];
    const loc = extractTag(block, "loc");
    if (!loc) continue;
    const lastmod = extractTag(block, "lastmod");
    const changefreq = extractTag(block, "changefreq");
    const priorityStr = extractTag(block, "priority");
    urls.push({
      url: loc,
      last_modified: lastmod,
      change_frequency: changefreq,
      priority: priorityStr !== null ? parseFloat(priorityStr) : null,
    });
  }
  return urls;
}

function parseSitemapIndex(xml: string): string[] {
  const locs: string[] = [];
  const sitemapBlockRe = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
  let match: RegExpExecArray | null;
  while ((match = sitemapBlockRe.exec(xml)) !== null) {
    const loc = extractTag(match[1], "loc");
    if (loc) locs.push(loc);
  }
  return locs;
}

function parseSitemapDirectivesFromRobots(robotsTxt: string): string[] {
  const sitemaps: string[] = [];
  for (const line of robotsTxt.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(/^Sitemap:\s*(.+)/i);
    if (match) sitemaps.push(match[1].trim());
  }
  return sitemaps;
}

function computeStats(urls: SitemapUrl[]) {
  const dates = urls.map((u) => u.last_modified).filter(Boolean) as string[];
  const priorities = urls.map((u) => u.priority).filter((p) => p !== null) as number[];
  const changefreqs = urls.filter((u) => u.change_frequency !== null);

  let newest: string | null = null;
  let oldest: string | null = null;
  if (dates.length > 0) {
    const sorted = [...dates].sort();
    oldest = sorted[0];
    newest = sorted[sorted.length - 1];
  }

  const avgPriority = priorities.length > 0
    ? Math.round((priorities.reduce((a, b) => a + b, 0) / priorities.length) * 100) / 100
    : null;

  return {
    newest_url_date: newest,
    oldest_url_date: oldest,
    avg_priority: avgPriority,
    has_lastmod: dates.length > 0,
    has_priority: priorities.length > 0,
    has_changefreq: changefreqs.length > 0,
  };
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

sitemapParserRouter.get("/sitemap-parser/fetch", async (req: Request, res: Response) => {
  try {
    const rawUrl = req.query.url as string | undefined;
    if (!rawUrl) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 100, 1), 1000);

    // Determine if it's a URL or domain
    let sitemapUrl: string | null = null;
    let isDomainInput = false;
    let domain: string | null = null;
    let cachedSitemapText: string | null = null;

    try {
      const parsed = validateUrl(rawUrl);
      sitemapUrl = parsed.href;
    } catch {
      // Not a valid URL — try as domain
      try {
        domain = validateDomain(rawUrl);
        isDomainInput = true;
      } catch {
        res.status(400).json({ error: "Invalid URL or domain" });
        return;
      }
    }

    // Auto-discover sitemap from domain
    if (isDomainInput && domain) {
      // Try robots.txt first
      try {
        const robotsResult = await safeFetch(`https://${domain}/robots.txt`);
        if (robotsResult.status === 200) {
          const sitemaps = parseSitemapDirectivesFromRobots(robotsResult.text);
          if (sitemaps.length > 0) {
            sitemapUrl = sitemaps[0];
          }
        }
      } catch {
        // robots.txt fetch failed, continue to fallbacks
      }

      // Fallback: try common sitemap paths
      if (!sitemapUrl) {
        for (const path of ["/sitemap.xml", "/sitemap_index.xml"]) {
          try {
            const result = await safeFetch(`https://${domain}${path}`);
            if (result.status === 200 && (result.text.includes("<urlset") || result.text.includes("<sitemapindex"))) {
              sitemapUrl = `https://${domain}${path}`;
              cachedSitemapText = result.text;
              break;
            }
          } catch {
            // continue to next fallback
          }
        }
      }

      if (!sitemapUrl) {
        const findings: Finding[] = [
          { rule: "sitemap_not_found", label: "Sitemap not found", impact: -40, detail: "Could not discover sitemap from robots.txt or common paths" },
        ];
        res.json({
          source_url: null,
          sitemap_type: null,
          total_urls: 0,
          urls_returned: 0,
          child_sitemaps_fetched: 0,
          urls: [],
          stats: {
            newest_url_date: null,
            oldest_url_date: null,
            avg_priority: null,
            has_lastmod: false,
            has_priority: false,
            has_changefreq: false,
          },
          score: 0,
          grade: "F",
          findings,
        });
        return;
      }
    }

    // Fetch the sitemap (skip if already cached from fallback discovery)
    let sitemapText: string;
    if (cachedSitemapText) {
      sitemapText = cachedSitemapText;
    } else {
      try {
        const result = await safeFetch(sitemapUrl!);
        if (result.status === 404) {
          res.status(404).json({ error: "Sitemap not found at URL" });
          return;
        }
        if (result.status < 200 || result.status >= 300) {
          res.status(502).json({ error: `Upstream returned HTTP ${result.status}` });
          return;
        }
        sitemapText = result.text;
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        res.status(502).json({ error: "Failed to fetch sitemap" });
        return;
      }
    }

    // Detect type and parse
    const isIndex = /<sitemapindex/i.test(sitemapText);
    const isUrlset = /<urlset/i.test(sitemapText);

    if (!isIndex && !isUrlset) {
      // Not a valid sitemap format
      const findings: Finding[] = [
        { rule: "parse_failed", label: "Invalid sitemap format", impact: -80, detail: "Response is not a valid XML sitemap or sitemap index" },
      ];
      res.json({
        source_url: sitemapUrl,
        sitemap_type: null,
        total_urls: 0,
        urls_returned: 0,
        child_sitemaps_fetched: 0,
        urls: [],
        stats: {
          newest_url_date: null,
          oldest_url_date: null,
          avg_priority: null,
          has_lastmod: false,
          has_priority: false,
          has_changefreq: false,
        },
        score: 20,
        grade: "F",
        findings,
      });
      return;
    }

    let allUrls: SitemapUrl[] = [];
    let childSitemapsFetched = 0;
    let sitemapType: string;

    if (isIndex) {
      sitemapType = "sitemapindex";
      const childLocs = parseSitemapIndex(sitemapText);
      // Fetch up to 3 child sitemaps concurrently, 1 level only
      const toFetch = childLocs.slice(0, 3);
      const results = await Promise.allSettled(
        toFetch.map((loc) => safeFetch(loc)),
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value.status === 200) {
          childSitemapsFetched++;
          const childUrls = parseUrlset(r.value.text);
          allUrls.push(...childUrls);
        }
      }
    } else {
      sitemapType = "urlset";
      allUrls = parseUrlset(sitemapText);
    }

    const totalUrls = allUrls.length;
    const returnedUrls = allUrls.slice(0, limit);

    // Stats
    const stats = computeStats(allUrls);

    // Grading
    let score = 100;
    const findings: Finding[] = [];

    if (totalUrls === 0) {
      findings.push({ rule: "no_urls_found", label: "No URLs found", impact: -60, detail: "Sitemap contains no URL entries" });
      score -= 60;
    }
    if (!stats.has_lastmod) {
      findings.push({ rule: "no_lastmod", label: "No lastmod dates", impact: -10, detail: "No URLs have lastmod dates — harder for agents to find new content" });
      score -= 10;
    }
    if (!stats.has_priority) {
      findings.push({ rule: "no_priority", label: "No priority values", impact: -5, detail: "No URLs have priority values" });
      score -= 5;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    res.json({
      source_url: sitemapUrl,
      sitemap_type: sitemapType,
      total_urls: totalUrls,
      urls_returned: returnedUrls.length,
      child_sitemaps_fetched: childSitemapsFetched,
      urls: returnedUrls,
      stats,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Sitemap parser error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
