// THE CALLER'S PERMISSION TO BE OFFERED A DIFFERENT MODEL.
//
// Why this exists. With a live agent (openai/gpt-4o-mini, 30 trials) the advice
// body's substitute list did two opposite things:
//   - a caller whose budget could not reach the requested model completed its
//     task instead of giving up (0/5 → 5/5), and
//   - a caller whose task REQUIRED gpt-5.6-luna bought gpt-5.4-nano instead and
//     the harness recorded an HTTP 200 (5/5 → 0/5).
// Ordering was not the cause and re-ordering is not the fix: the message already
// led with the requested model's own endpoint and listed substitutes after it.
// The only thing that separates the two callers is whether substitution is
// acceptable for their task — a fact this service cannot observe and must not
// guess. So it is asked for explicitly and defaults to NO.
//
// WHAT THIS IS NOT:
//   - not a budget signal. A caller who cannot afford the requested model has
//     not thereby agreed to a different one; price and permission are unrelated.
//   - not inferred from message content. Nothing here reads the prompt, and no
//     wording in a message ("any model is fine") turns it on.
//   - not a licence to act. Even opted in, the service never changes `model`
//     for the caller; it only LISTS options the caller may choose to re-send.
//
// WHY A HEADER, not a body field. It is a gateway control, not part of the
// OpenAI request contract: it needs no change to the request schema (so SDK
// types and existing bodies are untouched), and it cannot reach a provider,
// because the upstream request is built from named body fields and fresh
// headers (src/services/openai-passthrough.ts). A body field would have to be
// stripped correctly forever; a header has nothing to strip.

/** The one control that unlocks substitute suggestions. */
export const SUBSTITUTION_OPT_IN_HEADER = "X-NetIntel-Allow-Model-Substitution";

/** Values that mean something. Anything else is "not opted in", never an error. */
const TRUE_TOKEN = "true";
const FALSE_TOKEN = "false";

export interface SubstitutionOptIn {
  /** The ONLY field that may unlock substitute suggestions. */
  allowed: boolean;
  /** Exactly what the caller supplied (truncated). Never re-interpreted. */
  supplied: string | null;
  /** The supplied value was one of the documented tokens. */
  recognized: boolean;
}

export const NO_OPT_IN: SubstitutionOptIn = Object.freeze({
  allowed: false,
  supplied: null,
  recognized: false,
});

/**
 * Parse the header value.
 *
 * STRICT BY CONSTRUCTION: `allowed` is true only for the exact token "true"
 * (case-insensitive, trimmed). Every other value — "yes", "1", "TRUE-ish",
 * "false", an empty string, two conflicting duplicate headers joined by Node
 * into "true, false" — leaves it false. A caller who fat-fingers the value gets
 * today's behaviour, never substitution they did not ask for.
 *
 * An unrecognised value is NOT rejected with an error: a control the caller got
 * wrong must not break a request that is otherwise valid, and failing closed is
 * already the safe outcome. `recognized` records the difference so the caller
 * can be told their value was ignored.
 */
export function parseSubstitutionOptIn(raw: string | string[] | undefined | null): SubstitutionOptIn {
  if (raw === undefined || raw === null) return NO_OPT_IN;
  const joined = Array.isArray(raw) ? raw.join(", ") : raw;
  if (typeof joined !== "string") return NO_OPT_IN;
  const supplied = joined.slice(0, 40);
  const token = joined.trim().toLowerCase();
  if (token === TRUE_TOKEN) return { allowed: true, supplied, recognized: true };
  if (token === FALSE_TOKEN) return { allowed: false, supplied, recognized: true };
  return { allowed: false, supplied, recognized: false };
}

/** Read the opt-in off an incoming request. */
export function readSubstitutionOptIn(req: {
  header?: (name: string) => string | undefined;
  headers?: Record<string, string | string[] | undefined>;
}): SubstitutionOptIn {
  const viaHelper = req.header?.(SUBSTITUTION_OPT_IN_HEADER);
  if (viaHelper !== undefined) return parseSubstitutionOptIn(viaHelper);
  const viaHeaders = req.headers?.[SUBSTITUTION_OPT_IN_HEADER.toLowerCase()];
  return parseSubstitutionOptIn(viaHeaders);
}

/**
 * The contract, machine-readable, published in every recovery body so a caller
 * can discover the control at the moment it would have helped them.
 */
export const SUBSTITUTION_OPT_IN_DOC = {
  header: SUBSTITUTION_OPT_IN_HEADER,
  value: TRUE_TOKEN,
  effect:
    "lists other models that could serve this request. Suggestions only: the model you send is always the " +
    "model that runs, and nothing is substituted for you.",
  default: "off — no substitute model is named unless this header is sent",
  not_a_budget_signal:
    "a budget too small for the requested model is not permission to change it; only this header is",
} as const;

export function substitutionOptInContract(optIn: SubstitutionOptIn) {
  return {
    ...SUBSTITUTION_OPT_IN_DOC,
    you_sent: optIn.supplied,
    ...(optIn.supplied !== null && !optIn.recognized
      ? { ignored_because: `unrecognised value; send exactly "${TRUE_TOKEN}" or "${FALSE_TOKEN}"` }
      : {}),
  };
}
