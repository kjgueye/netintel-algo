import { Router, type Request, type Response } from "express";
import net from "node:net";
import { validateDomain, checkSsrf, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";

export const domainAgeRouter = Router();

// --- Constants ---

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const DAYS_PER_YEAR = 365.25;
const SIX_MONTHS_DAYS = DAYS_PER_YEAR / 2; // 182.625
const TWO_YEARS_DAYS = DAYS_PER_YEAR * 2; // 730.5

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

function formatWaybackTimestamp(ts: string): string {
  const y = ts.slice(0, 4);
  const m = ts.slice(4, 6);
  const d = ts.slice(6, 8);
  const H = ts.slice(8, 10) || "00";
  const M = ts.slice(10, 12) || "00";
  const S = ts.slice(12, 14) || "00";
  return `${y}-${m}-${d}T${H}:${M}:${S}Z`;
}

/**
 * RDAP lookup outcome. `supported` distinguishes "this TLD has no RDAP server in
 * the IANA bootstrap at all" (e.g. .io) from "RDAP exists but returned no
 * registration date" — the former is a permanent blind spot worth explaining to
 * the caller, the latter a per-record gap. `date` is the ISO registration date or
 * null.
 */
interface RdapResult {
  supported: boolean;
  date: string | null;
}

/**
 * Resolve a domain's RDAP creation date via the IANA bootstrap registry.
 * Returns { supported:false } when the TLD has no RDAP server in the bootstrap,
 * { supported:true, date:null } when RDAP was reachable but carried no
 * registration event, or the ISO date when found. Throws on network/timeout
 * failures so the caller's Promise.allSettled can treat it as a failed source.
 */
async function fetchRdapCreation(domain: string, timeout: number): Promise<RdapResult> {
  const bootstrapRes = await fetch("https://data.iana.org/rdap/dns.json", {
    signal: AbortSignal.timeout(timeout),
  });
  const bootstrapData = (await bootstrapRes.json()) as { services?: string[][][] };

  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  let rdapBaseUrl: string | null = null;
  if (Array.isArray(bootstrapData.services)) {
    for (const service of bootstrapData.services) {
      const tlds = service[0];
      const urls = service[1];
      if (Array.isArray(tlds) && tlds.includes(tld) && Array.isArray(urls) && urls.length > 0) {
        rdapBaseUrl = urls[0].replace(/\/+$/, "");
        break;
      }
    }
  }
  if (!rdapBaseUrl) return { supported: false, date: null };

  const rdapHostname = new URL(rdapBaseUrl).hostname;
  await checkSsrf(rdapHostname);

  const rdapUrl = `${rdapBaseUrl}/domain/${domain}`;
  const rdapRes = await fetch(rdapUrl, { signal: AbortSignal.timeout(timeout) });
  if (!rdapRes.ok) return { supported: true, date: null };

  const rdapData = (await rdapRes.json()) as Record<string, unknown>;
  const events = rdapData.events;
  if (Array.isArray(events)) {
    for (const evt of events) {
      const e = evt as Record<string, unknown>;
      if (e.eventAction === "registration" && typeof e.eventDate === "string") {
        return { supported: true, date: e.eventDate };
      }
    }
  }
  return { supported: true, date: null };
}

// --- WHOIS fallback (port 43) -------------------------------------------------
// RDAP is the modern, structured source, but a number of TLDs (.io being the
// common one) publish no RDAP server in the IANA bootstrap. For those — and for
// RDAP records that omit the registration event — we fall back to classic WHOIS:
// ask whois.iana.org which server is authoritative for the TLD (`refer:`), then
// query that registry server and parse the creation date. This keeps the call a
// useful, chargeable answer instead of an all-null result.

const WHOIS_PORT = 43;
const WHOIS_MAX_BYTES = 100 * 1024; // cap the response; registry WHOIS is small

/** One raw WHOIS query over TCP/43. Resolves with the full text, rejects on timeout/error. */
function whoisQuery(host: string, query: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const socket = net.createConnection({ host, port: WHOIS_PORT });
    socket.setTimeout(timeout);
    socket.once("connect", () => socket.write(`${query}\r\n`));
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length > WHOIS_MAX_BYTES) socket.destroy(); // 'close' resolves below
    });
    socket.once("end", () => finish(() => resolve(data)));
    socket.once("close", () => finish(() => resolve(data)));
    socket.once("timeout", () => {
      socket.destroy();
      finish(() => reject(new Error("whois timeout")));
    });
    socket.once("error", (err: Error) => finish(() => reject(err)));
  });
}

