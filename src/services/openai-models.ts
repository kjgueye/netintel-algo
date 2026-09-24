import { pricing } from "../config.js";
import type { OpenAiRouterConfig } from "./openai-passthrough.js";
import { GPT4O_VISION } from "./openai-vision.js";

// THE single source of truth for the OpenAI-direct model lineup: model id,
// endpoint path, caps, reasoning flag, and flat price. Consumed by:
//   - each src/routes/openai-*.ts (makeOpenAiRouter(openAiModel("gpt-4o")))
//   - the /v1 OpenAI-compat front door (GET /v1/models catalog + the
//     POST /v1/chat/completions model dispatcher)
// Caps and price are locked together (see OPENAI-ENDPOINTS-HANDOFF.md): never
// raise a cap without re-deriving the price in config.pricing.

export const OPENAI_MODELS: OpenAiRouterConfig[] = [
  { path: "/openai/gpt-5-6-sol",   modelId: "gpt-5.6-sol",   inCapChars: 96000, outCapTokens: 8192, reasoning: true,  price: pricing.openaiGpt56Sol },
  { path: "/openai/gpt-5-5",       modelId: "gpt-5.5",       inCapChars: 96000, outCapTokens: 8192, reasoning: true,  price: pricing.openaiGpt55 },
  { path: "/openai/gpt-5-6-terra", modelId: "gpt-5.6-terra", inCapChars: 96000, outCapTokens: 4096, reasoning: true,  price: pricing.openaiGpt56Terra },
  { path: "/openai/gpt-5-4",       modelId: "gpt-5.4",       inCapChars: 96000, outCapTokens: 4096, reasoning: true,  price: pricing.openaiGpt54 },
  { path: "/openai/gpt-5-2",       modelId: "gpt-5.2",       inCapChars: 96000, outCapTokens: 4096, reasoning: true,  price: pricing.openaiGpt52 },
  { path: "/openai/gpt-5-1",       modelId: "gpt-5.1",       inCapChars: 96000, outCapTokens: 4096, reasoning: true,  price: pricing.openaiGpt51 },
  // The ONLY vision-enabled row: bounded image input (<= 4 https image_url parts,
  // 16,000-token combined budget) — see openai-vision.ts. Text-only requests on
  // this row keep the 48000-char path; the gateway strips `vision` (withoutVision).
  { path: "/openai/gpt-4o",        modelId: "gpt-4o",        inCapChars: 48000, outCapTokens: 2048, reasoning: false, price: pricing.openaiGpt4o, vision: GPT4O_VISION },
  { path: "/openai/gpt-4-1",       modelId: "gpt-4.1",       inCapChars: 48000, outCapTokens: 2048, reasoning: false, price: pricing.openaiGpt41 },
  { path: "/openai/gpt-5-6-luna",  modelId: "gpt-5.6-luna",  inCapChars: 48000, outCapTokens: 2048, reasoning: true,  price: pricing.openaiGpt56Luna },
  { path: "/openai/gpt-5-4-mini",  modelId: "gpt-5.4-mini",  inCapChars: 36000, outCapTokens: 2048, reasoning: true,  price: pricing.openaiGpt54Mini },
  { path: "/openai/gpt-4-1-mini",  modelId: "gpt-4.1-mini",  inCapChars: 12000, outCapTokens: 1024, reasoning: false, price: pricing.openaiGpt41Mini },
  { path: "/openai/gpt-5-4-nano",  modelId: "gpt-5.4-nano",  inCapChars: 24000, outCapTokens: 1024, reasoning: true,  price: pricing.openaiGpt54Nano },
  { path: "/openai/gpt-4o-mini",   modelId: "gpt-4o-mini",   inCapChars: 40000, outCapTokens: 1024, reasoning: false, price: pricing.openaiGpt4oMini },
  { path: "/openai/gpt-4-1-nano",  modelId: "gpt-4.1-nano",  inCapChars: 24000, outCapTokens: 1024, reasoning: false, price: pricing.openaiGpt41Nano },
  { path: "/openai/gpt-5-nano",    modelId: "gpt-5-nano",    inCapChars: 24000, outCapTokens: 1024, reasoning: true,  price: pricing.openaiGpt5Nano },
];

/** Lookup by exact model id (e.g. "gpt-4o"). */
export function openAiModelById(modelId: string): OpenAiRouterConfig | undefined {
  return OPENAI_MODELS.find((m) => m.modelId === modelId);
}

/** Lookup by endpoint path — used by the per-model route files. Throws on a
 * typo so a bad refactor fails at boot, not silently at request time. */
export function openAiModel(path: string): OpenAiRouterConfig {
  const m = OPENAI_MODELS.find((x) => x.path === path);
  if (!m) throw new Error(`openAiModel: unknown path ${path}`);
  return m;
}

/** Numeric USD value of a "$0.10"-style flat price. */
export function priceUsd(price: string): number {
  return Number(price.replace(/[$,]/g, ""));
}

// ---------------------------------------------------------------------------
// Gateway eligibility — the ONE price filter behind POST /v1/chat/completions.
//
// x402 settles a single flat price per route, so the gateway can only serve
// models whose dedicated flat price is <= its own; pricier models get a 400
// pointing at their dedicated endpoint. The dispatcher (routes/v1-openai-compat.ts)
// AND the gateway route descriptions in src/index.ts must agree on this list:
// the descriptions used to hand-name premium models the dispatcher rejects
// (18 logged 400s on 2026-09-07 from callers following that text). Both now
// render from here.
// ---------------------------------------------------------------------------

export const GATEWAY_PRICE = pricing.v1ChatCompletions;

/** Models the gateway dispatches (dedicated flat price <= gateway price). */
export const GATEWAY_MODELS: OpenAiRouterConfig[] = OPENAI_MODELS.filter(
  (m) => priceUsd(m.price) <= priceUsd(GATEWAY_PRICE),
);

/** Models the gateway redirects to their dedicated endpoint. */
export const PREMIUM_MODELS: OpenAiRouterConfig[] = OPENAI_MODELS.filter(
  (m) => priceUsd(m.price) > priceUsd(GATEWAY_PRICE),
);

/**
 * Comma-separated gateway model ids for prose: the two gateway route
 * descriptions in src/index.ts and the dispatcher's 400 messages. The static
 * readers of src/index.ts (tests/route-description-length.test.ts and
 * scripts/sync-ecosystem.ts) resolve this identifier via
 * scripts/lib/description-expr.ts — keep it a plain string export.
 */
export const GATEWAY_MODEL_LIST = GATEWAY_MODELS.map((m) => m.modelId).join(", ");
