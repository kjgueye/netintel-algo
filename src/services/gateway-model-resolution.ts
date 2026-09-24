import {
  OPENAI_MODELS,
  GATEWAY_PRICE,
  GATEWAY_MODEL_LIST,
  openAiModelById,
  priceUsd,
} from "./openai-models.js";
import {
  sumMessageChars,
  sumNonContentChars,
  joinMessageText,
  unsupportedFeatures,
  type OpenAiRouterConfig,
  type UnsupportedFeature,
} from "./openai-passthrough.js";
import { estimateTokens, tokenBudgetForCharCap } from "../utils/token-estimate.js";
import { paidAccepts } from "../accepts.js";
import { substitutionOptInContract, type SubstitutionOptIn } from "./gateway-substitution.js";

// ONE model resolution per request, shared by validation, pricing and dispatch.
//
// The gateway used to resolve `model` in exactly one place (the handler), which
// ran AFTER the paywall had already verified a flat $0.005 payment. Recovering a
// premium-model request needs the same answer in three places — the pre-payment
// validator, the price callback the payment middleware calls to build the 402,
// and the dispatcher — and they must NEVER disagree, or a caller could be quoted
// one model's price and served another's.
//
// The resolution is therefore computed once and memoized on the identity of the
// parsed request body. Express creates a fresh body object per request, so the
// memo is per-request by construction: there is no module-level mutable state to
// leak between concurrent requests, and no route config is mutated per request.

export type GatewayResolution =
  | { kind: "ok"; requested: string; model: OpenAiRouterConfig }
  | { kind: "missing" }
  | { kind: "invalid_type"; got: string }
  | { kind: "unknown"; requested: string };

const RESOLUTION_CACHE = new WeakMap<object, GatewayResolution>();

/** Strip the dated snapshot suffix OpenAI SDK users write ("gpt-4o-2024-08-06"). */
export function normalizeModelId(raw: string): string {
  return raw.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

function computeResolution(body: unknown): GatewayResolution {
  const raw = (body as { model?: unknown } | null | undefined)?.model;
  if (raw === undefined || raw === null || raw === "") return { kind: "missing" };
  if (typeof raw !== "string") return { kind: "invalid_type", got: Array.isArray(raw) ? "an array" : typeof raw };
  const model = openAiModelById(normalizeModelId(raw));
  return model ? { kind: "ok", requested: raw, model } : { kind: "unknown", requested: raw };
}

/**
 * Did the request simply not NAME a model?
 *
 * TRUE only for a plain-object body (or no parsed body at all) with no `model`
 * key. That is the shape of a DISCOVERY probe — `POST {}`, or a messages-only
 * body — and it is the one case the gateway must not answer before the paywall,
 * because a caller who has named nothing is asking what this URL costs, not
 * asking for a model.
 *
 * Deliberately narrow, and NOT the same question as `resolveGatewayModel`'s
 * "missing": a body that supplies `model` and gets it wrong — `null`, `""`, a
 * number, an array — has named something invalid and still earns the early,
 * uncharged 400. A non-object body is malformed rather than exploratory and is
 * likewise not waved through. This must never become "bypass validation when the
 * body looks odd".
 */
export function modelFieldAbsent(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body !== "object" || Array.isArray(body)) return false;
  return !Object.prototype.hasOwnProperty.call(body, "model");
}

/**
 * Resolve the `model` field of a parsed chat-completions body.
 * Memoized per body object, so the price callback and the dispatcher that later
 * reads the same request share ONE result.
 */
export function resolveGatewayModel(body: unknown): GatewayResolution {
  if (body === null || typeof body !== "object") return computeResolution(body);
  const cached = RESOLUTION_CACHE.get(body as object);
  if (cached) return cached;
  const fresh = computeResolution(body);
  RESOLUTION_CACHE.set(body as object, fresh);
  return fresh;
}

// ---------------------------------------------------------------------------
// What THIS request actually needs — so a suggested alternative is one that can
// really serve it, not just a cheaper row in the catalog.
// ---------------------------------------------------------------------------

