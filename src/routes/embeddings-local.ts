import { Router, type Request, type Response } from "express";
import { pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { pickField } from "../utils/field-aliases.js";
import { signableAccepts } from "../accepts.js";
import {
  embedTexts,
  EMBED_MODEL_ID,
  EMBED_SOURCE_MODEL,
  EMBED_DIM,
} from "../services/local-embeddings.js";

// POST /embeddings — self-hosted multilingual text embeddings (Xenova
// multilingual-e5-small, 384-dim), served in-process via ONNX so there is no
// per-token upstream to meter. This is a SIBLING of the OpenAI-passthrough
// /v1/embeddings (src/routes/v1-embeddings.ts) on a different path/price — same
// 402-challenge stub shape and 400/502-uncharged billing discipline, but the
// cost floor here is fixed RAM, not per-call OpenAI spend, so it can go cheaper
// ($0.001) and bigger (256-item batches) than the resell endpoint can afford.
//
// ⚠ netintel-embed-small is a PERMANENT PUBLIC CONTRACT. Callers store vectors
// against it; vectors from a different model are not comparable. NEVER swap the
// underlying model (Xenova/multilingual-e5-small) under this id — that would
// silently invalidate every stored vector with no error. Ship a better model
// under a NEW id (e.g. netintel-embed-base) instead. See src/services/local-embeddings.ts.

export const embeddingsLocalRouter = Router();

const MAX_ITEMS = 256;
/** Batch-sum char cap across all input strings — bounds latency/RAM, not cost
 * (self-hosted inference has no per-token upstream bill). */
const MAX_TOTAL_CHARS = 200_000;

const INPUT_KEYS = ["input", "text", "inputs"];
const INPUT_TYPE_KEYS = ["input_type", "task", "type"];

const EXAMPLE_BODY = '{"input":"the quick brown fox","input_type":"passage"}';

interface Finding {
  rule: string;
  detail: string;
}

/** Normalize `input` to a validated array of non-empty strings. */
function validateInput(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    throw new ValidationError(
      `input is required — a string or an array of strings, e.g. ${EXAMPLE_BODY}`
    );
  }
  if (typeof raw === "string") {
    if (raw.trim() === "") {
      throw new ValidationError(`input must not be empty — e.g. ${EXAMPLE_BODY}`);
    }
    if (raw.length > MAX_TOTAL_CHARS) {
      throw new ValidationError(
        `Input too large: ${raw.length} chars (max ${MAX_TOTAL_CHARS}). Split the batch.`
      );
    }
    return [raw];
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new ValidationError("input array must contain at least one string");
    }
    if (raw.length > MAX_ITEMS) {
      throw new ValidationError(
        `Too many input items: ${raw.length} (max ${MAX_ITEMS}). Split the batch.`
      );
    }
    let chars = 0;
    for (const item of raw) {
      if (typeof item !== "string") {
        throw new ValidationError("Every input array element must be a string");
      }
      chars += item.length;
    }
    if (chars > MAX_TOTAL_CHARS) {
      throw new ValidationError(
        `Input too large: ${chars} chars total across ${raw.length} items (max ${MAX_TOTAL_CHARS}). Split the batch.`
      );
    }
    return raw as string[];
  }
  throw new ValidationError(
    `input is required — a string or an array of strings, e.g. ${EXAMPLE_BODY}`
  );
}

/** e5 requires a "query: "/"passage: " prefix per item; default is passage
 * (the index-time common case). Unknown values fall back to passage with a note. */
function resolveInputType(raw: unknown, findings: Finding[]): "query" | "passage" {
  if (raw === undefined || raw === null) return "passage";
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "query") return "query";
  if (s === "passage") return "passage";
  findings.push({
    rule: "input_type_unknown",
    detail: `input_type ${JSON.stringify(raw)} is not recognized — expected "query" or "passage"; defaulted to "passage"`,
  });
  return "passage";
}

function resolveEncodingFormat(raw: unknown): "float" | "base64" {
  if (raw === undefined || raw === null) return "float";
  if (raw === "float" || raw === "base64") return raw;
  throw new ValidationError('encoding_format must be "float" or "base64"');
}

/** `model` is accepted-and-ignored (this endpoint always serves netintel-embed-small) —
 * note it in findings when the caller asked for something else. */
function noteIgnoredModel(raw: unknown, findings: Finding[]): void {
  if (raw !== undefined && raw !== null && raw !== EMBED_MODEL_ID) {
    findings.push({
      rule: "model_ignored",
      detail: `This endpoint always serves ${EMBED_MODEL_ID} (${EMBED_SOURCE_MODEL}) at ${EMBED_DIM} dimensions — model ${JSON.stringify(raw)} was ignored. For OpenAI models, use /v1/embeddings.`,
    });
  }
}

/** Little-endian float32 bytes, base64-encoded — matches OpenAI's base64 embedding layout. */
function toBase64(vector: number[]): string {
  const floats = new Float32Array(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString("base64");
}

/** Bounds a hung model load / pathological batch — rejects after timeouts.embeddingsLocal. */
function embedWithTimeout(prefixed: string[]): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeouts.embeddingsLocal);
    embedTexts(prefixed).then(
      (vectors) => {
        clearTimeout(timer);
        resolve(vectors);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// GET/HEAD on the paid path → 402 challenge so the Bazaar health prober sees
// payment requirements instead of a 404 (same pattern as v1-embeddings.ts).
const embeddingsLocalChallenge = {
  x402Version: 2,
  accepts: signableAccepts(pricing.embeddingsLocal),
  error: "Payment required",
};

embeddingsLocalRouter.get("/embeddings", (_req: Request, res: Response) => {
  res.status(402).json(embeddingsLocalChallenge);
});

embeddingsLocalRouter.head("/embeddings", (_req: Request, res: Response) => {
  res.status(402).end();
});

embeddingsLocalRouter.post("/embeddings", async (req: Request, res: Response) => {
  try {
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    const findings: Finding[] = [];
    noteIgnoredModel(body.model, findings);

    const inputs = validateInput(pickField(body, INPUT_KEYS));
    const inputType = resolveInputType(pickField(body, INPUT_TYPE_KEYS), findings);
    const encodingFormat = resolveEncodingFormat(body.encoding_format);

    // The prefix is internal to the e5 contract — never counted against the
    // caller's char cap/token estimate and never echoed back.
    const prefix = inputType === "query" ? "query: " : "passage: ";
    const prefixed = inputs.map((text) => prefix + text);

    let vectors: number[][];
    try {
      vectors = await embedWithTimeout(prefixed);
    } catch (err) {
      console.error("embeddings-local inference error:", err);
      res.status(502).json({
        error: "Embedding model unavailable — try again shortly. You were not charged.",
      });
      return;
    }

    const data = vectors.map((embedding, index) => ({
      object: "embedding" as const,
      index,
      embedding: encodingFormat === "base64" ? toBase64(embedding) : embedding,
    }));

    const totalChars = inputs.reduce((sum, text) => sum + text.length, 0);
    const promptTokens = Math.ceil(totalChars / 4);

    // Cost is ~0 (self-hosted) — recorded so the paid-call logger's cost table
    // sees a known-but-unpriced model rather than crashing on a missing entry.
    res.locals.llmUsage = { model: EMBED_MODEL_ID, inputTokens: promptTokens, outputTokens: 0 };

    res.json({
      object: "list",
      data,
      model: EMBED_MODEL_ID,
      provider: "netintel",
      source_model: EMBED_SOURCE_MODEL,
      dimensions: EMBED_DIM,
      input_type: inputType,
      normalized: true,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("embeddings-local handler error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
