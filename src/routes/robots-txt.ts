import { Router, type Request, type Response } from "express";
import { validateDomain, checkSsrf, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";
import { safeFetch } from "../utils/safe-fetch.js";

export const robotsTxtRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  label: string;
  impact: number;
  detail: string;
}

interface AgentRule {
  user_agent: string;
  allow: string[];
  disallow: string[];
  crawl_delay: number | null;
}

interface PathCheck {
  path: string;
  user_agent: string;
  allowed: boolean;
  matched_rule: string | null;
  rule_type: string | null;
}

// --- Parsing helpers ---

function parseRobotsTxt(content: string): {
  rules: AgentRule[];
  sitemaps: string[];
  host: string | null;
} {
  const lines = content.split(/\r?\n/);
  const sitemaps: string[] = [];
  let host: string | null = null;

  const agentMap = new Map<string, { allow: string[]; disallow: string[]; crawl_delay: number | null }>();
  let currentAgents: string[] = [];
  let inAgentBlock = false; // true while reading consecutive User-agent lines

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Remove inline comments
    const commentIdx = line.indexOf("#");
    const clean = commentIdx >= 0 ? line.slice(0, commentIdx).trim() : line;
    if (!clean) continue;

    const colonIdx = clean.indexOf(":");
    if (colonIdx < 0) continue;

    const directive = clean.slice(0, colonIdx).trim().toLowerCase();
    const value = clean.slice(colonIdx + 1).trim();

    if (directive === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }

    if (directive === "host") {
      host = value || null;
      continue;
    }

    if (directive === "user-agent") {
      if (inAgentBlock) {
        // Consecutive user-agent line — accumulate
        currentAgents.push(value);
      } else {
        // Start a fresh group
        currentAgents = [value];
        inAgentBlock = true;
      }
      if (!agentMap.has(value)) {
        agentMap.set(value, { allow: [], disallow: [], crawl_delay: null });
      }
      continue;
    }

    // Non-user-agent directive — apply to current agents
    inAgentBlock = false;
    if (currentAgents.length === 0) continue;

    if (directive === "allow") {
      for (const agent of currentAgents) {
        const entry = agentMap.get(agent)!;
        if (value) entry.allow.push(value);
      }
    } else if (directive === "disallow") {
      for (const agent of currentAgents) {
        const entry = agentMap.get(agent)!;
        if (value) entry.disallow.push(value);
      }
    } else if (directive === "crawl-delay") {
      const delay = parseFloat(value);
      if (!isNaN(delay)) {
        for (const agent of currentAgents) {
          const entry = agentMap.get(agent)!;
          entry.crawl_delay = delay;
        }
      }
    }
  }

  const rules: AgentRule[] = [];
  for (const [agent, data] of agentMap) {
    rules.push({
      user_agent: agent,
      allow: data.allow,
      disallow: data.disallow,
      crawl_delay: data.crawl_delay,
    });
  }

  return { rules, sitemaps, host };
}

/**
 * Robots Exclusion Protocol pattern match (RFC 9309 / Google spec): the
 * pattern is a path prefix where `*` matches any character sequence and a
 * trailing `$` anchors the end. Everything else is literal.
 */
function repPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regexSource =
    "^" +
    body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
    (anchored ? "$" : "");
  try {
    return new RegExp(regexSource).test(path);
  } catch {
    // A pathological pattern must never break the check — fall back to the
    // literal prefix behavior.
    return path.startsWith(pattern);
  }
}

function checkPathPermission(
  rules: AgentRule[],
  path: string,
  userAgent: string,
): PathCheck {
  // Find rules for specific user-agent, fallback to "*"
  let agentRules = rules.find((r) => r.user_agent.toLowerCase() === userAgent.toLowerCase());
  if (!agentRules) {
    agentRules = rules.find((r) => r.user_agent === "*");
  }

  if (!agentRules) {
    return { path, user_agent: userAgent, allowed: true, matched_rule: null, rule_type: null };
  }

  // Collect all matching rules. REP patterns support `*` (any sequence) and a
  // trailing `$` (end anchor) — plain startsWith silently mis-judged paths
  // against wildcard-heavy files like Google's (/books?*zoom=1 etc.).
  const matches: Array<{ type: "allow" | "disallow"; pattern: string }> = [];

  for (const pattern of agentRules.allow) {
    if (repPatternMatches(pattern, path)) {
      matches.push({ type: "allow", pattern });
    }
  }

  for (const pattern of agentRules.disallow) {
    if (repPatternMatches(pattern, path)) {
      matches.push({ type: "disallow", pattern });
    }
  }

  if (matches.length === 0) {
    return { path, user_agent: userAgent, allowed: true, matched_rule: null, rule_type: null };
  }

  // Most specific (longest pattern) wins; if tied, Allow beats Disallow
  matches.sort((a, b) => {
    if (b.pattern.length !== a.pattern.length) return b.pattern.length - a.pattern.length;
    // Allow wins over Disallow at same length
    if (a.type === "allow" && b.type === "disallow") return -1;
    if (a.type === "disallow" && b.type === "allow") return 1;
    return 0;
  });

  const winner = matches[0];
  const ruleLabel = winner.type === "allow" ? "Allow" : "Disallow";

  return {
    path,
    user_agent: userAgent,
    allowed: winner.type === "allow",
    matched_rule: `${ruleLabel}: ${winner.pattern}`,
    rule_type: winner.type,
  };
}