// Creation-date labels seen across registry WHOIS servers (ICANN RDDS + legacy).
const WHOIS_CREATION_RE =
  /(?:creation date|created on|created|registered on|registration date|registration time|domain registration date|registry creation date):\s*(.+)/i;

/** Parse a WHOIS date value (ISO or "dd-Mon-yyyy"-style) to ISO, or null. */
function parseWhoisDate(value: string): string | null {
  const cleaned = value.trim().replace(/\s*\(.*\)\s*$/, ""); // strip trailing "(...)"
  let d = new Date(cleaned);
  if (isNaN(d.getTime())) d = new Date(cleaned.replace(/-/g, " ")); // "28-Jul-2014" → "28 Jul 2014"
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Resolve a creation date via WHOIS: IANA referral → registry server → parse.
 * Returns the ISO date or null (no referral, no record, or unparseable date).
 * Throws on network/timeout failures so the caller can treat it as a failed source.
 */
async function fetchWhoisCreation(domain: string, timeout: number): Promise<string | null> {
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  const ianaResp = await whoisQuery("whois.iana.org", tld, timeout);
  // A TLD query to IANA returns the registry's WHOIS server in the `whois:` field;
  // a full-domain query returns it in `refer:`. Accept either.
  const refer = /^(?:refer|whois):\s*(\S+)/im.exec(ianaResp)?.[1];
  if (!refer) return null;

  await checkSsrf(refer); // the referral host is derived from the caller's TLD — vet it
  const resp = await whoisQuery(refer, domain, timeout);
  for (const line of resp.split("\n")) {
    const m = WHOIS_CREATION_RE.exec(line);
    if (m) {
      const iso = parseWhoisDate(m[1]);
      if (iso) return iso;
    }
  }
  return null;
}

/**
 * Earliest Wayback Machine capture for a domain (ISO date), or null if never
 * archived. Throws on network/timeout failures.
 */
async function fetchWaybackFirstCapture(domain: string, timeout: number): Promise<string | null> {
  await checkSsrf("web.archive.org");
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&limit=1&fl=timestamp&order=asc`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const data = await res.json();
  if (Array.isArray(data) && data.length >= 2 && Array.isArray(data[1]) && data[1][0]) {
    return formatWaybackTimestamp(String(data[1][0]));
  }
  return null;
}

/**
 * Earliest Wayback capture via the lightweight `available` API (closest snapshot
 * to 1990 = the oldest one). Used as a fallback for fetchWaybackFirstCapture: the
 * CDX `order=asc` scan is heavy and times out from some hosts, while this single
 * JSON call is reliable. Returns the ISO date or null. Throws on network/timeout.
 */
async function fetchWaybackEarliestAvailable(domain: string, timeout: number): Promise<string | null> {
  await checkSsrf("archive.org");
  const url = `https://archive.org/wayback/available?url=${encodeURIComponent(domain)}&timestamp=19900101`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const data = (await res.json()) as {
    archived_snapshots?: { closest?: { timestamp?: string } };
  };
  const ts = data?.archived_snapshots?.closest?.timestamp;
  if (typeof ts === "string" && /^\d{8}/.test(ts)) return formatWaybackTimestamp(ts);
  return null;
}

/**
 * Rough Wayback snapshot estimate (page count × ~50), or null if the count
 * could not be determined. Throws on network/timeout failures.
 */
async function fetchWaybackSnapshotEstimate(domain: string, timeout: number): Promise<number | null> {
  await checkSsrf("web.archive.org");
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&showNumPages=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  const pages = parseInt(text.trim(), 10);
  if (isNaN(pages)) return null;
  return pages * 50;
}

// --- Extracted domain-age logic (shared with the domain-vendor-risk aggregator) ---

export interface DomainAgeResult {
  domain: string;
  created_at: string | null;
  age_days: number | null;
  age_years: number | null;
  age_source: "rdap" | "whois" | "wayback_estimate" | null;
  first_archived_at: string | null;
  archive_snapshot_estimate: number | null;
  registration_to_archive_gap_days: number | null;
  maturity: "established" | "young" | "new" | "unknown";
  score: number;
  grade: string;
  findings: Finding[];
}

/**
 * Core domain-age logic (RDAP → WHOIS → Wayback, with phase-2 fallbacks),
 * extracted so aggregators (e.g. domain-vendor-risk) can reuse it directly.
 * Expects an already-validated domain. Individual source failures degrade to
 * nulls (they never throw the whole call). The route handler below calls this
 * and serializes the result unchanged.
 */
