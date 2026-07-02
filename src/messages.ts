// Ported verbatim from NetIntel src/routes/messages.ts. Deviations: helpers
// from ./lib; lazy Anthropic singleton; stub body from env.
//
// OpenAI-compatible chat endpoint over x402, served by Claude. The request body
// is OpenAI chat.completions-shaped; we translate to the Anthropic Messages API,
// then translate the reply back to a chat.completion object.
//
// Pricing is a FLAT per-call price ($0.06). x402 settles a fixed, pre-agreed
// amount, so we bound the worst case with hard caps on input size and
// max_tokens and set the flat price to cover that worst case at a healthy markup:
//
//   Sonnet 4.6 buy: $3/MTok in, $15/MTok out. At the caps below the worst-case
//   upstream cost is ~ (1.5k in × $3 + 1024 out × $15)/1e6 ≈ $0.020. The flat
//   $0.06 price is ~3× that, so every call clears margin (actual cost ≤ cap).
//   Adding a model means re-checking that the flat price still covers its rates.
import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { timeouts } from "./lib/config.js";
import { ValidationError } from "./lib/validators.js";
import { paymentRequiredStub } from "./lib/payment-stub.js";

export const messagesRouter = Router();

export const MESSAGES_PRICE = "$0.06";

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
  // DEFAULT_MODEL is a key of MODELS by construction; ! for noUncheckedIndexedAccess
  if (input === undefined || input === null || input === "") return MODELS[DEFAULT_MODEL]!;
  if (typeof input !== "string") return null;
  const key = ALIASES[input] ?? input;
  return MODELS[key] ?? null;
}

// --- Caps (bound the cost so the flat price always clears margin) -----------
const DEFAULT_MAX_TOKENS = 1024;
const HARD_MAX_TOKENS = 1024;
// Total characters across all message content + system, ~6 KB (~1.5k tokens).
const MAX_INPUT_CHARS = 6000;

export function clampMaxTokens(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(HARD_MAX_TOKENS, Math.floor(n));
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join(" ");
  }
  return "";
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
} {
  const systemParts: string[] = [];
  const messages: Anthropic.MessageParam[] = [];
  let chars = 0;
  for (const m of rawMessages) {
    const role = m?.role;
    const text = contentToText(m?.content);
    chars += text.length;
    if (role === "system") {
      if (text) systemParts.push(text);
    } else if (role === "assistant") {
      messages.push({ role: "assistant", content: text });
    } else {
      // user, or any unrecognized role, becomes a user turn
      messages.push({ role: "user", content: text });
    }
  }
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages,
    chars,
  };
}

// GET/HEAD return 402 so the Bazaar health prober sees a payment challenge
// instead of a 404. (The POST is paywalled by paymentMiddleware.)
messagesRouter.get("/messages", (_req: Request, res: Response) => {
  res.status(402).json(paymentRequiredStub(MESSAGES_PRICE));
});

messagesRouter.head("/messages", (_req: Request, res: Response) => {
  res.status(402).end();
});

let anthropicSingleton: Anthropic | null = null;
function getAnthropic(): Anthropic {
  anthropicSingleton ??= new Anthropic();
  return anthropicSingleton;
}

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
    const { system, messages, chars } = toAnthropicMessages(body.messages);
    if (messages.length === 0) {
      throw new ValidationError("At least one user or assistant message is required");
    }
    if (chars > MAX_INPUT_CHARS) {
      throw new ValidationError(
        `Input too large: ${chars} characters across messages (max ${MAX_INPUT_CHARS}). Split the request or summarize first.`,
      );
    }

    // At most one of temperature/top_p (sending both 400s on Claude 4.x), and
    // only for models that accept sampling params at all.
    const sampling: { temperature?: number; top_p?: number } = {};
    if (model.acceptsSampling) {
      if (typeof body.temperature === "number") sampling.temperature = body.temperature;
      else if (typeof body.top_p === "number") sampling.top_p = body.top_p;
    }

    let response: Anthropic.Message;
    try {
      response = await Promise.race([
        getAnthropic().messages.create({
          model: model.anthropicModel,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages,
          ...sampling,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeouts.messages),
        ),
      ]);
    } catch (err) {
      if (err instanceof Anthropic.APIError || (err instanceof Error && err.message === "timeout")) {
        console.error("Messages LLM error:", err);
        res.status(502).json({ error: { message: "Upstream model error", type: "upstream_error" } });
        return;
      }
      throw err;
    }

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
