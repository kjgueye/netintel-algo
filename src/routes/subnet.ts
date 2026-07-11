import net from "node:net";
import { Router, type Request, type Response } from "express";
import { Address4, Address6 } from "ip-address";
import {
  decodeLeftoverPercentEncoding,
  validateCidr,
  ValidationError,
} from "../utils/validators.js";
import { pickRequestParam } from "../utils/field-aliases.js";

export const subnetRouter = Router();

// The synonyms agents send for the CIDR parameter (canonical first). `ip`
// last: some agents send `ip=10.0.0.0/24`, and validateCidr still rejects
// non-CIDR values with a clear message.
const CIDR_ALIASES = ["cidr", "cidrs", "subnet", "network", "range", "prefix", "target", "ip", "query", "q"];

interface SubnetBreakdown {
  prefix: string;
  count: number;
}

interface SubnetResult {
  cidr: string;
  ip_version: number;
  network: string;
  broadcast: string | null;
  netmask: string;
  wildcard: string | null;
  binary_mask: string;
  hex_mask: string;
  prefix_length: number;
  total_hosts: number;
  usable_hosts: number;
  first_usable: string | null;
  last_usable: string | null;
  is_private: boolean;
  supernet: string | null;
  subnets: SubnetBreakdown[];
  rfc_classification: string;
}

interface OverlapResult {
  cidr_a: string;
  cidr_b: string;
  overlap: boolean;
  relationship: string;
}

function classifyRfc(addr: Address4 | Address6, isV4: boolean): string {
  const str = addr.correctForm();

  if (isV4) {
    if (str.startsWith("127.")) return "Loopback (RFC 1122)";
    if (str.startsWith("169.254.")) return "Link-Local (RFC 3927)";
    if (str.startsWith("10.")) return "Private (RFC 1918)";
    if (str.startsWith("192.168.")) return "Private (RFC 1918)";
    if (str.startsWith("172.")) {
      const second = parseInt(str.split(".")[1], 10);
      if (second >= 16 && second <= 31) return "Private (RFC 1918)";
    }
    if (str.startsWith("224.") || str.startsWith("239.")) return "Multicast (RFC 5771)";
    if (str.startsWith("240.")) return "Reserved";
    return "Public";
  } else {
    const lower = str.toLowerCase();
    if (lower === "::1") return "Loopback (RFC 4291)";
    if (lower.startsWith("fe80:")) return "Link-Local (RFC 4291)";
    if (lower.startsWith("fc") || lower.startsWith("fd"))
      return "Unique Local (RFC 4193)";
    if (lower.startsWith("ff")) return "Multicast (RFC 4291)";
    return "Global Unicast";
  }
}

function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split(".").map(Number);
  return (
    (BigInt(parts[0]) << 24n) |
    (BigInt(parts[1]) << 16n) |
    (BigInt(parts[2]) << 8n) |
    BigInt(parts[3])
  );
}

function bigIntToIpv4(n: bigint): string {
  return [
    Number((n >> 24n) & 0xffn),
    Number((n >> 16n) & 0xffn),
    Number((n >> 8n) & 0xffn),
    Number(n & 0xffn),
  ].join(".");
}

