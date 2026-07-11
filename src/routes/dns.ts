import { Router, type Request, type Response } from "express";
import { dnsResolvers } from "../config.js";
import {
  queryDns,
  resolveTxt,
  RECORD_TYPES,
  type DnsAnswer,
} from "../utils/dns-resolvers.js";
import { validateDomain, ValidationError } from "../utils/validators.js";

export const dnsRouter = Router();

interface MxRecord {
  priority: number;
  exchange: string;
}

interface SoaRecord {
  mname: string;
  rname: string;
  serial: number;
  refresh: number;
  retry: number;
  expire: number;
  minimum: number;
}

interface SpfInfo {
  raw: string;
  version: string;
  mechanisms: string[];
  all_qualifier: string | null;
}

interface DkimInfo {
  raw: string;
  version: string | null;
  key_type: string | null;
  public_key: string | null;
}

interface DmarcInfo {
  raw: string;
  version: string | null;
  policy: string | null;
  subdomain_policy: string | null;
  pct: number | null;
  rua: string | null;
  ruf: string | null;
}

function parseSpf(txtRecords: string[]): SpfInfo | null {
  for (const txt of txtRecords) {
    if (txt.startsWith("v=spf1")) {
      const parts = txt.split(/\s+/);
      let allQualifier: string | null = null;
      const mechanisms: string[] = [];
      for (const p of parts.slice(1)) {
        if (["+all", "-all", "~all", "?all"].includes(p)) {
          allQualifier = p;
        } else {
          mechanisms.push(p);
        }
      }
      return {
        raw: txt,
        version: "spf1",
        mechanisms,
        all_qualifier: allQualifier,
      };
    }
  }
  return null;
}

function parseDkimRecord(raw: string): DkimInfo {
  const info: DkimInfo = {
    raw,
    version: null,
    key_type: null,
    public_key: null,
  };
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("v=")) info.version = trimmed.slice(2);
    else if (trimmed.startsWith("k=")) info.key_type = trimmed.slice(2);
    else if (trimmed.startsWith("p=")) info.public_key = trimmed.slice(2);
  }
  return info;
}

function parseDmarcRecord(raw: string): DmarcInfo {
  const info: DmarcInfo = {
    raw,
    version: null,
    policy: null,
    subdomain_policy: null,
    pct: null,
    rua: null,
    ruf: null,
  };
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("v=")) info.version = trimmed.slice(2);
    else if (trimmed.startsWith("p=")) info.policy = trimmed.slice(2);
    else if (trimmed.startsWith("sp=")) info.subdomain_policy = trimmed.slice(3);
    else if (trimmed.startsWith("pct=")) {
      const n = parseInt(trimmed.slice(4), 10);
      if (!isNaN(n)) info.pct = n;
    } else if (trimmed.startsWith("rua=")) info.rua = trimmed.slice(4);
    else if (trimmed.startsWith("ruf=")) info.ruf = trimmed.slice(4);
  }
  return info;
}

interface PropagationResolver {
  resolver: string;
  ip: string;
  A: string[];
}

export interface DnsLookupResult {
  domain: string;
  records: {
    A: string[];
    AAAA: string[];
    MX: MxRecord[];
    NS: string[];
    TXT: string[];
    SOA: SoaRecord | null;
    CNAME: string[];
    PTR: string[];
  };
  security: { spf: SpfInfo | null; dkim: DkimInfo | null; dmarc: DmarcInfo | null };
  propagation: { resolvers: PropagationResolver[]; consistent: boolean };
}

/**
 * Core DNS lookup logic, extracted so aggregators (e.g. domain-report-full) can
 * reuse it directly. Expects an already-validated domain. The route handler below
 * calls this and serializes the result unchanged.
 */
export async function runDnsLookup(domain: string): Promise<DnsLookupResult> {
  // Query all record types in parallel (resolveTxt for TXT to avoid UDP truncation)
    const [aAnswers, aaaaAnswers, mxAnswers, nsAnswers, txtRecords, soaAnswers, cnameAnswers, ptrAnswers] =
      await Promise.all([
        queryDns(domain, RECORD_TYPES.A),
        queryDns(domain, RECORD_TYPES.AAAA),
        queryDns(domain, RECORD_TYPES.MX),
        queryDns(domain, RECORD_TYPES.NS),
        resolveTxt(domain),
        queryDns(domain, RECORD_TYPES.SOA),
        queryDns(domain, RECORD_TYPES.CNAME),
        queryDns(domain, RECORD_TYPES.PTR),
      ]);

    const aRecords = aAnswers.map((a) => a.address!).filter(Boolean);
    const aaaaRecords = aaaaAnswers.map((a) => a.address!).filter(Boolean);
    const mxRecords: MxRecord[] = mxAnswers.map((a) => ({
      priority: a.priority ?? 0,
      exchange: (a.exchange || "").replace(/\.$/, ""),
    }));
    const nsRecords = nsAnswers.map((a) => (a.ns || "").replace(/\.$/, "")).filter(Boolean);
    const cnameRecords = cnameAnswers.map((a) => (a.data || "").replace(/\.$/, "")).filter(Boolean);
    const ptrRecords = ptrAnswers.map((a) => (a.data || "").replace(/\.$/, "")).filter(Boolean);

    let soa: SoaRecord | null = null;
    if (soaAnswers.length > 0) {
      const s = soaAnswers[0];
      soa = {
        mname: (s.primary || "").replace(/\.$/, ""),
        rname: (s.admin || "").replace(/\.$/, ""),
        serial: s.serial ?? 0,
        refresh: s.refresh ?? 0,
        retry: s.retry ?? 0,
        expire: s.expiration ?? 0,
        minimum: s.minimum ?? 0,
      };
    }

    // Security: SPF, DKIM, DMARC
    const spf = parseSpf(txtRecords);

    const dkimTxt = await resolveTxt(`default._domainkey.${domain}`);
    const dkim = dkimTxt.length > 0 ? parseDkimRecord(dkimTxt[0]) : null;

    const dmarcTxt = await resolveTxt(`_dmarc.${domain}`);
    const dmarc = dmarcTxt.length > 0 ? parseDmarcRecord(dmarcTxt[0]) : null;

    // Propagation check — query A records from 3 resolvers
    const propagationResults = await Promise.all(
      Object.entries(dnsResolvers).map(async ([name, ip]) => {
        const answers = await queryDns(domain, RECORD_TYPES.A, ip);
        const records = answers
          .map((a) => a.address!)
          .filter(Boolean)
          .sort();
        return { resolver: name, ip, A: records };
      })
    );

    const aSets = propagationResults.map((r) => JSON.stringify(r.A));
    const consistent =
      aSets.length < 2 || aSets.every((s) => s === aSets[0]);

    return {
      domain,
      records: {
        A: aRecords,
        AAAA: aaaaRecords,
        MX: mxRecords,
        NS: nsRecords,
        TXT: txtRecords,
        SOA: soa,
        CNAME: cnameRecords,
        PTR: ptrRecords,
      },
      security: { spf, dkim, dmarc },
      propagation: {
        resolvers: propagationResults,
        consistent,
      },
    };
}

dnsRouter.get("/dns/lookup", async (req: Request, res: Response) => {
  try {
    const rawDomain = req.query.domain as string;
    if (!rawDomain) {
      res.status(400).json({ error: "domain is required — e.g. /dns/lookup?domain=example.com" });
      return;
    }

    const domain = validateDomain(rawDomain);
    res.json(await runDnsLookup(domain));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("DNS lookup error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
