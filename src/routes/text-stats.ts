import { Router, type Request, type Response } from "express";
import { ValidationError } from "../utils/validators.js";
import { pickField } from "../utils/field-aliases.js";

// GET|POST /text/stats — deterministic text statistics (characters, words,
// sentences, paragraphs, averages, reading/speaking time). Pure function: no
// upstream, no LLM, no cache, no SSRF surface. Sibling of /text/chunk — agents
// size content here before chunking, embedding, summarizing, or posting.
//
// GET is a PAID method here (text arrives as ?text=), so unlike POST-only
// routes there is no hand-rolled 402 stub: the payment middleware challenges
// both methods from the `routes` map in index.ts.

export const textStatsRouter = Router();

// --- Limits ---

// Input cap in UTF-16 code units (JS string length) — same posture as
// /text/chunk. The global express.json() parser in index.ts allows 1mb bodies
// so this cap is reachable for any script; a body beyond THAT 413s at the
// parser (before the paywall — uncharged).
const MAX_TEXT_CHARS = 200_000;
const READING_WPM = 200;
const SPEAKING_WPM = 130;

const TEXT_KEYS = ["text", "content", "input", "body"];
const EXAMPLE_BODY = '{"text":"..."}';

// --- Types ---

interface Finding {
  rule: string;
  detail: string;
}

export interface TextStatsResult {
  /** Unicode code points, including whitespace. */
  characters: number;
  /** Code points excluding every Unicode whitespace character. */
  characters_no_spaces: number;
  /** Whitespace-delimited non-empty tokens. */
  words: number;
  /** Case-insensitive distinct words after stripping leading/trailing punctuation. */
  unique_words: number;
  sentences: number;
  paragraphs: number;
  /** characters_no_spaces / words, 2 dp. */
  avg_word_length: number;
  /** words / sentences, 2 dp. */
  avg_sentence_length: number;
  /** Longest punctuation-stripped word, first seen on ties; null when nothing survives stripping. */
  longest_word: string | null;
  reading_time_seconds: number;
  speaking_time_seconds: number;
  findings: Finding[];
}

// --- Metric helpers (pure; each metric is defined exactly once) ---

// JS `\s` with the u flag = the Unicode White_Space set (NBSP, ideographic
// space, line/paragraph separators, BOM …), so "no spaces" means no whitespace
// of any script, not just ASCII blanks.
const WHITESPACE = /\s/u;
const NON_BLANK = /\S/u;
const WORD_TOKEN = /\S+/gu;
// Leading/trailing Unicode punctuation (General Category P: quotes, brackets,
// commas, dashes, terminators …). Interior punctuation stays — "pay-per-call"
// and "don't" are one word each.
const EDGE_PUNCTUATION = /^\p{P}+|\p{P}+$/gu;
// A sentence ends at a run of terminators (. ! ? …), optionally followed by
// closing quotes/brackets, that is followed by whitespace or end of text. The
// trailing-context rule keeps "3.14", "example.com" and "v1.2" from being
// counted as breaks — the classic place a naive split-on-dot lies.
const SENTENCE_BOUNDARY = /[.!?…]+[)\]}"'”’»]*(?=\s|$)/u;
// One or more blank lines (a blank line may carry spaces/tabs; \s* also
// swallows extra newlines so a run of blank lines is a single break).
const PARAGRAPH_BREAK = /\n\s*\n/u;

/** Code-point length (an emoji or astral CJK char is 1, not 2). */
function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function countCharacters(text: string): { characters: number; noSpaces: number } {
  let characters = 0;
  let noSpaces = 0;
  for (const cp of text) {
    characters++;
    if (!WHITESPACE.test(cp)) noSpaces++;
  }
  return { characters, noSpaces };
}

function tokenize(text: string): string[] {
  return text.match(WORD_TOKEN) ?? [];
}

function stripPunctuation(token: string): string {
  return token.replace(EDGE_PUNCTUATION, "");
}

/** Non-blank segments between sentence boundaries; min 1 for non-blank text. */
function countSentences(text: string): number {
  let n = 0;
  for (const segment of text.split(SENTENCE_BOUNDARY)) {
    if (NON_BLANK.test(segment)) n++;
  }
  return Math.max(1, n);
}

/** Non-blank blocks between blank-line breaks; min 1 for non-blank text. */
function countParagraphs(text: string): number {
  let n = 0;
  for (const block of text.split(PARAGRAPH_BREAK)) {
    if (NON_BLANK.test(block)) n++;
  }
  return Math.max(1, n);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** words at `wpm` → whole seconds, rounded UP (1 word is 1s, never 0). */
function secondsAt(words: number, wpm: number): number {
  return Math.ceil((words * 60) / wpm);
}

// --- Core (exported for reuse/tests) ---

export function textStats(text: string): TextStatsResult {
  const { characters, noSpaces } = countCharacters(text);
  const tokens = tokenize(text);
  const words = tokens.length;

  const seen = new Set<string>();
  let longestWord: string | null = null;
  let longestLength = 0;
  for (const token of tokens) {
    const core = stripPunctuation(token);
    if (core === "") continue;
    seen.add(core.toLowerCase());
    const length = codePointLength(core);
    if (length > longestLength) {
      longestWord = core;
      longestLength = length;
    }
  }

  const sentences = countSentences(text);
  const paragraphs = countParagraphs(text);

  // Key order is part of the contract — agents diff these responses.
  return {
    characters,
    characters_no_spaces: noSpaces,
    words,
    unique_words: seen.size,
    sentences,
    paragraphs,
    avg_word_length: words > 0 ? round2(noSpaces / words) : 0,
    avg_sentence_length: sentences > 0 ? round2(words / sentences) : 0,
    longest_word: longestWord,
    reading_time_seconds: secondsAt(words, READING_WPM),
    speaking_time_seconds: secondsAt(words, SPEAKING_WPM),
    findings: [],
  };
}

// --- Route handler (shared by GET and POST) ---

// Text is read RAW (not trimmed) so `characters` reports exactly what was sent;
// the same query-wins-over-body merge as pickRequestParam, minus its trim.
function handleTextStats(req: Request, res: Response): void {
  try {
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const query = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
    const params = { ...body, ...query };

    const rawText = pickField(params, TEXT_KEYS);
    if (rawText === undefined || (typeof rawText === "string" && rawText.trim() === "")) {
      res.status(400).json({
        error: `text is required — pass the text to analyze as ?text= (GET) or a JSON body ${EXAMPLE_BODY} (POST). Aliases: content, input, body.`,
      });
      return;
    }
    if (typeof rawText !== "string") {
      throw new ValidationError(`text must be a string, e.g. ${EXAMPLE_BODY}`);
    }
    if (rawText.length > MAX_TEXT_CHARS) {
      res.status(413).json({
        error: `text exceeds the ${MAX_TEXT_CHARS}-character limit (got ${rawText.length}) — split the input and call again. You were not charged.`,
      });
      return;
    }

    res.json(textStats(rawText));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Text stats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

textStatsRouter.get("/text/stats", handleTextStats);
textStatsRouter.post("/text/stats", handleTextStats);
