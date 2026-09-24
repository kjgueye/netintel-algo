import { Router, type Request, type Response } from "express";
import { config, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { paidAccepts, signableAccepts } from "../accepts.js";
import { estimateTokens, tokenBudgetForCharCap, tokenDensityMessage } from "../utils/token-estimate.js";
import { openAiFetch } from "./openai-fetch.js";
import {
  type OpenAiVisionConfig,
  type PreparedVisionMessages,
  countImageParts,
  prepareVisionMessages,
  countVisionInputTokens,
  budgetExceededMessage,
  loadO200kCounter,
} from "./openai-vision.js";

// Shared factory for the OpenAI-direct chat passthrough endpoints (/openai/<model>).
//
// Every /openai/<model> route is the SAME thin, capped, metered passthrough to
// POST https://api.openai.com/v1/chat/completions — request AND response are
// already OpenAI chat.completions-shaped, so (unlike /messages, which converts
// to/from Anthropic) there is NO translation layer. The only per-endpoint
// differences are the model id, the input/output caps, and the token param
// (max_tokens for gpt-4* chat models vs max_completion_tokens for gpt-5.x /
// reasoning / Codex / Pro, which also reject temperature/top_p). This module
// owns all of that; a sibling endpoint imports makeOpenAiRouter and adds ONE row.
//
// Pricing is a FLAT per-call price (x402/CDP settles a fixed, pre-agreed amount —
// it cannot meter tokens). The flat price is derived from the caps so the
// theoretical worst-case OpenAI spend always clears margin; because the caps are
// enforced here, a call physically cannot cost more than that worst case. NEVER
// raise a cap without re-deriving the price (see OPENAI-ENDPOINTS-HANDOFF.md).

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

/** Per-endpoint knobs. Everything else about the passthrough is shared. */
export interface OpenAiPassthroughConfig {
  /** Real dotted OpenAI model id passed to the API, e.g. "gpt-4o", "gpt-5.6-sol". */
  modelId: string;
  /** Input cap in CHARACTERS, summed across all message content. */
  inCapChars: number;
  /** Output cap in TOKENS (the value the token param is clamped to). */
  outCapTokens: number;
  /**
   * Reasoning-family model? gpt-5.x / Codex / Pro require `max_completion_tokens`
   * and REJECT temperature/top_p (400). gpt-4* chat models use `max_tokens` and
   * accept sampling params. Selects the token param + whether sampling is forwarded.
   */
  reasoning: boolean;
  /**
   * Hard wall-clock cap for the upstream call. Optional — defaults to
   * timeouts.openaiChat. Overridable so tests can force the timeout branch fast.
   */
  timeoutMs?: number;
  /**
   * Bounded image input (see openai-vision.ts). ABSENT = text-only, which is
   * every model except the dedicated gpt-4o row; the gateway strips it
   * (withoutVision) so /v1/chat/completions stays text-only for every model.
   */
  vision?: OpenAiVisionConfig;
}

/** Config for a full router (adds the path + the flat x402 price string). */
export interface OpenAiRouterConfig extends OpenAiPassthroughConfig {
  /** Endpoint path, e.g. "/openai/gpt-4o". */
  path: string;
  /** Flat price string from config.pricing, e.g. "$0.10". */
  price: string;
}

/**
 * Flatten OpenAI message content to plain text for the input-char count. Content
 * is either a string or an array-of-parts ({type,text}), per the OpenAI shape.
 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join(" ");
  }
  return "";
}

/** Total content characters across all messages, for the input cap. */
export function sumMessageChars(messages: any[]): number {
  let chars = 0;
  for (const m of messages) chars += contentToText(m?.content).length;
  return chars;
}

/** All message content flattened to one string, for token estimation. */
export function joinMessageText(messages: any[]): string {
  return messages.map((m) => contentToText(m?.content)).join(" ");
}

// Cheap structural sanity caps. The real cost bound is the char/token caps;
// these just stop pathological shapes (thousands of tiny messages/parts) from
// costing per-item overhead the caps never priced.
const MAX_MESSAGES = 200;
const MAX_PARTS_PER_MESSAGE = 50;

/**
 * Enforce TEXT-ONLY message content.
 *
 * These are flat-priced text endpoints whose price is derived from the
 * char/token caps — but those caps only ever measured `part.text`. An
 * `image_url` part (up to 1,445 tokens on gpt-4o at detail:"high"), an
 * `input_audio` part, or a `file` part carrying a base64 PDF measured as ZERO
 * chars and was forwarded verbatim, so OpenAI billed it against a $0.005–$0.10
 * flat price with the 1 MB body limit as the only bound (found by the 2026-09
 * external review). Rejecting loudly (400, uncharged) beats silently dropping:
 * the agent gets a message it can act on. /messages already drops non-text;
 * this is the louder twin.
 *
 * Models with a `vision` config route IMAGE-BEARING requests through
 * openai-vision.ts instead (bounded, budgeted); this guard still handles their
 * image-free requests, so its message names the image option when it exists.
 */
export function assertTextOnlyMessages(
  messages: unknown[],
  opts: { imagesAllowed?: boolean; maxImages?: number } = {},
): void {
  if (messages.length > MAX_MESSAGES) {
    throw new ValidationError(
      `Too many messages: ${messages.length} (max ${MAX_MESSAGES}). Trim the conversation history.`,
    );
  }
  for (const m of messages) {
    const content = (m as { content?: unknown } | null)?.content;
    if (content === undefined || content === null || typeof content === "string") continue;
    if (!Array.isArray(content)) {
      throw new ValidationError(
        'message content must be a string or an array of {"type":"text","text":"..."} parts',
      );
    }
    if (content.length > MAX_PARTS_PER_MESSAGE) {
      throw new ValidationError(
        `Too many content parts in one message: ${content.length} (max ${MAX_PARTS_PER_MESSAGE}).`,
      );
    }
    for (const part of content) {
      const type = (part as { type?: unknown } | null)?.type;
      if (type === "text" && typeof (part as { text?: unknown }).text === "string") continue;
      const label = typeof type === "string" ? `'${type.slice(0, 40)}'` : "unknown";
      if (opts.imagesAllowed) {
        throw new ValidationError(
          `content part type ${label} is not supported on this endpoint; send string content, ` +
            `{"type":"text","text":"..."} parts, or (user messages) up to ${opts.maxImages ?? 4} https ` +
            '{"type":"image_url","image_url":{"url":"https://…"}} parts. Audio and file parts are not accepted.',
        );
      }
      throw new ValidationError(
        `content part type ${label} is not supported on this text-only endpoint; ` +
          'send string content or {"type":"text","text":"..."} parts.',
      );
    }
  }
}

/**
 * Characters in message fields OTHER than role/content (tool_calls arguments,
 * function_call, name, …). The whole message object is forwarded upstream, so
 * anything in it is billable input — count it against the same cap. Zero for
 * plain {role, content} messages, so ordinary callers see identical counts.
 */
export function sumNonContentChars(messages: any[]): number {
  let chars = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    for (const [k, v] of Object.entries(m)) {
      if (k === "role" || k === "content" || v === undefined || v === null) continue;
      chars += typeof v === "string" ? v.length : JSON.stringify(v)?.length ?? 0;
    }
  }
  return chars;
}

