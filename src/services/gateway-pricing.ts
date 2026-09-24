import { config } from "../config.js";
import { atomicUsdc, paidAccepts, type HTTPRequestContext, type PaymentOption } from "../accepts.js";
import {
  SETTLEMENT_REVERT_RE,
  SETTLEMENT_FAILED_TEXT,
  settlementRevertText,
  formatNeededUsdc,
} from "../mirror-402-body.js";
import { OPENAI_MODELS, GATEWAY_PRICE, priceUsd } from "./openai-models.js";
import { resolveGatewayModel } from "./gateway-model-resolution.js";

// SAME-URL, MODEL-SPECIFIC PRICING for POST /v1/chat/completions.
//
// x402 settles one amount per request, but @x402/core 2.18 resolves a route's
// price PER REQUEST when `accepts[].price` is a function (DynamicPrice), and it
// does so on BOTH paths that matter: the unpaid 402 (which becomes the quote)
// and the paid path (whose requirements the caller's payment must match before
// verification). So the gateway can quote gpt-5.6-luna at $0.06 at the same URL
// where gpt-4o-mini costs $0.005 — no silent subsidy, no downgrade.
//
// Mode is env-gated so the deployed behaviour is unchanged until it is switched
// on, and switching it off is a restart with no code change:
//   off       — today's flat $0.005 gateway (baseline)
//   advice    — flat $0.005, but premium/unknown models get an actionable,
//               machine-readable 400 BEFORE any payment is asked for
//   per-model — the requested model's own configured price is quoted, verified
//               and settled at the gateway URL
export type GatewayRecoveryMode = "off" | "advice" | "per-model";

export function gatewayRecoveryMode(env: NodeJS.ProcessEnv = process.env): GatewayRecoveryMode {
  const raw = (env.GATEWAY_RECOVERY_MODE ?? "off").trim().toLowerCase();
  return raw === "advice" || raw === "per-model" ? raw : "off";
}

/** Cheapest and priciest configured model prices (the honest quote range). */
export const GATEWAY_PRICE_MIN = OPENAI_MODELS.reduce(
  (min, m) => (priceUsd(m.price) < priceUsd(min) ? m.price : min),
  OPENAI_MODELS[0].price,
);
export const GATEWAY_PRICE_MAX = OPENAI_MODELS.reduce(
  (max, m) => (priceUsd(m.price) > priceUsd(max) ? m.price : max),
  OPENAI_MODELS[0].price,
);

/**
 * The price this gateway charges for a given parsed request body.
 *
 * Unknown / missing / non-string models fall back to the flat gateway price:
 * those requests are refused with an uncharged 400 before any upstream work, so
 * the quote never applies — but a price MUST be returned, because the payment
 * middleware builds a 402 challenge for every unpaid request, including
 * malformed ones and bodiless GET/HEAD probes.
 */
export function gatewayPriceForBody(body: unknown): string {
  const resolved = resolveGatewayModel(body);
  return resolved.kind === "ok" ? resolved.model.price : GATEWAY_PRICE;
}

/** DynamicPrice callback: reads the parsed body the express adapter exposes. */
function dynamicGatewayPrice(context: HTTPRequestContext): string {
  const body = context.adapter.getBody?.();
  return gatewayPriceForBody(body);
}

export interface GatewayPaymentOption extends Omit<PaymentOption, "price" | "amount"> {
  price: string | ((context: HTTPRequestContext) => string);
  amount?: string;
  /** Static, machine-readable price facts for discovery when `price` is a function. */
  priceDisplay?: string;
  priceMin?: string;
  priceMax?: string;
  priceModel?: "flat" | "per-model";
}

/**
 * The gateway's `accepts` array.
 *
 * In per-model mode each rail carries a price FUNCTION (the middleware resolves
 * it per request) plus static min/max/display fields, because discovery builders
 * and the paid-call logger read `accepts[0].price` as a string and must not see
 * `[Function]` — nor claim that every model costs $0.005.
 */
export function gatewayAccepts(
  mode: GatewayRecoveryMode = gatewayRecoveryMode(),
): GatewayPaymentOption[] {
  const perModel = mode === "per-model";
  const priceField = perModel ? dynamicGatewayPrice : GATEWAY_PRICE;
  const shared = perModel
    ? {
        priceDisplay: `${GATEWAY_PRICE_MIN}–${GATEWAY_PRICE_MAX} (depends on the model in the body)`,
        priceMin: GATEWAY_PRICE_MIN,
        priceMax: GATEWAY_PRICE_MAX,
        priceModel: "per-model" as const,
      }
    : { priceModel: "flat" as const };

  // One entry per rail, exactly as paidAccepts() declares them (Base first,
  // Solana when configured), with the flat amount replaced by the gateway's
  // price field — a DynamicPrice callback in per-model mode. Never re-declare
  // rails or USDC assets here: accepts.ts is the only rail-facing seam.
  return paidAccepts(perModel ? GATEWAY_PRICE_MIN : GATEWAY_PRICE).map((a) => ({
    ...a,
    price: priceField,
    ...shared,
  }));
}

