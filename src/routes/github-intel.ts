import { Router, type Request, type Response } from "express";
import { checkSsrf, ValidationError } from "../utils/validators.js";
import { pickField } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const githubIntelRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

// --- Helpers ---

// Synonyms agents send for the repository. Canonical `repo` is first so it always
// wins. `url`/`name` are tolerated because parseRepo strips a GitHub URL prefix and
// isValidRepo rejects anything that isn't owner/repo, so a stray value still 400s.
const REPO_ALIASES = ["repo", "repository", "repo_url", "repoUrl", "github_url", "githubUrl", "url", "name"];

// Built per-request so an optional GITHUB_TOKEN (set later without a code change)
// is always honored. Unauthenticated GitHub is 60 req/hr per IP — shared across
// ALL callers via our single egress IP — which intermittently 403s under load; a
// token raises the ceiling to 5,000/hr. Best-effort: absent token → unauthenticated.
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "NetIntel/1.0",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token && token.trim() !== "") headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function parseRepo(raw: string): string {
  let repo = raw.trim();
  // Strip GitHub URL prefix
  repo = repo.replace(/^https?:\/\/github\.com\//, "");
  // Remove trailing slash
  repo = repo.replace(/\/$/, "");
  return repo;
}

function isValidRepo(repo: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo);
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

async function safeFetch(url: string): Promise<globalThis.Response | null> {
  try {
    await checkSsrf(new URL(url).hostname);
    return await fetch(url, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(timeouts.githubIntel),
    });
  } catch {
    return null;
  }
}

// --- Route handler (shared by GET and POST) ---

