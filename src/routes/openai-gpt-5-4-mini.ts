import { makeOpenAiRouter } from "../services/openai-passthrough.js";
import { openAiModel } from "../services/openai-models.js";

// POST /openai/gpt-5-4-mini — pay-per-call x402 passthrough to OpenAI's
// gpt-5.4-mini chat completions. No OpenAI account or key needed by the caller;
// they pay $0.04 in USDC per request. All behavior (caps, GET/HEAD→402,
// 502-on-upstream, llmUsage) lives in the shared factory — see
// src/services/openai-passthrough.ts.
//
// gpt-5.4-mini is a reasoning-family model → reasoning:true, which switches the
// token param to max_completion_tokens and STOPS forwarding temperature/top_p
// (the model rejects sampling params with a 400).
//
// Caps + flat price are locked together: in-cap 36000 chars (~12k tok) + out-cap
// 2048 tok, worst-case OpenAI spend at gpt-5.4-mini's $0.75/$4.50 per-1M rates is
// (12000×0.75 + 2048×4.50)/1e6 ≈ $0.0182, so the flat $0.04 clears ~2.2× at the
// ceiling. Never raise a cap without re-deriving the price (config.pricing).
export const openaiGpt54MiniRouter = makeOpenAiRouter(openAiModel("/openai/gpt-5-4-mini"));
