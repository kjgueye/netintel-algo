import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { signableAccepts } from "../accepts.js";
import { estimateTokens, tokenBudgetForCharCap, tokenDensityMessage } from "../utils/token-estimate.js";
import { validateImageUrl } from "../services/openai-vision.js";

// OpenAI-compatible chat endpoint over x402, served by Claude. The request body
// is OpenAI chat.completions-shaped; we translate to the Anthropic Messages API,
// then translate the reply back to a chat.completion object.
//
// Pricing is a FLAT per-call price (pricing.messages). x402/CDP settles a fixed,
// pre-agreed amount, so we bound the worst case with hard caps on input size and
// max_tokens and set the flat price to cover that worst case at a healthy markup:
//
//   Sonnet 4.6 buy: $3/MTok in, $15/MTok out. At the caps below the *theoretical*
//   worst case (full 24k-char / ~7.5k-token input + a full 1024-token output) is
//   ~ (7.5k in × $3 + 1024 out × $15)/1e6 ≈ $0.038, so the flat $0.06 price still
//   clears ~1.6× at the ceiling. Real calls sit far under it: observed outputs run
//   ~400 tokens (bounded JSON verdicts), so typical cost is ~$0.01–0.03 and margin
//   ~2–6×. The 24k input cap (up from 6k) fits agent-swarm callers that send a full
//   persona + world-state + inbox per turn — their most common bounce was this cap.
//   The char cap assumes English (~3.2 chars/token); token-dense scripts (CJK ~1
//   token/char) are additionally bounded by the estimateTokens() budget below, or
//   24k chars of CJK (~$0.072 input alone) would exceed the flat price.
//   Adding a model — or raising the input cap further — means re-checking that the
//   flat price still covers its rates at the new ceiling.
//
// Images (since 2026-10-14): up to MAX_IMAGES https image URLs in user messages,
// as OpenAI image_url parts or Anthropic-native {type:"image",source:{type:"url"}}
// blocks. Anthropic fetches the URL (no bytes transit Railway, no SSRF surface on
// our side). Sonnet 4.6 is on the STANDARD resolution tier: every image is
// downscaled to <= 1568 visual tokens (platform docs, "Resolution and token
// cost"), so each image is reserved at IMAGE_RESERVE_TOKENS and the reserves
// count against the SAME input token budget as text. The worst-case input is
// therefore unchanged and the flat price needs no change. Before this, image
// parts were silently dropped and Claude answered "what's in this image?"
// blind — on a 200 we charged for (catalog-evaluator wallet, 2026-10).

export const messagesRouter = Router();

interface MessagesModel {
  /** Exact model id passed to anthropic.messages.create. */
  anthropicModel: string;
  /**
   * Whether the model accepts a sampling param. Opus 4.8/4.7 and Fable 5 reject
   * temperature/top_p with a 400; Sonnet 4.6 / Haiku 4.5 still accept them.
   */
  acceptsSampling: boolean;
}

// v1 exposes one model. Aliases let callers select by friendly name too.
const MODELS: Record<string, MessagesModel> = {
  "claude-sonnet-4-6": { anthropicModel: "claude-sonnet-4-6", acceptsSampling: true },
};
const ALIASES: Record<string, string> = {
  balanced: "claude-sonnet-4-6",
  sonnet: "claude-sonnet-4-6",
  "claude-sonnet": "claude-sonnet-4-6",
};
const DEFAULT_MODEL = "claude-sonnet-4-6";

export const SUPPORTED_MODELS = Object.keys(MODELS);

function resolveModel(input: unknown): MessagesModel | null {
  if (input === undefined || input === null || input === "") return MODELS[DEFAULT_MODEL];
  if (typeof input !== "string") return null;
  const key = ALIASES[input] ?? input;
  return MODELS[key] ?? null;
}

// --- Caps (bound the cost so the flat price always clears margin) -----------
const DEFAULT_MAX_TOKENS = 1024;
const HARD_MAX_TOKENS = 1024;
// Total characters across all message content + system, ~24 KB (~7.5k tokens).
const MAX_INPUT_CHARS = 24000;

export function clampMaxTokens(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(HARD_MAX_TOKENS, Math.floor(n));
}

// Sonnet 4.6 standard tier caps an image at 1568 visual tokens; reserve a
// little above it for the block framing.
export const IMAGE_RESERVE_TOKENS = 1600;
export const MAX_IMAGES = 4;
const MAX_IMAGE_URL_CHARS = 2048;

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join(" ");
  }
  return "";
}

