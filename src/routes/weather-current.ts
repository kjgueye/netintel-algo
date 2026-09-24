import { Router, type Request, type Response } from "express";
import { ValidationError } from "../utils/validators.js";
import { pickField, pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const weatherCurrentRouter = Router();

// Live weather + 3-day forecast from open-meteo (free, keyless, no signup) —
// same keyless-upstream-wrapper model as ip-geo. Two fixed upstream hosts
// (geocoding-api.open-meteo.com + api.open-meteo.com) and place-name/numeric
// input only, so there is no SSRF surface and deliberately no checkSsrf here.
// Billing is all-or-nothing: 200 only when a forecast is returned; city not
// found → 404 uncharged; upstream down/timeout → 502 uncharged.

// --- Constants ---

const TIMEOUT_MS = timeouts.weatherCurrent; // one shared deadline: geocode + forecast

const GEOCODE_BASE = "https://geocoding-api.open-meteo.com/v1/search";
// Reverse geocode (coords → place name); open-meteo's geocoder is forward-only, so
// we use BigDataCloud's keyless client endpoint. Best-effort only (see reverseGeocode).
const REVERSE_GEOCODE_BASE = "https://api.bigdatacloud.net/data/reverse-geocode-client";
const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";

// The synonyms agents send for each parameter (canonical name first).
const CITY_ALIASES = ["city", "location", "q", "place", "name"];
const LAT_ALIASES = ["latitude", "lat"];
const LON_ALIASES = ["longitude", "lon", "lng"];
const UNITS_ALIASES = ["units", "unit"];

const MAX_CITY_LENGTH = 200;

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

interface CurrentConditions {
  temperature: number | null;
  feels_like: number | null;
  humidity_pct: number | null;
  wind_speed: number | null;
  wind_direction_deg: number | null;
  precipitation: number | null;
  cloud_cover_pct: number | null;
  weather_code: number | null;
  condition: string | null;
  is_day: boolean;
}

interface ForecastDay {
  date: string;
  temp_max: number | null;
  temp_min: number | null;
  precipitation: number | null;
  weather_code: number | null;
  condition: string | null;
}

interface WeatherData {
  current: CurrentConditions;
  forecast: ForecastDay[];
  timezone: string | null;
  findings: Finding[];
  storedAt: number;
}

// Upstream failure (network error, timeout, non-2xx) → 502 uncharged.
class UpstreamError extends Error {}

// --- Caches (in-process Maps, wiped on deploy — same pattern as ip-geo). The
// 10-min forecast cache is required good-citizen behavior toward the keyless
// upstream, not an optimization; the geocode cache rides along because a
// city→coordinates mapping never changes on that timescale. ---

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const forecastCache = new Map<string, { value: WeatherData; expires: number }>();
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
export function __resetWeatherCurrentStateForTests(): void {
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

// Numeric twin of pickRequestParam: same body-or-query merge (query wins),
// but coordinates arrive as JSON numbers in POST bodies, which the
// string-only pickRequestParam would drop.
function pickCoordParam(
  req: { query?: unknown; body?: unknown },
  keys: string[],
  label: string,
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
  throw new ValidationError(`${label} must be a number (e.g. ${label}=${label === "latitude" ? "51.51" : "-0.13"})`);
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
 * endpoint). BEST-EFFORT: any failure (timeout, non-2xx, parse) returns null so the
 * weather response is NEVER blocked or failed just because the name lookup missed.
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
    return null; // best-effort — a naming miss must never fail the weather response
  }
}

/** Fetch current + 3-day forecast, behind the 10-min per-lat/lon/units cache. */
async function getForecast(lat: number, lon: number, units: UnitsKey, deadline: number): Promise<WeatherData> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${units}`;
  const hit = cacheGet(forecastCache, key);
  if (hit) return hit;

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current:
      "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum",
    timezone: "auto",
    forecast_days: "3",
    temperature_unit: units === "imperial" ? "fahrenheit" : "celsius",
    wind_speed_unit: units === "imperial" ? "mph" : "kmh",
    precipitation_unit: units === "imperial" ? "inch" : "mm",
  });
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

  const cur = (data.current ?? {}) as Record<string, unknown>;
  const currentCode = numOrNull(cur.weather_code);
  const current: CurrentConditions = {
    temperature: numOrNull(cur.temperature_2m),
    feels_like: numOrNull(cur.apparent_temperature),
    humidity_pct: numOrNull(cur.relative_humidity_2m),
    wind_speed: numOrNull(cur.wind_speed_10m),
    wind_direction_deg: numOrNull(cur.wind_direction_10m),
    precipitation: numOrNull(cur.precipitation),
    cloud_cover_pct: numOrNull(cur.cloud_cover),
    weather_code: currentCode,
    condition: conditionFor(currentCode),
    is_day: cur.is_day === 1,
  };

  // daily comes back as parallel arrays (time[], temperature_2m_max[], …) —
  // zip by index into per-day objects.
  const daily = (data.daily ?? {}) as Record<string, unknown[]>;
  const times = Array.isArray(daily.time) ? daily.time : [];
  const forecast: ForecastDay[] = times
    .filter((t): t is string => typeof t === "string")
    .map((date, i) => {
      const code = numOrNull(daily.weather_code?.[i]);
      return {
        date,
        temp_max: numOrNull(daily.temperature_2m_max?.[i]),
        temp_min: numOrNull(daily.temperature_2m_min?.[i]),
        precipitation: numOrNull(daily.precipitation_sum?.[i]),
        weather_code: code,
        condition: conditionFor(code),
      };
    });

  for (const code of [...unknownCodes].sort((a, b) => a - b)) {
    findings.push({
      rule: "unknown_weather_code",
      detail: `Upstream returned WMO weather code ${code}, which is not in the standard interpretation table`,
    });
  }

  const value: WeatherData = {
    current,
    forecast,
    timezone: typeof data.timezone === "string" ? data.timezone : null,
    findings,
    storedAt: Date.now(),
  };
  cacheSet(forecastCache, key, value);
  return value;
}

// --- Route ---

async function handleWeatherCurrent(req: Request, res: Response): Promise<void> {
  try {
    const city = pickRequestParam(req, CITY_ALIASES);
    const latitude = pickCoordParam(req, LAT_ALIASES, "latitude");
    const longitude = pickCoordParam(req, LON_ALIASES, "longitude");
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

    const hasCoords = latitude !== undefined && longitude !== undefined;
    if (!hasCoords && !city) {
      if (latitude !== undefined || longitude !== undefined) {
        throw new ValidationError(
          "latitude and longitude must be provided together (aliases: lat, lon/lng)",
        );
      }
      res.status(400).json({
        error:
          "Provide a city OR coordinates — e.g. /weather/current?city=London " +
          "(aliases: location, q, place, name) or ?latitude=51.51&longitude=-0.13 " +
          "(aliases: lat, lon/lng). Optional: units=metric|imperial. " +
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

    // Weather + (coords-only) best-effort reverse geocode run in parallel, so
    // naming the location adds no latency to the weather response.
    const [weather, revGeo] = await Promise.all([
      getForecast(lat, lon, units, deadline),
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
      current: weather.current,
      forecast: weather.forecast,
      units: UNIT_LABELS[units],
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
    console.error("Weather current error:", err);
    res.status(500).json({
      error: `Weather lookup failed: ${err instanceof Error ? err.message : "unknown error"}`,
    });
  }
}

weatherCurrentRouter.get("/weather/current", handleWeatherCurrent);
weatherCurrentRouter.post("/weather/current", handleWeatherCurrent);
