import { Router, type Request, type Response } from "express";
import { pickRequestParam } from "../utils/field-aliases.js";
import { timeouts } from "../config.js";

export const walletIntelRouter = Router();

interface Finding {
  rule: string;
  detail: string;
}

// --- Provider roster ---------------------------------------------------------
// Blockscout is the dashboard-proven primary: x402 wallets are gasless, so
// nonce/txlist say nothing — USDC token transfers are the signal. Etherscan is
// an ethereum-only fallback, used ONLY when ETHERSCAN_API_KEY is set (a per-key
// quota is immune to shared-egress burn). Public RPCs are the last resort for
// the basics so the report degrades instead of dying. All hosts are fixed
// constants and the address is format-validated below: no SSRF surface.
const BLOCKSCOUT_HOST: Record<string, string> = {
  base: "https://base.blockscout.com",
  ethereum: "https://eth.blockscout.com",
};
const EVM_RPCS: Record<string, string[]> = {
  base: [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
    "https://base.llamarpc.com",
    "https://1rpc.io/base",
  ],
  ethereum: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com",
    "https://1rpc.io/eth",
  ],
};

const USDC_CONTRACT: Record<string, string> = {
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  ethereum: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
};
const USDC_DECIMALS = 6;

const CHAINS = ["base", "ethereum"];
const CHAIN_ALIASES: Record<string, string> = { eth: "ethereum" };
const ADDRESS_ALIASES = ["address", "wallet", "account", "addr"];
const CHAIN_PARAM_ALIASES = ["chain", "network"];

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Blockscout paginates at 10k rows but serves ≤1,000 comfortably — the cap is
// requested explicitly and the analysis is bounded by it.
const MAX_TRANSFERS = 1000;

const DAY_MS = 86_400_000;
const WINDOW_30D_MS = 30 * DAY_MS;
const BURST_WINDOW_MS = 48 * 3_600_000;
const BURST_RATIO = 0.7;
// A lone transfer (or two) trivially fits any 48h window — below this floor the
// pattern verdict stays "steady" rather than crying burst on thin evidence.
const BURST_MIN_TRANSFERS = 3;

// --- Cache / cooldown state (house provider-chain pattern, inlined) ----------
const CACHE_TTL_MS = 5 * 60_000; // per chain:address
const STALE_MAX_MS = 60 * 60_000; // stale-serve ceiling
const BENCH_MS = 5 * 60_000; // per-provider cooldown on 429/403/timeout/garbage

interface CacheEntry {
  at: number;
  data: Record<string, unknown>; // response body minus cache_age_seconds/stale/findings
  findings: Finding[];
}

const cache = new Map<string, CacheEntry>(); // key = chain:address
const benchedUntil = new Map<string, number>(); // key = provider label

// Injectable clock so tests can advance time without sleeping.
let nowFn: () => number = Date.now;

/** Test-only: clear all module-level state (report cache, provider benches). */
export function __resetWalletIntelState(): void {
  cache.clear();
  benchedUntil.clear();
}

/** Test-only: override (or with no arg, restore) the clock. */
export function __setWalletIntelNow(fn?: () => number): void {
  nowFn = fn ?? Date.now;
}

// --- Helpers -----------------------------------------------------------------

function isBenched(provider: string): boolean {
  const until = benchedUntil.get(provider);
  return until !== undefined && nowFn() < until;
}

function bench(provider: string): void {
  benchedUntil.set(provider, nowFn() + BENCH_MS);
}

function roundSig(value: number, sig: number): number {
  if (!isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(sig));
}

/**
 * Raw micro-USDC → human number. Sums can exceed float precision at whale
 * scale, so the caller sums in BigInt and divides ONCE here — split into whole
 * dollars + micro remainder so huge sums stay exact to the cent.
 */
function formatUsdc(raw: bigint): number {
  const sign = raw < 0n ? -1 : 1;
  const abs = sign < 0 ? -raw : raw;
  const value = Number(abs / 1_000_000n) + Number(abs % 1_000_000n) / 1e6;
  return sign * roundSig(value, 12);
}

function formatEth(wei: bigint): number {
  return roundSig(Number(wei) / 1e18, 12);
}

