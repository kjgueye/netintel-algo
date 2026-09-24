import { Router, type Request, type Response } from "express";
import { pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { signableAccepts } from "../accepts.js";
import { fetchEmbeddings } from "../services/openai-embeddings.js";

// POST /v1/embeddings (+ /api/v1/embeddings alias) — OpenAI-compatible text
// embeddings served OpenAI-direct, pay-per-call via x402. Same transport rules
// as the /openai/<model> chat passthroughs (src/services/openai-passthrough.ts):
// no translation layer (request + response are already OpenAI-shaped), fetch +
// timeout race, upstream failure → 502 UNCHARGED, only a 2xx settles.
//
// Embeddings are the high-frequency RAG primitive (agents embed a query on
// nearly every retrieval task), and unlike chat there are NO output tokens —
// cost is input-only. The flat price is derived from the caps below so the
// worst case always clears margin.
//
// ⚠ Tokenization is SCRIPT-dependent, so the caps must assume the worst case
// (~1 token/char for CJK, worse for emoji), NOT the English ~3–4 chars/token:
//   -small $0.02/1M @ 64000 chars: CJK ~64k tok → $0.00128; emoji ~128k tok →
//     $0.00256 — safe at $0.005 even adversarially.
//   -large $0.13/1M @ 24000 chars: CJK ~24k tok → $0.00312 (1.6×); typical
//     English ~8k tok → ~$0.001 (5×). At 64k chars of CJK it would cost
//     $0.0083 — a LOSS at $0.005 — hence the smaller cap for -large.
// (Astral/emoji code points count as TWO UTF-16 units in .length, so the char
// caps already weigh them ~2 tokens each — no separate estimator needed here.)
// Rates verified on the OpenAI pricing page 2026-07-18. NEVER raise a cap
// without re-deriving pricing.v1Embeddings against 1-token-per-char input.

// ⚠ DEFAULT_MODEL is a PERMANENT PUBLIC CONTRACT. Callers that omit `model`
// store vectors against this default; silently changing it (or remapping a
// supported id to a different underlying model) would invalidate every vector a
// customer already stored — their similarity search would return garbage with
// no error. If OpenAI deprecates the id, keep serving it / error loudly, never
// substitute underneath a caller. The response always re-stamps the resolved id
// (below) so a caller who omitted `model` learns exactly what produced its vector.
const DEFAULT_MODEL = "text-embedding-3-small";
const SUPPORTED_MODELS = [DEFAULT_MODEL, "text-embedding-3-large"] as const;

/** Native output dimensions per model (callers can request fewer via `dimensions`). */
export const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

/** Array-length cap for batch input. */
const MAX_ITEMS = 128;
/** TOTAL character cap summed across every input string — the batch sum, not
 * per-item, is what bounds the flat-price worst case. Per-model because
 * -large's token rate is 6.5× -small's (see the pricing derivation above). */
const MAX_TOTAL_CHARS: Record<string, number> = {
  "text-embedding-3-small": 64000,
  "text-embedding-3-large": 24000,
};

export const v1EmbeddingsRouter = Router();

/** Normalize `input` to the validated OpenAI shape (string or string[]).
 * `maxTotalChars` is the resolved model's batch-sum cap. */
function validateInput(input: unknown, model: string, maxTotalChars: number): string | string[] {
  if (typeof input === "string") {
    if (input.length === 0) {
      throw new ValidationError('input must not be empty — e.g. {"input":"the quick brown fox"}');
    }
    if (input.length > maxTotalChars) {
      throw new ValidationError(
        `Input too large: ${input.length} chars (max ${maxTotalChars} for ${model}). Split the batch.`,
      );
    }
    return input;
  }
  if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new ValidationError("input array must contain at least one string");
    }
    if (input.length > MAX_ITEMS) {
      throw new ValidationError(
        `Too many input items: ${input.length} (max ${MAX_ITEMS}). Split the batch.`,
      );
    }
    let chars = 0;
    for (const item of input) {
      if (typeof item !== "string") {
        throw new ValidationError("Every input array element must be a string");
      }
      chars += item.length;
    }
    if (chars > maxTotalChars) {
      throw new ValidationError(
        `Input too large: ${chars} chars total across ${input.length} items (max ${maxTotalChars} for ${model}). Split the batch.`,
      );
    }
    return input as string[];
  }
  throw new ValidationError(
    'input is required — a string or an array of strings, e.g. {"input":"the quick brown fox"}',
  );
}

