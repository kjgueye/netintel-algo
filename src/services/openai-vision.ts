import { ValidationError } from "../utils/validators.js";

// Bounded image (vision) input for the dedicated /openai/gpt-4o passthrough.
//
// WHY: the /openai/* endpoints are flat-priced from what the caps can measure,
// and until this module every non-text part was refused (assertTextOnlyMessages).
// That refusal blocked ~78% of the traffic from the wallet that is ~48% of
// 30-day revenue, whose observed vision COGS was <= $0.016 on a $0.10 call.
// This module admits images WITHOUT fetching them and WITHOUT trusting the
// caller's cost: every image is reserved at its documented per-model MAXIMUM
// token cost, and the whole request (text + other message fields + framing +
// image reserves) must fit a fixed combined input budget. Nothing here is
// enabled unless a model row carries a `vision` config — today only gpt-4o.
//
// gpt-4o image token rule (verified 2026-09-07 against
// https://developers.openai.com/api/docs/guides/images-vision — table row
// "gpt-4o, gpt-4.1 | base 85 | tile 170"):
//   detail "low"          → base tokens only (85), regardless of size.
//   detail "high"/"auto"  → scale to fit 2048x2048 (never enlarge), then if the
//                           shortest side exceeds 768px scale it to 768px; count
//                           512px tiles; tokens = 85 + 170 x tiles.
//   Omitted detail = "auto", and for gpt-4o the guide applies the SAME tile
//   rule to auto and high, so auto can never exceed high.
// Max tiles: short side <= 768 → ceil(768/512) = 2; long side <= 2048 →
// ceil(2048/512) = 4; 2 x 4 = 8 tiles → 85 + 8 x 170 = 1,445 tokens. That is
// the reserve for high/auto (see gpt4oImageTokens + its sweep test). These
// constants are gpt-4o's (also gpt-4.1's); other models use different rules
// (patch-based for gpt-4.1-mini/gpt-5.x) — never reuse them for another id.

export type ImageDetail = "low" | "high" | "auto";

/** Per-model knobs for bounded image input. Absent → the model is text-only. */
export interface OpenAiVisionConfig {
  /** Max image_url parts per request, counted across ALL messages, duplicates included. */
  maxImages: number;
  /**
   * Combined input budget (o200k_base tokens) for image-bearing requests: text +
   * non-content message fields + framing overhead + image reserves. Text-only
   * requests keep the char-cap path and never touch this.
   */
  inputTokenBudget: number;
  /** Tokens reserved per image by detail (omitted detail reserves as "auto"). */
  imageTokens: Record<ImageDetail, number>;
  /** Max characters of one image URL (bounds the forwarded body; URLs are not tokenized). */
  maxUrlChars: number;
}

export const GPT4O_IMAGE_BASE_TOKENS = 85;
export const GPT4O_IMAGE_TILE_TOKENS = 170;
export const GPT4O_TILE_PX = 512;
export const GPT4O_FIT_PX = 2048;
export const GPT4O_SHORT_SIDE_PX = 768;
/** 85 + 170 x 8 tiles — the ceiling of gpt4oImageTokens over every image size. */
export const GPT4O_MAX_IMAGE_TOKENS = GPT4O_IMAGE_BASE_TOKENS + GPT4O_IMAGE_TILE_TOKENS * 8;

/**
 * The documented gpt-4o rule, for reference and for the tests that prove the
 * 1,445 ceiling. The passthrough never sees image bytes (it does not fetch
 * images), so it reserves the ceiling, not this per-size value. Scaling is done
 * in exact arithmetic: rounding pixel sizes down can only lower a tile count,
 * so this is >= what OpenAI bills for the same size.
 */
