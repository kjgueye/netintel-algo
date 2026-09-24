// Shared "did we actually deliver anything?" gate for the content-extraction
// endpoints (/web/extract, /page-extract/read, /og-scraper/extract).
//
// x402 settles a payment only when the final status is < 400, so a graded-down
// 200 still BILLS the caller. Before this gate, a Cloudflare challenge page or a
// 404 came back as a scored 200 — we charged for zero content and, worse, passed
// the challenge page's title ("Just a moment...") off as the document title
// (production, 2026-07-11: a new customer's first and only call). Same policy as
// money-parse's NO_AMOUNT_400: never bill our own miss.
//
// Deliberately NOT handled here: retrying with a spoofed browser User-Agent to
// slip past a bot challenge. The source is explicitly refusing automated clients;
// evading that is out of scope. We report the block honestly and don't charge.

/** Statuses a site serves when it is refusing an automated client. */
const CHALLENGE_STATUSES = new Set([401, 403, 429, 503]);

/**
 * Titles/bodies of the common interstitials. These pages often carry a handful
 * of real words ("Verifying you are human…"), so a word-count check alone would
 * happily sell them — the challenge must be matched explicitly.
 */
const CHALLENGE_TITLE_RE =
  /just a moment|attention required|access denied|verifying you are human|are you a robot|security check|checking your browser|please wait|ddos protection|403 forbidden|blocked/i;

const CHALLENGE_BODY_RE =
  /cf-browser-verification|cf_chl|__cf_chl|cf-mitigated|cdn-cgi\/challenge-platform|enable javascript and cookies to continue|checking your browser before accessing|_incapsula_|distil_r_captcha|px-captcha|perimeterx|<title>\s*just a moment|please enable js|enable javascript|disable any ad ?blocker|ad ?blocker detected|subscribe to (read|continue)|sign in to (read|continue)|subscription required|captcha|complete the security check|one more step/i;
// ("captcha"/"one more step" are safe as BODY markers because a body hit only
// counts alongside a refusal status — archive.ph's CAPTCHA page evaded the
// gate 2026-07-19: bland title "archive.ph", 101 wordy explainer words over
// the thin floor, none of the CF/paywall phrasings, billed as a graded-B 200.)

export type Unusable =
  | { blocked: true; code: "SOURCE_BLOCKED"; status: number; error: string; hint?: string }
  | { blocked: true; code: "SOURCE_NOT_FOUND"; status: number; error: string; hint?: string }
  | { blocked: true; code: "NO_CONTENT_EXTRACTED"; status: number; error: string; hint?: string };

// Pointer attached to render-fixable failures when a caller opts in via
// `suggestRenderer`. A plain fetch can't run JavaScript or clear a bot wall;
// /exa/contents renders the page and often can. Only offered on SOURCE_BLOCKED
// and NO_CONTENT_EXTRACTED — NOT on 404/410, where the page is simply gone and
// a renderer changes nothing. (Prod 2026-09-08: a first-touch caller hit an
// empty-200 on a client-rendered SPA and left with no idea /exa/contents exists.)
const RENDERER_HINT =
  "This looks like a JavaScript-rendered or bot-walled page that a plain fetch can't read. " +
  "POST /exa/contents renders the page and usually returns its text ($0.005).";

/**
 * True when the fetched page is an anti-bot interstitial rather than the
 * document the caller asked for. `body` may be the raw HTML or the extracted
 * text; both are cheap to scan.
 */
export function isBotChallenge(
  status: number,
  title: string | null | undefined,
  body: string | null | undefined,
): boolean {
  const titleHit = !!title && CHALLENGE_TITLE_RE.test(title);
  const bodyHit = !!body && CHALLENGE_BODY_RE.test(body);
  // A challenge status alone is not proof (a 403 can be a real page), and a
  // challenge-looking title alone is not either (an article ABOUT access denial).
  // Requiring the status plus a marker keeps false positives off the happy path,
  // but an unambiguous body marker (cf-chl script) is conclusive on its own.
  if (bodyHit && CHALLENGE_STATUSES.has(status)) return true;
  if (titleHit && CHALLENGE_STATUSES.has(status)) return true;
  return false;
}