export interface RequestProfile {
  /** Characters counted the way the passthrough caps them. */
  chars: number;
  /** Token estimate with the same density guard the passthrough enforces. */
  estTokens: number;
  /** Output tokens the caller asked for, if any. */
  maxTokensRequested?: number;
  /** temperature/top_p present (reasoning models drop them). */
  hasSampling: boolean;
  /** Any non-text content part (image/audio/file) — the gateway is text-only. */
  hasNonTextParts: boolean;
  /** response_format json_object requested. */
  jsonMode: boolean;
  /**
   * Constraints this request violates on EVERY endpoint here (streaming, a
   * response_format we will not forward, a malformed messages array, non-text
   * parts). Read from the passthrough's own checks, so advice and execution
   * cannot disagree.
   */
  unsupported: UnsupportedFeature[];
}

export function profileRequest(body: unknown): RequestProfile {
  const b = (body ?? {}) as Record<string, any>;
  const messages: any[] = Array.isArray(b.messages) ? b.messages : [];
  const chars = sumMessageChars(messages) + sumNonContentChars(messages);
  const estTokens = estimateTokens(joinMessageText(messages)) + Math.ceil(sumNonContentChars(messages) / 3.5);
  const requested = Number(b.max_completion_tokens ?? b.max_tokens);
  let hasNonTextParts = false;
  for (const m of messages) {
    const content = m?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "text") hasNonTextParts = true;
    }
  }
  return {
    chars,
    estTokens,
    maxTokensRequested: Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : undefined,
    hasSampling: typeof b.temperature === "number" || typeof b.top_p === "number",
    hasNonTextParts,
    jsonMode: (b.response_format as { type?: unknown } | undefined)?.type === "json_object",
    unsupported: unsupportedFeatures(b),
  };
}

/**
 * ONE recovery option, independently actionable: everything a caller needs to
 * act on it without reading anything else — which model, which method and URL,
 * what it costs AT THAT URL, whether this URL can serve it in the mode that is
 * actually running, and the limits that apply there.
 */
export interface RecoveryOption {
  model: string;
  method: "POST";
  /** The URL to send it to (this gateway, or the model's dedicated endpoint). */
  url: string;
  /** What a call costs AT `url` — not a price from somewhere else. */
  price: string;
  /** True only if `url` is this gateway AND the running mode serves this model there. */
  usable_at_this_url: boolean;
  max_input_chars: number;
  max_output_tokens: number;
  reasoning: boolean;
  /** The request's MEASURED input size fits this model's caps (checked, not assumed). */
  input_fits: true;
  /**
   * This option is a DIFFERENT model from the one that was requested. A
   * substitute is only ever listed when the caller opted in (see
   * services/gateway-substitution.ts), and taking one means the caller changes
   * `model` themselves — this service never changes it for them.
   */
  is_substitute: boolean;
  /** The exact `model` value to send for this option, when it differs from the request. */
  send_model_value: string | null;
  /**
   * True only when this option can serve the request EXACTLY AS SENT — same
   * model, same content, same capabilities, same output limit.
   *
   * It is FALSE for every substitute, because taking a substitute means editing
   * the `model` field. Saying otherwise is what let a caller read "usable with
   * the request exactly as sent" next to a model it had not asked for.
   */
  usable_unchanged: boolean;
  /**
   * Input size and every request feature fit this option, and `model` is the
   * ONLY field that differs from what was sent. This is the honest form of the
   * old `usable_unchanged` for a substitute: it separates "your request fits
   * here" from "this is still the model you asked for".
   */
  usable_with_only_model_changed: boolean;
  /** Every change the caller must make before this option will serve them. */
  requires_caller_changes: RequiredChange[];
  /** Behaviour differences that do NOT require a change but must be known. */
  notes: string[];
}

/** One thing the caller must alter for an option to work. Never done for them. */
export interface RequiredChange {
  field: string;
  reason: string;
  caller_action: string;
}

