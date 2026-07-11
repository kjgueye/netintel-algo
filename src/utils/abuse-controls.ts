// Abuse controls for paid endpoints: a wallet denylist + blocked-attempt logging.
//
// Context: x402 settles a payment ONLY when the handler returns HTTP < 400 (see
// the landing copy in src/index.ts). So returning 403/400 for a blocked request
// means the caller is never charged and no upstream (LLM/image) spend happens.
// And because the paid-call logger records only SETTLED calls, blocked attempts
// are invisible to it — this module's log line is the ONLY durable record of
// them, so it captures enough (wallet + reason + a truncated prompt snippet) to
// let the operator review abuse and decide whom to denylist.
//
// The denylist is env-driven (WALLET_DENYLIST, comma-separated addresses) so it
// can be updated without a code change. Ethereum addresses are compared
// case-insensitively. This util is generic — it's wired into the image endpoint
// today but can guard any paid route.

/** Lowercase + trim a wallet address; null/non-string → null. */
export function normalizeWallet(wallet: unknown): string | null {
  if (typeof wallet !== "string") return null;
  const w = wallet.trim().toLowerCase();
  return w === "" ? null : w;
}

/** Parse a comma-separated denylist into a normalized Set of 0x addresses. */
export function parseDenylist(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  if (!raw) return set;
  for (const part of raw.split(",")) {
    const w = normalizeWallet(part);
    if (w && w.startsWith("0x")) set.add(w);
  }
  return set;
}

// Memoize the parsed Set keyed on the raw env string so repeated checks are cheap
// but a changed env value (e.g. between tests) is still honored.
let cachedRaw: string | undefined;
let cachedSet: Set<string> = new Set();

/** True if `wallet` is on the denylist. Defaults to the WALLET_DENYLIST env. */
export function isWalletDenied(
  wallet: string | null,
  raw: string | undefined = process.env.WALLET_DENYLIST,
): boolean {
  const normalized = normalizeWallet(wallet);
  if (!normalized) return false;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSet = parseDenylist(raw);
  }
  return cachedSet.has(normalized);
}

/** Why a request was blocked — kept coarse and greppable. */
export type BlockedReason = "denylist" | "policy_prescreen" | "policy_provider";

export interface BlockedAttempt {
  /** The paid endpoint that blocked the request, e.g. "/ai-image/generate". */
  endpoint: string;
  reason: BlockedReason;
  /** Payer wallet from the x402 payload, or null if unreadable. */
  wallet: string | null;
  /** Optional context (e.g. use_case) — non-sensitive. */
  useCase?: string;
  /** A short snippet of the offending prompt, so the operator can assess severity. */
  promptSnippet?: string;
  /** Extra detail (the policy reason from Claude or the provider). */
  detail?: string;
}

const SNIPPET_CAP = 280;

/**
 * Emit a single structured, greppable line for a blocked attempt. Written to
 * stderr via console.warn with a stable "[abuse]" prefix so it stands out in the
 * Railway log stream and can be parsed/alerted on. Fire-and-forget: never throws.
 */
export function logBlockedAttempt(entry: BlockedAttempt): void {
  try {
    const line = {
      ts: new Date().toISOString(),
      kind: "blocked_attempt",
      endpoint: entry.endpoint,
      reason: entry.reason,
      wallet: entry.wallet ?? "unknown",
      ...(entry.useCase ? { use_case: entry.useCase } : {}),
      ...(entry.detail ? { detail: entry.detail.slice(0, 200) } : {}),
      ...(entry.promptSnippet
        ? { prompt_snippet: entry.promptSnippet.slice(0, SNIPPET_CAP) }
        : {}),
    };
    console.warn("[abuse] " + JSON.stringify(line));
  } catch {
    /* logging must never break the request path */
  }
}
