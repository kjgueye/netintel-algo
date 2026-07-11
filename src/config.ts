/**
 * config.ts — the ONE Algorand-specific adapter file.
 *
 * src/routes/* and src/utils/* are byte-identical copies of NetIntel's (Base).
 * They compile unchanged against this module because it exports exactly the same
 * symbols with the same member names as NetIntel's src/config.ts — only `config`
 * is rewritten to read Algorand env vars. Everything below `config` (pricing,
 * timeouts, limits, dnsResolvers, vendorRiskWeights) is copied verbatim from
 * NetIntel and is kept in step by `npm run sync:from-netintel`.
 *
 * Consequence: NetIntel's routes build their own 402 stubs from
 * pricing.* / config.network / config.payTo, and those now resolve to Algorand
 * values automatically — no per-route edits, no payment-stub helper.
 */
import { readFileSync } from "node:fs";

// Minimal .env loader (no dotenv dependency). Railway injects real env vars, so
// this is a no-op in production. Must run before the module-level reads below.
function loadDotEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
  } catch {
    return; // no .env file (e.g. in production) — rely on real env vars
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

// --- Env-only payment config (never hardcode network or payTo) ---------------
// Flipping testnet<->mainnet is a config-only change: set X402_NETWORK and
// PAYTO_ADDRESS. The USDC ASA is derived from the CAIP-2 network by the SDK.
const rawNetwork = process.env.X402_NETWORK;
const rawPayTo = process.env.PAYTO_ADDRESS;

if (!rawNetwork) {
  throw new Error("X402_NETWORK is required (CAIP-2 network id). See .env.example.");
}
if (!rawNetwork.includes(":")) {
  throw new Error(`X402_NETWORK must be a CAIP-2 id like "algorand:<genesis>", got "${rawNetwork}".`);
}
if (!rawPayTo) {
  throw new Error("PAYTO_ADDRESS is required (Algorand payout address). See .env.example.");
}

export const config = {
  payTo: rawPayTo,
  // CAIP-2 template-literal type; the "chain:ref" shape is checked above.
  network: rawNetwork as `${string}:${string}`,
  port: parseInt(process.env.PORT || "3000", 10),
  devMode: process.env.DEV_MODE === "true",
  // Canonical origin advertised by the discovery artifacts. When unset they fall
  // back to the request's own scheme + Host (see src/base-url.ts).
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  securityContact: process.env.SECURITY_CONTACT || "mailto:security@netintel.dev",
  supportContact: process.env.SUPPORT_CONTACT || "support@netintel.dev",
};

// --- Everything below is VERBATIM from NetIntel src/config.ts ----------------
// Do not hand-edit: `npm run sync:from-netintel` reports drift against upstream.

export const pricing = {
  dnsLookup: "$0.002",
  sslAnalyze: "$0.030",
  subnetCalc: "$0.005",
  redirectTrace: "$0.010",
  securityHeaders: "$0.010",
  emailAuth: "$0.002",
  cloudFingerprint: "$0.010",
  schemaParse: "$0.050",
  asnLookup: "$0.030",
  whoisRdap: "$0.003",
  certTransparency: "$0.010",
  dnsPropagation: "$0.030",
  dnssec: "$0.030",
  ipBlacklist: "$0.050",
  techFingerprint: "$0.050",
  breachCheck: "$0.010",
  domainAvailability: "$0.050",
  emailIntel: "$0.005",
  ogScraper: "$0.010",
  pageExtract: "$0.050",
  phoneIntel: "$0.050",
  robotsTxt: "$0.010",
  rssParser: "$0.010",
  usernameCheck: "$0.030",
  wayback: "$0.010",
  ipReputation: "$0.050",
  cronParser: "$0.030",
  currencyExchange: "$0.010",
  convert: "$0.01",
  githubIntel: "$0.030",
  holidays: "$0.005",
  ipGeo: "$0.002",
  jwtInspector: "$0.005",
  langDetect: "$0.005",
  npmIntel: "$0.010",
  sitemapParser: "$0.010",
  urlSafety: "$0.050",
  bulkDomain: "$0.100",
  domainAge: "$0.030",
  domainAppraise: "$0.030",
  domainReport: "$0.100",
  ipRisk: "$0.100",
  nameGen: "$0.050",
  tldPrice: "$0.010",
  typosquat: "$0.050",
  domainDueDiligence: "$0.20",
  domainReportFull: "$0.25",
  emailReportFull: "$0.15",
  ipReportFull: "$0.20",
  urlSafetyFull: "$0.15",
  // Composite domain trust/risk bundle (POST /domain/vendor-risk). Priced on the
  // aggregator floor rule: strictly ABOVE the most expensive single underlying
  // check (ip-reputation $0.050) and strictly BELOW the sum of the six it
  // composes — domain-age $0.030 + ssl $0.030 + dns $0.002 + email-auth $0.002 +
  // ip-reputation $0.050 + cert-transparency $0.010 = $0.124. $0.10 clears both
  // and lands on the existing $0.100 composite tier (domain-report/ip-risk/bulk-
  // domain), giving agents a ~19% incentive to call the bundle over the parts.
  domainVendorRisk: "$0.10",
  classify: "$0.005",
  contentModerate: "$0.05",
  entityExtract: "$0.050",
  sentiment: "$0.002",
  textSummarize: "$0.005",
  translateLong: "$0.08",
  translateShort: "$0.03",
  extractAddress: "$0.03",
  extractContact: "$0.05",
  extractInvoice: "$0.10",
  extractResume: "$0.08",
  extractTable: "$0.05",
  markdownClean: "$0.03",
  normalizeJson: "$0.05",
  textToJson: "$0.05",
  webExtract: "$0.003",
  moneyParse: "$0.01",
  calendarIcs: "$0.005",
  eventClassify: "$0.02",
  // Price parity with schemaParse maintained — both cut $0.100 → $0.050
  // (2026-07) for competitive alignment after on-chain evidence a whale moved
  // the extraction step to a $0.05 provider. See src/routes/event-extract.ts.
  eventExtract: "$0.050",
  // Flat per-call price for /messages. Bounded input + max_tokens caps (see
  // src/routes/messages.ts) keep the worst-case Sonnet 4.6 cost ~$0.02, so this
  // clears margin on every call.
  messages: "$0.06",
  // Flat per-call price for /ai-image/generate. gpt-image-1 at "medium" quality
  // costs ~$0.04 (1024²) to ~$0.06 (1536-wide) per image, plus a ~$0.001 Claude
  // Haiku metadata call — so $0.25 is ~4-6× margin. n=1 and standard(=medium)
  // quality are capped in the route to keep the worst case bounded.
  // NOTE: this endpoint currently fails CDP facilitator settlement verify
  // ("paymentPayload invalid") — the price is NOT the cause (tested $0.10 too);
  // it appears to be a CDP-side issue onboarding this brand-new resource. The
  // endpoint itself works end-to-end (verified locally in DEV_MODE).
  aiImageAssets: "$0.25",
} as const;

export const timeouts = {
  dns: 3000,
  ssl: 5000,
  redirect: 5000,
  securityHeaders: 10000,
  cloudFingerprint: 10000,
  schemaParse: 30000,
  asnLookup: 8000,
  whoisRdap: 10000,
  // Per-attempt crt.sh timeout. Kept short so a slow/degraded crt.sh fails over
  // to the certspotter fallback fast instead of holding a paid request ~30s
  // (prod: mongodb.com timed out at 30s). See runCertTransparency's fallback.
  certTransparency: 12000,
  dnsPropagation: 5000,
  dnssec: 10000,
  ipBlacklist: 10000,
  techFingerprint: 10000,
  breachCheck: 6000,
  domainAvailability: 8000,
  emailIntel: 5000,
  ogScraper: 10000,
  pageExtract: 12000,
  phoneIntel: 1000,
  robotsTxt: 8000,
  rssParser: 10000,
  usernameCheck: 10000,
  wayback: 10000,
  currencyExchange: 8000,
  // Pure compute (in-code factor tables) — no external calls; safety ceiling
  // only, kept for parity with the other endpoints.
  convert: 5000,
  githubIntel: 8000,
  holidays: 8000,
  ipGeo: 15000,
  npmIntel: 8000,
  sitemapParser: 10000,
  urlSafety: 8000,
  bulkDomain: 8000,
  domainAge: 10000,
  domainReport: 8000,
  ipRisk: 8000,
  nameGen: 6000,
  typosquat: 6000,
  // Per-sub-service timeout for the domain-due-diligence aggregator.
  domainDueDiligence: 5000,
  // Per-sub-service timeout for the domain-report-full aggregator.
  domainReportFull: 5000,
  // Per-sub-service timeout for the email-report-full aggregator.
  emailReportFull: 5000,
  // Per-sub-service timeout for the ip-report-full aggregator.
  ipReportFull: 5000,
  // Per-sub-service timeout for the url-safety-full aggregator.
  urlSafetyFull: 5000,
  // Per-signal deadline for the domain-vendor-risk aggregator. The six signals
  // run concurrently, so wall-clock ≈ this value; a slow/failing signal degrades
  // to signals_unavailable rather than failing the whole call.
  domainVendorRisk: 10000,
  classify: 30000,
  contentModerate: 30000,
  entityExtract: 30000,
  sentiment: 30000,
  textSummarize: 30000,
  translateLong: 30000,
  translateShort: 30000,
  extractAddress: 30000,
  extractContact: 30000,
  extractInvoice: 30000,
  // URL-mode document fetch for /extract/invoice only; the LLM call that
  // follows is still bounded by extractInvoice above.
  extractInvoiceFetch: 15000,
  extractResume: 30000,
  extractTable: 30000,
  markdownClean: 30000,
  normalizeJson: 30000,
  textToJson: 30000,
  webExtract: 12000,
  // LLM fallback path only; the deterministic fast path uses no timer.
  moneyParse: 30000,
  // Pure compute (RFC 5545 construction) — no external calls; cap is a safety
  // ceiling only, kept for parity with the other endpoints.
  calendarIcs: 5000,
  eventClassify: 30000,
  eventExtract: 30000,
  // Anthropic Messages call for /messages (non-streaming, max_tokens <= 4096).
  messages: 60000,
  // Image-provider HTTP call for /ai-image/generate. DALL·E 3 renders can
  // take 10–30s; the cap is generous. The preceding Claude Haiku metadata call
  // uses its own shorter timeout (see src/routes/ai-image-assets.ts).
  aiImageAssets: 60000,
} as const;

export const limits = {
  maxRedirectHops: 20,
  maxHostnameLength: 253,
} as const;

export const dnsResolvers = {
  Google: "8.8.8.8",
  Cloudflare: "1.1.1.1",
  Quad9: "9.9.9.9",
} as const;

// Relative weights for the domain-vendor-risk composite. Kept here (not inline in
// the route) so the blend can be retuned without a code change. The route
// re-normalizes these across only the signals that returned, so the absolute
// magnitudes — not their sum — are what matter. v1 defaults per the service spec:
// domain age and email/IP trust dominate; SSL/DNS/CT are corroborating signals.
export const vendorRiskWeights = {
  domain_age: 25,
  email_auth: 20,
  ip_reputation: 20,
  ssl: 15,
  dns: 10,
  cert_transparency: 10,
} as const;
