import { Router, type Request, type Response } from "express";
import { paymentHeaderValue } from "../payment-headers.js";
import { pricing } from "../config.js";
import { paidAccepts, signableAccepts } from "../accepts.js";
import { makeOpenAiHandler, type OpenAiRouterConfig } from "../services/openai-passthrough.js";
import { withoutVision } from "../services/openai-vision.js";
import {
  OPENAI_MODELS,
  GATEWAY_PRICE,
  GATEWAY_MODELS,
  PREMIUM_MODELS,
  GATEWAY_MODEL_LIST,
  priceUsd,
} from "../services/openai-models.js";
import { MODEL_DIMENSIONS } from "./v1-embeddings.js";
import { resolveGatewayModel } from "../services/gateway-model-resolution.js";
import { gatewayRejection } from "../services/gateway-errors.js";
import {
  gatewayRecoveryMode,
  expectedAtomicAmount,
  perModelQuoteNote,
  perModelQuoteSentence,
  GATEWAY_PRICE_MIN,
  GATEWAY_PRICE_MAX,
} from "../services/gateway-pricing.js";
import { gatewayCapability } from "../services/gateway-errors.js";
import { readSubstitutionOptIn, SUBSTITUTION_OPT_IN_DOC } from "../services/gateway-substitution.js";

// OpenAI-compat front door: /v1/models + /v1/chat/completions.
//
// WHY: the miss-log shows agents probing these exact paths — many agent stacks
// never search a directory; their OpenAI SDK is pointed at a base URL and
// expects the standard REST surface. This converts those 404 bounces:
//   - GET /v1/models (FREE, deliberately not in the paywalled routes object):
//     an OpenAI-shaped model list where every row carries an `x402` extension
//     with the model's dedicated endpoint, flat price, and payment networks —
//     a routing map for agents, valid JSON for SDKs.
//   - POST /v1/chat/completions (PAID, flat pricing.v1ChatCompletions): reads
//     `model` from the body like every OpenAI SDK sends it and dispatches to
//     the same per-model passthrough handler (same caps, same 502-uncharged
//     rules). x402 settles ONE flat price per route, so the gateway accepts
//     only models whose dedicated flat price is <= the gateway price — pricier
//     models get an instructive 400 pointing at their dedicated endpoint.
//     Cheap models cost the full gateway price here (the 402 quotes it before
//     anyone pays); the per-model endpoints remain the best-price path and the
//     models list says so.

export const v1OpenAiCompatRouter = Router();

// Gateway eligibility (GATEWAY_MODELS / PREMIUM_MODELS) lives in
// services/openai-models.ts, shared with the route descriptions in src/index.ts
// so the advertised model list can never drift from the list dispatched here.
const GATEWAY_USD = priceUsd(GATEWAY_PRICE);
/**
 * The gateway's handler for one model. The gateway is TEXT-ONLY for every model:
 * `vision` is stripped here so a vision-enabled row can never carry image input
 * through this flat price, even if a future price change made such a row
 * gateway-eligible. Exported so tests can prove the strip BEHAVIOURALLY with a
 * synthetic vision-carrying row instead of grepping this file.
 */
export function gatewayHandlerFor(model: OpenAiRouterConfig) {
  return makeOpenAiHandler(withoutVision(model));
}

// One shared handler per gateway-eligible model (same factory as the dedicated routes).
const DISPATCH = new Map(GATEWAY_MODELS.map((m) => [m.modelId, gatewayHandlerFor(m)]));

// In `per-model` mode the gateway quotes and settles the requested model's own
// price, so EVERY catalogued model is dispatchable here — still through the same
// factory, with the same caps and the same vision strip. Built once at module
// load: nothing about a handler is per-request, and no route config is mutated.
const ALL_DISPATCH = new Map(OPENAI_MODELS.map((m) => [m.modelId, gatewayHandlerFor(m)]));

/** The atomic USDC amount a caller's payment header actually carries (v2 payloads). */
function paidAtomicAmount(req: Request): string | null {
  const header = paymentHeaderValue(req);
  if (!header) return null;
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const amount = decoded?.accepted?.amount;
    return typeof amount === "string" ? amount : null;
  } catch {
    return null;
  }
}

// Fixed `created` stamp (2026-07-14, the lineup's launch) — OpenAI uses static
// per-model epochs; anything stable is fine and keeps responses deterministic.
const CREATED = 1783987200;

