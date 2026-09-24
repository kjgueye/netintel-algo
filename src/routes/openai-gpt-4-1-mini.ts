import { makeOpenAiRouter } from "../services/openai-passthrough.js";
import { openAiModel } from "../services/openai-models.js";

// POST /openai/gpt-4-1-mini — pay-per-call x402 passthrough to OpenAI's
// gpt-4.1-mini chat completions. No OpenAI account or key needed by the caller;
// they pay $0.005 in USDC per request. All behavior (caps, GET/HEAD→402,
// 502-on-upstream, llmUsage) lives in the shared factory — see
// src/services/openai-passthrough.ts.
//
// Caps + flat price are locked together: in-cap 12000 chars (~4k tok) + out-cap
// 2048 tok, worst-case OpenAI spend at gpt-4.1-mini's $0.40/$1.60 per-1M rates is
// (4000×0.40 + 1024×1.60)/1e6 ≈ $0.0033, so the flat $0.005 clears ~1.5× at the
// ceiling. gpt-4.1-mini is a gpt-4* chat model → reasoning:false (max_tokens,
// sampling forwarded). Never raise a cap without re-deriving the price
// (config.pricing).
export const openaiGpt41MiniRouter = makeOpenAiRouter(openAiModel("/openai/gpt-4-1-mini"));