/**
 * The honest qualifier for a quote that could NOT be computed from a model.
 *
 * Under per-model pricing the price IS the model, so a request that names no
 * model has no exact price. `gatewayPriceForBody` still has to return something
 * — the payment middleware builds a challenge for every unpaid request — and it
 * returns the floor. The floor is a real, payable amount for the cheapest
 * models, but publishing it bare would read as "this endpoint costs $0.005",
 * which is false for 9 of the 15 models. This block says what the number is.
 *
 * Shared with the GET challenge in routes/v1-openai-compat.ts so the two
 * discovery paths cannot drift.
 */
export function perModelQuoteNote() {
  return {
    model: "per-model" as const,
    min: GATEWAY_PRICE_MIN,
    max: GATEWAY_PRICE_MAX,
    quote: "POST the request unpaid; the 402 quotes that model's price",
    catalog: "/v1/models",
  };
}

/** Prose form of the same fact, for an `error` string. */
export function perModelQuoteSentence(): string {
  return (
    `Payment required. This endpoint is priced PER MODEL (${GATEWAY_PRICE_MIN}–${GATEWAY_PRICE_MAX}); ` +
    `the amount in accepts[] is the minimum, which applies to the cheapest models only. ` +
    `POST your real request without payment to get an exact quote for its \`model\`, or GET /v1/models (free) for every price.`
  );
}

/**
 * Atomic USDC amount the caller's payment must carry for this body, or null when
 * the request is not priceable (no resolvable model).
 */
export function expectedAtomicAmount(body: unknown, mode: GatewayRecoveryMode = gatewayRecoveryMode()): string | null {
  if (mode !== "per-model") return atomicUsdc(GATEWAY_PRICE);
  const resolved = resolveGatewayModel(body);
  return resolved.kind === "ok" ? atomicUsdc(resolved.model.price) : null;
}

/**
 * Price of a settled request for the paid-call logger's non-EVM fallback.
 * (EVM rows read the authorized amount straight off the payload; SVM payloads
 * carry only a serialized transaction, so the route's price is the only source —
 * and with per-model pricing that price is a function of the body.)
 */
export function gatewayPriceForRequest(req: { body?: unknown }): string {
  return gatewayPriceForBody(req.body);
}

// ---------------------------------------------------------------------------
// Discovery text. Exported as plain string consts so the STATIC readers of
// src/index.ts (tests/route-description-length.test.ts and
// scripts/sync-ecosystem.ts, via scripts/lib/description-expr.ts) resolve the
// same final text the runtime serves — a description may never advertise a
// model or a price the dispatcher does not honour.
// ---------------------------------------------------------------------------

const MODE_AT_LOAD = gatewayRecoveryMode();

/** Models this gateway will actually serve, as prose. */
export const GATEWAY_ADVERTISED_MODELS =
  MODE_AT_LOAD === "per-model"
    ? OPENAI_MODELS.map((m) => m.modelId).join(", ")
    : OPENAI_MODELS.filter((m) => priceUsd(m.price) <= priceUsd(GATEWAY_PRICE))
        .map((m) => m.modelId)
        .join(", ");

/**
 * The models phrase for a route DESCRIPTION.
 *
 * ⚠ A route description is echoed into `resource.description` inside the
 * paymentPayload the client sends to CDP /verify, and a long one breaks
 * settlement (see tests/route-description-length.test.ts, 450-char cap, and
 * memory x402-paymentpayload-size-limit). Naming all 15 models — which
 * per-model mode makes eligible — pushed this description to 563 chars, over
 * that cap, with no local signal because the guard only ever ran in the
 * flag-off mode. In per-model mode the list is therefore replaced by a pointer
 * to the free catalog; GATEWAY_ADVERTISED_MODELS stays available for callers
 * that want the enumeration.
 */
export const GATEWAY_MODELS_PHRASE =
  MODE_AT_LOAD === "per-model"
    ? // NOT "any model in GET /v1/models" — that catalog also lists Claude
      // (POST /messages) and the embedding models, which this chat dispatcher
      // does not serve at any price.
      "any gpt-* chat model (not Claude/embeddings), each at its own price"
    : GATEWAY_ADVERTISED_MODELS;

