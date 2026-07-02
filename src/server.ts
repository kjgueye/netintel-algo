import express from "express";
import { readFileSync } from "node:fs";
import { HTTPFacilitatorClient, x402ResourceServer, type RouteConfig } from "@x402-avm/core/server";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { paymentMiddleware, type Network } from "@x402-avm/express";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402-avm/extensions";
import { currencyExchangeRouter } from "./currency-exchange.js";
import { schemaParseRouter, SCHEMA_PARSE_PRICE } from "./schema-parse.js";
import { domainReportRouter, DOMAIN_REPORT_PRICE } from "./domain-report.js";
import { sentimentRouter, SENTIMENT_PRICE } from "./sentiment.js";
import { domainAvailabilityRouter, DOMAIN_AVAILABILITY_PRICE } from "./domain-availability.js";
import { messagesRouter, MESSAGES_PRICE } from "./messages.js";
import { aiImageRouter, AI_IMAGE_PRICE } from "./ai-image.js";

// --- Minimal .env loader (no dependency) -----------------------------------
// Loads KEY=VALUE lines from ./.env into process.env if not already set, so we
// don't need dotenv. Railway injects real env vars directly, so this is a no-op
// there (the file won't exist / vars already set).
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

// --- Config (env-only; never hardcode network or payTo) --------------------
const FACILITATOR_URL = "https://facilitator.goplausible.xyz";
const PORT = Number(process.env.PORT ?? 3000);
const PAYTO_ADDRESS = process.env.PAYTO_ADDRESS;
const rawNetwork = process.env.X402_NETWORK;

if (!rawNetwork) {
  throw new Error("X402_NETWORK is required (CAIP-2 network id). See .env.example.");
}
if (!rawNetwork.includes(":")) {
  throw new Error(`X402_NETWORK must be a CAIP-2 id like "algorand:<genesis>", got "${rawNetwork}".`);
}
if (!PAYTO_ADDRESS) {
  throw new Error("PAYTO_ADDRESS is required (Algorand payout address). See .env.example.");
}
// Env is a plain string; Network is the CAIP-2 template-literal type. We've
// checked the "chain:ref" shape above, so this narrowing cast is safe.
const X402_NETWORK = rawNetwork as Network;

// --- x402 wiring -----------------------------------------------------------
// HTTPFacilitatorClient takes a custom URL via FacilitatorConfig.url (2.6.1).
// Receive-only seller: no createAuthHeaders / no signing key.
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// Register the AVM (Algorand) exact scheme on the resource server. The seller
// side needs no signer — settlement is performed by the payer's wallet + the
// facilitator. registerExactAvmScheme(server) wires the algorand:* wildcard.
const resourceServer = new x402ResourceServer(facilitatorClient);
registerExactAvmScheme(resourceServer);

// Bazaar discovery: enrich the PaymentRequired declaration so this endpoint
// lists richly (semantic description + input/output examples) in the
// facilitator's discovery catalog, instead of a bare URL+price entry. This is
// discovery metadata only — it does not touch payment verification/settlement.
resourceServer.registerExtension(bazaarResourceServerExtension);

// Discovery metadata for the convert route: how to call it and what it returns.
// The method (GET) is inferred by bazaarResourceServerExtension.enrichDeclaration
// from the actual route verb, so it is not declared here.
const convertDiscovery = declareDiscoveryExtension({
  input: { from: "USD", to: "EUR", amount: 100 },
  inputSchema: {
    properties: {
      from: {
        type: "string",
        description:
          "Source currency: an ISO 4217 fiat code (e.g. USD, EUR, GBP) or a crypto ticker (e.g. BTC, ETH, USDC). Also accepted as base/source.",
      },
      to: {
        type: "string",
        description:
          "Target currency: fiat code or crypto ticker. Also accepted as target/quote.",
      },
      amount: {
        type: "number",
        description: "Amount of `from` to convert. Optional; defaults to 1.",
      },
      date: {
        type: "string",
        description:
          "Optional YYYY-MM-DD for a historical fiat rate; omit for the latest rate. Not supported for crypto pairs.",
      },
    },
    required: ["from", "to"],
  },
  output: {
    example: {
      from: "USD",
      to: "EUR",
      amount: 100,
      converted_amount: 91.85,
      exchange_rate: 0.9185,
      inverse_rate: 1.0887,
      rate_date: "2026-07-01",
      is_historical: false,
      source: "ecb",
      score: 100,
      grade: "A",
      findings: [],
    },
  },
});