export function gpt4oImageTokens(width: number, height: number, detail: ImageDetail = "auto"): number {
  if (detail === "low") return GPT4O_IMAGE_BASE_TOKENS;
  let w = Math.max(1, width);
  let h = Math.max(1, height);
  const fit = Math.min(1, GPT4O_FIT_PX / Math.max(w, h));
  w *= fit;
  h *= fit;
  const short = Math.min(w, h);
  if (short > GPT4O_SHORT_SIDE_PX) {
    const s = GPT4O_SHORT_SIDE_PX / short;
    w *= s;
    h *= s;
  }
  const tiles = Math.ceil(w / GPT4O_TILE_PX) * Math.ceil(h / GPT4O_TILE_PX);
  return GPT4O_IMAGE_BASE_TOKENS + GPT4O_IMAGE_TILE_TOKENS * tiles;
}

/** The only vision config in the lineup — attached to the gpt-4o registry row. */
export const GPT4O_VISION: OpenAiVisionConfig = {
  maxImages: 4,
  inputTokenBudget: 16000,
  imageTokens: {
    low: GPT4O_IMAGE_BASE_TOKENS,
    high: GPT4O_MAX_IMAGE_TOKENS,
    auto: GPT4O_MAX_IMAGE_TOKENS,
  },
  maxUrlChars: 2048,
};

/** Same config with vision disabled — for surfaces that must stay text-only (the gateway). */
export function withoutVision<T extends { vision?: OpenAiVisionConfig }>(cfg: T): Omit<T, "vision"> {
  const { vision: _vision, ...rest } = cfg;
  return rest;
}

// Message roles per the Chat Completions reference; image parts are accepted in
// user messages only (developer/system take text parts, assistant text/refusal,
// tool text — all per the reference and both official SDKs).
const MESSAGE_ROLES = new Set(["developer", "system", "user", "assistant", "tool", "function"]);
const IMAGE_ROLES = new Set(["user"]);
const DETAIL_VALUES = new Set<string>(["low", "high", "auto"]);

const IMAGE_PART_SHAPE = '{"type":"image_url","image_url":{"url":"https://…","detail":"low"|"high"|"auto"}}';