/** Strict 0x-hex uint → bigint; reverts ("0x"), error objects, garbage → null. */
function decodeUint(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

// --- Upstream fetchers -------------------------------------------------------

interface Transfer {
  ts: number; // ms
  from: string; // lowercased
  to: string; // lowercased
  raw: bigint; // micro-USDC
}

/**
 * Parse an Etherscan-shaped tokentx reply into asc-ordered transfers. A status
 * "0" with an empty result array is a DEFINITE zero-history answer, not a
 * provider failure. A non-array result (rate-limit prose, HTML) → null.
 */
function parseTokentx(body: unknown): Transfer[] | null {
  const b = body as { result?: unknown };
  if (!Array.isArray(b?.result)) return null;
  const out: Transfer[] = [];
  for (const row of b.result as Array<{ timeStamp?: unknown; from?: unknown; to?: unknown; value?: unknown }>) {
    const ts = typeof row?.timeStamp === "string" ? Number.parseInt(row.timeStamp, 10) : NaN;
    if (
      !Number.isFinite(ts) ||
      typeof row.from !== "string" ||
      typeof row.to !== "string" ||
      typeof row.value !== "string" ||
      !/^\d+$/.test(row.value)
    ) {
      continue;
    }
    out.push({ ts: ts * 1000, from: row.from.toLowerCase(), to: row.to.toLowerCase(), raw: BigInt(row.value) });
  }
  return out;
}

/** USDC transfer history: Blockscout primary, then Etherscan (ethereum + key only). */
async function fetchHistory(
  chain: string,
  address: string,
): Promise<{ transfers: Transfer[]; source: string } | null> {
  const query =
    `?module=account&action=tokentx&contractaddress=${USDC_CONTRACT[chain]}` +
    `&address=${address}&sort=asc&page=1&offset=${MAX_TRANSFERS}`;

  const providers: Array<{ label: string; url: string; source: string }> = [
    { label: `blockscout:tokentx:${chain}`, url: `${BLOCKSCOUT_HOST[chain]}/api${query}`, source: "blockscout" },
  ];
  const etherscanKey = process.env.ETHERSCAN_API_KEY;
  if (chain === "ethereum" && etherscanKey) {
    providers.push({
      label: "etherscan:tokentx",
      url: `https://api.etherscan.io/api${query}&apikey=${etherscanKey}`,
      source: "etherscan",
    });
  }

  for (const p of providers) {
    if (isBenched(p.label)) continue;
    try {
      const resp = await fetch(p.url, { signal: AbortSignal.timeout(timeouts.walletIntel) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const transfers = parseTokentx(await resp.json());
      if (transfers === null) throw new Error("non-array tokentx result");
      return { transfers, source: p.source };
    } catch {
      bench(p.label);
    }
  }
  return null;
}

interface AddressRecord {
  nativeWei: bigint | null;
  isContract: boolean | null;
  source: string;
}

/**
 * Address basics: Blockscout v2 record, then the RPC rotation
 * (eth_getBalance + eth_getCode) so the report degrades instead of dying.
 * A v2 404 is a definite "never seen" answer — zero balance, not a contract.
 */
async function fetchRecord(chain: string, address: string): Promise<AddressRecord | null> {
  const v2Label = `blockscout:v2:${chain}`;
  if (!isBenched(v2Label)) {
    try {
      const resp = await fetch(`${BLOCKSCOUT_HOST[chain]}/api/v2/addresses/${address}`, {
        signal: AbortSignal.timeout(timeouts.walletIntel),
      });
      if (resp.status === 404) {
        return { nativeWei: 0n, isContract: false, source: "blockscout" };
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = (await resp.json()) as { coin_balance?: unknown; is_contract?: unknown };
      const nativeWei =
        typeof body?.coin_balance === "string" && /^\d+$/.test(body.coin_balance)
          ? BigInt(body.coin_balance)
          : null;
      const isContract = typeof body?.is_contract === "boolean" ? body.is_contract : null;
      if (nativeWei === null && isContract === null) throw new Error("empty v2 record");
      return { nativeWei, isContract, source: "blockscout" };
    } catch {
      bench(v2Label);
    }
  }

  for (const rpc of EVM_RPCS[chain]) {
    if (isBenched(rpc)) continue;
    try {
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] },
          { jsonrpc: "2.0", id: 2, method: "eth_getCode", params: [address, "latest"] },
        ]),
        signal: AbortSignal.timeout(timeouts.walletIntel),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const batch = (await resp.json()) as Array<{ id?: number; result?: unknown }>;
      if (!Array.isArray(batch)) throw new Error("non-batch reply");
      const byId = new Map<number | undefined, unknown>();
      for (const e of batch) byId.set(e?.id, e?.result);
      const nativeWei = decodeUint(byId.get(1));
      if (nativeWei === null) throw new Error("invalid eth_getBalance");
      const code = byId.get(2);
      const isContract = typeof code === "string" ? code.replace(/^0x/, "").length > 0 : null;
      return { nativeWei, isContract, source: "rpc" };
    } catch {
      bench(rpc);
    }
  }
  return null;
}

// --- Derivation --------------------------------------------------------------

function detectPattern(recentTs: number[]): "dormant" | "steady" | "burst" {
  if (recentTs.length === 0) return "dormant";
  if (recentTs.length >= BURST_MIN_TRANSFERS) {
    const sorted = [...recentTs].sort((a, b) => a - b);
    let best = 0;
    let j = 0;
    for (let i = 0; i < sorted.length; i++) {
      while (j < sorted.length && sorted[j] - sorted[i] <= BURST_WINDOW_MS) j++;
      if (j - i > best) best = j - i;
    }
    if (best / sorted.length >= BURST_RATIO) return "burst";
  }
  return "steady";
}

