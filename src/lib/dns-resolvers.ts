// Inlined from NetIntel src/utils/dns-resolvers.ts (verbatim; the dns timeout
// constant comes from lib/config.ts). Requires the dns2 package + local shim
// in src/types/dns2.d.ts.
import DNS from "dns2";
import dns from "node:dns/promises";
import { timeouts } from "./config.js";

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