/**
 * Clamp a requested output-token count to the cap. Missing/invalid/non-positive
 * → the cap (the default). A smaller valid request is honored.
 */
export function clampMaxTokens(input: unknown, cap: number): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return cap;
  return Math.min(cap, Math.floor(n));
}

/** Response header signalling that the caller's output-token request was clamped. */
export const MAX_TOKENS_CLAMPED_HEADER = "X-NetIntel-Max-Tokens-Clamped";

/**
 * "<requested>-><cap>" when the caller asked for MORE output tokens than the
 * cap (clampMaxTokens silently reduced it), else undefined. Observed before
 * this signal existed: 25 gateway calls asked for 12000, got exactly 1024 and a
 * finish_reason "length" — truncated (invalid) JSON, HTTP 200, charged, and
 * nothing in the response said why.
 */
export function clampedMaxTokensHeader(requested: unknown, cap: number): string | undefined {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const asked = Math.floor(n);
  return asked > cap ? `${asked}->${cap}` : undefined;
}

/** The response_format values this passthrough forwards upstream. */
export type ForwardedResponseFormat = { type: "text" } | { type: "json_object" };

const RESPONSE_FORMAT_HINT =
  'Accepted: {"type":"json_object"} (JSON mode: the reply is guaranteed to be valid JSON, no schema is ' +
  'enforced, and a system or user message must mention JSON) or {"type":"text"} (the default).';

function jsonTypeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  const t = typeof v;
  return t === "object" ? "an object" : `a ${t}`;
}

/**
 * Validate a caller's `response_format` and return the object forwarded
 * upstream — REBUILT as a named field, never the caller's object spread through
 * (the flat price is derived from what the caps can measure, so every forwarded
 * field is named on purpose). Omitted or null → undefined → no key upstream, so
 * callers that never send it get a byte-identical upstream body.
 *
 * Supported per OpenAI's Chat Completions reference: {"type":"text"} and
 * {"type":"json_object"} (JSON mode — "ensures the message the model generates
 * is valid JSON"; it does NOT enforce a schema, and the model "will not generate
 * JSON without a system or user message instructing it to do so": OpenAI 400s
 * when no message mentions JSON, which the upstream-4xx passthrough surfaces
 * verbatim). {"type":"json_schema"} (Structured Outputs) is rejected: the
 * schema is unmeasured, unpriced input with model-dependent support.
 *
 * Silently dropping this field was the old behaviour: the recurring gpt-4o-mini
 * gateway wallet sent json_object on 931/996 calls and the /openai/gpt-4o wallet
 * on 95/95 — 68 of those came back as a ```json fence, which real JSON mode
 * never produces.
 */
export function normalizeResponseFormat(input: unknown): ForwardedResponseFormat | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError(
      `response_format must be an object, got ${jsonTypeName(input)}. ${RESPONSE_FORMAT_HINT}`,
    );
  }
  const { type, ...rest } = input as Record<string, unknown>;
  if (typeof type !== "string") {
    throw new ValidationError(`response_format.type is required and must be a string. ${RESPONSE_FORMAT_HINT}`);
  }
  if (type === "json_schema") {
    throw new ValidationError(
      'response_format.type "json_schema" (Structured Outputs) is not supported on this endpoint. ' +
        'Use {"type":"json_object"} and describe the required shape in your prompt — the reply is valid ' +
        'JSON but the schema is not enforced — or {"type":"text"}.',
    );
  }
  if (type !== "text" && type !== "json_object") {
    throw new ValidationError(
      `response_format.type "${type.slice(0, 40)}" is not supported. ${RESPONSE_FORMAT_HINT}`,
    );
  }
  const extra = Object.keys(rest);
  if (extra.length > 0) {
    throw new ValidationError(
      `response_format has unsupported field(s) ${extra.map((k) => `"${k.slice(0, 40)}"`).join(", ")} ` +
        `for type "${type}". Send exactly {"type":"${type}"}.`,
    );
  }
  return { type };
}

/**
 * Scrub key/token material from an upstream error message before echoing it to
 * the caller. An OpenAI 400 normally echoes the caller's own parameters, not
 * our key, but the text is upstream-authored — treat it as untrusted.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|authorization)(\s*[:=]\s*)["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi, "$1$2[redacted]");
}

const UPSTREAM_MESSAGE_MAX_CHARS = 1000;

/**
 * OpenAI's own error.message (+ param) from a rejected request, or a generic
 * line when the body is not the documented {error:{message}} shape. The body
 * was already drained under the fetch deadline (openai-fetch.ts), so this read
 * cannot stall on the network.
 */