export interface RecoveryOptions {
  /** Servable at the URL the caller already used, in the mode that is running. */
  at_this_url: RecoveryOption[];
  /**
   * Every endpoint whose limits can actually accept THIS request, cheapest
   * first, regardless of what it costs. Populated when nothing at this URL fits,
   * so a caller with a large input is told what CAN take it instead of being
   * left with an empty list. Prices vary and may exceed the refused model's.
   */
  endpoints_that_fit_this_request?: RecoveryOption[];
  /**
   * Cheaper than the model that was refused, but NOT servable at this URL —
   * each has its own endpoint and its own price. Listed because they cost less
   * than what was asked for; this is NOT an inference about the caller's budget.
   */
  cheaper_elsewhere: RecoveryOption[];
  /** Why `at_this_url` is empty, when it is — naming the constraint that rejected it. */
  none_at_this_url_because?: string;
  /**
   * Constraints NO option can absorb at any price (streaming, an unforwardable
   * response_format, malformed messages, non-text parts). While these are
   * present, every listed option carries `usable_unchanged: false`.
   */
  blocking_constraints?: RequiredChange[];
  /**
   * Whether substitute models are listed at all. False means the caller did not
   * opt in, so `at_this_url`, `cheaper_elsewhere` and
   * `endpoints_that_fit_this_request` are empty BY POLICY — not because nothing
   * exists. `substitutes_opt_in` says how to ask for them.
   */
  substitutes_included: boolean;
  /** The opt-in contract, so the control is discoverable where it would have helped. */
  substitutes_opt_in: Record<string, unknown>;
  /** The mechanical ordering rule — deliberately NOT a capability ranking. */
  ordering: string;
}

export const RECOVERY_ORDERING =
  "same reasoning-family as the requested model first, then lowest price first. " +
  "This is a mechanical sort, NOT a capability or quality ranking.";

/**
 * Does the request's measured INPUT fit this model's enforced limits?
 *
 * Input size only — it says nothing about whether the rest of the request is
 * supported. `requiredChanges()` covers that, and the two are reported
 * separately because "your text is small enough" and "we will run this as sent"
 * are different promises.
 */
export function inputFits(model: OpenAiRouterConfig, profile: RequestProfile): boolean {
  if (profile.chars > model.inCapChars) return false;
  return profile.estTokens <= tokenBudgetForCharCap(model.inCapChars);
}

/** Why the input does not fit — the CONSTRAINT that actually rejected it. */
export function inputFitFailure(
  model: OpenAiRouterConfig,
  profile: RequestProfile,
): { constraint: "char_cap" | "token_budget"; detail: string } | undefined {
  if (profile.chars > model.inCapChars) {
    return {
      constraint: "char_cap",
      detail: `${profile.chars} chars exceeds ${model.modelId}'s ${model.inCapChars}-char input cap`,
    };
  }
  const budget = tokenBudgetForCharCap(model.inCapChars);
  if (profile.estTokens > budget) {
    return {
      constraint: "token_budget",
      detail:
        `~${profile.estTokens} estimated tokens exceeds the ${budget}-token budget ${model.modelId}'s ` +
        `${model.inCapChars}-char cap was priced for (token-dense scripts hit this before the char cap)`,
    };
  }
  return undefined;
}

/**
 * Everything the caller must change before `model` will serve this request.
 *
 * Two sources: constraints every endpoint enforces (streaming, an unforwardable
 * response_format, malformed messages, non-text parts — read from the
 * passthrough's own checks) and this model's OUTPUT limit, which is a caller
 * change too: we clamp rather than fail, so a caller who asked for 4,000 output
 * tokens would silently get 1,024. Saying "unchanged recovery" there would be
 * false.
 */
export function requiredChanges(model: OpenAiRouterConfig, profile: RequestProfile): RequiredChange[] {
  const changes: RequiredChange[] = profile.unsupported.map((f) => ({
    field: f.field,
    reason: f.reason,
    caller_action: f.caller_action,
  }));
  if (profile.maxTokensRequested && profile.maxTokensRequested > model.outCapTokens) {
    changes.push({
      field: "max_tokens",
      reason:
        `you requested ${profile.maxTokensRequested} output tokens; ${model.modelId} caps output at ` +
        `${model.outCapTokens} and the request would be clamped, not refused`,
      caller_action: `accept ${model.outCapTokens} output tokens (resend with max_tokens<=${model.outCapTokens}) or choose an endpoint with a larger output cap`,
    });
  }
  return changes;
}

