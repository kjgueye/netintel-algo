import { Router, type Request, type Response } from "express";
import net from "node:net";
import { ValidationError } from "../utils/validators.js";
import { pickRequestParam, IP_ALIASES } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const ipGeoRouter = Router();

// --- Constants ---

const TIMEOUT_MS = timeouts.ipGeo;

// --- Helpers ---

function isPrivateIp(ip: string): boolean {
  // IPv4
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("0.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

export interface IpGeoResult {
  ip: string;
  country: string | null;
  country_code: string | null;
  region: string | null;
  region_name: string | null;
  city: string | null;
  zip: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  isp: string | null;
  organization: string | null;
  asn: string | null;
  score: number;
  grade: string;
  findings: Finding[];
}

type GeoFields = Omit<IpGeoResult, "score" | "grade" | "findings">;

type ProviderOutcome =
  | { ok: true; fields: GeoFields }
  | { ok: false; reason: string };

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// ipapi.co — free (1k/day per source IP), HTTPS, no API key. Railway egress
// IPs are shared across tenants, so this quota exhausts unpredictably — hence
// the fallback chain below.
async function lookupIpapiCo(ip: string, timeoutMs: number): Promise<ProviderOutcome> {
  const data = await fetchJson(
    `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
    timeoutMs,
  );
  if (data.error === true || !data.country_code) {
    return { ok: false, reason: data.reason || "empty response" };
  }
  return {
    ok: true,
    fields: {
      ip: data.ip || ip,
      country: data.country_name || null,
      country_code: data.country_code || null,
      region: data.region_code || null,
      region_name: data.region || null,
      city: data.city || null,
      zip: data.postal || null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      timezone: data.timezone || null,
      isp: data.org || null,
      organization: data.org || null,
      asn: data.asn || null,
    },
  };
}

// ipwho.is — free (10k/month), HTTPS, no API key. Note: region is the full
// name and region_code the abbreviation (inverse of our contract's mapping).
async function lookupIpwhoIs(ip: string, timeoutMs: number): Promise<ProviderOutcome> {
  const data = await fetchJson(
    `https://ipwho.is/${encodeURIComponent(ip)}`,
    timeoutMs,
  );
  if (data.success === false || !data.country_code) {
    return { ok: false, reason: data.message || "empty response" };
  }
  return {
    ok: true,
    fields: {
      ip: data.ip || ip,
      country: data.country || null,
      country_code: data.country_code || null,
      region: data.region_code || null,
      region_name: data.region || null,
      city: data.city || null,
      zip: data.postal || null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      timezone: data.timezone?.id || null,
      isp: data.connection?.isp || null,
      organization: data.connection?.org || null,
      asn: data.connection?.asn ? `AS${data.connection.asn}` : null,
    },
  };
}

// ip-api.com — free (45 req/min), last resort: free tier is HTTP-only.
async function lookupIpApiCom(ip: string, timeoutMs: number): Promise<ProviderOutcome> {
  const data = await fetchJson(
    `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query`,
    timeoutMs,
  );
  if (data.status !== "success" || !data.countryCode) {
    return { ok: false, reason: data.message || "empty response" };
  }
  return {
    ok: true,
    fields: {
      ip: data.query || ip,
      country: data.country || null,
      country_code: data.countryCode || null,
      region: data.region || null,
      region_name: data.regionName || null,
      city: data.city || null,
      zip: data.zip || null,
      latitude: data.lat ?? null,
      longitude: data.lon ?? null,
      timezone: data.timezone || null,
      isp: data.isp || null,
      // ip-api has no separate org-name field for the AS; `org` is closest.
      organization: data.org || data.isp || null,
      asn: typeof data.as === "string" ? data.as.split(" ")[0] || null : null,
    },
  };
}

const PROVIDERS: {
  name: string;
  lookup: (ip: string, timeoutMs: number) => Promise<ProviderOutcome>;
}[] = [
  { name: "ipapi.co", lookup: lookupIpapiCo },
  { name: "ipwho.is", lookup: lookupIpwhoIs },
  { name: "ip-api.com", lookup: lookupIpApiCom },
];

// --- ipapi.co circuit breaker ---
// Railway's shared egress IP exhausts ipapi.co's keyless per-IP quota, and once
// rate-limited it stays rate-limited for a while — retrying it on every call
// just adds a doomed ~300-500ms round trip before the fallback. After a
// rate-limit signal, skip ipapi.co entirely for a cooldown window. Worst case
// (breaker tripped spuriously) we make the same fallback call we make today.
const IPAPI_BREAKER_MS = 10 * 60 * 1000;
let ipapiSkipUntil = 0;

function isIpapiRateLimit(reason: string): boolean {
  return /rate ?limit/i.test(reason);
}

// ipapi.co serves its over-quota page as HTML ("Please consider upgrading…"),
// which surfaces here as a JSON parse error rather than a definitive refusal.
function isIpapiQuotaHtml(err: unknown): boolean {
  return err instanceof SyntaxError;
}

// --- In-memory result cache (same pattern as the extract routes: in-process
// Map only, wiped on deploy, successful full-data results only). Geo facts
// change on a timescale of weeks, so an hour is conservative; the point is
// deduping repeat/burst queries and saving provider quota. ---
const CACHE_TTL_MS = 3600 * 1000;
const MAX_CACHE_ENTRIES = 500;
const geoCache = new Map<string, { value: IpGeoResult; expires: number }>();

function cacheGet(ip: string): IpGeoResult | undefined {
  const entry = geoCache.get(ip);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    geoCache.delete(ip);
    return undefined;
  }
  return entry.value;
}

function cacheSet(ip: string, value: IpGeoResult): void {
  if (geoCache.size >= MAX_CACHE_ENTRIES && !geoCache.has(ip)) {
    const oldest = geoCache.keys().next().value;
    if (oldest !== undefined) geoCache.delete(oldest);
  }
  geoCache.set(ip, { value, expires: Date.now() + CACHE_TTL_MS });
}

// Test hook: cache + breaker are module state and would leak between tests.
export function __resetIpGeoStateForTests(): void {
  geoCache.clear();
  ipapiSkipUntil = 0;
}

/**
 * Core geolocation logic, extracted so aggregators (e.g. ip-report-full) can
 * reuse it directly. Expects an already-validated, non-private IP.
 *
 * Tries each provider in order until one returns usable data — a paid call
 * must not ship all-null fields just because the primary's shared free-tier
 * quota is exhausted. TIMEOUT_MS bounds the whole chain, not each attempt.
 * Throws only if every provider errored at the network level (no provider
 * gave a definitive answer), so the route can 500 instead of charging for
 * nothing.
 */
export async function runIpGeo(ip: string): Promise<IpGeoResult> {
  const hit = cacheGet(ip);
  if (hit) return hit;

  const deadline = Date.now() + TIMEOUT_MS;
  const refusals: string[] = [];
  let definitiveRefusals = 0;
  let lastNetworkError: unknown = null;

  for (const [i, provider] of PROVIDERS.entries()) {
    const remaining = deadline - Date.now();
    if (remaining < 500) break;

    // Breaker tripped → skip the doomed round trip; the fallback chain
    // proceeds exactly as if ipapi.co had just refused.
    if (provider.name === "ipapi.co" && Date.now() < ipapiSkipUntil) {
      refusals.push("ipapi.co: skipped (recently rate-limited)");
      continue;
    }

    let outcome: ProviderOutcome;
    try {
      outcome = await provider.lookup(ip, remaining);
    } catch (err) {
      if (provider.name === "ipapi.co" && isIpapiQuotaHtml(err)) {
        ipapiSkipUntil = Date.now() + IPAPI_BREAKER_MS;
      }
      lastNetworkError = err;
      refusals.push(
        `${provider.name}: ${err instanceof Error ? err.message : "request failed"}`,
      );
      continue;
    }

    if (outcome.ok) {
      const findings: Finding[] = [];
      if (i > 0) {
        // Informational only — the data is complete, so no deduction.
        findings.push({
          rule: "fallback_provider",
          deduction: 0,
          detail: `primary geolocation provider unavailable (${refusals.join("; ")}); served via ${provider.name}`,
        });
      }
      const result = { ...outcome.fields, score: 100, grade: calculateGrade(100), findings };
      // Cache only full-data successes — never the degraded all-null result.
      cacheSet(ip, result);
      return result;
    }
    if (provider.name === "ipapi.co" && isIpapiRateLimit(outcome.reason)) {
      ipapiSkipUntil = Date.now() + IPAPI_BREAKER_MS;
    }
    definitiveRefusals++;
    refusals.push(`${provider.name}: ${outcome.reason}`);
  }

  // No provider returned data. If every attempt died at the network level,
  // surface the error so the route 500s instead of charging for nulls; if at
  // least one answered definitively (e.g. "Reserved IP Address"), grade it
  // down but respond — the lookup itself worked, the IP has no geo data.
  if (definitiveRefusals === 0 && lastNetworkError !== null) {
    throw lastNetworkError;
  }

  const findings: Finding[] = [
    {
      rule: "lookup_failed",
      deduction: -60,
      detail: refusals.join("; ") || "Geolocation lookup failed",
    },
  ];
  const score = Math.max(0, 100 - 60);

  return {
    ip,
    country: null,
    country_code: null,
    region: null,
    region_name: null,
    city: null,
    zip: null,
    latitude: null,
    longitude: null,
    timezone: null,
    isp: null,
    organization: null,
    asn: null,
    score,
    grade: calculateGrade(score),
    findings,
  };
}

// --- Route ---

ipGeoRouter.get("/ip-geo/locate", async (req: Request, res: Response) => {
  try {
    // Tolerate the common synonyms and body-sent params agents use (see
    // field-aliases.ts) — every rejected synonym is a paid call that bounces.
    const ip = pickRequestParam(req, IP_ALIASES);

    if (!ip) {
      res.status(400).json({
        error:
          'ip is required — pass an IP address as the `ip` query param, ' +
          'e.g. /ip-geo/locate?ip=8.8.8.8 (aliases accepted: target, address, host).',
      });
      return;
    }

    if (!net.isIP(ip)) {
      throw new ValidationError("Invalid IP address format");
    }

    if (isPrivateIp(ip)) {
      res.status(400).json({ error: "Private IP addresses cannot be geolocated" });
      return;
    }

    res.json(await runIpGeo(ip));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("IP geolocation error:", err);
    res.status(500).json({
      error: `Geolocation lookup failed: ${err instanceof Error ? err.message : "unknown error"}`,
    });
  }
});