// --- Route handler ---

robotsTxtRouter.get("/robots-txt/analyze", async (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string | undefined;
    const pathParam = req.query.path as string | undefined;
    const userAgentParam = (req.query.user_agent as string | undefined) || "*";

    if (!rawDomain) {
      res.status(400).json({ error: "domain is required" });
      return;
    }

    const domain = validateDomain(rawDomain);
    const robotsUrl = `https://${domain}/robots.txt`;

    await checkSsrf(domain);

    let statusCode: number;
    let rawContent: string | null = null;
    let found = false;
    let fetchError = false;

    try {
      // Every redirect hop is SSRF-checked before it is requested (safeFetch).
      const response = await safeFetch(robotsUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; NetIntel/1.0)" },
        timeoutMs: timeouts.robotsTxt,
        maxBytes: 512 * 1024,
      });

      statusCode = response.status;

      if (response.ok) {
        rawContent = response.text;
        found = true;
      }
    } catch (err) {
      // A private/reserved redirect target is the route's ValidationError →
      // uncharged 400, never a charged "fetch error" verdict.
      if (err instanceof ValidationError) throw err;
      statusCode = 0;
      fetchError = true;
    }

    // Parse content
    let rules: AgentRule[] = [];
    let sitemaps: string[] = [];
    if (rawContent) {
      const parsed = parseRobotsTxt(rawContent);
      rules = parsed.rules;
      sitemaps = parsed.sitemaps;
    }

    // Path check
    let pathCheck: PathCheck | null = null;
    if (pathParam) {
      pathCheck = checkPathPermission(rules, pathParam, userAgentParam);
    }

    // Raw content preview (first 500 chars)
    const rawContentPreview = rawContent ? rawContent.slice(0, 500) : null;

    // Grading
    let score = 100;
    const findings: Finding[] = [];

    if (fetchError) {
      findings.push({ rule: "fetch_error", label: "Fetch error", impact: -40, detail: "Connection error or timeout fetching robots.txt" });
      score -= 40;
    }

    if (!found && !fetchError && statusCode === 404) {
      findings.push({ rule: "not_found", label: "robots.txt not found", impact: -30, detail: "robots.txt returned 404" });
      score -= 30;
    }

    if (found && rawContent !== null && rules.length === 0 && sitemaps.length === 0) {
      findings.push({ rule: "empty_file", label: "Empty robots.txt", impact: -20, detail: "File found but contains no directives" });
      score -= 20;
    }

    // Check blocks_all_bots: "*" rules contain Disallow: /
    const wildcardRule = rules.find((r) => r.user_agent === "*");
    if (wildcardRule && wildcardRule.disallow.includes("/")) {
      findings.push({ rule: "blocks_all_bots", label: "Blocks all bots", impact: -20, detail: "Wildcard (*) rules contain Disallow: / which blocks all crawling" });
      score -= 20;
    }

    if (found && sitemaps.length === 0) {
      findings.push({ rule: "no_sitemap", label: "No sitemap declared", impact: -15, detail: "No Sitemap: directives found in robots.txt" });
      score -= 15;
    }

    score = Math.max(0, score);

    let grade: string;
    if (score >= 90) grade = "A";
    else if (score >= 75) grade = "B";
    else if (score >= 55) grade = "C";
    else if (score >= 30) grade = "D";
    else grade = "F";

    res.json({
      domain,
      robots_url: robotsUrl,
      found,
      status_code: statusCode,
      raw_content_preview: rawContentPreview,
      sitemaps,
      rules,
      path_check: pathCheck,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Robots.txt analyze error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