async function upstreamRejection(
  response: globalThis.Response,
): Promise<{ message: string; param?: string }> {
  const fallback = { message: `OpenAI rejected the request (HTTP ${response.status})` };
  try {
    const data: any = await response.json();
    const raw = data?.error?.message;
    if (typeof raw !== "string" || raw.trim() === "") return fallback;
    const message = redactSecrets(raw).slice(0, UPSTREAM_MESSAGE_MAX_CHARS);
    const param = data.error?.param;
    return typeof param === "string" && param !== "" ? { message, param: param.slice(0, 100) } : { message };
  } catch {
    return fallback;
  }
}

/**
 * Stable error code for a JSON-mode reply we could not accept. Callers can
 * branch on this without parsing prose.
 */
export const JSON_MODE_ERROR_CODE = "upstream_invalid_json";

/**
 * Validate the assistant content of a reply the caller asked to be JSON.
 *
 * Applies ONLY when the caller explicitly sent response_format
 * {"type":"json_object"}. Returns undefined when the reply is acceptable, else a
 * short reason for the caller.
 *
 * WHY: gpt-4o in JSON mode intermittently returns EMPTY content with
 * finish_reason "stop" (observed 2026-09-07 during live validation: the same
 * prompt produced valid JSON on one sample and empty content on another; root
 * cause unconfirmed, it is upstream behaviour we do not control). Without this
 * check that reply is a 200 and therefore SETTLES — the caller pays for content
 * they cannot use. A truncated reply (finish_reason "length") is the same story.
 *
 * This validates SYNTAX ONLY. JSON mode guarantees syntactic validity and
 * nothing else: no schema is enforced and no claim is made about the factual
 * correctness of the content. Valid JSON is passed through completely untouched
 * — nothing is repaired, no code fences are stripped, and no retry is issued.
 */
export function jsonModeFailureReason(data: any): string | undefined {
  const choice = data?.choices?.[0];
  if (!choice) return "the upstream reply contained no choices";
  const message = choice.message;
  if (!message || typeof message !== "object") return "the upstream reply had no assistant message";
  const content = message.content;
  const finish = typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown";
  if (content === undefined || content === null) {
    if (typeof message.refusal === "string" && message.refusal.trim() !== "") {
      return `the model returned a refusal instead of JSON (finish_reason ${finish})`;
    }
    return `the assistant message had no content (finish_reason ${finish})`;
  }
  if (typeof content !== "string") return `the assistant content was not a string (finish_reason ${finish})`;
  if (content.trim() === "") return `the model returned empty or whitespace-only content (finish_reason ${finish})`;
  try {
    JSON.parse(content);
  } catch {
    return `the model's content did not parse as JSON (finish_reason ${finish})`;
  }
  return undefined;
}

/**
 * A constraint this endpoint enforces that the caller's request does not satisfy.
 *
 * These exist so the REFUSAL ADVICE and the EXECUTION PATH cannot disagree: the
 * handler below throws on exactly these checks, and the gateway's recovery
 * builder reads the same functions to decide whether an alternative can serve a
 * request UNCHANGED. Before this, recovery could advertise
 * `fits_this_request: true` for a `stream: true` request that every listed
 * alternative would then refuse.
 */
export interface UnsupportedFeature {
  /** Request field responsible. */
  field: "stream" | "messages" | "response_format";
  /** The message the handler would return (verbatim). */
  reason: string;
  /** What the caller must change for any endpoint to accept this request. */
  caller_action: string;
}

/** `stream: true` — no endpoint here streams. */
export function checkStreaming(body: any): UnsupportedFeature | undefined {
  if (body?.stream !== true) return undefined;
  return {
    field: "stream",
    reason: "Streaming is not supported. Set stream to false or omit it.",
    caller_action: "resend with stream:false (or omit it) — no model at this service streams",
  };
}

/** `messages` missing, not an array, or empty. */
export function checkMessagesShape(body: any): UnsupportedFeature | undefined {
  if (Array.isArray(body?.messages) && body.messages.length > 0) return undefined;
  return {
    field: "messages",
    reason: 'messages is required — e.g. {"messages":[{"role":"user","content":"Hello"}]}',
    caller_action: "send a non-empty messages array",
  };
}

