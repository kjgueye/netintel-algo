import { Router, type Request, type Response } from "express";
import { validateUrl, ValidationError } from "../utils/validators.js";
import { describeFetchFailure } from "../utils/fetch-failure.js";
import { safeFetch, FetchProblem } from "../utils/safe-fetch.js";
import { assessSource } from "../utils/source-usability.js";
import { timeouts } from "../config.js";
// pdf-parse ships no type declarations, and its package entrypoint (index.js)
// runs debug code on import that reads a bundled test PDF off disk — which
// throws under ESM where `module.parent` is undefined. Import the library
// module directly to dodge that side effect.
// @ts-ignore -- no types for the lib subpath
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export const webExtractRouter = Router();

// --- Interfaces ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

// Stop reading an upstream body past 5MB (PDFs can dwarf HTML); a runaway
// download must never balloon memory.
const INPUT_READ_CAP = 5 * 1024 * 1024;
// Hard ceiling on the markdown we emit. Distinct from the input cap: this guards
// the response body (and our response logging) from a multi-megabyte payload.
// Truncate-and-flag, never reject — truncated prose is still useful.
const OUTPUT_BYTE_CAP = 1024 * 1024; // 1,048,576 bytes
const MAX_REDIRECTS = 3;

// --- Fetch (shared hop-checked fetcher: caps redirects + SSRF-checks each one) ---

interface FetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  bytes: Buffer;
}

async function fetchPage(start: URL): Promise<FetchResult> {
  const r = await safeFetch(start, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; NetIntel/1.0)" },
    timeoutMs: timeouts.webExtract,
    maxRedirects: MAX_REDIRECTS,
    maxBytes: INPUT_READ_CAP,
  });
  return { status: r.status, finalUrl: r.finalUrl, contentType: r.contentType, bytes: r.bytes };
}

// --- HTML helpers (extends the page-extract approach, but emits Markdown) ---

function getMetaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match && match[1]) return match[1];
  }
  return null;
}

function getTitleTag(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match?.[1]?.trim() || null;
}

function parseHtmlTitle(html: string): string | null {
  const t =
    getMetaContent(html, "og:title") ??
    getMetaContent(html, "twitter:title") ??
    getTitleTag(html);
  return t ? decodeHtmlEntities(t).trim() || null : null;
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#x27;": "'",
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };
  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.split(entity).join(char);
  }
  result = result.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return result;
}

function stripTags(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, "");
}

function stripTagContents(html: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  return html.replace(re, "");
}

function stripBySelector(html: string, className: string): string {
  const re = new RegExp(
    `<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/[^>]+>`,
    "gi",
  );
  return html.replace(re, "");
}

function resolveHref(href: string, base: string): string {
  const trimmed = href.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed, base).href;
  } catch {
    return trimmed;
  }
}

// Render a single <table>…</table> as a Markdown table; falls back to a
// linearized text run when no rows can be parsed.
function convertTable(inner: string): string {
  const rows: string[][] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(inner)) !== null) {
    const cells: string[] = [];
    const cellRe = /<(t[hd])[^>]*>([\s\S]*?)<\/\1>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      const text = decodeHtmlEntities(stripTags(cellMatch[2]))
        .replace(/\s+/g, " ")
        .replace(/\|/g, "\\|")
        .trim();
      cells.push(text);
    }
    if (cells.length) rows.push(cells);
  }

  if (!rows.length) {
    const linear = decodeHtmlEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    return linear ? `\n\n${linear}\n\n` : "\n\n";
  }

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => {
    const copy = [...r];
    while (copy.length < width) copy.push("");
    return copy;
  };
  const header = pad(rows[0]);
  const body = rows.slice(1).map(pad);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ];
  return `\n\n${lines.join("\n")}\n\n`;
}

// Ensure at most one H1: keep the first, demote any later H1 to H2 so the
// document has a sensible heading hierarchy.
function normalizeHeadings(markdown: string): string {
  let seenH1 = false;
  return markdown
    .split("\n")
    .map((line) => {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (!m) return line;
      if (m[1].length === 1) {
        if (!seenH1) {
          seenH1 = true;
          return line;
        }
        return `## ${m[2]}`;
      }
      return line;
    })
    .join("\n");
}

