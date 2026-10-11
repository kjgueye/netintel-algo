// PDF text-layer extraction for /pdf/parse: per-page Markdown with paragraphs
// rebuilt from line positions, document metadata, and the pages that have no
// text layer (scans — this service does no OCR).
//
// Engine: the pdf.js 1.10 build that pdf-parse 1.1.1 bundles (the same engine
// /web/extract uses through pdf-parse), driven directly so only the requested
// pages are opened. pdf-parse's renderer joins a page's lines with "\n" and never
// marks a paragraph, so /web/extract's PDF output collapses each page into one
// paragraph; here the vertical gap between lines decides.
//
// pdf.js runs on the main thread (no worker in Node): callers must cap input
// size and page count to bound the event-loop time a document can take.

// No type declarations for the bundled build.
// @ts-ignore -- no types for the lib subpath
import PDFJS from "pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js";
import { ValidationError } from "../utils/validators.js";

PDFJS.disableWorker = true; // as pdf-parse does: no worker threads in Node

export interface PdfPage {
  page: number;
  markdown: string;
  char_count: number;
  word_count: number;
  has_text: boolean;
}

export interface PdfMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  creator: string | null;
  producer: string | null;
  created: string | null;
  modified: string | null;
  pdf_version: string | null;
  has_form: boolean;
}

export interface PdfText {
  page_count: number;
  pages: PdfPage[];
  metadata: PdfMetadata;
  /** Pages pdf.js could not render (reported, not fatal; they count as no text). */
  failed_pages: number[];
}

export class PdfError extends Error {
  constructor(
    public readonly code: "PDF_ENCRYPTED" | "PDF_PARSE_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "PdfError";
  }
}

/**
 * "1-3,7" → [1, 2, 3, 7] (1-based, sorted, de-duplicated). Empty/undefined →
 * null (all pages). Throws ValidationError on malformed specs or > maxPages pages.
 */
export function parsePageSpec(spec: string | undefined, maxPages: number): number[] | null {
  if (spec === undefined || spec.trim() === "" || /^all$/i.test(spec.trim())) return null;
  const out = new Set<number>();
  const tooMany = () => new ValidationError(`pages selects more than ${maxPages} pages — request at most ${maxPages} per call`);
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,6})(?:\s*-\s*(\d{1,6}))?$/.exec(part);
    if (!m) {
      throw new ValidationError(`pages must look like "1-3,7" (1-based page numbers and ranges) — got "${spec}"`);
    }
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    if (a < 1 || b < a) throw new ValidationError(`pages range "${part}" is invalid — pages start at 1 and ranges go low-high`);
    if (b - a + 1 > maxPages) throw tooMany();
    for (let p = a; p <= b; p++) out.add(p);
    if (out.size > maxPages) throw tooMany();
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

/** PDF date string ("D:20240315120000+01'00'") → ISO 8601, or null. */
export function pdfDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(Z|[+-]\d{2}'?\d{2}'?)?/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", tz] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  const zone = !tz ? "" : tz === "Z" ? "Z" : `${tz.slice(0, 3)}:${tz.replace(/'/g, "").slice(3, 5) || "00"}`;
  return Number.isNaN(Date.parse(`${iso}${zone || "Z"}`)) ? null : `${iso}${zone}`;
}

interface Item { str: string; x: number; y: number; w: number; size: number }
interface Line { y: number; endX: number; size: number; text: string }

// Lower median: with few lines, paragraph gaps must not become the "usual" spacing.
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

/**
 * pdf.js text items (content-stream order) → Markdown paragraphs. Items on the
 * same baseline form a line (a space is inserted where pdf.js left a visible
 * gap); a vertical gap well above the page's usual line spacing, a jump back up
 * the page (next column), or a font-size change starts a new paragraph. Lines
 * set at least 1.35× the body size and short enough to be a title become
 * "## " headings. A word hyphenated across a line break is re-joined.
 */
