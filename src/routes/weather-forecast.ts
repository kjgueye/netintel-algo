import { Router, type Request, type Response } from "express";
import { ValidationError } from "../utils/validators.js";
import { pickField, pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const weatherForecastRouter = Router();

// Multi-day forecast companion to /weather/current — the dedicated planning
// endpoint: up to 16 days of rich daily fields plus an optional next-24h hourly
// block. Same keyless open-meteo upstreams (geocoding-api.open-meteo.com +
// api.open-meteo.com), fixed hosts and place-name/numeric input only, so there
// is no SSRF surface and deliberately no checkSsrf here. Routes are
// self-contained, so the geocode/WMO/units/cache helpers are copied from
// weather-current rather than shared. Billing is all-or-nothing: 200 only when
// a forecast is returned; city not found → 404 uncharged; upstream
// down/timeout → 502 uncharged.

// --- Constants ---

const TIMEOUT_MS = timeouts.weatherForecast; // one shared deadline: geocode + forecast

const GEOCODE_BASE = "https://geocoding-api.open-meteo.com/v1/search";
// Reverse geocode (coords → place name). open-meteo's geocoder is forward-only,
// so we use BigDataCloud's keyless client endpoint. Best-effort only (see reverseGeocode).
const REVERSE_GEOCODE_BASE = "https://api.bigdatacloud.net/data/reverse-geocode-client";
const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";

// The synonyms agents send for each parameter (canonical name first).
const CITY_ALIASES = ["city", "location", "q", "place", "name"];
const LAT_ALIASES = ["latitude", "lat"];
const LON_ALIASES = ["longitude", "lon", "lng"];
const DAYS_ALIASES = ["days", "forecast_days"];
const HOURLY_ALIASES = ["hourly", "include_hourly"];
const UNITS_ALIASES = ["units", "unit"];

const MAX_CITY_LENGTH = 200;

const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 16;
const HOURLY_HOURS = 24;

// Daily fields requested from open-meteo (parallel arrays, zipped by index).
const DAILY_FIELDS =
  "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant";

// Hourly fields — only appended to the URL when hourly output is requested,
// otherwise open-meteo returns a large hourly payload we don't need.
const HOURLY_FIELDS =
  "temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m";

// WMO weather interpretation codes → plain-language condition.
const WMO: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Fog",
  51: "Drizzle",
  53: "Drizzle",
  55: "Drizzle",
  56: "Freezing drizzle",
  57: "Freezing drizzle",
  61: "Rain",
  63: "Rain",
  65: "Rain",
  66: "Freezing rain",
  67: "Freezing rain",
  71: "Snow",
  73: "Snow",
  75: "Snow",
  77: "Snow grains",
  80: "Rain showers",
  81: "Rain showers",
  82: "Rain showers",
  85: "Snow showers",
  86: "Snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with hail",
};

type UnitsKey = "metric" | "imperial";

// Field names stay unit-agnostic; the labels carry the unit.
const UNIT_LABELS: Record<UnitsKey, { temperature: string; wind_speed: string; precipitation: string }> = {
  metric: { temperature: "°C", wind_speed: "km/h", precipitation: "mm" },
  imperial: { temperature: "°F", wind_speed: "mph", precipitation: "inch" },
};

// --- Interfaces ---

interface Finding {
  rule: string;
  detail: string;
}

interface GeoHit {
  name: string | null;
  country: string | null;
  region: string | null;
  latitude: number;
  longitude: number;
}

interface ForecastDay {
  date: string;
  temp_max: number | null;
  temp_min: number | null;
  feels_like_max: number | null;
  feels_like_min: number | null;
  precipitation: number | null;
  precip_probability_pct: number | null;
  uv_index_max: number | null;
  sunrise: string | null;
  sunset: string | null;
  wind_speed_max: number | null;
  wind_gusts_max: number | null;
  wind_direction_deg: number | null;
  weather_code: number | null;
  condition: string | null;
}

