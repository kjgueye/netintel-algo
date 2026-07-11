import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { config, pricing } from "../config.js";
import { ValidationError } from "../utils/validators.js";

export const calendarIcsRouter = Router();

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge
// instead of a 404.
const calendarIcsPaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      price: pricing.calendarIcs,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  error: "Payment required",
};

calendarIcsRouter.get("/calendar/ics", (_req: Request, res: Response) => {
  res.status(402).json(calendarIcsPaymentRequired);
});

calendarIcsRouter.head("/calendar/ics", (_req: Request, res: Response) => {
  res.status(402).end();
});

// --- Date primitives ---------------------------------------------------------

interface Ymd {
  y: number;
  mo: number; // 1-12
  d: number;
}

const BARE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// ISO-8601 timestamp: date + time, optional seconds/fraction, optional offset.
const ISO_TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// True only if (y, mo, d) is a real calendar date (rejects 2026-02-30 etc.,
// which Date.UTC would silently roll over).
function validYmd(y: number, mo: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isValidTimezone(tz: string): boolean {
  try {
    // Throws RangeError for an unknown IANA zone.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Offset (ms) of `timeZone` at the instant `date` — i.e. (wall clock in zone) -
// (UTC). Standard Intl trick: format the UTC instant *as if* it were in the
// zone, then diff against the original UTC milliseconds.
function tzOffsetMs(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  // "24" can appear for midnight in some engines — normalize to 0.
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - date.getTime();
}

// Interpret a naive wall-clock time (no offset) as being in `timeZone` and
// return the corresponding absolute UTC instant.
function naiveZonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): Date {
  const naiveUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = tzOffsetMs(timeZone, new Date(naiveUtc));
  return new Date(naiveUtc - offset);
}

// Parse a timed value into an absolute UTC instant.
//   - explicit offset (Z / ±hh:mm) → already absolute, parsed as-is
//   - no offset + IANA timezone     → interpreted as wall time in that zone
//   - no offset + no timezone       → treated as UTC (UTC-Z decision)
// Returns null if the value is not a parseable ISO-8601 date/timestamp.
function parseInstant(value: string, timezone: string | undefined): Date | null {
  const v = value.trim();

  const bare = BARE_DATE_RE.exec(v);
  if (bare) {
    const y = +bare[1];
    const mo = +bare[2];
    const d = +bare[3];
    if (!validYmd(y, mo, d)) return null;
    return timezone
      ? naiveZonedToUtc(y, mo, d, 0, 0, 0, timezone)
      : new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  }

  const m = ISO_TS_RE.exec(v);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const h = +m[4];
  const mi = +m[5];
  const s = m[6] !== undefined ? +m[6] : 0;
  const off = m[7];

  if (!validYmd(y, mo, d) || h > 23 || mi > 59 || s > 59) return null;

  if (off) {
    // Absolute instant — normalize a bare "+0200" offset to "+02:00" for Date.
    const offset = off === "Z" ? "Z" : off.includes(":") ? off : `${off.slice(0, 3)}:${off.slice(3)}`;
    const dt = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${pad(s)}${offset}`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  if (timezone) return naiveZonedToUtc(y, mo, d, h, mi, s, timezone);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

// Pull just the calendar date out of a value (bare date or timestamp prefix).
// Used for all-day events, which are floating dates with no timezone math.
function extractDate(value: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (!validYmd(y, mo, d)) return null;
  return { y, mo, d };
}

function addDays(date: Ymd, n: number): Ymd {
  const dt = new Date(Date.UTC(date.y, date.mo - 1, date.d + n));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// ICS DATE value: 20260627
function formatDate(date: Ymd): string {
  return `${date.y}${pad(date.mo)}${pad(date.d)}`;
}

// ICS UTC DATE-TIME value: 20260627T020000Z
function formatUtc(dt: Date): string {
  return (
    `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}` +
    `T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}${pad(dt.getUTCSeconds())}Z`
  );
}

// --- RFC 5545 text construction ---------------------------------------------

// Escape a TEXT value (SUMMARY/DESCRIPTION/LOCATION). Order matters: the
// backslash MUST be escaped first, otherwise it doubles the escapes we add next.
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// Fold a single content line to <=75 octets per RFC 5545 §3.1. Continuation
// lines begin with a single space (CRLF + " "), which counts toward the 75
// octets, so they carry at most 74 octets of content. We fold on UTF-8 octet
// boundaries but never split a multi-byte character.
function foldLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    const limit = out.length === 0 ? 75 : 74;
    if (curBytes + chBytes > limit) {
      out.push(cur);
      cur = ch;
      curBytes = chBytes;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  out.push(cur);
  return out.join("\r\n ");
}

// Build an ORGANIZER line. A cal-address must be a mailto: URI; we extract an
// email if one is present and carry the display name as a quoted CN param.
function organizerLine(org: string): string {
  const emailMatch = org.match(/[^\s<>]+@[^\s<>]+/);
  const email = emailMatch ? emailMatch[0] : null;
  let cn = org.replace(/<[^>]*>/, "").trim();
  if (!cn) cn = email ?? org.trim();
  const cnSafe = cn.replace(/"/g, "");
  const addr = email ? `mailto:${email}` : "mailto:noreply@netintel.dev";
  return `ORGANIZER;CN="${cnSafe}":${addr}`;
}

interface Finding {
  rule: string;
  detail: string;
}

interface BuildResult {
  ics: string;
  uid: string;
  all_day: boolean;
  findings: Finding[];
}

function buildIcs(input: {
  title: string;
  startsAt: string;
  endsAt?: string;
  allDay: boolean;
  timezone?: string;
  location?: string;
  description?: string;
  url?: string;
  organizer?: string;
}): BuildResult {
  const findings: Finding[] = [];

  // Deterministic UID for idempotent re-import: stable across calls for the same
  // (title, starts_at). DTSTAMP below is the only non-deterministic line.
  const uidHash = createHash("sha256")
    .update(`${input.title}|${input.startsAt}`)
    .digest("hex");
  const uid = `${uidHash}@netintel.dev`;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NetIntel//Event ICS//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${formatUtc(new Date())}`,
  ];

  if (input.allDay) {
    // All-day: floating DATE values, no timezone math. The ICS DTEND is
    // EXCLUSIVE, so the inclusive end date (ends_at, else starts_at) + 1 day.
    const startDate = extractDate(input.startsAt)!;
    let inclusiveEnd: Ymd | null = null;
    if (input.endsAt) {
      inclusiveEnd = extractDate(input.endsAt);
      if (!inclusiveEnd) {
        findings.push({ rule: "defaulted_end", detail: "ends_at was not a valid date; defaulted to a single all-day event" });
      }
    }
    if (!inclusiveEnd) {
      if (!input.endsAt) {
        findings.push({ rule: "defaulted_end", detail: "ends_at not provided; defaulted to DTSTART + 1 day (exclusive)" });
      }
      inclusiveEnd = startDate;
    }
    const dtEnd = addDays(inclusiveEnd, 1);
    lines.push(`DTSTART;VALUE=DATE:${formatDate(startDate)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDate(dtEnd)}`);
  } else {
    // Timed: convert to UTC-Z (decision: never hand-roll VTIMEZONE — UTC-Z
    // imports to the correct local instant in every calendar app).
    const start = parseInstant(input.startsAt, input.timezone)!;
    let end: Date | null = null;
    if (input.endsAt) {
      end = parseInstant(input.endsAt, input.timezone);
      if (!end) {
        findings.push({ rule: "defaulted_end", detail: "ends_at was not a valid timestamp; defaulted to DTSTART + 1 hour" });
      }
    }
    if (!end) {
      if (!input.endsAt) {
        // Omitting DTEND renders as zero-duration in some clients — default +1h.
        findings.push({ rule: "defaulted_end", detail: "ends_at not provided; defaulted to DTSTART + 1 hour" });
      }
      end = new Date(start.getTime() + 60 * 60 * 1000);
    }
    lines.push(`DTSTART:${formatUtc(start)}`);
    lines.push(`DTEND:${formatUtc(end)}`);
  }

  lines.push(`SUMMARY:${escapeText(input.title)}`);
  if (input.location) lines.push(`LOCATION:${escapeText(input.location)}`);
  if (input.description) lines.push(`DESCRIPTION:${escapeText(input.description)}`);
  if (input.url) lines.push(`URL:${input.url}`);
  if (input.organizer) lines.push(organizerLine(input.organizer));

  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  // Fold each content line, join with CRLF, and terminate with a trailing CRLF.
  const ics = lines.map(foldLine).join("\r\n") + "\r\n";

  return { ics, uid, all_day: input.allDay, findings };
}

