import { Router, type Request, type Response } from "express";
import { validateUrl, ValidationError } from "../utils/validators.js";
import { describeFetchFailure } from "../utils/fetch-failure.js";
import { pickField, pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";
import { safeFetch, FetchProblem, type SafeFetchResult } from "../utils/safe-fetch.js";

export const webFetchRouter = Router();

// /web/fetch — raw server-side fetch of a URL: JSON parsed under `json`,
// everything else returned verbatim under `text`. Sibling of /web/extract with
// the same fetch/abort/SSRF/billing machinery, MINUS the markdown conversion
// (which mangles structured data), PLUS a longer timeout (data APIs are slow)
// and a caller-tunable byte cap. Built for ArcGIS feature services, open-data
// portals, blob storage and plain JSON/CSV endpoints — a real agent retried
// /web/extract 5× in 24h against exactly those URLs and 504'd every time.
//
// Billing posture (house policy — see WEB-DATA-BATCH-HANDOFF.md and
// src/utils/source-usability.ts): bill ONLY on a usable 2xx body. Target 4xx/5xx
// → mirrored status, uncharged. Timeout → 504 uncharged. SSRF/non-http(s) →
// 422/400 uncharged. Oversized JSON we cannot return whole → 413 uncharged.

// --- Interfaces ---

interface Finding {
  rule: string;
  detail: string;
}


// --- Constants ---

const DEFAULT_MAX_BYTES = 2_000_000;
// Absolute ceiling on what we will read from any source, whatever the caller
// asks for. Keeps a hostile/huge body from ballooning memory (5 MB, matching
// /web/extract's input read cap).
const HARD_CAP_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;

// Synonyms agents send for the URL (canonical first) and the byte cap.
const URL_ALIASES = ["url", "uri", "target", "link", "u"];
const MAX_BYTES_ALIASES = ["max_bytes", "maxbytes", "maxBytes", "limit_bytes", "limitBytes"];

// Spec: a normal browser UA — a number of open-data portals / county sites
// sit behind WAFs that 403 obviously-automated clients. NOTE: this differs
// from /web/extract's honest "Mozilla/5.0 (compatible; NetIntel/1.0)". We never
// RETRY with a different UA after a block (source-usability policy) — this is
// the one and only request identity.
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ACCEPT = "application/json, text/*;q=0.9, */*;q=0.5";

// Content-type families that are never text. application/octet-stream is
// deliberately ABSENT: blob storage serves .json/.csv files under it, so those
// go through the NUL-byte sniff + JSON-promotion path instead.
const BINARY_MEDIA_PREFIXES = ["image/", "audio/", "video/", "font/"];
const BINARY_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/wasm",
]);

const INSTRUCTIVE_URL_400 =
  'url is required — pass an absolute http(s) URL via ?url=https://api.example.com/data.json (GET) ' +
  'or a JSON body {"url":"https://api.example.com/data.json"} (POST). Also accepted: uri, target, link, u.';


// --- Body helpers ---

function parseContentType(header: string): { mediaType: string | null; charset: string | null } {
  const trimmed = header.trim();
  if (!trimmed) return { mediaType: null, charset: null };
  const [type, ...params] = trimmed.split(";");
  const mediaType = type.trim().toLowerCase() || null;
  let charset: string | null = null;
  for (const p of params) {
    const [k, v] = p.split("=");
    if (k && v && k.trim().toLowerCase() === "charset") {
      charset = v.trim().replace(/^["']|["']$/g, "").toLowerCase() || null;
    }
  }
  return { mediaType, charset };
}

function isBinaryMediaType(mediaType: string | null): boolean {
  if (!mediaType) return false;
  if (BINARY_MEDIA_PREFIXES.some((p) => mediaType.startsWith(p))) return true;
  return BINARY_MEDIA_TYPES.has(mediaType);
}

/** Text files essentially never contain NUL; binary formats almost always do early. */
function hasNulByte(bytes: Buffer, window = 8192): boolean {
  const end = Math.min(bytes.length, window);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Decode honoring the declared charset (falling back to UTF-8 for unknown
 * labels). Returns whether any byte sequence was invalid for the chosen
 * encoding, so the caller can flag lossy replacement characters.
 */
function decodeBody(bytes: Buffer, charset: string | null): { text: string; lossy: boolean } {
  const label = charset || "utf-8";
  let strict: TextDecoder;
  try {
    strict = new TextDecoder(label, { fatal: true });
  } catch {
    strict = new TextDecoder("utf-8", { fatal: true });
  }
  try {
    return { text: strict.decode(bytes), lossy: false };
  } catch {
    const loose = new TextDecoder(strict.encoding);
    return { text: loose.decode(bytes), lossy: true };
  }
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** JSON.parse that never throws: returns { ok: true, value } or { ok: false }. */
function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(stripBom(text)) };
  } catch {
    return { ok: false };
  }
}

function isJsonContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === "object";
}