export function itemsToMarkdown(raw: Array<{ str?: string; transform?: number[]; width?: number; height?: number }>): string {
  const items: Item[] = [];
  for (const r of raw) {
    if (!r || typeof r.str !== "string" || r.str === "" || !Array.isArray(r.transform)) continue;
    const t = r.transform;
    items.push({ str: r.str, x: t[4], y: t[5], w: r.width ?? 0, size: Math.hypot(t[2], t[3]) || r.height || 12 });
  }
  const lines: Line[] = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    const dy = last ? Math.abs(it.y - last.y) : Infinity;
    const sameBaseline = !!last && dy <= Math.max(1, 0.3 * Math.min(it.size, last.size));
    // A superscript/subscript (footnote mark, "h_t") sits off the baseline in a
    // smaller font: it belongs to the line it is attached to.
    const scriptAfter = !!last && it.size < 0.85 * last.size && dy <= 0.6 * last.size;
    const scriptBefore = !!last && last.size < 0.85 * it.size && dy <= 0.6 * it.size && last.text.length <= 3;
    if (last && (sameBaseline || scriptAfter || scriptBefore)) {
      const gap = it.x - last.endX;
      const space = gap > 0.15 * it.size && !/\s$/.test(last.text) && !/^\s/.test(it.str);
      last.text += (space ? " " : "") + it.str;
      last.endX = Math.max(last.endX, it.x + it.w);
      if (scriptBefore) {
        last.y = it.y; // re-base the line on its body text, not the leading mark
        last.size = it.size;
      } else if (sameBaseline) {
        last.size = Math.max(last.size, it.size);
      }
    } else {
      lines.push({ y: it.y, endX: it.x + it.w, size: it.size, text: it.str });
    }
  }
  const kept = lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text);
  if (!kept.length) return "";

  // Body size = the font size carrying the most characters on the page.
  const weight = new Map<number, number>();
  for (const l of kept) weight.set(Math.round(l.size), (weight.get(Math.round(l.size)) ?? 0) + l.text.length);
  const bodySize = [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const isHeading = (l: Line) => l.size >= 1.35 * bodySize && l.text.length <= 120;
  const leading = median(kept.slice(1).map((l, i) => kept[i].y - l.y).filter((g) => g > 0)) || bodySize * 1.2;

  const paragraphs: string[] = [];
  let current = "";
  let prev: Line | null = null;
  const flush = () => {
    if (current) paragraphs.push(current);
    current = "";
  };
  for (const l of kept) {
    if (isHeading(l)) {
      flush();
      paragraphs.push(`## ${l.text}`);
      prev = null;
      continue;
    }
    const gap = prev ? prev.y - l.y : 0;
    const newParagraph = !prev || gap <= 0 || gap > 1.5 * leading || Math.abs(l.size - prev.size) > 0.2 * prev.size;
    if (newParagraph) {
      flush();
      current = l.text;
    } else if (/[A-Za-z]-$/.test(current) && /^[a-z]/.test(l.text)) {
      current = current.slice(0, -1) + l.text; // "contin-" + "ues" → "continues"
    } else {
      current += ` ${l.text}`;
    }
    prev = l;
  }
  flush();
  return paragraphs.join("\n\n");
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Extract the text layer of `bytes`. `pages` = 1-based page numbers (null = the
 * first `maxPages` pages). A requested page beyond the document throws a
 * ValidationError naming the page count, before any page is rendered.
 */
export async function extractPdfText(bytes: Uint8Array, opts: { pages: number[] | null; maxPages: number }): Promise<PdfText> {
  let doc: PdfJsDocument;
  try {
    // A plain Uint8Array copy, never a Buffer: pdf.js 1.10 misreads Node
    // Buffers (any Buffer, even at byteOffset 0) — real-world files survive only
    // through pdf.js's xref repair, while a small well-formed PDF fails with
    // "bad XRef entry". (Verified 2026-10-10.)
    doc = await PDFJS.getDocument(new Uint8Array(bytes));
  } catch (err) {
    const name = (err as { name?: string })?.name;
    const message = err instanceof Error ? err.message : String(err);
    if (name === "PasswordException") {
      throw new PdfError("PDF_ENCRYPTED", "The PDF is password-protected — it cannot be read without the password");
    }
    throw new PdfError("PDF_PARSE_ERROR", `The PDF could not be parsed: ${message}`);
  }
  try {
    const pageCount: number = doc.numPages;
    const beyond = opts.pages?.find((p) => p > pageCount);
    if (beyond !== undefined) {
      throw new ValidationError(`page ${beyond} is out of range — this PDF has ${pageCount} page${pageCount === 1 ? "" : "s"}`);
    }
    const numbers = opts.pages ?? Array.from({ length: Math.min(pageCount, opts.maxPages) }, (_, i) => i + 1);
    const pages: PdfPage[] = [];
    const failed: number[] = [];
    for (const n of numbers) {
      let markdown = "";
      try {
        const page = await doc.getPage(n);
        const tc = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
        markdown = itemsToMarkdown(tc.items);
      } catch {
        failed.push(n);
      }
      // pdf.js shares the main thread with every other request: let queued I/O
      // run between pages so a long document delays others by one page, not all.
      await new Promise((resolve) => setImmediate(resolve));
      pages.push({
        page: n,
        markdown,
        char_count: markdown.length,
        word_count: markdown.replace(/^## /gm, "").split(/\s+/).filter(Boolean).length,
        has_text: /[\p{L}\p{N}]/u.test(markdown) && markdown.replace(/\s/g, "").length >= 3,
      });
    }
    const meta = await doc.getMetadata().catch(() => null);
    const info: Record<string, unknown> = meta?.info ?? {};
    return {
      page_count: pageCount,
      pages,
      failed_pages: failed,
      metadata: {
        title: str(info.Title),
        author: str(info.Author),
        subject: str(info.Subject),
        keywords: str(info.Keywords),
        creator: str(info.Creator),
        producer: str(info.Producer),
        created: pdfDate(info.CreationDate),
        modified: pdfDate(info.ModDate),
        pdf_version: str(info.PDFFormatVersion),
        has_form: info.IsAcroFormPresent === true || info.IsXFAPresent === true,
      },
    };
  } finally {
    doc.destroy();
  }
}

interface PdfJsDocument {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(o: object): Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number; height?: number }> }> }>;
  getMetadata(): Promise<{ info?: Record<string, unknown> } | null>;
  destroy(): void;
}

/** True when the first KB carries the "%PDF-" header (pdf.js tolerates leading junk). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 1024)).toString("latin1").includes("%PDF-");
}
