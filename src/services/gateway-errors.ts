import {
  buildRecoveryOptions,
  closestModelIds,
  inputFits,
  requiredChanges,
  networksFor,
  profileRequest,
  RECOVERY_ORDERING,
  type GatewayResolution,
  type RecoveryOption,
  type RecoveryOptions,
  type RequestProfile,
} from "./gateway-model-resolution.js";
import { GATEWAY_MODELS, GATEWAY_MODEL_LIST, GATEWAY_PRICE, OPENAI_MODELS, priceUsd } from "./openai-models.js";
import type { OpenAiRouterConfig } from "./openai-passthrough.js";
import type { GatewayRecoveryMode } from "./gateway-pricing.js";
import {
  NO_OPT_IN,
  SUBSTITUTION_OPT_IN_HEADER,
  substitutionOptInContract,
  type SubstitutionOptIn,
} from "./gateway-substitution.js";

// The gateway's 400 bodies.
//
// Shape: a standard OpenAI error object (agents and every OpenAI SDK already
// branch on error.type / error.code / error.param) PLUS a `recovery` object.
//
// TWO RULES this file exists to keep:
//
// 1. EVERY option is independently actionable — model id, method, URL, the price
//    AT THAT URL, the limits that apply there, and whether this URL can serve it
//    in the mode that is actually running. The first version of this error
//    listed gpt-5.4-mini ($0.04, dedicated endpoint only) beside a sentence
//    telling callers to re-send any listed model to the same URL; following that
//    instruction earned a second refusal. Options usable HERE and options that
//    are merely cheaper than what was asked for are now separate lists.
//
// 2. The prose and the structured fields are RENDERED FROM THE SAME OBJECT
//    (renderRecoveryProse below), so they cannot disagree.
//
// 3. A DIFFERENT MODEL IS NEVER OFFERED UNLESS THE CALLER ASKED TO SEE ONE.
//    Suggesting a cheap substitute rescued a caller who could not afford the
//    requested model and derailed a caller who required it (see
//    services/gateway-substitution.ts for the measurement). Those two callers
//    are indistinguishable from the request, so permission is explicit and
//    defaults to off. Without it these bodies answer ONLY about the model that
//    was asked for: its own endpoint, its real price, and its real limits.
//
// Nothing here guesses the caller's budget, and nothing is ranked by "capability":
// the ordering is a stated mechanical sort. An option is listed only when the
// request's MEASURED size fits that model's enforced caps — never by trimming.

export const GATEWAY_ERROR_CODES = {
  modelRequired: "model_required",
  modelUnknown: "model_unknown",
  modelAbovePrice: "model_above_gateway_price",
  modelNotText: "model_requires_dedicated_endpoint",
} as const;

export interface GatewayErrorBody {
  error: {
    message: string;
    type: "invalid_request_error";
    param: "model" | "messages";
    code: string;
    recovery: Record<string, unknown>;
  };
}

/** Which models this URL serves, and at what price, in the running mode. */
export function gatewayCapability(mode: GatewayRecoveryMode) {
  const serves =
    mode === "per-model"
      ? () => true
      : (m: OpenAiRouterConfig) => GATEWAY_MODELS.some((g) => g.modelId === m.modelId);
  const priceFor = mode === "per-model" ? (m: OpenAiRouterConfig) => m.price : () => GATEWAY_PRICE;
  return { serves, priceFor };
}

function quote(model: OpenAiRouterConfig) {
  return {
    model: model.modelId,
    price: model.price,
    method: "POST" as const,
    url: model.path,
    networks: networksFor(model.price),
    max_input_chars: model.inCapChars,
    max_output_tokens: model.outCapTokens,
    reasoning: model.reasoning,
  };
}

