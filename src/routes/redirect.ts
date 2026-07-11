import { Router, type Request, type Response } from "express";
import { timeouts, limits } from "../config.js";
import { checkSsrf, validateUrl, ValidationError } from "../utils/validators.js";

export const redirectRouter = Router();

interface HopResult {
  hop: number;
  url: string;
  status_code: number;
  location: string | null;
  headers: Record<string, string>;
  tls: boolean;
  timing_ms: number;
}

interface Deduction {
  reason: string;
  points: number;
}

interface TraceResult {
  chain: HopResult[];
  final_url: string;
  final_status_code: number;
  total_hops: number;
  total_timing_ms: number;
  protocol_downgrade: boolean;
  loop_detected: boolean;
  flags: string[];
  grade: string;
  score: number;
  deductions: Deduction[];
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function computeGrade(result: Omit<TraceResult, "grade" | "score" | "deductions">): {
  grade: string;
  score: number;
  deductions: Deduction[];
} {
  const deductions: Deduction[] = [];
  let score = 100;

  // Auto-F conditions
  if (
    result.loop_detected ||
    result.flags.includes("max_hops_exceeded") ||
    result.flags.includes("connection_error") ||
    result.flags.includes("connection_timeout") ||
    result.flags.includes("missing_location_header")
  ) {
    const autoFReason = result.loop_detected
      ? "redirect_loop"
      : result.flags.find((f) =>
          ["max_hops_exceeded", "connection_error", "connection_timeout", "missing_location_header"].includes(f)
        )!;
    deductions.push({ reason: autoFReason, points: -100 });
    return { grade: "F", score: 0, deductions };
  }

  // Excess hops beyond 2
  if (result.total_hops > 2) {
    const extra = result.total_hops - 2;
    const points = extra * -5;
    deductions.push({ reason: `${extra} extra redirect hop(s) beyond 2`, points });
    score += points;
  }

  // http entry point
  if (result.flags.includes("http_entry_point")) {
    deductions.push({ reason: "http_entry_point", points: -5 });
    score -= 5;
  }

  // protocol downgrade
  if (result.protocol_downgrade) {
    deductions.push({ reason: "protocol_downgrade", points: -25 });
    score -= 25;
  }

  // Slow hops
  for (const hop of result.chain) {
    if (hop.timing_ms > 2000) {
      deductions.push({ reason: `hop ${hop.hop} timing_ms > 2000 (${hop.timing_ms}ms)`, points: -20 });
      score -= 20;
    } else if (hop.timing_ms > 1000) {
      deductions.push({ reason: `hop ${hop.hop} timing_ms > 1000 (${hop.timing_ms}ms)`, points: -10 });
      score -= 10;
    }
  }

  // Total timing
  if (result.total_timing_ms > 3000) {
    deductions.push({ reason: "total_timing_ms > 3000", points: -10 });
    score -= 10;
  }

  // Final status code
  const finalStatus = result.final_status_code;
  if (finalStatus >= 500) {
    deductions.push({ reason: `final status ${finalStatus} (5xx)`, points: -25 });
    score -= 25;
  } else if (finalStatus >= 400) {
    deductions.push({ reason: `final status ${finalStatus} (4xx)`, points: -15 });
    score -= 15;
  }

  score = Math.max(0, score);

  let grade: string;
  if (score >= 90) grade = "A";
  else if (score >= 75) grade = "B";
  else if (score >= 55) grade = "C";
  else if (score >= 30) grade = "D";
  else grade = "F";

  return { grade, score, deductions };
}

async function traceRedirects(startUrl: URL, maxHops: number): Promise<TraceResult> {
  const chain: HopResult[] = [];
  const flags: string[] = [];
  const seenUrls = new Set<string>();
  let currentUrl = startUrl.href;
  let protocolDowngrade = false;
  let loopDetected = false;
  let totalTimingMs = 0;

  if (startUrl.protocol === "http:") {
    flags.push("http_entry_point");
  }

  for (let hop = 0; hop <= maxHops; hop++) {
    // Loop detection
    if (seenUrls.has(currentUrl)) {
      loopDetected = true;
      flags.push("redirect_loop");
      break;
    }
    seenUrls.add(currentUrl);

    // SSRF check on each hop
    const parsed = new URL(currentUrl);
    await checkSsrf(parsed.hostname);

    let hopResult: HopResult;
    const start = performance.now();

    try {
      const response = await fetch(currentUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeouts.redirect),
      });
      const elapsed = Math.round(performance.now() - start);
      totalTimingMs += elapsed;

      const location = response.headers.get("location");

      hopResult = {
        hop,
        url: currentUrl,
        status_code: response.status,
        location,
        headers: responseHeadersToRecord(response.headers),
        tls: parsed.protocol === "https:",
        timing_ms: elapsed,
      };
      chain.push(hopResult);

      // Slow hop flag
      if (elapsed > 1000) {
        flags.push("slow_hop");
      }

      // Terminal response (not a redirect)
      if (!isRedirectStatus(response.status)) {
        break;
      }

      // Missing Location header on redirect
      if (!location) {
        flags.push("missing_location_header");
        break;
      }

      // Resolve relative Location
      let resolved: URL;
      try {
        resolved = new URL(location, currentUrl);
      } catch {
        flags.push("invalid_location_header");
        break;
      }

      // Non-HTTP redirect target
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
        flags.push("non_http_redirect");
        break;
      }