function optionNotes(m: OpenAiRouterConfig, profile: RequestProfile, requested?: OpenAiRouterConfig): string[] {
  const notes: string[] = [];
  if (profile.hasSampling && m.reasoning) notes.push("reasoning model: temperature/top_p are not forwarded");
  if (requested && requested.reasoning && !m.reasoning) notes.push("not a reasoning-family model");
  if (profile.maxTokensRequested && profile.maxTokensRequested > m.outCapTokens) {
    notes.push(
      `max_tokens would be clamped to ${m.outCapTokens} (you asked for ${profile.maxTokensRequested}) — ` +
        "resend a smaller max_tokens or use an endpoint with a bigger output cap",
    );
  }
  if (profile.jsonMode) notes.push('response_format {"type":"json_object"} is supported here — keep it on the retry');
  return notes;
}

function sortOptions(models: OpenAiRouterConfig[], requested?: OpenAiRouterConfig): OpenAiRouterConfig[] {
  return [...models].sort((a, b) => {
    if (requested) {
      const aSame = a.reasoning === requested.reasoning ? 0 : 1;
      const bSame = b.reasoning === requested.reasoning ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
    }
    return priceUsd(a.price) - priceUsd(b.price);
  });
}

/**
 * Build the recovery options for a refused request.
 *
 * The two lists are kept apart on purpose. Collapsing them is what made the
 * first version of this error self-contradictory: it listed gpt-5.4-mini
 * ($0.04, not servable at the gateway) next to a sentence telling callers to
 * re-send any listed model to the same URL. Following that instruction produced
 * a second refusal.
 *
 * @param gatewayServes - given a model, can THIS URL serve it in the running
 *   mode? (advice: only models at/below the gateway's flat price; per-model:
 *   every catalogued model.)
 * @param gatewayPriceFor - what this URL charges for a model it serves.
 */
