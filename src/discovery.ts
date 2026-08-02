/**
 * discovery.ts — agent-discovery surfaces, ported from the NetIntel pattern.
 *
 * Everything here is FREE (no payment) and generated from the same `routes`
 * object that drives the payment middleware, so the catalogs can never drift
 * from what is actually served/priced. Surfaces:
 *
 *   /.well-known/x402 (+ x402.json, x402-services.json, x402-resources)  — x402 service manifest
 *   /.well-known/api-catalog                                             — RFC 9727 linkset (RFC 9264)
 *   /.well-known/agent-card.json (+ agent.json, agent-card)              — A2A agent card
 *   /apis.json (+ /.well-known/apis.json)                                — APIs.json (apisjson.org)
 *   /.well-known/ai-plugin.json                                          — LLM-plugin manifest
 *   /openapi.json (+ /.well-known/openapi.json)                          — OpenAPI 3.1 (x402scan-compatible)
 *   /llms.txt (+ /llm.txt, /.well-known/llms.txt) and /llms-full.txt     — llmstxt.org catalogs
 *   /.well-known/security.txt                                            — RFC 9116
 *   /robots.txt, /, /api                                                 — crawler/agent on-ramps
 */

import { Router, type Request } from "express";
import { resolveBaseUrl } from "./base-url.js";
import { buildOpenApiSpec } from "./openapi.js";

// Structural view of the RouteConfig entries in server.ts — enough to read
// price/description/discovery metadata without importing SDK types.
export interface DiscoveryRoute {
  accepts:
    | { scheme: string; price: string; network: string; payTo: string }
    | ReadonlyArray<{ scheme: string; price: string; network: string; payTo: string }>;
  description: string;
  mimeType?: string;
  extensions?: Record<string, unknown>;
}

export interface DiscoveryOptions {
  /** CAIP-2 network id, e.g. "algorand:wGHE2…". */
  network: string;
  /** Algorand payout address (58 chars). */
  payTo: string;
  /** Facilitator base URL (GoPlausible). */
  facilitatorUrl: string;
  /** Canonical public origin to advertise (PUBLIC_BASE_URL); request host fallback. */
  publicBaseUrl?: string;
  supportContact?: string;
  securityContact?: string;
}

const NAME = "NetIntel Algo";
const VERSION = "2.0.0";

/**
 * Capability groups, derived from the live route set rather than hand-listed.
 *
 * Each group claims a set of path prefixes. A group is only ever advertised if
 * the routes object actually contains an endpoint matching it, so the catalogs
 * cannot promise a capability this service does not serve. Adding an endpoint
 * under an existing prefix needs no change here; adding a genuinely new family
 * means adding one row (anything unmatched is simply not advertised).
 */
