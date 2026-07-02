// Inlined from NetIntel src/utils/validators.ts (ported verbatim) so this
// service stays fully self-contained. Shared by the ported route handlers;
// src/currency-exchange.ts keeps its own inlined copy untouched.
import dns from "node:dns/promises";

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
    const second = parseInt(ip.split(".")[1] ?? "", 10);
    if (second >= 16 && second <= 31) return true;
  }
  // 100.64.0.0/10 (CGNAT)
  if (ip.startsWith("100.")) {
    const second = parseInt(ip.split(".")[1] ?? "", 10);
    if (second >= 64 && second <= 127) return true;
  }
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
}

export function validateDomain(domain: string): string {
  const cleaned = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!cleaned || cleaned.length > 253 || !DOMAIN_RE.test(cleaned)) {
    throw new ValidationError("Invalid domain name");
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
      throw new ValidationError("Target resolves to a private/reserved address");
    }
  }
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
