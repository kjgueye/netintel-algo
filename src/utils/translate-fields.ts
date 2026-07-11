// Field-name resolution for the translate endpoints.
//
// Production data showed the dominant failure mode on /translate/short was a
// `target is required` 400 — callers (agents/frameworks) supplied the text fine
// but the target language under a different key, or not at all. To stop bleeding
// that demand we accept the common synonyms agents use for the language fields.
// The canonical name remains `target` / `source` (and the response keeps using
// `target_language` / `source_language` for clarity).

function pick(body: unknown, keys: string[]): unknown {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  for (const k of keys) {
    if (b[k] !== undefined && b[k] !== null) return b[k];
  }
  return undefined;
}

// Synonyms accepted for the TARGET language. `target` is canonical; the rest are
// common conventions seen in agent frameworks (incl. our own response field
// `target_language`, which agents sometimes echo back as input). `target_lang`
// (snake, single word) was the #1 surviving 400 in production — agents send it
// constantly — so it sits alongside the camelCase `targetLang`. `language` is the
// bare key some frameworks use for the destination language.
export const TARGET_ALIASES = ["target", "target_language", "target_lang", "targetLanguage", "targetLang", "to", "lang", "language"];

// Synonyms accepted for the (optional) SOURCE language.
export const SOURCE_ALIASES = ["source", "source_language", "source_lang", "sourceLanguage", "sourceLang", "from"];

// Synonyms accepted for the TEXT to translate. `text` is canonical; the rest are
// the common keys agents/frameworks use to carry a payload string. Production
// data showed a large `text is required` 400 cluster (22+ distinct wallets, none
// retried) — callers had paid intent but named the field differently. We
// deliberately EXCLUDE ambiguous names: `source`/`from` are the source-LANGUAGE
// fields, and over-generic keys like `body` are left out. Canonical `text` is
// always tried first, so an explicit `text` can never be shadowed by an alias.
export const TEXT_ALIASES = [
  "text", "q", "input", "content", "text_to_translate", "textToTranslate", "str", "message", "prompt",
];

export function resolveTargetField(body: unknown): unknown {
  return pick(body, TARGET_ALIASES);
}

export function resolveSourceField(body: unknown): unknown {
  return pick(body, SOURCE_ALIASES);
}

export function resolveTextField(body: unknown): unknown {
  return pick(body, TEXT_ALIASES);
}
