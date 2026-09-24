import { makeOpenAiRouter } from "../services/openai-passthrough.js";
import { openAiModel } from "../services/openai-models.js";

// POST /openai/gpt-5-6-terra — pay-per-call x402 passthrough to OpenAI's
// gpt-5.6-terra chat completions. No OpenAI account or key needed by the caller;
// they pay $0.25 in USDC per request. All behavior (caps, GET/HEAD→402,
// 502-on-upstream, llmUsage) lives in the shared factory — see
// src/services/openai-passthrough.ts.
//
// gpt-5.6-terra is a reasoning-family model → reasoning:true, which switches the
// token param to max_completion_tokens and STOPS forwarding temperature/top_p
// (the model rejects sampling params with a 400).
//
// Caps + flat price are locked together: in-cap 96000 chars (~32k tok) + out-cap
// 4096 tok, worst-case OpenAI spend at gpt-5.6-terra's $2.50/$15.00 per-1M rates is
// (32000×2.50 + 4096×15.00)/1e6 ≈ $0.142, so the flat $0.25 clears ~1.6× at the
// ceiling. Never raise a cap without re-deriving the price (config.pricing).
export const openaiGpt56TerraRouter = makeOpenAiRouter(openAiModel("/openai/gpt-5-6-terra"));
