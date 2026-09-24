import { Router, type Request, type Response } from "express";
import { ValidationError } from "../utils/validators.js";
import { pickField } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const predictionMarketRouter = Router();

// Single-market drill-in for /prediction/markets: the full state of ONE
// Polymarket market (every outcome + odds, description/resolution terms,
// volume, liquidity, dates, status) from the Gamma API (public, keyless, no
// signup). Routes are self-contained, so the Gamma helpers below are copied
// from prediction-markets.ts rather than shared — keep the two in step.
// One fixed upstream host and id/slug input only, so there is no SSRF surface
// and deliberately no checkSsrf here.
//
// Billing: market found → 200 billed; not found → 404 uncharged; missing or
// unusable input → 400 uncharged; upstream down/5xx/timeout/malformed → 502
// uncharged.
//
// Gamma facts verified live 2026-08-31 (the API shifts — re-verify on change):
//   - GET /markets/{id} → ONE market object. Unknown id → HTTP 404
//     {"type":"not found error"}; non-numeric or over-long id → HTTP 422
//     {"type":"validation error","error":"id is invalid"}.
//   - GET /markets?slug={slug} → an ARRAY: one element, or [] for an unknown
//     slug (HTTP 200, never 404).
//   - `outcomes` / `outcomePrices` arrive as JSON-ENCODED STRINGS
//     ("[\"Yes\", \"No\"]", "[\"0.55\", \"0.45\"]"), NOT arrays.
//   - `volumeNum` / `liquidityNum` are numbers; `volume` / `liquidity` are
//     the same values as strings. Prefer the *Num fields.
//   - Market objects carry NO `category`. `?include_tag=true` adds a
//     top-level `tags[]` ({label}) on BOTH lookups — category is derived from
//     it. The id lookup returns no `events`; the slug lookup nests `events[]`.
//   - `resolutionSource` is "" on most markets (the terms live in
//     `description`) → resolution_source is null there.

// --- Constants ---

const TIMEOUT_MS = timeouts.predictionMarket;

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const POLYMARKET_SITE = "https://polymarket.com";

// The synonyms agents send for each parameter (canonical name first).
const ID_ALIASES = ["id", "market_id", "market"];
const SLUG_ALIASES = ["slug", "market_slug"];

const MAX_SLUG_LENGTH = 200;
// Polymarket slugs are lowercase [a-z0-9-]; a little looser here (agents paste
// dots/underscores), but nothing URL-hostile. Checked after lowercasing.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const NUMERIC_ID_PATTERN = /^\d+$/;

// Polymarket's top-level categories, in priority order. `category` is the
// highest-priority one that appears among the market's tags.
const KNOWN_CATEGORIES = [
  "Politics",
  "Sports",
  "Crypto",
  "Business",
  "Economy",
  "Finance",
  "Science",
  "Tech",
  "Culture",
  "Pop Culture",
  "Entertainment",
  "World",
  "Geopolitics",
  "Elections",
  "Weather",
  "Health",
];

// --- Interfaces ---

interface Finding {
  rule: string;
  detail: string;
}

interface Outcome {
  outcome: string;
  /** Implied probability 0..1 (0.55 = 55% chance) — Polymarket's share price. */
  price: number;
}

interface MarketDetail {
  id: string;
  question: string;
  slug: string | null;
  description: string | null;
  outcomes: Outcome[];
  volume_usd: number;
  volume_24h_usd: number | null;
  liquidity_usd: number | null;
  start_date: string | null;
  end_date: string | null;
  resolution_source: string | null;
  category: string | null;
  active: boolean;
  closed: boolean;
  url: string | null;
}

interface MarketData {
  market: MarketDetail;
  findings: Finding[];
  storedAt: number;
}

type Lookup = { kind: "id"; value: string } | { kind: "slug"; value: string };

// Upstream failure (network error, timeout, non-2xx, unparseable/unexpected
// body) → 502 uncharged.
class UpstreamError extends Error {}
// Upstream answered, but no such market → 404 uncharged.
class NotFoundError extends Error {}

// --- Cache (in-process Map, wiped on deploy — same pattern as the list
// endpoint). Odds move, but 60s per market spares the keyless upstream from
// bursty agents re-asking about the same market. A hit is stored under BOTH
// its id and slug keys so a slug lookup warms the id lookup and vice versa. ---

const CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;
const marketCache = new Map<string, { value: MarketData; expires: number }>();

