import crypto from "node:crypto";
import tls from "node:tls";
import { Router, type Request, type Response } from "express";
import { timeouts } from "../config.js";
import { checkSsrf, validateDomain, ValidationError } from "../utils/validators.js";

export const sslRouter = Router();

interface CertSubject {
  common_name: string | null;
  organization: string | null;
  organizational_unit: string | null;
  country: string | null;
}

interface CertIssuer {
  common_name: string | null;
  organization: string | null;
  country: string | null;
}

interface KeyInfo {
  algorithm: string | null;
  size: number | null;
}

interface CertDetails {
  subject: CertSubject;
  issuer: CertIssuer;
  serial_number: string | null;
  san: string[];
  key_info: KeyInfo;
  not_before: string | null;
  not_after: string | null;
  signature_algorithm: string | null;
  version: number | null;
}

interface ChainCert {
  subject: string | null;
  issuer: string | null;
  not_before: string | null;
  not_after: string | null;
}

function getCertField(
  obj: tls.Certificate | undefined,
  key: string
): string | null {
  if (!obj) return null;
  const val = (obj as unknown as Record<string, unknown>)[key];
  return typeof val === "string" ? val : null;
}

function parseCert(cert: tls.PeerCertificate): CertDetails {
  const san: string[] = [];
  if (cert.subjectaltname) {
    for (const entry of cert.subjectaltname.split(",")) {
      const trimmed = entry.trim();
      if (trimmed.startsWith("DNS:")) {
        san.push(trimmed.slice(4));
      }
    }
  }

  let algorithm: string | null = null;
  let size: number | null = null;
  const pubkey = cert.pubkey;
  if (pubkey) {
    try {
      const keyObj = crypto.createPublicKey({
        key: pubkey,
        format: "der",
        type: "spki",
      });
      const detail = keyObj.asymmetricKeyType;
      if (detail === "rsa") {
        algorithm = "RSA";
        // Export as JWK to get key size
        const jwk = keyObj.export({ format: "jwk" });
        if (jwk.n) {
          // n is base64url-encoded modulus, each char ~6 bits, length * 6 / 8 * 8 ≈ bits
          size = Math.ceil((jwk.n.length * 6) / 8) * 8;
        }
      } else if (detail === "ec") {
        algorithm = "EC";
        const jwk = keyObj.export({ format: "jwk" });
        // EC key size from curve name
        if (jwk.crv === "P-256") size = 256;
        else if (jwk.crv === "P-384") size = 384;
        else if (jwk.crv === "P-521") size = 521;
      } else {
        algorithm = detail ?? null;
      }
    } catch {
      // Fall back to modulus length for RSA
      if ((cert as unknown as Record<string, unknown>).modulus) {
        algorithm = "RSA";
        size =
          ((cert as unknown as Record<string, unknown>).modulus as string).length * 4;
      }
    }
  }

  return {
    subject: {
      common_name: getCertField(cert.subject, "CN"),
      organization: getCertField(cert.subject, "O"),
      organizational_unit: getCertField(cert.subject, "OU"),
      country: getCertField(cert.subject, "C"),
    },
    issuer: {
      common_name: getCertField(cert.issuer, "CN"),
      organization: getCertField(cert.issuer, "O"),
      country: getCertField(cert.issuer, "C"),
    },
    serial_number: cert.serialNumber || null,
    san,
    key_info: { algorithm, size },
    not_before: cert.valid_from || null,
    not_after: cert.valid_to || null,
    signature_algorithm:
      (cert as unknown as Record<string, unknown>).signatureAlgorithm as string || null,
    version:
      typeof (cert as unknown as Record<string, unknown>).version === "number"
        ? ((cert as unknown as Record<string, unknown>).version as number)
        : null,
  };
}

function extractChain(socket: tls.TLSSocket): ChainCert[] {
  const chain: ChainCert[] = [];
  const cert = socket.getPeerCertificate(true);
  if (!cert || !cert.issuerCertificate) return chain;

  let current = cert.issuerCertificate;
  const seen = new Set<string>();

  while (current && !seen.has(current.serialNumber)) {
    seen.add(current.serialNumber);
    chain.push({
      subject: getCertField(current.subject, "CN"),
      issuer: getCertField(current.issuer, "CN"),
      not_before: current.valid_from || null,
      not_after: current.valid_to || null,
    });
    if (
      !current.issuerCertificate ||
      current.issuerCertificate.serialNumber === current.serialNumber
    ) {
      break;
    }
    current = current.issuerCertificate;
  }

  return chain;
}

const TLS_VERSIONS = ["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"] as const;
const TLS_LABELS: Record<string, string> = {
  TLSv1: "TLS 1.0",
  "TLSv1.1": "TLS 1.1",
  "TLSv1.2": "TLS 1.2",
  "TLSv1.3": "TLS 1.3",
};