export async function runDomainAge(domain: string): Promise<DomainAgeResult> {
    const tld = domain.slice(domain.lastIndexOf(".") + 1);
    const timeout = timeouts.domainAge;

    // Three sources fetched concurrently; RDAP is internally a bootstrap → lookup chain.
    const [rdapResult, firstCaptureResult, snapshotResult] = await Promise.allSettled([
      fetchRdapCreation(domain, timeout),
      fetchWaybackFirstCapture(domain, timeout),
      fetchWaybackSnapshotEstimate(domain, timeout),
    ]);

    // A rejected RDAP fetch (network/timeout) is treated as "server exists but
    // unanswered" — we don't claim the TLD is unsupported on a transient failure.
    const rdap: RdapResult =
      rdapResult.status === "fulfilled" ? rdapResult.value : { supported: true, date: null };
    let firstArchivedAt =
      firstCaptureResult.status === "fulfilled" ? firstCaptureResult.value : null;
    const snapshotCount =
      snapshotResult.status === "fulfilled" ? snapshotResult.value : null;

    // Phase-2 fallbacks, run concurrently and only when needed:
    //   • WHOIS when RDAP yielded no creation date — covers bootstrap-missing TLDs
    //     (.io) and RDAP records that omit the registration event.
    //   • Wayback first-capture retry when the domain is provably archived
    //     (snapshot count > 0) yet the concurrent first-capture call came back
    //     empty — the flaky-host race that returned "archived but no first date".
    const needWhois = rdap.date === null;
    const needArchiveRetry =
      firstArchivedAt === null && snapshotCount !== null && snapshotCount > 0;
    let whoisCreation: string | null = null;
    // Distinguish "WHOIS server unreachable" (threw — e.g. port 43 blocked) from
    // "connected but no record" so the response can explain the null precisely.
    let whoisReachable = true;
    if (needWhois || needArchiveRetry) {
      const fallbackTimeout = Math.min(timeout, 4000); // keep total latency bounded
      const [whoisRes, retryRes] = await Promise.allSettled([
        needWhois ? fetchWhoisCreation(domain, fallbackTimeout) : Promise.resolve(null),
        // Retry the first capture via the reliable `available` API, not the heavy
        // CDX asc scan that may have just failed.
        needArchiveRetry ? fetchWaybackEarliestAvailable(domain, timeout) : Promise.resolve(null),
      ]);
      if (needWhois) {
        if (whoisRes.status === "fulfilled") whoisCreation = whoisRes.value;
        else whoisReachable = false; // rejected → connection/timeout failure
      }
      if (needArchiveRetry && retryRes.status === "fulfilled" && retryRes.value) {
        firstArchivedAt = retryRes.value;
      }
    }

    const hasArchive =
      firstArchivedAt !== null || (snapshotCount !== null && snapshotCount > 0);

    // archive_snapshot_estimate: known count if available, 0 when provably never
    // archived, otherwise null (count could not be determined).
    let archiveSnapshotEstimate: number | null;
    if (snapshotCount !== null) {
      archiveSnapshotEstimate = snapshotCount;
    } else if (!hasArchive) {
      archiveSnapshotEstimate = 0;
    } else {
      archiveSnapshotEstimate = null;
    }

    // Authoritative registration date: RDAP preferred, then WHOIS. Wayback is only
    // an estimate, so it is not counted as a true registration date.
    const registrationDate = rdap.date ?? whoisCreation;

    // Establish effective creation date and its source (best authoritative first).
    let createdAt: string | null = null;
    let ageSource: "rdap" | "whois" | "wayback_estimate" | null = null;
    if (rdap.date) {
      createdAt = rdap.date;
      ageSource = "rdap";
    } else if (whoisCreation) {
      // RDAP gave nothing (often a bootstrap-missing TLD like .io) — use WHOIS.
      createdAt = whoisCreation;
      ageSource = "whois";
    } else if (firstArchivedAt) {
      // No registration date anywhere — estimate age from the first archival capture.
      createdAt = firstArchivedAt;
      ageSource = "wayback_estimate";
    }

    const now = new Date();

    // Age computation.
    let ageDays: number | null = null;
    let ageYears: number | null = null;
    if (createdAt) {
      const createdDate = new Date(createdAt);
      ageDays = Math.floor((now.getTime() - createdDate.getTime()) / MS_PER_DAY);
      ageYears = Math.round((ageDays / DAYS_PER_YEAR) * 10) / 10;
    }

    // Gap between registration and first archive — only meaningful when both an
    // authoritative registration date (RDAP or WHOIS) and a first archive date are
    // known. Clamp to >= 0.
    let registrationToArchiveGapDays: number | null = null;
    if (registrationDate && firstArchivedAt) {
      const raw = Math.floor(
        (new Date(firstArchivedAt).getTime() - new Date(registrationDate).getTime()) / MS_PER_DAY,
      );
      registrationToArchiveGapDays = Math.max(0, raw);
    }

    // Maturity bucket.
    let maturity: "established" | "young" | "new" | "unknown";
    if (ageDays === null) {
      maturity = "unknown";
    } else if (ageDays < SIX_MONTHS_DAYS) {
      maturity = "new";
    } else if (ageDays < TWO_YEARS_DAYS) {
      maturity = "young";
    } else {
      maturity = "established";
    }

    // --- Scoring ---
    let score = 100;
    const findings: Finding[] = [];

    if (ageDays !== null) {
      if (ageDays < 30) {
        findings.push({ rule: "very_new_domain", deduction: -50, detail: `Domain is only ${ageDays} days old` });
        score -= 50;
      } else if (ageDays < SIX_MONTHS_DAYS) {
        findings.push({ rule: "new_domain", deduction: -30, detail: `Domain is ${ageDays} days old (under 6 months)` });
        score -= 30;
      } else if (ageDays < TWO_YEARS_DAYS) {
        findings.push({ rule: "young_domain", deduction: -15, detail: `Domain is ${ageDays} days old (under 2 years)` });
        score -= 15;
      }
    }

    // Confidence in the age signal itself — the core thing this endpoint measures.
    if (ageDays === null) {
      // Nothing dated the domain. Say so loudly instead of returning a quiet B.
      findings.push({
        rule: "age_undetermined",
        deduction: -40,
        detail:
          "Could not determine domain age — no creation date from RDAP or WHOIS, and no Wayback Machine capture to estimate from.",
      });
      score -= 40;
    } else if (!registrationDate) {
      // Age came only from the earliest archive — usable, but an estimate.
      findings.push({
        rule: "registration_date_estimated",
        deduction: -15,
        detail:
          "No authoritative registration date (RDAP and WHOIS unavailable); age estimated from the earliest Wayback Machine capture.",
      });
      score -= 15;
    }

    if (!hasArchive) {
      findings.push({ rule: "no_archive_history", deduction: -20, detail: "Domain has never been captured by the Wayback Machine" });
      score -= 20;
    }

    // Informational notes (no score impact): explain HOW the registration date was
    // sourced — or why it is missing — so a caller seeing a WHOIS-derived date, an
    // estimate, or nulls knows exactly why rather than guessing. This is what keeps
    // a bootstrap-missing-TLD result a useful, chargeable answer.
    if (!rdap.supported) {
      const whoisOutcome = !whoisReachable
        ? "WHOIS lookup failed (registry server unreachable)"
        : "WHOIS returned no record";
      const note = whoisCreation
        ? "used WHOIS for the registration date instead"
        : firstArchivedAt
          ? `${whoisOutcome}; fell back to the earliest Wayback Machine capture for an age estimate`
          : `${whoisOutcome}, so age is undetermined`;
      findings.push({
        rule: "rdap_unsupported_tld",
        deduction: 0,
        detail: `RDAP is not published for .${tld} (no IANA bootstrap entry) — ${note}.`,
      });
    } else if (rdap.date === null && whoisCreation) {
      findings.push({
        rule: "rdap_no_registration_event",
        deduction: 0,
        detail: "RDAP record contained no registration event; used WHOIS for the creation date.",
      });
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    return {
      domain,
      created_at: createdAt,
      age_days: ageDays,
      age_years: ageYears,
      age_source: ageSource,
      first_archived_at: firstArchivedAt,
      archive_snapshot_estimate: archiveSnapshotEstimate,
      registration_to_archive_gap_days: registrationToArchiveGapDays,
      maturity,
      score,
      grade,
      findings,
    };
}

// --- Route handler ---

domainAgeRouter.get("/domain-age/check", async (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string | undefined;
    if (!rawDomain) {
      res.status(400).json({
        error: 'domain is required — pass it as a query param, e.g. ?domain=example.com',
      });
      return;
    }

    const domain = validateDomain(rawDomain);
    res.json(await runDomainAge(domain));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Domain age error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