function calcSubnetV4(cidr: string): SubnetResult {
  const addr = new Address4(cidr);
  const prefix = addr.subnetMask;
  const maskBits = 0xffffffffn << BigInt(32 - prefix) & 0xffffffffn;
  const wildcardBits = maskBits ^ 0xffffffffn;

  const networkInt = ipv4ToBigInt(addr.startAddress().correctForm());
  const broadcastInt = networkInt | wildcardBits;

  const networkAddr = bigIntToIpv4(networkInt);
  const broadcastAddr = bigIntToIpv4(broadcastInt);
  const netmask = bigIntToIpv4(maskBits);
  const wildcard = bigIntToIpv4(wildcardBits);

  const totalHosts = Number(wildcardBits + 1n);
  const usableHosts = prefix < 31 ? Math.max(totalHosts - 2, 0) : totalHosts;

  let firstUsable: string | null = null;
  let lastUsable: string | null = null;
  if (prefix < 31 && totalHosts > 2) {
    firstUsable = bigIntToIpv4(networkInt + 1n);
    lastUsable = bigIntToIpv4(broadcastInt - 1n);
  } else if (totalHosts >= 1) {
    firstUsable = networkAddr;
    lastUsable = broadcastAddr;
  }

  const binaryMask = maskBits.toString(2).padStart(32, "0");
  const hexMask = maskBits.toString(16).padStart(8, "0");

  const supernet = prefix > 0 ? `${bigIntToIpv4(networkInt & (0xffffffffn << BigInt(32 - prefix + 1) & 0xffffffffn))}/${prefix - 1}` : null;

  const subnets: SubnetBreakdown[] = [];
  for (let tp = prefix + 1; tp <= Math.min(prefix + 4, 32); tp++) {
    subnets.push({ prefix: `/${tp}`, count: 2 ** (tp - prefix) });
  }

  const isPrivate =
    networkAddr.startsWith("10.") ||
    networkAddr.startsWith("192.168.") ||
    networkAddr.startsWith("127.") ||
    (() => {
      if (networkAddr.startsWith("172.")) {
        const s = parseInt(networkAddr.split(".")[1], 10);
        return s >= 16 && s <= 31;
      }
      return false;
    })();

  return {
    cidr: `${networkAddr}/${prefix}`,
    ip_version: 4,
    network: networkAddr,
    broadcast: broadcastAddr,
    netmask,
    wildcard,
    binary_mask: binaryMask,
    hex_mask: hexMask,
    prefix_length: prefix,
    total_hosts: totalHosts,
    usable_hosts: usableHosts,
    first_usable: firstUsable,
    last_usable: lastUsable,
    is_private: isPrivate,
    supernet,
    subnets,
    rfc_classification: classifyRfc(addr, true),
  };
}

function ipv6ToBigInt(addr: Address6): bigint {
  const hex = addr.canonicalForm().replace(/:/g, "");
  return BigInt("0x" + hex);
}

function bigIntToIpv6(n: bigint): string {
  const hex = n.toString(16).padStart(32, "0");
  const groups: string[] = [];
  for (let i = 0; i < 32; i += 4) {
    groups.push(hex.slice(i, i + 4));
  }
  // Compress for display
  const addr = new Address6(groups.join(":"));
  return addr.correctForm();
}

function calcSubnetV6(cidr: string): SubnetResult {
  const addr = new Address6(cidr);
  const prefix = addr.subnetMask;
  const totalBits = 128;

  const maskBits = ((1n << BigInt(totalBits)) - 1n) << BigInt(totalBits - prefix) & ((1n << BigInt(totalBits)) - 1n);
  const networkInt = ipv6ToBigInt(new Address6(addr.startAddress().correctForm()));

  const totalHosts = 2n ** BigInt(totalBits - prefix);
  const networkAddr = bigIntToIpv6(networkInt);

  const binaryMask = maskBits.toString(2).padStart(128, "0");
  const hexMask = maskBits.toString(16).padStart(32, "0");
  const netmask = bigIntToIpv6(maskBits);

  const supernet =
    prefix > 0
      ? `${bigIntToIpv6(networkInt & (((1n << BigInt(totalBits)) - 1n) << BigInt(totalBits - prefix + 1) & ((1n << BigInt(totalBits)) - 1n)))}/${prefix - 1}`
      : null;

  const subnets: SubnetBreakdown[] = [];
  for (let tp = prefix + 1; tp <= Math.min(prefix + 4, 128); tp++) {
    subnets.push({ prefix: `/${tp}`, count: 2 ** (tp - prefix) });
  }

  return {
    cidr: `${networkAddr}/${prefix}`,
    ip_version: 6,
    network: networkAddr,
    broadcast: null,
    netmask,
    wildcard: null,
    binary_mask: binaryMask,
    hex_mask: hexMask,
    prefix_length: prefix,
    total_hosts: totalHosts <= Number.MAX_SAFE_INTEGER ? Number(totalHosts) : -1,
    usable_hosts: totalHosts <= Number.MAX_SAFE_INTEGER ? Number(totalHosts) : -1,
    first_usable: networkAddr,
    last_usable: bigIntToIpv6(networkInt + totalHosts - 1n),
    is_private:
      networkAddr.startsWith("fc") ||
      networkAddr.startsWith("fd") ||
      networkAddr === "::1",
    supernet,
    subnets,
    rfc_classification: classifyRfc(addr, false),
  };
}