async function handleGithubIntel(req: Request, res: Response): Promise<void> {
  try {
    // Accept the repo from a JSON body OR the query string, under common aliases.
    // Agents frequently POST {"repo":"owner/repo"}; previously that hit a 405 (GET
    // only) and the body was ignored. Body is checked first, then query.
    const rawRepoValue = pickField(req.body, REPO_ALIASES) ?? pickField(req.query, REPO_ALIASES);

    if (typeof rawRepoValue !== "string" || rawRepoValue.trim() === "") {
      res.status(400).json({
        error:
          'repo is required — pass the repository as "repo" in owner/repo format or a GitHub URL, via ?repo=expressjs/express or a JSON body {"repo":"expressjs/express"}. Also accepted: repository, url, name.',
      });
      return;
    }
    const rawRepo = rawRepoValue;

    const repo = parseRepo(rawRepo);

    if (!isValidRepo(repo)) {
      res.status(400).json({ error: "repo must be in owner/repo format" });
      return;
    }

    const baseUrl = `https://api.github.com/repos/${repo}`;

    // Fetch all endpoints concurrently
    const [repoResult, languagesResult, releaseResult, contributorsResult] =
      await Promise.allSettled([
        safeFetch(baseUrl),
        safeFetch(`${baseUrl}/languages`),
        safeFetch(`${baseUrl}/releases/latest`),
        // per_page=1: the Link header's rel="last" page number IS the exact
        // contributor count, in one request. The old per_page=100 array-length
        // read silently capped the count at 100 (expressjs/express reported
        // exactly "100"; 2026-07-30 sweep audit). GitHub truncates this
        // endpoint at 500 contributors, so huge repos report 500 — a floor,
        // but a far better one.
        safeFetch(`${baseUrl}/contributors?per_page=1&anon=false`),
      ]);

    // Process main repo response
    const repoRes = repoResult.status === "fulfilled" ? repoResult.value : null;

    if (!repoRes || repoRes.status === 404) {
      res.status(404).json({ error: `Repository not found: ${repo}` });
      return;
    }

    if (!repoRes.ok) {
      // 403/429 here is almost always the GitHub rate limit (unauthenticated:
      // 60 req/hr shared across every caller on our one egress IP). Production
      // data: 4 paid calls 502'd with the bare "GitHub API error: 403". Name
      // the cause, mark it transient/uncharged, and surface the reset time.
      if (repoRes.status === 403 || repoRes.status === 429) {
        const reset = repoRes.headers?.get?.("x-ratelimit-reset");
        const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : null;
        res.status(503).json({
          code: "UPSTREAM_UNAVAILABLE",
          error:
            `GitHub API rate limit exceeded — this is a transient upstream limit, not a problem ` +
            `with your request; retry ${resetAt ? `after ${resetAt}` : "in a few minutes"}. ` +
            `You were not charged.`,
        });
        return;
      }
      res.status(502).json({ error: `GitHub API error: ${repoRes.status}` });
      return;
    }

    const repoData = await repoRes.json();

    // Process languages
    const langRes = languagesResult.status === "fulfilled" ? languagesResult.value : null;
    const languages: Record<string, number> =
      langRes && langRes.ok ? await langRes.json() : {};

    // Process latest release
    const releaseRes = releaseResult.status === "fulfilled" ? releaseResult.value : null;
    let latestRelease: string | null = null;
    let latestReleaseDate: string | null = null;
    if (releaseRes && releaseRes.ok) {
      const releaseData = await releaseRes.json();
      latestRelease = releaseData.tag_name ?? null;
      latestReleaseDate = releaseData.published_at ?? null;
    }

    // Process contributors: exact count from the Link rel="last" page number;
    // no Link header means the whole result fit on one page, so the array
    // length is already exact.
    const contribRes = contributorsResult.status === "fulfilled" ? contributorsResult.value : null;
    let contributorCount = 0;
    if (contribRes && contribRes.ok) {
      const link = contribRes.headers?.get?.("link");
      const last = typeof link === "string" ? link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/) : null;
      if (last) {
        contributorCount = parseInt(last[1], 10);
      } else {
        const contribData = await contribRes.json();
        contributorCount = Array.isArray(contribData) ? contribData.length : 0;
      }
    }

    // Calculate days since last push
    const lastPushedAt = repoData.pushed_at ?? null;
    let daysSinceLastPush = 0;
    if (lastPushedAt) {
      const pushDate = new Date(lastPushedAt);
      const now = new Date();
      daysSinceLastPush = Math.floor(
        (now.getTime() - pushDate.getTime()) / (1000 * 60 * 60 * 24),
      );
    }

    // Grading
    let score = 100;
    const findings: Finding[] = [];

    const isArchived = repoData.archived ?? false;
    const isFork = repoData.fork ?? false;
    const description = repoData.description ?? null;
    const license = repoData.license?.spdx_id ?? repoData.license?.name ?? null;
    const licenseName = repoData.license?.name ?? null;
    const openIssues = repoData.open_issues_count ?? 0;

    if (isArchived) {
      findings.push({ rule: "archived", deduction: -60, detail: "Repository is archived" });
      score -= 60;
    }

    if (daysSinceLastPush > 730) {
      findings.push({
        rule: "stale_over_2_years",
        deduction: -40,
        detail: `Last push was ${daysSinceLastPush} days ago (over 2 years)`,
      });
      score -= 40;
    } else if (daysSinceLastPush > 365) {
      findings.push({
        rule: "stale_over_1_year",
        deduction: -20,
        detail: `Last push was ${daysSinceLastPush} days ago (over 1 year)`,
      });
      score -= 20;
    } else if (daysSinceLastPush > 180) {
      findings.push({
        rule: "stale_over_6_months",
        deduction: -10,
        detail: `Last push was ${daysSinceLastPush} days ago (over 6 months)`,
      });
      score -= 10;
    } else {
      findings.push({
        rule: "active_development",
        deduction: 0,
        detail: "Pushed within last 180 days",
      });
    }

    if (!license || license === "NOASSERTION") {
      findings.push({ rule: "no_license", deduction: -15, detail: "No license detected" });
      score -= 15;
    }

    if (openIssues > 500) {
      findings.push({
        rule: "high_open_issues",
        deduction: -10,
        detail: `${openIssues} open issues`,
      });
      score -= 10;
    }

    if (isFork) {
      findings.push({
        rule: "is_fork",
        deduction: -5,
        detail: "Repository is a fork (derivative work)",
      });
      score -= 5;
    }

    if (!description || description.trim() === "") {
      findings.push({ rule: "no_description", deduction: -5, detail: "No description provided" });
      score -= 5;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    res.json({
      repo: repoData.full_name,
      url: repoData.html_url,
      description: description,
      homepage: repoData.homepage || null,
      stars: repoData.stargazers_count ?? 0,
      forks: repoData.forks_count ?? 0,
      open_issues: openIssues,
      watchers: repoData.watchers_count ?? 0,
      primary_language: repoData.language ?? null,
      languages,
      license: licenseName,
      license_spdx: license === "NOASSERTION" ? null : license,
      topics: repoData.topics ?? [],
      created_at: repoData.created_at ?? null,
      last_pushed_at: lastPushedAt,
      days_since_last_push: daysSinceLastPush,
      is_archived: isArchived,
      is_fork: isFork,
      parent_repo: repoData.parent?.full_name ?? null,
      contributor_count: contributorCount,
      latest_release: latestRelease,
      latest_release_date: latestReleaseDate,
      default_branch: repoData.default_branch ?? null,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("GitHub intel error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET (?repo=) is canonical; POST (JSON body) is accepted for agents that send a
// body. Both share one handler and one paid route entry (see index.ts routes).
githubIntelRouter.get("/github-intel/analyze", handleGithubIntel);
githubIntelRouter.post("/github-intel/analyze", handleGithubIntel);
