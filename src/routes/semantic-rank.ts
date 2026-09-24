import { Router, type Request, type Response } from "express";
import { pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { signableAccepts } from "../accepts.js";
import { fetchEmbeddings } from "../services/openai-embeddings.js";

// POST /semantic/rank — semantic similarity ranking, the first of the
// /semantic/* outcome family (rank → dedupe → route). The caller sends a query
// plus candidate texts and gets the candidates back ranked by semantic
// similarity — it never touches a vector, never computes cosine, never manages
// an embedding model. Stateless: candidates arrive on every call, nothing is
// stored; what the endpoint offloads is embedding generation, similarity math,
// scoring, sorting, and result formatting.
//
// This is embedding-cosine ranking, NOT a cross-encoder reranker — the response
// says so explicitly via method: "embedding_similarity", and the word "rerank"
// must never appear in any user-visible string (/semantic/rerank is reserved
// for a future true-reranker tier).
//
// Transport is one batched OpenAI embeddings call — [query, ...candidates] —
// via the shared fetchEmbeddings service (same rules as /v1/embeddings:
// upstream failure → 502 UNCHARGED, only a 2xx settles). OpenAI vectors are
// unit-normalized, so cosine similarity is the plain dot product. If another
// provider is ever added, normalize before dotting.
//
// ⚠ Caps assume the worst-case ~1 token/char (CJK; astral/emoji code points
// count as TWO UTF-16 units in .length, so they weigh ~2 each — no separate
// estimator needed). Pricing at the flat $0.02 (pricing.semanticRank):
//   -small $0.02/1M @ 64000 chars → worst case $0.00128 (~16×)
//   -large $0.13/1M @ 24000 chars → worst case $0.00312 (~6.4×)
// NEVER raise a cap without re-deriving the price at 1 token/char.

// Same permanent-contract rule as /v1/embeddings: the resolved model id is
// re-stamped in every response, and scores are only comparable across calls
// that used the same model.
const DEFAULT_MODEL = "text-embedding-3-small";
const SUPPORTED_MODELS = [DEFAULT_MODEL, "text-embedding-3-large"] as const;

const MAX_CANDIDATES = 100;
/** TOTAL character cap summed over query + ALL candidates, per model (see the
 * pricing derivation above — -large's token rate is 6.5× -small's). */
const MAX_TOTAL_CHARS: Record<string, number> = {
  "text-embedding-3-small": 64000,
  "text-embedding-3-large": 24000,
};

export const semanticRankRouter = Router();

function badRequest(res: Response, message: string, param?: string): void {
  res.status(400).json({
    error: { message, type: "invalid_request_error", ...(param ? { param } : {}) },
  });
}

/** Dot product of two equal-length vectors, rounded to 4 decimals. */
function dotScore(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return Math.round(sum * 10000) / 10000;
}

const semanticRankHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body ?? {};
    if (typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("Request body must be a JSON object");
    }

    const query = body.query;
    if (typeof query !== "string" || query.length === 0) {
      badRequest(
        res,
        'query is required — a non-empty string, e.g. {"query":"How do I reset my password?","candidates":["…"]}',
        "query",
      );
      return;
    }

    // `documents` is an accepted alias (input-field-leniency house rule);
    // `candidates` is canonical and wins when both are present.
    const candidates = body.candidates ?? body.documents;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      badRequest(
        res,
        'candidates is required — an array of 1 to 100 non-empty strings to rank against the query (alias: "documents")',
        "candidates",
      );
      return;
    }
    if (candidates.length > MAX_CANDIDATES) {
      badRequest(
        res,
        `Too many candidates: ${candidates.length} (max ${MAX_CANDIDATES}). Split the batch.`,
        "candidates",
      );
      return;
    }
    for (let i = 0; i < candidates.length; i++) {
      if (typeof candidates[i] !== "string" || candidates[i].length === 0) {
        badRequest(res, `candidates[${i}] must be a non-empty string`, "candidates");
        return;
      }
    }

    const model = body.model === undefined || body.model === null ? DEFAULT_MODEL : body.model;
    if (!SUPPORTED_MODELS.includes(model)) {
      badRequest(
        res,
        `Unknown model ${JSON.stringify(model)}. Supported: ${SUPPORTED_MODELS.join(", ")} (default ${DEFAULT_MODEL}).`,
        "model",
      );
      return;
    }

    const maxTotalChars = MAX_TOTAL_CHARS[model];
    let totalChars = query.length;
    for (const c of candidates) totalChars += c.length;
    if (totalChars > maxTotalChars) {
      badRequest(
        res,
        `Input too large: ${totalChars} chars (max ${maxTotalChars} for ${model}). Split the batch.`,
      );
      return;
    }

    let topK = candidates.length;
    if (body.top_k !== undefined) {
      if (!Number.isInteger(body.top_k) || body.top_k <= 0) {
        badRequest(res, "top_k must be a positive integer", "top_k");
        return;
      }
      topK = Math.min(body.top_k, candidates.length);
    }

    let minScore: number | undefined;
    if (body.min_score !== undefined) {
      if (typeof body.min_score !== "number" || Number.isNaN(body.min_score) || body.min_score < -1 || body.min_score > 1) {
        badRequest(res, "min_score must be a number between -1 and 1", "min_score");
        return;
      }
      minScore = body.min_score;
    }

    // One upstream call: query is index 0, candidate i is index i+1. Float
    // encoding only — encoding_format/dimensions are not part of this contract.
    const result = await fetchEmbeddings(model, [query, ...candidates], timeouts.semanticRank);
    if (result.upstreamError) {
      res.status(502).json({ error: { message: "Upstream model error", type: "upstream_error" } });
      return;
    }
    const data = result.data;

    // Rebuild vectors by the upstream `index` field. Any hole, extra, or
    // non-array embedding → 502 rather than silently ranking against the wrong
    // vector (an off-by-one here would corrupt every score).
    const expected = candidates.length + 1;
    const items = data?.data;
    if (!Array.isArray(items) || items.length !== expected) {
      console.error(
        `OpenAI ${model} embeddings length mismatch: got ${Array.isArray(items) ? items.length : "none"}, expected ${expected}`,
      );
      res.status(502).json({ error: { message: "Upstream model error", type: "upstream_error" } });
      return;
    }
    const vectors: number[][] = new Array(expected);
    for (let pos = 0; pos < items.length; pos++) {
      const item = items[pos];
      const idx = Number.isInteger(item?.index) ? item.index : pos;
      if (idx < 0 || idx >= expected || !Array.isArray(item?.embedding)) {
        console.error(`OpenAI ${model} embeddings malformed item at position ${pos}`);
        res.status(502).json({ error: { message: "Upstream model error", type: "upstream_error" } });
        return;
      }
      vectors[idx] = item.embedding;
    }
    if (vectors.some((v) => v === undefined)) {
      console.error(`OpenAI ${model} embeddings response has duplicate/missing indexes`);
      res.status(502).json({ error: { message: "Upstream model error", type: "upstream_error" } });
      return;
    }

    const queryVector = vectors[0];
    let results = candidates.map((text: string, i: number) => ({
      index: i,
      score: dotScore(queryVector, vectors[i + 1]),
      text,
    }));
    // Deterministic for identical input (agents retry and diff): sort desc by
    // score, ties by ascending original index; min_score filters BEFORE top_k.
    results.sort((a, b) => b.score - a.score || a.index - b.index);
    if (minScore !== undefined) {
      results = results.filter((r) => r.score >= minScore!);
    }
    results = results.slice(0, topK);

    // Input-only usage, same as /v1/embeddings (read at res.finish for
    // per-call cost/margin logging).
    res.locals.llmUsage = {
      model,
      inputTokens: data?.usage?.prompt_tokens ?? 0,
      outputTokens: 0,
    };

    res.json({
      results,
      method: "embedding_similarity",
      provider: "openai",
      model,
      dimensions: queryVector.length,
      normalized: true,
      usage: { prompt_tokens: data?.usage?.prompt_tokens ?? 0 },
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: { message: err.message, type: "invalid_request_error" } });
      return;
    }
    console.error("semantic-rank handler error:", err);
    res.status(500).json({ error: { message: "Internal server error", type: "server_error" } });
  }
};

// GET/HEAD on the paid path → 402 challenge so the Bazaar health prober sees
// payment requirements instead of a 404 (same pattern as /v1/embeddings).
const semanticRankChallenge = {
  x402Version: 2,
  accepts: signableAccepts(pricing.semanticRank),
  error: "Payment required",
};

semanticRankRouter.get("/semantic/rank", (_req: Request, res: Response) => {
  res.status(402).json(semanticRankChallenge);
});
semanticRankRouter.head("/semantic/rank", (_req: Request, res: Response) => {
  res.status(402).end();
});
semanticRankRouter.post("/semantic/rank", semanticRankHandler);