// --- Discovery metadata for the six ported endpoints ------------------------
// POST endpoints declare bodyType "json"; the method itself is inferred from
// the route verb by bazaarResourceServerExtension.enrichDeclaration. Output
// examples mirror each handler's real response shape.

const schemaParseDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: {
    raw_text: "John Doe, Acme Inc, john@acme.com",
    target_schema: { properties: { name: { type: "string" }, company: { type: "string" }, email: { type: "string" } }, required: ["name"] },
  },
  inputSchema: {
    properties: {
      raw_text: { type: "string", description: "Unstructured text to extract from (max 10000 words / 50KB)." },
      target_schema: { type: "object", description: "JSON-Schema-shaped object describing the fields to extract; a top-level `required` array is enforced before billing." },
    },
    required: ["raw_text", "target_schema"],
  },
  output: {
    example: {
      extracted: { name: "John Doe", company: "Acme Inc", email: "john@acme.com" },
      tokens_used: { input: 128, output: 42 },
    },
  },
});

const domainReportDiscovery = declareDiscoveryExtension({
  input: { domain: "example.com" },
  inputSchema: {
    properties: {
      domain: { type: "string", description: "Domain to analyze, e.g. example.com." },
    },
    required: ["domain"],
  },
  output: {
    example: {
      domain: "example.com",
      resolved_ip: "93.184.215.14",
      overall_score: 90,
      grade: "A",
      risk_level: "low",
      sections: {
        whois: { available: true, registrar: "ICANN", created_at: "1995-08-14T04:00:00Z", expires_at: "2027-08-13T04:00:00Z", days_until_expiry: 407, status: ["client delete prohibited"] },
        dns: { available: true, a_records: ["93.184.215.14"], mx_records: [], ns_records: ["a.iana-servers.net"], txt_records: ["v=spf1 -all"] },
        ssl: { available: true, issuer: "DigiCert Inc", valid_from: "2025-01-15T00:00:00.000Z", valid_to: "2026-01-15T23:59:59.000Z", days_until_expiry: 198, san_count: 2 },
        tech: { available: true, server: "ECAcc", cdn: null, cms: null, waf: null },
        blacklist: { available: true, listed_count: 0, lists_checked: 5, listed_on: [] },
      },
      findings: [{ rule: "no_mx_records", deduction: -10, detail: "Domain has no MX records" }],
    },
  },
});

const sentimentDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { text: "The delivery was fast but the packaging was terrible", aspects: ["delivery", "packaging"] },
  inputSchema: {
    properties: {
      text: { type: "string", description: "Text to analyze (max 10000 words / 50KB)." },
      aspects: { type: "array", description: "Optional: up to 10 aspect names for per-aspect sentiment." },
    },
    required: ["text"],
  },
  output: {
    example: {
      polarity: "mixed",
      score: -0.1,
      confidence: 0.92,
      emotions: ["joy", "anger"],
      aspects: { delivery: { polarity: "positive", score: 0.8 }, packaging: { polarity: "negative", score: -0.85 } },
      service_score: 100,
      grade: "A",
      findings: [],
    },
  },
});

const domainAvailabilityDiscovery = declareDiscoveryExtension({
  input: { domain: "myproject" },
  inputSchema: {
    properties: {
      domain: {
        type: "string",
        description: "A bare name (checks 10 popular TLDs: .com .net .org .io .co .dev .app .ai .xyz .me) or a full domain like myproject.com (checks just that one).",
      },
    },
    required: ["domain"],
  },
  output: {
    example: {
      name: "myproject",
      results: [
        { domain: "myproject.com", available: false, status: "registered", registrar: "GoDaddy.com, LLC", expires_at: "2026-11-02T14:00:00Z", days_until_expiry: 124, expiring_soon: false },
        { domain: "myproject.dev", available: true, status: "available", registrar: null, expires_at: null, days_until_expiry: null, expiring_soon: false },
      ],
      available_tlds: [".dev"],
      taken_tlds: [".com"],
      score: 80,
      grade: "B",
      findings: [{ rule: "com_taken", deduction: -20, detail: "myproject.com is already registered" }],
    },
  },
});

const messagesDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "Say hello in French" }],
    max_tokens: 256,
  },
  inputSchema: {
    properties: {
      messages: { type: "array", description: "OpenAI chat.completions-shaped messages array (system/user/assistant). Total content max 6000 characters." },
      model: { type: "string", description: 'Optional. Supported: "claude-sonnet-4-6" (aliases: balanced, sonnet). Defaults to claude-sonnet-4-6.' },
      max_tokens: { type: "number", description: "Optional completion cap; hard-capped at 1024." },
      temperature: { type: "number", description: "Optional sampling temperature (at most one of temperature/top_p)." },
    },
    required: ["messages"],
  },
  output: {
    example: {
      id: "chatcmpl-0f1e2d3c4b5a69788796a5b4",
      object: "chat.completion",
      created: 1782950400,
      model: "claude-sonnet-4-6",
      choices: [{ index: 0, message: { role: "assistant", content: "Bonjour !" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    },
  },
});

const aiImageDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: {
    prompt: "clean modern app icon for a network intelligence API",
    use_case: "app_icon",
    style: "flat, minimal",
    brand_colors: ["deep blue", "cyan"],
  },
  inputSchema: {
    properties: {
      prompt: { type: "string", description: "Describe the asset (3-2000 chars). Aliases: text, description, input." },
      use_case: { type: "string", description: "One of: app_icon, logo, avatar, social_graphic, og_image, blog_thumbnail, banner, product_mockup, web_image, illustration. Defaults to web_image." },
      aspect_ratio: { type: "string", description: 'Optional: "1:1", "16:9", "9:16" (aliases like square/wide/tall). Defaults per use case.' },
      style: { type: "string", description: "Optional style guidance (max 200 chars)." },
      brand_colors: { type: "array", description: "Optional: up to 8 color strings folded into the prompt." },
      quality: { type: "string", description: '"standard" only in v1.' },
    },
    required: ["prompt"],
  },
  output: {
    example: {
      image_url: "data:image/png;base64,iVBORw0KGgo...",
      revised_prompt: "A minimal flat app icon of a stylized network graph...",
      use_case: "app_icon",
      aspect_ratio: "1:1",
      size: "1024x1024",
      quality: "standard",
      n: 1,
      provider: "openai",
      model: "gpt-image-1",
      alt_text: "Flat blue app icon showing a stylized network graph of connected nodes",
      score: 85,
      grade: "B",
      warnings: [],
      disclaimer: "Generated images are not guaranteed to be copyright- or trademark-safe. Review before commercial use. image_url is a base64 PNG data URI (self-contained, no expiry).",
      price: { amount: "0.25", currency: "USD" },
    },
  },
});