/**
 * The "model chosen in the body…" clause INCLUDING its punctuation.
 *
 * Why the punctuation lives here. A route description is published to the
 * external directories and hashed into the MCP description baseline, so ANY
 * textual change — even a colon — shows up as drift that has to be reviewed and
 * re-synced. The deployed text has always read `…in the body (list).`; a
 * mid-release re-template changed it to `…in the body: list.` for no behavioural
 * reason, which would have cost a directory PATCH and a baseline edit to say
 * nothing new. The parenthesised form is therefore kept for the flat gateway,
 * making the description byte-identical to the deployed one, and the colon is
 * used ONLY for per-model mode, where the phrase is a sentence fragment with its
 * own parentheses and would nest badly inside another pair.
 */
export const GATEWAY_BODY_CLAUSE =
  MODE_AT_LOAD === "per-model" ? `: ${GATEWAY_MODELS_PHRASE}` : ` (${GATEWAY_MODELS_PHRASE})`;

/** How this gateway charges, as prose. */
export const GATEWAY_PRICING_SENTENCE =
  MODE_AT_LOAD === "per-model"
    ? `Priced per model, ${GATEWAY_PRICE_MIN}–${GATEWAY_PRICE_MAX} per call in USDC via x402, no API key: POST unpaid and the 402 quotes your model's exact price.`
    : `Flat ${GATEWAY_PRICE} per call in USDC via x402, no OpenAI account or API key.`;

/**
 * Where a model this URL does NOT serve can be bought.
 *
 * The base description carried "Pricier models have dedicated endpoints;" and the
 * first draft of this release dropped it while re-templating the sentence. That
 * clause is the one piece of routing information a caller asking for a premium
 * model actually needs — the omission that produced 18 logged 400s in the first
 * place — so it is restored here, and only where it is TRUE: under per-model
 * pricing the gateway serves those models itself, so saying they need a
 * dedicated endpoint would be false. Empty string in that mode, which also keeps
 * the per-model description inside the 450-char CDP settlement cap.
 */
export const GATEWAY_DEDICATED_SENTENCE =
  MODE_AT_LOAD === "per-model" ? "" : "Pricier models have dedicated endpoints; ";

/**
 * The alias route's price sentence. Identical in meaning to
 * GATEWAY_PRICING_SENTENCE; it keeps the deployed alias wording ("no API key")
 * so the alias description is byte-identical to the deployed one too — see
 * GATEWAY_BODY_CLAUSE for why a cosmetic difference is not free. Both are
 * derived from GATEWAY_PRICE, so neither can drift from config.
 */
export const GATEWAY_PRICING_SENTENCE_ALIAS =
  MODE_AT_LOAD === "per-model"
    ? GATEWAY_PRICING_SENTENCE
    : `Flat ${GATEWAY_PRICE} per call in USDC via x402, no API key.`;

/** A model id that is always valid to name in schema help text. */
export const GATEWAY_MODEL_EXAMPLE = "gpt-4o-mini";

// ---------------------------------------------------------------------------
// Settle-stage failure body.
//
// @x402/express 2.18 answers a SETTLEMENT failure with `{}` unless the route
// supplies this callback: the facilitator's own reason travels only in the
// settlement headers. mirror402Body then synthesizes the generic "transient,
// retry with a fresh payment" text — which is the WRONG advice for the common
// case (a drained payer wallet: the transfer reverted and retrying can never
// help). Supplying the callback puts the accurate explanation in the body while
// keeping settlement failures worded distinctly from verification failures and
// from a missing/short payment. Wording comes from src/mirror-402-body.ts so
// the two paths can never drift apart.
// ---------------------------------------------------------------------------

/** Build the 402 body for a settlement failure on a gateway route. */
export function gatewaySettlementFailedBody(
  context: HTTPRequestContext,
  failure: { errorReason?: string; errorMessage?: string },
): { contentType: string; body: unknown } {
  const raw = failure.errorMessage || failure.errorReason || "";
  const price = gatewayPriceForBody(context.adapter.getBody?.());
  const reverted = SETTLEMENT_REVERT_RE.test(raw);
  return {
    contentType: "application/json",
    body: {
      x402Version: 2,
      error: reverted ? settlementRevertText(formatNeededUsdc(atomicUsdc(price))) : SETTLEMENT_FAILED_TEXT,
      ...(raw ? { facilitator_error: raw } : {}),
      // Which model this attempt was priced for — a per-model gateway must say
      // WHICH quote failed, or a payer cannot tell what to fund.
      quoted_price: price,
    },
  };
}