/** Actual output vector size: measured from the first returned embedding
 * (float array, or base64 = 4 bytes/float), falling back to the requested
 * `dimensions` param, then the model's native size. */
function vectorDimensions(data: any, requested: number | undefined, model: string): number {
  const first = data?.data?.[0]?.embedding;
  if (Array.isArray(first)) return first.length;
  if (typeof first === "string") return Math.floor(Buffer.from(first, "base64").length / 4);
  return requested ?? MODEL_DIMENSIONS[model];
}

const embeddingsHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body ?? {};
    if (typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("Request body must be a JSON object");
    }

    // Model first — the input cap depends on it.
    const model = body.model === undefined || body.model === null ? DEFAULT_MODEL : body.model;
    if (!SUPPORTED_MODELS.includes(model)) {
      res.status(400).json({
        error: {
          message: `Unknown model ${JSON.stringify(model)}. Supported: ${SUPPORTED_MODELS.join(", ")} (default ${DEFAULT_MODEL}).`,
          type: "invalid_request_error",
          param: "model",
        },
      });
      return;
    }

    let input: string | string[];
    try {
      input = validateInput(body.input, model, MAX_TOTAL_CHARS[model]);
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({
          error: { message: err.message, type: "invalid_request_error", param: "input" },
        });
        return;
      }
      throw err;
    }

    // Optional OpenAI params — forwarded only when present AND valid; nothing
    // else in the body (user, metadata, …) is passed upstream.
    const extra: { dimensions?: number; encoding_format?: string } = {};
    if (body.dimensions !== undefined) {
      if (!Number.isInteger(body.dimensions) || body.dimensions <= 0) {
        throw new ValidationError("dimensions must be a positive integer");
      }
      extra.dimensions = body.dimensions;
    }
    if (body.encoding_format !== undefined) {
      if (body.encoding_format !== "float" && body.encoding_format !== "base64") {
        throw new ValidationError('encoding_format must be "float" or "base64"');
      }
      extra.encoding_format = body.encoding_format;
    }

    // Transport failure, our timeout, upstream non-2xx, or an unparseable body
    // → 502 so payment does NOT settle.
    const result = await fetchEmbeddings(model, input, timeouts.embeddings, extra);
    if (result.upstreamError) {
      res.status(502).json({ error: { message: "Upstream model error", type: "upstream_error" } });
      return;
    }
    const data = result.data;

    // Record usage for per-call cost/margin logging (read at res.finish).
    // Embeddings have NO output tokens — cost is input-only.
    res.locals.llmUsage = {
      model,
      inputTokens: data?.usage?.prompt_tokens ?? 0,
      outputTokens: 0,
    };

    // Return the OpenAI embeddings body as-is (already the right shape), plus
    // the model-identity/compatibility fields an agent needs to pin: re-stamped
    // model id, provider, measured vector dimensions, and normalized (OpenAI
    // embeddings are unit-length). Extra top-level keys are ignored by SDKs.
    res.json({
      ...data,
      model,
      provider: "openai",
      dimensions: vectorDimensions(data, extra.dimensions, model),
      normalized: true,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: { message: err.message, type: "invalid_request_error" } });
      return;
    }
    console.error("v1-embeddings handler error:", err);
    res.status(500).json({ error: { message: "Internal server error", type: "server_error" } });
  }
};

// GET/HEAD on the paid paths → 402 challenge so the Bazaar health prober sees
// payment requirements instead of a 404 (same pattern as the /v1 chat gateway).
const embeddingsChallenge = {
  x402Version: 2,
  accepts: signableAccepts(pricing.v1Embeddings),
  error: "Payment required",
};

// Both SDK base-URL dialects: host/v1/... and host/api/v1/... — the miss-log
// showed probes on each (same as /v1/chat/completions).
for (const path of ["/v1/embeddings", "/api/v1/embeddings"]) {
  v1EmbeddingsRouter.get(path, (_req: Request, res: Response) => {
    res.status(402).json(embeddingsChallenge);
  });
  v1EmbeddingsRouter.head(path, (_req: Request, res: Response) => {
    res.status(402).end();
  });
  v1EmbeddingsRouter.post(path, embeddingsHandler);
}
