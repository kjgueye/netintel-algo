import { makeOpenAiRouter } from "../services/openai-passthrough.js";
import { openAiModel } from "../services/openai-models.js";

// POST /openai/gpt-4o — pay-per-call x402 passthrough to OpenAI's gpt-4o chat
// completions. No OpenAI account or key needed by the caller; they pay $0.10 in
// USDC per request. All behavior (caps, GET/HEAD→402, 502-on-upstream, llmUsage)
// lives in the shared factory — see src/services/openai-passthrough.ts.
//
// Caps + flat price are locked together: in-cap 48000 chars (~16k tok) + out-cap
// 2048 tok, worst-case OpenAI spend at gpt-4o's $2.50/$10.00 per-1M rates is
// (16000×2.50 + 2048×10.00)/1e6 ≈ $0.061, so the flat $0.10 clears ~1.6× at the
// ceiling. Never raise a cap without re-deriving the price (config.pricing).
export const openaiGpt4oRouter = makeOpenAiRouter(openAiModel("/openai/gpt-4o"));
