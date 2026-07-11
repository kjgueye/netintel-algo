import { Router, type Request, type Response } from "express";
import { ValidationError } from "../utils/validators.js";

export const usernameCheckRouter = Router();

// --- Constants ---

const USERNAME_RE = /^[a-zA-Z0-9._-]{1,50}$/;

const USER_AGENT = "Mozilla/5.0 (compatible; NetIntel/1.0)";

const LOGIN_REDIRECT_PATTERNS = ["/login", "/signin", "/signup", "/register", "/accounts/login"];

interface PlatformDef {
  name: string;
  urlTemplate: string;
}

const PLATFORMS: PlatformDef[] = [
  { name: "GitHub", urlTemplate: "https://github.com/{username}" },
  { name: "GitLab", urlTemplate: "https://gitlab.com/{username}" },
  { name: "Bitbucket", urlTemplate: "https://bitbucket.org/{username}" },
  { name: "npm", urlTemplate: "https://www.npmjs.com/~{username}" },
  { name: "PyPI", urlTemplate: "https://pypi.org/user/{username}" },
  { name: "Reddit", urlTemplate: "https://www.reddit.com/user/{username}" },
  { name: "HackerNews", urlTemplate: "https://news.ycombinator.com/user?id={username}" },
  { name: "dev.to", urlTemplate: "https://dev.to/{username}" },
  { name: "Medium", urlTemplate: "https://medium.com/@{username}" },
  { name: "Keybase", urlTemplate: "https://keybase.io/{username}" },
  { name: "Twitter/X", urlTemplate: "https://twitter.com/{username}" },
  { name: "Instagram", urlTemplate: "https://www.instagram.com/{username}" },
  { name: "TikTok", urlTemplate: "https://www.tiktok.com/@{username}" },
  { name: "YouTube", urlTemplate: "https://www.youtube.com/@{username}" },
  { name: "Twitch", urlTemplate: "https://www.twitch.tv/{username}" },
  { name: "Pinterest", urlTemplate: "https://www.pinterest.com/{username}" },
  { name: "Snapchat", urlTemplate: "https://www.snapchat.com/add/{username}" },
  { name: "LinkedIn", urlTemplate: "https://www.linkedin.com/in/{username}" },
  { name: "Steam", urlTemplate: "https://steamcommunity.com/id/{username}" },
  { name: "Mastodon", urlTemplate: "https://mastodon.social/@{username}" },
  { name: "Spotify", urlTemplate: "https://open.spotify.com/user/{username}" },
  { name: "SoundCloud", urlTemplate: "https://soundcloud.com/{username}" },
];

// --- Helpers ---

function isLoginRedirect(location: string): boolean {
  const lower = location.toLowerCase();
  return LOGIN_REDIRECT_PATTERNS.some((p) => lower.includes(p));
}

type PlatformStatus = "taken" | "available" | "unknown";

async function checkPlatform(url: string): Promise<PlatformStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    let res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });

    // Fall back to GET if HEAD returns 405
    if (res.status === 405) {
      res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
      });
    }

    if (res.status === 200) {
      return "taken";
    }

    if (res.status === 301 || res.status === 302) {
      const location = res.headers.get("location") ?? "";
      if (isLoginRedirect(location)) {
        return "available";
      }
      return "taken";
    }

    if (res.status === 404) {
      return "available";
    }

    if (res.status === 403) {
      return "unknown";
    }

    // Any other status — treat as unknown
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timeout);
  }
}

// --- Route handler ---

usernameCheckRouter.get("/username-check/lookup", async (req: Request, res: Response) => {
  try {
    const username = req.query.username as string | undefined;

    if (!username) {
      res.status(400).json({ error: "username is required" });
      return;
    }

    if (!USERNAME_RE.test(username)) {
      res.status(400).json({ error: "Invalid username format" });
      return;
    }

    const platformResults = await Promise.allSettled(
      PLATFORMS.map(async (platform) => {
        const url = platform.urlTemplate.replace("{username}", username);
        const status = await checkPlatform(url);
        return { platform: platform.name, url, status };
      }),
    );

    const results: Array<{ platform: string; url: string; status: PlatformStatus }> = [];
    let takenCount = 0;
    let availableCount = 0;
    let unknownCount = 0;

    for (const result of platformResults) {
      if (result.status === "fulfilled") {
        const r = result.value;
        results.push(r);
        if (r.status === "taken") takenCount++;
        else if (r.status === "available") availableCount++;
        else unknownCount++;
      } else {
        // Should not happen since checkPlatform catches all errors, but handle gracefully
        unknownCount++;
      }
    }

    res.json({
      username,
      taken_count: takenCount,
      available_count: availableCount,
      unknown_count: unknownCount,
      results,
      score: 100,
      grade: "A",
      findings: [],
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Username check error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
