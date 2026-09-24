// Shared OpenAI chat helpers for the structured LLM endpoints (content-moderate,
// classify, schema-parse). These were on Anthropic Haiku ($1/$5 per MTok at a
// 10k-word cap → worst-case COGS ~$0.02-0.034), which forced uncompetitive flat
// prices ($0.05/$0.10). gpt-4o-mini ($0.15/$0.60) cuts worst-case COGS ~7× so the
// same endpoints clear margin at the market price ($0.005/$0.01) — see the
// 2026-09-02 pricing deep-dive. Model quality for moderation/classification/JSON
// extraction is well-covered by gpt-4o-mini (function-calling + json_object native).
//
// Both helpers throw OpenAiCallError on transport failure, timeout, or a non-2xx
// upstream so the caller can map it to a 502 (payment does NOT settle). Only a
// clean 2xx returns — mirroring the discipline in openai-passthrough.ts.

import { openAiFetch } from "./openai-fetch.js";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

export class OpenAiCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiCallError";
  }
}

export interface OpenAiUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

function usageFrom(modelId: string, data: any): OpenAiUsage {
  const u = data?.usage ?? {};
  return {
    model: modelId,
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
  };
}

/** POST to the OpenAI chat API with a hard wall-clock timeout that actually
 * aborts the request. Throws OpenAiCallError on transport failure/timeout/non-2xx
 * or an unparseable body. */
async function callOpenAi(body: object, timeoutMs: number, modelId: string): Promise<any> {
  // openAiFetch retries transient failures (429 / 5xx / transport) within timeoutMs
  // so a rate-limit blip doesn't become an instant OpenAiCallError → 502 uncharged.
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
        body: JSON.stringify(body),
      },
      timeoutMs,
      modelId,
    );
  } catch (err) {
    throw new OpenAiCallError(`OpenAI ${modelId} request failed: ${(err as Error)?.message ?? err}`);
  }
  if (!response.ok) {
    throw new OpenAiCallError(`OpenAI ${modelId} upstream status ${response.status}`);
  }
  try {
    return await response.json();
  } catch (err) {
    throw new OpenAiCallError(`OpenAI ${modelId} unparseable body: ${(err as Error)?.message ?? err}`);
  }
}

export interface JsonCompleteParams {
  modelId: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

/** JSON-mode completion (response_format: json_object) — for content-moderate /
 * classify, which prompt the model to emit a JSON object. Returns the raw content
 * string (caller parses with parseLooseJson) + usage + whether it hit the token cap. */
export async function openaiJsonComplete(
  p: JsonCompleteParams,
): Promise<{ content: string; usage: OpenAiUsage; truncated: boolean }> {
  const data = await callOpenAi(
    {
      model: p.modelId,
      max_tokens: p.maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: p.system },
        { role: "user", content: p.user },
      ],
    },
    p.timeoutMs,
    p.modelId,
  );
  const choice = data?.choices?.[0];
  return {
    content: choice?.message?.content ?? "",
    usage: usageFrom(p.modelId, data),
    truncated: choice?.finish_reason === "length",
  };
}

export interface ExtractParams {
  modelId: string;
  system: string;
  user: string;
  /** Caller-supplied JSON schema (becomes the forced function's parameters). */
  schema: object;
  maxTokens: number;
  timeoutMs: number;
}

/** Forced-function-call extraction — for schema-parse. The caller's target_schema
 * becomes the `extract` function's parameters and tool_choice forces it, mirroring
 * the previous Anthropic tool_use. Returns the parsed arguments object (or
 * hasCall=false if the model returned no usable tool call). */
export async function openaiExtract(
  p: ExtractParams,
): Promise<{ args: any; hasCall: boolean; usage: OpenAiUsage; truncated: boolean }> {
  const data = await callOpenAi(
    {
      model: p.modelId,
      max_tokens: p.maxTokens,
      tools: [
        {
          type: "function",
          function: {
            name: "extract",
            description: "Extract structured data from the provided text",
            parameters: { type: "object", ...p.schema },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "extract" } },
      messages: [
        { role: "system", content: p.system },
        { role: "user", content: p.user },
      ],
    },
    p.timeoutMs,
    p.modelId,
  );
  const choice = data?.choices?.[0];
  const rawArgs = choice?.message?.tool_calls?.[0]?.function?.arguments;
  let args: any;
  let hasCall = false;
  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs);
      hasCall = true;
    } catch {
      hasCall = false;
    }
  }
  return {
    args,
    hasCall,
    usage: usageFrom(p.modelId, data),
    truncated: choice?.finish_reason === "length",
  };
}
