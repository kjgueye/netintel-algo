// Shared OpenAI fetch with retry/backoff on TRANSIENT failures — used by BOTH the
// /openai/* + gateway passthrough (openai-passthrough.ts) and the structured helper
// (openai-json.ts), so every OpenAI-backed endpoint gets the same resilience with
// no per-route code.
//
// Why (2026-09-03): a single OpenAI 429 used to become an instant 502 — a LOST
// billable call. That's easy to hit now that ~14 endpoints funnel to gpt-4o-mini,
// especially under an agent's burst (observed: an agent firing 8 calls in ~2s got
// 8× 502). Retrying a couple times with short backoff, well inside the 60s timeout,
// recovers most of these into settled 200s.
//
// ONLY transient statuses (429 + 5xx) and transport errors are retried; a real
// client error (400/401/404/422) or our own deadline-abort is returned/thrown
// immediately, so each caller's existing !ok / catch handling fires unchanged. The
// whole loop is bounded by the caller's timeoutMs deadline.

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3; // 1 try + up to 2 retries
// 300ms then 900ms in prod; ~0 under Vitest so the retry path doesn't slow tests.
const BASE_BACKOFF_MS = process.env.VITEST || process.env.NODE_ENV === "test" ? 1 : 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry-After header (delta-seconds or HTTP-date) → ms, or null. */
function retryAfterMs(res: Response): number | null {
  const h = res.headers?.get?.("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * Drain the body while the attempt's deadline is still armed, then hand back an
 * equivalent Response whose .json()/.text() resolve from memory — so the caller's
 * existing body read can never wait on the network past the deadline. Stub
 * responses with no body reader (the unit tests' bare {ok,status,json} objects)
 * have no stream that could stall and pass through untouched.
 */
async function readBodyUnderDeadline(upstream: Response, deadline: Promise<never>): Promise<Response> {
  if (typeof upstream.text !== "function") return upstream;
  const text = await Promise.race([upstream.text(), deadline]);
  // A null-body status (204/205/304) rejects any non-null body, even "".
  return new Response(text.length > 0 ? text : null, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

/**
 * fetch() the OpenAI API, retrying transient failures within a timeoutMs total
 * deadline. Returns the final Response (possibly !ok, if retries were exhausted or
 * the status is non-retryable) — the caller handles !ok as before. Throws on a
 * transport failure or deadline-abort that persists past the retries (same contract
 * as a raw fetch throwing). Each attempt is itself bounded by the remaining budget.
 */
export async function openAiFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  modelId: string,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Race the fetch against the deadline: the timer aborts the real request
      // (cancellation) AND rejects the race (so we never hang even if the underlying
      // fetch ignores the abort signal). A timeout rejects with name "AbortError".
      const deadlineReject = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const e = new Error(`timeout after ${timeoutMs}ms`);
          e.name = "AbortError";
          reject(e);
        }, remaining);
      });
      const upstream = await Promise.race([fetch(url, { ...init, signal: controller.signal }), deadlineReject]);
      // Headers are in, but the BODY is still on the wire: read it under the SAME
      // deadline before disarming the timer. Callers .json() the body after this
      // returns, so a body that stalled after the headers used to outlive the
      // advertised timeout. A body that dies mid-read is a transport failure like
      // any other (retried below); our own deadline-abort stays terminal.
      const res = await readBodyUnderDeadline(upstream, deadlineReject);
      clearTimeout(timer);
      if (res.ok || !RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) return res;
      const backoff = retryAfterMs(res) ?? BASE_BACKOFF_MS * Math.pow(3, attempt - 1);
      const wait = Math.min(backoff, deadline - Date.now());
      if (wait <= 0) return res; // no budget left to retry → hand back the error response
      console.error(`OpenAI ${modelId} status ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${wait}ms`);
      await sleep(wait);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // Our own deadline-abort → out of time, do not retry.
      const aborted = err instanceof Error && err.name === "AbortError";
      const wait = aborted ? 0 : Math.min(BASE_BACKOFF_MS * Math.pow(3, attempt - 1), deadline - Date.now());
      if (aborted || attempt === MAX_ATTEMPTS || wait <= 0) throw err;
      console.error(`OpenAI ${modelId} transport error — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${wait}ms`);
      await sleep(wait);
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`OpenAI ${modelId} timed out after ${timeoutMs}ms`);
}