function unexpectedFields(obj: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

function quoteFields(keys: string[]): string {
  return keys.map((k) => `"${k.slice(0, 40)}"`).join(", ");
}

/**
 * Validate one image URL and return the canonical form that is forwarded.
 * Accepted: an absolute https URL with a host and no embedded credentials.
 * Rejected: data: URLs (inline bytes are unmeasured input and the 1 MB body
 * limit would be the only bound), http/ftp/other schemes, credentials, embedded
 * whitespace, over-long strings, anything the WHATWG parser refuses. Nothing is
 * fetched here — OpenAI fetches the image — so there is no NetIntel-side SSRF
 * surface and no image bytes ever transit Railway.
 */
export function validateImageUrl(raw: unknown, maxChars: number, where: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ValidationError(`${where}: image_url.url must be a non-empty https URL string.`);
  }
  if (raw.length > maxChars) {
    throw new ValidationError(`${where}: image URL is too long (${raw.length} chars, max ${maxChars}).`);
  }
  if (/^\s*data:/i.test(raw)) {
    throw new ValidationError(
      `${where}: inline data: image URLs are not supported on this endpoint — host the image at an https URL and send that instead.`,
    );
  }
  if (/\s/.test(raw)) {
    throw new ValidationError(`${where}: image URL must not contain whitespace.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(`${where}: malformed image URL. Send an absolute https URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new ValidationError(
      `${where}: image URLs must use https (got "${parsed.protocol.replace(":", "").slice(0, 20)}").`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ValidationError(`${where}: image URLs must not embed credentials.`);
  }
  if (parsed.hostname === "") {
    throw new ValidationError(`${where}: malformed image URL (no host).`);
  }
  return parsed.href;
}

export interface PreparedVisionMessages {
  /** Messages with every array content rebuilt from validated parts; string content untouched. */
  messages: any[];
  imageCount: number;
  /** Sum of the per-image reserves (imageTokens by detail, omitted = auto). */
  imageReserveTokens: number;
  imagesByDetail: Record<ImageDetail, number>;
}

/** Cheap scan: number of parts whose type is "image_url" (before any validation). */
export function countImageParts(messages: unknown[]): number {
  let n = 0;
  for (const m of messages) {
    const content = (m as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const p of content) if ((p as { type?: unknown } | null)?.type === "image_url") n++;
  }
  return n;
}

/**
 * Validate an image-bearing request and REBUILD its array content explicitly —
 * only {type:"text",text} and {type:"image_url",image_url:{url[,detail]}} parts,
 * each reconstructed field by field (never the caller's objects spread through).
 * Throws ValidationError (→ 400, uncharged, no upstream call) on: bad roles,
 * image parts outside user messages, more than maxImages images (duplicates
 * count), any other part type (input_audio, file, refusal, …), unexpected fields
 * on a part or its image_url, and every URL/detail problem. Non-content message
 * fields (name, tool_calls, …) are preserved and counted by the token budget.
 */
export function prepareVisionMessages(
  messages: unknown[],
  vision: OpenAiVisionConfig,
  limits: { maxMessages: number; maxPartsPerMessage: number },
): PreparedVisionMessages {
  if (messages.length > limits.maxMessages) {
    throw new ValidationError(
      `Too many messages: ${messages.length} (max ${limits.maxMessages}). Trim the conversation history.`,
    );
  }
  const out: any[] = [];
  let imageCount = 0;
  let imageReserveTokens = 0;
  const imagesByDetail: Record<ImageDetail, number> = { low: 0, high: 0, auto: 0 };

  messages.forEach((m, i) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      throw new ValidationError(`messages[${i}] must be an object {"role": ..., "content": ...}.`);
    }
    const msg = m as Record<string, unknown>;
    const role = msg.role;
    if (typeof role !== "string" || !MESSAGE_ROLES.has(role)) {
      throw new ValidationError(
        `messages[${i}].role must be one of developer, system, user, assistant, tool, function.`,
      );
    }
    const content = msg.content;
    if (content === undefined || content === null || typeof content === "string") {
      out.push(m);
      return;
    }
    if (!Array.isArray(content)) {
      throw new ValidationError(
        `messages[${i}].content must be a string or an array of {"type":"text"} / {"type":"image_url"} parts.`,
      );
    }
    if (content.length > limits.maxPartsPerMessage) {
      throw new ValidationError(
        `Too many content parts in one message: ${content.length} (max ${limits.maxPartsPerMessage}).`,
      );
    }
    const parts = content.map((part, j) => {
      const where = `messages[${i}].content[${j}]`;
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        throw new ValidationError(`${where} must be an object part.`);
      }
      const p = part as Record<string, unknown>;
      const type = p.type;
      if (type === "text") {
        if (typeof p.text !== "string") {
          throw new ValidationError(`${where}: a text part needs a string "text".`);
        }
        const extra = unexpectedFields(p, ["type", "text"]);
        if (extra.length > 0) {
          throw new ValidationError(
            `${where}: unexpected text part field(s) ${quoteFields(extra)}. Send exactly {"type":"text","text":"..."}.`,
          );
        }
        return { type: "text", text: p.text };
      }
      if (type === "image_url") {
        if (!IMAGE_ROLES.has(role)) {
          throw new ValidationError(
            `${where}: image_url parts are only accepted in user messages (this message has role "${role}").`,
          );
        }
        imageCount++;
        if (imageCount > vision.maxImages) {
          throw new ValidationError(
            `Too many images: this request has more than ${vision.maxImages} image_url parts across its messages ` +
              `(duplicates count). Send at most ${vision.maxImages} images per call.`,
          );
        }
        const extra = unexpectedFields(p, ["type", "image_url"]);
        if (extra.length > 0) {
          throw new ValidationError(
            `${where}: unexpected image part field(s) ${quoteFields(extra)}. Send exactly ${IMAGE_PART_SHAPE}.`,
          );
        }
        const iu = p.image_url;
        if (!iu || typeof iu !== "object" || Array.isArray(iu)) {
          throw new ValidationError(`${where}: image_url must be an object. Send exactly ${IMAGE_PART_SHAPE}.`);
        }
        const iuObj = iu as Record<string, unknown>;
        const extraIu = unexpectedFields(iuObj, ["url", "detail"]);
        if (extraIu.length > 0) {
          throw new ValidationError(
            `${where}: unexpected image_url field(s) ${quoteFields(extraIu)}. Send exactly ${IMAGE_PART_SHAPE}.`,
          );
        }
        const url = validateImageUrl(iuObj.url, vision.maxUrlChars, where);
        let detail: ImageDetail | undefined;
        if (iuObj.detail !== undefined) {
          if (typeof iuObj.detail !== "string" || !DETAIL_VALUES.has(iuObj.detail)) {
            throw new ValidationError(
              `${where}: image_url.detail must be "low", "high" or "auto" (got ${JSON.stringify(iuObj.detail).slice(0, 40)}). Omit it for auto.`,
            );
          }
          detail = iuObj.detail as ImageDetail;
        }
        const reserveAs: ImageDetail = detail ?? "auto";
        imageReserveTokens += vision.imageTokens[reserveAs];
        imagesByDetail[reserveAs]++;
        // Preserve the caller's detail exactly (omitted stays omitted = auto upstream).
        return { type: "image_url", image_url: detail ? { url, detail } : { url } };
      }
      const label = typeof type === "string" ? `'${type.slice(0, 40)}'` : "unknown";
      throw new ValidationError(
        `${where}: content part type ${label} is not supported on this endpoint. Send {"type":"text"} parts or ` +
          `up to ${vision.maxImages} https {"type":"image_url"} parts (user messages only); audio and file parts are not accepted.`,
      );
    });
    out.push({ ...msg, content: parts });
  });

  return { messages: out, imageCount, imageReserveTokens, imagesByDetail };
}