function cacheGet(key: string): MarketData | undefined {
  const entry = marketCache.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    marketCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: MarketData): void {
  if (marketCache.size >= MAX_CACHE_ENTRIES && !marketCache.has(key)) {
    const oldest = marketCache.keys().next().value;
    if (oldest !== undefined) marketCache.delete(oldest);
  }
  marketCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

function idKey(id: string): string {
  return `id:${id}`;
}

function slugKey(slug: string): string {
  return `slug:${slug}`;
}

// Test hook: the cache is module state and would leak between tests.
export function __resetPredictionMarketStateForTests(): void {
  marketCache.clear();
}

// --- Helpers ---

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Finite number from a JSON number OR a numeric string (Gamma sends both). */
function numOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Gamma's JSON-encoded-string arrays → real arrays; tolerates a real array too. */
function parseJsonArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Zip outcomes + outcomePrices; null when either side is unusable. */
function parseOutcomes(rawOutcomes: unknown, rawPrices: unknown): Outcome[] | null {
  const outcomes = parseJsonArray(rawOutcomes);
  const prices = parseJsonArray(rawPrices);
  if (!outcomes || !prices || outcomes.length !== prices.length) return null;
  const out: Outcome[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const price = numOrNull(prices[i]);
    const label = outcomes[i];
    if (price === null || (typeof label !== "string" && typeof label !== "number")) return null;
    out.push({ outcome: String(label), price });
  }
  return out;
}

/** Tag labels from a Gamma `tags[]` ({label} objects or bare strings), lowercased. */
function tagLabels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((t) => (isRecord(t) ? strOrNull(t.label) : strOrNull(t)))
    .filter((l): l is string => l !== null)
    .map((l) => l.toLowerCase());
}

function deriveCategory(raw: Record<string, unknown>, event: Record<string, unknown> | undefined): string | null {
  const direct = strOrNull(raw.category) ?? strOrNull(event?.category);
  if (direct) return direct;
  // include_tag=true puts tags on the market itself; the event's tags are the
  // fallback for any shape that still nests them there.
  const labels = new Set([...tagLabels(raw.tags), ...tagLabels(event?.tags)]);
  for (const known of KNOWN_CATEGORIES) {
    if (labels.has(known.toLowerCase())) return known;
  }
  return null;
}

/** Gamma market object → our snake_case contract. */
function normalizeMarket(raw: Record<string, unknown>): MarketData {
  const id = raw.id !== undefined && raw.id !== null ? String(raw.id) : "";
  if (!id) throw new UpstreamError("Polymarket upstream returned a market without an id");

  const findings: Finding[] = [];
  const event = Array.isArray(raw.events) && isRecord(raw.events[0]) ? raw.events[0] : undefined;

  const outcomes = parseOutcomes(raw.outcomes, raw.outcomePrices);
  if (outcomes === null) {
    findings.push({
      rule: "outcomes_unparseable",
      detail: `Market ${id}: outcomes/outcomePrices could not be parsed — outcomes omitted`,
    });
  }

  const slug = strOrNull(raw.slug);
  const eventSlug = strOrNull(event?.slug);
  const url = slug
    ? `${POLYMARKET_SITE}/market/${encodeURIComponent(slug)}`
    : eventSlug
      ? `${POLYMARKET_SITE}/event/${encodeURIComponent(eventSlug)}`
      : null;

  const volume = numOrNull(raw.volumeNum) ?? numOrNull(raw.volume) ?? 0;
  const volume24h = numOrNull(raw.volume24hr);
  const liquidity = numOrNull(raw.liquidityNum) ?? numOrNull(raw.liquidity);

  return {
    market: {
      id,
      question: strOrNull(raw.question) ?? strOrNull(raw.title) ?? "",
      slug,
      description: strOrNull(raw.description),
      outcomes: outcomes ?? [],
      volume_usd: round2(volume),
      volume_24h_usd: volume24h === null ? null : round2(volume24h),
      liquidity_usd: liquidity === null ? null : round2(liquidity),
      start_date: strOrNull(raw.startDate) ?? strOrNull(raw.startDateIso),
      end_date: strOrNull(raw.endDate) ?? strOrNull(raw.endDateIso),
      resolution_source: strOrNull(raw.resolutionSource),
      category: deriveCategory(raw, event),
      active: raw.active === true,
      closed: raw.closed === true,
      url,
    },
    findings,
    storedAt: Date.now(),
  };
}

/**
 * GET the upstream JSON. Statuses listed in `notFoundStatuses` resolve to
 * `{ data: null }` (the caller turns that into a 404); every other non-2xx,
 * network error, timeout, or non-JSON body is an UpstreamError (→ 502).
 */
