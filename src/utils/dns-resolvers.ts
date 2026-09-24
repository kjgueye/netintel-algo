import DNS from "dns2";
import dns from "node:dns/promises";
import { timeouts } from "../config.js";

export interface DnsAnswer {
  name: string;
  type: number;
  class: number;
  ttl: number;
  address?: string;
  data?: string;
  exchange?: string;
  priority?: number;
  ns?: string;
  primary?: string;
  admin?: string;
  serial?: number;
  refresh?: number;
  retry?: number;
  expiration?: number;
  minimum?: number;
}

/**
 * Whether a DNSBL A-record answer is a genuine LISTING, as opposed to an
 * in-band error/refusal code.
 *
 * DNSBLs signal listings inside 127.0.0.0/8 (Spamhaus: 127.0.0.2-11), but
 * Spamhaus also signals ERRORS in-band: 127.255.255.252 (malformed query),
 * .254 (query via public/open resolver — refused), .255 (rate limited).
 * Queries from shared datacenter egress (Railway) routinely get those
 * refusals, and counting them as listings made clean IPs (8.8.8.8!) come
 * back "listed on 3 Spamhaus zones → block" in prod (caught live via
 * test:pay, 2026-07-07). 127.0.0.1 is likewise a resolver-hijack/whitelist
 * sentinel, never a listing.
 */
export function isDnsblListing(answer: DnsAnswer): boolean {
  const addr = answer.address;
  if (!addr || !addr.startsWith("127.")) return false;
  if (addr.startsWith("127.255.")) return false; // Spamhaus error band
  if (addr === "127.0.0.1") return false; // hijack/whitelist sentinel
  return true;
}

/* ---- DNS-over-HTTPS (JSON) — for DNSSEC record types ------------------------
   dns2 is UDP-only and never sets the EDNS DO flag, so DS comes back empty and
   DNSKEY truncates — which made /dnssec/validate grade every SIGNED domain F
   (caught by the 2026-07-18 eval sweep: example.com "no DNSSEC" vs ground
   truth 1 DS + 4 DNSKEYs). DoH JSON returns these types reliably AND carries
   the resolver's AD (authenticated-data) bit — proof the chain validates.
   Google primary, Cloudflare fallback; failure → empty (callers degrade). */

const DOH_TYPE_NUM: Record<string, number> = {
  DS: 43, DNSKEY: 48, RRSIG: 46, NSEC: 47, NSEC3PARAM: 51, SOA: 6,
};

export interface DohResult {
  /** Answers of the REQUESTED type only (DoH includes RRSIGs alongside when do=1). */
  answers: DnsAnswer[];
  /** The validating resolver's AD bit — true = chain of trust verified upstream. */
  ad: boolean;
  /** RRSIG records that rode along in the same answer (do=1). */
  rrsigCount: number;
}