function calcSubnet(cidr: string): SubnetResult {
  const parts = cidr.split("/");
  const ip = parts[0];
  if (net.isIPv4(ip)) {
    return calcSubnetV4(cidr);
  }
  return calcSubnetV6(cidr);
}

function networksOverlap(
  aNet: bigint,
  aEnd: bigint,
  bNet: bigint,
  bEnd: bigint
): boolean {
  return aNet <= bEnd && bNet <= aEnd;
}

function getNetworkRange(
  cidr: string
): { network: bigint; end: bigint; prefix: number; isV4: boolean } {
  const parts = cidr.split("/");
  const ip = parts[0];
  const prefix = parseInt(parts[1], 10);

  if (net.isIPv4(ip)) {
    const addr = new Address4(cidr);
    const netInt = ipv4ToBigInt(addr.startAddress().correctForm());
    const hostBits = 32 - prefix;
    const endInt = netInt | ((1n << BigInt(hostBits)) - 1n);
    return { network: netInt, end: endInt, prefix, isV4: true };
  } else {
    const addr = new Address6(cidr);
    const netInt = ipv6ToBigInt(new Address6(addr.startAddress().correctForm()));
    const hostBits = 128 - prefix;
    const endInt = netInt | ((1n << BigInt(hostBits)) - 1n);
    return { network: netInt, end: endInt, prefix, isV4: false };
  }
}

function checkOverlaps(cidrs: string[]): OverlapResult[] {
  const ranges = cidrs.map((c) => ({ cidr: c, ...getNetworkRange(c) }));
  const results: OverlapResult[] = [];

  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i];
      const b = ranges[j];

      if (a.isV4 !== b.isV4) {
        results.push({
          cidr_a: a.cidr,
          cidr_b: b.cidr,
          overlap: false,
          relationship: "disjoint (different address families)",
        });
        continue;
      }

      if (networksOverlap(a.network, a.end, b.network, b.end)) {
        let relationship: string;
        if (a.network <= b.network && a.end >= b.end) {
          relationship = `${cidrs[i]} is a supernet of ${cidrs[j]}`;
        } else if (b.network <= a.network && b.end >= a.end) {
          relationship = `${cidrs[i]} is a subnet of ${cidrs[j]}`;
        } else {
          relationship = "partial overlap";
        }
        results.push({
          cidr_a: cidrs[i],
          cidr_b: cidrs[j],
          overlap: true,
          relationship,
        });
      } else {
        results.push({
          cidr_a: cidrs[i],
          cidr_b: cidrs[j],
          overlap: false,
          relationship: "disjoint",
        });
      }
    }
  }

  return results;
}

subnetRouter.get("/subnet/calc", (req: Request, res: Response) => {
  try {
    // Tolerate the common synonyms and body-sent params agents use (see
    // field-aliases.ts) — every rejected synonym is a paid call that bounces.
    const rawCidr = pickRequestParam(req, CIDR_ALIASES);
    if (!rawCidr) {
      res.status(400).json({
        error:
          'cidr is required — pass a CIDR block (or comma-separated list) as the `cidr` query param, ' +
          'e.g. /subnet/calc?cidr=10.0.0.0/24 (aliases accepted: subnet, network, range, prefix).',
      });
      return;
    }

    // Decode BEFORE splitting so a double-encoded list (`%2C` commas, `%2F`
    // slashes — seen live in paid_call_failures) still splits into its CIDRs.
    const parts = decodeLeftoverPercentEncoding(rawCidr)
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    // Validate all CIDRs
    const validated = parts.map((p) => validateCidr(p));

    if (validated.length === 1) {
      res.json(calcSubnet(validated[0]));
      return;
    }

    const subnets = validated.map((c) => calcSubnet(c));
    const overlaps = checkOverlaps(validated);

    res.json({ subnets, overlaps });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Subnet calc error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
