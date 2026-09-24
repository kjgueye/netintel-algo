import { makeOpenAiRouter } from "../services/openai-passthrough.js";
import { openAiModel } from "../services/openai-models.js";

// POST /openai/gpt-4-1 — pay-per-call x402 passthrough to OpenAI's gpt-4.1 chat
// completions. No OpenAI account or key needed by the caller; they pay $0.09 in
// USDC per request. All behavior (caps, GET/HEAD→402, 502-on-upstream, llmUsage)
// lives in the shared factory — see src/services/openai-passthrough.ts.
//
// Caps + flat price are locked together: in-cap 48000 chars (~16k tok) + out-cap
// 2048 tok, worst-case OpenAI spend at gpt-4.1's $2.00/$8.00 per-1M rates is
// (16000×2.00 + 2048×8.00)/1e6 ≈ $0.049, so the flat $0.09 clears ~1.6× at the
// ceiling. gpt-4.1 is a gpt-4* chat model → reasoning:false (max_tokens, sampling
// forwarded). Never raise a cap without re-deriving the price (config.pricing).
export const openaiGpt41Router = makeOpenAiRouter(openAiModel("/openai/gpt-4-1"));
