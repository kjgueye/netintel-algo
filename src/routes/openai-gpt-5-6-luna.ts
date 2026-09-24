import { makeOpenAiRouter } from "../services/openai-passthrough.js";
import { openAiModel } from "../services/openai-models.js";

// POST /openai/gpt-5-6-luna — pay-per-call x402 passthrough to OpenAI's gpt-5.6-luna
// chat completions. No OpenAI account or key needed by the caller; they pay $0.06
// in USDC per request. All behavior (caps, GET/HEAD→402, 502-on-upstream,
// llmUsage) lives in the shared factory — see src/services/openai-passthrough.ts.
//
// gpt-5.6-luna is a reasoning-family model → reasoning:true, which switches the
// token param to max_completion_tokens and STOPS forwarding temperature/top_p
// (the model rejects sampling params with a 400).
//
// Caps + flat price are locked together: in-cap 48000 chars (~16k tok) + out-cap
// 2048 tok, worst-case OpenAI spend at gpt-5.6-luna's $1.00/$6.00 per-1M rates is
// (16000×1.00 + 2048×6.00)/1e6 ≈ $0.028, so the flat $0.06 clears ~2× at the
// ceiling. Never raise a cap without re-deriving the price (config.pricing).
export const openaiGpt56LunaRouter = makeOpenAiRouter(openAiModel("/openai/gpt-5-6-luna"));