const CAPABILITY_GROUPS: ReadonlyArray<{
  label: string;
  bestFor: string;
  prefixes: readonly string[];
}> = [
  {
    label: "domain & DNS intelligence",
    bestFor: "Domain risk reports, availability, WHOIS/RDAP, DNS, DNSSEC and typosquat checks",
    prefixes: ["/dns", "/dnssec", "/dns-propagation", "/whois-rdap", "/domain", "/bulk-domain", "/typosquat", "/name-gen", "/tld-price"],
  },
  {
    label: "IP & network intelligence",
    bestFor: "IP geolocation, ASN/network ownership, subnet math and IP risk scoring",
    prefixes: ["/ip-geo", "/ip-risk", "/ip-report", "/asn-lookup", "/subnet", "/cloud-fingerprint"],
  },
  {
    label: "security & threat checks",
    bestFor: "TLS/SSL posture, security headers, blacklists, breach and URL-safety checks",
    prefixes: ["/ssl", "/security-headers", "/cert-transparency", "/ip-blacklist", "/ip-reputation", "/url-safety", "/breach-check", "/tech-fingerprint", "/jwt-inspector"],
  },
  {
    label: "email intelligence",
    bestFor: "Email deliverability, SPF/DKIM/DMARC authentication and address validation",
    prefixes: ["/email-auth", "/email-intel", "/email-report"],
  },
  {
    label: "web scraping & page metadata",
    bestFor: "Extracting clean article text, Open Graph metadata, feeds, sitemaps and redirect chains",
    prefixes: ["/web", "/page-extract", "/og-scraper", "/rss-parser", "/sitemap-parser", "/robots-txt", "/redirect", "/wayback"],
  },
  {
    label: "structured extraction",
    bestFor: "Turning unstructured text into JSON that conforms to your own schema",
    prefixes: ["/schema-parse", "/extract", "/entity-extract", "/text-to-json", "/normalize", "/markdown"],
  },
  {
    label: "text understanding",
    bestFor: "Sentiment, classification, moderation, summarization, translation and language detection",
    prefixes: ["/sentiment", "/classify", "/content-moderate", "/text-summarize", "/translate", "/lang-detect"],
  },
  {
    label: "chat completions & image generation",
    bestFor: "OpenAI-compatible chat completions and AI image assets paid per call",
    prefixes: ["/messages", "/ai-image"],
  },
  {
    label: "conversion & utilities",
    bestFor: "Currency and unit conversion, money parsing, calendars, cron and holidays",
    prefixes: ["/currency-exchange", "/convert", "/money", "/calendar", "/cron-parser", "/holidays", "/event-"],
  },
  {
    label: "package & repo intel",
    bestFor: "Assessing npm packages and GitHub repositories before depending on them",
    prefixes: ["/npm-intel", "/github-intel"],
  },
  {
    label: "phone & identity checks",
    bestFor: "Phone number validation and username availability across platforms",
    prefixes: ["/phone-intel", "/username-check"],
  },
];

/** The capability groups actually represented in the live route set. */
function capabilities(endpoints: Endpoint[]): typeof CAPABILITY_GROUPS {
  return CAPABILITY_GROUPS.filter((g) =>
    g.prefixes.some((p) => endpoints.some((e) => e.path.startsWith(p)))
  );
}

