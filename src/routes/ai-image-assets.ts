import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config, pricing, timeouts } from "../config.js";
import { ValidationError } from "../utils/validators.js";
import { pickField } from "../utils/field-aliases.js";
import {
  getImageProvider,
  ImageProviderError,
  type ImageGenResult,
} from "../utils/image-providers.js";
import { isWalletDenied, logBlockedAttempt } from "../utils/abuse-controls.js";
import { extractPayerFromRequest } from "../paid-call-logger.js";
import { parseLooseJson } from "../utils/parse-loose-json.js";
import { signableAccepts } from "../accepts.js";

const ENDPOINT_PATH = "/ai-image/generate";

// AI Image Asset Generator — agent-ready visual assets (app icons, logos,
// social graphics, blog thumbnails, product mockups, banners, web images).
//
// This is intentionally NOT a raw prompt→image wrapper. Each call:
//   1. validates + bounds the request (prompt length, n, quality, aspect ratio);
//   2. runs ONE Claude Haiku pass that does prompt-engineering for the use case,
//      writes alt text, scores the request, lists warnings, and screens for
//      disallowed content (blocked requests never reach the paid image call);
//   3. renders via a swappable image provider (OpenAI/DALL·E 3 in v1);
//   4. returns the image plus rich, agent-usable metadata.
//
// Pricing is a FLAT per-call price (pricing.aiImageAssets, $0.25). The caps below
// bound the worst-case upstream cost (~$0.08 image + ~$0.001 Haiku) so the flat
// price clears ~3× margin on every call — see the note in src/config.ts.

export const aiImageAssetsRouter = Router();

// --- Caps (bound the upstream cost so the flat price always clears margin) ---
const MAX_PROMPT_CHARS = 2000;
const MIN_PROMPT_CHARS = 3;
const MAX_STYLE_CHARS = 200;
const MAX_BRAND_COLORS = 8;
const MAX_BRAND_COLOR_CHARS = 40;
// v1 renders a single image per call (keeps the flat price's cost bounded).
const MAX_IMAGES = 1;
// v1 ships "standard" only; "hd" would change the worst-case cost math.
const SUPPORTED_QUALITIES = ["standard"] as const;
const DEFAULT_QUALITY = "standard";
// Metadata (Claude Haiku) call cap — short; the image call gets the longer
// timeouts.aiImageAssets budget.
const METADATA_TIMEOUT_MS = 25000;
const METADATA_MODEL = "claude-haiku-4-5-20251001";

// --- Use cases --------------------------------------------------------------
// Each use case carries a default aspect ratio and design guidance the prompt
// engineer applies. Adding one here is the only change needed to support it.
interface UseCaseSpec {
  defaultAspect: AspectRatio;
  guidance: string;
}
const USE_CASES: Record<string, UseCaseSpec> = {
  app_icon: {
    defaultAspect: "1:1",
    guidance:
      "a polished app icon: one centered, instantly recognizable symbol, simple shapes, legible at small sizes, subtle depth, no text or letterforms",
  },
  logo: {
    defaultAspect: "1:1",
    guidance:
      "a clean, scalable logo mark: minimal, flat or single-gradient, high contrast, vector-like, memorable, no photographic detail and no rendered text unless explicitly requested",
  },
  avatar: {
    defaultAspect: "1:1",
    guidance:
      "a friendly avatar/profile image: single subject centered, clear silhouette, reads well as a small circle crop",
  },
  social_graphic: {
    defaultAspect: "1:1",
    guidance:
      "an eye-catching social media graphic: bold focal point, strong composition, leaves breathing room for an overlaid caption",
  },
  og_image: {
    defaultAspect: "16:9",
    guidance:
      "an Open Graph / link-preview image: clear focal subject, uncluttered, strong contrast so it pops in a feed at small size",
  },
  blog_thumbnail: {
    defaultAspect: "16:9",
    guidance:
      "a blog/article thumbnail: a single clear concept illustrating the topic, editorial feel, uncluttered",
  },
  banner: {
    defaultAspect: "16:9",
    guidance:
      "a wide hero/banner image: cinematic composition with negative space on one side for headline text, balanced focal subject",
  },
  product_mockup: {
    defaultAspect: "1:1",
    guidance:
      "a clean product mockup: the product as hero on a simple, well-lit, uncluttered surface or backdrop, soft realistic shadows",
  },
  web_image: {
    defaultAspect: "16:9",
    guidance:
      "a versatile website image: clean, modern, on-brand, suitable as a section or feature illustration",
  },
  illustration: {
    defaultAspect: "1:1",
    guidance: "a cohesive illustration with a clear subject and consistent style",
  },
};
const DEFAULT_USE_CASE = "web_image";
export const SUPPORTED_USE_CASES = Object.keys(USE_CASES);

