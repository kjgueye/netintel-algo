import { makeOpenAiRouter } from "../services/openai-passthrough.js";
import { openAiModel } from "../services/openai-models.js";

// POST /openai/gpt-5-4-nano — pay-per-call x402 passthrough to OpenAI's
// gpt-5.4-nano chat completions. No OpenAI account or key needed by the caller;
// they pay $0.005 in USDC per request. All behavior (caps, GET/HEAD→402,
// 502-on-upstream, llmUsage) lives in the shared factory — see
// src/services/openai-passthrough.ts.
//
// gpt-5.4-nano is a reasoning-family model → reasoning:true, which switches the
// token param to max_completion_tokens and STOPS forwarding temperature/top_p
// (the model rejects sampling params with a 400).
//
// Caps + flat price are locked together: in-cap 24000 chars (~8k tok) + out-cap
// 1024 tok, worst-case OpenAI spend at gpt-5.4-nano's $0.20/$1.25 per-1M rates is
// (8000×0.20 + 1024×1.25)/1e6 ≈ $0.0029, so the flat $0.005 clears ~1.7× at the
// ceiling. Never raise a cap without re-deriving the price (config.pricing).
export const openaiGpt54NanoRouter = makeOpenAiRouter(openAiModel("/openai/gpt-5-4-nano"));
