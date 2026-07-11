import { Router, type Request, type Response } from "express";
import net from "node:net";
import { isDnsblListing, queryDns } from "../utils/dns-resolvers.js";
import { ValidationError } from "../utils/validators.js";
import { pickRequestParam, IP_ALIASES } from "../utils/field-aliases.js";

export const ipBlacklistRouter = Router();

// --- DNSBL definitions ---

interface DnsblEntry {
  host: string;
  description: string;
}

const DNSBLS: DnsblEntry[] = [
  { host: "zen.spamhaus.org", description: "Spamhaus ZEN — combined spam sources and exploits" },
  { host: "bl.spamcop.net", description: "SpamCop — reported spam sources" },
  { host: "b.barracudacentral.org", description: "Barracuda — spam sources" },
  { host: "dnsbl.sorbs.net", description: "SORBS — spam/proxies/exploits" },
  { host: "spam.dnsbl.sorbs.net", description: "SORBS Spam — spam sources" },
  { host: "http.dnsbl.sorbs.net", description: "SORBS Open proxies" },
  { host: "sbl.spamhaus.org", description: "Spamhaus SBL — spam sources" },
  { host: "xbl.spamhaus.org", description: "Spamhaus XBL — exploits/botnets" },
  { host: "pbl.spamhaus.org", description: "Spamhaus PBL — policy block list" },
  { host: "dnsbl-1.uceprotect.net", description: "UCEPROTECT Level 1" },
  { host: "bl.0spam.org", description: "0spam — spam sources" },
  { host: "dnsbl.dronebl.org", description: "DroneBL — botnets/drones" },
  { host: "all.s5h.net", description: "s5h — spam sources" },
  { host: "singular.ttk.pte.hu", description: "TTK — spam sources" },
  { host: "ix.dnsbl.manitu.net", description: "Manitu — spam sources" },
];

const MAJOR_LISTS = new Set(["zen.spamhaus.org", "bl.spamcop.net", "b.barracudacentral.org", "dnsbl.sorbs.net"]);

// --- Helpers ---

function isPrivateIp(ip: string): boolean {
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function reverseIp(ip: string): string {
  return ip.split(".").reverse().join(".");
}

function getGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

function getThreatLevel(listedCount: number): string {
  if (listedCount === 0) return "clean";
  if (listedCount <= 2) return "suspicious";
  return "malicious";
}

export interface IpBlacklistResult {
  ip: string;
  reversed_ip: string;
  listed_count: number;
  total_checked: number;
  threat_level: string;
  score: number;
  grade: string;
  findings: { rule: string; deduction: number; detail: string }[];
  blacklists: { name: string; listed: boolean; description: string }[];
}

/**
 * Core DNSBL check logic, extracted so aggregators (e.g. ip-report-full) can
 * reuse it directly. Expects an already-validated, non-private IPv4 address.
 * The route handler below calls this unchanged.
 */
export async function runIpBlacklist(ip: string): Promise<IpBlacklistResult> {
  const reversed = reverseIp(ip);

  // Query all 15 DNSBLs concurrently
  const results = await Promise.allSettled(
    DNSBLS.map(async (dnsbl) => {
      const query = `${reversed}.${dnsbl.host}`;
      const answers = await queryDns(query, "A");
      // isDnsblListing filters Spamhaus in-band refusal codes (127.255.255.x)
      // — from Railway egress those otherwise read as false "listed" verdicts.
      const listed = answers.some(isDnsblListing);
      return { ...dnsbl, listed };
    })
  );

  const blacklists: { name: string; listed: boolean; description: string }[] = [];
  const findings: { rule: string; deduction: number; detail: string }[] = [];
  let score = 100;
  let listedCount = 0;
  const listedHosts: string[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { host, listed, description } = result.value;
      blacklists.push({ name: host, listed, description });
      if (listed) {
        listedCount++;
        listedHosts.push(host);
        findings.push({ rule: "listed_on_blacklist", deduction: -15, detail: `Listed on ${host}` });
        score -= 15;
      }
    } else {
      // Lookup failed — treat as not listed
      const dnsbl = DNSBLS[results.indexOf(result)];
      blacklists.push({ name: dnsbl.host, listed: false, description: dnsbl.description });
    }
  }

  // Extra penalty: listed on any spamhaus list
  const spamhausListed = listedHosts.some((h) => h.endsWith("spamhaus.org"));
  if (spamhausListed) {
    findings.push({ rule: "listed_on_spamhaus", deduction: -5, detail: "Listed on a Spamhaus blacklist (high-signal)" });
    score -= 5;
  }

  // Extra penalty: listed on 3+ major lists
  const majorListedCount = listedHosts.filter((h) => MAJOR_LISTS.has(h)).length;
  if (majorListedCount >= 3) {
    findings.push({ rule: "listed_on_multiple_major", deduction: -10, detail: "Listed on 3 or more major blacklists" });
    score -= 10;
  }

  // Floor at 0
  score = Math.max(0, score);

  return {
    ip,
    reversed_ip: reversed,
    listed_count: listedCount,
    total_checked: DNSBLS.length,
    threat_level: getThreatLevel(listedCount),
    score,
    grade: getGrade(score),
    findings,
    blacklists,
  };
}

// --- Route ---

ipBlacklistRouter.get("/ip-blacklist/check", async (req: Request, res: Response) => {
  try {
    // Tolerate the common synonyms and body-sent params agents use (see
    // field-aliases.ts) — every rejected synonym is a paid call that bounces.
    const ip = pickRequestParam(req, IP_ALIASES);

    if (!ip) {
      res.status(400).json({
        error:
          'ip is required — pass an IPv4 address as the `ip` query param, ' +
          'e.g. /ip-blacklist/check?ip=8.8.8.8 (aliases accepted: target, address, host).',
      });
      return;
    }

    // Check for IPv6
    if (ip.includes(":")) {
      res.status(400).json({ error: "Only IPv4 addresses are supported" });
      return;
    }

    // Validate IPv4
    if (!net.isIPv4(ip)) {
      throw new ValidationError("Invalid IPv4 address");
    }

    // Reject private/reserved ranges
    if (isPrivateIp(ip)) {
      res.status(400).json({ error: "Private IP addresses cannot be checked against blacklists" });
      return;
    }

    res.json(await runIpBlacklist(ip));
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("ip-blacklist error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