function gradeFor(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler -----------------------------------------------------------

walletIntelRouter.get("/wallet/intel", async (req: Request, res: Response) => {
  try {
    const rawChain = pickRequestParam(req, CHAIN_PARAM_ALIASES);
    const chainToken = (rawChain ?? "base").trim().toLowerCase();
    const chain = CHAINS.includes(chainToken) ? chainToken : CHAIN_ALIASES[chainToken];
    if (!chain) {
      res.status(400).json({
        error:
          `Unsupported chain ${JSON.stringify(chainToken.slice(0, 48))}. Supported: ${CHAINS.join(", ")} ` +
          "(default base; eth accepted; alias: network).",
      });
      return;
    }

    const rawAddress = pickRequestParam(req, ADDRESS_ALIASES);
    if (!rawAddress) {
      res.status(400).json({
        error: "Missing address. Pass ?address=0x… (0x + 40 hex chars). Aliases: wallet, account, addr.",
      });
      return;
    }
    if (!EVM_ADDRESS_RE.test(rawAddress)) {
      if (SOLANA_ADDRESS_RE.test(rawAddress)) {
        res.status(400).json({
          error:
            `${rawAddress.slice(0, 48)} looks like a Solana address — /wallet/intel is EVM only in v1 ` +
            "(base, ethereum). For Solana balances use /wallet/balance?chain=solana.",
        });
        return;
      }
      res.status(400).json({
        error:
          `Invalid address ${JSON.stringify(rawAddress.slice(0, 48))}. Expected 0x + 40 hex chars ` +
          "(checksum case is ignored).",
      });
      return;
    }
    // Checksum-insensitive: lowercased everywhere — cache key, upstream calls, response.
    const address = rawAddress.toLowerCase();

    const now = nowFn();
    const key = `${chain}:${address}`;

    // Fresh cache hit → no upstream calls at all.
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      res.json({
        ...hit.data,
        cache_age_seconds: Math.round((now - hit.at) / 1000),
        stale: false,
        findings: hit.findings,
      });
      return;
    }

    // History and address record are independent legs — a failed leg is a
    // finding, never a thrown error.
    const [historySettled, recordSettled] = await Promise.allSettled([
      fetchHistory(chain, address),
      fetchRecord(chain, address),
    ]);
    const history = historySettled.status === "fulfilled" ? historySettled.value : null;
    const record = recordSettled.status === "fulfilled" ? recordSettled.value : null;

    // No primary answer at all → stale-serve (1h ceiling) else 502 uncharged.
    if (history === null && record === null) {
      serveStaleOr502(res, hit, now, chain);
      return;
    }

    const findings: Finding[] = [];
    const flags: string[] = [];
    let score: number | null = 100;

    const isContract = record?.isContract ?? null;
    const nativeBalance = record !== null && record.nativeWei !== null ? formatEth(record.nativeWei) : null;
    if (record === null) {
      findings.push({
        rule: "address_record_unavailable",
        detail: `Blockscout v2 record and every ${chain} RPC failed — native_balance and is_contract are null`,
      });
    }

    let walletAgeDays: number | null = null;
    let firstSeen: string | null = null;
    let firstFunder: { address: string; date: string } | null = null;
    let usdcIn: number | null = null;
    let usdcOut: number | null = null;
    let netFlow: number | null = null;
    let counterparties: number | null = null;
    let topCounterparty: { address: string; volume: number } | null = null;
    let activity30d: { transfers: number; volume: number } | null = null;
    let activityPattern: string | null = null;
    let transfersAnalyzed: number | null = null;
    let truncated = false;

    if (history === null) {
      // History unavailable is NOT zero history — the report ships the basics
      // and suppresses the score rather than guessing.
      score = null;
      findings.push({
        rule: "history_unavailable",
        detail:
          "USDC transfer history could not be fetched from any provider — " +
          "age/flow/counterparty fields are null and the score is suppressed",
      });
    } else {
      const transfers = history.transfers;
      transfersAnalyzed = transfers.length;
      truncated = transfers.length >= MAX_TRANSFERS;
      if (truncated) {
        findings.push({
          rule: "history_truncated",
          detail:
            `analysis capped at the first ${MAX_TRANSFERS} USDC transfers (oldest-first) — ` +
            "totals, counterparties, and activity_30d may undercount later activity",
        });
      }

      if (transfers.length === 0) {
        // Empty wallet is a REAL answer — low score + flags IS the product.
        score += -40;
        flags.push("no_history");
        flags.push("fresh_or_inactive");
        usdcIn = 0;
        usdcOut = 0;
        netFlow = 0;
        counterparties = 0;
        activity30d = { transfers: 0, volume: 0 };
        activityPattern = "dormant";
      } else {
        const first = transfers[0]; // sort=asc → oldest row first
        firstSeen = new Date(first.ts).toISOString();
        walletAgeDays = Math.floor((now - first.ts) / DAY_MS);

        const inboundFirst = transfers.find((t) => t.to === address && t.from !== address);
        if (inboundFirst) {
          firstFunder = { address: inboundFirst.from, date: new Date(inboundFirst.ts).toISOString() };
        }

        // Self-transfers (from == to == address) count in neither direction.
        let inRaw = 0n;
        let outRaw = 0n;
        const peerVolume = new Map<string, bigint>();
        for (const t of transfers) {
          const isSelf = t.from === address && t.to === address;
          if (isSelf) continue;
          if (t.to === address) inRaw += t.raw;
          else if (t.from === address) outRaw += t.raw;
          const peer = t.to === address ? t.from : t.to;
          peerVolume.set(peer, (peerVolume.get(peer) ?? 0n) + t.raw);
        }
        usdcIn = formatUsdc(inRaw);
        usdcOut = formatUsdc(outRaw);
        netFlow = formatUsdc(inRaw - outRaw);
        counterparties = peerVolume.size;
        let topRaw = -1n;
        for (const [peer, volume] of peerVolume) {
          if (volume > topRaw) {
            topRaw = volume;
            topCounterparty = { address: peer, volume: formatUsdc(volume) };
          }
        }

        // sort=asc → the 30d window is the TAIL of the list; no desc re-fetch.
        const recent = transfers.filter((t) => now - t.ts <= WINDOW_30D_MS);
        let recentRaw = 0n;
        for (const t of recent) {
          if (!(t.from === address && t.to === address)) recentRaw += t.raw;
        }
        activity30d = { transfers: recent.length, volume: formatUsdc(recentRaw) };
        activityPattern = detectPattern(recent.map((t) => t.ts));

        // Grading rubric — deductions are negative integers; flags carry the
        // fired rule names verbatim.
        if (walletAgeDays < 7) {
          score += -30;
          flags.push("fresh_wallet");
        } else if (walletAgeDays < 30) {
          score += -15;
          flags.push("young_wallet");
        }
        if (counterparties <= 1) {
          score += -15;
          flags.push("single_counterparty");
        }
        if (outRaw === 0n && inRaw > 0n) {
          score += -10;
          flags.push("no_outbound");
        }
        if (activityPattern === "burst") {
          score += -10;
          flags.push("burst_pattern");
        }
      }
    }

    // Finding only, not a deduction — contracts (multisigs, routers) are a
    // different trust question, not automatically a worse one.
    if (isContract === true) {
      flags.push("contract_wallet");
      findings.push({
        rule: "contract_wallet",
        detail: "address is a contract, not an EOA — the report reflects the contract's USDC flow",
      });
    }

    if (score !== null) score = Math.max(0, score);

    const sources = [...new Set([history?.source, record?.source].filter(Boolean))];

    const data: Record<string, unknown> = {
      address,
      chain,
      is_contract: isContract,
      wallet_age_days: walletAgeDays,
      first_seen: firstSeen,
      first_funder: firstFunder,
      usdc_in_total: usdcIn,
      usdc_out_total: usdcOut,
      net_flow: netFlow,
      counterparties,
      top_counterparty: topCounterparty,
      activity_30d: activity30d,
      activity_pattern: activityPattern,
      native_balance: nativeBalance,
      transfers_analyzed: transfersAnalyzed,
      truncated,
      score,
      grade: score !== null ? gradeFor(score) : null,
      flags,
      source: sources.join("+"),
    };

    cache.set(key, { at: now, data, findings });
    res.json({ ...data, cache_age_seconds: 0, stale: false, findings });
  } catch (err) {
    console.error("Wallet intel error:", err);
    res.status(500).json({ error: "Upstream wallet data unavailable" });
  }
});

/** Stale-serve last resort: younger than the 1h ceiling → billed 200 + finding; else 502 uncharged. */
function serveStaleOr502(res: Response, hit: CacheEntry | undefined, now: number, chain: string): void {
  if (hit && now - hit.at <= STALE_MAX_MS) {
    const ageS = Math.round((now - hit.at) / 1000);
    res.json({
      ...hit.data,
      cache_age_seconds: ageS,
      stale: true,
      findings: [
        ...hit.findings,
        {
          rule: "stale_data",
          detail: `every ${chain} history and record provider failed this call — serving the last good report, ${ageS}s old`,
        },
      ],
    });
    return;
  }
  res.status(502).json({ error: `Upstream wallet data unavailable for ${chain}` });
}