export function buildRecoveryOptions(args: {
  requested?: OpenAiRouterConfig;
  profile: RequestProfile;
  gatewayUrl: string;
  gatewayServes: (m: OpenAiRouterConfig) => boolean;
  gatewayPriceFor: (m: OpenAiRouterConfig) => string;
  /** The caller's explicit permission to be shown other models. Default: none. */
  optIn?: SubstitutionOptIn;
  limit?: number;
}): RecoveryOptions {
  const { requested, profile, gatewayUrl, gatewayServes, gatewayPriceFor } = args;
  const limit = args.limit ?? 3;
  const optIn: SubstitutionOptIn = args.optIn ?? { allowed: false, supplied: null, recognized: false };

  // Constraints that no listed option can absorb, whatever the caller pays.
  // These describe the CALLER'S OWN request, not an alternative to it, so they
  // are reported whether or not substitutes may be listed.
  const blocking = profile.unsupported.map((f) => ({
    field: f.field,
    reason: f.reason,
    caller_action: f.caller_action,
  }));

  // NO OPT-IN → NO SUBSTITUTES. Not "none found": none offered. The lists are
  // not computed at all, so there is no path by which one could leak into the
  // body, and the caller is told the control exists.
  if (!optIn.allowed) {
    return {
      at_this_url: [],
      cheaper_elsewhere: [],
      ...(blocking.length > 0 ? { blocking_constraints: blocking } : {}),
      substitutes_included: false,
      substitutes_opt_in: substitutionOptInContract(optIn),
      ordering: RECOVERY_ORDERING,
    };
  }

  /** Changing `model` is a caller action like any other — it is never done for them. */
  const modelChange = (m: OpenAiRouterConfig): RequiredChange => ({
    field: "model",
    reason: requested
      ? `this is ${m.modelId}, NOT the ${requested.modelId} you asked for`
      : `this is ${m.modelId}, not the model string you sent`,
    caller_action:
      `resend with "model":"${m.modelId}" — only if a different model is acceptable for your task; ` +
      `nothing is substituted for you`,
  });

  const toOption = (m: OpenAiRouterConfig, atGateway: boolean): RecoveryOption => {
    const isSubstitute = m.modelId !== requested?.modelId;
    const otherChanges = requiredChanges(m, profile);
    const changes = isSubstitute ? [modelChange(m), ...otherChanges] : otherChanges;
    return {
      model: m.modelId,
      method: "POST",
      url: atGateway ? gatewayUrl : m.path,
      price: atGateway ? gatewayPriceFor(m) : m.price,
      usable_at_this_url: atGateway,
      max_input_chars: m.inCapChars,
      max_output_tokens: m.outCapTokens,
      reasoning: m.reasoning,
      input_fits: true,
      is_substitute: isSubstitute,
      send_model_value: isSubstitute ? m.modelId : null,
      // A substitute is never "unchanged": `model` has to change.
      usable_unchanged: changes.length === 0,
      usable_with_only_model_changed: otherChanges.length === 0,
      requires_caller_changes: changes,
      notes: optionNotes(m, profile, requested),
    };
  };

  // Input size is the only filter for LISTING an option; anything else the
  // caller must change is reported on the option itself rather than hiding it,
  // so the answer to "can this serve me?" is never a silent no.
  const fitting = OPENAI_MODELS.filter((m) => m.modelId !== requested?.modelId && inputFits(m, profile));

  const atThisUrl = sortOptions(fitting.filter(gatewayServes), requested)
    .slice(0, limit)
    .map((m) => toOption(m, true));

  const cheaperElsewhere = requested
    ? sortOptions(
        fitting.filter((m) => !gatewayServes(m) && priceUsd(m.price) < priceUsd(requested.price)),
        requested,
      )
        .slice(0, limit)
        .map((m) => {
          const o = toOption(m, false);
          return {
            ...o,
            notes: [`not usable at ${gatewayUrl} — POST ${m.path} and pay ${m.price} there`, ...o.notes],
          };
        })
    : [];

  const fitsAnywhere = sortOptions(
    OPENAI_MODELS.filter((m) => inputFits(m, profile)),
    requested,
  ).map((m) => toOption(m, gatewayServes(m)));

  // WHY nothing is available here, naming the constraint that actually rejected
  // it — a character cap, the token budget that cap was priced for, or a
  // feature no endpoint supports.
  let noneBecause: string | undefined;
  if (atThisUrl.length === 0) {
    const servable = OPENAI_MODELS.filter(gatewayServes);
    const biggest = servable.reduce<OpenAiRouterConfig | undefined>(
      (max, m) => (!max || m.inCapChars > max.inCapChars ? m : max),
      undefined,
    );
    const sizeFailure = biggest ? inputFitFailure(biggest, profile) : undefined;
    if (sizeFailure) {
      noneBecause =
        `${sizeFailure.detail} — that is the largest input this URL serves ` +
        `(constraint: ${sizeFailure.constraint})`;
    } else if (!biggest) {
      noneBecause = "this URL serves no chat model";
    } else {
      noneBecause = "no model this URL serves fits this request";
    }
  }

  return {
    at_this_url: atThisUrl,
    cheaper_elsewhere: cheaperElsewhere,
    none_at_this_url_because: noneBecause,
    ...(blocking.length > 0 ? { blocking_constraints: blocking } : {}),
    ...(atThisUrl.length === 0 && fitsAnywhere.length > 0
      ? { endpoints_that_fit_this_request: fitsAnywhere.slice(0, 5) }
      : {}),
    substitutes_included: true,
    substitutes_opt_in: substitutionOptInContract(optIn),
    ordering: RECOVERY_ORDERING,
  };
}

/** Models whose id is a near-miss for what the caller typed (unknown-model help). */
export function closestModelIds(requested: string, limit = 3): string[] {
  const needle = normalizeModelId(requested).toLowerCase();
  const scored = OPENAI_MODELS.map((m) => {
    const id = m.modelId.toLowerCase();
    let score = 0;
    if (id === needle) score = 100;
    else if (id.startsWith(needle) || needle.startsWith(id)) score = 60;
    else if (id.includes(needle) || needle.includes(id)) score = 40;
    else {
      // Shared dash-separated fragments ("gpt", "4o", "mini", "nano", "5.6").
      const a = new Set(needle.split(/[-_.\s]/).filter(Boolean));
      const b = id.split(/[-_.\s]/).filter(Boolean);
      score = b.filter((t) => a.has(t)).length * 10;
    }
    return { id: m.modelId, score };
  })
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score);
  return scored.slice(0, limit).map((s) => s.id);
}

/** Payment networks a given price is payable on (Base always; Solana when configured). */
export function networksFor(price: string): string[] {
  return paidAccepts(price).map((a) => a.network);
}

export { GATEWAY_MODEL_LIST, GATEWAY_PRICE };