// Natural shorthands → canonical use case, accepted silently (same philosophy
// as pickRequestParam's field aliases). Learned live: the first consumer
// integration sent use_case:"social" (2026-08-09) and fell to the generic
// default with a warning. Keys are post-normalization (lowercased,
// spaces/hyphens already folded to underscores).
const USE_CASE_ALIASES: Record<string, string> = {
  social: "social_graphic",
  social_media: "social_graphic",
  social_post: "social_graphic",
  post: "social_graphic",
  og: "og_image",
  opengraph: "og_image",
  open_graph: "og_image",
  link_preview: "og_image",
  icon: "app_icon",
  thumbnail: "blog_thumbnail",
  thumb: "blog_thumbnail",
  hero: "banner",
  header: "banner",
  cover: "banner",
  profile: "avatar",
  profile_picture: "avatar",
  profile_pic: "avatar",
  pfp: "avatar",
  product: "product_mockup",
  mockup: "product_mockup",
  logomark: "logo",
  logo_mark: "logo",
  drawing: "illustration",
  sticker: "illustration",
  art: "illustration",
  image: "web_image",
  picture: "web_image",
};

// --- Aspect ratios → provider size -----------------------------------------
export type AspectRatio = "1:1" | "16:9" | "9:16";
// Provider sizes are gpt-image-1's supported set (1024x1024, 1536x1024,
// 1024x1536). 16:9 / 9:16 are the closest landscape/portrait options.
const SIZE_BY_ASPECT: Record<AspectRatio, string> = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
};
// Friendly aliases agents commonly send.
const ASPECT_ALIASES: Record<string, AspectRatio> = {
  "1:1": "1:1",
  square: "1:1",
  icon: "1:1",
  "16:9": "16:9",
  landscape: "16:9",
  wide: "16:9",
  horizontal: "16:9",
  banner: "16:9",
  "9:16": "9:16",
  portrait: "9:16",
  tall: "9:16",
  vertical: "9:16",
  story: "9:16",
};
export const SUPPORTED_ASPECT_RATIOS = Object.keys(SIZE_BY_ASPECT) as AspectRatio[];

// --- Pure helpers (exported for unit tests) --------------------------------

export function gradeFromScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

/** Canonicalize a use_case; unknown/empty falls back to the default. */
export function resolveUseCase(input: unknown): { useCase: string; warning?: string } {
  if (input === undefined || input === null || input === "") {
    return { useCase: DEFAULT_USE_CASE };
  }
  if (typeof input !== "string") {
    return { useCase: DEFAULT_USE_CASE, warning: "use_case was not a string; defaulted to web_image" };
  }
  const key = input.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (USE_CASES[key]) return { useCase: key };
  const aliased = USE_CASE_ALIASES[key];
  if (aliased) return { useCase: aliased };
  return {
    useCase: DEFAULT_USE_CASE,
    warning: `unknown use_case "${input}"; defaulted to web_image (supported: ${SUPPORTED_USE_CASES.join(", ")})`,
  };
}

/**
 * Resolve the effective aspect ratio (caller's value if recognized, else the
 * use case's default) and the provider size string.
 */
export function resolveAspectRatio(
  input: unknown,
  useCase: string,
): { aspect: AspectRatio; size: string; warning?: string } {
  const fallback = USE_CASES[useCase]?.defaultAspect ?? "1:1";
  if (input === undefined || input === null || input === "") {
    return { aspect: fallback, size: SIZE_BY_ASPECT[fallback] };
  }
  if (typeof input === "string") {
    const key = input.trim().toLowerCase();
    const mapped = ASPECT_ALIASES[key];
    if (mapped) return { aspect: mapped, size: SIZE_BY_ASPECT[mapped] };
  }
  return {
    aspect: fallback,
    size: SIZE_BY_ASPECT[fallback],
    warning: `unsupported aspect_ratio "${input}"; used ${fallback} (supported: ${SUPPORTED_ASPECT_RATIOS.join(", ")} and aliases like square/wide/tall)`,
  };
}

