// Shared OpenAI-direct embeddings transport for the endpoints built on it:
// /v1/embeddings (raw vectors) and the /semantic/* outcome family
// (/semantic/rank today; dedupe/route planned). Same transport rules as the
// chat passthroughs (openai-passthrough.ts): raw fetch under an AbortController
// deadline that covers headers AND body (a timed-out request is cancelled, never
// leaked); any upstream failure (non-2xx, transport error, our timeout,
// unparseable body) collapses to `{ upstreamError: true }` — callers map that to
// a 502 UNCHARGED response; only a 2xx settles.

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

/** Optional OpenAI params a caller may forward (validated by the route). */
export interface EmbeddingsExtras {
  dimensions?: number;
  encoding_format?: string;
}

export type EmbeddingsResult =
  | { upstreamError: true }
  | { upstreamError?: undefined; data: any };

/**
 * POST the embeddings request upstream and parse the response. `data` on
 * success is the full OpenAI body ({object, data[], model, usage}); every
 * failure mode returns { upstreamError: true } (already logged).
 */
export async function fetchEmbeddings(
  model: string,
  input: string | string[],
  timeoutMs: number,
  extra: EmbeddingsExtras = {},
): Promise<EmbeddingsResult> {
  // One AbortController deadline covers the headers AND the body read, and is
  // disarmed only once the body is in hand (or the call failed). The previous
  // Promise.race carried no signal — a timed-out request kept running upstream —
  // and cleared its timer as soon as the headers arrived, so a body that stalled
  // afterwards outlived timeoutMs.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: globalThis.Response;
    try {
      response = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`,
        },
        body: JSON.stringify({ model, input, ...extra }),
        signal: controller.signal,
      });
    } catch (err) {
      console.error(`OpenAI ${model} embeddings request error:`, err);
      return { upstreamError: true };
    }

    if (!response.ok) {
      console.error(`OpenAI ${model} embeddings upstream status ${response.status}`);
      return { upstreamError: true };
    }

    try {
      return { data: await response.json() };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      console.error(`OpenAI ${model} embeddings ${aborted ? "body timed out" : "unparseable body"}:`, err);
      return { upstreamError: true };
    }
  } finally {
    clearTimeout(timer);
  }
}