function optionPhrase(o: RecoveryOption): string {
  const base = `${o.model} (POST ${o.url}, ${o.price}`;
  if (o.usable_unchanged) return `${base})`;
  // Spell the model edit out as the edit it is. "needs model changed first" is
  // true but vague; the caller should not have to work out what to write.
  const fields = o.requires_caller_changes.map((c) => c.field);
  const others = fields.filter((f) => f !== "model");
  if (o.send_model_value === null) return `${base} — needs ${fields.join(" + ")} changed first)`;
  return others.length === 0
    ? `${base} — send "model":"${o.send_model_value}")`
    : `${base} — send "model":"${o.send_model_value}" and change ${others.join(" + ")})`;
}

/**
 * The human-readable half of the SAME recovery object the structured fields
 * carry. Every sentence names the exact URL an option belongs to, so no sentence
 * can imply an option works somewhere it does not.
 */
export function renderRecoveryProse(opts: RecoveryOptions, gatewayUrl: string): string {
  const parts: string[] = [];
  // A constraint no endpoint can absorb comes FIRST: switching model will not
  // help until the caller changes it, and saying otherwise would be false.
  if (opts.blocking_constraints && opts.blocking_constraints.length > 0) {
    parts.push(
      `This request cannot run on ANY model here as sent — ` +
        `${opts.blocking_constraints.map((c) => `${c.field}: ${c.caller_action}`).join("; ")}. ` +
        `Fix that first.`,
    );
  }
  // No permission to suggest another model → say that, and say how to ask. The
  // sentence names no model: a caller who must keep theirs is given nothing to
  // drift onto, and a caller who is free to switch learns how to see the list.
  if (!opts.substitutes_included) {
    parts.push(
      `No other model is listed: this URL suggests a different model only when you ask it to. ` +
        `Send the header ${SUBSTITUTION_OPT_IN_HEADER}: true to see models that could serve this request ` +
        `(suggestions only — your \`model\` field is never changed for you).`,
    );
    return parts.join(" ");
  }
  if (opts.at_this_url.length > 0) {
    // "Exactly as sent" would be a lie about a DIFFERENT model: taking any of
    // these means editing `model` yourself. Group by what else must change.
    const onlyModel = opts.at_this_url.filter((o) => o.usable_with_only_model_changed);
    const needsMore = opts.at_this_url.filter((o) => !o.usable_with_only_model_changed);
    if (onlyModel.length > 0) {
      parts.push(
        `You asked to see other models. These can serve this request at this URL (POST ${gatewayUrl}) with ` +
          `everything else exactly as sent, changing ONLY the \`model\` field: ${onlyModel.map(optionPhrase).join(", ")}.`,
      );
    }
    if (needsMore.length > 0) {
      parts.push(`Usable at this URL after further changes you must make: ${needsMore.map(optionPhrase).join(", ")}.`);
    }
  } else if (opts.none_at_this_url_because) {
    parts.push(`No model available at this URL can serve this request: ${opts.none_at_this_url_because}.`);
  }
  if (opts.endpoints_that_fit_this_request && opts.endpoints_that_fit_this_request.length > 0) {
    parts.push(
      `Endpoints whose limits can accept an input this size (cheapest first, prices vary): ` +
        `${opts.endpoints_that_fit_this_request.map(optionPhrase).join(", ")}.`,
    );
  }
  if (opts.cheaper_elsewhere.length > 0) {
    parts.push(
      `Cheaper than the model you asked for but NOT usable at this URL — each needs its own endpoint: ` +
        `${opts.cheaper_elsewhere.map(optionPhrase).join(", ")}.`,
    );
  }
  return parts.join(" ");
}

/**
 * The uncharged-and-unchanged guarantee, plus the routes forward that actually
 * exist in THIS body. Pointing at recovery.at_this_url when no substitute was
 * listed would send a caller to an empty array.
 */