// ---------------------------------------------------------------------------
// Token accounting for image-bearing requests.
//
// Text is counted with the real gpt-4o tokenizer (o200k_base, via gpt-tokenizer
// — pure JS, only the o200k rank module is loaded, lazily and once). The
// char-ratio estimator used on the text-only path is deliberately NOT treated as
// a bound here: with 1,445-token images in the same budget, a 3.5-chars/token
// guess could be off by thousands of tokens.
//
// What the tokenizer cannot see is the request FRAMING: OpenAI's cookbook
// (num_tokens_from_messages) documents 3 tokens per message + 1 per `name` + 3
// reply-priming tokens for gpt-4o-2024-08-06 with STRING content, calls that "an
// estimate, not a timeless guarantee", and documents nothing for content-part
// arrays or for the framing around an image part beyond the image tokens
// themselves. So framing is over-provisioned: 4 per message, 1 per name, 4 per
// content part, 3 priming, plus 2% of the counted text/field tokens. The
// remaining uncertainty is bounded to that framing (tens of tokens on a
// 16,000-token budget, absorbed by the flat price's ~1.65x margin) and should be
// checked against usage.prompt_tokens on real image calls after deploy.
// ---------------------------------------------------------------------------

export const VISION_TOKENS_PER_MESSAGE = 4;
export const VISION_TOKENS_PER_NAME = 1;
export const VISION_TOKENS_PER_PART = 4;
export const VISION_REPLY_PRIMING_TOKENS = 3;
export const VISION_COUNT_SLACK = 0.02;

type TokenCounter = (text: string) => number;
let counterPromise: Promise<TokenCounter> | undefined;

/**
 * Lazily load the o200k_base counter (gpt-4o's encoding); one module instance
 * per process.
 *
 * `disallowedSpecial: new Set()` is REQUIRED: gpt-tokenizer defaults to
 * disallowing every special-token literal and THROWS a plain Error the moment a
 * caller's text contains one ("<|endoftext|>", "<|im_start|>", ...). That threw
 * out of the budget check into the handler's generic catch -> HTTP 500, while
 * the text-only path forwards the same text happily — a caller-triggerable 5xx
 * for any agent that merely discusses special tokens. Disallowed-but-not-special
 * makes them encode as ORDINARY TEXT (9 tokens for "describe <|endoftext|> this"),
 * which is both what the API does with user content and the safe direction for a
 * budget (allowedSpecial would count 1 token and under-count by ~6).
 */
