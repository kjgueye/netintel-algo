import { makeOpenAiRouter } from "../services/openai-passthrough.js";
import { openAiModel } from "../services/openai-models.js";

// POST /openai/gpt-4-1-nano — pay-per-call x402 passthrough to OpenAI's
// gpt-4.1-nano chat completions. No OpenAI account or key needed by the caller;
// they pay $0.005 in USDC per request. All behavior (caps, GET/HEAD→402,
// 502-on-upstream, llmUsage) lives in the shared factory — see
// src/services/openai-passthrough.ts.
//
// Caps + flat price are locked together: in-cap 24000 chars (~8k tok) + out-cap
// 1024 tok, worst-case OpenAI spend at gpt-4.1-nano's $0.10/$0.40 per-1M rates is
// (8000×0.10 + 1024×0.40)/1e6 ≈ $0.0012, so the flat $0.005 clears ~4× at the
// ceiling. gpt-4.1-nano is a gpt-4* chat model → reasoning:false (max_tokens,
// sampling forwarded). Never raise a cap without re-deriving the price
// (config.pricing).
export const openaiGpt41NanoRouter = makeOpenAiRouter(openAiModel("/openai/gpt-4-1-nano"));
