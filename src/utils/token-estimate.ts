// Script-aware token estimation for flat-priced LLM endpoints.
//
// Every LLM endpoint bounds cost with an input cap, but tokenization is
// SCRIPT-dependent: English runs ~3.5–4 chars/token while CJK is ~1 token per
// character and emoji/astral code points can be 2+. A char-only cap derived
// from the English ratio lets token-dense input cost several times the
// budgeted worst case — enough to push the pricier models underwater (found
// live 2026-07-18: 9/15 /openai/* and /messages could lose money on CJK at
// their char caps). This estimator deliberately OVER-counts dense scripts so
// the price floor holds without shrinking the char caps English callers use.
//
// Rule of thumb (validated against o200k/Claude tokenizers' worst cases):
//   ASCII               ~3.5 chars/token
//   other BMP scripts   1 token/char   (CJK ≈ 0.7–1.5 real; 1 is the estimate,
//                                       price margins absorb the 1.5× tail)
//   astral (> U+FFFF)   2 tokens/char  (emoji are multi-token)
export function estimateTokens(text: string): number {
  let ascii = 0;
  let dense = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 128) ascii++;
    else if (cp > 0xffff) dense += 2;
    else dense++;
  }
  return Math.ceil(ascii / 3.5) + dense;
}

/** The token budget a char cap was priced for (chars ÷ 3, slightly more
 * generous to callers than the ~3.5 pricing assumption). */
export function tokenBudgetForCharCap(charCap: number): number {
  return Math.ceil(charCap / 3);
}

/** Instructive 400 body text for a token-density rejection. */
export function tokenDensityMessage(estimated: number, budget: number): string {
  return `Input too token-dense: ~${estimated} estimated tokens (max ${budget}). Non-Latin scripts and emoji tokenize at ~1+ token per character — split the request or reduce the input.`;
}