export function loadO200kCounter(): Promise<TokenCounter> {
  counterPromise ??= import("gpt-tokenizer/encoding/o200k_base")
    .then((m) => (text: string) => m.countTokens(text, { disallowedSpecial: new Set<string>() }))
    .catch((err) => {
      counterPromise = undefined; // let the next request retry the load
      throw err;
    });
  return counterPromise;
}

export interface VisionTokenBreakdown {
  /** o200k tokens of all string content and text parts. */
  text: number;
  /** o200k tokens of non-content message fields (role, name, tool_calls, …), keys included. */
  fields: number;
  /** Per-message / per-part / per-name / priming overhead plus the 2% slack. */
  framing: number;
  /** Sum of the per-image reserves. */
  images: number;
  total: number;
}

/** Count everything the budget covers for already-prepared (rebuilt) messages. */
export async function countVisionInputTokens(messages: any[], imageReserveTokens: number): Promise<VisionTokenBreakdown> {
  const count = await loadO200kCounter();
  let text = 0;
  let fields = 0;
  let framing = VISION_REPLY_PRIMING_TOKENS;
  for (const m of messages) {
    framing += VISION_TOKENS_PER_MESSAGE;
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      if (k === "content") {
        if (typeof v === "string") {
          text += count(v);
        } else if (Array.isArray(v)) {
          for (const p of v) {
            framing += VISION_TOKENS_PER_PART;
            if ((p as { type?: unknown })?.type === "text") text += count(String((p as { text?: unknown }).text ?? ""));
          }
        }
        continue;
      }
      fields += count(k) + count(typeof v === "string" ? v : JSON.stringify(v));
      if (k === "name") framing += VISION_TOKENS_PER_NAME;
    }
  }
  framing += Math.ceil((text + fields) * VISION_COUNT_SLACK);
  const images = imageReserveTokens;
  return { text, fields, framing, images, total: text + fields + framing + images };
}

/**
 * Instructive 400 text for a combined-budget rejection, for image-bearing AND
 * image-free requests. The breakdown deliberately keeps the three kinds of
 * number apart, because they have different epistemic status:
 *   - tokenized: exact o200k_base counts of what is forwarded (text, fields)
 *   - reserved:  documented per-image maxima from OpenAI's published tile rule
 *   - estimated: framing allowances OpenAI does not document for part arrays
 */
export function budgetExceededMessage(
  b: VisionTokenBreakdown,
  budget: number,
  prepared: Pick<PreparedVisionMessages, "imageCount" | "imagesByDetail"> | undefined,
  vision: OpenAiVisionConfig,
): string {
  const parts = [
    `tokenized text ${b.text}`,
    `tokenized non-content message fields ${b.fields}`,
    `estimated framing ${b.framing}`,
  ];
  if (prepared && prepared.imageCount > 0) {
    parts.push(`${prepared.imageCount} image(s) reserved at ${b.images}`);
  }
  const advice = prepared && prepared.imageCount > 0
    ? `Use detail "low", send fewer images, or shorten the text.`
    : `Shorten the input or split the request across calls.`;
  const imageNote = prepared && prepared.imageCount > 0
    ? ` Each image is reserved at its documented gpt-4o maximum: ${vision.imageTokens.high} tokens at detail high/auto ` +
      `(${prepared.imagesByDetail.high + prepared.imagesByDetail.auto} such image(s) here), ${vision.imageTokens.low} at detail low.`
    : "";
  return (
    `Input too large: ~${b.total} input tokens (${parts.join(" + ")}) exceeds the ${budget}-token budget for this endpoint.` +
    `${imageNote} ${advice}`
  );
}
