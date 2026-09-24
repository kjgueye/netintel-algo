import crypto from "node:crypto";
import tls from "node:tls";
import { Router, type Request, type Response } from "express";
import { timeouts } from "../config.js";
import { ValidationError, validateDomain } from "../utils/validators.js";
import { pickField, pickRequestParam } from "../utils/field-aliases.js";

export const sslCertQuickRouter = Router();

// Fast, single-handshake SSL/TLS cert facts — the light tier under
// /ssl/analyze (src/routes/ssl.ts). Deliberately duplicates that file's TLS
// connect + cert-parsing approach inline (routes stay self-contained) rather
// than sharing code — this tier skips analyze's protocol-version probing and
// grading entirely, one handshake only.

const DOMAIN_ALIASES = ["domain", "host", "hostname", "url", "site"];
const PORT_ALIASES = ["port", "p"];
const MIN_PORT = 1;
const MAX_PORT = 65535;
const DEFAULT_PORT = 443;
const MAX_SANS = 25;

// Certs don't churn; probes do — 5 min per domain:port is plenty fresh.
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

interface Finding {
  rule: string;
  detail: string;
}

interface QuickCertResult {
  domain: string;
  port: number;
  subject: string | null;
  issuer: { common_name: string | null; organization: string | null };
  sans: string[];
  sans_truncated: boolean;
  valid_from: string | null;
  valid_to: string | null;
  days_remaining: number | null;
  expired: boolean;
  not_yet_valid: boolean;
  self_signed: boolean;
  chain_length: number;
  tls_version: string | null;
  sig_alg: string | null;
  key: { type: string | null; bits: number | null };
  findings: Finding[];
  storedAt: number;
}

// A cert was retrieved (even expired/self-signed — that IS the answer): 200
// billed. This error means we never got one at all: uncharged.
class UnreachableError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// --- Cache (in-process Map, wiped on deploy — same pattern as ip-geo /
// weather-current) ---

const cache = new Map<string, { value: QuickCertResult; expires: number }>();

function cacheGet(key: string): QuickCertResult | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: QuickCertResult): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

// Test hook: the cache is module state and would leak between tests.
export function __resetSslCertQuickStateForTests(): void {
  cache.clear();
}

// --- Helpers ---

/** A pasted URL (scheme + path) resolves to its host; a bare domain passes through untouched. */
function extractHostname(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      // fall through — validateDomain below rejects with a clear error
    }
  }
  return trimmed;
}

// Numeric twin of pickRequestParam (query OR JSON body, query wins). A
// non-numeric port 400s; an out-of-range numeric port clamps + records a
// finding rather than rejecting the whole call.
function pickPort(req: Request, findings: Finding[]): number {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const query = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
  const raw = pickField({ ...body, ...query }, PORT_ALIASES);
  if (raw === undefined) return DEFAULT_PORT;

  let n: number;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    n = raw;
  } else if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw.trim()))) {
    n = Number(raw.trim());
  } else {
    throw new ValidationError(`port must be a number (e.g. port=443) — received ${JSON.stringify(String(raw))}`);
  }

  const rounded = Math.round(n);
  if (rounded < MIN_PORT || rounded > MAX_PORT) {
    const clamped = Math.min(MAX_PORT, Math.max(MIN_PORT, rounded));
    findings.push({
      rule: "port_clamped",
      detail: `port=${raw} is out of range — clamped to ${clamped} (accepted: ${MIN_PORT}-${MAX_PORT})`,
    });
    return clamped;
  }
  return rounded;
}

function getCertField(obj: tls.Certificate | undefined, key: string): string | null {
  if (!obj) return null;
  const val = (obj as unknown as Record<string, unknown>)[key];
  return typeof val === "string" ? val : null;
}

function parseSans(subjectaltname: string | undefined): string[] {
  if (!subjectaltname) return [];
  const sans: string[] = [];
  for (const entry of subjectaltname.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.startsWith("DNS:")) sans.push(trimmed.slice(4));
  }
  return sans;
}

// Counts the leaf + every distinct cert reachable via issuerCertificate,
// guarding the classic self-referencing root loop (a root CA's
// issuerCertificate commonly points back at itself).
function countChainLength(cert: tls.DetailedPeerCertificate): number {
  let count = 1;
  const seen = new Set<string>([cert.serialNumber]);
  let current = cert.issuerCertificate;
  while (current && current.serialNumber && !seen.has(current.serialNumber)) {
    seen.add(current.serialNumber);
    count++;
    if (!current.issuerCertificate || current.issuerCertificate.serialNumber === current.serialNumber) break;
    current = current.issuerCertificate;
  }
  return count;
}

function getKeyInfo(cert: tls.DetailedPeerCertificate): { type: string | null; bits: number | null } {
  const pubkey = cert.pubkey;
  if (!pubkey) return { type: null, bits: null };
  try {
    const keyObj = crypto.createPublicKey({ key: pubkey, format: "der", type: "spki" });
    const kind = keyObj.asymmetricKeyType;
    if (kind === "rsa") {
      const jwk = keyObj.export({ format: "jwk" });
      const bits = jwk.n ? Math.ceil((jwk.n.length * 6) / 8) * 8 : null;
      return { type: "RSA", bits };
    }
    if (kind === "ec") {
      const jwk = keyObj.export({ format: "jwk" });
      const bits = jwk.crv === "P-256" ? 256 : jwk.crv === "P-384" ? 384 : jwk.crv === "P-521" ? 521 : null;
      return { type: "EC", bits };
    }
    return { type: kind ? kind.toUpperCase() : null, bits: null };
  } catch {
    return { type: null, bits: null };
  }
}