      // Protocol downgrade detection
      if (parsed.protocol === "https:" && resolved.protocol === "http:") {
        protocolDowngrade = true;
        flags.push("protocol_downgrade");
      }

      // Max hops check
      if (hop === maxHops) {
        flags.push("max_hops_exceeded");
        break;
      }

      currentUrl = resolved.href;
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      totalTimingMs += elapsed;

      const isTimeout =
        err instanceof DOMException && err.name === "TimeoutError";

      hopResult = {
        hop,
        url: currentUrl,
        status_code: 0,
        location: null,
        headers: {},
        tls: parsed.protocol === "https:",
        timing_ms: elapsed,
      };
      chain.push(hopResult);

      flags.push(isTimeout ? "connection_timeout" : "connection_error");
      break;
    }
  }

  const lastHop = chain[chain.length - 1];
  const partial: Omit<TraceResult, "grade" | "score" | "deductions"> = {
    chain,
    final_url: lastHop?.url ?? startUrl.href,
    final_status_code: lastHop?.status_code ?? 0,
    total_hops: chain.length - 1,
    total_timing_ms: totalTimingMs,
    protocol_downgrade: protocolDowngrade,
    loop_detected: loopDetected,
    flags: [...new Set(flags)],
  };

  const { grade, score, deductions } = computeGrade(partial);
  return { ...partial, grade, score, deductions };
}

/**
 * Core redirect-trace logic, extracted so aggregators (e.g. url-safety-full)
 * can reuse it directly. Validates the URL, clamps max_hops to the configured
 * ceiling, and runs the trace. The route handler below calls this unchanged.
 */
export async function runRedirectTrace(url: string, maxHops = 10): Promise<TraceResult> {
  const parsedUrl = validateUrl(url);
  const hops = Math.min(Math.max(1, Math.floor(maxHops)), limits.maxRedirectHops);
  return traceRedirects(parsedUrl, hops);
}

redirectRouter.get("/redirect/trace", async (req: Request, res: Response) => {
  try {
    const rawUrl = req.query.url as string;
    if (!rawUrl) {
      res.status(400).json({ error: "Missing required parameter: url" });
      return;
    }

    const maxHops = parseInt((req.query.max_hops as string) || "10", 10);
    if (isNaN(maxHops) || maxHops < 1) {
      res.status(400).json({ error: "max_hops must be a positive integer" });
      return;
    }

    const result = await runRedirectTrace(rawUrl, maxHops);
    res.json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Redirect trace error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
