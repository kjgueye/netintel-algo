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

/**
 * True if the domain has any mail-relevant DNS presence — an MX record or an
 * A/AAAA address (RFC 5321 implicit MX). A domain with neither effectively does
 * not exist for email, so a message claiming to be from it is almost certainly
 * spoofed. Never throws — resolution failures resolve to false.
 */
export async function domainHasMailInfra(domain: string): Promise<boolean> {
  const [hasMx, hasAddr] = await Promise.all([
    dns.resolveMx(domain).then((r) => r.length > 0).catch(() => false),
    dns.lookup(domain).then(() => true).catch(() => false),
  ]);
  return hasMx || hasAddr;
}