function tlsConnectQuick(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ socket: tls.TLSSocket; cert: tls.DetailedPeerCertificate }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, timeout: timeoutMs, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate(true);
        resolve({ socket, cert });
      },
    );
    socket.on("error", (err: NodeJS.ErrnoException) => {
      socket.destroy();
      if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
        reject(new UnreachableError(404, `Domain not found: ${host}`));
      } else {
        reject(new UnreachableError(502, `Could not reach ${host}:${port} — ${err.message}`));
      }
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new UnreachableError(504, `Could not reach ${host}:${port} — connection timed out`));
    });
  });
}

async function fetchQuickCert(host: string, port: number): Promise<QuickCertResult> {
  const { socket, cert } = await tlsConnectQuick(host, port, timeouts.sslCertQuick);
  if (!cert || !cert.subject) {
    socket.destroy();
    throw new UnreachableError(502, `Could not reach ${host}:${port} — no certificate returned`);
  }

  const tlsVersion = socket.getProtocol() || null;
  socket.destroy();

  const subjectCn = getCertField(cert.subject, "CN");
  const issuerCn = getCertField(cert.issuer, "CN");
  const issuerO = getCertField(cert.issuer, "O");

  const allSans = parseSans(cert.subjectaltname);
  const sansTruncated = allSans.length > MAX_SANS;
  const sans = sansTruncated ? allSans.slice(0, MAX_SANS) : allSans;

  const validFromDate = cert.valid_from ? new Date(cert.valid_from) : null;
  const validToDate = cert.valid_to ? new Date(cert.valid_to) : null;
  const now = Date.now();

  const daysRemaining =
    validToDate && !Number.isNaN(validToDate.getTime())
      ? Math.floor((validToDate.getTime() - now) / 86_400_000)
      : null;
  const expired = daysRemaining !== null && daysRemaining < 0;
  const notYetValid = !!validFromDate && !Number.isNaN(validFromDate.getTime()) && validFromDate.getTime() > now;
  const selfSigned = !!subjectCn && subjectCn === issuerCn;

  const findings: Finding[] = [];
  if (expired) {
    findings.push({ rule: "cert_expired", detail: `Certificate expired ${Math.abs(daysRemaining as number)} day(s) ago` });
  }
  if (notYetValid) {
    findings.push({
      rule: "cert_not_yet_valid",
      detail: `Certificate is not valid until ${(validFromDate as Date).toISOString()}`,
    });
  }
  if (selfSigned) {
    findings.push({ rule: "self_signed", detail: "Certificate is self-signed" });
  }

  return {
    domain: host,
    port,
    subject: subjectCn,
    issuer: { common_name: issuerCn, organization: issuerO },
    sans,
    sans_truncated: sansTruncated,
    valid_from: validFromDate && !Number.isNaN(validFromDate.getTime()) ? validFromDate.toISOString() : null,
    valid_to: validToDate && !Number.isNaN(validToDate.getTime()) ? validToDate.toISOString() : null,
    days_remaining: daysRemaining,
    expired,
    not_yet_valid: notYetValid,
    self_signed: selfSigned,
    chain_length: countChainLength(cert),
    tls_version: tlsVersion,
    sig_alg: ((cert as unknown as Record<string, unknown>).signatureAlgorithm as string) || null,
    key: getKeyInfo(cert),
    findings,
    storedAt: Date.now(),
  };
}

function toResponse(result: QuickCertResult, requestFindings: Finding[]) {
  const { storedAt, findings, ...rest } = result;
  return {
    ...rest,
    cache_age_seconds: Math.floor((Date.now() - storedAt) / 1000),
    findings: [...requestFindings, ...findings],
  };
}

// --- Route ---

async function handleSslCertQuick(req: Request, res: Response): Promise<void> {
  try {
    const rawDomain = pickRequestParam(req, DOMAIN_ALIASES);
    if (!rawDomain) {
      res.status(400).json({
        error: "domain is required — e.g. /ssl/cert?domain=example.com (aliases: host, hostname, url, site)",
      });
      return;
    }

    const requestFindings: Finding[] = [];
    const host = validateDomain(extractHostname(rawDomain));
    const port = pickPort(req, requestFindings);

    const cacheKey = `${host}:${port}`;
    let result = cacheGet(cacheKey);
    if (!result) {
      result = await fetchQuickCert(host, port);
      cacheSet(cacheKey, result);
    }

    res.json(toResponse(result, requestFindings));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof UnreachableError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("SSL cert quick error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

sslCertQuickRouter.get("/ssl/cert", handleSslCertQuick);
sslCertQuickRouter.post("/ssl/cert", handleSslCertQuick);