function modelList() {
  // `via_gateway` must describe the gateway that is RUNNING, not the flat-price
  // filter: under per-model pricing every chat model is reachable here, each at
  // its own price, and saying otherwise sends callers to a dedicated endpoint
  // they do not need. Under the flat gateway the old answer is still the right
  // one. Both come from the same capability helper the dispatcher uses.
  const mode = gatewayRecoveryMode();
  const { serves, priceFor } = gatewayCapability(mode);
  return {
    object: "list",
    // Gateway-level facts an OpenAI SDK ignores and an agent can read. The
    // substitution control is published ONLY in the modes where it does
    // something: in `off` the gateway never suggests another model at all, and
    // advertising an inert header would be a lie about the running service.
    ...(mode === "off" ? {} : { x402_gateway: { url: "/v1/chat/completions", substitution_opt_in: SUBSTITUTION_OPT_IN_DOC } }),
    data: [
      ...OPENAI_MODELS.map((m) => ({
        id: m.modelId,
        object: "model",
        created: CREATED,
        owned_by: "openai",
        x402: {
          endpoint: m.path,
          price: m.price,
          via_gateway: serves(m)
            ? `/v1/chat/completions (${priceFor(m)}${mode === "per-model" ? " for this model" : " flat"})`
            : null,
          gateway_price: serves(m) ? priceFor(m) : null,
          networks: paidAccepts(m.price).map((a) => a.network),
          note:
            mode === "per-model"
              ? "Reachable at the gateway URL at this model's own price, or directly at its dedicated endpoint."
              : "Dedicated endpoint is the best-price path; no API key, pay per call via x402.",
        },
      })),
      {
        id: "claude-sonnet-4-6",
        object: "model",
        created: CREATED,
        owned_by: "anthropic",
        x402: {
          endpoint: "/messages",
          price: pricing.messages,
          via_gateway: null,
          gateway_price: null,
          networks: paidAccepts(pricing.messages).map((a) => a.network),
          note: "OpenAI-compatible request/response at POST /messages. NOT served by the /v1/chat/completions gateway in any mode.",
        },
      },
      // Embedding models — served at POST /v1/embeddings (input-only, flat
      // price). Listed so agents enumerating /v1/models can discover and PIN a
      // model before embedding (vectors from different models are incompatible).
      ...Object.entries(MODEL_DIMENSIONS).map(([id, dimensions]) => ({
        id,
        object: "model",
        created: CREATED,
        owned_by: "openai",
        x402: {
          endpoint: "/v1/embeddings",
          price: pricing.v1Embeddings,
          via_gateway: null,
          gateway_price: null,
          networks: paidAccepts(pricing.v1Embeddings).map((a) => a.network),
          dimensions,
          note: "Text embeddings at POST /v1/embeddings — an embeddings endpoint, NOT served by the chat gateway. Use the SAME model to embed documents and queries; vectors are model-specific.",
        },
      })),
    ],
  };
}

// FREE: SDKs call this to enumerate models; agents use the x402 extension to route.
// Both base-URL dialects agents use: host/v1/... and host/api/v1/... — the
// miss-log showed probes on each (/v1/models, /api/v1/models, /api/v1/chat).
const serveModels = (_req: Request, res: Response) => {
  res.json(modelList());
};
v1OpenAiCompatRouter.get("/v1/models", serveModels);
v1OpenAiCompatRouter.get("/api/v1/models", serveModels);

// GET on the paid path → 402 challenge so directory probers see payment
// requirements instead of a 404 (same pattern as the other paid POST routes).
const chatChallenge = (_req: Request, res: Response) => {
  const perModel = gatewayRecoveryMode() === "per-model";
  // A bodiless probe has no `model`, so it cannot be quoted an exact price. Say
  // so instead of implying the floor applies to every model: `accepts` carries
  // the minimum (a real, payable quote for the cheapest models) and the error
  // string names the range and how to get an exact quote.
  res.status(402).json({
    x402Version: 2,
    accepts: signableAccepts(perModel ? GATEWAY_PRICE_MIN : GATEWAY_PRICE),
    // Same wording the model-less POST quote carries (services/gateway-pricing.ts)
    // so the two discovery paths cannot drift.
    error: perModel ? perModelQuoteSentence() : "Payment required",
    ...(perModel ? { pricing: perModelQuoteNote() } : {}),
  });
};
v1OpenAiCompatRouter.get("/v1/chat/completions", chatChallenge);
v1OpenAiCompatRouter.get("/api/v1/chat/completions", chatChallenge);