function noSilentChanges(substitutesIncluded: boolean): string {
  const base =
    "Nothing was sent upstream and you were not charged. Nothing was substituted, truncated, downgraded or " +
    "auto-upgraded — the model you send is the only model that ever runs. ";
  return substitutesIncluded
    ? base +
        "To proceed: POST recovery.pay_the_requested_model_at.url to get the model you asked for, or — since you " +
        "asked to see other models — re-send to this URL with a model from recovery.at_this_url[].send_model_value " +
        "(you change the field; we do not), or POST recovery.cheaper_elsewhere[].url."
    : base +
        `To proceed: POST recovery.pay_the_requested_model_at.url to get the model you asked for. No substitute ` +
        `model is listed; send ${SUBSTITUTION_OPT_IN_HEADER}: true if you want to see models that could serve ` +
        `this request instead.`;
}

function requestProfileBlock(profile: RequestProfile) {
  return {
    input_chars: profile.chars,
    estimated_input_tokens: profile.estTokens,
    max_output_tokens_requested: profile.maxTokensRequested ?? null,
    json_mode: profile.jsonMode,
    has_non_text_parts: profile.hasNonTextParts,
  };
}

/** `model` missing or not a string. */
export function modelRequiredError(
  resolution: Extract<GatewayResolution, { kind: "missing" | "invalid_type" }>,
  mode: GatewayRecoveryMode,
  gatewayUrl: string,
): GatewayErrorBody {
  const got = resolution.kind === "invalid_type" ? ` (got ${resolution.got})` : "";
  const { serves, priceFor } = gatewayCapability(mode);
  const servable = OPENAI_MODELS.filter(serves);
  return {
    error: {
      message:
        `model is required and must be a string${got}. Models this URL serves: ` +
        `${servable.map((m) => `${m.modelId} (${priceFor(m)})`).join(", ")}. ` +
        `GET /v1/models (free) lists every model with its own endpoint and price.`,
      type: "invalid_request_error",
      param: "model",
      code: GATEWAY_ERROR_CODES.modelRequired,
      recovery: {
        catalog: { method: "GET", url: "/v1/models", price: "free" },
        substitutes_opt_in: substitutionOptInContract(NO_OPT_IN),
        // Not a substitution: the caller named no model, so there is nothing to
        // preserve. This is the catalog for the URL they called.
        models_at_this_url: servable.map((m) => ({
          model: m.modelId,
          method: "POST" as const,
          url: gatewayUrl,
          price: priceFor(m),
          usable_at_this_url: true,
          max_input_chars: m.inCapChars,
          max_output_tokens: m.outCapTokens,
        })),
      },
    },
  };
}

/** `model` is a string we do not serve anywhere. */
export function unknownModelError(
  requested: string,
  profile: RequestProfile,
  mode: GatewayRecoveryMode,
  gatewayUrl: string,
  optIn: SubstitutionOptIn = NO_OPT_IN,
): GatewayErrorBody {
  const near = closestModelIds(requested);
  const { serves, priceFor } = gatewayCapability(mode);
  const options = buildRecoveryOptions({ profile, gatewayUrl, gatewayServes: serves, gatewayPriceFor: priceFor, optIn });
  return {
    error: {
      message:
        `Unknown model "${requested.slice(0, 60)}". ${near.length ? `Did you mean ${near.join(", ")}? ` : ""}` +
        `${renderRecoveryProse(options, gatewayUrl)} Claude is at POST /messages. ` +
        `GET /v1/models (free) lists every model with its endpoint and price.`,
      type: "invalid_request_error",
      param: "model",
      code: GATEWAY_ERROR_CODES.modelUnknown,
      recovery: {
        requested_model: requested.slice(0, 60),
        // A SPELLING match on the string that was sent — the model the caller
        // named exists nowhere, so there is no model choice to preserve and
        // nothing here is offered as a replacement for one. Substitutes (models
        // offered INSTEAD of one we do serve) stay gated below.
        did_you_mean: near,
        did_you_mean_is: "closest spellings of the string you sent, not an offer to run a different model",
        catalog: { method: "GET", url: "/v1/models", price: "free" },
        request_profile: requestProfileBlock(profile),
        at_this_url: options.at_this_url,
        cheaper_elsewhere: options.cheaper_elsewhere,
        ...(options.none_at_this_url_because ? { none_at_this_url_because: options.none_at_this_url_because } : {}),
        // Constraints no option can absorb at any price — listed once, at the
        // top level, because they apply to every option below them.
        ...(options.blocking_constraints ? { blocking_constraints: options.blocking_constraints } : {}),
        ...(options.endpoints_that_fit_this_request
          ? { endpoints_that_fit_this_request: options.endpoints_that_fit_this_request }
          : {}),
        ordering: RECOVERY_ORDERING,
        substitutes_included: options.substitutes_included,
        substitutes_opt_in: options.substitutes_opt_in,
        no_silent_changes: noSilentChanges(options.substitutes_included),
      },
    },
  };
}