/** Comma-joined capability labels with a trailing "and" — e.g. "a, b, and c". */
function capabilityList(endpoints: Endpoint[]): string {
  const labels = capabilities(endpoints).map((g) => g.label);
  if (labels.length <= 1) return labels[0] ?? "pay-per-call utilities";
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function tagline(endpoints: Endpoint[]): string {
  return (
    `Pay-per-call API for AI agents settling on Algorand — ${endpoints.length} endpoints spanning ` +
    `${capabilityList(endpoints)}. Every endpoint is paid per call over the x402 micropayment ` +
    `protocol: no API keys, no signup, no subscriptions.`
  );
}

const HOW_TO_CALL =
  "How to call it: make a normal HTTP request to any endpoint. With no payment you get an " +
  "HTTP 402 response describing the exact price and payment requirements; retry the same " +
  "request with an `X-PAYMENT` header (x402 `exact` scheme, USDC on Algorand). Settlement " +
  "is gasless via the GoPlausible facilitator and only happens if the call succeeds " +
  "(HTTP < 400) — failed calls are never charged. All responses are JSON.";

interface Endpoint {
  method: string;
  path: string;
  price?: string;
  description: string;
  mimeType?: string;
  bazaar?: {
    info?: { input?: { queryParams?: Record<string, unknown>; body?: unknown }; output?: unknown };
    schema?: unknown;
  };
}

function firstAccepts(route: DiscoveryRoute) {
  return Array.isArray(route.accepts) ? route.accepts[0] : route.accepts;
}

/** Flatten the routes object into an ordered endpoint list (declaration order). */
function listEndpoints(routes: Record<string, DiscoveryRoute>): Endpoint[] {
  return Object.entries(routes).flatMap(([key, route]) => {
    const sp = key.indexOf(" ");
    if (sp < 0) return [];
    return [
      {
        method: key.slice(0, sp),
        path: key.slice(sp + 1),
        price: firstAccepts(route)?.price,
        description: route.description,
        mimeType: route.mimeType,
        bazaar: route.extensions?.bazaar as Endpoint["bazaar"],
      },
    ];
  });
}

/** Min/max of the per-call prices, keeping the original "$0.010"-style strings. */
function priceRange(endpoints: Endpoint[]): { min: string; max: string } | undefined {
  const priced = endpoints
    .filter((e) => e.price)
    .map((e) => ({ raw: e.price as string, n: parseFloat((e.price as string).replace(/[^0-9.]/g, "")) }))
    .filter((p) => Number.isFinite(p.n))
    .sort((a, b) => a.n - b.n);
  const lo = priced[0];
  const hi = priced[priced.length - 1];
  if (!lo || !hi) return undefined;
  return { min: lo.raw, max: hi.raw };
}

/** First clause of the description, capped — a concise human label. */
function shortTitle(desc: string): string {
  const first = ((desc || "").split(/[—.\n]/)[0] ?? "").trim();
  return first.length > 80 ? first.slice(0, 79) + "…" : first;
}

// --- x402 service manifest (/.well-known/x402) -------------------------------

function buildX402Manifest(baseUrl: string, endpoints: Endpoint[], opts: DiscoveryOptions): object {
  const range = priceRange(endpoints);
  return {
    // Protocol metadata
    x402Version: 2,
    name: NAME,
    description: tagline(endpoints),
    version: VERSION,
    baseUrl,
    documentation: `${baseUrl}/.well-known/x402`,

    // Payment info
    payment: {
      protocol: "x402",
      scheme: "exact",
      network: opts.network,
      payTo: opts.payTo,
      currency: "USDC",
      ...(range ? { priceRange: range } : {}),
      facilitator: opts.facilitatorUrl,
      note:
        "Unpaid requests return HTTP 402 with payment requirements; retry with an X-PAYMENT " +
        "header (x402 exact scheme, USDC ASA on Algorand — the ASA id is derived from the " +
        "CAIP-2 network). Settlement is gasless via the facilitator and only occurs when the " +
        "call succeeds — failed calls (HTTP >= 400) are never charged.",
    },

    // Service catalog
    totalEndpoints: endpoints.length,
    endpoints: endpoints.map((e) => ({
      method: e.method,
      path: e.path,
      url: `${baseUrl}${e.path}`,
      price: e.price,
      description: e.description,
      mimeType: e.mimeType,
      ...(e.bazaar?.info ? { discovery: e.bazaar.info } : {}),
      ...(e.bazaar?.schema ? { schema: e.bazaar.schema } : {}),
    })),

    // Agent-friendly hints
    hints: {
      authentication: "none — pay-per-call via x402, no API keys needed",
      rateLimit: "none — usage is metered by payment, not rate limits",
      contentType: "application/json for all responses",
      errorFormat: "{ error: string } with appropriate HTTP status codes",
      health: `${baseUrl}/health`,
      bestFor: capabilities(endpoints).map((g) => g.bestFor),
    },
  };
}

// --- RFC 9727 API Catalog (/.well-known/api-catalog), RFC 9264 linkset -------

/** Per RFC 9727: the catalog MUST be served as a linkset with this media type. */
export const API_CATALOG_CONTENT_TYPE =
  'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

function buildApiCatalog(baseUrl: string, endpoints: Endpoint[]): object {
  const item = endpoints.map((e) => {
    const title = shortTitle(e.description);
    return title ? { href: `${baseUrl}${e.path}`, title } : { href: `${baseUrl}${e.path}` };
  });

  return {
    linkset: [
      {
        anchor: `${baseUrl}/.well-known/api-catalog`,
        // Machine-readable API description — the canonical endpoint list.
        "service-desc": [
          {
            href: `${baseUrl}/openapi.json`,
            type: "application/openapi+json",
            title: `${NAME} OpenAPI — ${item.length} endpoints, schemas, prices`,
          },
        ],
        // Human / LLM documentation.
        "service-doc": [
          { href: `${baseUrl}/llms.txt`, type: "text/plain", title: "LLM-readable service catalog" },
        ],
        // Additional machine metadata: x402 prices + I/O schemas, and the agent card.
        "service-meta": [
          { href: `${baseUrl}/.well-known/x402`, type: "application/json", title: "x402 payment manifest (prices + input/output schemas)" },
          { href: `${baseUrl}/.well-known/agent-card.json`, type: "application/json", title: "A2A agent card" },
        ],
        // API health.
        status: [{ href: `${baseUrl}/health`, type: "application/json", title: "Health check" }],
        // Every endpoint, enumerated for direct-reading crawlers.
        item,
      },
    ],
  };
}

// --- A2A Agent Card (/.well-known/agent-card.json) ---------------------------

// This service is not an A2A JSON-RPC server; it is a pay-per-call HTTP API.
// The card describes the catalog and points to the real calling conventions.
function buildAgentCard(baseUrl: string, endpoints: Endpoint[], opts: DiscoveryOptions): object {
  const range = priceRange(endpoints);
  return {
    protocolVersion: "0.3.0",
    name: NAME,
    description: tagline(endpoints),
    url: baseUrl,
    preferredTransport: "HTTP+JSON",
    version: VERSION,
    documentationUrl: `${baseUrl}/llms.txt`,
    provider: { organization: "NetIntel", url: baseUrl, contact: opts.supportContact },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: endpoints.map((e) => ({
      id: e.path.replace(/^\//, "").replace(/\//g, "-"),
      name: shortTitle(e.description) || e.path,
      description: `${e.method} ${e.path} — ${e.description}`,
      tags: ["x402", "algorand", "pay-per-call"],
      examples: [`${e.method} ${baseUrl}${e.path}`],
    })),
    x402: {
      protocol: "x402",
      scheme: "exact",
      network: opts.network,
      payTo: opts.payTo,
      currency: "USDC",
      ...(range ? { priceRange: range } : {}),
      facilitator: opts.facilitatorUrl,
      manifest: `${baseUrl}/.well-known/x402`,
      openapi: `${baseUrl}/openapi.json`,
      llmsTxt: `${baseUrl}/llms.txt`,
      note:
        "Make a normal HTTP request; an unpaid request returns HTTP 402 with payment " +
        "requirements. Retry with an X-PAYMENT header. Failed calls (HTTP >= 400) are never charged.",
    },
  };
}

// --- APIs.json (apisjson.org) -------------------------------------------------

function buildApisJson(baseUrl: string, endpoints: Endpoint[]): object {
  return {
    name: NAME,
    type: "Index",
    description:
      `Pay-per-call API for AI agents — ${endpoints.length} endpoints spanning ` +
      `${capabilityList(endpoints)}, paid per call in USDC on Algorand via x402. ` +
      `No signup, no API keys.`,
    url: `${baseUrl}/apis.json`,
    tags: ["x402", "micropayments", "algorand", "usdc", "ai-agents", "pay-per-call", "api"],
    apis: [
      {
        name: `${NAME} API`,
        description:
          "x402 pay-per-call HTTP API: every endpoint returns JSON and settles a USDC micropayment on Algorand per request (gasless, via the GoPlausible facilitator).",
        humanURL: `${baseUrl}/`,
        baseURL: baseUrl,
        tags: ["x402", "usdc", "algorand"],
        properties: [
          { type: "OpenAPI", url: `${baseUrl}/openapi.json` },
          { type: "x402-manifest", url: `${baseUrl}/.well-known/x402` },
          { type: "llms-txt", url: `${baseUrl}/llms.txt` },
          { type: "AgentCard", url: `${baseUrl}/.well-known/agent-card.json` },
          { type: "ApiCatalog", url: `${baseUrl}/.well-known/api-catalog` },
          { type: "Health", url: `${baseUrl}/health` },
        ],
      },
    ],
    specificationVersion: "0.18",
  };
}

// --- ai-plugin.json ------------------------------------------------------------

function buildAiPlugin(baseUrl: string, endpoints: Endpoint[], opts: DiscoveryOptions): object {
  return {
    schema_version: "v1",
    name_for_human: NAME,
    name_for_model: "netintel_algo",
    description_for_human:
      `${endpoints.length} endpoints spanning ${capabilityList(endpoints)}. ` +
      `Pay-per-call via x402 on Algorand.`,
    description_for_model:
      "Pay-per-call utilities for agents over the x402 micropayment protocol (no API keys). " +
      "Unpaid requests return HTTP 402 with payment requirements; retry with an X-PAYMENT " +
      "header (USDC on Algorand). See the OpenAPI spec for all endpoints and schemas, and /llms.txt for a readable catalog.",
    api: { type: "openapi", url: `${baseUrl}/openapi.json` },
    legal_info_url: `${baseUrl}/`,
    contact_email: opts.supportContact,
  };
}

// --- llms.txt / llms-full.txt (https://llmstxt.org/) ---------------------------

function buildLlmsTxt(baseUrl: string, endpoints: Endpoint[], opts: DiscoveryOptions): string {
  const out: string[] = [];
  out.push(`# ${NAME}`);
  out.push("");
  out.push(`> ${tagline(endpoints)}`);
  out.push("");
  out.push(HOW_TO_CALL);
  out.push("");
  out.push(`- [x402 service manifest](${baseUrl}/.well-known/x402): machine-readable catalog with input/output schemas and live prices`);
  out.push(`- [OpenAPI 3.1 specification](${baseUrl}/openapi.json): full request/response schema for every endpoint`);
  out.push(`- [Full reference](${baseUrl}/llms-full.txt): verbose catalog with input parameters and call examples for every endpoint`);
  out.push(`- Questions, integration help, or feedback: ${opts.supportContact}`);
  out.push("");
  out.push("## Endpoints");
  out.push("");
  for (const e of endpoints) {
    const price = e.price ? ` — ${e.price}` : "";
    out.push(`- [${e.method} ${e.path}](${baseUrl}${e.path})${price}: ${e.description}`);
  }
  out.push("");
  return out.join("\n");
}

function buildLlmsFullTxt(baseUrl: string, endpoints: Endpoint[]): string {
  const out: string[] = [];
  out.push(`# ${NAME} — full endpoint reference`);
  out.push("");
  out.push(`> ${tagline(endpoints)} This is the verbose catalog with call examples; the compact version is at /llms.txt.`);
  out.push("");
  out.push(HOW_TO_CALL);
  out.push("");
  out.push(`- Compact catalog: ${baseUrl}/llms.txt`);
  out.push(`- Machine-readable manifest: ${baseUrl}/.well-known/x402`);
  out.push(`- OpenAPI 3.1 schema: ${baseUrl}/openapi.json`);
  out.push("");
  for (const e of endpoints) {
    out.push(`## ${e.method} ${e.path}${e.price ? ` — ${e.price}` : ""}`);
    out.push(e.description);
    const input = e.bazaar?.info?.input;
    if (input?.queryParams && Object.keys(input.queryParams).length) {
      const qs = Object.entries(input.queryParams)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&");
      out.push(`Example: \`curl "${baseUrl}${e.path}?${qs}"\``);
    } else if (input?.body !== undefined) {
      out.push(`Example: \`curl -X ${e.method} ${baseUrl}${e.path} -H "Content-Type: application/json" -d '${JSON.stringify(input.body)}'\``);
    } else {
      out.push(`Example: \`curl -X ${e.method} ${baseUrl}${e.path}\``);
    }
    out.push("");
  }
  return out.join("\n");
}

// --- security.txt (RFC 9116) ----------------------------------------------------

function buildSecurityTxt(baseUrl: string, opts: DiscoveryOptions): string {
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  return [
    `Contact: ${opts.securityContact}`,
    `Expires: ${expires}`,
    `Canonical: ${baseUrl}/.well-known/security.txt`,
    "Preferred-Languages: en",
    "",
  ].join("\n");
}

// --- JSON on-ramp (/ and /api) ---------------------------------------------------

function buildDiscoveryJson(baseUrl: string, endpoints: Endpoint[], opts: DiscoveryOptions): object {
  const range = priceRange(endpoints);
  return {
    name: NAME,
    description: tagline(endpoints),
    totalEndpoints: endpoints.length,
    discovery: {
      llmsTxt: `${baseUrl}/llms.txt`,
      llmsFullTxt: `${baseUrl}/llms-full.txt`,
      manifest: `${baseUrl}/.well-known/x402`,
      openapi: `${baseUrl}/openapi.json`,
      agentCard: `${baseUrl}/.well-known/agent-card.json`,
      apiCatalog: `${baseUrl}/.well-known/api-catalog`,
      aiPlugin: `${baseUrl}/.well-known/ai-plugin.json`,
    },
    payment: {
      protocol: "x402",
      scheme: "exact",
      network: opts.network,
      currency: "USDC",
      ...(range ? { priceRange: range } : {}),
      facilitator: opts.facilitatorUrl,
      note: "Unpaid requests return HTTP 402 with payment requirements; retry with an X-PAYMENT header. Failed calls (HTTP >= 400) are never charged.",
    },
    hint: "Start with /llms.txt for a readable catalog, or /.well-known/x402 for the machine-readable manifest.",
  };
}

// --- Router ----------------------------------------------------------------------

/**
 * Build the free discovery router. Register it BEFORE the payment middleware —
 * none of these paths appear in `routes`, so they are never payment-gated
 * either way, but keeping them first makes the intent obvious.
 */
export function discoveryRouter(routes: Record<string, DiscoveryRoute>, opts: DiscoveryOptions): Router {
  const options: DiscoveryOptions = {
    supportContact: "support@netintel.dev",
    securityContact: "mailto:security@netintel.dev",
    ...opts,
  };
  const router = Router();
  const base = (req: Request) => resolveBaseUrl(options.publicBaseUrl, req.protocol, req.get("host"));
  // Rebuilt per request: `routes` extensions are enriched in place by the
  // bazaar extension, and the base URL can vary by Host header.
  const endpoints = () => listEndpoints(routes);

  // x402 service manifest. Agents probe several spellings of the manifest path
  // and all expect the same catalog — one handler, one source of truth.
  router.get(
    [
      "/.well-known/x402",
      "/.well-known/x402.json",
      "/.well-known/x402-services.json",
      "/.well-known/x402-resources",
      "/x402-resources",
    ],
    (req, res) => {
      res.set("Cache-Control", "public, max-age=3600");
      res.json(buildX402Manifest(base(req), endpoints(), options));
    }
  );

  // OpenAPI 3.1 spec — x402scan-compatible; crawlers also probe the well-known alias.
  router.get(["/openapi.json", "/.well-known/openapi.json"], (req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.json(buildOpenApiSpec(routes, { baseUrl: base(req), title: `${NAME} API`, version: VERSION, contactEmail: options.supportContact }));
  });

  // llms.txt — human/LLM-readable service catalog; agents probe the variants too.
  router.get(["/llms.txt", "/llm.txt", "/.well-known/llms.txt"], (req, res) => {
    res.type("text/plain; charset=utf-8");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(buildLlmsTxt(base(req), endpoints(), options));
  });

  // llms-full.txt — verbose catalog with per-endpoint examples.
  router.get("/llms-full.txt", (req, res) => {
    res.type("text/plain; charset=utf-8");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(buildLlmsFullTxt(base(req), endpoints()));
  });

  // A2A agent card — agent-card.json is current; agent.json is legacy; bare agent-card is seen too.
  router.get(["/.well-known/agent-card.json", "/.well-known/agent.json", "/.well-known/agent-card"], (req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.json(buildAgentCard(base(req), endpoints(), options));
  });

  // API Catalog (RFC 9727) — served as an RFC 9264 linkset.
  router.get("/.well-known/api-catalog", (req, res) => {
    res.set("Content-Type", API_CATALOG_CONTENT_TYPE);
    res.set("Cache-Control", "public, max-age=3600");
    res.send(JSON.stringify(buildApiCatalog(base(req), endpoints())));
  });

  // APIs.json (apisjson.org) — crawled at the domain root by API directories.
  router.get(["/apis.json", "/.well-known/apis.json"], (req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.json(buildApisJson(base(req), endpoints()));
  });

  // ai-plugin.json — the LLM-plugin discovery convention; points at the OpenAPI spec.
  router.get("/.well-known/ai-plugin.json", (req, res) => {
    res.set("Cache-Control", "public, max-age=3600");
    res.json(buildAiPlugin(base(req), endpoints(), options));
  });

  // security.txt (RFC 9116) — security researchers and scanners probe this.
  router.get("/.well-known/security.txt", (req, res) => {
    res.type("text/plain; charset=utf-8");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buildSecurityTxt(base(req), options));
  });

  // robots.txt — allow everything and point crawlers at the agent-readable catalogs.
  router.get("/robots.txt", (req, res) => {
    const baseUrl = base(req);
    res.type("text/plain; charset=utf-8");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(
      [
        "User-agent: *",
        "Allow: /",
        "",
        `# LLM/agent catalog: ${baseUrl}/llms.txt`,
        `# Full reference: ${baseUrl}/llms-full.txt`,
        `# x402 service manifest: ${baseUrl}/.well-known/x402`,
        `# OpenAPI spec: ${baseUrl}/openapi.json`,
        "",
      ].join("\n")
    );
  });

  // Root + /api on-ramps. JSON pointer document; agents and crawlers hit / first.
  router.get(["/", "/api"], (req, res) => {
    res.json(buildDiscoveryJson(base(req), endpoints(), options));
  });

  // x402 discovery-resources mirror — the single biggest miss on this host:
  // one indexer probed all five CDP-shape variants 81× each (405 misses,
  // daily, still active 2026-08-02) looking for a Bazaar-style resource list.
  // Serve our slice of the catalog in that exact shape, same `routes` source
  // as the manifest. `quality` deliberately omitted (self-reporting traffic
  // stats would be fabrication) — same policy as the NetIntel Base app.
  router.get(
    [
      "/v1/x402/discovery/resources",
      "/v2/x402/discovery/resources",
      "/x402/discovery/resources",
      "/.well-known/x402/discovery/resources",
      "/discovery/resources",
    ],
    (req, res) => {
      const baseUrl = base(req);
      const all = Object.entries(routes).map(([key, route]) => {
        const [method, path] = key.split(" ");
        const acceptsArr = Array.isArray(route.accepts) ? route.accepts : [route.accepts];
        return {
          resource: `${baseUrl}${path}`,
          type: "http",
          x402Version: 2,
          accepts: acceptsArr.map((a) => ({
            scheme: a.scheme,
            network: a.network,
            payTo: a.payTo,
            price: a.price,
          })),
          method,
          description: route.description,
        };
      });
      const total = all.length;
      const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
      const rawOffset = Number.parseInt(String(req.query.offset ?? ""), 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
      const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
      res.set("Cache-Control", "public, max-age=300");
      res.json({
        items: all.slice(offset, offset + limit),
        pagination: { limit, offset, total },
        x402Version: 2,
      });
    }
  );

  // favicon — 69 crawler/monitor misses; a tiny inline SVG answers every
  // variant (browsers accept SVG favicons; monitors just want a 200).
  router.get(["/favicon.ico", "/favicon.png", "/favicon.svg"], (_req, res) => {
    res.type("image/svg+xml");
    res.set("Cache-Control", "public, max-age=604800");
    res.send(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0E1116"/><text x="32" y="44" text-anchor="middle" font-family="Impact,sans-serif" font-size="36" fill="#22D3EE">N</text></svg>`
    );
  });

  // sitemap.xml — 71 crawler-convention misses; minimal and honest.
  router.get("/sitemap.xml", (req, res) => {
    const baseUrl = base(req);
    res.type("application/xml");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${baseUrl}/</loc></url>\n</urlset>\n`
    );
  });

  return router;
}