function collapseMarkdown(md: string): string {
  return md
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  let s = html;

  // 0 — Normalize CRLF/CR to LF. Every collapse below matches \n only, so
  // stray \r from CRLF-served pages (e.g. sitemaps.org) leaked "\r\n\r\n"
  // runs into the output (2026-07-30 sweep audit).
  s = s.replace(/\r\n?/g, "\n");

  // 1 — Drop comments + noise blocks (tag + contents).
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  const noiseTags = [
    "script", "style", "nav", "header", "footer", "aside",
    "form", "iframe", "noscript", "svg", "head",
  ];
  for (const tag of noiseTags) s = stripTagContents(s, tag);

  // Keep figcaption text, drop the rest of <figure>.
  s = s.replace(/<figure[^>]*>([\s\S]*?)<\/figure>/gi, (_m, frag: string) => {
    const cap = frag.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
    return cap ? cap[1] : "";
  });

  const noiseClasses = [
    "nav", "menu", "sidebar", "ad", "advertisement",
    "cookie", "popup", "modal", "related", "comments",
  ];
  for (const cls of noiseClasses) s = stripBySelector(s, cls);

  // 2 — Fenced code from <pre> (capture before inline/tag stripping).
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const code = decodeHtmlEntities(stripTags(inner)).replace(/\n{3,}/g, "\n\n").trim();
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
  });

  // 3 — Inline: code, bold, italic.
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => "`" + stripTags(inner).trim() + "`");
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const t = stripTags(inner).trim();
    return t ? `**${t}**` : "";
  });
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const t = stripTags(inner).trim();
    return t ? `*${t}*` : "";
  });

  // 4 — Links: [text](resolved-href).
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = stripTags(inner).replace(/\s+/g, " ").trim();
    const url = resolveHref(href, baseUrl);
    if (!url) return text;
    if (!text) return url;
    return `[${text}](${url})`;
  });

  // 5 — Tables.
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner: string) => convertTable(inner));

  // 6 — Headings.
  for (let level = 1; level <= 6; level++) {
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi");
    s = s.replace(re, (_m, inner: string) => {
      const t = stripTags(inner).replace(/\s+/g, " ").trim();
      return t ? `\n\n${"#".repeat(level)} ${t}\n\n` : "\n\n";
    });
  }

  // 7 — Blockquotes.
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
    const t = stripTags(inner).replace(/\s+/g, " ").trim();
    return t ? `\n\n> ${t}\n\n` : "\n\n";
  });

  // 8 — Lists: each <li> becomes a bullet line; list wrappers add spacing.
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => {
    const t = stripTags(inner).replace(/\s+/g, " ").trim();
    return t ? `\n- ${t}` : "";
  });
  s = s.replace(/<\/(ul|ol)>/gi, "\n\n").replace(/<(ul|ol)[^>]*>/gi, "\n");

  // 9 — Paragraphs + line breaks.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, inner: string) => {
    const t = stripTags(inner).replace(/[ \t]+/g, " ").trim();
    return t ? `\n\n${t}\n\n` : "\n\n";
  });

  // 10 — Strip whatever tags remain, decode entities, collapse, normalize.
  s = stripTags(s);
  s = decodeHtmlEntities(s);
  s = collapseMarkdown(s);
  s = normalizeHeadings(s);
  return s;
}

// --- PDF helpers ---

function pdfTextToMarkdown(text: string): string {
  const lines = text.split(/\r?\n/);
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(line.trim());
    }
  }
  if (current.length) paragraphs.push(current.join(" "));
  return collapseMarkdown(paragraphs.join("\n\n"));
}

// --- Output cap ---

function truncateToBytes(md: string, cap: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(md, "utf8") <= cap) return { text: md, truncated: false };

  // Largest character prefix that fits the byte cap (binary search — avoids
  // splitting a multi-byte UTF-8 sequence).
  let lo = 0;
  let hi = md.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Buffer.byteLength(md.slice(0, mid), "utf8") <= cap) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  let cut = md.slice(0, best);

  // Back off to a clean boundary: paragraph break, then line break, then word.
  const para = cut.lastIndexOf("\n\n");
  const line = cut.lastIndexOf("\n");
  const space = cut.lastIndexOf(" ");
  const boundary = para >= 0 ? para : line >= 0 ? line : space >= 0 ? space : cut.length;
  cut = cut.slice(0, boundary).replace(/\s+$/g, "");
  return { text: cut, truncated: true };
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

function countWords(md: string): number {
  return (md.match(/\S*\w\S*/g) || []).length;
}

// --- Route handler ---

