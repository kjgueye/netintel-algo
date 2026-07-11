import dns from "node:dns/promises";
import net from "node:net";

const DOMAIN_RE =
  /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,}$/;

// RFC 1918 + loopback + link-local + reserved ranges
const PRIVATE_RANGES_V4 = [
  { prefix: "10.", mask: 8 },
  { prefix: "127.", mask: 8 },
  { prefix: "169.254.", mask: 16 },
  { prefix: "192.168.", mask: 16 },
];

function isPrivateIPv4(ip: string): boolean {
  if (ip.startsWith("0.")) return true;
  for (const range of PRIVATE_RANGES_V4) {
    if (ip.startsWith(range.prefix)) return true;
  }
  // 172.16.0.0 - 172.31.255.255
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  // 100.64.0.0/10 (CGNAT)
  if (ip.startsWith("100.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 64 && second <= 127) return true;
  }
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
}

/**
 * Echo of "what you sent" for validation errors — truncated so the message
 * stays readable (and under error-detail's MESSAGE_CAP) even when an agent
 * sends a whole prompt as a parameter value.
 */
export function fmtReceived(value: string): string {
  return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
}

/**
 * Undo percent-encoding that survived Express's single query-string decode.
 * Agents that double-encode send `10.0.0.0%2F24` and it reaches the handler
 * still encoded (observed live in paid_call_failures). Only attempted when a
 * `%` is present — values these validators accept never contain a literal
 * `%`, so a second decode cannot corrupt already-valid input. Malformed
 * sequences are left as-is rather than throwing.
 */
export function decodeLeftoverPercentEncoding(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function validateDomain(domain: string): string {
  const cleaned = decodeLeftoverPercentEncoding(domain.trim())
    .toLowerCase()
    .replace(/\.$/, "");
  if (!cleaned || cleaned.length > 253 || !DOMAIN_RE.test(cleaned)) {
    throw new ValidationError(
      `Invalid domain name: ${fmtReceived(domain)} — expected a bare registrable domain, e.g. example.com (no scheme, path, or spaces)`
    );
  }
  return cleaned;
}

export async function checkSsrf(hostname: string): Promise<void> {
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new ValidationError(`Cannot resolve hostname: ${hostname}`);
  }

  for (const { address, family } of addresses) {
    const isPrivate =
      family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
    if (isPrivate) {
      throw new ValidationError(
        "Target resolves to a private/reserved address"
      );
    }
  }
}

export function validateUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Second chance for double-encoded URLs (https%3A%2F%2F…) before rejecting.
    try {
      parsed = new URL(decodeLeftoverPercentEncoding(trimmed));
    } catch {
      throw new ValidationError(
        `Invalid URL: ${fmtReceived(rawUrl)} — expected an absolute http(s) URL, e.g. https://example.com/page`
      );
    }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new ValidationError(
      `URL must use http or https protocol — received ${fmtReceived(parsed.protocol)}, e.g. https://example.com`
    );
  if (!parsed.hostname) throw new ValidationError("URL must contain a hostname, e.g. https://example.com");
  if (parsed.username || parsed.password)
    throw new ValidationError("URL must not contain credentials (user:pass@)");
  return parsed;
}

export function validateCidr(cidr: string): string {
  // Tolerate double-encoded input (`10.0.0.0%2F24`) — see
  // decodeLeftoverPercentEncoding. The decoded form is what gets calculated on.
  const trimmed = decodeLeftoverPercentEncoding(cidr.trim());

  const invalid = () =>
    new ValidationError(
      `Invalid CIDR: ${fmtReceived(cidr)} — expected ip/prefix notation, e.g. 192.168.1.0/24 (IPv4) or 2001:db8::/48 (IPv6)`
    );

  // Basic CIDR format: ip/prefix
  const parts = trimmed.split("/");
  if (parts.length !== 2) {
    throw invalid();
  }

  const [ip, prefixStr] = parts;
  const prefix = parseInt(prefixStr, 10);

  if (isNaN(prefix) || prefix < 0) {
    throw invalid();
  }

  if (net.isIPv4(ip)) {
    if (prefix > 32) throw invalid();
  } else if (net.isIPv6(ip)) {
    if (prefix > 128) throw invalid();
  } else {
    throw invalid();
  }

  return trimmed;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Lightweight check that an extracted object contains the fields the caller
 * marked `required` in their JSON-Schema-shaped `target_schema`.
 *
 * Deliberately PRESENCE-ONLY and lenient: it does NOT enforce types, formats,
 * enums, or nested schemas. The goal is to avoid billing for an extraction that
 * dropped required fields — never to reject output that works today. A required
 * field present but null/undefined counts as missing, because the extractor is
 * told to use null when a value can't be found.
 *
 * Returns [] when satisfied — and is a true no-op (always []) when the schema
 * declares no `required` array. Otherwise returns human-readable problems.
 */
export function validateAgainstSchema(value: unknown, schema: any): string[] {
  const required = schema?.required;
  if (!Array.isArray(required) || required.length === 0) return [];

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [`expected an object with required fields: ${required.join(", ")}`];
  }

  const obj = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of required) {
    if (typeof field !== "string") continue;
    const v = obj[field];
    if (!(field in obj) || v === null || v === undefined) {
      problems.push(`missing required field: ${field}`);
    }
  }
  return problems;
}