/** Clamp the requested image count to the v1 max (1), warning if reduced. */
export function clampImageCount(input: unknown): { n: number; warning?: string } {
  if (input === undefined || input === null) return { n: 1 };
  const num = Number(input);
  if (!Number.isFinite(num) || num < 1) {
    return { n: 1, warning: "n must be a positive integer; used 1" };
  }
  const n = Math.min(MAX_IMAGES, Math.floor(num));
  if (Math.floor(num) > MAX_IMAGES) {
    return { n, warning: `n capped to ${MAX_IMAGES} in v1` };
  }
  return { n };
}

/** Force quality to a supported value, warning if the request asked for more. */
export function normalizeQuality(input: unknown): { quality: string; warning?: string } {
  if (input === undefined || input === null || input === "") return { quality: DEFAULT_QUALITY };
  const q = typeof input === "string" ? input.trim().toLowerCase() : "";
  if ((SUPPORTED_QUALITIES as readonly string[]).includes(q)) return { quality: q };
  return {
    quality: DEFAULT_QUALITY,
    warning: `quality "${input}" is not available in v1; used "${DEFAULT_QUALITY}"`,
  };
}

/** "$0.25" → { amount: "0.25", currency: "USD" } for the response payment block. */
export function priceBlock(priceStr: string): { amount: string; currency: string } {
  return { amount: priceStr.replace(/^\$/, ""), currency: "USD" };
}

// --- GET/HEAD 402 stubs (so the Bazaar prober sees a challenge, not a 404) ---
const aiImageAssetsPaymentRequired = {
  x402Version: 2,
  accepts: signableAccepts(pricing.aiImageAssets),
  error: "Payment required",
};

aiImageAssetsRouter.get("/ai-image/generate", (_req: Request, res: Response) => {
  res.status(402).json(aiImageAssetsPaymentRequired);
});

aiImageAssetsRouter.head("/ai-image/generate", (_req: Request, res: Response) => {
  res.status(402).end();
});

const anthropic = new Anthropic();

// What the Haiku metadata pass returns. Parsed defensively below.
interface AssetMetadata {
  allowed: boolean;
  reason: string;
  optimized_prompt: string;
  alt_text: string;
  score: number;
  warnings: string[];
}

function buildMetadataSystemPrompt(useCase: string): string {
  const guidance = USE_CASES[useCase]?.guidance ?? "a clean, on-brand visual asset";
  return [
    "You are an expert prompt engineer and brand designer for an image-generation API used by autonomous agents.",
    `The caller wants ${useCase.replace(/_/g, " ")} — i.e. ${guidance}.`,
    "Given their request, do ALL of the following and respond with ONLY a JSON object (no markdown, no code fences):",
    "1. allowed (boolean): false ONLY if the request is clearly disallowed — sexual content involving minors, real-person sexual/explicit deepfakes, content promoting violence or hatred toward a protected group, instructions/depictions enabling serious harm, or deliberate forgery of real currency/IDs. Brand logos and trademarked-style requests are ALLOWED (the response disclaims trademark safety). When unsure, allow.",
    "2. reason (string): one short sentence; if not allowed, explain which policy it breaks.",
    "3. optimized_prompt (string): a single vivid, concrete image-generation prompt that realizes the request for the stated use case, folding in the requested style and brand colors, composition suited to the aspect ratio, and the design guidance above. Do NOT include resolution, file format, or aspect-ratio tokens. If the request is not allowed, set this to an empty string.",
    "4. alt_text (string): concise, descriptive accessibility alt text (<= 160 chars) for the image that will be produced.",
    "5. score (number 0-100): how clear, specific, and well-suited the ORIGINAL request is for generating a strong asset (vague/one-word requests score low; detailed, on-brief requests score high).",
    "6. warnings (string[]): brief notes for the caller (e.g. request was vague, brand colors ignored, may resemble a known trademark). Empty array if none.",
    'Shape: {"allowed":true,"reason":"...","optimized_prompt":"...","alt_text":"...","score":0,"warnings":[]}',
  ].join(" ");
}