interface ForecastHour {
  time: string;
  temperature: number | null;
  precipitation: number | null;
  precip_probability_pct: number | null;
  wind_speed: number | null;
  weather_code: number | null;
  condition: string | null;
}

interface ForecastData {
  daily: ForecastDay[];
  hourly?: ForecastHour[]; // present only when the caller asked for it
  timezone: string | null;
  findings: Finding[];
  storedAt: number;
}

// Upstream failure (network error, timeout, non-2xx) → 502 uncharged.
class UpstreamError extends Error {}

// --- Caches (in-process Maps, wiped on deploy — same pattern as
// weather-current). The 10-min forecast cache is required good-citizen behavior
// toward the keyless upstream, not an optimization; the geocode cache rides
// along because a city→coordinates mapping never changes on that timescale. ---

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const forecastCache = new Map<string, { value: ForecastData; expires: number }>();
const geocodeCache = new Map<string, { value: GeoHit; expires: number }>();
const reverseCache = new Map<string, { value: GeoHit; expires: number }>();

function cacheGet<T>(cache: Map<string, { value: T; expires: number }>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet<T>(cache: Map<string, { value: T; expires: number }>, key: string, value: T): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

// Test hook: caches are module state and would leak between tests.
export function __resetWeatherForecastStateForTests(): void {
  forecastCache.clear();
  geocodeCache.clear();
  reverseCache.clear();
}

// --- Helpers ---

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// Numeric twin of pickRequestParam: same body-or-query merge (query wins),
// but numbers arrive as JSON numbers in POST bodies, which the string-only
// pickRequestParam would drop.
function pickNumberParam(
  req: { query?: unknown; body?: unknown },
  keys: string[],
  label: string,
  example: string,
): number | undefined {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const query = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
  const v = pickField({ ...body, ...query }, keys);
  if (v === undefined) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  throw new ValidationError(`${label} must be a number (e.g. ${label}=${example})`);
}

// Boolean twin: accepts JSON booleans, 1/0, and the usual string spellings.
// A bare flag (?hourly) counts as true; unrecognized values return undefined
// so the caller can fall back with a finding.
function pickBoolParam(
  req: { query?: unknown; body?: unknown },
  keys: string[],
): { value: boolean; raw: unknown } | undefined {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const query = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
  const v = pickField({ ...body, ...query }, keys);
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return { value: v, raw: v };
  if (typeof v === "number") {
    if (v === 1) return { value: true, raw: v };
    if (v === 0) return { value: false, raw: v };
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on", ""].includes(s)) return { value: true, raw: v };
    if (["false", "0", "no", "n", "off"].includes(s)) return { value: false, raw: v };
  }
  return { value: false, raw: v }; // unrecognized — caller adds a finding
}

async function fetchUpstreamJson(
  url: string,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  if (timeoutMs < 250) throw new UpstreamError(`${label} timed out`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url, { signal: controller.signal });
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

/** Resolve a free-text place name via open-meteo geocoding; null = not found. */
async function geocodeCity(city: string, deadline: number): Promise<GeoHit | null> {
  const key = city.toLowerCase();
  const hit = cacheGet(geocodeCache, key);
  if (hit) return hit;

  const params = new URLSearchParams({ name: city, count: "1", language: "en", format: "json" });
  const data = (await fetchUpstreamJson(
    `${GEOCODE_BASE}?${params}`,
    deadline - Date.now(),
    "Geocoding service",
  )) as { results?: Array<Record<string, unknown>> };

  const top = Array.isArray(data?.results) ? data.results[0] : undefined;
  const latitude = numOrNull(top?.latitude);
  const longitude = numOrNull(top?.longitude);
  if (!top || latitude === null || longitude === null) return null;

  const geo: GeoHit = {
    name: typeof top.name === "string" ? top.name : city,
    country: typeof top.country === "string" ? top.country : null,
    region: typeof top.admin1 === "string" ? top.admin1 : null,
    latitude,
    longitude,
  };
  cacheSet(geocodeCache, key, geo);
  return geo;
}

/** Reverse-geocode coordinates → place name via BigDataCloud (keyless client
 * endpoint). BEST-EFFORT: any failure (timeout, non-2xx, parse) returns null so a
 * forecast is NEVER blocked or failed just because the name lookup didn't resolve.
 * Cached (10-min) like geocodeCity; only successes are cached so failures retry. */
async function reverseGeocode(lat: number, lon: number, deadline: number): Promise<GeoHit | null> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cacheGet(reverseCache, key);
  if (hit) return hit;
  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      localityLanguage: "en",
    });
    const data = (await fetchUpstreamJson(
      `${REVERSE_GEOCODE_BASE}?${params}`,
      deadline - Date.now(),
      "Reverse geocoding",
    )) as Record<string, unknown>;
    const name =
      (typeof data.city === "string" && data.city) ||
      (typeof data.locality === "string" && data.locality) ||
      null;
    const geo: GeoHit = {
      name: name || null,
      country: typeof data.countryName === "string" ? data.countryName : null,
      region: typeof data.principalSubdivision === "string" ? data.principalSubdivision : null,
      latitude: lat,
      longitude: lon,
    };
    cacheSet(reverseCache, key, geo);
    return geo;
  } catch {
    return null; // best-effort — a naming miss must never fail the forecast
  }
}