/** The caller-supplied URL if this part is an image (OpenAI or Anthropic shape), else undefined. */
function imagePartUrl(p: any, where: string): string | undefined {
  if (p?.type === "image_url") {
    const iu = p.image_url;
    // OpenAI allows image_url as a bare string in some SDKs; accept both.
    return typeof iu === "string" ? iu : iu?.url;
  }
  if (p?.type === "image") {
    if (p.source?.type !== "url") {
      throw new ValidationError(
        `${where}: only {"type":"url"} image sources are accepted — host the image at an https URL.`,
      );
    }
    return p.source.url;
  }
  return undefined;
}

/**
 * One message's content as Anthropic content. Text-only content stays a plain
 * string (unchanged behaviour); content with images becomes text + image
 * blocks in the caller's order. Parts that are neither text nor an image are
 * REFUSED rather than dropped — a silently dropped part is how the model came
 * to answer image questions without the image.
 */
function toAnthropicContent(
  content: unknown,
  role: string,
  where: string,
): { content: string | Anthropic.ContentBlockParam[]; text: string; images: number } {
  if (!Array.isArray(content)) {
    const text = contentToText(content);
    return { content: text, text, images: 0 };
  }
  const blocks: Anthropic.ContentBlockParam[] = [];
  const texts: string[] = [];
  let images = 0;
  content.forEach((p: any, j: number) => {
    const at = `${where}.content[${j}]`;
    if (typeof p?.text === "string") {
      texts.push(p.text);
      if (p.text) blocks.push({ type: "text", text: p.text });
      return;
    }
    const raw = imagePartUrl(p, at);
    if (raw === undefined) {
      const label = typeof p?.type === "string" ? `'${p.type.slice(0, 40)}'` : "unknown";
      throw new ValidationError(
        `${at}: content part type ${label} is not supported. Send text parts or up to ${MAX_IMAGES} https ` +
          '{"type":"image_url","image_url":{"url":"https://…"}} parts; audio and file parts are not accepted.',
      );
    }
    if (role !== "user") {
      throw new ValidationError(`${at}: images are only accepted in user messages (this message has role "${role}").`);
    }
    const url = validateImageUrl(raw, MAX_IMAGE_URL_CHARS, at);
    blocks.push({ type: "image", source: { type: "url", url } });
    images++;
  });
  const text = texts.join(" ");
  return { content: images > 0 ? blocks : text, text, images };
}

// --- Translation: OpenAI <-> Anthropic -------------------------------------
export function mapFinishReason(stop: string | null): string {
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

// OpenAI puts system turns in the messages array; Anthropic takes a top-level
// `system` string. Hoist system turns; map the rest to user/assistant. Returns
// the total content character count so the caller can enforce the input cap.
export function toAnthropicMessages(rawMessages: any[]): {
  system?: string;
  messages: Anthropic.MessageParam[];
  chars: number;
  images: number;
} {
  const systemParts: string[] = [];
  const messages: Anthropic.MessageParam[] = [];
  let chars = 0;
  let images = 0;
  rawMessages.forEach((m, i) => {
    const role = m?.role;
    // Unrecognized roles become user turns (below), so they may carry images too.
    const effectiveRole = role === "system" || role === "assistant" ? role : "user";
    const converted = toAnthropicContent(m?.content, effectiveRole, `messages[${i}]`);
    const text = converted.text;
    chars += text.length;
    images += converted.images;
    if (images > MAX_IMAGES) {
      throw new ValidationError(
        `Too many images: more than ${MAX_IMAGES} across the request (duplicates count). Send at most ${MAX_IMAGES} per call.`,
      );
    }
    if (role === "system") {
      if (text) systemParts.push(text);
    } else if (role === "assistant") {
      messages.push({ role: "assistant", content: text });
    } else {
      messages.push({ role: "user", content: converted.content });
    }
  });
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages,
    chars,
    images,
  };
}

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge
// instead of a 404. (The POST is paywalled by paymentMiddleware.)
const messagesPaymentRequired = {
  x402Version: 2,
  accepts: signableAccepts(pricing.messages),
  error: "Payment required",
};

messagesRouter.get("/messages", (_req: Request, res: Response) => {
  res.status(402).json(messagesPaymentRequired);
});

messagesRouter.head("/messages", (_req: Request, res: Response) => {
  res.status(402).end();
});

const anthropic = new Anthropic();