function buildMetadataUserContent(input: {
  prompt: string;
  useCase: string;
  aspect: string;
  style?: string;
  brandColors?: string[];
}): string {
  const lines = [
    `Use case: ${input.useCase}`,
    `Aspect ratio: ${input.aspect}`,
    input.style ? `Style: ${input.style}` : null,
    input.brandColors && input.brandColors.length
      ? `Brand colors: ${input.brandColors.join(", ")}`
      : null,
    "",
    "Request:",
    input.prompt,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

aiImageAssetsRouter.post("/ai-image/generate", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    if (typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("Request body must be a JSON object");
    }

    // Payer wallet from the signed x402 payload — used for abuse controls.
    const wallet = extractPayerFromRequest(req);

    // Accept common synonyms agents send for the prompt.
    const promptRaw = pickField(body, ["prompt", "text", "description", "input"]);
    if (!promptRaw || typeof promptRaw !== "string" || promptRaw.trim() === "") {
      throw new ValidationError(
        'prompt is required — describe the asset, e.g. {"prompt":"clean modern app icon for a network intelligence API","use_case":"app_icon"} (aliases: text, description, input)',
      );
    }
    const prompt = promptRaw.trim();
    if (prompt.length < MIN_PROMPT_CHARS) {
      throw new ValidationError(`prompt is too short (min ${MIN_PROMPT_CHARS} characters)`);
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new ValidationError(
        `prompt is too long: ${prompt.length} characters (max ${MAX_PROMPT_CHARS}). Shorten the description.`,
      );
    }

    // Denylist gate — block known-abusive wallets before any LLM/image spend.
    // Returns 403, so x402 never settles the payment (HTTP >= 400 = not charged).
    if (isWalletDenied(wallet)) {
      logBlockedAttempt({ endpoint: ENDPOINT_PATH, reason: "denylist", wallet, promptSnippet: prompt });
      res.status(403).json({ error: "This wallet is not permitted to use this endpoint." });
      return;
    }

    // style (optional)
    let style: string | undefined;
    const styleRaw = pickField(body, ["style", "art_style"]);
    if (styleRaw !== undefined) {
      if (typeof styleRaw !== "string") throw new ValidationError("style must be a string");
      style = styleRaw.trim().slice(0, MAX_STYLE_CHARS) || undefined;
    }

    // brand_colors (optional)
    let brandColors: string[] | undefined;
    const colorsRaw = pickField(body, ["brand_colors", "colors", "palette"]);
    if (colorsRaw !== undefined) {
      if (!Array.isArray(colorsRaw)) {
        throw new ValidationError('brand_colors must be an array of color strings, e.g. ["blue","cyan"]');
      }
      brandColors = colorsRaw
        .filter((c): c is string => typeof c === "string" && c.trim() !== "")
        .slice(0, MAX_BRAND_COLORS)
        .map((c) => c.trim().slice(0, MAX_BRAND_COLOR_CHARS));
      if (brandColors.length === 0) brandColors = undefined;
    }

    // Resolve use case, aspect ratio, count, quality (lenient — collect warnings).
    const warnings: string[] = [];
    const { useCase, warning: ucWarn } = resolveUseCase(pickField(body, ["use_case", "usecase", "type"]));
    if (ucWarn) warnings.push(ucWarn);
    const { aspect, size, warning: arWarn } = resolveAspectRatio(
      pickField(body, ["aspect_ratio", "aspect", "ratio", "size"]),
      useCase,
    );
    if (arWarn) warnings.push(arWarn);
    const { n, warning: nWarn } = clampImageCount(body.n);
    if (nWarn) warnings.push(nWarn);
    const { quality, warning: qWarn } = normalizeQuality(pickField(body, ["quality"]));
    if (qWarn) warnings.push(qWarn);

    // 1) Prompt-engineering + safety + alt-text + score, in one cheap Haiku pass.
    let meta: AssetMetadata;
    try {
      const response = await Promise.race([
        anthropic.messages.create({
          model: METADATA_MODEL,
          max_tokens: 1024,
          system: buildMetadataSystemPrompt(useCase),
          messages: [
            { role: "user", content: buildMetadataUserContent({ prompt, useCase, aspect, style, brandColors }) },
          ],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), METADATA_TIMEOUT_MS),
        ),
      ]);

      // Record token usage for per-call cost/margin logging (read at res.finish).
      res.locals.llmUsage = {
        model: METADATA_MODEL,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };

      const textBlock = response.content.find(
        (block): block is Anthropic.ContentBlock & { type: "text" } => block.type === "text",
      );
      if (!textBlock) throw new Error("no text content");
      const parsed = parseLooseJson(textBlock.text) as Partial<AssetMetadata>;

      meta = {
        allowed: parsed.allowed !== false, // default-allow if the model omits it
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
        optimized_prompt:
          typeof parsed.optimized_prompt === "string" && parsed.optimized_prompt.trim()
            ? parsed.optimized_prompt.trim()
            : prompt,
        alt_text: typeof parsed.alt_text === "string" ? parsed.alt_text.slice(0, 200) : "",
        score:
          typeof parsed.score === "number" && Number.isFinite(parsed.score)
            ? Math.max(0, Math.min(100, Math.round(parsed.score)))
            : 70,
        warnings: Array.isArray(parsed.warnings)
          ? parsed.warnings.filter((w): w is string => typeof w === "string").slice(0, 10)
          : [],
      };
    } catch (err) {
      if (err instanceof Anthropic.APIError || (err instanceof Error && err.message === "timeout")) {
        console.error("AI image assets metadata LLM error:", err);
      } else {
        console.error("AI image assets metadata parse error:", err);
      }
      res.status(502).json({ error: "Image asset preparation failed" });
      return;
    }

    // 2) Policy gate — reject disallowed requests BEFORE the paid image call.
    if (!meta.allowed) {
      logBlockedAttempt({
        endpoint: ENDPOINT_PATH,
        reason: "policy_prescreen",
        wallet,
        useCase,
        promptSnippet: prompt,
        detail: meta.reason,
      });
      res.status(400).json({
        error: "Image request rejected by content policy",
        reason: meta.reason || "The request violates the image generation content policy.",
      });
      return;
    }

    warnings.push(...meta.warnings);

    // 3) Render via the selected provider (OpenAI in v1).
    let result: ImageGenResult;
    try {
      const provider = getImageProvider(typeof body.provider === "string" ? body.provider : undefined);
      result = await provider.generate({
        prompt: meta.optimized_prompt,
        size,
        quality,
        timeoutMs: timeouts.aiImageAssets,
      });
    } catch (err) {
      if (err instanceof ImageProviderError) {
        if (err.status === 400) {
          // Provider-side content-policy rejection — record it for abuse review.
          logBlockedAttempt({
            endpoint: ENDPOINT_PATH,
            reason: "policy_provider",
            wallet,
            useCase,
            promptSnippet: meta.optimized_prompt,
            detail: err.message,
          });
          res.status(400).json({ error: err.message });
          return;
        }
        if (err.status === 503) {
          res.status(503).json({ error: "Image generation is not configured on this server" });
          return;
        }
        console.error("AI image assets provider error:", err);
        res.status(502).json({ error: "Image generation failed" });
        return;
      }
      throw err;
    }

    // Fold the render's token usage in ahead of the Claude metadata usage the
    // step-1 stash recorded: the image is the dominant cost (~$0.06-0.08 vs
    // ~$0.002) and was invisible to cost_usdc before — the first live call
    // (2026-08-08) logged a ~99% margin that was really ~65-70%. The image
    // entry goes FIRST so meta.model reads gpt-image-1.
    const claudeUsage = res.locals.llmUsage;
    if (result.usage && claudeUsage && !Array.isArray(claudeUsage)) {
      res.locals.llmUsage = [
        { model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
        claudeUsage,
      ];
    }

    const score = meta.score;
    // De-dup warnings while preserving order.
    const dedupedWarnings = [...new Set(warnings)];

    // Field order is deliberate: metadata FIRST, the multi-megabyte data URI
    // LAST. The paid-call logger stores only a ~1KB response prefix, and with
    // image_url first that prefix was pure base64 — no revised_prompt, score,
    // or warnings ever reached the log, leaving zero quality audit trail on an
    // endpoint whose output we (rightly) never persist.
    res.json({
      // Prefer the provider's own revised prompt; fall back to our optimized one.
      revised_prompt: result.revisedPrompt || meta.optimized_prompt,
      use_case: useCase,
      aspect_ratio: aspect,
      size,
      quality,
      n,
      provider: result.provider,
      model: result.model,
      alt_text: meta.alt_text,
      score,
      grade: gradeFromScore(score),
      warnings: dedupedWarnings,
      // Generated images are not guaranteed to be free of third-party copyright
      // or trademark — callers are responsible for clearing rights before use.
      disclaimer:
        "Generated images are not guaranteed to be copyright- or trademark-safe. Review before commercial use. image_url is a base64 PNG data URI (self-contained, no expiry).",
      price: priceBlock(pricing.aiImageAssets),
      image_url: result.imageUrl,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("AI image assets error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