/** Fetch the multi-day forecast, behind the 10-min per-lat/lon/units/days/hourly cache. */
async function getForecast(
  lat: number,
  lon: number,
  units: UnitsKey,
  days: number,
  wantHourly: boolean,
  deadline: number,
): Promise<ForecastData> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${units},${days},${wantHourly ? 1 : 0}`;
  const hit = cacheGet(forecastCache, key);
  if (hit) return hit;

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: DAILY_FIELDS,
    timezone: "auto",
    forecast_days: String(days),
    temperature_unit: units === "imperial" ? "fahrenheit" : "celsius",
    wind_speed_unit: units === "imperial" ? "mph" : "kmh",
    precipitation_unit: units === "imperial" ? "inch" : "mm",
  });
  if (wantHourly) params.set("hourly", HOURLY_FIELDS);
  const data = (await fetchUpstreamJson(
    `${FORECAST_BASE}?${params}`,
    deadline - Date.now(),
    "Weather upstream",
  )) as Record<string, unknown>;
  if (!data || typeof data !== "object") throw new UpstreamError("Weather upstream returned no data");

  const findings: Finding[] = [];
  const unknownCodes = new Set<number>();
  const conditionFor = (code: number | null): string | null => {
    if (code === null) return null;
    const known = WMO[code];
    if (known) return known;
    unknownCodes.add(code);
    return `Unknown (code ${code})`;
  };

  // daily comes back as parallel arrays (time[], temperature_2m_max[], …) —
  // zip by index into per-day objects.
  const dailyRaw = (data.daily ?? {}) as Record<string, unknown[]>;
  const times = Array.isArray(dailyRaw.time) ? dailyRaw.time : [];
  const daily: ForecastDay[] = times
    .filter((t): t is string => typeof t === "string")
    .map((date, i) => {
      const code = numOrNull(dailyRaw.weather_code?.[i]);
      return {
        date,
        temp_max: numOrNull(dailyRaw.temperature_2m_max?.[i]),
        temp_min: numOrNull(dailyRaw.temperature_2m_min?.[i]),
        feels_like_max: numOrNull(dailyRaw.apparent_temperature_max?.[i]),
        feels_like_min: numOrNull(dailyRaw.apparent_temperature_min?.[i]),
        precipitation: numOrNull(dailyRaw.precipitation_sum?.[i]),
        // can be null for far-out days — passed through as null.
        precip_probability_pct: numOrNull(dailyRaw.precipitation_probability_max?.[i]),
        uv_index_max: numOrNull(dailyRaw.uv_index_max?.[i]),
        sunrise: strOrNull(dailyRaw.sunrise?.[i]),
        sunset: strOrNull(dailyRaw.sunset?.[i]),
        wind_speed_max: numOrNull(dailyRaw.wind_speed_10m_max?.[i]),
        wind_gusts_max: numOrNull(dailyRaw.wind_gusts_10m_max?.[i]),
        wind_direction_deg: numOrNull(dailyRaw.wind_direction_10m_dominant?.[i]),
        weather_code: code,
        condition: conditionFor(code),
      };
    });

  // Hourly = next 24h only. open-meteo returns hourly for whole local days;
  // find the current hour in hourly.time (local ISO, derived from now +
  // utc_offset_seconds) and slice 24 entries from there.
  let hourly: ForecastHour[] | undefined;
  if (wantHourly) {
    const hourlyRaw = (data.hourly ?? {}) as Record<string, unknown[]>;
    const hourTimes = (Array.isArray(hourlyRaw.time) ? hourlyRaw.time : []).filter(
      (t): t is string => typeof t === "string",
    );
    const offsetSec = numOrNull(data.utc_offset_seconds) ?? 0;
    const nowLocalHour = new Date(Date.now() + offsetSec * 1000).toISOString().slice(0, 13) + ":00";
    let start = hourTimes.indexOf(nowLocalHour);
    if (start === -1) start = hourTimes.findIndex((t) => t >= nowLocalHour);
    if (start === -1) start = Math.max(0, hourTimes.length - HOURLY_HOURS);
    hourly = hourTimes.slice(start, start + HOURLY_HOURS).map((time, j) => {
      const i = start + j;
      const code = numOrNull(hourlyRaw.weather_code?.[i]);
      return {
        time,
        temperature: numOrNull(hourlyRaw.temperature_2m?.[i]),
        precipitation: numOrNull(hourlyRaw.precipitation?.[i]),
        precip_probability_pct: numOrNull(hourlyRaw.precipitation_probability?.[i]),
        wind_speed: numOrNull(hourlyRaw.wind_speed_10m?.[i]),
        weather_code: code,
        condition: conditionFor(code),
      };
    });
  }

  for (const code of [...unknownCodes].sort((a, b) => a - b)) {
    findings.push({
      rule: "unknown_weather_code",
      detail: `Upstream returned WMO weather code ${code}, which is not in the standard interpretation table`,
    });
  }

  const value: ForecastData = {
    daily,
    ...(hourly !== undefined ? { hourly } : {}),
    timezone: typeof data.timezone === "string" ? data.timezone : null,
    findings,
    storedAt: Date.now(),
  };
  cacheSet(forecastCache, key, value);
  return value;
}

// --- Route ---

async function handleWeatherForecast(req: Request, res: Response): Promise<void> {
  try {
    const city = pickRequestParam(req, CITY_ALIASES);
    const latitude = pickNumberParam(req, LAT_ALIASES, "latitude", "51.51");
    const longitude = pickNumberParam(req, LON_ALIASES, "longitude", "-0.13");
    const daysRaw = pickNumberParam(req, DAYS_ALIASES, "days", "7");
    const hourlyPick = pickBoolParam(req, HOURLY_ALIASES);
    const unitsRaw = pickRequestParam(req, UNITS_ALIASES);

    const requestFindings: Finding[] = [];

    let units: UnitsKey = "metric";
    if (unitsRaw) {
      const u = unitsRaw.toLowerCase();
      if (u === "imperial") units = "imperial";
      else if (u !== "metric") {
        requestFindings.push({
          rule: "unknown_units",
          detail: `Unknown units "${unitsRaw}" — using metric (accepted: metric, imperial)`,
        });
      }
    }

    let days = DEFAULT_DAYS;
    if (daysRaw !== undefined) {
      days = Math.round(daysRaw);
      if (days < MIN_DAYS || days > MAX_DAYS) {
        const clamped = Math.min(MAX_DAYS, Math.max(MIN_DAYS, days));
        requestFindings.push({
          rule: "days_clamped",
          detail: `days=${daysRaw} is out of range — clamped to ${clamped} (accepted: ${MIN_DAYS}-${MAX_DAYS})`,
        });
        days = clamped;
      }
    }

    let wantHourly = false;
    if (hourlyPick !== undefined) {
      wantHourly = hourlyPick.value;
      const raw = hourlyPick.raw;
      const recognized =
        typeof raw === "boolean" ||
        raw === 0 ||
        raw === 1 ||
        (typeof raw === "string" &&
          ["true", "1", "yes", "y", "on", "", "false", "0", "no", "n", "off"].includes(
            raw.trim().toLowerCase(),
          ));
      if (!recognized) {
        requestFindings.push({
          rule: "unknown_hourly",
          detail: `Unrecognized hourly value "${String(raw)}" — hourly omitted (accepted: true/false or 1/0)`,
        });
      }
    }

    const hasCoords = latitude !== undefined && longitude !== undefined;
    if (!hasCoords && !city) {
      if (latitude !== undefined || longitude !== undefined) {
        throw new ValidationError(
          "latitude and longitude must be provided together (aliases: lat, lon/lng)",
        );
      }
      res.status(400).json({
        error:
          "Provide a city OR coordinates — e.g. /weather/forecast?city=London " +
          "(aliases: location, q, place, name) or ?latitude=51.51&longitude=-0.13 " +
          "(aliases: lat, lon/lng). Optional: days=1-16 (default 7, alias forecast_days), " +
          "hourly=true for the next 24h (alias include_hourly), units=metric|imperial. " +
          "Params are accepted as query (GET) or a JSON body (POST).",
      });
      return;
    }

    const deadline = Date.now() + TIMEOUT_MS;
    let geo: GeoHit | null = null;
    let lat: number;
    let lon: number;

    if (hasCoords) {
      // Coordinates win over city — no geocode round trip.
      if (latitude < -90 || latitude > 90) {
        throw new ValidationError("latitude must be between -90 and 90");
      }
      if (longitude < -180 || longitude > 180) {
        throw new ValidationError("longitude must be between -180 and 180");
      }
      lat = latitude;
      lon = longitude;
    } else {
      if (city!.length > MAX_CITY_LENGTH) {
        throw new ValidationError(`city must be at most ${MAX_CITY_LENGTH} characters`);
      }
      geo = await geocodeCity(city!, deadline);
      if (!geo) {
        res.status(404).json({ error: `No location found for "${city}"` });
        return;
      }
      lat = geo.latitude;
      lon = geo.longitude;
    }

    // Forecast + (coords-only) best-effort reverse geocode run in parallel, so
    // naming the location adds no latency to the forecast itself.
    const [weather, revGeo] = await Promise.all([
      getForecast(lat, lon, units, days, wantHourly, deadline),
      hasCoords ? reverseGeocode(lat, lon, deadline) : Promise.resolve(null),
    ]);
    if (revGeo) geo = revGeo; // fill name/country/region for coordinate input

    res.json({
      location: {
        name: geo?.name ?? null,
        country: geo?.country ?? null,
        region: geo?.region ?? null,
        latitude: round2(lat),
        longitude: round2(lon),
        timezone: weather.timezone,
      },
      daily: weather.daily,
      // hourly is present ONLY when requested — never an empty placeholder.
      ...(weather.hourly !== undefined ? { hourly: weather.hourly } : {}),
      units: UNIT_LABELS[units],
      days,
      source: "open-meteo",
      cache_age_seconds: Math.floor((Date.now() - weather.storedAt) / 1000),
      findings: [...requestFindings, ...weather.findings],
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
    console.error("Weather forecast error:", err);
    res.status(500).json({
      error: `Weather forecast failed: ${err instanceof Error ? err.message : "unknown error"}`,
    });
  }
}

weatherForecastRouter.get("/weather/forecast", handleWeatherForecast);
weatherForecastRouter.post("/weather/forecast", handleWeatherForecast);
