// Inlined from NetIntel src/utils/field-aliases.ts (verbatim).
// Return the first present (non-null/undefined) value among a list of accepted
// field names, from a request body or query object. Lets endpoints tolerate the
// common synonyms agents send for a parameter instead of hard-400ing.
// Canonical name should be listed first.
export function pickField(obj: unknown, keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
  }
  return undefined;
}
