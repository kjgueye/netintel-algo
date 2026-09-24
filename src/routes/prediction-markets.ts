import { Router, type Request, type Response } from "express";
import { ValidationError } from "../utils/validators.js";
import { pickField, pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const predictionMarketsRouter = Router();

// Live Polymarket prediction-market odds from the Gamma API (public, keyless,
// no signup) — the same keyless-upstream-wrapper model as ip-geo / weather.
// One fixed upstream host and keyword/number input only, so there is no SSRF
// surface and deliberately no checkSsrf here.
//
// Billing: 200 whenever the upstream answered — INCLUDING zero matches for a
// real query (a valid "no markets match" answer, flagged with a `no_results`
// finding). Upstream down/5xx/timeout/malformed → 502 uncharged. A bad
// limit/status is clamped/defaulted with a finding, still 200.
//
// Gamma facts verified live 2026-08-31 (the API shifts — re-verify on change):
//   - `outcomes` / `outcomePrices` arrive as JSON-ENCODED STRINGS
//     ("[\"Yes\", \"No\"]", "[\"0.55\", \"0.45\"]"), NOT arrays.
//   - `volumeNum` / `liquidityNum` are numbers; `volume` / `liquidity` are
//     the same values as strings. Prefer the *Num fields.
//   - Market objects carry NO `category` field any more; search results nest
//     markets under events, and only those events carry `tags`.
//   - /public-search with zero matches omits the `events` key entirely
//     ({"pagination":{...}} only) — that is a legitimate empty answer.
//   - /public-search `events_status` does NOT filter the nested markets (an
//     "active" event still lists its resolved sub-markets), so status is
//     applied here as a post-filter on each market's own `closed` flag.

// --- Constants ---

const TIMEOUT_MS = timeouts.predictionMarkets;

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const POLYMARKET_SITE = "https://polymarket.com";

// The synonyms agents send for each parameter (canonical name first).
const QUERY_ALIASES = ["query", "q", "search", "keyword"];
const LIMIT_ALIASES = ["limit", "count", "n"];
const STATUS_ALIASES = ["status", "state"];

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const MAX_QUERY_LENGTH = 200;

type StatusKey = "active" | "closed" | "all";
const STATUS_VALUES: readonly StatusKey[] = ["active", "closed", "all"];

// Polymarket's top-level categories, in priority order. `category` is the
// highest-priority one that appears among the parent event's tags (search
// mode only — /markets nests its events WITHOUT tags, so browse results are
// null unless Gamma reintroduces a market-level `category` field).
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

interface Market {
  id: string;
  question: string;
  slug: string | null;
  outcomes: Outcome[];
  volume_usd: number;
  volume_24h_usd: number | null;
  liquidity_usd: number | null;
  end_date: string | null;
  category: string | null;
  active: boolean;
  closed: boolean;
  url: string | null;
}

interface MarketsData {
  markets: Market[];
  findings: Finding[];
  storedAt: number;
}

// Upstream failure (network error, timeout, non-2xx, unparseable/unexpected
// body) → 502 uncharged.
class UpstreamError extends Error {}

// --- Cache (in-process Map, wiped on deploy — same pattern as weather). Odds
// move, but 60s per query|limit|status spares the keyless upstream from
// bursty agents re-asking the same question. ---

const CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const marketsCache = new Map<string, { value: MarketsData; expires: number }>();

function cacheGet(key: string): MarketsData | undefined {
  const entry = marketsCache.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    marketsCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: MarketsData): void {
  if (marketsCache.size >= MAX_CACHE_ENTRIES && !marketsCache.has(key)) {
    const oldest = marketsCache.keys().next().value;
    if (oldest !== undefined) marketsCache.delete(oldest);
  }
  marketsCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

// Test hook: the cache is module state and would leak between tests.
export function __resetPredictionMarketsStateForTests(): void {
  marketsCache.clear();
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

function deriveCategory(raw: Record<string, unknown>, event: Record<string, unknown> | undefined): string | null {
  const direct = strOrNull(raw.category) ?? strOrNull(event?.category);
  if (direct) return direct;
  const tags = Array.isArray(event?.tags) ? event.tags : [];
  const labels = new Set(
    tags
      .map((t) => (isRecord(t) ? strOrNull(t.label) : strOrNull(t)))
      .filter((l): l is string => l !== null)
      .map((l) => l.toLowerCase()),
  );
  for (const known of KNOWN_CATEGORIES) {
    if (labels.has(known.toLowerCase())) return known;
  }
  return null;
}

/**
 * Gamma market object → our snake_case contract. `event` is the search-mode
 * parent (the container the market was nested under); browse-mode markets
 * carry their own nested `events[]` instead. Returns null for junk entries
 * (no id), so a malformed row never poisons the whole list.
 */
function normalizeMarket(
  raw: Record<string, unknown>,
  parentEvent: Record<string, unknown> | undefined,
  findings: Finding[],
): Market | null {
  const id = raw.id !== undefined && raw.id !== null ? String(raw.id) : "";
  if (!id) return null;

  const nested = Array.isArray(raw.events) && isRecord(raw.events[0]) ? raw.events[0] : undefined;
  const event = parentEvent ?? nested;

  const outcomes = parseOutcomes(raw.outcomes, raw.outcomePrices);
  if (outcomes === null) {
    findings.push({
      rule: "outcomes_unparseable",
      detail: `Market ${id}: outcomes/outcomePrices could not be parsed — outcomes omitted for this market`,
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
    id,
    question: strOrNull(raw.question) ?? strOrNull(raw.title) ?? "",
    slug,
    outcomes: outcomes ?? [],
    volume_usd: round2(volume),
    volume_24h_usd: volume24h === null ? null : round2(volume24h),
    liquidity_usd: liquidity === null ? null : round2(liquidity),
    end_date: strOrNull(raw.endDate) ?? strOrNull(raw.endDateIso),
    category: deriveCategory(raw, event),
    active: raw.active === true,
    closed: raw.closed === true,
    url,
  };
}

function matchesStatus(market: Market, status: StatusKey): boolean {
  if (status === "all") return true;
  return status === "closed" ? market.closed : !market.closed;
}

async function fetchUpstreamJson(url: string, timeoutMs: number, label: string): Promise<unknown> {
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
    if (!response.ok) throw new UpstreamError(`${label} error (HTTP ${response.status})`);
    try {
      return await response.json();
    } catch {
      throw new UpstreamError(`${label} returned a malformed response`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Browse: top markets by volume (GET /markets). */
async function browseMarkets(limit: number, status: StatusKey, deadline: number): Promise<MarketsData> {
  const params = new URLSearchParams({ limit: String(limit), order: "volumeNum", ascending: "false" });
  if (status === "active") {
    params.set("active", "true");
    params.set("closed", "false");
  } else if (status === "closed") {
    params.set("active", "false");
    params.set("closed", "true");
  }
  const data = await fetchUpstreamJson(`${GAMMA_BASE}/markets?${params}`, deadline - Date.now(), "Polymarket upstream");
  if (!Array.isArray(data)) throw new UpstreamError("Polymarket upstream returned an unexpected response");

  const findings: Finding[] = [];
  const markets = collectMarkets(
    data.map((raw) => ({ raw, event: undefined })),
    limit,
    status,
    findings,
  );
  return { markets, findings, storedAt: Date.now() };
}

/** Search: keyword → events (market groups) → flattened markets (GET /public-search). */
async function searchMarkets(query: string, limit: number, status: StatusKey, deadline: number): Promise<MarketsData> {
  const params = new URLSearchParams({ q: query, limit_per_type: String(limit) });
  if (status === "active") params.set("events_status", "active");
  const data = await fetchUpstreamJson(
    `${GAMMA_BASE}/public-search?${params}`,
    deadline - Date.now(),
    "Polymarket search upstream",
  );
  if (!isRecord(data)) throw new UpstreamError("Polymarket search upstream returned an unexpected response");
  // Zero matches → the `events` key is simply absent (only `pagination` remains).
  // Neither key at all means the response shape changed under us → 502, never
  // a billed "no results".
  if (!("events" in data) && !("pagination" in data)) {
    throw new UpstreamError("Polymarket search upstream returned an unexpected response");
  }
  const events = Array.isArray(data.events) ? data.events : [];

  const candidates: Array<{ raw: unknown; event: Record<string, unknown> | undefined }> = [];
  for (const ev of events) {
    if (!isRecord(ev)) continue;
    const markets = Array.isArray(ev.markets) ? ev.markets : [];
    for (const raw of markets) candidates.push({ raw, event: ev });
  }

  const findings: Finding[] = [];
  const markets = collectMarkets(candidates, limit, status, findings);
  return { markets, findings, storedAt: Date.now() };
}

/** Normalize, status-filter, de-dupe by id (upstream order kept), cap at limit. */
function collectMarkets(
  candidates: Array<{ raw: unknown; event: Record<string, unknown> | undefined }>,
  limit: number,
  status: StatusKey,
  findings: Finding[],
): Market[] {
  const seen = new Set<string>();
  const out: Market[] = [];
  for (const { raw, event } of candidates) {
    if (out.length >= limit) break;
    if (!isRecord(raw)) continue;
    if (raw.id !== undefined && raw.id !== null && seen.has(String(raw.id))) continue;
    const market = normalizeMarket(raw, event, findings);
    if (!market) continue;
    seen.add(market.id);
    if (!matchesStatus(market, status)) continue;
    out.push(market);
  }
  return out;
}

// Raw-value twin of pickRequestParam (same body-or-query merge, query wins):
// `limit` arrives as a JSON number in POST bodies, which the string-only
// pickRequestParam would drop.
function pickRawParam(req: { query?: unknown; body?: unknown }, keys: string[]): unknown {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const query = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
  return pickField({ ...body, ...query }, keys);
}

function resolveLimit(raw: unknown, findings: Finding[]): number {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return DEFAULT_LIMIT;
  const n = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) {
    findings.push({
      rule: "invalid_limit",
      detail: `limit "${String(raw)}" is not a number — using the default of ${DEFAULT_LIMIT}`,
    });
    return DEFAULT_LIMIT;
  }
  const whole = Math.floor(n);
  if (whole < MIN_LIMIT || whole > MAX_LIMIT) {
    const clamped = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, whole));
    findings.push({
      rule: "limit_clamped",
      detail: `limit ${String(raw)} is outside ${MIN_LIMIT}..${MAX_LIMIT} — clamped to ${clamped}`,
    });
    return clamped;
  }
  return whole;
}

function resolveStatus(raw: string | undefined, findings: Finding[]): StatusKey {
  if (!raw) return "active";
  const lower = raw.toLowerCase() as StatusKey;
  if (STATUS_VALUES.includes(lower)) return lower;
  findings.push({
    rule: "invalid_status",
    detail: `Unknown status "${raw}" — using active (accepted: ${STATUS_VALUES.join(", ")})`,
  });
  return "active";
}

// --- Route ---

async function handlePredictionMarkets(req: Request, res: Response): Promise<void> {
  try {
    const query = pickRequestParam(req, QUERY_ALIASES);
    if (query !== undefined && query.length > MAX_QUERY_LENGTH) {
      throw new ValidationError(`query must be at most ${MAX_QUERY_LENGTH} characters`);
    }

    const requestFindings: Finding[] = [];
    const limit = resolveLimit(pickRawParam(req, LIMIT_ALIASES), requestFindings);
    const status = resolveStatus(pickRequestParam(req, STATUS_ALIASES), requestFindings);

    const cacheKey = `${(query ?? "").toLowerCase()}|${limit}|${status}`;
    let data = cacheGet(cacheKey);
    if (!data) {
      const deadline = Date.now() + TIMEOUT_MS;
      data = query
        ? await searchMarkets(query, limit, status, deadline)
        : await browseMarkets(limit, status, deadline);
      if (data.markets.length === 0) {
        data.findings.push({
          rule: "no_results",
          detail: query
            ? `No ${status === "all" ? "" : status + " "}markets match "${query}" on Polymarket`
            : `Polymarket returned no ${status === "all" ? "" : status + " "}markets`,
        });
      }
      cacheSet(cacheKey, data);
    }

    res.json({
      source: "polymarket",
      query: query ?? null,
      status,
      count: data.markets.length,
      markets: data.markets,
      cache_age_seconds: Math.floor((Date.now() - data.storedAt) / 1000),
      findings: [...requestFindings, ...data.findings],
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof UpstreamError) {
      res.status(502).json({ error: err.message });
      return;
    }
    console.error("Prediction markets error:", err);
    res.status(500).json({
      error: `Prediction market lookup failed: ${err instanceof Error ? err.message : "unknown error"}`,
    });
  }
}

predictionMarketsRouter.get("/prediction/markets", handlePredictionMarkets);
predictionMarketsRouter.post("/prediction/markets", handlePredictionMarkets);