/**
 * The caller asked for a model this URL does not serve at its price (`advice`
 * mode only — in `per-model` mode the model is quoted at its own price and this
 * never fires).
 */
export function premiumModelError(
  model: OpenAiRouterConfig,
  body: unknown,
  mode: GatewayRecoveryMode,
  gatewayUrl: string,
  optIn: SubstitutionOptIn = NO_OPT_IN,
): GatewayErrorBody {
  const profile = profileRequest(body);
  const { serves, priceFor } = gatewayCapability(mode);
  const options = buildRecoveryOptions({
    requested: model,
    profile,
    gatewayUrl,
    gatewayServes: serves,
    gatewayPriceFor: priceFor,
    optIn,
  });
  // The advertised "pay for it at its own endpoint" instruction is only valid if
  // that endpoint can actually take THIS request — a 54,000-char body does not
  // fit gpt-5.6-luna's 48,000-char cap, and telling the caller to go there would
  // just earn them a second refusal.
  const requestedInputFits = inputFits(model, profile);
  const requestedChanges = requiredChanges(model, profile);
  const requestedUnchanged = requestedInputFits && requestedChanges.length === 0;
  const requestedLine = !requestedInputFits
    ? `${model.modelId} cannot serve this request either: it measures ${profile.chars} chars and ${model.modelId}'s ` +
      `input cap is ${model.inCapChars} chars, so POST ${model.path} would also refuse it. `
    : requestedUnchanged
      ? `To get ${model.modelId} itself: POST ${model.path} and pay ${model.price} there (identical OpenAI chat.completions request shape). `
      : `To get ${model.modelId} itself: POST ${model.path} and pay ${model.price} there — but this request needs ` +
        `${requestedChanges.length} change(s) first (${requestedChanges.map((c) => c.field).join(", ")}), listed in ` +
        `recovery.requested_requires_caller_changes. `;
  return {
    error: {
      message:
        `${model.modelId} costs ${model.price}/call — more than this URL's flat ${GATEWAY_PRICE}, so ${gatewayUrl} ` +
        `cannot serve it. ` +
        requestedLine +
        renderRecoveryProse(options, gatewayUrl),
      type: "invalid_request_error",
      param: "model",
      code: GATEWAY_ERROR_CODES.modelAbovePrice,
      recovery: {
        requested: quote(model),
        /** The request's measured INPUT fits the model that was asked for. */
        requested_input_fits: requestedInputFits,
        /** …and nothing else about the request needs changing for it to run there. */
        requested_usable_unchanged: requestedUnchanged,
        ...(requestedChanges.length > 0 ? { requested_requires_caller_changes: requestedChanges } : {}),
        ...(requestedInputFits
          ? {
              pay_the_requested_model_at: {
                method: "POST" as const,
                url: model.path,
                price: model.price,
                networks: networksFor(model.price),
                usable_at_this_url: false,
              },
            }
          : {
              requested_model_cannot_serve_this_request: {
                model: model.modelId,
                url: model.path,
                max_input_chars: model.inCapChars,
                your_input_chars: profile.chars,
                reason: "input exceeds that endpoint's cap; it would refuse this request too",
              },
            }),
        this_url: { url: gatewayUrl, price: GATEWAY_PRICE, serves_models_priced_at_or_below: GATEWAY_PRICE },
        request_profile: requestProfileBlock(profile),
        at_this_url: options.at_this_url,
        cheaper_elsewhere: options.cheaper_elsewhere,
        ...(options.none_at_this_url_because ? { none_at_this_url_because: options.none_at_this_url_because } : {}),
        // Constraints no option can absorb at any price — listed once, at the
        // top level, because they apply to every option below them.
        ...(options.blocking_constraints ? { blocking_constraints: options.blocking_constraints } : {}),
        ...(options.endpoints_that_fit_this_request
          ? { endpoints_that_fit_this_request: options.endpoints_that_fit_this_request }
          : {}),
        ordering: RECOVERY_ORDERING,
        substitutes_included: options.substitutes_included,
        substitutes_opt_in: options.substitutes_opt_in,
        budget_note: options.substitutes_included
          ? "price and permission are separate. A price you cannot afford is NOT permission to change your model: " +
            `the models above are listed only because you sent ${SUBSTITUTION_OPT_IN_HEADER}: true, never because ` +
            "this request looked cheap or small. Nothing is charged without a fresh 402 quote you choose to pay."
          : "price and permission are separate. This request was refused on price, and that is NOT permission to " +
            "change your model, so no other model is named. Nothing is charged without a fresh 402 quote you choose to pay.",
        no_silent_changes: noSilentChanges(options.substitutes_included),
      },
    },
  };
}