/** `response_format` the passthrough will not forward (json_schema, unknown types…). */
export function checkResponseFormat(body: any): UnsupportedFeature | undefined {
  try {
    normalizeResponseFormat(body?.response_format);
    return undefined;
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    return {
      field: "response_format",
      reason: err.message,
      caller_action: 'use {"type":"json_object"} or {"type":"text"}, or omit response_format',
    };
  }
}

/** Non-text content parts (image/audio/file) on a text-only endpoint. */
export function checkTextOnlyContent(body: any): UnsupportedFeature | undefined {
  if (!Array.isArray(body?.messages)) return undefined;
  try {
    assertTextOnlyMessages(body.messages);
    return undefined;
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    return {
      field: "messages",
      reason: err.message,
      caller_action: "send text-only content parts, or use the dedicated endpoint that accepts images",
    };
  }
}

/**
 * Every enforced constraint this request currently violates, in the order the
 * handler checks them. Empty ⇒ the request's SHAPE is acceptable (size limits
 * are per-model and checked separately).
 */
export function unsupportedFeatures(body: any): UnsupportedFeature[] {
  const out: UnsupportedFeature[] = [];
  for (const f of [checkStreaming(body), checkMessagesShape(body), checkTextOnlyContent(body), checkResponseFormat(body)]) {
    if (f) out.push(f);
  }
  return out;
}

/**
 * Build the POST handler for one OpenAI model. Charged only on a 2xx (x402
 * settles on success responses); bad body / cap / stream / bad response_format
 * → 400 uncharged; upstream 400/422 → 400 upstream_rejected (OpenAI's message,
 * uncharged); upstream 429 / 5xx / transport failure / timeout → 502 uncharged
 * (NEVER 200-wrapped).
 */