// Protected routes. Price/network/payTo are config-driven; the existing
// currency-exchange entry is UNCHANGED. description/mimeType/extensions are
// discovery metadata surfaced in the catalog.
const routes: Record<string, RouteConfig> = {
  "GET /currency-exchange/convert": {
    accepts: {
      scheme: "exact",
      price: "$0.010",
      network: X402_NETWORK,
      payTo: PAYTO_ADDRESS,
    },
    description:
      "Convert an amount between two currencies. Fiat↔fiat pairs use European Central Bank (ECB) reference rates via Frankfurter and support historical rates by date; pairs involving crypto use the latest Coinbase spot rate. Keyless. Returns the converted amount, the exchange rate and its inverse, the rate date, and a structured result envelope (source, score, grade, findings).",
    mimeType: "application/json",
    extensions: { ...convertDiscovery },
  },
  "POST /schema-parse/extract": {
    accepts: {
      scheme: "exact",
      price: SCHEMA_PARSE_PRICE,
      network: X402_NETWORK,
      payTo: PAYTO_ADDRESS,
    },
    description:
      "Extract structured data from unstructured text using an LLM (Claude Haiku 4.5) constrained to your JSON-Schema-shaped target_schema. Required fields are verified present before you are billed; truncated or non-conforming extractions return 4xx/5xx (not charged). Returns the extracted object plus input/output token counts.",
    mimeType: "application/json",
    extensions: { ...schemaParseDiscovery },
  },
  "GET /domain-report/analyze": {
    accepts: {
      scheme: "exact",
      price: DOMAIN_REPORT_PRICE,
      network: X402_NETWORK,
      payTo: PAYTO_ADDRESS,
    },
    description:
      "Full domain risk report running five checks concurrently: WHOIS/RDAP registration (registrar, created/expiry dates, status), DNS records (A/MX/NS/TXT), SSL certificate (issuer, validity, SANs), tech fingerprint (server, CDN, CMS, WAF), and IP reputation across 5 DNS blacklists. Aggregates into a 0-100 score with grade, risk level, and per-rule findings. Keyless.",
    mimeType: "application/json",
    extensions: { ...domainReportDiscovery },
  },
  "POST /sentiment/analyze": {
    accepts: {
      scheme: "exact",
      price: SENTIMENT_PRICE,
      network: X402_NETWORK,
      payTo: PAYTO_ADDRESS,
    },
    description:
      "LLM sentiment analysis (Claude Haiku 4.5): overall polarity (positive/negative/neutral/mixed), a -1..1 sentiment score, confidence, and detected emotions (joy, anger, sadness, fear, surprise, disgust, trust, anticipation). Optionally pass up to 10 aspects for per-aspect polarity and score.",
    mimeType: "application/json",
    extensions: { ...sentimentDiscovery },
  },
  "GET /domain-availability/check": {
    accepts: {
      scheme: "exact",
      price: DOMAIN_AVAILABILITY_PRICE,
      network: X402_NETWORK,
      payTo: PAYTO_ADDRESS,
    },
    description:
      "Domain availability check via RDAP with DNS fallback. Pass a bare name to check 10 popular TLDs (.com .net .org .io .co .dev .app .ai .xyz .me) concurrently, or a full domain to check just that one. Returns per-domain registration status, registrar and expiry for taken domains, available/taken TLD lists, and a brandability score with findings. Keyless.",
    mimeType: "application/json",
    extensions: { ...domainAvailabilityDiscovery },
  },
  "POST /messages": {
    accepts: {
      scheme: "exact",
      price: MESSAGES_PRICE,
      network: X402_NETWORK,
      payTo: PAYTO_ADDRESS,
    },
    description:
      "OpenAI-compatible chat completions endpoint served by Claude Sonnet 4.6. Send a chat.completions-shaped body (messages array, optional model/max_tokens/temperature); receive a chat.completion object back. Flat per-call price with hard caps: 6000 input characters, 1024 max_tokens, non-streaming.",
    mimeType: "application/json",
    extensions: { ...messagesDiscovery },
  },
  "POST /ai-image/generate": {
    accepts: {
      scheme: "exact",
      price: AI_IMAGE_PRICE,
      network: X402_NETWORK,
      payTo: PAYTO_ADDRESS,
    },
    description:
      "AI image asset generator for agents: app icons, logos, avatars, social graphics, OG images, blog thumbnails, banners, product mockups, web images, illustrations. A Claude Haiku pass optimizes the prompt for the use case, writes alt text, scores the request, and screens content policy before the paid render (OpenAI gpt-image-1). Returns a self-contained base64 PNG data URI plus rich metadata (revised prompt, alt text, score/grade, warnings). One 1024px-class image per call.",
    mimeType: "application/json",
    extensions: { ...aiImageDiscovery },
  },
};

// --- App -------------------------------------------------------------------
const app = express();
app.use(express.json());

// Free, unprotected health check (Railway). Must be registered BEFORE the
// payment middleware doesn't matter (the middleware only guards matched routes),
// but keeping it first makes intent obvious and avoids any payment path for it.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", network: X402_NETWORK });
});

// Payment gate: only requests matching `routes` require payment; everything
// else (incl. /health) passes straight through to the next handler.
app.use(paymentMiddleware(routes, resourceServer));

// The actual protected handlers (run only after payment is satisfied).
app.use(currencyExchangeRouter);
app.use(schemaParseRouter);
app.use(domainReportRouter);
app.use(sentimentRouter);
app.use(domainAvailabilityRouter);
app.use(messagesRouter);
app.use(aiImageRouter);

// Bind 0.0.0.0 explicitly so the container is reachable on Railway's network.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`netintel-algo listening on 0.0.0.0:${PORT}`);
  console.log(`  facilitator: ${FACILITATOR_URL}`);
  console.log(`  network:     ${X402_NETWORK}`);
  console.log(`  payTo:       ${PAYTO_ADDRESS}`);
});
