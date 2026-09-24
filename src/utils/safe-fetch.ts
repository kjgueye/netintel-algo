// The ONE server-side fetcher for caller-controlled URLs.
//
// Why it exists: `fetch(url, { redirect: "follow" })` follows every hop itself,
// so a public URL that 302s to 169.254.169.254 / an RFC-1918 host / a Railway-
// internal hostname is requested before response.url can be inspected — the
// initial validateUrl + checkSsrf on the caller's hostname protects hop 0 only.
// Until 2026-09 four routes each carried a private manual-redirect loop
// (web-fetch, web-extract, extract-invoice, redirect) while ten others followed
// redirects unchecked. This module is web-fetch's implementation, lifted.
//
// Guarantees:
//   - checkSsrf() runs BEFORE every hop is requested (throws ValidationError,
//     which every route already maps to an uncharged 4xx).
//   - Redirect hops are capped (default 5); a non-http(s) Location is refused;
//     embedded credentials are never forwarded to the next hop.
//   - ONE deadline covers every hop AND the body read — the timer is cleared
//     only after the body is consumed, so a stalled body cannot outlive
//     `timeoutMs`.
//   - Body reads are capped at `maxBytes` (streamed, never buffered past the
//     cap; `truncated` tells the caller). HEAD never reads a body.
//   - A 3xx WITHOUT a Location header is returned as the final response — what
//     redirect:"follow" does — so converted routes keep their response shape.
//
// Not covered (documented follow-up): DNS-rebinding TOCTOU between checkSsrf's
// lookup and fetch's own lookup. Closing it needs an undici Agent with a pinned
// lookup; out of scope for the 2026-09 hardening pass.

import { checkSsrf } from "./validators.js";

/** The global fetch Response type (routes import express's `Response`, which shadows it). */
export type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/** A fetch-stage failure that maps to a specific uncharged HTTP status. */
export class FetchProblem extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FetchProblem";
  }
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  /** Hard wall-clock cap covering every hop AND the body read. */
  timeoutMs: number;
  /** Max redirect hops to follow (default 5). */
  maxRedirects?: number;
  /** Max body bytes to read (default 5 MB). Ignored for HEAD. */
  maxBytes?: number;
}

export interface SafeFetchResult {
  status: number;
  ok: boolean;
  /** URL of the final hop (after redirects). */
  finalUrl: string;
  headers: Headers;
  /** Raw Content-Type header of the final hop ("" when absent). */
  contentType: string;
  bytes: Buffer;
  /** True when the source had more than `maxBytes` (only the first `maxBytes` are kept). */
  truncated: boolean;
  /** Redirects followed. */
  hops: number;
  /** UTF-8 decoding of `bytes` (BOM stripped, like Response.text()). Lazy + cached. */
  readonly text: string;
}

export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BYTES = 5_000_000;

/**
 * Read at most `cap` bytes of the body, then cancel the stream. `truncated`
 * is true when the source had MORE than `cap` bytes (we read at most one
 * extra chunk past the cap to know, then drop it) — never buffers unbounded.
 */
export async function readCapped(
  resp: FetchResponse,
  cap: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const reader = resp.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await resp.arrayBuffer());
    return { bytes: buf.length > cap ? buf.subarray(0, cap) : buf, truncated: buf.length > cap };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
      if (total > cap) {
        truncated = true;
        break;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const combined = Buffer.concat(chunks);
  return { bytes: truncated ? combined.subarray(0, cap) : combined, truncated };
}

function makeResult(r: Omit<SafeFetchResult, "text">): SafeFetchResult {
  let cached: string | undefined;
  return Object.defineProperty({ ...r }, "text", {
    enumerable: true,
    get(): string {
      if (cached === undefined) cached = new TextDecoder("utf-8").decode(r.bytes);
      return cached;
    },
  }) as SafeFetchResult;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * Fetch a caller-controlled URL with every redirect hop SSRF-checked before it
 * is requested. Throws:
 *   - ValidationError (from checkSsrf) — private/reserved/unresolvable target on
 *     ANY hop; routes map it to an uncharged 4xx.
 *   - FetchProblem — too many redirects (502), non-http(s) Location (422),
 *     unparseable Location (502).
 *   - AbortError — `timeoutMs` elapsed (during any hop or the body read).
 *   - whatever fetch() throws on transport failure.
 */
export async function safeFetch(start: string | URL, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const method = opts.method ?? "GET";
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let current = typeof start === "string" ? new URL(start) : start;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      // Throws ValidationError → the route's uncharged 4xx.
      await checkSsrf(current.hostname);

      const resp = await fetch(current.href, {
        method,
        headers: opts.headers,
        redirect: "manual",
        signal: controller.signal,
      });

      const status = resp.status;
      const location = isRedirect(status) ? resp.headers.get("location") : null;
      if (location) {
        resp.body?.cancel?.().catch(() => {});
        if (hop >= maxRedirects) {
          throw new FetchProblem(
            502,
            "TOO_MANY_REDIRECTS",
            `The source redirected more than ${maxRedirects} times — giving up. You were not charged.`,
            { upstream_status: status, final_url: current.href },
          );
        }
        let next: URL;
        try {
          next = new URL(location, current.href);
        } catch {
          throw new FetchProblem(
            502,
            "UPSTREAM_ERROR",
            `The source redirected to an unparseable Location (${JSON.stringify(location.slice(0, 80))}). You were not charged.`,
            { upstream_status: status, final_url: current.href },
          );
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new FetchProblem(
            422,
            "REDIRECT_BLOCKED",
            `The source redirected to a non-http(s) URL (${next.protocol}//…) — not followed. You were not charged.`,
            { upstream_status: status, final_url: current.href },
          );
        }
        // Never forward embedded credentials to the next hop.
        next.username = "";
        next.password = "";
        current = next;
        continue;
      }

      const headers = resp.headers;
      const contentType = headers.get("content-type") || "";
      let bytes: Buffer = Buffer.alloc(0);
      let truncated = false;
      if (method === "HEAD") {
        resp.body?.cancel?.().catch(() => {});
      } else {
        // Still under the deadline: a stalled body aborts via the same signal.
        ({ bytes, truncated } = await readCapped(resp, maxBytes));
      }
      return makeResult({
        status,
        ok: status >= 200 && status < 300,
        finalUrl: resp.url || current.href,
        headers,
        contentType,
        bytes,
        truncated,
        hops: hop,
      });
    }
    // Unreachable: the loop returns on the final hop or throws on overflow.
    throw new FetchProblem(502, "TOO_MANY_REDIRECTS", "redirect handling fell through");
  } finally {
    clearTimeout(timer);
  }
}

/** True for the abort/timeout error shapes fetch raises when `timeoutMs` elapses. */
export function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === "AbortError" || name === "TimeoutError";
}