webExtractRouter.get("/web/extract", async (req: Request, res: Response) => {
  try {
    const rawUrl = req.query.url as string | undefined;
    if (!rawUrl) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    const parsed = validateUrl(rawUrl);

    let page: FetchResult;
    try {
      page = await fetchPage(parsed);
    } catch (err) {
      if (err instanceof ValidationError) throw err; // SSRF / resolution → 400 below
      if (err instanceof FetchProblem) {
        // Refused redirect (non-http scheme / too many hops / bad Location) → its own uncharged status.
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      const name = (err as { name?: string })?.name;
      if (name === "AbortError" || name === "TimeoutError") {
        res.status(504).json({ error: "Upstream fetch timed out" });
        return;
      }
      // Node reports every transport failure as the same opaque
      // "TypeError: fetch failed"; the real reason is on err.cause. Surfacing
      // only the outer message told a paying caller nothing — an expired
      // certificate, a DNS failure and our own service being down all read
      // identically, and "fetch failed" reads as OUR fault. See
      // src/utils/fetch-failure.ts.
      const failure = describeFetchFailure(err);
      console.error("Web extract fetch failed:", failure.reason, err);
      res.status(502).json({ ...failure, url: parsed.href });
      return;
    }

    const ct = page.contentType.toLowerCase();
    const looksPdf =
      ct.includes("application/pdf") ||
      parsed.pathname.toLowerCase().endsWith(".pdf") ||
      page.finalUrl.toLowerCase().endsWith(".pdf");
    const looksHtml = ct.includes("text/html");

    let contentType: "article" | "pdf" | "other";
    let title: string | null;
    let rawMarkdown: string;

    if (looksPdf) {
      let parsedPdf: { text?: string; info?: { Title?: string } };
      try {
        parsedPdf = await pdfParse(page.bytes);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Web extract PDF parse failed:", message);
        res.status(502).json({ error: `PDF parsing failed: ${message}` });
        return;
      }
      const text = (parsedPdf.text || "").trim();
      if (!text) {
        res.status(422).json({ error: "PDF has no extractable text layer (likely scanned images)" });
        return;
      }
      contentType = "pdf";
      rawMarkdown = pdfTextToMarkdown(text);
      const infoTitle = parsedPdf.info?.Title?.trim();
      const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
      title = infoTitle || firstLine || null;
    } else if (looksHtml) {
      const html = page.bytes.toString("utf8");
      contentType = "article";
      title = parseHtmlTitle(html);
      rawMarkdown = htmlToMarkdown(html, page.finalUrl);
    } else {
      // Non-HTML/PDF text — best-effort: treat the body as plain text.
      const text = page.bytes.toString("utf8");
      contentType = "other";
      title = null;
      rawMarkdown = collapseMarkdown(decodeHtmlEntities(text));
    }

    // Enforce the output byte cap (truncate-and-flag, never reject).
    const { text: markdown, truncated } = truncateToBytes(rawMarkdown, OUTPUT_BYTE_CAP);

    const wordCount = countWords(markdown);
    const outputBytes = Buffer.byteLength(markdown, "utf8");

    // Never bill for a miss: a bot challenge, a 404, or an empty extraction has
    // nothing to sell. A graded-down 200 would still settle the payment (x402
    // settles on <400) and would hand the agent the interstitial's title as if
    // it were the document's. Answer 4xx instead — uncharged.
    const unusable = assessSource({
      status: page.status,
      title,
      body: looksHtml ? page.bytes.toString("utf8") : markdown,
      contentUnits: wordCount,
      noun: "content",
      // A 401/403/429/503 that yields under 40 words is a refusal remnant, not
      // the document (the grader already calls <100 words "thin"; 40 is well
      // below any real article) — uncharged instead of a billed C-grade.
      thinFloor: 40,
      // JS-rendered / bot-walled pages are /exa/contents' job, not ours; point
      // the caller there rather than leaving a dead end.
      suggestRenderer: true,
    });
    if (unusable) {
      res.status(unusable.status).json({
        error: unusable.error,
        code: unusable.code,
        ...(unusable.hint ? { hint: unusable.hint } : {}),
        url: parsed.href,
        final_url: page.finalUrl,
        status_code: page.status,
      });
      return;
    }

    // --- Grading ---
    let score = 100;
    const findings: Finding[] = [];

    if (page.status !== 200) {
      findings.push({ rule: "non_200_source", deduction: -20, detail: `Source returned HTTP ${page.status}` });
      score -= 20;
    }
    if (!title) {
      findings.push({ rule: "no_title", deduction: -10, detail: "No title could be determined" });
      score -= 10;
    }
    if (wordCount < 100) {
      findings.push({ rule: "thin_content", deduction: -15, detail: "Extracted content is under 100 words — likely paywalled or JS-rendered" });
      score -= 15;
    }
    if (truncated) {
      findings.push({ rule: "output_truncated", deduction: -5, detail: "Content exceeded 1MB and was truncated" });
      score -= 5;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    res.json({
      url: parsed.href,
      final_url: page.finalUrl,
      content_type: contentType,
      title,
      markdown,
      word_count: wordCount,
      char_count: markdown.length,
      output_bytes: outputBytes,
      truncated,
      status_code: page.status,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Web extract error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