messagesRouter.post("/messages", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    if (typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("Request body must be a JSON object");
    }
    if (body.stream === true) {
      throw new ValidationError("Streaming is not supported. Set stream to false or omit it.");
    }

    const model = resolveModel(body.model);
    if (!model) {
      throw new ValidationError(
        `Unsupported model. Supported: ${SUPPORTED_MODELS.join(", ")} (aliases: balanced, sonnet).`,
      );
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new ValidationError('messages is required — e.g. {"messages":[{"role":"user","content":"Hello"}]}');
    }

    const maxTokens = clampMaxTokens(body.max_tokens);
    const { system, messages, chars, images } = toAnthropicMessages(body.messages);
    if (messages.length === 0) {
      throw new ValidationError("At least one user or assistant message is required");
    }
    if (chars > MAX_INPUT_CHARS) {
      throw new ValidationError(
        `Input too large: ${chars} characters across messages (max ${MAX_INPUT_CHARS}). Split the request or summarize first.`,
      );
    }
    // The char cap alone under-counts token-dense scripts (CJK ~1 token/char):
    // 24k chars of CJK ≈ 24k input tokens ≈ $0.072 at Sonnet rates — over the
    // flat price by itself. Enforce the token budget the price was derived for.
    const inTokenBudget = tokenBudgetForCharCap(MAX_INPUT_CHARS);
    const estTokens = estimateTokens(body.messages.map((m: any) => contentToText(m?.content)).join(" "));
    // Images share the same budget, each reserved at its documented maximum.
    const imageTokens = images * IMAGE_RESERVE_TOKENS;
    if (images > 0 && estTokens + imageTokens > inTokenBudget) {
      throw new ValidationError(
        `Input too large: ~${estTokens} estimated text tokens + ${images} image(s) reserved at ${IMAGE_RESERVE_TOKENS} each ` +
          `= ~${estTokens + imageTokens} tokens (max ${inTokenBudget}). Send fewer images or shorten the text.`,
      );
    }
    if (estTokens > inTokenBudget) {
      throw new ValidationError(tokenDensityMessage(estTokens, inTokenBudget));
    }

    // At most one of temperature/top_p (sending both 400s on Claude 4.x), and
    // only for models that accept sampling params at all.
    const sampling: { temperature?: number; top_p?: number } = {};
    if (model.acceptsSampling) {
      if (typeof body.temperature === "number") sampling.temperature = body.temperature;
      else if (typeof body.top_p === "number") sampling.top_p = body.top_p;
    }

    // Deadline via an AbortController handed to the SDK (same pattern as
    // money-parse): on timeout the in-flight request is actually cancelled. The
    // old Promise.race left it running — and its timer armed — after we answered.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeouts.messages);
    let response: Anthropic.Message;
    try {
      response = await anthropic.messages.create(
        {
          model: model.anthropicModel,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages,
          ...sampling,
        },
        { signal: controller.signal },
      );
    } catch (err) {
      // An image Anthropic could not fetch or decode (404, non-image, too big)
      // is the caller's input problem: say so with an uncharged 400 instead of
      // a generic upstream 502.
      if (images > 0 && err instanceof Anthropic.APIError && (err as { status?: unknown }).status === 400) {
        res.status(400).json({
          error: {
            message: `Image could not be used: ${String(err.message).slice(0, 300)}. Check the URL is a public https JPEG, PNG, GIF or WebP.`,
            type: "invalid_request_error",
          },
        });
        return;
      }
      // Our own abort surfaces from the SDK as APIUserAbortError (an APIError).
      if (
        err instanceof Anthropic.APIError ||
        (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError"))
      ) {
        console.error("Messages LLM error:", err);
        res.status(502).json({ error: { message: "Upstream model error", type: "upstream_error" } });
        return;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // Record token usage for per-call cost/margin logging (read at res.finish).
    res.locals.llmUsage = {
      model: model.anthropicModel,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    const text = response.content
      .filter((b): b is Anthropic.ContentBlock & { type: "text" } => b.type === "text")
      .map((b) => b.text)
      .join("");

    const promptTokens = response.usage.input_tokens;
    const completionTokens = response.usage.output_tokens;

    res.json({
      id: "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      // Echo the caller's model string when given, else the resolved id.
      model: typeof body.model === "string" && body.model ? body.model : model.anthropicModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: mapFinishReason(response.stop_reason),
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: { message: err.message, type: "invalid_request_error" } });
      return;
    }
    console.error("Messages error:", err);
    res.status(500).json({ error: { message: "Internal server error", type: "server_error" } });
  }
});