export async function dohQuery(domain: string, type: keyof typeof DOH_TYPE_NUM): Promise<DohResult> {
  const q = `name=${encodeURIComponent(domain)}&type=${type}&do=1`;
  const urls = [
    `https://dns.google/resolve?${q}`,
    `https://cloudflare-dns.com/dns-query?${q}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(timeouts.dns),
      });
      if (!res.ok) continue;
      const j: any = await res.json();
      const all: any[] = Array.isArray(j.Answer) ? j.Answer : [];
      const want = DOH_TYPE_NUM[type];
      return {
        ad: j.AD === true,
        answers: all
          .filter((a) => a.type === want)
          .map((a) => ({ name: String(a.name ?? domain), type: a.type, class: 1, ttl: a.TTL ?? 0, data: String(a.data ?? "") })),
        rrsigCount: all.filter((a) => a.type === 46).length,
      };
    } catch {
      // try the next resolver
    }
  }
  return { answers: [], ad: false, rrsigCount: 0 };
}

// dns2 expects string type names
export const RECORD_TYPES = {
  A: "A",
  NS: "NS",
  CNAME: "CNAME",
  SOA: "SOA",
  PTR: "PTR",
  MX: "MX",
  TXT: "TXT",
  AAAA: "AAAA",
} as const;

export async function queryDns(
  domain: string,
  type: string,
  nameserver?: string
): Promise<DnsAnswer[]> {
  const dnsClient = new DNS({
    nameServers: [nameserver || "8.8.8.8"],
    timeout: timeouts.dns,
  });

  try {
    const response = await dnsClient.resolve(domain, type);
    return (response.answers || []) as DnsAnswer[];
  } catch {
    return [];
  }
}

/* ---- Registration-oriented NS presence --------------------------------------
   queryDns() collapses every failure — NXDOMAIN, SERVFAIL, timeout — into [],
   which availability checkers then read as "no NS records → available". That is
   wrong for SERVFAIL: registered domains with broken (lame) delegation SERVFAIL,
   and parked/held names — exactly what name generators and typosquat variations
   produce — do this constantly. The 2026-07-30 catalog sweep caught /name-gen
   claiming cloudify.com, cloudio.com and joincloud.com "available"; all three
   are registered and SERVFAIL. Node's c-ares resolver surfaces the rcode as the
   error code, so callers can tell the cases apart. */

export type NsPresence =
  /** NS answers exist, or the name exists without NS (NOERROR) — registered. */
  | "registered"
  /** NXDOMAIN — the name does not exist in DNS; genuinely available. */
  | "available"
  /** SERVFAIL — in practice a registered domain with lame delegation. */
  | "servfail"
  /** Timeout / refusal / network failure — no verdict either way. */
  | "unknown";

export async function nsPresence(
  domain: string,
  timeoutMs?: number
): Promise<NsPresence> {
  const resolver = new dns.Resolver({
    timeout: timeoutMs ?? timeouts.dns,
    tries: 1,
  });
  resolver.setServers(["8.8.8.8"]);
  try {
    await resolver.resolveNs(domain);
    return "registered";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND") return "available"; // NXDOMAIN
    if (code === "ENODATA") return "registered"; // name exists, no NS records
    if (code === "ESERVFAIL") return "servfail";
    return "unknown";
  }
}

/**
 * Resolve TXT records using Node's built-in dns module.
 * Unlike dns2 (UDP-only), this handles TCP fallback automatically,
 * avoiding truncation for domains with many TXT records.
 */
export async function resolveTxt(domain: string): Promise<string[]> {
  try {
    const chunks = await dns.resolveTxt(domain);
    return chunks.map((parts) => parts.join(""));
  } catch {
    return [];
  }
}

export interface MxAssessment {
  /** Real, deliverable mail hosts, sorted by priority (null-MX filtered out). */
  deliverableHosts: string[];
  /**
   * True when the domain publishes an RFC 7505 "null MX" (`MX 0 .`, which
   * node:dns returns as a single record with an empty-string exchange) and NO
   * real host — i.e. it explicitly declares it accepts no mail. This is a
   * DELIBERATE "undeliverable" signal, the opposite of a missing MX, and must
   * not be counted as a usable MX (the bug this replaced graded null-MX
   * domains like example.com as "deliverable A/100").
   */
  nullMx: boolean;
}

/**
 * Filter ALREADY-RESOLVED MX records down to real deliverable hosts — dropping
 * RFC 7505 null-MX entries (an empty or "." exchange, i.e. "this domain accepts
 * no mail"). For composites that already hold MX records from runDnsLookup and
 * must not count/emit a null MX as a real mail host (the bug that let
 * domain-report/full return mx_records:[""] and domain/vendor-risk report
 * "MX healthy" for example.com). Pure — no I/O.
 */
export function deliverableMxHosts(records: Array<{ exchange?: string | null }>): string[] {
  return records
    .map((r) => (r.exchange || "").replace(/\.$/, ""))
    .filter((h) => h.length > 0);
}

/**
 * Resolve a domain's MX and split real deliverable hosts from an RFC 7505 null
 * MX. Never throws — a lookup failure yields no hosts and nullMx=false.
 */
export async function assessMx(domain: string): Promise<MxAssessment> {
  try {
    const rows = await dns.resolveMx(domain);
    const deliverableHosts = rows
      .filter((r) => r.exchange && r.exchange !== ".")
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange);
    // Records existed but none was a real host ⇒ the domain published a null MX.
    const nullMx = rows.length > 0 && deliverableHosts.length === 0;
    return { deliverableHosts, nullMx };
  } catch {
    return { deliverableHosts: [], nullMx: false };
  }
}

/**
 * True if the domain has any mail-relevant DNS presence — a REAL MX host or an
 * A/AAAA address (RFC 5321 implicit MX). A null MX does not count as an MX (it
 * is an explicit "no mail" declaration), so a null-MX domain with no address
 * has no mail infra. A domain with neither effectively does not exist for
 * email, so a message claiming to be from it is almost certainly spoofed.
 * Never throws — resolution failures resolve to false.
 */
export async function domainHasMailInfra(domain: string): Promise<boolean> {
  const [hasMx, hasAddr] = await Promise.all([
    assessMx(domain).then((a) => a.deliverableHosts.length > 0),
    dns.lookup(domain).then(() => true).catch(() => false),
  ]);
  return hasMx || hasAddr;
}