/**
 * Decide whether a fetch delivered something worth billing for. Returns null
 * when the result is usable (the caller then grades it as before), or an
 * Unusable describing the 4xx to send instead — uncharged.
 *
 * `contentUnits` is whatever the endpoint sells: extracted words for the text
 * extractors, or populated metadata fields for the og-scraper.
 */
export function assessSource(opts: {
  status: number;
  title: string | null | undefined;
  body: string | null | undefined;
  contentUnits: number;
  /** Human name of what we'd have returned, e.g. "content" or "metadata". */
  noun: string;
  /**
   * When set: a challenge-status response (401/403/429/503) whose extraction
   * came in UNDER this many units is unusable even without a marker match —
   * a refusal page's wording varies endlessly (production 2026-07-16: WSJ's
   * 401 + "Please enable JS and disable any ad blocker", 8 words, billed as a
   * graded-down 200 to our first organic Solana customer), but "the source
   * refused us AND we extracted almost nothing" doesn't need the exact words.
   * Word-count-based extractors pass a small floor; og-scraper omits it
   * (paywalled pages legitimately serve full OG metadata on 401/403).
   */
  thinFloor?: number;
  /**
   * When true, render-fixable failures (SOURCE_BLOCKED, NO_CONTENT_EXTRACTED)
   * carry a `hint` pointing at /exa/contents. Text extractors that sell page
   * text (web-extract, page-extract) opt in; og-scraper does not — it sells OG
   * metadata, which /exa/contents does not return, so the pointer would mislead.
   */
  suggestRenderer?: boolean;
}): Unusable | null {
  const { status, title, body, contentUnits, noun, thinFloor, suggestRenderer } = opts;
  const renderHint = suggestRenderer ? RENDERER_HINT : undefined;

  if (isBotChallenge(status, title, body)) {
    return {
      blocked: true,
      code: "SOURCE_BLOCKED",
      status: 422,
      error:
        `The source blocked automated access (HTTP ${status} — bot challenge/interstitial), ` +
        `so no ${noun} could be extracted. This URL cannot be served by this endpoint; try a different source.`,
      hint: renderHint,
    };
  }

  if (thinFloor !== undefined && CHALLENGE_STATUSES.has(status) && contentUnits < thinFloor) {
    return {
      blocked: true,
      code: "SOURCE_BLOCKED",
      status: 422,
      error:
        `The source refused automated access (HTTP ${status}) and only a refusal/paywall remnant ` +
        `could be extracted — not the ${noun} you asked for. This URL cannot be served by this ` +
        `endpoint; try a different source.`,
      hint: renderHint,
    };
  }

  // Nothing extracted at all → we have nothing to sell, whatever the status.
  if (contentUnits <= 0) {
    if (status === 404 || status === 410) {
      return {
        blocked: true,
        code: "SOURCE_NOT_FOUND",
        status: 404,
        error: `The source returned HTTP ${status} and no ${noun} could be extracted — check the URL.`,
      };
    }
    return {
      blocked: true,
      code: "NO_CONTENT_EXTRACTED",
      status: 422,
      error:
        `No ${noun} could be extracted from the source (HTTP ${status}) — the page may be empty, ` +
        `JS-rendered, or paywalled.`,
      hint: renderHint,
    };
  }

  // Content exists but the source said "this page does not exist" — a 404 body
  // (error page boilerplate) is not what the caller asked for.
  if (status === 404 || status === 410) {
    return {
      blocked: true,
      code: "SOURCE_NOT_FOUND",
      status: 404,
      error:
        `The source returned HTTP ${status} — the page does not exist, so any ${noun} on it is an ` +
        `error page, not the document you requested. Check the URL.`,
    };
  }

  return null;
}