async function fetchUpstream(
  url: string,
  timeoutMs: number,
  label: string,
  notFoundStatuses: readonly number[],
): Promise<{ data: unknown }> {
  if (timeoutMs < 250) throw new UpstreamError(`${label} timed out`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new UpstreamError(
        aborted
          ? `${label} timed out`
          : `${label} unreachable: ${err instanceof Error ? err.message : "request failed"}`,
      );
    }
    if (notFoundStatuses.includes(response.status)) return { data: null };
    if (!response.ok) throw new UpstreamError(`${label} error (HTTP ${response.status})`);
    try {
      return { data: await response.json() };
    } catch {
      throw new UpstreamError(`${label} returned a malformed response`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** By id: GET /markets/{id} → ONE object. 404 (unknown) / 422 (invalid) → not found. */
async function lookupById(id: string): Promise<MarketData> {
  const { data } = await fetchUpstream(
    `${GAMMA_BASE}/markets/${encodeURIComponent(id)}?include_tag=true`,
    TIMEOUT_MS,
    "Polymarket upstream",
    [404, 422],
  );
  if (data === null) throw new NotFoundError(`No market found for id ${id}`);
  if (!isRecord(data)) throw new UpstreamError("Polymarket upstream returned an unexpected response");
  return normalizeMarket(data);
}

/** By slug: GET /markets?slug= → an ARRAY; [] (or a 422 on the slug) → not found. */
async function lookupBySlug(slug: string): Promise<MarketData> {
  const params = new URLSearchParams({ slug, include_tag: "true" });
  const { data } = await fetchUpstream(`${GAMMA_BASE}/markets?${params}`, TIMEOUT_MS, "Polymarket upstream", [422]);
  if (data === null) throw new NotFoundError(`No market found for slug "${slug}"`);
  if (!Array.isArray(data)) throw new UpstreamError("Polymarket upstream returned an unexpected response");
  const first = data.find(isRecord);
  if (!first) throw new NotFoundError(`No market found for slug "${slug}"`);
  return normalizeMarket(first);
}

// --- Input resolution ---

// Raw-value pick (same body-or-query merge as pickRequestParam, query wins):
// `id` is numeric and arrives as a JSON NUMBER in POST bodies ({"id": 665374}),
// which the string-only pickRequestParam would drop.
function pickRawParam(req: { query?: unknown; body?: unknown }, keys: string[]): unknown {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const query = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
  return pickField({ ...body, ...query }, keys);
}

/** Non-empty trimmed string from a string OR an integer JSON number. */
function asParamString(v: unknown): string | undefined {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? String(v) : undefined;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed !== "" ? trimmed : undefined;
}

/**
 * Accept a bare slug OR a pasted polymarket.com URL (…/event/{event}/{market},
 * …/market/{slug}) — agents copy URLs. Lowercased, validated.
 */
function normalizeSlug(raw: string, findings: Finding[]): string {
  let slug = raw;
  if (/^https?:\/\//i.test(slug) || /polymarket\.com\//i.test(slug)) {
    const path = slug.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0];
    const segments = path.split("/").filter((s) => s !== "");
    const last = segments[segments.length - 1];
    if (!last) throw new ValidationError("slug URL has no market path — e.g. https://polymarket.com/market/<slug>");
    slug = decodeURIComponent(last);
    findings.push({ rule: "slug_extracted_from_url", detail: `Used the last path segment of the URL as the slug: ${slug}` });
  }
  slug = slug.toLowerCase();
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new ValidationError(`slug must be at most ${MAX_SLUG_LENGTH} characters`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new ValidationError(
      "slug must be a Polymarket market slug (letters, digits, hyphens) — e.g. will-the-us-invade-iran-before-2027",
    );
  }
  return slug;
}

function resolveLookup(req: Request, findings: Finding[]): Lookup {
  const id = asParamString(pickRawParam(req, ID_ALIASES));
  const slug = asParamString(pickRawParam(req, SLUG_ALIASES));

  if (id !== undefined) {
    if (NUMERIC_ID_PATTERN.test(id)) return { kind: "id", value: id };
    // A slug sent under the id/market alias is an obvious intent — honour it.
    findings.push({
      rule: "id_treated_as_slug",
      detail: `id "${id}" is not a numeric Polymarket market id — looked it up as a slug instead`,
    });
    return { kind: "slug", value: normalizeSlug(id, findings) };
  }
  if (slug !== undefined) return { kind: "slug", value: normalizeSlug(slug, findings) };

  throw new ValidationError(
    'id or slug is required — e.g. ?slug=will-the-us-invade-iran-before-2027 or {"id":"665374"} (aliases: market_id, market, market_slug)',
  );
}

// --- Route ---

async function handlePredictionMarket(req: Request, res: Response): Promise<void> {
  try {
    const requestFindings: Finding[] = [];
    const lookup = resolveLookup(req, requestFindings);
    const cacheKey = lookup.kind === "id" ? idKey(lookup.value) : slugKey(lookup.value);

    let data = cacheGet(cacheKey);
    if (!data) {
      data = lookup.kind === "id" ? await lookupById(lookup.value) : await lookupBySlug(lookup.value);
      cacheSet(cacheKey, data);
      cacheSet(idKey(data.market.id), data);
      if (data.market.slug) cacheSet(slugKey(data.market.slug.toLowerCase()), data);
    }

    res.json({
      source: "polymarket",
      ...data.market,
      cache_age_seconds: Math.floor((Date.now() - data.storedAt) / 1000),
      findings: [...requestFindings, ...data.findings],
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof UpstreamError) {
      res.status(502).json({ error: err.message });
      return;
    }
    console.error("Prediction market error:", err);
    res.status(500).json({
      error: `Prediction market lookup failed: ${err instanceof Error ? err.message : "unknown error"}`,
    });
  }
}

predictionMarketRouter.get("/prediction/market", handlePredictionMarket);
predictionMarketRouter.post("/prediction/market", handlePredictionMarket);
