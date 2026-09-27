// LLM cost calculator — the single source of truth for per-call Anthropic spend.
//
// Revenue (price_usdc) is captured by the paid-call logger; this module supplies
// the COST side so gross margin per endpoint/wallet can be computed. Every
// LLM-backed handler stashes its token usage on `res.locals.llmUsage`, and the
// logger turns it into a `cost_usdc` value via computeLlmCost() at res.finish.
//
// To onboard a new model, add ONE row to MODEL_RATES below. An unpriced model
// yields `undefined` (not 0) so a silent model swap surfaces as tokens-present /
// cost-null in the data rather than a misleading $0.

/** Per-million-token rates in USD, mirroring Anthropic's published pricing. */
export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Keyed by the exact model id passed to anthropic.messages.create. */
export const MODEL_RATES: Record<string, ModelRate> = {
  // Claude Haiku 4.5 — $1.00 / MTok input, $5.00 / MTok output.
  "claude-haiku-4-5-20251001": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  // Claude Sonnet 4.6 — $3.00 / MTok input, $15.00 / MTok output. Backs the
  // /messages endpoint; this is the COST side, revenue is the dynamic quote.
  "claude-sonnet-4-6": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  // OpenAI-direct chat passthrough models (/openai/<model>). Keyed by the exact
  // model id sent to the OpenAI API and stamped onto res.locals.llmUsage. Rates
  // per the OpenAI dashboard — verify before go-live; each endpoint's flat price
  // is derived from these (see OPENAI-ENDPOINTS-HANDOFF.md).
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10.0 },
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "gpt-4.1": { inputPerMTok: 2.0, outputPerMTok: 8.0 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  "gpt-4.1-nano": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  // gpt-5.5 — reasoning-family model, uses max_completion_tokens and rejects
  // sampling params. Rates per the OpenAI dashboard; the $0.65 flat price on
  // /openai/gpt-5-5 is derived from these (see OPENAI-ENDPOINTS-HANDOFF.md).
  "gpt-5.5": { inputPerMTok: 5.0, outputPerMTok: 30.0 },
  // gpt-5.4 — reasoning-family model, uses max_completion_tokens and rejects
  // sampling params. Rates per the OpenAI dashboard; the $0.25 flat price on
  // /openai/gpt-5-4 is derived from these (see OPENAI-ENDPOINTS-HANDOFF.md).
  "gpt-5.4": { inputPerMTok: 2.5, outputPerMTok: 15.0 },
  // gpt-5.4-mini — reasoning-family model, uses max_completion_tokens and rejects
  // temperature/top_p. Flat $0.04 for POST /openai/gpt-5-4-mini is derived from
  // these (see OPENAI-ENDPOINTS-HANDOFF.md).
  "gpt-5.4-mini": { inputPerMTok: 0.75, outputPerMTok: 4.5 },
  // gpt-5.4-nano — reasoning-family model, uses max_completion_tokens and rejects
  // temperature/top_p. Flat $0.01 for POST /openai/gpt-5-4-nano is derived from
  // these (see OPENAI-ENDPOINTS-HANDOFF.md).
  "gpt-5.4-nano": { inputPerMTok: 0.2, outputPerMTok: 1.25 },
  // gpt-5.6-sol — reasoning-family model, uses max_completion_tokens and rejects
  // sampling params. Rates per the OpenAI dashboard; the $0.65 flat price on
  // /openai/gpt-5-6-sol is derived from these (see OPENAI-ENDPOINTS-HANDOFF.md).
  "gpt-5.6-sol": { inputPerMTok: 5.0, outputPerMTok: 30.0 },
  // gpt-5.6-terra — reasoning-family model, uses max_completion_tokens and rejects
  // sampling params. Rates per the OpenAI dashboard; the $0.25 flat price on
  // /openai/gpt-5-6-terra is derived from these (see OPENAI-ENDPOINTS-HANDOFF.md).
  "gpt-5.6-terra": { inputPerMTok: 2.5, outputPerMTok: 15.0 },
  // gpt-5.6-luna — reasoning-family model, uses max_completion_tokens and rejects
  // sampling params. Rates per the OpenAI dashboard; the $0.06 flat price on
  // /openai/gpt-5-6-luna is derived from these (see OPENAI-ENDPOINTS-HANDOFF.md).
  "gpt-5.6-luna": { inputPerMTok: 1.0, outputPerMTok: 6.0 },
  // gpt-5.2 — reasoning-family model, uses max_completion_tokens and rejects
  // sampling params. Rates per the OpenAI dashboard; the $0.20 flat price on
  // /openai/gpt-5-2 is derived from these (see OPENAI-ENDPOINTS-HANDOFF.md).
  "gpt-5.2": { inputPerMTok: 1.75, outputPerMTok: 14.0 },
  // gpt-5.1 — reasoning-family model, uses max_completion_tokens and rejects
  // sampling params. Rates per the OpenAI dashboard; the $0.15 flat price on
  // /openai/gpt-5-1 is derived from these (see OPENAI-ENDPOINTS-HANDOFF.md).
  "gpt-5.1": { inputPerMTok: 1.25, outputPerMTok: 10.0 },
  // gpt-5-nano — reasoning-family model, uses max_completion_tokens and rejects
  // sampling params. Rates per the OpenAI dashboard; the $0.01 flat price on
  // /openai/gpt-5-nano is derived from these (see OPENAI-ENDPOINTS-HANDOFF.md).
  "gpt-5-nano": { inputPerMTok: 0.05, outputPerMTok: 0.4 },
  // OpenAI embeddings (/v1/embeddings). Embeddings have NO output tokens — the
  // handler stamps outputTokens: 0, so outputPerMTok never contributes. Rates
  // verified on the OpenAI pricing page 2026-07-18; the flat $0.005 price on
  // /v1/embeddings is derived from these + the route's caps.
  "text-embedding-3-small": { inputPerMTok: 0.02, outputPerMTok: 0 },
  "text-embedding-3-large": { inputPerMTok: 0.13, outputPerMTok: 0 },
  // gpt-image-1 (/ai-image/generate) — image OUTPUT is billed as tokens
  // ($40/MTok); input here is the text prompt ($5/MTok — v1 does generation
  // only, no image inputs). Before this row the endpoint's cost_usdc captured
  // only the Claude metadata call (~$0.002), overstating margin ~99% vs the
  // real ~65-70%.
  "gpt-image-1": { inputPerMTok: 5.0, outputPerMTok: 40.0 },
};

/** Per-call token usage recorded by a handler on res.locals.llmUsage. */
export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Fixed upstream cost in USD for non-token-metered providers (Exa). When
   *  present it IS the cost — MODEL_RATES is not consulted. */
  costUsd?: number;
}

/**
 * Cost of one LLM call in USDC, as a 6-decimal string (e.g. "0.001715") to match
 * the price_usdc formatting — so margin is a clean numeric subtraction in SQL.
 * Returns undefined when the model has no rate row (unpriced → cost unknown).
 */
export function computeLlmCost(usage: LlmUsage): string | undefined {
  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) {
    return usage.costUsd.toFixed(6);
  }
  const rate = MODEL_RATES[usage.model];
  if (!rate) return undefined;
  const usd =
    (usage.inputTokens / 1_000_000) * rate.inputPerMTok +
    (usage.outputTokens / 1_000_000) * rate.outputPerMTok;
  return usd.toFixed(6);
}