/** Parse the optional max_bytes parameter (query wins over body, like pickRequestParam). */
function resolveMaxBytes(
  req: Request,
  findings: Finding[],
): { ok: true; maxBytes: number } | { ok: false; error: string } {
  const raw = pickField(req.query, MAX_BYTES_ALIASES) ?? pickField(req.body, MAX_BYTES_ALIASES);
  if (raw === undefined) return { ok: true, maxBytes: DEFAULT_MAX_BYTES };
  const n =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 1) {
    return {
      ok: false,
      error:
        `max_bytes must be a positive integer number of bytes (received ${JSON.stringify(String(raw).slice(0, 40))}) — ` +
        `e.g. max_bytes=500000; default ${DEFAULT_MAX_BYTES}, hard cap ${HARD_CAP_BYTES}. Also accepted: maxbytes, limit_bytes.`,
    };
  }
  let maxBytes = Math.floor(n);
  if (maxBytes > HARD_CAP_BYTES) {
    findings.push({
      rule: "max_bytes_clamped",
      detail: `max_bytes ${maxBytes} exceeds the ${HARD_CAP_BYTES}-byte hard cap and was clamped to ${HARD_CAP_BYTES}`,
    });
    maxBytes = HARD_CAP_BYTES;
  }
  return { ok: true, maxBytes };
}

function upstreamCode(status: number): string {
  if (status === 404 || status === 410) return "SOURCE_NOT_FOUND";
  if (status === 401 || status === 403 || status === 429) return "SOURCE_BLOCKED";
  return "UPSTREAM_ERROR";
}

// --- Route handler (shared by GET and POST) ---