export function makeOpenAiHandler(cfg: OpenAiPassthroughConfig) {
  const { modelId, inCapChars, outCapTokens, reasoning, vision } = cfg;
  const timeoutMs = cfg.timeoutMs ?? timeouts.openaiChat;

  // Vision-enabled models warm the o200k tokenizer at construction (boot) so the
  // first paid image call does not pay the module load, and a broken dependency
  // shows up in the boot log rather than on a customer's request.
  if (vision) {
    void loadO200kCounter().catch((err) => console.error(`OpenAI ${modelId} vision tokenizer failed to load:`, err));
  }

  return async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body ?? {};
      if (typeof body !== "object" || Array.isArray(body)) {
        throw new ValidationError("Request body must be a JSON object");
      }
      // Same functions the gateway's recovery advice reads, so an alternative
      // is never advertised as able to serve a request this would refuse.
      const streamProblem = checkStreaming(body);
      if (streamProblem) throw new ValidationError(streamProblem.reason);
      const messagesProblem = checkMessagesShape(body);
      if (messagesProblem) throw new ValidationError(messagesProblem.reason);

      // Messages as forwarded: the caller's objects on the text path (unchanged
      // behaviour), or the explicitly rebuilt parts on the vision path.
      let messages: any[] = body.messages;

      if (vision) {
        // VISION-ENABLED MODEL (gpt-4o only). EVERY request on this endpoint —
        // image-bearing or not — is bounded by the real o200k_base tokenizer, so
        // the flat price rests on a measured count rather than a char-ratio
        // proxy. Image parts, when present, are validated and rebuilt first and
        // then reserved at their documented maximum (1,445 high/auto, 85 low).
        let prepared: PreparedVisionMessages | undefined;
        if (countImageParts(body.messages) > 0) {
          prepared = prepareVisionMessages(body.messages, vision, {
            maxMessages: MAX_MESSAGES,
            maxPartsPerMessage: MAX_PARTS_PER_MESSAGE,
          });
          messages = prepared.messages;
        } else {
          // Image-free: anything the accounting cannot measure is still refused.
          assertTextOnlyMessages(body.messages, { imagesAllowed: true, maxImages: vision.maxImages });
        }

        // Character cap retained as an ADDITIONAL cheap structural check; the
        // token budget below is the binding bound.
        const chars = sumMessageChars(messages) + sumNonContentChars(messages);
        if (chars > inCapChars) {
          throw new ValidationError(
            `Input too large: ${chars} chars (max ${inCapChars}). Split the request or summarize first.`,
          );
        }

        // Combined budget: tokenized text + tokenized non-content fields +
        // estimated framing + documented image reserves. Nothing is truncated;
        // an over-budget request is refused before any upstream work.
        const budget = await countVisionInputTokens(messages, prepared?.imageReserveTokens ?? 0);
        if (budget.total > vision.inputTokenBudget) {
          throw new ValidationError(budgetExceededMessage(budget, vision.inputTokenBudget, prepared, vision));
        }
      } else {
        // EVERY OTHER MODEL — unchanged: char cap + char-ratio density estimate.
        assertTextOnlyMessages(body.messages);

        const chars = sumMessageChars(body.messages) + sumNonContentChars(body.messages);
        if (chars > inCapChars) {
          throw new ValidationError(
            `Input too large: ${chars} chars (max ${inCapChars}). Split the request or summarize first.`,
          );
        }
        // The char cap alone under-counts token-dense scripts (CJK ~1 token/char)
        // — enough to push the flat price underwater. Enforce the token budget
        // the price was actually derived for. Non-content fields are ASCII JSON,
        // so the 3.5 chars/token ratio holds for them; count them via the cap above.
        const inTokenBudget = tokenBudgetForCharCap(inCapChars);
        const estTokens =
          estimateTokens(joinMessageText(body.messages)) + Math.ceil(sumNonContentChars(body.messages) / 3.5);
        if (estTokens > inTokenBudget) {
          throw new ValidationError(tokenDensityMessage(estTokens, inTokenBudget));
        }
      }

      // response_format: validated and rebuilt as a named field (400 on anything
      // unsupported — never silently dropped, never spread through). Validated
      // AFTER the message checks so the text path reports the SAME error as it
      // did before bounded vision existed when a request is bad in both ways.
      const responseFormat = normalizeResponseFormat(body.response_format);

      // Reasoning models take max_completion_tokens; chat models take max_tokens.
      // Accept either input name so callers of both generations work.
      const requested = reasoning ? (body.max_completion_tokens ?? body.max_tokens) : (body.max_tokens ?? body.max_completion_tokens);
      const maxTokens = clampMaxTokens(requested, outCapTokens);
      const tokenParam = reasoning
        ? { max_completion_tokens: maxTokens }
        : { max_tokens: maxTokens };

      // Sampling: gpt-4* chat models accept temperature/top_p; reasoning models
      // reject them, so we forward them only when reasoning === false.
      const sampling: { temperature?: number; top_p?: number } = {};
      if (!reasoning) {
        if (typeof body.temperature === "number") sampling.temperature = body.temperature;
        if (typeof body.top_p === "number") sampling.top_p = body.top_p;
      }

      const upstreamBody = {
        model: modelId,
        messages,
        ...tokenParam,
        ...sampling,
        ...(responseFormat ? { response_format: responseFormat } : {}),
      };

      // openAiFetch retries transient failures (429 / 5xx / transport) with short
      // backoff inside timeoutMs — recovers rate-limit blips into settled 200s
      // instead of instant 502s. See src/services/openai-fetch.ts.
      let response: globalThis.Response;
      try {
        response = await openAiFetch(
          OPENAI_CHAT_URL,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`,
            },
            body: JSON.stringify(upstreamBody),
          },
          timeoutMs,
          modelId,
        );
      } catch (err) {
        // Transport failure or our timeout (after retries) → upstream error. A
        // >=400 status is handled below; both branches 502 so payment does NOT settle.
        console.error(`OpenAI ${modelId} request error:`, err);
        res.status(502).json({ error: { message: "Upstream model error", type: "upstream_error" } });
        return;
      }

      if (!response.ok) {
        // OpenAI rejected the REQUEST (400 validation / 422): that is a caller
        // problem, not an outage — e.g. JSON mode without any message mentioning
        // JSON. Surface OpenAI's own message so the agent can fix its call,
        // still uncharged (x402 settles only on 2xx). Everything else (429,
        // 5xx, auth) stays the generic 502 upstream_error.
        if (response.status === 400 || response.status === 422) {
          const { message, param } = await upstreamRejection(response);
          console.error(`OpenAI ${modelId} rejected the request (${response.status}): ${message}`);
          res.status(400).json({
            error: {
              message,
              type: "invalid_request_error",
              code: "upstream_rejected",
              ...(param ? { param } : {}),
            },
          });
          return;
        }
        console.error(`OpenAI ${modelId} upstream status ${response.status}`);
        res.status(502).json({ error: { message: "Upstream model error", type: "upstream_error" } });
        return;
      }

      let data: any;
      try {
        data = await response.json();
      } catch (err) {
        console.error(`OpenAI ${modelId} unparseable body:`, err);
        res.status(502).json({ error: { message: "Upstream model error", type: "upstream_error" } });
        return;
      }

      // Record token usage for per-call cost/margin logging (read at res.finish).
      const usage = data?.usage ?? {};
      res.locals.llmUsage = {
        model: modelId,
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      };

      // JSON-MODE OUTPUT CHECK — only when the caller explicitly asked for
      // {"type":"json_object"}. Deliberately placed AFTER res.locals.llmUsage is
      // set: OpenAI billed us for this generation whether or not we accept it, so
      // the failure event must still carry its model/token/cost figures. Omitted
      // response_format and explicit {"type":"text"} are untouched by this.
      if (responseFormat?.type === "json_object") {
        const reason = jsonModeFailureReason(data);
        if (reason) {
          console.error(`OpenAI ${modelId} json_object reply rejected: ${reason}`);
          res.status(502).json({
            error: {
              message:
                `JSON mode did not return usable JSON: ${reason}. You were not charged. ` +
                `Send the request again, or drop response_format to accept free-form text. ` +
                `Note that JSON mode only ever guarantees syntactic validity — it does not ` +
                `enforce a schema and says nothing about whether the content is correct.`,
              type: "upstream_error",
              code: JSON_MODE_ERROR_CODE,
            },
          });
          return;
        }
      }

      // If the caller asked for more output tokens than the cap, say so in a
      // header — the body stays the untouched OpenAI reply and billing is unchanged.
      const clamped = clampedMaxTokensHeader(requested, outCapTokens);
      if (clamped) res.set(MAX_TOKENS_CLAMPED_HEADER, clamped);

      // Return the OpenAI chat.completion body as-is (already the right shape).
      // Re-stamp the model to the id we actually called, in case the caller sent
      // a different `model` in the body (the path is the contract, not the body).
      res.json({ ...data, model: modelId });
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: { message: err.message, type: "invalid_request_error" } });
        return;
      }
      console.error(`OpenAI ${modelId} handler error:`, err);
      res.status(500).json({ error: { message: "Internal server error", type: "server_error" } });
    }
  };
}

/**
 * Build the full Express router for one /openai/<model> endpoint: the paywalled
 * POST plus GET/HEAD returning a 402 challenge (so the Bazaar health prober sees
 * a payment challenge instead of a 404). This is what the 18 sibling endpoints
 * import — they add a row, they do NOT rebuild the handler.
 */
export function makeOpenAiRouter(cfg: OpenAiRouterConfig): Router {
  const router = Router();

  // signableAccepts, NOT paidAccepts: this is a hand-rolled cold-probe challenge
  // that bypasses the payment middleware, so nothing else injects the EIP-712
  // domain `extra`. Without it external validators read every /openai/* route as
  // "not signable" — x402-list.com's `eip712_domain_extra` check failed on all 15
  // of them while the other 109 endpoints passed. See src/accepts.ts.
  const paymentRequired = {
    x402Version: 2,
    accepts: signableAccepts(cfg.price),
    error: "Payment required",
  };

  router.get(cfg.path, (_req: Request, res: Response) => {
    res.status(402).json(paymentRequired);
  });
  router.head(cfg.path, (_req: Request, res: Response) => {
    res.status(402).end();
  });
  router.post(cfg.path, makeOpenAiHandler(cfg));

  return router;
}
