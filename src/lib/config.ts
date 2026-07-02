// Inlined from NetIntel src/config.ts: only the timeout values the ported
// endpoints use, verbatim. (currency-exchange keeps its own inline 8000.)
export const timeouts = {
  dns: 3000,
  schemaParse: 30000,
  sentiment: 30000,
  domainReport: 8000,
  domainAvailability: 8000,
  // Anthropic Messages call for /messages (non-streaming, max_tokens <= 4096).
  messages: 60000,
  // Image-provider HTTP call for /ai-image/generate.
  aiImageAssets: 60000,
} as const;