async function handleWebFetch(req: Request, res: Response): Promise<void> {
  try {
    const rawUrl = pickRequestParam(req, URL_ALIASES);
    if (!rawUrl) {
      res.status(400).json({ error: INSTRUCTIVE_URL_400 });
      return;
    }

    // Non-http(s) / malformed / credentialed → 400 (ValidationError), uncharged.
    const parsed = validateUrl(rawUrl);

    const findings: Finding[] = [];
    const cap = resolveMaxBytes(req, findings);
    if (!cap.ok) {
      res.status(400).json({ error: cap.error });
      return;
    }
    const maxBytes = cap.maxBytes;

    let result: SafeFetchResult;
    try {
      result = await safeFetch(parsed, {
        headers: { "User-Agent": USER_AGENT, Accept: ACCEPT },
        timeoutMs: timeouts.webFetch,
        maxRedirects: MAX_REDIRECTS,
        maxBytes,
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        // checkSsrf: private/reserved target (input OR a redirect hop), or an
        // unresolvable hostname — uncharged 422.
        res.status(422).json({ error: `${err.message}. You were not charged.`, code: "SSRF_BLOCKED", url: parsed.href });
        return;
      }
      if (err instanceof FetchProblem) {
        res.status(err.status).json({ error: err.message, code: err.code, url: parsed.href, ...err.extra });
        return;
      }
      const name = (err as { name?: string })?.name;
      if (name === "AbortError" || name === "TimeoutError") {
        res.status(504).json({
          error: `The source did not finish responding within ${timeouts.webFetch} ms. You were not charged.`,
          code: "UPSTREAM_TIMEOUT",
          url: parsed.href,
          timeout_ms: timeouts.webFetch,
        });
        return;
      }
      // Already read err.cause, but passed its raw text through verbatim
      // ("certificate has expired" alone does not tell a caller WHOSE fault it
      // is or whether retrying helps). Shared mapping: src/utils/fetch-failure.ts.
      const failure = describeFetchFailure(err);
      console.error("Web fetch failed:", failure.reason, err);
      res.status(502).json({ ...failure, url: parsed.href });
      return;
    }

    const { status, finalUrl, contentType: contentTypeHeader, bytes, truncated } = result;

    // A 3xx the shared fetcher could not follow (no Location header) — nothing
    // to return. Kept as its own 502 so the message stays actionable.
    if (status >= 300 && status < 400) {
      res.status(502).json({
        error: `The source answered HTTP ${status} (redirect) without a Location header — nothing to follow. You were not charged.`,
        code: "UPSTREAM_ERROR",
        url: parsed.href,
        upstream_status: status,
        final_url: finalUrl,
      });
      return;
    }

    // Non-2xx: nothing the agent can use → mirror the status, uncharged.
    // Exception: an upstream 402 must NOT be mirrored — on this surface a 402 IS
    // the x402 paywall challenge, and body-reading clients would try to pay it.
    if (status < 200 || status >= 300) {
      const mirrored = status === 402 ? 502 : status;
      res.status(mirrored).json({
        error: `The source returned HTTP ${status} — nothing usable to return. You were not charged.`,
        code: upstreamCode(status),
        upstream_status: status,
        url: parsed.href,
        final_url: finalUrl,
      });
      return;
    }

    const { mediaType, charset } = parseContentType(contentTypeHeader);
    const common = { url: parsed.href, final_url: finalUrl, status, content_type: mediaType };

    if (bytes.length === 0 || (bytes.length <= 4096 && bytes.toString("utf8").trim() === "")) {
      res.status(422).json({
        error: `The source returned HTTP ${status} with an empty body — nothing to return. You were not charged.`,
        code: "EMPTY_BODY",
        ...common,
      });
      return;
    }

    if (isBinaryMediaType(mediaType) || hasNulByte(bytes)) {
      res.status(422).json({
        error:
          `The source body is binary (${mediaType ?? "unknown content-type"}) — this endpoint returns JSON or text, ` +
          `not binary payloads. You were not charged.`,
        code: "BINARY_CONTENT",
        ...common,
        bytes: bytes.length,
        truncated,
      });
      return;
    }

    const declaredJson = !!mediaType && mediaType.includes("json");
    const decoded = decodeBody(bytes, charset);
    let text = decoded.text;
    if (decoded.lossy) {
      findings.push({
        rule: "lossy_decode",
        detail: `body was not valid ${charset || "utf-8"}; invalid sequences were replaced with U+FFFD`,
      });
    }

    let json: Record<string, unknown> | unknown[] | null = null;
    let textOut: string | null = null;

    if (truncated) {
      // A cut-off JSON document is unparseable — nothing usable to sell.
      // (Only if the prefix somehow still parses do we return it.)
      const parsedPrefix = declaredJson ? tryParseJson(text) : ({ ok: false } as const);
      if (declaredJson && !(parsedPrefix.ok && isJsonContainer(parsedPrefix.value))) {
        const atHardCap = maxBytes >= HARD_CAP_BYTES;
        res.status(413).json({
          error: atHardCap
            ? `The source's JSON body exceeds the ${HARD_CAP_BYTES}-byte hard cap and a truncated JSON prefix is unparseable — nothing usable to return. You were not charged.`
            : `The source's JSON body exceeds max_bytes (${maxBytes}) and a truncated JSON prefix is unparseable — retry with a larger max_bytes (up to ${HARD_CAP_BYTES}). You were not charged.`,
          code: "BODY_TOO_LARGE",
          ...common,
          max_bytes: maxBytes,
          hard_cap_bytes: HARD_CAP_BYTES,
        });
        return;
      }
      if (parsedPrefix.ok && isJsonContainer(parsedPrefix.value)) {
        json = parsedPrefix.value;
      } else {
        // Drop a dangling partial multi-byte sequence at the cut.
        text = text.replace(/�+$/, "");
        textOut = text;
      }
      findings.push({
        rule: "body_truncated",
        detail: `source body exceeded max_bytes (${maxBytes}); returned the first ${bytes.length} bytes`,
      });
    } else {
      const parsedBody = tryParseJson(text);
      if (parsedBody.ok && isJsonContainer(parsedBody.value)) {
        json = parsedBody.value;
        if (!declaredJson) {
          findings.push({
            rule: "json_detected",
            detail: `content-type was ${mediaType ?? "missing"} but the body parsed cleanly as JSON — returned under json`,
          });
        }
      } else if (parsedBody.ok) {
        // Valid JSON but a scalar (number/string/bool/null): `json` is typed
        // object|array|null, so hand back the raw text.
        textOut = text;
        if (declaredJson) {
          findings.push({ rule: "json_scalar", detail: "body is valid JSON but a scalar value — returned as text" });
        }
      } else {
        textOut = text;
        if (declaredJson) {
          findings.push({
            rule: "json_parse_failed",
            detail: `content-type declares JSON (${mediaType}) but the body did not parse — returned raw as text`,
          });
        }
      }
    }

    res.json({
      ...common,
      bytes: bytes.length,
      truncated,
      json,
      text: textOut,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Web fetch error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET (?url=) is canonical; POST carries {"url": …} in the body for agents that
// send one. Both share one handler and paired paid route entries (index.ts).
webFetchRouter.get("/web/fetch", handleWebFetch);
webFetchRouter.post("/web/fetch", handleWebFetch);
