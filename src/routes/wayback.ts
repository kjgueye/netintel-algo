import { Router, type Request, type Response } from "express";
import { validateUrl, checkSsrf, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";

export const waybackRouter = Router();

const TIMESTAMP_RE = /^\d{8}(\d{6})?$/;

// Internet Archive (archive.org / web.archive.org) blocks requests without a
// real User-Agent (it returns an HTML block page that fails JSON parsing → 502),
// and is also frequently flaky/slow. Send a proper UA + Accept, and retry once
// to clear transient failures. Treats a non-JSON (HTML) body as a failure so the
// retry/allSettled logic can fall back instead of throwing on the block page.
const WAYBACK_HEADERS = {
  "User-Agent": "NetIntel/1.0 (+https://netintel.dev; network intelligence API)",
  Accept: "application/json",
};
async function fetchJsonRetry(url: string, timeout: number): Promise<any> {
  // r.json() throws on a non-200 or on an HTML block page, which is exactly when
  // we want to retry / fall back rather than 502 on the first blip.
  const once = async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: WAYBACK_HEADERS });
    if (!r.ok) throw new Error(`archive.org returned ${r.status}`);
    return r.json();
  };
  try {
    return await once();
  } catch {
    return await once();
  }
}

function formatWaybackTimestamp(ts: string): string {
  const y = ts.slice(0, 4);
  const m = ts.slice(4, 6);
  const d = ts.slice(6, 8);
  const H = ts.slice(8, 10) || "00";
  const M = ts.slice(10, 12) || "00";
  const S = ts.slice(12, 14) || "00";
  return `${y}-${m}-${d}T${H}:${M}:${S}Z`;
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

waybackRouter.get("/wayback/lookup", async (req: Request, res: Response) => {
  try {
    const rawUrl = req.query.url as string | undefined;
    const timestamp = req.query.timestamp as string | undefined;

    if (!rawUrl) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    const parsedUrl = validateUrl(rawUrl);
    await checkSsrf(parsedUrl.hostname);

    if (timestamp && !TIMESTAMP_RE.test(timestamp)) {
      res.status(400).json({ error: "timestamp must be in format YYYYMMDD or YYYYMMDDHHmmss" });
      return;
    }

    const targetUrl = parsedUrl.toString();
    const timeout = timeouts.wayback;

    // --- Concurrent calls: availability API, first capture, last capture ---
    const availabilityUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}${timestamp ? `&timestamp=${timestamp}` : ""}`;
    // CDX has no `order` parameter (it silently ignores one): results are
    // always oldest-first, `limit=1` takes the first row and `limit=-1` the
    // last. The old `order=desc` query returned the FIRST capture, so
    // last_capture was either wrong or null (2026-07-30 sweep audit).
    const firstCaptureUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(targetUrl)}&output=json&limit=1&fl=timestamp`;
    const lastCaptureUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(targetUrl)}&output=json&limit=-1&fl=timestamp`;

    const [availResult, firstResult, lastResult] = await Promise.allSettled([
      fetchJsonRetry(availabilityUrl, timeout),
      fetchJsonRetry(firstCaptureUrl, timeout),
      fetchJsonRetry(lastCaptureUrl, timeout),
    ]);

    if (availResult.status === "rejected" && firstResult.status === "rejected" && lastResult.status === "rejected") {
      res.status(502).json({ error: `Wayback Machine lookup failed: ${availResult.reason?.message || "timeout"}` });
      return;
    }

    // Parse availability
    let snapshot: { url: string; timestamp: string; formatted_date: string; status_code: string } | null = null;
    let isArchived = false;

    if (availResult.status === "fulfilled") {
      const closest = availResult.value?.archived_snapshots?.closest;
      if (closest && closest.available) {
        isArchived = true;
        snapshot = {
          url: closest.url,
          timestamp: closest.timestamp,
          formatted_date: formatWaybackTimestamp(closest.timestamp),
          status_code: String(closest.status),
        };
      }
    }

    // Parse first capture (CDX returns [["timestamp"], ["20010101000000"]])
    let firstCapture: string | null = null;
    if (firstResult.status === "fulfilled") {
      const data = firstResult.value;
      if (Array.isArray(data) && data.length >= 2 && Array.isArray(data[1])) {
        firstCapture = formatWaybackTimestamp(data[1][0]);
        isArchived = true;
      }
    }

    // Parse last capture
    let lastCapture: string | null = null;
    if (lastResult.status === "fulfilled") {
      const data = lastResult.value;
      if (Array.isArray(data) && data.length >= 2 && Array.isArray(data[1])) {
        lastCapture = formatWaybackTimestamp(data[1][0]);
        isArchived = true;
      }
    }

    // "Never archived" needs POSITIVE evidence of absence: at least one CDX
    // query must have SUCCEEDED (a parsed JSON array — [] genuinely means no
    // captures). fetchJsonRetry rejects on non-200, HTML block pages and
    // empty bodies, so a fulfilled array is conclusive; a rejection is not.
    // Without this, an archive.org rate-limit burst (it throttles shared
    // datacenter egress hard) made the 2026-07-30 verify run answer "never
    // archived" for example.com — 6,400+ real captures — and bill for it.
    // Unknown must degrade to an uncharged 503, not a confident wrong answer.
    const cdxConclusive =
      (firstResult.status === "fulfilled" && Array.isArray(firstResult.value)) ||
      (lastResult.status === "fulfilled" && Array.isArray(lastResult.value));
    if (!isArchived && !cdxConclusive) {
      res.status(503).json({
        code: "UPSTREAM_UNAVAILABLE",
        error:
          "The Wayback Machine did not answer (rate limit or outage), so the archive status is unknown — this is NOT 'never archived'. Transient; retry in a minute. You were not charged.",
      });
      return;
    }

    // --- Capture count estimate (showNumPages) ---
    let captureCountEstimate = 0;
    if (isArchived) {
      try {
        const countUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(targetUrl)}&showNumPages=true`;
        const countRes = await fetch(countUrl, { signal: AbortSignal.timeout(timeout) });
        const countText = await countRes.text();
        const pages = parseInt(countText.trim(), 10);
        if (!isNaN(pages)) {
          captureCountEstimate = pages * 50;
        }
      } catch {
        // omit count on failure
      }
    }

    // --- Scoring ---
    let score = 100;
    const findings: Finding[] = [];

    if (!isArchived) {
      findings.push({ rule: "not_archived", deduction: -60, detail: "URL has never been archived by the Wayback Machine" });
      score -= 60;
    }

    if (isArchived && lastCapture) {
      const lastDate = new Date(lastCapture);
      const now = new Date();
      const diffMs = now.getTime() - lastDate.getTime();
      const diffMonths = diffMs / (1000 * 60 * 60 * 24 * 30.44);

      if (diffMonths > 12) {
        findings.push({ rule: "last_capture_over_1_year", deduction: -20, detail: "Last capture is more than 1 year ago" });
        score -= 20;
      } else if (diffMonths > 6) {
        findings.push({ rule: "last_capture_over_6_months", deduction: -10, detail: "Last capture is 6-12 months ago" });
        score -= 10;
      }
    }

    if (isArchived && captureCountEstimate < 10) {
      findings.push({ rule: "low_capture_count", deduction: -10, detail: "Capture count estimate is less than 10" });
      score -= 10;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    res.json({
      url: targetUrl,
      is_archived: isArchived,
      snapshot,
      first_capture: firstCapture,
      last_capture: lastCapture,
      capture_count_estimate: captureCountEstimate,
      timestamp_requested: timestamp || null,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Wayback lookup error:", err);
    res.status(500).json({ error: `Wayback Machine lookup failed: ${err instanceof Error ? err.message : "unknown error"}` });
  }
});