/**
 * The model is known and quotable, but this request cannot be served at the
 * gateway URL at all: non-text content parts (the gateway is text-only for every
 * model, including the vision-enabled gpt-4o row).
 */
export function nonTextPartsError(model: OpenAiRouterConfig, gatewayUrl: string): GatewayErrorBody {
  const gpt4o = OPENAI_MODELS.find((m) => m.modelId === "gpt-4o");
  return {
    error: {
      message:
        `${gatewayUrl} is text-only for every model: content parts other than {"type":"text"} are not accepted here. ` +
        `Image input is available only on the dedicated POST /openai/gpt-4o endpoint` +
        (gpt4o ? ` (${gpt4o.price}/call, bounded image budget).` : "."),
      type: "invalid_request_error",
      param: "messages",
      code: GATEWAY_ERROR_CODES.modelNotText,
      recovery: {
        requested: quote(model),
        images_supported_at: {
          method: "POST" as const,
          url: "/openai/gpt-4o",
          price: gpt4o?.price ?? null,
          usable_at_this_url: false,
        },
        catalog: { method: "GET", url: "/v1/models", price: "free" },
        no_silent_changes: noSilentChanges(false),
      },
    },
  };
}

/**
 * Build the right 400 for a resolution that cannot be served, or null when the
 * request may proceed to payment.
 */
export function gatewayRejection(
  resolution: GatewayResolution,
  body: unknown,
  mode: GatewayRecoveryMode,
  gatewayUrl: string,
  /**
   * The caller's explicit permission to be shown other models. Defaults to NONE
   * on every path, so a caller that forgets to pass it through gets the
   * conservative answer rather than the permissive one.
   */
  optIn: SubstitutionOptIn = NO_OPT_IN,
): GatewayErrorBody | null {
  if (resolution.kind === "missing" || resolution.kind === "invalid_type") {
    return modelRequiredError(resolution, mode, gatewayUrl);
  }
  if (resolution.kind === "unknown") {
    return unknownModelError(resolution.requested, profileRequest(body), mode, gatewayUrl, optIn);
  }
  const profile = profileRequest(body);
  if (profile.hasNonTextParts) return nonTextPartsError(resolution.model, gatewayUrl);
  if (mode === "per-model") return null; // every catalogued model is quotable here
  const servedHere = priceUsd(resolution.model.price) <= priceUsd(GATEWAY_PRICE);
  return servedHere ? null : premiumModelError(resolution.model, body, mode, gatewayUrl, optIn);
}

export { GATEWAY_MODEL_LIST };
