/**
 * THROWAWAY — seed every paid endpoint into the GoPlausible discovery index with
 * one real settlement each (self-pay KGIE→KGIE, gasless; the USDC returns to the
 * same wallet, so the true cost is just the facilitator's cut + fees).
 *
 * It does NOT hand-maintain a target list. It reads:
 *   1. the live service manifest  (/.well-known/x402)  -> every endpoint, its
 *      price, and a REAL example input (bazaar `discovery.input`), so a new
 *      endpoint is picked up automatically with no edit here; and
 *   2. the facilitator's catalog   (/discovery/resources) -> what is already
 *      listed, so a re-run SKIPS those and cannot double-pay.
 *
 * Endpoints run SEQUENTIALLY so each settlement's logs are unambiguous.
 *
 * Matching note: already-listed entries are matched on METHOD + PATH, ignoring
 * the URL scheme. The first 7 endpoints were cataloged as http://algo.netintel.dev/…
 * before the service began pinning its x402 `resource` to PUBLIC_BASE_URL (https).
 * Re-seeding them would mint a SECOND https:// entry rather than update the old
 * one, so by default they are left alone. INCLUDE_LISTED=1 overrides.
 *
 * x402 settles only on HTTP < 400, so a handler that errors costs you nothing —
 * failed endpoints are simply reported and can be retried with ONLY=.
 *
 * Run:
 *   DRY_RUN=1 npx tsx scripts/seed-all.ts                 # plan + cost, no payment
 *   MNEMONIC="...24 words..." npx tsx scripts/seed-all.ts # seed for real
 *
 * Env: RESOURCE_SERVER_URL, ONLY (comma-separated path/label prefixes),
 *      INCLUDE_LISTED=1, DRY_RUN=1, ALGOD_MAINNET_URL.
 */
import { pbkdf2Sync } from "node:crypto";
import { wrapFetchWithPayment, x402Client } from "@x402-avm/fetch";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/client";
import type { ClientAvmSigner } from "@x402-avm/avm";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402-avm/core/http";
import { fromSeed, XHDWalletAPI, KeyContext, BIP32DerivationType } from "@algorandfoundation/xhd-wallet-api";
import { encodeAddress } from "@algorandfoundation/algokit-utils/common";
import { decodeTransaction, bytesForSigning, encodeSignedTransaction } from "@algorandfoundation/algokit-utils/transact";

const EXPECTED_ADDRESS = "KGIEWEWNIZWZB4DVGVFW4FAPL3DON6HT5WFHWMDH42SNAYWVPRQ7YBP6EM";
const BASE = (process.env.RESOURCE_SERVER_URL ?? "https://algo.netintel.dev").replace(/\/+$/, "");
const FACILITATOR = process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";
const DRY_RUN = process.env.DRY_RUN === "1";
const INCLUDE_LISTED = process.env.INCLUDE_LISTED === "1";

interface SeedTarget {
  label: string;
  method: "GET" | "POST";
  path: string;      // path only, no query
  url: string;       // full URL incl. query built from the example input
  price: string;
  priceNum: number;
  body?: unknown;
}

// --- 1. What the service offers (with a real example input per endpoint) -----

interface ManifestEndpoint {
  method: string;
  path: string;
  price?: string;
  discovery?: {
    input?: { queryParams?: Record<string, unknown>; body?: unknown };
  };
}

