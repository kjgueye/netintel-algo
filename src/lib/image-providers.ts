// Inlined from NetIntel src/utils/image-providers.ts (verbatim).
// Provider-agnostic image generation. v1 ships ONE provider (OpenAI), but the
// route talks only to the ImageProvider interface, so Stability / Gemini /
// Replicate / fal can be added later by writing another class and a case in
// getImageProvider() — no change to the route.

/** What the route asks a provider to render. */
export interface ImageGenRequest {
  /** Final, already-optimized prompt (the route does prompt engineering upstream). */
  prompt: string;
  /** Provider-native size string, e.g. "1024x1024". Produced by the route from aspect ratio. */
  size: string;
  /** "standard" in v1. Bounded so the flat price clears margin. */
  quality: string;
  /** Hard wall-clock cap for the provider HTTP call. */
  timeoutMs: number;
}

/** Normalized result handed back to the route, provider-independent. */
export interface ImageGenResult {
  /** Hosted image URL or base64 data URI. */
  imageUrl: string;
  /** Provider's rewritten prompt, if it exposes one. */
  revisedPrompt?: string;
  /** Exact model id used. */
  model: string;
  /** Provider key, e.g. "openai". */
  provider: string;
}

/**
 * Provider failure carrying the HTTP status the route should surface.
 *  - 400  → caller's fault (content-policy rejection, bad request). Not retriable.
 *  - 503  → provider not configured (missing API key).
 *  - 502/504 → upstream/transport error or timeout. `retriable` flags transient ones.
 */
export class ImageProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retriable: boolean = false,
  ) {
    super(message);
    this.name = "ImageProviderError";
  }
}

export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}

// --- OpenAI (gpt-image-1) ----------------------------------------------------

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

// Heuristics for mapping a provider 400 to "your request was rejected by policy"
// vs. a generic bad-request. Kept loose; OpenAI's wording varies.
const POLICY_RE = /content policy|safety system|safety guidelines|rejected|moderation|not allowed|violat/i;

// Map our public quality value to gpt-image-1's native scale (low|medium|high).
// "medium" is the v1 default: ~$0.04-0.06/image at the supported sizes, well
// under the $0.25 flat price. "high" (~$0.17) is intentionally not the default.
function mapQuality(q: string): "low" | "medium" | "high" {
  const v = (q || "").toLowerCase();
  if (v === "low") return "low";
  if (v === "high" || v === "hd") return "high";
  return "medium"; // "standard" and anything else
}

class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai";
  // gpt-image-1 is OpenAI's current image model (legacy dall-e-3 is not available
  // on new projects). It returns base64 (no hosted URL) and no revised_prompt.
  // Overridable via OPENAI_IMAGE_MODEL.
  readonly model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      // No key → the endpoint genuinely cannot produce an image; image
      // generation can't degrade gracefully the way enrichment endpoints do.
      throw new ImageProviderError("Image generation is not configured", 503, false);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);

    let res: globalThis.Response;
    try {
      res = await fetch(OPENAI_IMAGES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          prompt: req.prompt,
          n: 1,
          size: req.size,
          quality: mapQuality(req.quality),
          // gpt-image-1 always returns base64; it rejects response_format.
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ImageProviderError("Image provider timed out", 504, true);
      }
      throw new ImageProviderError("Image provider request failed", 502, true);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body?.error?.message ?? "";
      } catch {
        /* non-JSON error body — ignore */
      }
      // A policy rejection is the caller's request being disallowed → 400.
      if (res.status === 400 && POLICY_RE.test(detail)) {
        throw new ImageProviderError(
          "Image request was rejected by the provider's content policy",
          400,
          false,
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new ImageProviderError("Image generation is not configured", 503, false);
      }
      // 429 / 5xx / other → transient upstream error.
      throw new ImageProviderError("Image provider error", 502, true);
    }

    const data = (await res.json()) as {
      data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
    };
    const item = data?.data?.[0];
    // gpt-image-1 returns b64_json; older models may return a hosted url. Prefer
    // a hosted url if present, else wrap the base64 PNG as a self-contained data
    // URI (no expiry — agents can use or decode it directly).
    const imageUrl = item?.url
      ? item.url
      : item?.b64_json
        ? `data:image/png;base64,${item.b64_json}`
        : undefined;
    if (!imageUrl) {
      throw new ImageProviderError("Image provider returned no image", 502, true);
    }
    return {
      imageUrl,
      revisedPrompt: item?.revised_prompt,
      model: this.model,
      provider: this.name,
    };
  }
}

/** Names a caller may pass in `provider` (and the IMAGE_PROVIDER env default). */
export const SUPPORTED_IMAGE_PROVIDERS = ["openai"] as const;

/**
 * Resolve an ImageProvider by name. Falls back to IMAGE_PROVIDER env, then
 * "openai". Throws a 400 ImageProviderError on an unknown name so the route can
 * surface a clear message.
 */
export function getImageProvider(name?: string): ImageProvider {
  const key = (name || process.env.IMAGE_PROVIDER || "openai").trim().toLowerCase();
  switch (key) {
    case "openai":
      return new OpenAIImageProvider();
    default:
      throw new ImageProviderError(
        `Unknown image provider "${key}". Supported: ${SUPPORTED_IMAGE_PROVIDERS.join(", ")}.`,
        400,
        false,
      );
  }
}
