import { Router, type Request, type Response } from "express";
import { checkSsrf, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";

export const npmIntelRouter = Router();

// --- Constants ---

const NPM_PACKAGE_RE = /^(@[a-z0-9\-~][a-z0-9\-._~]*\/)?[a-z0-9\-~][a-z0-9\-._~]*$/;

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

// --- Helpers ---

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

function cleanRepoUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let url = raw;
  // Strip git+ prefix and .git suffix
  url = url.replace(/^git\+/, "").replace(/\.git$/, "");
  // Convert ssh:// to https://
  url = url.replace(/^ssh:\/\/git@/, "https://");
  // Convert git:// to https://
  url = url.replace(/^git:\/\//, "https://");
  return url || null;
}

// --- Route ---

npmIntelRouter.get("/npm-intel/analyze", async (req: Request, res: Response) => {
  try {
    const pkg = req.query.package as string | undefined;

    if (!pkg) {
      res.status(400).json({ error: "package is required" });
      return;
    }

    if (!NPM_PACKAGE_RE.test(pkg)) {
      throw new ValidationError("Invalid npm package name");
    }

    // URL-encode scoped packages: @scope/name → @scope%2Fname
    const encodedPkg = pkg.includes("/")
      ? pkg.replace("/", "%2F")
      : pkg;

    const registryUrl = `https://registry.npmjs.org/${encodedPkg}`;
    const downloadsUrl = `https://api.npmjs.org/downloads/point/last-week/${encodedPkg}`;

    // SSRF check both URLs
    await Promise.all([
      checkSsrf("registry.npmjs.org"),
      checkSsrf("api.npmjs.org"),
    ]);

    // Fetch both in parallel
    const [registryResult, downloadsResult] = await Promise.allSettled([
      fetch(registryUrl, {
        signal: AbortSignal.timeout(timeouts.npmIntel),
        headers: { Accept: "application/json" },
      }),
      fetch(downloadsUrl, {
        signal: AbortSignal.timeout(timeouts.npmIntel),
        headers: { Accept: "application/json" },
      }),
    ]);

    // Handle registry response
    if (registryResult.status === "rejected") {
      res.status(502).json({ error: `Registry request failed: ${registryResult.reason?.message || "unknown error"}` });
      return;
    }

    const registryRes = registryResult.value;
    if (registryRes.status === 404) {
      res.status(404).json({ error: `Package not found: ${pkg}` });
      return;
    }
    if (!registryRes.ok) {
      res.status(502).json({ error: `Registry returned ${registryRes.status}` });
      return;
    }

    const data = await registryRes.json() as any;

    // Extract latest version info
    const latestVersion = data["dist-tags"]?.latest || null;
    const versions = data.versions || {};
    const totalVersions = Object.keys(versions).length;
    const latestMeta = latestVersion ? versions[latestVersion] : null;

    // Dependencies
    const deps = latestMeta?.dependencies || {};
    const devDeps = latestMeta?.devDependencies || {};
    const dependencyCount = Object.keys(deps).length;
    const devDependencyCount = Object.keys(devDeps).length;

    // Deprecation
    const deprecationMessage = latestMeta?.deprecated || null;
    const isDeprecated = deprecationMessage !== null;

    // Maintainers
    const maintainers = (data.maintainers || []).map((m: any) => m.name || m.email);
    const maintainerCount = maintainers.length;

    // Repository
    const repoRaw = data.repository?.url || data.repository || null;
    const repository = typeof repoRaw === "string" ? cleanRepoUrl(repoRaw) : null;

    // Dates
    const timeData = data.time || {};
    const createdAt = timeData.created || null;
    const latestPublishedAt = latestVersion ? (timeData[latestVersion] || null) : null;

    let daysSinceLastPublish: number | null = null;
    if (latestPublishedAt) {
      const publishDate = new Date(latestPublishedAt);
      const now = new Date();
      daysSinceLastPublish = Math.floor((now.getTime() - publishDate.getTime()) / (1000 * 60 * 60 * 24));
    }

    // Downloads
    let weeklyDownloads = 0;
    if (downloadsResult.status === "fulfilled" && downloadsResult.value.ok) {
      const dlData = await downloadsResult.value.json() as any;
      weeklyDownloads = dlData.downloads || 0;
    }

    // Other fields
    const license = data.license || null;
    const homepage = data.homepage || null;
    const keywords = data.keywords || [];
    const description = data.description || null;

    // --- Grading ---
    let score = 100;
    const findings: Finding[] = [];

    if (isDeprecated) {
      score -= 60;
      findings.push({ rule: "deprecated", deduction: -60, detail: `Package is deprecated: ${deprecationMessage}` });
    }

    if (daysSinceLastPublish !== null) {
      if (daysSinceLastPublish > 730) {
        score -= 30;
        findings.push({ rule: "stale_over_2_years", deduction: -30, detail: `Last published ${daysSinceLastPublish} days ago` });
      } else if (daysSinceLastPublish > 365) {
        score -= 15;
        findings.push({ rule: "stale_package", deduction: -15, detail: `Last published ${daysSinceLastPublish} days ago` });
      }
    }

    if (maintainerCount === 1) {
      score -= 10;
      findings.push({ rule: "single_maintainer", deduction: -10, detail: "Only one maintainer (bus factor risk)" });
    }

    if (repository === null) {
      score -= 10;
      findings.push({ rule: "no_repository", deduction: -10, detail: "No repository URL specified" });
    }

    if (license === null) {
      score -= 15;
      findings.push({ rule: "no_license", deduction: -15, detail: "No license specified" });
    }

    if (dependencyCount > 50) {
      score -= 10;
      findings.push({ rule: "high_dependencies", deduction: -10, detail: `${dependencyCount} dependencies exceed threshold of 50` });
    }

    if (weeklyDownloads < 100) {
      score -= 10;
      findings.push({ rule: "low_downloads", deduction: -10, detail: `Only ${weeklyDownloads} weekly downloads` });
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    res.json({
      package: data.name || pkg,
      description,
      latest_version: latestVersion,
      total_versions: totalVersions,
      weekly_downloads: weeklyDownloads,
      license,
      repository,
      homepage,
      keywords,
      maintainers,
      maintainer_count: maintainerCount,
      dependency_count: dependencyCount,
      dev_dependency_count: devDependencyCount,
      created_at: createdAt,
      latest_published_at: latestPublishedAt,
      days_since_last_publish: daysSinceLastPublish,
      is_deprecated: isDeprecated,
      deprecation_message: deprecationMessage,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("npm-intel error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