const chatCompletionsHandler = (req: Request, res: Response) => {
  const mode = gatewayRecoveryMode();

  // ONE resolution per request, memoized on the parsed body object — the same
  // result the price callback used to build the 402 and the same one the
  // pre-payment validator used. Pricing and dispatch cannot disagree.
  const resolution = resolveGatewayModel(req.body);

  // `off` keeps the original behaviour verbatim (flat price, prose-only 400s).
  if (mode === "off") {
    const rawModel = (req.body ?? {}).model;
    if (typeof rawModel !== "string" || rawModel === "") {
      res.status(400).json({
        error: {
          message: `model is required. Gateway models (${GATEWAY_PRICE} flat/call): ${GATEWAY_MODEL_LIST}. See GET /v1/models for the full catalog incl. per-model endpoints and prices.`,
          type: "invalid_request_error",
          param: "model",
        },
      });
      return;
    }
    const model = rawModel.replace(/-\d{4}-\d{2}-\d{2}$/, "");
    const handler = DISPATCH.get(model);
    if (handler) {
      void handler(req, res);
      return;
    }
    const premium = PREMIUM_MODELS.find((m) => m.modelId === model);
    if (premium) {
      res.status(400).json({
        error: {
          message: `${premium.modelId} costs ${premium.price}/call — above this gateway's flat ${GATEWAY_PRICE}. Call its dedicated endpoint instead: POST ${premium.path} (same OpenAI chat.completions shape).`,
          type: "invalid_request_error",
          param: "model",
        },
      });
      return;
    }
    res.status(400).json({
      error: {
        message: `Unknown model "${rawModel}". Gateway models: ${GATEWAY_MODEL_LIST}. Premium models have dedicated endpoints (see GET /v1/models). Claude is at POST /messages.`,
        type: "invalid_request_error",
        param: "model",
      },
    });
    return;
  }

  // Recovery modes. The pre-payment middleware normally answers these first;
  // repeating the check here keeps the handler correct on its own (a request
  // that reaches it with an unservable model is still refused, uncharged,
  // before any upstream call).
  const rejection = gatewayRejection(resolution, req.body, mode, req.path, readSubstitutionOptIn(req));
  if (rejection) {
    res.status(400).json(rejection);
    return;
  }
  if (resolution.kind !== "ok") {
    // Unreachable: gatewayRejection() returns a body for every non-ok kind.
    res.status(400).json({
      error: { message: "model is required.", type: "invalid_request_error", param: "model" },
    });
    return;
  }

  // CONSISTENCY CHECK — NOT an authentication step.
  //
  // What actually stops a $0.005 payload from buying a $0.65 generation is the
  // payment middleware: it rebuilds the requirements from THIS body, refuses a
  // payload that does not match them, and has the facilitator verify the
  // signature. This block only re-reads the amount the caller's header CLAIMS
  // and compares it to the price we resolved, so a wiring mistake (precheck and
  // paywall disagreeing, a route mounted without the paywall) surfaces as a 402
  // instead of a served request. A decoded header is caller-supplied data and is
  // never treated as proof of payment: when the paywall is absent there is no
  // payment to prove, and this check cannot substitute for one.
  const paid = paidAtomicAmount(req);
  const expected = expectedAtomicAmount(req.body, mode);
  if (paid !== null && expected !== null && paid !== expected) {
    res.status(402).json({
      x402Version: 2,
      error:
        `price_mismatch: this request was priced at ${resolution.model.price} for ${resolution.model.modelId} ` +
        `(${expected} atomic USDC) but the payment authorizes ${paid}. Nothing was sent upstream and you were not charged. ` +
        `Re-send unpaid to get a fresh quote for this exact request.`,
      // Hand-rolled challenge → signable accepts (EIP-712 domain + timeout), the
      // same rule the cold-probe stubs follow. See tests/signable-accepts.test.ts.
      accepts: signableAccepts(resolution.model.price),
    });
    return;
  }

  const handler = (mode === "per-model" ? ALL_DISPATCH : DISPATCH).get(resolution.model.modelId);
  if (!handler) {
    // A gateway-eligible model always has a handler; this is a configuration bug.
    res.status(500).json({ error: { message: "Model not dispatchable", type: "server_error" } });
    return;
  }
  void handler(req, res);
};

v1OpenAiCompatRouter.post("/v1/chat/completions", chatCompletionsHandler);
v1OpenAiCompatRouter.post("/api/v1/chat/completions", chatCompletionsHandler);