function priceToNumber(p: string | undefined): number {
  const n = parseFloat((p ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function loadTargets(): Promise<SeedTarget[]> {
  const res = await fetch(`${BASE}/.well-known/x402`);
  if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
  const manifest = (await res.json()) as { endpoints: ManifestEndpoint[] };

  return manifest.endpoints.map((e) => {
    const method = e.method.toUpperCase() === "POST" ? "POST" : "GET";
    const input = e.discovery?.input;
    let url = `${BASE}${e.path}`;
    let body: unknown;

    if (method === "GET") {
      // The bazaar example input IS the query string for GET routes.
      const qp = input?.queryParams ?? {};
      const qs = new URLSearchParams(
        Object.entries(qp).map(([k, v]) => [k, String(v)])
      ).toString();
      if (qs) url += `?${qs}`;
    } else {
      body = input?.body ?? {};
    }

    return {
      label: e.path.replace(/^\//, "").replace(/\//g, "-"),
      method,
      path: e.path,
      url,
      price: e.price ?? "$0",
      priceNum: priceToNumber(e.price),
      body,
    };
  });
}

// --- 2. What the facilitator has already cataloged ---------------------------

/** "METHOD /path" keys already listed for our host — scheme-insensitive. */
async function loadAlreadyListed(): Promise<Set<string>> {
  const listed = new Set<string>();
  const host = new URL(BASE).host;
  let url: string | null = `${FACILITATOR}/discovery/resources`;

  for (let page = 0; url && page < 25; page++) {
    const res: Response = await fetch(url);
    if (!res.ok) {
      console.warn(`  ⚠ facilitator catalog HTTP ${res.status} — cannot dedupe; assuming nothing is listed.`);
      return listed;
    }
    const json = (await res.json()) as {
      items?: Array<{ resourceUrl?: string; method?: string }>;
      pagination?: { next?: string | null; nextUrl?: string | null };
    };
    for (const item of json.items ?? []) {
      if (!item.resourceUrl) continue;
      let parsed: URL;
      try {
        parsed = new URL(item.resourceUrl);
      } catch {
        continue;
      }
      if (parsed.host !== host) continue; // other merchants' resources
      // Ignore scheme (http:// vs https://) and any query string.
      listed.add(`${(item.method ?? "GET").toUpperCase()} ${parsed.pathname}`);
    }
    const next = json.pagination?.next ?? json.pagination?.nextUrl ?? null;
    url = next ? new URL(next, FACILITATOR).toString() : null;
  }
  return listed;
}

// --- Signer (unchanged: ARC-52 HD, address verified before any signing) ------

const mnemonic = process.env.MNEMONIC?.trim();
const passphrase = process.env.MNEMONIC_PASSPHRASE ?? "";
const context = KeyContext.Address;
const account = Number(process.env.HD_ACCOUNT ?? "0");
const keyIndex = Number(process.env.HD_KEY_INDEX ?? "0");
const derivationType = BIP32DerivationType.Peikert;

async function buildSigner(): Promise<ClientAvmSigner> {
  if (!mnemonic || mnemonic.split(/\s+/).length !== 24) {
    console.error("MNEMONIC env var is required (24-word BIP-39 phrase). Nothing sent.");
    process.exit(1);
  }
  const seed = pbkdf2Sync(
    Buffer.from(mnemonic.normalize("NFKD"), "utf8"),
    Buffer.from(("mnemonic" + passphrase).normalize("NFKD"), "utf8"),
    2048,
    64,
    "sha512",
  );
  const rootKey = fromSeed(Buffer.from(seed));
  const api = new XHDWalletAPI();
  const pub = await api.keyGen(rootKey, context, account, keyIndex, derivationType);
  const address = encodeAddress(pub);
  if (address !== EXPECTED_ADDRESS) {
    console.error(`[abort] derived address ${address} != expected ${EXPECTED_ADDRESS}. Nothing sent.`);
    process.exit(1);
  }
  console.log(`[signer] ready: ${address} (m/44'/283'/${account}'/0/${keyIndex})`);
  return {
    address,
    signTransactions: async (txns: Uint8Array[], idx?: number[]) =>
      Promise.all(
        txns.map(async (txn, i) => {
          if (idx && !idx.includes(i)) return null;
          const decoded = decodeTransaction(txn);
          const msg = bytesForSigning.transaction(decoded);
          const sig = await api.signAlgoTransaction(rootKey, context, account, keyIndex, msg, derivationType);
          return encodeSignedTransaction({ txn: decoded, sig });
        }),
      ),
  };
}

// --- Seeding -----------------------------------------------------------------

interface SeedResult {
  label: string;
  ok: boolean;
  status?: number;
  txId?: string;
  error?: string;
}

async function seedOne(
  fetchWithPay: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  t: SeedTarget,
  n: number,
  total: number,
): Promise<SeedResult> {
  console.log(`\n=== [${n}/${total}] ${t.label} — ${t.method} ${t.path} (${t.price}) ===`);
  const init: RequestInit =
    t.method === "POST"
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t.body) }
      : { method: "GET" };

  let res: Response;
  try {
    res = await fetchWithPay(t.url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ payment failed before a final response: ${msg}`);
    return { label: t.label, ok: false, error: msg };
  }

  console.log(`  final HTTP ${res.status}`);
  const bodyText = await res.text();

  if (res.status < 200 || res.status >= 300) {
    // Not settled — x402 only settles on HTTP < 400, so this cost nothing.
    const reReq = res.headers.get("PAYMENT-REQUIRED") ?? res.headers.get("X-PAYMENT-REQUIRED");
    let reason = bodyText.slice(0, 200);
    if (reReq) {
      try {
        reason = decodePaymentRequiredHeader(reReq).error ?? reason;
      } catch { /* keep body text */ }
    }
    console.error(`  ❌ not settled (not charged): ${reason}`);
    return { label: t.label, ok: false, status: res.status, error: reason };
  }

  console.log(`  body: ${bodyText.slice(0, 160).replace(/\s+/g, " ")}${bodyText.length > 160 ? "…" : ""}`);
  const respHeader = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  if (!respHeader) {
    console.warn("  ⚠ 2xx but no PAYMENT-RESPONSE header — no settlement txId returned");
    return { label: t.label, ok: false, status: res.status, error: "no PAYMENT-RESPONSE header" };
  }
  try {
    const settle = decodePaymentResponseHeader(respHeader);
    if (settle.success) {
      console.log(`  ✅ SETTLED tx ${settle.transaction}  https://allo.info/tx/${settle.transaction}`);
      return { label: t.label, ok: true, status: res.status, txId: settle.transaction };
    }
    console.error(`  ❌ settle failure: ${settle.errorReason ?? ""} ${settle.errorMessage ?? ""}`);
    return { label: t.label, ok: false, status: res.status, error: settle.errorReason ?? "settle failure" };
  } catch (e) {
    return { label: t.label, ok: false, status: res.status, error: `could not decode PAYMENT-RESPONSE: ${e}` };
  }
}

async function main(): Promise<void> {
  console.log(`=== seed-all — one settlement per endpoint against ${BASE} ===\n`);

  const all = await loadTargets();
  console.log(`service manifest : ${all.length} paid endpoints`);

  const listed = INCLUDE_LISTED ? new Set<string>() : await loadAlreadyListed();
  console.log(`already cataloged: ${listed.size}${INCLUDE_LISTED ? " (ignored — INCLUDE_LISTED=1)" : " (will be skipped)"}`);

  const only = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const skipped = all.filter((t) => listed.has(`${t.method} ${t.path}`));
  let targets = all.filter((t) => !listed.has(`${t.method} ${t.path}`));
  if (only.length) {
    targets = targets.filter((t) => only.some((o) => t.label.startsWith(o) || t.path.startsWith(o)));
  }

  if (skipped.length) {
    console.log(`\nSKIP (already in the discovery index):`);
    for (const t of skipped) console.log(`  - ${t.method} ${t.path}`);
  }

  const cost = targets.reduce((s, t) => s + t.priceNum, 0);
  console.log(`\nTO SEED: ${targets.length} endpoints, total ${cost.toFixed(3)} USDC (self-paid, returns to the same wallet)`);
  for (const t of targets) console.log(`  ${t.price.padStart(7)}  ${t.method.padEnd(4)} ${t.path}`);

  if (!targets.length) {
    console.log("\nNothing to seed. Everything is already cataloged.");
    return;
  }
  if (DRY_RUN) {
    console.log("\nDRY_RUN=1 — no payments made. Re-run with MNEMONIC set to seed for real.");
    return;
  }

  const signer = await buildSigner();
  const client = new x402Client();
  const ALGOD_MAINNET = process.env.ALGOD_MAINNET_URL ?? "https://mainnet-api.algonode.cloud";
  registerExactAvmScheme(client, { signer, algodConfig: { algodUrl: ALGOD_MAINNET } });
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  const results: SeedResult[] = [];
  for (const [i, t] of targets.entries()) {
    results.push(await seedOne(fetchWithPay, t, i + 1, targets.length));
  }

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.label.padEnd(26)} ${r.ok ? `tx ${r.txId}` : `(${r.error ?? "failed"})`}`);
  }
  const spent = targets
    .filter((t) => ok.some((r) => r.label === t.label))
    .reduce((s, t) => s + t.priceNum, 0);
  console.log(`\nseeded ${ok.length}/${results.length} — ${spent.toFixed(3)} USDC settled`);

  if (failed.length) {
    console.error(`\n${failed.length} failed (NOT charged — x402 settles only on HTTP < 400).`);
    console.error(`Retry just those:  ONLY=${failed.map((f) => f.label).join(",")} npx tsx scripts/seed-all.ts`);
    process.exit(1);
  }
  console.log(`\nAll seeded. Verify: ${FACILITATOR}/discovery/resources`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