async function probeTlsVersion(
  host: string,
  port: number,
  version: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host,
        port,
        minVersion: version as tls.SecureVersion,
        maxVersion: version as tls.SecureVersion,
        rejectUnauthorized: false,
        timeout: timeouts.ssl,
      },
      () => {
        socket.destroy();
        resolve(true);
      }
    );
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function probeTlsVersions(
  host: string,
  port: number
): Promise<string[]> {
  const results = await Promise.all(
    TLS_VERSIONS.map(async (v) => ({
      version: v,
      supported: await probeTlsVersion(host, port, v),
    }))
  );
  return results
    .filter((r) => r.supported)
    .map((r) => TLS_LABELS[r.version]);
}

function computeWarningsAndGrade(
  cert: CertDetails,
  supportedProtocols: string[],
  isSelfSigned: boolean
): { warnings: string[]; grade: string } {
  const warnings: string[] = [];
  let grade = "A";

  // Expiry check
  if (cert.not_after) {
    const expiry = new Date(cert.not_after);
    const daysLeft = Math.floor(
      (expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );
    if (daysLeft < 0) {
      warnings.push("Certificate has expired");
      grade = "F";
    } else if (daysLeft < 30) {
      warnings.push(`Certificate expires in ${daysLeft} days`);
      if (grade < "B") grade = "B";
    }
  }

  // Weak key
  if (
    cert.key_info.algorithm === "RSA" &&
    cert.key_info.size &&
    cert.key_info.size < 2048
  ) {
    warnings.push(`Weak RSA key: ${cert.key_info.size} bits`);
    if (grade < "B") grade = "B";
  }

  // Legacy TLS
  if (supportedProtocols.includes("TLS 1.0")) {
    warnings.push("TLS 1.0 supported (insecure)");
    if (grade < "C") grade = "C";
  }
  if (supportedProtocols.includes("TLS 1.1")) {
    warnings.push("TLS 1.1 supported (deprecated)");
    if (grade < "C") grade = "C";
  }

  // Self-signed
  if (isSelfSigned) {
    warnings.push("Self-signed certificate");
    grade = "F";
  }

  // SHA-1
  if (
    cert.signature_algorithm &&
    cert.signature_algorithm.toLowerCase().includes("sha1")
  ) {
    warnings.push("SHA-1 signature algorithm (weak)");
    if (grade < "B") grade = "B";
  }

  return { warnings, grade };
}

function tlsConnect(
  host: string,
  port: number
): Promise<{ socket: tls.TLSSocket; cert: tls.PeerCertificate }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, timeout: timeouts.ssl, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate(true);
        resolve({ socket, cert });
      }
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Connection timed out"));
    });
  });
}

export interface SslAnalyzeResult {
  host: string;
  port: number;
  certificate: CertDetails;
  chain: ChainCert[];
  chain_valid: boolean;
  connection: {
    protocol: string | null;
    cipher: string | null;
    supported_protocols: string[];
  };
  warnings: string[];
  grade: string;
}

/**
 * Core SSL/TLS analysis logic, extracted so aggregators (e.g. domain-report-full)
 * can reuse it directly. Performs the SSRF check and TLS handshake; expects an
 * already-validated host. The route handler below calls this unchanged.
 */
export async function runSslAnalyze(host: string, port = 443): Promise<SslAnalyzeResult> {
  await checkSsrf(host);

  // Main TLS handshake
  const { socket, cert } = await tlsConnect(host, port);
  const certDetails = parseCert(cert);
  const chain = extractChain(socket);
  const protocol = socket.getProtocol();
  const cipher = socket.getCipher();
  socket.destroy();

  // Probe TLS versions
  const supportedProtocols = await probeTlsVersions(host, port);

  // Self-signed detection: subject matches issuer and no real intermediates
  const isSelfSigned =
    certDetails.subject.common_name === certDetails.issuer.common_name &&
    certDetails.subject.organization === certDetails.issuer.organization &&
    chain.every((c) => c.subject === certDetails.subject.common_name);

  const { warnings, grade } = computeWarningsAndGrade(
    certDetails,
    supportedProtocols,
    isSelfSigned
  );

  return {
    host,
    port,
    certificate: certDetails,
    chain,
    chain_valid: chain.length > 0,
    connection: {
      protocol: protocol || null,
      cipher: cipher?.name || null,
      supported_protocols: supportedProtocols,
    },
    warnings,
    grade,
  };
}

sslRouter.get("/ssl/analyze", async (req: Request, res: Response) => {
  try {
    const rawHost = req.query.domain as string;
    if (!rawHost) {
      res.status(400).json({ error: "domain is required — e.g. /ssl/analyze?domain=example.com" });
      return;
    }

    const host = validateDomain(rawHost);
    const port = parseInt((req.query.port as string) || "443", 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      // Without this guard a non-numeric port reached tls.connect as NaN → 500.
      throw new ValidationError(
        `port must be an integer between 1 and 65535 (default 443) — received ${JSON.stringify(String(req.query.port))}`
      );
    }

    res.json(await runSslAnalyze(host, port));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("SSL analyze error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