// --- Route handler -----------------------------------------------------------

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

calendarIcsRouter.post("/calendar/ics", (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};

    // 1. Validate title (UNCHARGED → 400 on failure).
    const rawTitle = body.title;
    if (typeof rawTitle !== "string" || rawTitle.trim() === "") {
      res.status(400).json({ error: 'title and starts_at are required — e.g. {"title":"Team sync","starts_at":"2026-07-15T14:00:00-04:00"}' });
      return;
    }
    const title = rawTitle.trim();

    // starts_at required + parseable.
    const rawStart = body.starts_at;
    if (typeof rawStart !== "string" || rawStart.trim() === "") {
      res.status(400).json({ error: 'title and starts_at are required — e.g. {"title":"Team sync","starts_at":"2026-07-15T14:00:00-04:00"}' });
      return;
    }
    const startsAt = rawStart.trim();

    // Optional timezone — ignored if it is not a known IANA zone.
    const tzRaw = asOptionalString(body.timezone, "timezone");
    const timezone = tzRaw && isValidTimezone(tzRaw) ? tzRaw : undefined;

    // 2. Resolve all_day: explicit boolean wins; otherwise inferred from shape
    //    (bare YYYY-MM-DD → all-day, timestamp → timed).
    const isBareDate = BARE_DATE_RE.test(startsAt);
    let allDay: boolean;
    if (typeof body.all_day === "boolean") {
      allDay = body.all_day;
    } else if (body.all_day !== undefined) {
      throw new ValidationError("all_day must be a boolean");
    } else {
      allDay = isBareDate;
    }

    // Validate starts_at is parseable for the resolved mode.
    if (allDay) {
      if (!extractDate(startsAt)) {
        res.status(400).json({ error: "starts_at is not a valid ISO-8601 date" });
        return;
      }
    } else {
      if (!parseInstant(startsAt, timezone)) {
        res.status(400).json({ error: "starts_at is not a valid ISO-8601 date" });
        return;
      }
    }

    const endsAt = asOptionalString(body.ends_at, "ends_at");
    const location = asOptionalString(body.location, "location");
    const description = asOptionalString(body.description, "description");
    const url = asOptionalString(body.url, "url");
    const organizer = asOptionalString(body.organizer, "organizer");

    const { ics, uid, all_day, findings } = buildIcs({
      title,
      startsAt,
      endsAt,
      allDay,
      timezone,
      location,
      description,
      url,
      organizer,
    });

    // 3. Download mode: an explicit ?download=1 or a text/calendar Accept header
    //    serves the raw file; everything else gets the canonical JSON envelope.
    const wantsDownload =
      req.query.download === "1" ||
      req.query.download === "true" ||
      (req.headers.accept ?? "").toLowerCase().includes("text/calendar");

    if (wantsDownload) {
      const slug =
        title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) ||
        "event";
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${slug}.ics"`);
      res.status(200).send(ics);
      return;
    }

    res.json({
      data: { ics, uid, all_day },
      score: 100,
      grade: "A",
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Calendar ICS error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
