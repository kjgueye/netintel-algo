// Shared defensive parser for LLM JSON replies — tolerates code fences,
// surrounding prose, and multi-object "self-correction" output ("Wait, let me
// correct that: ```json {...}```"), where several JSON objects appear in one
// reply. The LAST parseable object is the model's final answer, so that's the
// one we return. Used by every LLM-backed route.
export function parseLooseJson(text: string): unknown {
  let raw = text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  try {
    return JSON.parse(raw);
  } catch {
    const candidates = extractBalancedObjects(raw);
    for (let i = candidates.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(candidates[i]);
      } catch {
        // Not valid JSON despite balanced braces (e.g. prose in braces) — try earlier.
      }
    }
    throw new Error("unparseable");
  }
}

// Every balanced top-level {...} span in raw, respecting JSON string literals
// (so braces inside string values don't open/close spans). Quotes at depth 0
// are prose, not string delimiters.
function extractBalancedObjects(raw: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        spans.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return spans;
}
