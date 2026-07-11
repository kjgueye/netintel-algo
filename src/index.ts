/**
 * index.ts — the Algorand resource server.
 *
 * This is one of only two Algorand-specific source files (the other is
 * config.ts). Everything under src/routes and src/utils is a byte-identical
 * copy of NetIntel's (Base) — see src/SYNCED-FROM.txt and
 * `npm run sync:from-netintel`.
 *
 * The `routes` map below is likewise lifted verbatim from NetIntel's index.ts.
 * It needs no per-entry edits because every entry already reads through
 * pricing.* / config.network / config.payTo, and this repo's config.ts binds
 * those to Algorand env vars. So the same declarations that price and describe
 * the Base service now price and describe the Algorand one.
 *
 * The only deltas vs NetIntel are the payment rails:
 *   - @x402-avm/* instead of @x402/* + @coinbase/x402
 *   - the GoPlausible facilitator instead of the CDP one
 *   - registerExactAvmScheme (the algorand:* wildcard) instead of ExactEvmScheme
 * The seller is RECEIVE-ONLY: there is no signing key anywhere. Settlement is
 * performed by the payer's wallet and the facilitator.
 */
import express from "express";
import { HTTPFacilitatorClient, x402ResourceServer, type RouteConfig } from "@x402-avm/core/server";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { paymentMiddleware } from "@x402-avm/express";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402-avm/extensions";
import { config, pricing } from "./config.js";
import { discoveryRouter, type DiscoveryRoute } from "./discovery.js";
import { createStore } from "./paid-call-store.js";
import { createPaidCallLogger, buildPriceLookup } from "./paid-call-logger.js";
import { createMissStore } from "./miss-log-store.js";
import { createMissLogger } from "./miss-log.js";

// Catch silent crashes
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

import { dnsRouter } from "./routes/dns.js";
import { sslRouter } from "./routes/ssl.js";
import { subnetRouter } from "./routes/subnet.js";
import { redirectRouter } from "./routes/redirect.js";
import { securityHeadersRouter } from "./routes/security-headers.js";
import { emailAuthRouter } from "./routes/email-auth.js";
import { cloudFingerprintRouter } from "./routes/cloud-fingerprint.js";
import { schemaParseRouter } from "./routes/schema-parse.js";
import { classifyRouter } from "./routes/classify.js";
import { messagesRouter } from "./routes/messages.js";
import { aiImageAssetsRouter } from "./routes/ai-image-assets.js";
import { contentModerateRouter } from "./routes/content-moderate.js";
import { entityExtractRouter } from "./routes/entity-extract.js";
import { extractAddressRouter } from "./routes/extract-address.js";
import { extractContactRouter } from "./routes/extract-contact.js";
import { extractInvoiceRouter } from "./routes/extract-invoice.js";
import { extractResumeRouter } from "./routes/extract-resume.js";
import { extractTableRouter } from "./routes/extract-table.js";
import { markdownCleanRouter } from "./routes/markdown-clean.js";
import { normalizeJsonRouter } from "./routes/normalize-json.js";
import { textToJsonRouter } from "./routes/text-to-json.js";
import { sentimentRouter } from "./routes/sentiment.js";
import { textSummarizeRouter } from "./routes/text-summarize.js";
import { translateLongRouter } from "./routes/translate-long.js";
import { translateShortRouter } from "./routes/translate-short.js";
import { asnLookupRouter } from "./routes/asn-lookup.js";
import { whoisRdapRouter } from "./routes/whois-rdap.js";
import { certTransparencyRouter } from "./routes/cert-transparency.js";
import { dnsPropagationRouter } from "./routes/dns-propagation.js";
import { dnssecRouter } from "./routes/dnssec.js";
import { ipBlacklistRouter } from "./routes/ip-blacklist.js";
import { techFingerprintRouter } from "./routes/tech-fingerprint.js";
import { breachCheckRouter } from "./routes/breach-check.js";
import { domainAvailabilityRouter } from "./routes/domain-availability.js";
import { emailIntelRouter } from "./routes/email-intel.js";
import { ogScraperRouter } from "./routes/og-scraper.js";
import { pageExtractRouter } from "./routes/page-extract.js";
import { webExtractRouter } from "./routes/web-extract.js";
import { phoneIntelRouter } from "./routes/phone-intel.js";
import { robotsTxtRouter } from "./routes/robots-txt.js";
import { rssParserRouter } from "./routes/rss-parser.js";
import { usernameCheckRouter } from "./routes/username-check.js";
import { waybackRouter } from "./routes/wayback.js";
import { ipReputationRouter } from "./routes/ip-reputation.js";
import { cronParserRouter } from "./routes/cron-parser.js";
import { currencyExchangeRouter } from "./routes/currency-exchange.js";
import { convertRouter } from "./routes/convert.js";
import { moneyParseRouter } from "./routes/money-parse.js";
import { calendarIcsRouter } from "./routes/calendar-ics.js";
import { eventClassifyRouter } from "./routes/event-classify.js";
import { eventExtractRouter } from "./routes/event-extract.js";
import { githubIntelRouter } from "./routes/github-intel.js";
import { holidaysRouter } from "./routes/holidays.js";
import { ipGeoRouter } from "./routes/ip-geo.js";
import { jwtInspectorRouter } from "./routes/jwt-inspector.js";
import { langDetectRouter } from "./routes/lang-detect.js";
import { npmIntelRouter } from "./routes/npm-intel.js";
import { sitemapParserRouter } from "./routes/sitemap-parser.js";
import { urlSafetyRouter } from "./routes/url-safety.js";
import { bulkDomainRouter } from "./routes/bulk-domain.js";
import { domainAgeRouter } from "./routes/domain-age.js";
import { domainAppraiseRouter } from "./routes/domain-appraise.js";
import { domainReportRouter } from "./routes/domain-report.js";
import { ipRiskRouter } from "./routes/ip-risk.js";
import { nameGenRouter } from "./routes/name-gen.js";
import { tldPriceRouter } from "./routes/tld-price.js";
import { typosquatRouter } from "./routes/typosquat.js";
import { domainDueDiligenceRouter } from "./routes/domain-due-diligence.js";
import { domainReportFullRouter } from "./routes/domain-report-full.js";
import { emailReportFullRouter } from "./routes/email-report-full.js";
import { ipReportFullRouter } from "./routes/ip-report-full.js";
import { urlSafetyFullRouter } from "./routes/url-safety-full.js";
import { domainVendorRiskRouter } from "./routes/domain-vendor-risk.js";

// github-intel accepts the repo via query (GET) OR JSON body (POST). Both methods
// share this one paid config so pricing, description, and discovery stay identical.
const githubIntelRouteConfig = {
  accepts: [
    {
      scheme: "exact",
      price: pricing.githubIntel,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  description:
    "Fetch public metadata for any GitHub repository — stars, forks, open issues, language breakdown, license, contributors, last commit date, topics, and an activity/health score — so agents can evaluate dependencies, research projects, and assess open source health without the GitHub API complexity. Pass repo as ?repo=owner/repo (GET) or {\"repo\":\"owner/repo\"} (POST).",
  mimeType: "application/json",
  extensions: {
    ...declareDiscoveryExtension({
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "GitHub repository in owner/repo format or full GitHub URL",
          },
        },
        required: ["repo"],
      },
      input: { repo: "expressjs/express" },
      output: {
        schema: {
          type: "object",
          properties: {
            repo: { type: "string" },
            url: { type: "string" },
            description: { type: ["string", "null"] },
            homepage: { type: ["string", "null"] },
            stars: { type: "number" },
            forks: { type: "number" },
            watchers: { type: "number" },
            open_issues: { type: "number" },
            primary_language: { type: ["string", "null"] },
            languages: { type: "object", description: "Language → bytes breakdown" },
            license: { type: ["string", "null"] },
            license_spdx: { type: ["string", "null"] },
            topics: { type: "array" },
            created_at: { type: "string" },
            last_pushed_at: { type: "string" },
            days_since_last_push: { type: "number" },
            is_archived: { type: "boolean" },
            is_fork: { type: "boolean" },
            parent_repo: { type: ["string", "null"] },
            default_branch: { type: "string" },
            contributor_count: { type: "number" },
            latest_release: { type: ["string", "null"] },
            latest_release_date: { type: ["string", "null"] },
            score: { type: "number" },
            grade: { type: "string" },
            findings: { type: "array" },
          },
        },
        example: {
          repo: "expressjs/express",
          url: "https://github.com/expressjs/express",
          description: "Fast, unopinionated, minimalist web framework for node.",
          homepage: "https://expressjs.com",
          stars: 65000,
          forks: 15000,
          watchers: 65000,
          open_issues: 200,
          primary_language: "JavaScript",
          languages: { JavaScript: 543210, TypeScript: 12345 },
          license: "MIT License",
          license_spdx: "MIT",
          topics: ["nodejs", "javascript", "web", "framework"],
          created_at: "2009-06-26T18:56:01Z",
          last_pushed_at: "2024-03-10T08:00:00Z",
          days_since_last_push: 12,
          is_archived: false,
          is_fork: false,
          parent_repo: null,
          default_branch: "master",
          contributor_count: 100,
          latest_release: "v4.18.3",
          latest_release_date: "2024-02-26T14:00:00Z",
          score: 100,
          grade: "A",
          findings: [
            { rule: "active_development", deduction: 0, detail: "Pushed within last 180 days" },
          ],
        },
      },
    }),
  },
};

const routes = {
  "GET /dns/lookup": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.dnsLookup,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "DNS lookup / nslookup / dig API — resolve the common DNS record types (A, AAAA, MX, TXT, NS, CNAME, SOA, PTR) for a domain. Parses SPF/DMARC from TXT plus DKIM at the default._domainkey selector, and cross-checks A records across Google/Cloudflare/Quad9 resolvers for propagation consistency.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain name to query (e.g. example.com)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "example.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              records: { type: "object" },
              security: { type: "object" },
              propagation: { type: "object" },
            },
          },
          example: {
            domain: "example.com",
            records: {
              A: ["93.184.216.34"],
              AAAA: ["2606:2800:220:1:248:1893:25c8:1946"],
              MX: [{ priority: 10, exchange: "mail.example.com" }],
              NS: ["ns1.example.com", "ns2.example.com"],
              TXT: ["v=spf1 include:_spf.google.com ~all"],
              SOA: { mname: "ns1.example.com", rname: "admin.example.com", serial: 2024010101, refresh: 3600, retry: 900, expire: 604800, minimum: 86400 },
              CNAME: [],
              PTR: [],
            },
            security: {
              spf: { raw: "v=spf1 include:_spf.google.com ~all", version: "spf1", mechanisms: ["include:_spf.google.com"], all_qualifier: "~all" },
              dkim: { raw: "v=DKIM1; k=rsa; p=MIIBIjAN...", version: "DKIM1", key_type: "rsa", public_key: "MIIBIjAN..." },
              dmarc: { raw: "v=DMARC1; p=reject; rua=mailto:dmarc@example.com", version: "DMARC1", policy: "reject", subdomain_policy: null, pct: null, rua: "mailto:dmarc@example.com", ruf: null },
            },
            propagation: {
              resolvers: [
                { resolver: "Google", ip: "8.8.8.8", A: ["93.184.216.34"] },
                { resolver: "Cloudflare", ip: "1.1.1.1", A: ["93.184.216.34"] },
                { resolver: "Quad9", ip: "9.9.9.9", A: ["93.184.216.34"] },
              ],
              consistent: true,
            },
          },
        },
      }),
    },
  },
  "GET /ssl/analyze": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.sslAnalyze,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Performs a TLS handshake to inspect the certificate chain, probes supported TLS versions (1.0–1.3), detects weak keys and expiry issues, and returns an overall security grade (A/B/C/F).",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain to analyze (e.g. example.com)",
            },
            port: {
              type: "number",
              description: "Port to connect to (default: 443)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "example.com", port: 443 },
        output: {
          schema: {
            type: "object",
            properties: {
              host: { type: "string" },
              port: { type: "number" },
              certificate: { type: "object" },
              chain: { type: "array" },
              chain_valid: { type: "boolean" },
              connection: { type: "object" },
              warnings: { type: "array" },
              grade: { type: "string" },
            },
          },
          example: {
            host: "example.com",
            port: 443,
            certificate: {
              subject: { common_name: "example.com", organization: "Internet Corporation for Assigned Names and Numbers", organizational_unit: null, country: "US" },
              issuer: { common_name: "DigiCert TLS RSA SHA256 2020 CA1", organization: "DigiCert Inc", country: "US" },
              serial_number: "0FD078DD48F1A2BD4D0F2BA96B6038FE",
              san: ["example.com", "www.example.com"],
              key_info: { algorithm: "RSA", size: 2048 },
              not_before: "Jan 13 00:00:00 2024 GMT",
              not_after: "Feb 13 23:59:59 2025 GMT",
              signature_algorithm: "sha256WithRSAEncryption",
              version: 3,
            },
            chain: [
              { subject: "DigiCert TLS RSA SHA256 2020 CA1", issuer: "DigiCert Global Root CA", not_before: "Apr 14 00:00:00 2021 GMT", not_after: "Apr 13 23:59:59 2031 GMT" },
            ],
            chain_valid: true,
            connection: {
              protocol: "TLSv1.3",
              cipher: "TLS_AES_256_GCM_SHA384",
              supported_protocols: ["TLS 1.2", "TLS 1.3"],
            },
            warnings: [],
            grade: "A",
          },
        },
      }),
    },
  },
  "GET /redirect/trace": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.redirectTrace,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Follows a URL through its full redirect chain (up to 20 hops), recording status codes, timing, headers, TLS status, and protocol downgrades per hop, then returns an overall redirect health grade (A–F).",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "URL to trace redirects for (e.g. http://google.com)",
            },
            max_hops: {
              type: "number",
              description: "Maximum redirect hops to follow (default: 10, max: 20)",
            },
          },
          required: ["url"],
        },
        input: { url: "http://example.com", max_hops: 10 },
        output: {
          schema: {
            type: "object",
            properties: {
              chain: { type: "array" },
              final_url: { type: "string" },
              final_status_code: { type: "number" },
              total_hops: { type: "number" },
              total_timing_ms: { type: "number" },
              protocol_downgrade: { type: "boolean" },
              loop_detected: { type: "boolean" },
              flags: { type: "array" },
              grade: { type: "string" },
              score: { type: "number" },
              deductions: { type: "array" },
            },
          },
          example: {
            chain: [
              { hop: 0, url: "http://example.com/", status_code: 301, location: "https://example.com/", headers: { location: "https://example.com/", server: "nginx" }, tls: false, timing_ms: 85 },
              { hop: 1, url: "https://example.com/", status_code: 200, location: null, headers: { server: "nginx", "content-type": "text/html" }, tls: true, timing_ms: 42 },
            ],
            final_url: "https://example.com/",
            final_status_code: 200,
            total_hops: 1,
            total_timing_ms: 127,
            protocol_downgrade: false,
            loop_detected: false,
            flags: ["http_entry_point"],
            grade: "A",
            score: 95,
            deductions: [{ reason: "http_entry_point", points: -5 }],
          },
        },
      }),
    },
  },
  "GET /security-headers/analyze": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.securityHeaders,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Fetches a URL and evaluates 10 security-critical response headers (CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, X-XSS-Protection, CORP, COEP, COOP), detects anti-patterns, and returns an overall security grade (A–F).",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "URL or domain to audit security headers for (e.g. https://example.com)",
            },
          },
          required: ["target"],
        },
        input: { target: "https://example.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              service: { type: "string" },
              target: { type: "string" },
              timestamp: { type: "string" },
              grade: { type: "string" },
              score: { type: "number" },
              deductions: { type: "array" },
              results: { type: "object" },
              warnings: { type: "array" },
              errors: { type: "array" },
              meta: { type: "object" },
            },
          },
          example: {
            service: "security-headers",
            target: "https://example.com",
            timestamp: "2025-01-15T12:00:00.000Z",
            grade: "B",
            score: 78,
            deductions: [
              { reason: "Permissions-Policy not set", points: -5 },
              { reason: "Cross-Origin-Resource-Policy not set", points: -2 },
              { reason: "Cross-Origin-Embedder-Policy not set", points: -2 },
              { reason: "Cross-Origin-Opener-Policy not set", points: -2 },
              { reason: "X-Powered-By header exposes server framework", points: -3 },
            ],
            results: {
              final_url: "https://example.com/",
              status_code: 200,
              content_type: "text/html; charset=utf-8",
              summary: { pass: 6, warn: 0, fail: 0, info: 4 },
              headers: {
                "content-security-policy": { present: true, raw_value: "default-src 'self'", status: "pass", reason: "Content-Security-Policy is set with a strong policy" },
                "strict-transport-security": { present: true, raw_value: "max-age=31536000; includeSubDomains", status: "pass", reason: "HSTS enabled with max-age=31536000" },
                "x-content-type-options": { present: true, raw_value: "nosniff", status: "pass", reason: "X-Content-Type-Options is set to nosniff" },
                "x-frame-options": { present: true, raw_value: "DENY", status: "pass", reason: "X-Frame-Options is set to DENY" },
                "referrer-policy": { present: true, raw_value: "strict-origin-when-cross-origin", status: "pass", reason: "Referrer-Policy is set to strict-origin-when-cross-origin" },
                "permissions-policy": { present: false, raw_value: null, status: "warn", reason: "Permissions-Policy not set — browser features not restricted" },
                "x-xss-protection": { present: false, raw_value: null, status: "info", reason: "X-XSS-Protection not set — modern browsers use CSP instead" },
                "cross-origin-resource-policy": { present: false, raw_value: null, status: "info", reason: "Cross-Origin-Resource-Policy not set" },
                "cross-origin-embedder-policy": { present: false, raw_value: null, status: "info", reason: "Cross-Origin-Embedder-Policy not set" },
                "cross-origin-opener-policy": { present: false, raw_value: null, status: "info", reason: "Cross-Origin-Opener-Policy not set" },
              },
              anti_patterns: [
                { header: "x-powered-by", raw_value: "Express", severity: "warn", reason: "Information leakage — reveals server framework" },
              ],
            },
            warnings: [],
            errors: [],
            meta: { duration_ms: 312 },
          },
        },
      }),
    },
  },
  "POST /email-auth": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.emailAuth,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Email deliverability & domain security check — validates SPF, DKIM (multi-selector), and DMARC, detects spoofing and misconfigurations, and returns an A–F email security grade with transparent deductions. Anti-spam / anti-phishing readiness for any sending domain.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain to validate email authentication for (e.g. example.com)",
            },
            dkim_selectors: {
              type: "array",
              items: { type: "string" },
              description: "Optional list of DKIM selectors to probe (defaults to common selectors)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "example.com" },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              resolves: { type: "boolean", description: "Whether the domain has mail infrastructure (MX/A) — false adds a -100 no-mail-infrastructure deduction" },
              grade: { type: "string" },
              score: { type: "number" },
              spf: { type: "object" },
              dkim: { type: "object" },
              dmarc: { type: "object" },
              deductions: { type: "array" },
            },
          },
          example: {
            domain: "example.com",
            resolves: true,
            grade: "A",
            score: 100,
            spf: {
              found: true,
              record: "v=spf1 include:_spf.google.com -all",
              mechanisms: ["include:_spf.google.com"],
              all_qualifier: "-all",
              dns_lookup_count: 1,
              issues: [],
            },
            dkim: {
              found: true,
              selectors_checked: ["default", "google"],
              records: [
                { selector: "google", record: "v=DKIM1; k=rsa; p=MIIBIjAN...", key_type: "rsa", key_length_bits: 2048, issues: [] },
              ],
              issues: [],
            },
            dmarc: {
              found: true,
              record: "v=DMARC1; p=reject; rua=mailto:dmarc@example.com; ruf=mailto:forensic@example.com",
              policy: "reject",
              subdomain_policy: null,
              pct: 100,
              rua: ["mailto:dmarc@example.com"],
              ruf: ["mailto:forensic@example.com"],
              issues: [],
            },
            deductions: [],
          },
        },
      }),
    },
  },
  "GET /cloud-fingerprint/analyze": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.cloudFingerprint,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Fingerprints a domain's cloud infrastructure by probing DNS records, HTTP headers, and PTR lookups to detect CDN, WAF, hosting, DNS provider, and email provider with confidence scores and an infrastructure security grade (A–F).",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain to fingerprint (e.g. example.com)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "cloudflare.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              resolved_ips: { type: "array" },
              cname_chain: { type: "array" },
              hosting: { type: "object" },
              cdn: { type: "object" },
              waf: { type: "array" },
              dns_provider: { type: "object" },
              email_provider: { type: "object" },
              http_fingerprint: { type: "object" },
              tls: { type: "object" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            domain: "cloudflare.com",
            resolved_ips: ["104.16.133.229", "104.16.132.229"],
            cname_chain: [],
            hosting: { provider: "Cloudflare", confidence: "medium", signals: ["cf-ray header present"] },
            cdn: { provider: "Cloudflare", confidence: "medium", signals: ["cf-ray header present"] },
            waf: [{ provider: "Cloudflare WAF", confidence: "medium", signals: ["cf-ray header present"] }],
            dns_provider: { provider: "Cloudflare DNS", confidence: "high", signals: ["NS ns3.cloudflare.com contains cloudflare.com"] },
            email_provider: { provider: null, confidence: null, signals: [] },
            http_fingerprint: {
              https_enforced: true,
              server_header: "cloudflare",
              server_version_exposed: false,
              x_powered_by: null,
              notable_headers: ["cf-ray"],
            },
            tls: { issuer: null, wildcard: null, san_count: null },
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /schema-parse/extract": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.schemaParse,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Extract structured data from any unstructured text into your own JSON Schema — structured-data / information extraction, text-to-JSON, LLM data enrichment. You supply the schema; the LLM returns a matching object. Works for contacts, invoices, events, product specs, medical records, legal clauses, resumes — any shape. Returns the extracted object plus token usage; unfound fields are omitted or null.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            raw_text: {
              type: "string",
              description:
                "Unstructured text to extract data from — emails, resumes, articles, log entries, contracts, support tickets, etc.",
            },
            target_schema: {
              type: "object",
              description:
                "A standard JSON Schema object with type, properties, and optionally required. Defines the shape of the extracted output.",
            },
          },
          required: ["raw_text", "target_schema"],
        },
        input: { raw_text: "Hi I'm Sarah Chen, VP of Engineering at Acme Corp. Reach me at sarah.chen@acme.com or 555-867-5309.", target_schema: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, company: { type: "string" }, role: { type: "string" } }, required: ["name", "email"] } },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              extracted: {
                type: "object",
                description:
                  "Structured data conforming to the caller's target_schema. Missing fields are omitted or null.",
              },
              tokens_used: {
                type: "object",
                description: "LLM token consumption for this extraction",
                properties: {
                  input: { type: "number", description: "Prompt tokens consumed" },
                  output: { type: "number", description: "Completion tokens consumed" },
                },
              },
            },
          },
          example: {
            extracted: {
              name: "Sarah Chen",
              email: "sarah.chen@acme.com",
              phone: "555-867-5309",
              company: "Acme Corp",
              role: "VP of Engineering",
            },
            tokens_used: {
              input: 312,
              output: 48,
            },
          },
        },
      }),
    },
  },
  "POST /messages": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.messages,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "OpenAI-compatible chat completions over x402, answered by Claude Sonnet 4.6 — send a messages array and get an assistant reply for Q&A, reasoning, agent planning, coding help, summarization, extraction, and classification. Body is OpenAI chat.completions-shaped ({model?, messages:[{role,content}], max_tokens?, temperature?}); response is a chat.completion object. Flat $0.06; inputs capped ~6KB, max_tokens 1024; no streaming in v1.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            model: {
              type: "string",
              description:
                "Model to use. Supported: claude-sonnet-4-6 (aliases: balanced, sonnet). Optional — defaults to claude-sonnet-4-6.",
            },
            messages: {
              type: "array",
              description:
                "Chat messages in OpenAI format. Each item is {role: 'system'|'user'|'assistant', content: string}. System messages are applied as the system prompt.",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", description: "system, user, or assistant" },
                  content: { type: "string", description: "Message text" },
                },
                required: ["role", "content"],
              },
            },
            max_tokens: {
              type: "number",
              description: "Maximum output tokens. Optional — defaults to 1024, capped at 1024.",
            },
            temperature: {
              type: "number",
              description: "Sampling temperature (0–1). Optional.",
            },
            top_p: {
              type: "number",
              description: "Nucleus sampling (0–1). Optional; ignored if temperature is set.",
            },
          },
          required: ["messages"],
        },
        input: {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "What is the capital of France?" }],
          max_tokens: 256,
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              id: { type: "string" },
              object: { type: "string", description: "Always 'chat.completion'" },
              created: { type: "number", description: "Unix timestamp (seconds)" },
              model: { type: "string" },
              choices: {
                type: "array",
                description:
                  "One choice with the assistant message and a finish_reason (stop/length/content_filter/tool_calls).",
              },
              usage: {
                type: "object",
                description: "prompt_tokens, completion_tokens, total_tokens",
              },
            },
          },
          example: {
            id: "chatcmpl-abc123",
            object: "chat.completion",
            created: 1735689600,
            model: "claude-sonnet-4-6",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "The capital of France is Paris." },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 14, completion_tokens: 8, total_tokens: 22 },
          },
        },
      }),
    },
  },
  "POST /ai-image/generate": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.aiImageAssets,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    // NOTE: keep this discovery blob SMALL. The x402 client echoes `extensions`
    // into the paymentPayload it sends to the CDP facilitator /verify, which
    // schema-validates (and size-limits) the payload — an oversized blob makes
    // verify reject every payment with "paymentPayload invalid". Keep terse.
    description:
      "Generate agent-ready image assets (icons, logos, social graphics, thumbnails, banners) with gpt-image-1. Claude refines the prompt, screens content, adds alt text and a score. Returns image_url as a base64 PNG data URI. Flat $0.25; n=1; ratios 1:1/16:9/9:16.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "What to create (3-2000 chars)." },
            use_case: { type: "string", description: "One of: app_icon, logo, banner, avatar, social_graphic, og_image, blog_thumbnail, product_mockup, illustration, web_image (default). Unknown values fall back to web_image with a warning." },
            aspect_ratio: { type: "string", description: "1:1, 16:9, or 9:16 (aliases like square/wide/tall accepted)." },
            style: { type: "string", description: "Optional art direction." },
            brand_colors: { type: "array", items: { type: "string" }, description: "Optional palette." },
            provider: { type: "string", description: "Optional image backend override; unknown values 400." },
            n: { type: "number", description: "Image count — currently clamped to 1." },
          },
          required: ["prompt"],
        },
        input: { prompt: "clean modern app icon for a network intelligence API", use_case: "app_icon", aspect_ratio: "1:1" },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              image_url: { type: "string" },
              revised_prompt: { type: "string" },
              alt_text: { type: "string" },
              score: { type: "number" },
              grade: { type: "string" },
            },
          },
          example: { image_url: "data:image/png;base64,...", revised_prompt: "A clean app icon...", alt_text: "App icon.", score: 92, grade: "A" },
        },
      }),
    },
  },
  "POST /classify": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.classify,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Text classification API — zero-shot text classifier / categorization: caller supplies 2–20 labels and Claude Haiku returns the best-matching category with confidence and per-label scores. Route, tag, triage, and detect intent/topic with your own taxonomy in one call.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The text to classify — a support ticket, email, message, document snippet, etc. Max 10000 words or 50KB.",
            },
            labels: {
              type: "array",
              items: { type: "string" },
              description:
                "2-20 candidate category labels to classify the text into. The chosen label(s) are always drawn from this set.",
            },
            multi_label: {
              type: "boolean",
              description:
                "If true, allow multiple matching labels and return a labels array. Defaults to false (single best label).",
            },
          },
          required: ["text", "labels"],
        },
        input: {
          text: "Hi, I was charged twice for my subscription this month and need a refund.",
          labels: ["billing", "technical", "general"],
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              mode: { type: "string", description: "single_label or multi_label" },
              label: { type: "string", description: "Best matching label (single-label mode)" },
              labels: {
                type: "array",
                items: { type: "string" },
                description: "Matching labels (multi-label mode)",
              },
              confidence: { type: "number", description: "Confidence for the chosen label (single-label mode)" },
              scores: {
                type: "object",
                description: "Per-label relevance scores (0-1) for every provided label",
              },
              labels_provided: {
                type: "array",
                items: { type: "string" },
                description: "Echo of the candidate labels supplied by the caller",
              },
              score: { type: "number", description: "Quality score 0-100" },
              grade: { type: "string", description: "Letter grade A-F" },
              findings: {
                type: "array",
                items: { type: "string" },
                description: "Informational findings (e.g. low_confidence)",
              },
            },
          },
          example: {
            mode: "single_label",
            label: "billing",
            confidence: 0.91,
            scores: { billing: 0.91, technical: 0.06, general: 0.03 },
            labels_provided: ["billing", "technical", "general"],
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /content-moderate": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.contentModerate,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Moderate text content using Claude Haiku — flags categories like harassment, hate, sexual content, violence, self-harm, and spam with per-category severity and an overall allow/flag/block recommendation, so agents can screen user-generated content before publishing or storing it.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The text to moderate — a comment, message, post, review, or any user-generated content. Max 10000 words or 50KB.",
            },
          },
          required: ["text"],
        },
        input: {
          text: "I will find where you live and make you regret ever posting that.",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              categories: {
                type: "object",
                description:
                  "Per-category verdicts (harassment, hate, sexual, violence, self_harm, spam), each with flagged (boolean) and severity (none/low/medium/high)",
              },
              flagged_categories: {
                type: "array",
                items: { type: "string" },
                description: "Category names where flagged=true",
              },
              overall: {
                type: "string",
                description: "Overall recommendation: allow, flag, or block",
              },
              reasoning: { type: "string", description: "One-sentence rationale for the verdict" },
              score: { type: "number", description: "Content cleanliness score 0-100 (allow=100, flag=70, block=20)" },
              grade: { type: "string", description: "Letter grade A-F derived from the score" },
              findings: {
                type: "array",
                items: { type: "object" },
                description: "One entry per flagged category with its severity",
              },
            },
          },
          example: {
            categories: {
              harassment: { flagged: true, severity: "high" },
              hate: { flagged: false, severity: "none" },
              sexual: { flagged: false, severity: "none" },
              violence: { flagged: true, severity: "medium" },
              self_harm: { flagged: false, severity: "none" },
              spam: { flagged: false, severity: "none" },
            },
            flagged_categories: ["harassment", "violence"],
            overall: "block",
            reasoning: "Contains a direct threat of physical harm targeting the recipient.",
            score: 20,
            grade: "F",
            findings: [
              { category: "harassment", severity: "high" },
              { category: "violence", severity: "medium" },
            ],
          },
        },
      }),
    },
  },
  "POST /entity-extract": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.entityExtract,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Extract named entities from text using Claude Haiku — people, organizations, locations, dates, emails, URLs, money amounts, and products — returned as structured typed arrays so agents can pull structured signals out of unstructured text in one call.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The text to extract named entities from — an article, email, document, or any unstructured text. Max 10000 words or 50KB.",
            },
            types: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional subset of entity types to extract: person, organization, location, date, email, url, money, product, phone. Defaults to all types.",
            },
          },
          required: ["text"],
        },
        input: {
          text: "Jane Doe and John Smith from Acme Corp met in San Francisco on 2024-03-15 to discuss WidgetPro. Contact jane@acme.com or visit https://acme.com — the deal was worth $1.2M.",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              entities: {
                type: "object",
                description:
                  "Per-type arrays of unique entity strings as they appear in the text. Only requested types appear when the types param is supplied.",
              },
              total_entities: {
                type: "number",
                description: "Total count across all entity arrays",
              },
              types_extracted: {
                type: "array",
                items: { type: "string" },
                description: "The entity types included in this response",
              },
              score: { type: "number", description: "Quality score 0-100" },
              grade: { type: "string", description: "Letter grade A-F" },
              findings: {
                type: "array",
                items: { type: "object" },
                description: "Informational findings (e.g. extraction errors)",
              },
            },
          },
          example: {
            entities: {
              person: ["Jane Doe", "John Smith"],
              organization: ["Acme Corp"],
              location: ["San Francisco"],
              date: ["2024-03-15"],
              email: ["jane@acme.com"],
              url: ["https://acme.com"],
              money: ["$1.2M"],
              product: ["WidgetPro"],
              phone: [],
            },
            total_entities: 9,
            types_extracted: ["person", "organization", "location", "date", "email", "url", "money", "product", "phone"],
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /extract/address": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.extractAddress,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Parse and normalize a freeform address string using Claude Haiku — splits it into street, city, state/region, postal code, and country, plus a normalized single-line form, so agents can clean and standardize messy address data for shipping, CRM, and verification workflows.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            address: {
              type: "string",
              description:
                "The freeform address string to parse and normalize. Max 10000 words or 50KB.",
            },
          },
          required: ["address"],
        },
        input: {
          address: "123 Main St, San Francisco, CA 94105, USA",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              address: {
                type: "object",
                description:
                  "Parsed components: street, city, state_region, postal_code, country, country_code (ISO 3166-1 alpha-2), and a normalized single-line form. Missing components are null.",
              },
              components_found: {
                type: "number",
                description:
                  "Count of non-null core components (street, city, state_region, postal_code, country).",
              },
              is_complete: {
                type: "boolean",
                description: "True when street, city, and country are all present.",
              },
              cached: { type: "boolean", description: "True if served from the in-memory cache." },
              score: { type: "number", description: "Quality score 0-100" },
              grade: { type: "string", description: "Letter grade A-F" },
              findings: {
                type: "array",
                items: { type: "string" },
                description: "Informational findings (e.g. incomplete_address, no_components).",
              },
            },
          },
          example: {
            address: {
              street: "123 Main St",
              city: "San Francisco",
              state_region: "CA",
              postal_code: "94105",
              country: "United States",
              country_code: "US",
              normalized: "123 Main St, San Francisco, CA 94105, United States",
            },
            components_found: 5,
            is_complete: true,
            cached: false,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /extract/contact": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.extractContact,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Extract structured contact details from text, an email signature, or webpage text using Claude Haiku — returns name, title, company, email, phone, and address as clean JSON so agents can turn unstructured contact blocks into CRM-ready records in one call.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The text to extract contact details from — free text, an email signature, or webpage text. Max 10000 words or 50KB.",
            },
          },
          required: ["text"],
        },
        input: {
          text: "Jane Doe\nVP of Engineering, Acme Corp\njane@acme.com | +1 555 867 5309\n123 Main St, San Francisco, CA 94105",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              contact: {
                type: "object",
                description:
                  "Parsed contact fields: name, title, company, email, phone, address. Missing fields are null.",
              },
              fields_found: {
                type: "number",
                description: "Count of non-null contact fields.",
              },
              cached: { type: "boolean", description: "True if served from the in-memory cache." },
              score: { type: "number", description: "Quality score 0-100" },
              grade: { type: "string", description: "Letter grade A-F" },
              findings: {
                type: "array",
                items: { type: "string" },
                description: "Informational findings (e.g. no_fields_found).",
              },
            },
          },
          example: {
            contact: {
              name: "Jane Doe",
              title: "VP of Engineering",
              company: "Acme Corp",
              email: "jane@acme.com",
              phone: "+1 555 867 5309",
              address: "123 Main St, San Francisco, CA 94105",
            },
            fields_found: 6,
            cached: false,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /extract/invoice": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.extractInvoice,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Extract structured data from invoice or receipt text — or directly from an invoice URL (PDF, HTML, or plain text, fetched and parsed server-side) — using Claude Haiku: returns vendor, invoice number, dates, line items, subtotal, tax, total, and currency as clean JSON for accounts-payable, expense processing, and bookkeeping automation.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The invoice or receipt content ITSELF (email body, OCR dump, pasted PDF text) — not an instruction or question about an invoice. Have only a link? Pass url instead. Text with no extractable invoice data returns an uncharged 400 (NO_INVOICE_CONTENT). Max 10000 words or 50KB.",
            },
            url: {
              type: "string",
              description:
                "Publicly reachable invoice URL — PDF, HTML, or plain text; fetched and parsed server-side (e.g. https://vendor.example/invoice-42.pdf). Provide exactly one of text or url.",
            },
          },
        },
        input: {
          text: "Acme Supplies Inc\nInvoice INV-2024-0142\nDate: 2024-03-01  Due: 2024-03-31\nWidget A  10 x $5.00 = $50.00\nShipping  1 x $12.00 = $12.00\nSubtotal: $62.00\nTax: $5.58\nTotal: $67.58 USD",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              invoice: {
                type: "object",
                description:
                  "Parsed invoice fields: vendor, invoice_number, invoice_date, due_date, line_items (array of {description, quantity, unit_price, amount}), subtotal, tax, total, currency. Missing fields are null.",
              },
              line_item_count: {
                type: "number",
                description: "Number of line items extracted.",
              },
              totals_reconcile: {
                type: ["boolean", "null"],
                description:
                  "True if sum(line_items.amount) + tax ≈ total (within $0.02). False if they do not reconcile. Null if total or subtotal is missing.",
              },
              cached: { type: "boolean", description: "True if served from the in-memory cache." },
              score: { type: "number", description: "Quality score 0-100" },
              grade: { type: "string", description: "Letter grade A-F" },
              findings: {
                type: "array",
                items: { type: "string" },
                description: "Informational findings (e.g. no_total_found, totals_mismatch).",
              },
              source: {
                type: "object",
                description:
                  "Where the invoice content came from. type is \"text\" or \"url\"; url and content_type (pdf | html | text) are null in text mode.",
                properties: {
                  type: { type: "string" },
                  url: { type: ["string", "null"] },
                  content_type: { type: ["string", "null"] },
                },
              },
            },
          },
          example: {
            invoice: {
              vendor: "Acme Supplies Inc",
              invoice_number: "INV-2024-0142",
              invoice_date: "2024-03-01",
              due_date: "2024-03-31",
              line_items: [
                { description: "Widget A", quantity: 10, unit_price: 5.0, amount: 50.0 },
                { description: "Shipping", quantity: 1, unit_price: 12.0, amount: 12.0 },
              ],
              subtotal: 62.0,
              tax: 5.58,
              total: 67.58,
              currency: "USD",
            },
            line_item_count: 2,
            totals_reconcile: true,
            cached: false,
            score: 100,
            grade: "A",
            findings: [],
            source: { type: "text", url: null, content_type: null },
          },
        },
      }),
    },
  },
  "POST /extract/resume": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.extractResume,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Extract structured data from resume/CV text using Claude Haiku — returns name, contact info, skills, work experience, and education as clean JSON arrays so agents can automate applicant screening, candidate databases, and recruiting workflows from raw resume text.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The resume or CV text to extract structured data from. Max 10000 words or 50KB.",
            },
          },
          required: ["text"],
        },
        input: {
          text: "Jane Doe\nSan Francisco, CA | jane@example.com | +1 555 867 5309 | linkedin.com/in/janedoe\n\nSummary: Senior engineer with 10 years experience.\n\nSkills: Python, TypeScript, Kubernetes\n\nExperience:\nStaff Engineer, Acme Corp (2020-present) — Led platform team\n\nEducation:\nBS Computer Science, UC Berkeley, 2014",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              resume: {
                type: "object",
                description:
                  "Parsed resume fields: name, contact ({email, phone, location, links}), summary, skills (array), experience (array of {title, company, start, end, description}), education (array of {degree, institution, year}). Missing scalar fields are null; arrays are empty when nothing is found.",
              },
              skills_count: {
                type: "number",
                description: "Number of skills extracted.",
              },
              experience_count: {
                type: "number",
                description: "Number of work-experience entries extracted.",
              },
              education_count: {
                type: "number",
                description: "Number of education entries extracted.",
              },
              cached: { type: "boolean", description: "True if served from the in-memory cache." },
              score: { type: "number", description: "Quality score 0-100" },
              grade: { type: "string", description: "Letter grade A-F" },
              findings: {
                type: "array",
                items: { type: "string" },
                description: "Informational findings (e.g. no_experience, no_skills, no_name).",
              },
            },
          },
          example: {
            resume: {
              name: "Jane Doe",
              contact: {
                email: "jane@example.com",
                phone: "+1 555 867 5309",
                location: "San Francisco, CA",
                links: ["https://linkedin.com/in/janedoe"],
              },
              summary: "Senior engineer with 10 years experience...",
              skills: ["Python", "TypeScript", "Kubernetes"],
              experience: [
                {
                  title: "Staff Engineer",
                  company: "Acme Corp",
                  start: "2020",
                  end: "present",
                  description: "Led platform team",
                },
              ],
              education: [
                { degree: "BS Computer Science", institution: "UC Berkeley", year: "2014" },
              ],
            },
            skills_count: 3,
            experience_count: 1,
            education_count: 1,
            cached: false,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /extract/table": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.extractTable,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Extract tabular data from messy text or HTML using Claude Haiku — detects columns and rows in unstructured content and returns clean structured JSON (columns + rows) so agents can turn pasted tables, HTML tables, and delimited text into usable data in one call.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The messy text or HTML containing tabular data to extract. Max 10000 words or 50KB. Aliases also accepted: content, html, csv, table, markdown, data.",
            },
          },
          required: ["text"],
        },
        input: {
          text: "product | price | qty\nWidget A | 5.00 | 10\nWidget B | 7.50 | 4",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              table: {
                type: "object",
                description:
                  "Parsed table: columns (array of column names), rows (array of objects keyed by column name), and row_count (number of rows). Empty columns/rows with row_count 0 when no tabular structure is detected.",
              },
              column_count: {
                type: "number",
                description: "Number of columns detected.",
              },
              cached: { type: "boolean", description: "True if served from the in-memory cache." },
              score: { type: "number", description: "Quality score 0-100" },
              grade: { type: "string", description: "Letter grade A-F" },
              findings: {
                type: "array",
                items: { type: "string" },
                description: "Informational findings (e.g. no_table_found, count_mismatch).",
              },
            },
          },
          example: {
            table: {
              columns: ["product", "price", "qty"],
              rows: [
                { product: "Widget A", price: "5.00", qty: "10" },
                { product: "Widget B", price: "7.50", qty: "4" },
              ],
              row_count: 2,
            },
            column_count: 3,
            cached: false,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /markdown/clean": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.markdownClean,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Convert messy HTML or text into clean, well-structured Markdown using Claude Haiku — strips boilerplate, fixes heading hierarchy, normalizes lists and links, and returns readable Markdown so agents can feed clean docs into downstream pipelines, knowledge bases, or LLM context.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The messy HTML or text to convert into clean Markdown. Max 10000 words or 50KB. Aliases also accepted: html, content, markdown, input.",
            },
          },
          required: ["text"],
        },
        input: {
          text: "<nav>Home About</nav><h1>Welcome</h1><p>Hello <a href=\"https://example.com\">world</a>.</p><footer>© 2024</footer>",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              markdown: {
                type: "string",
                description: "The cleaned, well-structured GitHub-flavored Markdown.",
              },
              input_chars: { type: "number", description: "Character count of the input." },
              output_chars: {
                type: "number",
                description: "Character count of the cleaned markdown.",
              },
              reduction_ratio: {
                type: "number",
                description:
                  "1 - (output_chars / input_chars), rounded to 2dp — how much boilerplate was stripped (informational).",
              },
              cached: { type: "boolean", description: "True if served from the in-memory cache." },
              score: { type: "number", description: "Quality score 0-100" },
              grade: { type: "string", description: "Letter grade A-F" },
              findings: {
                type: "array",
                items: { type: "string" },
                description: "Informational findings (e.g. empty_output).",
              },
            },
          },
          example: {
            markdown: "# Welcome\n\nHello [world](https://example.com).\n",
            input_chars: 108,
            output_chars: 39,
            reduction_ratio: 0.64,
            cached: false,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /normalize/json": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.normalizeJson,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Conform messy or inconsistent JSON to a target schema using Claude Haiku — renames keys, coerces types (string→number, \"true\"→boolean, etc.), and fills missing fields with null, returning JSON that matches the exact shape the caller specified so agents can normalize data from varied sources into one consistent structure.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            data: {
              type: ["string", "object"],
              description:
                "The messy JSON to normalize — a JSON string or an already-parsed object. Max 10000 words or 50KB.",
            },
            schema: {
              type: "object",
              description:
                "A map of field name → type token. Supported tokens: string, number, boolean, date, string[], number[], object. Max 50 fields. Output keys are forced to exactly these field names.",
            },
          },
          required: ["data", "schema"],
        },
        input: {
          data: { fullName: "Jane Doe", age: "42", active: "yes", tags: "vip,beta", signup: "March 1 2024" },
          schema: {
            full_name: "string",
            age: "number",
            is_active: "boolean",
            tags: "string[]",
            signup_date: "date",
          },
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              normalized: {
                type: "object",
                description:
                  "The input conformed to the target schema: keys are exactly the schema field names, values coerced to the declared types, missing fields null.",
              },
              fields_in_schema: { type: "number", description: "Number of fields in the target schema." },
              fields_populated: { type: "number", description: "Number of non-null fields in the output." },
              fields_nulled: { type: "number", description: "Number of null fields in the output." },
              schema_match: {
                type: "boolean",
                description:
                  "True when the model's output keys were exactly the schema field names. False when code had to force-conform (strip extra / add missing) keys.",
              },
              cached: { type: "boolean", description: "True if served from the in-memory cache." },
              score: { type: "number", description: "Quality score 0-100." },
              grade: { type: "string", description: "Letter grade A-F." },
              findings: {
                type: "array",
                items: { type: "string" },
                description: "Informational findings (e.g. schema_mismatch_corrected, mostly_nulled).",
              },
            },
          },
          example: {
            normalized: {
              full_name: "Jane Doe",
              age: 42,
              is_active: true,
              tags: ["vip", "beta"],
              signup_date: "2024-03-01",
            },
            fields_in_schema: 5,
            fields_populated: 5,
            fields_nulled: 0,
            schema_match: true,
            cached: false,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /text-to-json": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.textToJson,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Turn unstructured text into structured JSON matching a caller-supplied schema using Claude Haiku — the agent declares the fields and types it wants, and gets back populated JSON with values pulled from the text and coerced to the right types, so agents can structure any prose into the exact shape their pipeline expects.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The unstructured prose to extract structured data from. Max 10000 words or 50KB.",
            },
            schema: {
              type: "object",
              description:
                "A map of field name → type token. Supported tokens: string, number, boolean, date, string[], number[], object. Max 50 fields. Each field is extracted from the text as the declared type; output keys are forced to exactly these field names.",
            },
          },
          required: ["text", "schema"],
        },
        input: {
          text: "Acme Corp is a privately held software company founded in 2010. The San Francisco-based firm, which also has an office in London, now employs roughly 250 people.",
          schema: {
            company: "string",
            founded_year: "number",
            employees: "number",
            is_public: "boolean",
            locations: "string[]",
          },
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              result: {
                type: "object",
                description:
                  "The extracted data: keys are exactly the schema field names, values pulled from the text and cast to the declared types, unfindable fields null.",
              },
              fields_in_schema: { type: "number", description: "Number of fields in the schema." },
              fields_populated: { type: "number", description: "Number of non-null fields in the output." },
              fields_nulled: { type: "number", description: "Number of null fields in the output." },
              schema_match: {
                type: "boolean",
                description:
                  "True when the model's output keys were exactly the schema field names. False when code had to force-conform (strip extra / add missing) keys.",
              },
              cached: { type: "boolean", description: "True if served from the in-memory cache." },
              score: { type: "number", description: "Quality score 0-100." },
              grade: { type: "string", description: "Letter grade A-F." },
              findings: {
                type: "array",
                items: { type: "string" },
                description: "Informational findings (e.g. schema_mismatch_corrected, mostly_nulled).",
              },
            },
          },
          example: {
            result: {
              company: "Acme Corp",
              founded_year: 2010,
              employees: 250,
              is_public: false,
              locations: ["San Francisco", "London"],
            },
            fields_in_schema: 5,
            fields_populated: 5,
            fields_nulled: 0,
            schema_match: true,
            cached: false,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /sentiment/analyze": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.sentiment,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Sentiment analysis API — analyze sentiment of text and get a text sentiment score in one call: classifies positive / negative / neutral / mixed polarity with a -1 to +1 sentiment score, plus emotion detection in text (joy, anger, sadness, fear, surprise, disgust, trust, anticipation). Aspect-based sentiment and opinion mining for customer feedback analysis — analyze reviews, support tickets, social posts, chat messages. Via Claude Haiku.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The text to analyze sentiment for — a review, message, feedback, or any natural-language text. Max 10000 words or 50KB.",
            },
            aspects: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional list of up to 10 aspects for aspect-based sentiment (e.g. [\"price\", \"service\", \"quality\"]). When provided, sentiment toward each named aspect is also returned.",
            },
          },
          required: ["text"],
        },
        input: {
          text: "The food was absolutely delicious and the staff were so friendly, but the prices were a bit steep.",
          aspects: ["food", "service", "price"],
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              polarity: {
                type: "string",
                description: "Overall sentiment: positive, negative, neutral, or mixed",
              },
              score: {
                type: "number",
                description: "Sentiment polarity score from -1.0 (very negative) to 1.0 (very positive)",
              },
              confidence: { type: "number", description: "Model confidence 0.0-1.0" },
              emotions: {
                type: "array",
                items: { type: "string" },
                description:
                  "Detected emotions drawn from joy, anger, sadness, fear, surprise, disgust, trust, anticipation",
              },
              aspects: {
                type: "object",
                description:
                  "Per-aspect sentiment (present only when the aspects param was supplied); each aspect maps to { polarity, score }",
              },
              service_score: {
                type: "number",
                description: "Endpoint health score 0-100 (100 on success) — distinct from the sentiment score",
              },
              grade: { type: "string", description: "Letter grade A-F derived from service_score" },
              findings: {
                type: "array",
                description: "Reserved — currently always [] on success (analysis errors surface as 502s, never findings)",
              },
            },
          },
          example: {
            polarity: "mixed",
            score: 0.2,
            confidence: 0.86,
            emotions: ["joy", "trust"],
            aspects: {
              food: { polarity: "positive", score: 0.9 },
              service: { polarity: "positive", score: 0.8 },
              price: { polarity: "negative", score: -0.4 },
            },
            service_score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /text-summarize": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.textSummarize,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Text summarizer / summarization API — condense text, Markdown, or a URL into a TL;DR plus key bullet points using Claude Haiku. Accepts raw text or a URL (fetched and extracted), enforces an input cap, and returns a clean structured summary so agents can compress documents and articles in one call.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "Raw text to summarize. Provide exactly one of text or url. Max 10000 words or 50KB.",
            },
            url: {
              type: "string",
              description:
                "URL to fetch, extract readable text from, and summarize. Provide exactly one of text or url. The page must yield ≥50 words of extractable paragraph text (fetch capped at 500KB/10s) — thin or JS-rendered pages 400 without charging.",
            },
            max_points: {
              type: "number",
              description:
                "Number of key bullet points to return (default 5, max 10).",
            },
          },
        },
        input: {
          text: "The James Webb Space Telescope has captured its deepest infrared image of the universe to date, revealing thousands of galaxies in a tiny patch of sky. The image, known as Webb's First Deep Field, shows galaxy cluster SMACS 0723 as it appeared 4.6 billion years ago. The combined mass of this cluster acts as a gravitational lens, magnifying far more distant galaxies behind it. Astronomers say the image will help them understand galaxy formation in the early universe.",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              source: { type: "string", description: "text or url" },
              summary: { type: "string", description: "Concise 2-4 sentence summary" },
              key_points: {
                type: "array",
                items: { type: "string" },
                description: "Key bullet points extracted from the content",
              },
              original_word_count: { type: "number", description: "Word count of the input content" },
              summary_word_count: { type: "number", description: "Word count of the generated summary" },
              compression_ratio: {
                type: "number",
                description: "summary_word_count / original_word_count, rounded to 2 decimals",
              },
              score: { type: "number", description: "Quality score 0-100" },
              grade: { type: "string", description: "Letter grade A-F" },
              findings: {
                type: "array",
                description: "Reserved — currently always [] on success",
              },
            },
          },
          example: {
            source: "text",
            summary:
              "The James Webb Space Telescope captured its deepest infrared image yet, revealing thousands of galaxies. Known as Webb's First Deep Field, it shows galaxy cluster SMACS 0723 acting as a gravitational lens to magnify far more distant galaxies. The image will help astronomers study galaxy formation in the early universe.",
            key_points: [
              "Webb captured its deepest infrared image to date",
              "The image shows galaxy cluster SMACS 0723 as it appeared 4.6 billion years ago",
              "The cluster's mass acts as a gravitational lens magnifying distant galaxies",
              "It will aid the study of early-universe galaxy formation",
            ],
            original_word_count: 78,
            summary_word_count: 52,
            compression_ratio: 0.67,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /translate/long": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.translateLong,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Translate up to 2000 words between languages using Claude Haiku — auto-detects source, supports 30+ target languages, preserves formatting, for larger documents and articles. For short snippets use the cheaper /translate/short.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The text to translate. Max 2000 words (and 50KB). For shorter snippets use the cheaper /translate/short. Aliases also accepted: q, input, content, message.",
            },
            target: {
              type: "string",
              description:
                "Target language as an ISO 639-1 code (e.g. \"de\") or English name (e.g. \"German\"). 30+ languages mapped directly; other values (endonyms, qualified names like \"Brazilian Portuguese\") are interpreted by the model with a targetHint finding. Required. Aliases also accepted: target_lang, target_language, to, lang, targetLanguage. (The response returns this as target_language.)",
            },
            source: {
              type: "string",
              description:
                "Optional source language (ISO 639-1 code or English name). When omitted, the source language is auto-detected. Aliases also accepted: source_language, from.",
            },
          },
          required: ["text", "target"],
        },
        input: {
          text: "The James Webb Space Telescope has captured its deepest infrared image of the universe to date, revealing thousands of galaxies in a tiny patch of sky.",
          target: "de",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              translation: { type: "string", description: "The translated text, formatting preserved" },
              source_language: {
                type: "string",
                description: "ISO 639-1 code of the source language (detected or supplied)",
              },
              target_language: { type: "string", description: "ISO 639-1 code of the target language" },
              source_detected: {
                type: "boolean",
                description: "true when the source language was auto-detected; false when supplied by the caller",
              },
              word_count: { type: "number", description: "Word count of the input text" },
              tier: { type: "string", description: "Pricing tier — always \"long\" for this endpoint" },
              service_score: { type: "number", description: "Endpoint health score 0-100 (100 on success)" },
              grade: { type: "string", description: "Letter grade A-F derived from service_score" },
              findings: {
                type: "array",
                description: "Plain-string hints — e.g. a targetHint string when the target language was model-interpreted",
              },
            },
          },
          example: {
            translation:
              "Das James-Webb-Weltraumteleskop hat sein bisher tiefstes Infrarotbild des Universums aufgenommen und Tausende von Galaxien in einem winzigen Himmelsausschnitt enthüllt.",
            source_language: "en",
            target_language: "de",
            source_detected: true,
            word_count: 26,
            tier: "long",
            service_score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /translate/short": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.translateShort,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Translate text between languages — text translation API for short content: translate a sentence, chat message, or up to 500 words to English, Spanish, French, Chinese, or any of 30+ languages. Language translation with auto-detected source language, formatting preserved; returns the translation plus detected source. Machine translation via Claude Haiku for agents localizing content cheaply. For longer documents use /translate/long.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The text to translate. Max 500 words (and 50KB). For longer documents use /translate/long. Aliases also accepted: q, input, content, message.",
            },
            target: {
              type: "string",
              description:
                "Target language as an ISO 639-1 code (e.g. \"fr\") or English name (e.g. \"French\"). 30+ languages mapped directly; other values (endonyms, qualified names) are interpreted by the model with a targetHint finding. Required. Aliases also accepted: target_lang, target_language, to, lang, targetLanguage. (The response returns this as target_language.)",
            },
            source: {
              type: "string",
              description:
                "Optional source language (ISO 639-1 code or English name). When omitted, the source language is auto-detected. Aliases also accepted: source_language, from.",
            },
          },
          required: ["text", "target"],
        },
        input: {
          text: "Hello world",
          target: "fr",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              translation: { type: "string", description: "The translated text, formatting preserved" },
              source_language: {
                type: "string",
                description: "ISO 639-1 code of the source language (detected or supplied)",
              },
              target_language: { type: "string", description: "ISO 639-1 code of the target language" },
              source_detected: {
                type: "boolean",
                description: "true when the source language was auto-detected; false when supplied by the caller",
              },
              word_count: { type: "number", description: "Word count of the input text" },
              tier: { type: "string", description: "Pricing tier — always \"short\" for this endpoint" },
              service_score: { type: "number", description: "Endpoint health score 0-100 (100 on success)" },
              grade: { type: "string", description: "Letter grade A-F derived from service_score" },
              findings: {
                type: "array",
                description: "Plain-string hints — e.g. a targetHint string when the target language was model-interpreted",
              },
            },
          },
          example: {
            translation: "Bonjour le monde",
            source_language: "en",
            target_language: "fr",
            source_detected: true,
            word_count: 2,
            tier: "short",
            service_score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /asn-lookup/analyze": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.asnLookup,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Resolves an IP address or domain to its Autonomous System Number (ASN), network owner, country, and hosting/cloud classification — agents get structured network ownership context plus a trust score to assess infrastructure risk.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "IP address (v4 or v6) or domain name to look up (aliases accepted: ip, address, host, hostname, query — query param or JSON body)",
            },
          },
          required: ["target"],
        },
        input: { target: "8.8.8.8" },
        output: {
          schema: {
            type: "object",
            properties: {
              target: { type: "string" },
              ip: { type: "string" },
              ip_version: { type: "number" },
              hostname: { type: ["string", "null"] },
              asn: { type: ["string", "null"] },
              asn_number: { type: ["number", "null"] },
              organization: { type: ["string", "null"] },
              network: { type: ["string", "null"] },
              country: { type: ["string", "null"] },
              region: { type: ["string", "null"] },
              city: { type: ["string", "null"] },
              is_hosting: { type: "boolean" },
              is_cloud: { type: "boolean" },
              is_vpn: { type: "boolean" },
              classification: { type: "string" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          // Live output of the input above. Note: cloud_infrastructure and
          // hosting_provider findings are mutually exclusive in the handler
          // (hosting fires only when NOT cloud), and deductions are multiples
          // of 5 — don't hand-edit this into an unreachable combination.
          example: {
            target: "8.8.8.8",
            ip: "8.8.8.8",
            ip_version: 4,
            hostname: "dns.google",
            asn: "AS15169",
            asn_number: 15169,
            organization: "Google LLC",
            network: null,
            country: "US",
            region: "California",
            city: "Mountain View",
            is_hosting: true,
            is_cloud: true,
            is_vpn: false,
            classification: "cloud",
            score: 80,
            grade: "B",
            findings: [
              { rule: "cloud_infrastructure", deduction: -20, detail: "IP belongs to known cloud provider (Google LLC)" },
            ],
          },
        },
      }),
    },
  },
  "GET /whois-rdap/lookup": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.whoisRdap,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "WHOIS domain lookup via RDAP — registrar, creation/expiry/updated dates, nameservers, and status flags from the authoritative registry, plus an actionability score so agents can assess domain trustworthiness, ownership, or availability risk.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain name to look up (e.g. example.com)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "example.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              tld: { type: "string" },
              rdap_url: { type: "string" },
              registrar: { type: "string" },
              registrar_iana_id: { type: "string" },
              created_at: { type: "string" },
              updated_at: { type: "string" },
              expires_at: { type: "string" },
              days_until_expiry: { type: "number" },
              name_servers: { type: "array" },
              status: { type: "array" },
              status_has_abuse_flags: { type: "boolean" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
              raw_rdap_url: { type: "string" },
            },
          },
          // Live output of the input above (expires_within_90_days only fires
          // when days_until_expiry < 90 — the previous example paired it with
          // 180 days, an impossible combination).
          example: {
            domain: "example.com",
            tld: "com",
            rdap_url: "https://rdap.verisign.com/com/v1/domain/example.com",
            registrar: "RESERVED-Internet Assigned Numbers Authority",
            registrar_iana_id: "376",
            created_at: "1995-08-14T04:00:00Z",
            updated_at: "2026-01-16T18:26:50Z",
            expires_at: "2026-08-13T04:00:00Z",
            days_until_expiry: 37,
            name_servers: ["elliott.ns.cloudflare.com", "hera.ns.cloudflare.com"],
            status: ["client delete prohibited", "client transfer prohibited"],
            status_has_abuse_flags: false,
            score: 85,
            grade: "B",
            findings: [
              { rule: "expires_within_90_days", deduction: -15, detail: "Domain expires in 37 days" },
            ],
            raw_rdap_url: "https://rdap.verisign.com/com/v1/domain/example.com",
          },
        },
      }),
    },
  },
  "GET /cert-transparency/lookup": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.certTransparency,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Query the crt.sh certificate transparency log database to enumerate all SSL certificates ever issued for a domain — returns subdomains discovered, certificate issuers, validity periods, and a risk score flagging wildcard certs, expiring certs, and suspicious issuance patterns.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain name to query certificate transparency logs for (e.g. example.com)",
            },
            include_subdomains: {
              type: "boolean",
              description: "Whether to include subdomain certificates (default: true)",
            },
            limit: {
              type: "number",
              description: "Maximum number of certificates to return (default: 100, max: 500)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "example.com", include_subdomains: true, limit: 100 },
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              total_certs_found: { type: "number" },
              unique_subdomains: { type: "array" },
              unique_subdomain_count: { type: "number" },
              issuers: { type: "array" },
              wildcard_certs: { type: "array" },
              expiring_within_30_days: { type: "array" },
              recently_issued: { type: "array" },
              certs: { type: "array" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            domain: "example.com",
            total_certs_found: 47,
            unique_subdomains: ["www.example.com", "mail.example.com"],
            unique_subdomain_count: 2,
            issuers: ["Let's Encrypt"],
            wildcard_certs: [],
            expiring_within_30_days: [],
            recently_issued: [],
            certs: [
              {
                id: 12345678,
                common_name: "example.com",
                issuer: "Let's Encrypt",
                not_before: "2024-01-01T00:00:00Z",
                not_after: "2024-04-01T00:00:00Z",
                sans: ["example.com", "www.example.com"],
                is_wildcard: false,
                is_expired: false,
                days_until_expiry: 90,
              },
            ],
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /subnet/calc": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.subnetCalc,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Calculates IPv4/IPv6 subnet details from CIDR notation — network/broadcast, netmask, wildcard (Cisco ACL) mask, binary/hex masks, usable host range, RFC classification (private/loopback/multicast), supernet, and subnet-split counts. Pass comma-separated CIDRs to detect overlaps and classify each pair (subnet/supernet/partial overlap/disjoint); multi-CIDR responses return {subnets, overlaps}.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            cidr: {
              type: "string",
              description:
                "CIDR block, e.g. 10.0.1.0/24 or 2001:db8::/48 (IPv6). Comma-separate multiple CIDRs for overlap/containment analysis, e.g. 10.0.0.0/16,10.0.1.0/24",
            },
          },
          required: ["cidr"],
        },
        input: { cidr: "10.0.1.0/24" },
        output: {
          schema: {
            type: "object",
            properties: {
              cidr: { type: "string" },
              ip_version: { type: "number" },
              network: { type: "string" },
              broadcast: { type: "string" },
              netmask: { type: "string" },
              wildcard: { type: "string" },
              binary_mask: { type: "string" },
              hex_mask: { type: "string" },
              prefix_length: { type: "number" },
              total_hosts: { type: "number" },
              usable_hosts: { type: "number" },
              first_usable: { type: "string" },
              last_usable: { type: "string" },
              is_private: { type: "boolean" },
              supernet: { type: "string" },
              subnets: { type: "array" },
              rfc_classification: { type: "string" },
            },
          },
          example: {
            cidr: "10.0.1.0/24",
            ip_version: 4,
            network: "10.0.1.0",
            broadcast: "10.0.1.255",
            netmask: "255.255.255.0",
            wildcard: "0.0.0.255",
            binary_mask: "11111111111111111111111100000000",
            hex_mask: "ffffff00",
            prefix_length: 24,
            total_hosts: 256,
            usable_hosts: 254,
            first_usable: "10.0.1.1",
            last_usable: "10.0.1.254",
            is_private: true,
            supernet: "10.0.0.0/23",
            subnets: [{ prefix: "/25", count: 2 }, { prefix: "/26", count: 4 }, { prefix: "/27", count: 8 }, { prefix: "/28", count: 16 }],
            rfc_classification: "Private (RFC 1918)",
          },
        },
      }),
    },
  },
  "GET /dns-propagation/check": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.dnsPropagation,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Query a domain's DNS record across 10 geographically distributed public resolvers simultaneously — returns what each resolver sees, whether results are consistent, propagation percentage, and a readiness score so agents can confirm DNS changes have fully propagated globally.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain name to check propagation for (e.g. example.com)",
            },
            record_type: {
              type: "string",
              description: "DNS record type: A, AAAA, MX, TXT, CNAME, NS (default: A)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "example.com", record_type: "A" },
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              record_type: { type: "string" },
              propagation_percentage: { type: "number" },
              consistent: { type: "boolean" },
              majority_value: { type: "array" },
              resolvers: { type: "array" },
              divergent_resolvers: { type: "array" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          // Live output shape (resolver list truncated to 2 of 10 for size).
          // NOTE: timeouts count toward resolver_timeout only — a timed-out
          // resolver is NOT a partial_propagation divergent (that rule counts
          // successful-but-different answers), so keep the two rules coherent
          // if editing this example.
          example: {
            domain: "example.com",
            record_type: "A",
            propagation_percentage: 90,
            consistent: true,
            majority_value: ["104.20.23.154", "172.66.147.243"],
            resolvers: [
              { name: "Google Primary", ip: "8.8.8.8", status: "success", records: ["104.20.23.154", "172.66.147.243"], matches_majority: true, response_time_ms: 24 },
              { name: "Comodo Secure", ip: "8.26.56.26", status: "timeout", records: [], matches_majority: false, response_time_ms: null },
            ],
            divergent_resolvers: ["Comodo Secure"],
            score: 92,
            grade: "A",
            findings: [
              { rule: "resolver_timeout", deduction: -8, detail: "1 resolver timed out" },
            ],
          },
        },
      }),
    },
  },
  "GET /dnssec/validate": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.dnssec,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Validate a domain's DNSSEC configuration by checking for DS records at the parent zone, DNSKEY records at the domain, RRSIG signatures, and NSEC/NSEC3 records — returns a full chain-of-trust assessment and readiness score so agents can verify DNS integrity before trusting resolution results.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain name to validate DNSSEC for (e.g. example.com)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "example.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              dnssec_enabled: { type: "boolean" },
              chain_of_trust: { type: "string" },
              components: { type: "object" },
              tld_ds_present: { type: "boolean" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            domain: "example.com",
            dnssec_enabled: true,
            chain_of_trust: "complete",
            components: {
              ds_record: { present: true, count: 1, algorithms: ["ECDSAP256SHA256"] },
              dnskey_record: { present: true, count: 2, key_types: ["KSK", "ZSK"] },
              rrsig_record: { present: true, signatures_found: 3 },
              nsec_or_nsec3: { present: true, type: "NSEC3" },
            },
            tld_ds_present: true,
            score: 95,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /ip-blacklist/check": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.ipBlacklist,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Check an IP address against 15 major DNS blacklists (Spamhaus, Barracuda, SORBS, etc.) simultaneously — returns which lists it appears on, a reputation score, and a threat classification so agents can make block/allow decisions instantly.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            ip: {
              type: "string",
              description: "IPv4 address to check (e.g. 1.2.3.4)",
            },
          },
          required: ["ip"],
        },
        input: { ip: "1.2.3.4" },
        output: {
          schema: {
            type: "object",
            properties: {
              ip: { type: "string" },
              reversed_ip: { type: "string" },
              listed_count: { type: "number" },
              total_checked: { type: "number" },
              threat_level: { type: "string" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
              blacklists: { type: "array" },
            },
          },
          example: {
            ip: "1.2.3.4",
            reversed_ip: "4.3.2.1",
            listed_count: 0,
            total_checked: 15,
            threat_level: "clean",
            score: 100,
            grade: "A",
            findings: [],
            blacklists: [
              {
                name: "zen.spamhaus.org",
                listed: false,
                description: "Spamhaus ZEN — combined spam sources and exploits",
              },
            ],
          },
        },
      }),
    },
  },
  "GET /ip-reputation/analyze": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.ipReputation,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Check an IP address against AbuseIPDB and AlienVault OTX threat feeds. Returns a composite risk score, threat categories, malware families, and full source data.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            ip: {
              type: "string",
              description: "IPv4 or IPv6 address to check",
            },
          },
          required: ["ip"],
        },
        input: { ip: "185.220.101.45" },
        output: {
          schema: {
            type: "object",
            properties: {
              ip: { type: "string" },
              risk_score: { type: "number" },
              risk_level: { type: "string" },
              composite: { type: "object" },
              abuseipdb: { type: "object" },
              otx: { type: "object" },
            },
          },
          example: {
            ip: "185.220.101.45",
            risk_score: 87,
            risk_level: "critical",
            composite: {
              is_malicious: true,
              threat_categories: ["brute_force", "port_scan"],
              first_seen: "2022-03-11",
              last_seen: "2024-11-01T14:22:00Z",
            },
            abuseipdb: {
              confidence_score: 100,
              total_reports: 1842,
              distinct_reporters: 312,
              last_reported_at: "2024-11-01T14:22:00Z",
              isp: "Frantech Solutions",
              usage_type: "Data Center/Web Hosting/Transit",
              domain: "frantech.ca",
              categories: [18, 14],
            },
            otx: {
              available: true,
              pulse_count: 38,
              malware_families: ["Mirai"],
              threat_types: ["scanning"],
              asn: "AS53667",
              country_code: "NL",
              reputation: -100,
            },
          },
        },
      }),
    },
  },
  "GET /cron-parser/explain": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.cronParser,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Parse any cron expression into a human-readable explanation, validate its syntax, compute the next 5 scheduled run times (UTC), and detect common patterns (daily, weekly, monthly, hourly) — accepts standard numeric fields plus JAN-DEC/SUN-SAT name tokens — so agents can understand, validate, and work with cron schedules without implementing their own cron parser.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            expression: {
              type: "string",
              description: "Cron expression, 5 or 6 space-separated fields; month/day names accepted (e.g. 0 9 * * MON-FRI)",
            },
            // NOTE: no `timezone` param — next_runs are computed in UTC. A
            // timezone used to be documented here but the handler never
            // honored it (silent UTC), which misled paying agents.
            count: {
              type: "number",
              description: "Number of next run times to return (default: 5, max: 20)",
            },
          },
          required: ["expression"],
        },
        input: { expression: "0 9 * * 1-5" },
        output: {
          schema: {
            type: "object",
            properties: {
              expression: { type: "string" },
              is_valid: { type: "boolean" },
              fields: { type: "object" },
              explanation: { type: "string" },
              pattern_name: { type: "string" },
              next_runs: { type: "array" },
              warnings: { type: "array" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            expression: "0 9 * * 1-5",
            is_valid: true,
            fields: {
              minute: "0",
              hour: "9",
              day_of_month: "*",
              month: "*",
              day_of_week: "1-5",
            },
            explanation: "At 9:00 AM, Monday through Friday",
            pattern_name: "Weekdays at 9:00 AM",
            next_runs: ["2024-03-11T09:00:00Z"],
            warnings: [],
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /currency-exchange/convert": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.currencyExchange,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    // Keep this description under ~450 chars — CDP's facilitator rejects the
    // paymentPayload (VERIFICATION_FAILED) when the echoed discovery blob/desc is
    // too large. It grew to 583 chars in 823f626 and silently broke settlement.
    // See memory x402-paymentpayload-size-limit.
    description:
      "Convert any amount between 32 fiat currencies (live European Central Bank rates) and major cryptocurrencies (BTC, ETH, USDC, SOL, ICP, CELO and more, live Coinbase spot rates) — fiat↔fiat, crypto↔fiat, and crypto↔crypto all work. Returns converted amount, exchange rate, inverse rate, rate date, and rate source so agents can price and invoice across fiat and crypto without a paid forex API.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: "ISO 4217 source currency code (e.g. USD)",
            },
            to: {
              type: "string",
              description: "Target — ISO 4217 fiat code (EUR) or crypto ticker (BTC, ETH)",
            },
            amount: {
              type: "number",
              description: "Amount to convert (default 1)",
            },
            date: {
              type: "string",
              description: "YYYY-MM-DD historical rate (fiat only). Default: latest",
            },
          },
          required: ["from", "to"],
        },
        input: { from: "USD", to: "BTC", amount: 100 },
        output: {
          schema: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              amount: { type: "number" },
              converted_amount: { type: "number" },
              exchange_rate: { type: "number" },
              inverse_rate: { type: "number" },
              rate_date: { type: "string" },
              is_historical: { type: "boolean" },
              source: { type: "string", description: "ecb | coinbase | coingecko | same" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            from: "USD",
            to: "BTC",
            amount: 100,
            converted_amount: 0.00094932,
            exchange_rate: 0.0000094932,
            inverse_rate: 105340,
            rate_date: "2026-06-23",
            is_historical: false,
            source: "coinbase",
            score: 100,
            grade: "A",
            findings: [{ rule: "crypto_spot", detail: "Crypto pair priced at Coinbase spot" }],
          },
        },
      }),
    },
  },
  "GET /convert": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.convert,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Convert any physical measurement — length, mass, volume, temperature, area, speed, pressure, energy, time, data storage & transfer rate, power, frequency, force, fuel economy (mpg/L per 100 km), angle. Auto-detects the category, handles US/imperial ambiguity, reports assumptions. Accepts natural-language queries (\"what is 5 km in miles\") and volume↔mass via density/substance. Deterministic and instant.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            value: {
              type: "number",
              description: "Quantity to convert",
            },
            from: {
              type: "string",
              description: 'Source unit, e.g. "cups", "kg", "C", "miles" — common aliases accepted (kilograms, °C, fl oz, …)',
            },
            to: {
              type: "string",
              description: 'Destination unit, e.g. "fl_oz", "lb", "F", "km" — must be in the same category as from',
            },
            query: {
              type: "string",
              description: 'Alternative to value/from/to: one natural-language string, e.g. "convert 73 liters to gallons"',
            },
            system: {
              type: "string",
              description: '"us" or "imperial" — disambiguates volume units (cup, fl_oz, pint, quart, gallon), bare "ton" (us_ton vs imperial_ton), and bare "mpg". Default: us',
            },
            base: {
              type: "string",
              description: '"decimal" (1000) or "binary" (1024) for digital storage units. Default: decimal',
            },
            density: {
              type: "number",
              description: "For volume↔mass: density in kg per liter (= g/mL), e.g. 0.92",
            },
            substance: {
              type: "string",
              description: "For volume↔mass: substance whose nominal density to use (water, milk, gasoline, diesel, ethanol, olive_oil, honey, butter, flour, sugar, seawater)",
            },
          },
          required: [],
        },
        input: { value: 2, from: "cups", to: "fl_oz" },
        output: {
          schema: {
            type: "object",
            properties: {
              value: { type: "number" },
              from: { type: "string" },
              to: { type: "string" },
              result: { type: "number" },
              category: { type: "string" },
              assumptions: { type: "object", description: "Every default applied to resolve ambiguity: system (volume), oz_interpreted_as, base_used (digital)" },
              precision_note: { type: "string" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            value: 2,
            from: "cups",
            to: "fl_oz",
            result: 16,
            category: "volume",
            // oz_interpreted_as only appears when the raw unit was a bare
            // "oz"/"ounce" — cups→fl_oz emits {system} alone.
            assumptions: { system: "us" },
            precision_note: "rounded to 6 significant figures",
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /money/parse": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.moneyParse,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Normalize any messy money string into a typed decimal amount plus ISO 4217 currency — handles symbols, locale separators ($1,234.56 vs €1.234,56), magnitude suffixes (1.2M), accounting notation, and natural-language amounts — so agents can clean money values before converting or storing them, with no external data and a deterministic fast path.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The money string to parse (e.g. \"$1,234.56\", \"€1.234,56\", \"USD 1.2M\"). Max 1000 characters.",
            },
            locale_hint: {
              type: "string",
              description: "Optional BCP-47/ISO locale (e.g. \"de-DE\", \"en-US\") to disambiguate decimal vs grouping separators.",
            },
            default_currency: {
              type: "string",
              description: "Optional ISO 4217 code to assume when no currency marker is present. Honored for ~50 common codes; unrecognized codes are ignored (currency stays null — never guessed).",
            },
            allow_llm: {
              type: "boolean",
              description: "Default true. When false, skip the natural-language LLM fallback (deterministic-only).",
            },
          },
          required: ["text"],
        },
        input: { text: "$1,234.56" },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              data: { type: "object" },
              meta: { type: "object" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            data: {
              parsed: true,
              amount: 1234.56,
              currency: "USD",
              raw: "$1,234.56",
              reason: null,
            },
            meta: {
              method: "deterministic",
              currency_ambiguous: true,
              separator_assumed: "us",
              magnitude_applied: null,
              sign_convention: "none",
              confidence: 0.5,
              used_llm: false,
            },
            score: 90,
            grade: "A",
            findings: [
              { rule: "currency_ambiguous", detail: "Currency symbol/word maps to multiple ISO 4217 codes; resolution is best-effort" },
            ],
          },
        },
      }),
    },
  },
  "POST /calendar/ics": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.calendarIcs,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Turn event fields into a valid RFC 5545 .ics calendar file — handles timed and all-day events, escaping, line folding, and a deterministic UID for idempotent re-import — so agents can publish events that import cleanly into Google, Apple, and Outlook calendars. Add ?download=1 (or Accept: text/calendar) to receive the raw .ics file with a Content-Disposition attachment header instead of the JSON envelope. Pure compute, no LLM.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Event summary (e.g. \"Team Offsite\"). Required.",
            },
            starts_at: {
              type: "string",
              description:
                "ISO-8601 start. Use an offset/timestamp for timed events (e.g. 2026-06-27T09:00:00+02:00) or a bare date (YYYY-MM-DD) for all-day. Required.",
            },
            ends_at: {
              type: "string",
              description:
                "Optional ISO-8601 end. Defaults: timed → start + 1 hour; all-day → start + 1 day (exclusive). For multi-day all-day events pass the inclusive last day.",
            },
            all_day: {
              type: "boolean",
              description:
                "Optional. Inferred when omitted: a bare-date starts_at is all-day, a timestamp is timed.",
            },
            timezone: {
              type: "string",
              description:
                "Optional IANA timezone (e.g. Europe/Paris). Timed events are converted to UTC and emitted with a Z suffix (no VTIMEZONE block). Unrecognized values are ignored (falls back to UTC).",
            },
            location: { type: "string", description: "Optional venue/address → LOCATION." },
            description: { type: "string", description: "Optional → DESCRIPTION." },
            url: { type: "string", description: "Optional → URL." },
            organizer: {
              type: "string",
              description: "Optional organizer name and/or email → ORGANIZER (CN=...).",
            },
          },
          required: ["title", "starts_at"],
        },
        input: {
          title: "Team Offsite",
          starts_at: "2026-06-27T09:00:00",
          ends_at: "2026-06-27T17:00:00",
          timezone: "Europe/Paris",
          location: "Paris HQ",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              data: { type: "object" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            data: {
              ics: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n...END:VCALENDAR\r\n",
              uid: "a1b2c3...@netintel.dev",
              all_day: false,
            },
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /event-classify": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.eventClassify,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Cheap, fast \"is this a dateable event?\" filter for social and web text — one tiny Haiku call returns is_event, confidence, and a one-line reason, so agents can screen every post for free-ish and only pay for full extraction on the ones that pass. Front-end filter to /event-extract; intentionally minimal output for cost/latency discipline.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "Caption/post/snippet to classify. Required. Max 10000 words or 50KB.",
            },
            posted_at: {
              type: "string",
              description:
                "Optional ISO-8601 timestamp the content was posted — lets the classifier reject past-event recaps (an event whose only date is in the past relative to posted_at is not dateable).",
            },
            timezone: {
              type: "string",
              description:
                "Optional IANA timezone (e.g. America/Los_Angeles) for date context.",
            },
          },
          required: ["text"],
        },
        input: {
          text: "Live at The Echo this Saturday 7pm — doors at 6:30, $15 at the door.",
          posted_at: "2026-06-20T12:00:00Z",
          timezone: "America/Los_Angeles",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              data: {
                type: "object",
                description:
                  "Minimal verdict: is_event (boolean), confidence (0-1), reason (one short line).",
              },
              meta: { type: "object" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            data: {
              is_event: true,
              confidence: 0.93,
              reason: "specific dated event",
            },
            meta: { model: "haiku-4.5" },
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /event-extract": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.eventExtract,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Event extraction / event parsing — turn any caption, announcement, listing, or page text into a normalized calendar event via Claude Haiku. Resolves relative dates (\"this Saturday 7pm\") against post time + timezone, handles all-day/multi-day, and returns title, start/end, venue, address, city, price, organizer, url. Purpose-built for structured event data (no schema to define); pairs with /event-classify and /calendar/ics.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "Caption/announcement/page text to extract an event from. Required. Max 10000 words or 50KB.",
            },
            posted_at: {
              type: "string",
              description:
                "Optional ISO-8601 timestamp the content was posted — the anchor for resolving relative dates (\"this Saturday\", \"tonight\"). Strongly recommended.",
            },
            timezone: {
              type: "string",
              description:
                "Optional IANA timezone (e.g. America/Los_Angeles) to resolve times against. Inferred from city when absent.",
            },
            city: {
              type: "string",
              description:
                "Optional city — helps timezone inference and venue/address disambiguation.",
            },
          },
          required: ["text"],
        },
        input: {
          text: "Live Jazz Night at The Echo, 1822 Sunset Blvd — this Saturday 7pm. Free!",
          posted_at: "2026-06-24T12:00:00Z",
          timezone: "America/Los_Angeles",
          city: "Los Angeles",
        },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              data: {
                type: "object",
                description:
                  "Normalized event (is_event, confidence, title, starts_at, ends_at, all_day, timezone, venue, address, city, price, url, organizer). For a non-event, is_event=false + reason and all event fields null.",
              },
              meta: { type: "object" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            data: {
              is_event: true,
              confidence: 0.9,
              title: "Live Jazz Night",
              starts_at: "2026-06-27T19:00:00-07:00",
              ends_at: null,
              all_day: false,
              timezone: "America/Los_Angeles",
              venue: "The Echo",
              address: "1822 Sunset Blvd",
              city: "Los Angeles",
              price: "Free",
              url: null,
              organizer: null,
            },
            meta: {
              model: "haiku-4.5",
              date_resolved_from: "posted_at",
              date_before_posted: false,
            },
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /tech-fingerprint/analyze": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.techFingerprint,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Fetch a URL and detect the full technology stack from HTTP response headers, HTML meta tags, cookies, and script patterns — returns CMS, framework, CDN, server, analytics, and security tool detections so agents can profile any web target without a browser.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "URL to fingerprint (e.g. https://example.com); bare domains are accepted and get https:// prepended. Aliases also accepted: target, domain, host, site (query param or JSON body).",
            },
          },
          required: ["url"],
        },
        input: { url: "https://example.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              url: { type: "string" },
              status_code: { type: "number" },
              response_time_ms: { type: "number" },
              detections: { type: "array" },
              summary: { type: "object" },
              security_headers_present: { type: "array" },
              security_headers_missing: { type: "array" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            url: "https://example.com",
            status_code: 200,
            response_time_ms: 342,
            detections: [
              { name: "Cloudflare", category: "cdn", confidence: "high" },
              { name: "WordPress", category: "cms", confidence: "high" },
            ],
            summary: {
              server: "Nginx",
              cdn: "Cloudflare",
              cms: "WordPress",
              waf: "Cloudflare WAF",
              javascript_frameworks: ["jQuery"],
              analytics: ["Google Analytics"],
            },
            security_headers_present: ["Strict-Transport-Security", "X-Frame-Options"],
            security_headers_missing: ["Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy"],
            score: 68,
            grade: "C",
            findings: [
              { rule: "missing_csp", deduction: -20, detail: "Content-Security-Policy header missing" },
            ],
          },
        },
      }),
    },
  },
  "GET /breach-check/password": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.breachCheck,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Check if a password has appeared in known data breaches using the HaveIBeenPwned Pwned Passwords API with k-anonymity — the full password is never transmitted, only a 5-character SHA-1 hash prefix — returns breach count and a risk classification so agents can enforce password policies without storing or exposing credentials.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            password: {
              type: "string",
              description: "Password to check against known data breaches (1-500 characters; sent as a query param but only a k-anonymity SHA-1 prefix leaves the server)",
            },
          },
          required: ["password"],
        },
        input: { password: "test123" },
        output: {
          schema: {
            type: "object",
            properties: {
              breached: { type: "boolean" },
              breach_count: { type: "number" },
              risk_level: { type: "string" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            breached: true,
            breach_count: 34521,
            risk_level: "critical",
            score: 0,
            grade: "F",
            findings: [
              { rule: "critical_breach", deduction: -100, detail: "Password found 34521 times in known data breaches" },
            ],
          },
        },
      }),
    },
  },
  "GET /domain-availability/check": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.domainAvailability,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Check if a domain name is available for registration by querying RDAP and DNS — pass a bare name (e.g. mybrand) to sweep it across 10 popular TLDs simultaneously, or a full domain (e.g. mybrand.com) to check that single domain — returns registration status, expiry date if registered, and available/taken TLD lists so agents can find the best domain for a brand or project.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain name with or without TLD (e.g. mybrand or mybrand.com)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "mybrand" },
        output: {
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              results: { type: "array" },
              available_tlds: { type: "array" },
              taken_tlds: { type: "array" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            name: "mybrand",
            results: [
              {
                domain: "mybrand.com",
                available: false,
                status: "registered",
                registrar: "GoDaddy LLC",
                expires_at: "2025-06-01T00:00:00Z",
                days_until_expiry: 79,
                expiring_soon: true,
              },
              {
                domain: "mybrand.io",
                available: true,
                status: "available",
                registrar: null,
                expires_at: null,
                days_until_expiry: null,
                expiring_soon: false,
              },
            ],
            available_tlds: [".io", ".co", ".xyz"],
            taken_tlds: [".com", ".net", ".org"],
            score: 70,
            grade: "C",
            findings: [
              { rule: "com_taken", deduction: -20, detail: "mybrand.com is already registered" },
            ],
          },
        },
      }),
    },
  },
  "GET /email-intel/analyze": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.emailIntel,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Email verification & deliverability check (email validator / verifier) — validate an address, detect disposable/temporary domains, flag role-based inboxes, confirm MX records exist, and return a trust/risk score so agents can qualify leads, clean lists, and gate signups without sending a single email.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            email: {
              type: "string",
              description: "Email address to validate (e.g. john@gmail.com)",
            },
          },
          required: ["email"],
        },
        // gmail.com has real MX + free-provider signal — the example response
        // below is this exact call's live output (example.com has NO usable MX,
        // so the old example promised a result the input could never produce).
        input: { email: "john@gmail.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              email: { type: "string" },
              domain: { type: "string" },
              local_part: { type: "string" },
              format_valid: { type: "boolean" },
              mx_records_found: { type: "boolean" },
              mx_records: { type: "array", items: { type: "string" } },
              is_disposable: { type: "boolean" },
              is_role_based: { type: "boolean" },
              is_free_provider: { type: "boolean" },
              is_business_email: { type: "boolean" },
              deliverability: { type: "string" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "string" } },
            },
          },
          example: {
            email: "john@gmail.com",
            domain: "gmail.com",
            local_part: "john",
            format_valid: true,
            mx_records_found: true,
            mx_records: ["gmail-smtp-in.l.google.com", "alt1.gmail-smtp-in.l.google.com"],
            is_disposable: false,
            is_role_based: false,
            is_free_provider: true,
            is_business_email: false,
            deliverability: "risky",
            score: 90,
            grade: "A",
            findings: ["is_free_provider"],
          },
        },
      }),
    },
  },
  "GET /og-scraper/extract": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.ogScraper,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Fetch any public URL and extract structured metadata — Open Graph tags, Twitter Card tags, canonical URL, title, description, favicon, article author/date, JSON-LD structured data, and content type — so agents can preview, classify, and enrich links without building their own scraper.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Public URL to extract metadata from (e.g. https://github.com/coinbase/x402)",
            },
          },
          required: ["url"],
        },
        // OG-rich, stable page; the example response is this call's live output.
        // (example.com has no description/og:image/canonical → scored 55/C and
        // contradicted the pristine example previously shown here.)
        input: { url: "https://github.com/coinbase/x402" },
        output: {
          schema: {
            type: "object",
            properties: {
              url: { type: "string" },
              final_url: { type: "string" },
              status_code: { type: "number" },
              title: { type: "string" },
              description: { type: ["string", "null"] },
              image: { type: ["string", "null"] },
              favicon: { type: ["string", "null"] },
              site_name: { type: ["string", "null"] },
              canonical_url: { type: ["string", "null"] },
              content_type: { type: "string" },
              author: { type: ["string", "null"] },
              published_at: { type: ["string", "null"] },
              modified_at: { type: ["string", "null"] },
              twitter_card: { type: ["string", "null"] },
              json_ld: { type: ["object", "null"] },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            url: "https://github.com/coinbase/x402",
            final_url: "https://github.com/coinbase/x402",
            status_code: 200,
            title: "GitHub - coinbase/x402: A payments protocol for the internet. Built on HTTP.",
            description: "A payments protocol for the internet. Built on HTTP. - coinbase/x402",
            image: "https://opengraph.githubassets.com/d86e2f3ce6d1051d325e229bc56ef07c81a8e75e7455c3d5b52de8a1031e6a51/coinbase/x402",
            favicon: "https://github.githubassets.com/favicons/favicon",
            site_name: "GitHub",
            canonical_url: "https://github.com/coinbase/x402",
            content_type: "object",
            author: null,
            published_at: null,
            modified_at: null,
            twitter_card: "summary_large_image",
            json_ld: null,
            score: 90,
            grade: "A",
            findings: [{ rule: "no_canonical", deduction: -10, detail: "No canonical URL found" }],
          },
        },
      }),
    },
  },
  "GET /page-extract/read": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.pageExtract,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Fetch any article or web page and extract clean readable text stripped of navigation, ads, and boilerplate — returns the main content body, word count, estimated reading time, detected language, and key sentences so agents can read the web without a browser or third-party scraping service.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Public URL to extract content from (e.g. https://www.sitemaps.org/protocol.html)",
            },
          },
          required: ["url"],
        },
        // Content-rich, stable page. example.com has ~25 words of <p> text, so
        // the first paid call on the old example returned score 40/D
        // "no_content_extracted" — the opposite of what the example promised.
        input: { url: "https://www.sitemaps.org/protocol.html" },
        output: {
          schema: {
            type: "object",
            properties: {
              url: { type: "string" },
              final_url: { type: "string" },
              title: { type: "string" },
              content: { type: "string" },
              preview: { type: "array" },
              word_count: { type: "number" },
              reading_time_minutes: { type: "number" },
              language: { type: "string" },
              content_length_chars: { type: "number" },
              status_code: { type: "number" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            url: "https://www.sitemaps.org/protocol.html",
            final_url: "https://www.sitemaps.org/protocol.html",
            title: "sitemaps.org - Protocol",
            content: "This document describes the XML schema for the Sitemap protocol.\n\nThe Sitemap protocol format consists of XML tags...",
            preview: [
              "This document describes the XML schema for the Sitemap protocol.",
              "The Sitemap protocol format consists of XML tags.",
              "All data values in a Sitemap must be entity-escaped.",
            ],
            word_count: 2456,
            reading_time_minutes: 11,
            language: "en",
            content_length_chars: 18894,
            status_code: 200,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /web/extract": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.webExtract,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Extract article / main content from any URL or PDF to clean, LLM-ready Markdown (web scraper / reader / html-to-markdown) — strips scripts, nav, ads, and boilerplate while preserving headings, links, lists, tables, code blocks, and blockquotes; extracts the text layer from PDFs. Returns Markdown body, title, word count, and a quality grade so agents can read articles and documents without a browser or paid scraping service.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Public URL of an HTML page or PDF to extract (e.g. https://www.sitemaps.org/protocol.html)",
            },
          },
          required: ["url"],
        },
        // Same rationale as /page-extract: example.com is too thin to extract
        // (fired thin_content, 85/B) — this stable page returns the clean 100/A
        // shown below (live output of this exact call).
        input: { url: "https://www.sitemaps.org/protocol.html" },
        output: {
          schema: {
            type: "object",
            properties: {
              url: { type: "string" },
              final_url: { type: "string" },
              content_type: { type: "string", description: "article | pdf | other (non-HTML/PDF falls back to best-effort plain text)" },
              title: { type: "string" },
              markdown: { type: "string" },
              word_count: { type: "number" },
              char_count: { type: "number" },
              output_bytes: { type: "number" },
              truncated: { type: "boolean" },
              status_code: { type: "number" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            url: "https://www.sitemaps.org/protocol.html",
            final_url: "https://www.sitemaps.org/protocol.html",
            content_type: "article",
            title: "sitemaps.org - Protocol",
            markdown: "## Sitemaps XML format\n\nThis document describes the XML schema for the Sitemap protocol...",
            word_count: 2707,
            char_count: 21619,
            output_bytes: 21619,
            truncated: false,
            status_code: 200,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /phone-intel/analyze": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.phoneIntel,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Parse and validate any phone number in any format, identify its country and line type (mobile/landline/VOIP/toll-free/premium for NANP + UK numbers; other countries return line_type unknown), and return all standard format variants (E.164, international, national) — so agents can validate contacts and normalize phone data without a paid telecom API.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            phone: {
              type: "string",
              description: "Phone number in any format (e.g. +1 555 867-5309). In query strings URL-encode a leading + as %2B — an unencoded + decodes to a space (tolerated: leading space+digits is re-interpreted as +).",
            },
            country_hint: {
              type: "string",
              description: "ISO 3166-1 alpha-2 country code hint when no dial code present (e.g. US)",
            },
          },
          required: ["phone"],
        },
        input: { phone: "+1 (555) 867-5309" },
        output: {
          schema: {
            type: "object",
            properties: {
              input: { type: "string" },
              is_valid: { type: "boolean" },
              e164: { type: "string" },
              international: { type: "string" },
              national: { type: "string" },
              country_code: { type: "string" },
              country: { type: "string" },
              country_name: { type: "string" },
              line_type: { type: "string" },
              digit_count: { type: "number" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          example: {
            input: "+1 (555) 867-5309",
            is_valid: true,
            e164: "+15558675309",
            international: "+1 555 867 5309",
            national: "(555) 867-5309",
            country_code: "1",
            country: "US",
            country_name: "United States",
            line_type: "mobile_or_landline",
            digit_count: 11,
            score: 90,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /robots-txt/analyze": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.robotsTxt,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Fetch and parse a domain's robots.txt file — returns all crawl rules by user-agent, sitemap URLs, crawl delay settings, and checks whether a specific path is allowed or blocked for any bot — so agents can respect crawl policies and locate sitemaps before scraping.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain name to fetch robots.txt from (e.g. example.com)",
            },
            path: {
              type: "string",
              description: "URL path to check permission for (e.g. /api/data)",
            },
            user_agent: {
              type: "string",
              description: "Bot name to check rules for (default: *)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "example.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              robots_url: { type: "string" },
              found: { type: "boolean" },
              status_code: { type: "number" },
              raw_content_preview: { type: "string" },
              sitemaps: { type: "array", items: { type: "string" } },
              rules: { type: "array", items: { type: "object" } },
              path_check: { type: "object" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          example: {
            domain: "example.com",
            robots_url: "https://example.com/robots.txt",
            found: true,
            status_code: 200,
            raw_content_preview: "User-agent: *\nDisallow: /private/\n...",
            sitemaps: ["https://example.com/sitemap.xml"],
            rules: [
              {
                user_agent: "*",
                allow: ["/public/"],
                disallow: ["/private/", "/admin/"],
                crawl_delay: null,
              },
            ],
            path_check: {
              path: "/private/page",
              user_agent: "*",
              allowed: false,
              matched_rule: "Disallow: /private/",
              rule_type: "disallow",
            },
            score: 85,
            grade: "B",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /rss-parser/fetch": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.rssParser,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Fetch and parse any RSS 2.0 or Atom feed URL and return structured articles with title, link, description (truncated to 500 chars), author, publish date, and categories — so agents can monitor content sources, build news pipelines, and process any feed without building their own XML parser. A URL that isn't a parseable feed still returns 200 with feed_type:\"unknown\", empty items, and a parse_failed finding.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Feed URL to fetch and parse (e.g. https://example.com/feed.xml)",
            },
            limit: {
              type: "integer",
              description: "Maximum number of items to return (1-50, default 10)",
            },
          },
          required: ["url"],
        },
        input: { url: "https://feeds.bbci.co.uk/news/rss.xml" },
        output: {
          schema: {
            type: "object",
            properties: {
              url: { type: "string" },
              feed_type: { type: "string" },
              feed: { type: "object" },
              total_items_in_feed: { type: "number" },
              items_returned: { type: "number" },
              items: { type: "array", items: { type: "object" } },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          example: {
            url: "https://example.com/feed.xml",
            feed_type: "rss2",
            feed: {
              title: "Example Blog",
              description: "A blog about interesting things",
              site_url: "https://example.com",
              last_updated: "2024-03-10T08:00:00Z",
            },
            total_items_in_feed: 25,
            items_returned: 10,
            items: [
              {
                title: "Article Title",
                url: "https://example.com/article",
                description: "Short description or summary of the article...",
                author: "Jane Doe",
                published_at: "2024-03-10T08:00:00Z",
                categories: ["technology", "AI"],
                has_full_content: true,
              },
            ],
            score: 90,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /username-check/lookup": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.usernameCheck,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Check username availability across 20+ social platforms and developer sites simultaneously — returns which platforms have a profile registered under that handle so agents can find people, verify identities, scout brand handles, or check name availability before registration.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            username: {
              type: "string",
              description: "Username/handle to check (1-50 chars, alphanumeric + hyphens/underscores/dots)",
            },
          },
          required: ["username"],
        },
        input: { username: "johndoe" },
        output: {
          schema: {
            type: "object",
            properties: {
              username: { type: "string" },
              taken_count: { type: "number" },
              available_count: { type: "number" },
              unknown_count: { type: "number" },
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    platform: { type: "string" },
                    url: { type: "string" },
                    status: { type: "string", enum: ["taken", "available", "unknown"] },
                  },
                },
              },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            username: "johndoe",
            taken_count: 8,
            available_count: 10,
            unknown_count: 4,
            results: [
              { platform: "GitHub", url: "https://github.com/johndoe", status: "taken" },
              { platform: "npm", url: "https://www.npmjs.com/~johndoe", status: "available" },
              { platform: "Instagram", url: "https://www.instagram.com/johndoe", status: "unknown" },
            ],
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /wayback/lookup": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.wayback,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Query the Internet Archive Wayback Machine to check if a URL has ever been archived, get the closest snapshot to a given date, retrieve the most recent capture, and return archival history stats — so agents can access historical web content, verify past content claims, and recover deleted pages.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "URL to check in the Wayback Machine (e.g. https://example.com)",
            },
            timestamp: {
              type: "string",
              description: "Optional target date in YYYYMMDD or YYYYMMDDHHmmss format to find the closest snapshot",
            },
          },
          required: ["url"],
        },
        input: { url: "https://example.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              url: { type: "string", description: "Echoed in normalized form (may gain a trailing slash)" },
              is_archived: { type: "boolean" },
              snapshot: { type: ["object", "null"] },
              first_capture: { type: ["string", "null"] },
              last_capture: { type: ["string", "null"] },
              capture_count_estimate: { type: "number" },
              timestamp_requested: { type: ["string", "null"] },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            url: "https://example.com",
            is_archived: true,
            snapshot: {
              url: "https://web.archive.org/web/20240115120000/https://example.com",
              timestamp: "20240115120000",
              formatted_date: "2024-01-15T12:00:00Z",
              status_code: "200",
            },
            first_capture: "1996-12-02T00:00:00Z",
            last_capture: "2024-03-10T08:00:00Z",
            capture_count_estimate: 5400,
            timestamp_requested: null,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /domain-age/check": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.domainAge,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Determine a domain's age from registration data and archival history — tries RDAP, then port-43 WHOIS, then a Wayback-based estimate (age_source: rdap | whois | wayback_estimate | null), returning creation date, age in years, first Wayback capture, archived snapshot count, and a maturity signal so agents can assess trustworthiness and detect freshly registered domains used for fraud or phishing — including .io and TLDs without public RDAP.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain name to assess (e.g. example.com)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "example.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              created_at: { type: ["string", "null"] },
              age_days: { type: ["number", "null"] },
              age_years: { type: ["number", "null"] },
              age_source: { type: ["string", "null"], description: "rdap | whois | wayback_estimate | null (undetermined)" },
              first_archived_at: { type: ["string", "null"] },
              archive_snapshot_estimate: { type: ["number", "null"] },
              registration_to_archive_gap_days: { type: ["number", "null"] },
              maturity: { type: "string" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            domain: "example.com",
            created_at: "1995-08-14T04:00:00Z",
            age_days: 11260,
            age_years: 30.8,
            age_source: "rdap",
            first_archived_at: "1996-12-02T00:00:00Z",
            archive_snapshot_estimate: 5400,
            registration_to_archive_gap_days: 476,
            maturity: "established",
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /github-intel/analyze": githubIntelRouteConfig,
  // Same paid endpoint, accessible via POST with a JSON body for agents that send
  // one (previously a 405). Shares the exact config above — no drift.
  "POST /github-intel/analyze": githubIntelRouteConfig,
  "GET /holidays/check": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.holidays,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Look up public holidays for any country and year, check whether a specific date is a holiday, and calculate the next business day — so agents can handle scheduling, SLA calculations, deadline setting, and date-aware workflows without hardcoding country-specific holiday rules.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            country_code: {
              type: "string",
              description: "ISO 3166-1 alpha-2 country code (e.g. US, GB, DE)",
            },
            year: {
              type: "integer",
              description: "4-digit year (default: current year, range 2000-2099)",
            },
            date: {
              type: "string",
              description: "YYYY-MM-DD specific date to check — populates date_check with {date, is_holiday, is_weekend, is_business_day, holiday_name, next_business_day}; omitted → date_check is null",
            },
          },
          required: ["country_code"],
        },
        // Include `date` so the example demonstrates the date_check shape —
        // it's the endpoint's most agent-useful mode (is this a business day?).
        input: { country_code: "US", year: 2026, date: "2026-07-03" },
        output: {
          schema: {
            type: "object",
            properties: {
              country_code: { type: "string" },
              year: { type: "number" },
              total_holidays: { type: "number" },
              holidays: { type: "array" },
              date_check: { type: ["object", "null"] },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          // Live output of the input above (holiday list truncated).
          example: {
            country_code: "US",
            year: 2026,
            total_holidays: 17,
            holidays: [
              {
                date: "2026-01-01",
                name: "New Year's Day",
                local_name: "New Year's Day",
                is_global: true,
                types: ["Public", "Bank"],
              },
            ],
            date_check: {
              date: "2026-07-03",
              is_holiday: true,
              is_weekend: false,
              is_business_day: false,
              holiday_name: "Independence Day",
              next_business_day: "2026-07-06",
            },
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /ip-geo/locate": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.ipGeo,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "IP geolocation lookup (geoip / IP location API) — geolocate any IPv4 or IPv6 address to city, region, country, latitude/longitude, timezone, and ISP/ASN as structured JSON so agents can localize content and enrich user records without a paid geolocation subscription. For proxy/VPN/anonymizer or hosting/datacenter detection, use /ip-risk/score or /ip-reputation/analyze.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            ip: {
              type: "string",
              description: "IPv4 or IPv6 address to geolocate (e.g. 8.8.8.8)",
            },
          },
          required: ["ip"],
        },
        input: { ip: "8.8.8.8" },
        output: {
          schema: {
            type: "object",
            properties: {
              ip: { type: "string" },
              country: { type: ["string", "null"] },
              country_code: { type: ["string", "null"] },
              region: { type: ["string", "null"] },
              region_name: { type: ["string", "null"] },
              city: { type: ["string", "null"] },
              zip: { type: ["string", "null"] },
              latitude: { type: ["number", "null"] },
              longitude: { type: ["number", "null"] },
              timezone: { type: ["string", "null"] },
              isp: { type: ["string", "null"] },
              organization: { type: ["string", "null"] },
              asn: { type: ["string", "null"] },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", description: "Geo fields are null (score 40) when all upstream geo providers decline — retry later rather than treating as a hard failure" },
            },
          },
          example: {
            ip: "8.8.8.8",
            country: "United States",
            country_code: "US",
            region: "VA",
            region_name: "Virginia",
            city: "Ashburn",
            zip: "20149",
            latitude: 39.0438,
            longitude: -77.4874,
            timezone: "America/New_York",
            isp: "Google LLC",
            organization: "Google LLC",
            asn: "AS15169",
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /jwt-inspector/decode": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.jwtInspector,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Decode and inspect any JWT token — extracts header algorithm, payload claims, expiry status, issued-at time, audience, issuer, and subject without requiring the secret — so agents can debug auth issues, check token expiry, and extract identity claims from tokens in pipelines.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            token: {
              type: "string",
              description: "JWT token string (3 dot-separated segments); a 'Bearer ' prefix is stripped automatically",
            },
          },
          required: ["token"],
        },
        input: { token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c" },
        output: {
          schema: {
            type: "object",
            properties: {
              valid_structure: { type: "boolean" },
              header: { type: "object" },
              payload: { type: "object" },
              is_expired: { type: ["boolean", "null"], description: "null when the token has no exp claim" },
              seconds_until_expiry: { type: ["number", "null"] },
              human_expiry: { type: ["string", "null"] },
              signature_hex: { type: "string" },
              signature_present: { type: "boolean" },
              security_flags: { type: "array" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          // Live output of decoding the input token above (the canonical
          // jwt.io demo token, which has no exp claim).
          example: {
            valid_structure: true,
            header: {
              algorithm: "HS256",
              token_type: "JWT",
              key_id: null,
            },
            payload: {
              issuer: null,
              subject: "1234567890",
              audience: null,
              expires_at: null,
              expires_at_unix: null,
              issued_at: "2018-01-18T01:30:22.000Z",
              issued_at_unix: 1516239022,
              not_before: null,
              jwt_id: null,
              custom_claims: { name: "John Doe" },
            },
            is_expired: null,
            seconds_until_expiry: null,
            human_expiry: null,
            signature_hex: "49f94ac7044948c78a285d904f87f0a4c7897f7e8f3a4eb2255fda750b2cc397",
            signature_present: true,
            security_flags: ["no_expiry"],
            score: 80,
            grade: "B",
            findings: [{ rule: "no_expiry_claim", label: "No expiry claim", impact: -20, detail: "JWT has no exp claim — token never expires" }],
          },
        },
      }),
    },
  },
  "POST /lang-detect/analyze": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.langDetect,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Detect the language of any text input using stopword-set matching and Unicode script analysis — returns the detected language, ISO code, a high/medium/low confidence level, and top alternative languages so agents can route multilingual content, trigger translation workflows, and classify text without a paid NLP API.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Text to detect the language of (1-10000 characters)",
            },
          },
          required: ["text"],
        },
        // ~40 stopword-rich words — short samples land confidence "medium",
        // which contradicted the "high" shown in the example below.
        input: { text: "The report shows that the team finished the project on time and that the results were better than we expected. We will share the findings with the rest of the company at the meeting and then decide what to do next." },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              detected_language: { type: "string" },
              language_code: { type: "string" },
              confidence: { type: "string" },
              script: { type: "string" },
              is_multilingual: { type: "boolean" },
              alternatives: { type: "array" },
              text_length: { type: "number" },
              word_count: { type: "number" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          // Live output of the input above.
          example: {
            detected_language: "English",
            language_code: "en",
            confidence: "high",
            script: "Latin",
            is_multilingual: false,
            alternatives: [
              { language: "Polish", code: "pl", score: 0.05 },
              { language: "Czech", code: "cs", score: 0.05 },
              { language: "Portuguese", code: "pt", score: 0.02 },
            ],
            text_length: 214,
            word_count: 41,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /npm-intel/analyze": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.npmIntel,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Fetch metadata for any npm package — download counts, latest version, version count, dependency/devDependency counts, maintainers, repository URL, license, and a health score based on maintenance signals — so agents can evaluate dependencies, audit package ecosystems, and assess supply chain risk. (Returns counts, not the full version/dependency lists.)",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            package: {
              type: "string",
              description: "npm package name (e.g. express, @types/node)",
            },
          },
          required: ["package"],
        },
        input: { package: "express" },
        output: {
          schema: {
            type: "object",
            properties: {
              package: { type: "string" },
              description: { type: ["string", "null"] },
              latest_version: { type: ["string", "null"] },
              total_versions: { type: "number" },
              weekly_downloads: { type: "number" },
              license: { type: ["string", "null"] },
              repository: { type: ["string", "null"] },
              homepage: { type: ["string", "null"] },
              keywords: { type: "array" },
              maintainers: { type: "array" },
              maintainer_count: { type: "number" },
              dependency_count: { type: "number" },
              dev_dependency_count: { type: "number" },
              created_at: { type: ["string", "null"] },
              latest_published_at: { type: ["string", "null"] },
              days_since_last_publish: { type: ["number", "null"] },
              is_deprecated: { type: "boolean" },
              deprecation_message: { type: ["string", "null"] },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            package: "express",
            description: "Fast, unopinionated, minimalist web framework",
            latest_version: "4.18.2",
            total_versions: 265,
            weekly_downloads: 34521000,
            license: "MIT",
            repository: "https://github.com/expressjs/express",
            homepage: "https://expressjs.com",
            keywords: ["web", "framework", "http"],
            maintainers: ["dougwilson", "wesleytodd"],
            maintainer_count: 2,
            dependency_count: 31,
            dev_dependency_count: 12,
            created_at: "2010-05-22T00:00:00Z",
            latest_published_at: "2023-02-14T00:00:00Z",
            days_since_last_publish: 390,
            is_deprecated: false,
            deprecation_message: null,
            score: 72,
            grade: "C",
            findings: [
              { rule: "stale_package", deduction: -15, detail: "Last published 390 days ago" },
            ],
          },
        },
      }),
    },
  },
  "GET /sitemap-parser/fetch": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.sitemapParser,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Fetch and parse any XML sitemap or sitemap index file — returns URLs with their priority, change frequency, and last modified date, follows sitemap indexes one level deep (first 3 child sitemaps), and auto-discovers the sitemap from robots.txt or common paths when given a bare domain — so agents can enumerate site content for crawling, indexing, and SEO analysis.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Sitemap URL or domain name to parse (e.g. https://example.com/sitemap.xml or example.com)",
            },
            limit: {
              type: "integer",
              description: "Maximum number of URLs to return (1-1000, default 100)",
            },
          },
          required: ["url"],
        },
        // example.com serves NO sitemap — the previous example 404'd for every
        // agent that copied it (verified live). sitemaps.org's own sitemap is
        // stable, small, and thematically on-point.
        input: { url: "https://www.sitemaps.org/sitemap.xml" },
        output: {
          schema: {
            type: "object",
            properties: {
              source_url: { type: ["string", "null"], description: "null when no sitemap was found/parseable (graceful 200 with grade F)" },
              sitemap_type: { type: ["string", "null"] },
              total_urls: { type: "number" },
              urls_returned: { type: "number" },
              child_sitemaps_fetched: { type: "number" },
              urls: { type: "array", items: { type: "object" } },
              stats: { type: "object" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            source_url: "https://www.sitemaps.org/sitemap.xml",
            sitemap_type: "urlset",
            total_urls: 847,
            urls_returned: 100,
            child_sitemaps_fetched: 0,
            urls: [
              {
                url: "https://www.sitemaps.org/protocol.html",
                last_modified: "2024-03-01T00:00:00Z",
                change_frequency: "weekly",
                priority: 0.8,
              },
            ],
            stats: {
              newest_url_date: "2024-03-10T00:00:00Z",
              oldest_url_date: "2020-01-01T00:00:00Z",
              avg_priority: 0.6,
              has_lastmod: true,
              has_priority: true,
              has_changefreq: true,
            },
            score: 88,
            grade: "B",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /url-safety/check": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.urlSafety,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Check a URL against URLhaus malware database and heuristic phishing pattern analysis — returns threat classification, malware family if known, threat confidence, and risk score so agents can screen links before following them or sharing them in automated workflows.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "URL to check for malware and phishing indicators (e.g. https://example.com/page)",
            },
          },
          required: ["url"],
        },
        input: { url: "https://example.com/page" },
        output: {
          schema: {
            type: "object",
            properties: {
              url: { type: "string" },
              in_urlhaus: { type: "boolean" },
              urlhaus_status: { type: ["string", "null"] },
              threat_type: { type: ["string", "null"] },
              malware_families: { type: "array", items: { type: "string" } },
              blacklisted_gsb: { type: "boolean" },
              blacklisted_surbl: { type: "boolean" },
              heuristic_flags: { type: "array", items: { type: "string" } },
              threat_classification: { type: "string" },
              confidence: { type: "string" },
              urlhaus_reference: { type: ["string", "null"], description: "URLhaus entry link when the URL is listed" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array" },
            },
          },
          example: {
            url: "https://example.com/page",
            in_urlhaus: false,
            urlhaus_status: null,
            threat_type: null,
            malware_families: [],
            blacklisted_gsb: false,
            blacklisted_surbl: false,
            urlhaus_reference: null,
            heuristic_flags: [],
            threat_classification: "clean",
            confidence: "none",
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /bulk-domain/check": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.bulkDomain,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Check availability of many domain names across multiple TLDs in a single call — submit up to 50 name/TLD combinations and get back per-domain registration status, registrar, and expiry concurrently, so agents can scan an entire naming shortlist or brand portfolio in one request instead of dozens. Caveat: when both RDAP and DNS are unreachable, status reads 'available' — re-check surprising availables on premium names.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description: "1-50 domain names to check (alphanumeric + hyphens, 2-63 chars each), e.g. [\"acme\", \"acmehq\"]",
            },
            tlds: {
              type: "array",
              items: { type: "string" },
              description: "TLDs to check, with or without leading dot (default: [\".com\",\".net\",\".org\",\".io\",\".co\"]). Total names × tlds must not exceed 50.",
            },
          },
          required: ["names"],
        },
        input: { names: ["acme", "acmehq"], tlds: [".com", ".io", ".ai"] },
        bodyType: "json",
        output: {
          schema: {
            type: "object",
            properties: {
              total_checked: { type: "number" },
              available_count: { type: "number" },
              taken_count: { type: "number" },
              names_available_all_tlds: { type: "array", items: { type: "string" } },
              results: { type: "array", items: { type: "object" } },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          example: {
            total_checked: 6,
            available_count: 2,
            taken_count: 4,
            names_available_all_tlds: ["acmehq"],
            results: [
              {
                domain: "acme.com",
                name: "acme",
                tld: "com",
                available: false,
                status: "registered",
                registrar: "GoDaddy LLC",
                expires_at: "2025-06-01T00:00:00Z",
                days_until_expiry: 79,
              },
              {
                domain: "acmehq.io",
                name: "acmehq",
                tld: "io",
                available: true,
                status: "available",
                registrar: null,
                expires_at: null,
                days_until_expiry: null,
              },
            ],
            score: 65,
            grade: "C",
            findings: [
              { rule: "low_availability", deduction: -35, detail: "Only 2 of 6 combinations available" },
            ],
          },
        },
      }),
    },
  },
  "GET /domain-appraise/estimate": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.domainAppraise,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Estimate the market value tier of a domain name using transparent heuristics — length, TLD premium, dictionary-word presence, pronounceability, keyword value, and numeric/hyphen penalties — returns a value tier and 0-100 quality score so agents can triage domain portfolios and prioritize acquisitions without a paid appraisal service.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain name to appraise (e.g. pay.com)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "pay.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              name: { type: "string" },
              tld: { type: "string" },
              value_score: { type: "number" },
              value_tier: { type: "string" },
              factors: { type: "array", items: { type: "object" } },
              characteristics: { type: "object" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          example: {
            domain: "pay.com",
            name: "pay",
            tld: "com",
            value_score: 100,
            value_tier: "premium",
            factors: [
              { factor: "length", impact: 35, detail: "3-character name (ultra premium)" },
              { factor: "tld", impact: 25, detail: ".com TLD" },
              { factor: "dictionary_word", impact: 20, detail: "Exact dictionary word" },
              { factor: "keyword_category", impact: 10, detail: "Finance keyword: pay" },
            ],
            characteristics: {
              length: 3,
              is_dictionary_word: true,
              has_hyphen: false,
              has_number: false,
              pronounceable: true,
            },
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /domain-report/analyze": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.domainReport,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "One call returns a complete intelligence profile for a domain — WHOIS registration, DNS records, SSL certificate, detected tech stack, and blacklist status — aggregated into a single risk-scored report so agents can fully vet a domain without orchestrating five separate lookups.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain name to profile (e.g. example.com)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "example.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              resolved_ip: { type: "string" },
              overall_score: { type: "number" },
              grade: { type: "string" },
              risk_level: { type: "string" },
              sections: { type: "object" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          // section_ok only fires when NO deductions did — it must pair with
          // a 100 score (the previous 78-with-section_ok was contradictory).
          example: {
            domain: "example.com",
            resolved_ip: "93.184.216.34",
            overall_score: 100,
            grade: "A",
            risk_level: "low",
            sections: {
              whois: {
                available: true,
                registrar: "MarkMonitor Inc.",
                created_at: "1995-08-14T04:00:00Z",
                expires_at: "2025-08-13T04:00:00Z",
                days_until_expiry: 425,
                status: ["client transfer prohibited"],
              },
              dns: {
                available: true,
                a_records: ["93.184.216.34"],
                mx_records: ["mail.example.com"],
                ns_records: ["a.iana-servers.net", "b.iana-servers.net"],
                txt_records: ["v=spf1 -all"],
              },
              ssl: {
                available: true,
                issuer: "DigiCert Inc",
                valid_from: "2024-01-01T00:00:00Z",
                valid_to: "2025-01-01T00:00:00Z",
                days_until_expiry: 200,
                san_count: 3,
              },
              tech: {
                available: true,
                server: "ECS",
                cdn: "Cloudflare",
                cms: null,
                waf: "Cloudflare WAF",
              },
              blacklist: {
                available: true,
                listed_count: 0,
                lists_checked: 5,
                listed_on: [],
              },
            },
            findings: [
              { rule: "section_ok", deduction: 0, detail: "All five checks completed" },
            ],
          },
        },
      }),
    },
  },
  "GET /ip-risk/score": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.ipRisk,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "One call returns a complete risk profile for an IP address — geolocation, ASN/network owner, blacklist status across multiple DNSBLs, and proxy/VPN/hosting classification — aggregated into a single verdict so agents can make a block/allow decision without calling four separate IP endpoints.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            ip: {
              type: "string",
              description: "IPv4 or IPv6 address to risk-score (private/reserved ranges are rejected; DNSBL blacklist checks are IPv4-only and are skipped for IPv6 with a blacklist_skipped_ipv6 finding)",
            },
          },
          required: ["ip"],
        },
        input: { ip: "8.8.8.8" },
        output: {
          schema: {
            type: "object",
            properties: {
              ip: { type: "string" },
              risk_score: { type: "number" },
              grade: { type: "string" },
              recommendation: { type: "string" },
              geo: { type: "object" },
              network: { type: "object" },
              blacklist: { type: "object" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          // Live output of the input above (the previous fabricated example's
          // findings couldn't produce its own risk_score — keep this one real).
          example: {
            ip: "8.8.8.8",
            risk_score: 80,
            grade: "B",
            recommendation: "allow",
            geo: {
              available: true,
              country: "United States",
              country_code: "US",
              city: "Ashburn",
              timezone: "America/New_York",
              isp: "Google LLC",
              is_proxy: false,
              is_hosting: true,
              is_mobile: false,
            },
            network: {
              available: true,
              asn: "AS15169",
              organization: "Google LLC",
              classification: "cloud",
            },
            blacklist: {
              available: true,
              listed_count: 0,
              lists_checked: 8,
              listed_on: [],
            },
            findings: [
              { rule: "is_cloud", deduction: -20, detail: "IP belongs to known cloud provider (Google LLC)" },
            ],
          },
        },
      }),
    },
  },
  "GET /name-gen/suggest": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.nameGen,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Generate brandable startup/product names from a keyword using prefixes, suffixes, blends, and phonetic patterns, then check .com (or any TLD) availability for each via DNS — returns available names ranked by a brandability heuristic so agents can find a claimable brand without manual brainstorming plus one-by-one availability checks.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            keyword: {
              type: "string",
              description: "Seed keyword to generate names from (2-20 alphanumeric chars, e.g. cloud)",
            },
            tld: {
              type: "string",
              description: "TLD to check availability against (default: com)",
            },
            limit: {
              type: "number",
              description: "Max names to generate and check (default: 25, max: 40)",
            },
          },
          required: ["keyword"],
        },
        input: { keyword: "cloud" },
        output: {
          schema: {
            type: "object",
            properties: {
              keyword: { type: "string" },
              tld: { type: "string" },
              generated_count: { type: "number" },
              available_count: { type: "number" },
              suggestions: { type: "array", items: { type: "object" } },
              top_available: { type: "array", items: { type: "string" } },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          example: {
            keyword: "cloud",
            tld: "com",
            generated_count: 25,
            available_count: 9,
            suggestions: [
              { name: "cloudly", domain: "cloudly.com", available: true, brandability: 90, pattern: "suffix" },
              { name: "getcloud", domain: "getcloud.com", available: false, brandability: 80, pattern: "prefix" },
            ],
            top_available: ["cloudly.com", "cloudkit.com", "cloudflow.com"],
            score: 75,
            grade: "B",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /tld-price/compare": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.tldPrice,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Reference registration/renewal/transfer pricing from a curated table of ~21 common TLDs — Mode A: price one TLD (typical register/renew/transfer cost + renewal-markup %); Mode B: price a name across all covered TLDs, sorted cheapest-first with cheapest/cheapest_premium picks. Reference prices, not live per-registrar quotes — for budgeting and spotting predatory renewal markups; TLDs outside the table return pricing:null.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            tld: {
              type: "string",
              description:
                "A TLD with or without leading dot to compare registrar pricing for, e.g. .com (Mode A). Provide exactly one of tld or name.",
            },
            name: {
              type: "string",
              description:
                "A domain name without TLD to price across many TLDs, e.g. acme (Mode B). Provide exactly one of tld or name.",
            },
          },
        },
        input: { tld: ".io" },
        output: {
          schema: {
            type: "object",
            properties: {
              mode: { type: "string" },
              tld: { type: "string" },
              name: { type: "string" },
              pricing: { type: ["object", "null"], description: "null for TLDs outside the reference table (unknown_tld finding)" },
              renewal_markup_pct: { type: ["number", "null"] },
              predatory_renewal: { type: "boolean" },
              cheapest: { type: "object" },
              cheapest_premium: { type: "object" },
              options: { type: "array", items: { type: "object" } },
              is_reference_pricing: { type: "boolean" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          example: {
            mode: "tld",
            tld: "io",
            pricing: { register: 39.99, renew: 49.99, transfer: 39.99, currency: "USD" },
            renewal_markup_pct: 25,
            predatory_renewal: false,
            is_reference_pricing: true,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /typosquat/scan": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.typosquat,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Generate common typo and look-alike variations of a domain and check which are already registered — catches character swaps, omissions, additions, homoglyphs, and alternate TLDs so agents can detect typosquatting and brand-impersonation domains targeting a company.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain to scan for typosquat look-alikes (e.g. google.com) — must include a TLD",
            },
            limit: {
              type: "number",
              description: "Max variations to generate and check (default: 30, max: 50)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "google.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              name: { type: "string" },
              tld: { type: "string" },
              variations_checked: { type: "number" },
              registered_count: { type: "number" },
              available_count: { type: "number" },
              registered_lookalikes: { type: "array", items: { type: "object" } },
              available_variations: { type: "array", items: { type: "object" } },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          // Live output shape (lookalike list truncated). A registered
          // homoglyph and a registered alternate-TLD ALWAYS add their own
          // findings, so the findings list must include all three rules here.
          example: {
            domain: "google.com",
            name: "google",
            tld: "com",
            variations_checked: 10,
            registered_count: 10,
            available_count: 0,
            registered_lookalikes: [
              { domain: "g00gle.com", technique: "homoglyph", registered: true },
              { domain: "gogle.com", technique: "omission", registered: true },
              { domain: "google.net", technique: "alternate_tld", registered: true },
            ],
            available_variations: [],
            score: 35,
            grade: "D",
            findings: [
              { rule: "high_typosquat_exposure", deduction: -40, detail: "10 of 10 look-alike domains are registered" },
              { rule: "homoglyph_registered", deduction: -15, detail: "A homoglyph look-alike domain is registered (highest phishing risk)" },
              { rule: "alt_tld_registered", deduction: -10, detail: "An alternate-TLD look-alike domain is registered" },
            ],
          },
        },
      }),
    },
  },
  "GET /domain-due-diligence": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.domainDueDiligence,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "One call combines domain availability, heuristic value appraisal, and TLD pricing into a single acquisition brief — tells an agent whether a name is available, what it's worth, and what it costs across TLDs, concurrently and with graceful partial-failure handling.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain to assess, including TLD (e.g. acme.com)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "acme.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              name: { type: "string" },
              tld: { type: "string" },
              generated_at: { type: "string" },
              sections: { type: "object" },
              sections_ok: { type: "number" },
              sections_failed: { type: "number" },
              verdict: { type: "string", description: "available_strong | available_weak | taken_premium | taken_low | unknown" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          example: {
            domain: "acme.com",
            name: "acme",
            tld: "com",
            generated_at: "2026-06-16T01:00:00Z",
            sections: {
              availability: { available: true, is_available: false, status: "registered", registrar: "GoDaddy LLC", expires_at: "2025-06-01T00:00:00Z" },
              appraisal: { available: true, value_tier: "premium", value_score: 95 },
              tld_pricing: { available: true, cheapest: { domain: "acme.xyz", register: 1.99 }, cheapest_premium: { domain: "acme.com", register: 10.99 } },
            },
            sections_ok: 3,
            sections_failed: 0,
            verdict: "taken_premium",
            score: 80,
            grade: "B",
            findings: [
              { rule: "not_available", deduction: -20, detail: "acme.com is already registered" },
            ],
          },
        },
      }),
    },
  },
  "GET /domain-report/full": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.domainReportFull,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "One premium call returns a complete six-part domain profile — DNS records, SSL certificate, WHOIS registration, cloud fingerprint, technology stack, and security headers — each section run concurrently with graceful partial-failure handling, so agents get an entire domain workup in a single request instead of orchestrating six.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain to profile, including TLD (e.g. example.com)",
            },
          },
          required: ["domain"],
        },
        input: { domain: "example.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              generated_at: { type: "string" },
              sections: { type: "object" },
              sections_ok: { type: "number" },
              sections_failed: { type: "number" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          example: {
            domain: "example.com",
            generated_at: "2026-06-16T01:00:00Z",
            sections: {
              dns: { available: true, a_records: ["93.184.216.34"], mx_records: ["mail.example.com"], ns_records: ["a.iana-servers.net"], txt_records: ["v=spf1 -all"] },
              ssl: { available: true, issuer: "DigiCert Inc", valid_to: "Feb 13 23:59:59 2027 GMT", days_until_expiry: 200 },
              whois: { available: true, registrar: "MarkMonitor Inc.", created_at: "1995-08-14T04:00:00Z", expires_at: "2027-08-13T04:00:00Z", days_until_expiry: 425 },
              cloud: { available: true, provider: "Cloudflare", cdn: "Cloudflare", dns_provider: "Cloudflare DNS", grade: "A" },
              tech: { available: true, server: "Nginx", cdn: "Cloudflare", cms: null, waf: "Cloudflare WAF" },
              security_headers: { available: true, grade: "B", hsts: true, csp: false },
            },
            // All-sections-ok with no content deductions ⇒ score 100 (the
            // previous 80-with-zero-deductions example was unreachable).
            sections_ok: 6,
            sections_failed: 0,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "POST /domain/vendor-risk": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.domainVendorRisk,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "Composite 0-100 trust/risk score for a domain in one call — blends domain age, SSL/TLS, DNS health, email auth (SPF/DKIM/DMARC), IP reputation, and certificate transparency into a single \"safe to do business with this domain?\" verdict with per-signal breakdown and actionable flags. Partial results never read as safe.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Bare domain, e.g. acme.com",
            },
          },
          required: ["domain"],
        },
        input: { domain: "example.com" },
        bodyType: "json",
        // NOTE: keep this discovery blob terse. The full 6-signal example + fully
        // described schema pushed the encoded 402 payload past CDP's paymentPayload
        // size limit (verify 400). Trimmed to a 3-signal partial example + a
        // description-free schema; see memory x402-paymentpayload-size-limit.
        output: {
          schema: {
            type: "object",
            properties: {
              domain: { type: "string" },
              risk_score: { type: "number" },
              risk_band: { type: "string" },
              signals: { type: "object" },
              flags: { type: "array", items: { type: "string" } },
              signals_unavailable: { type: "array", items: { type: "string" } },
              confidence: { type: "string" },
              run_id: { type: "string" },
              duration_ms: { type: "number" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          // Representative 3-signal partial run (the other 3 unavailable): missing
          // email auth drags an otherwise-healthy domain to risk_band "medium".
          example: {
            domain: "example.com",
            risk_score: 69,
            risk_band: "medium",
            signals: {
              domain_age: { score: 100, detail: "Registered 1995-08, 29.9 yrs" },
              ssl: { score: 95, detail: "Valid, TLSv1.3, expires in 210d" },
              email_auth: { score: 12, detail: "SPF missing, DMARC missing" },
            },
            flags: ["dmarc_missing", "spf_missing"],
            signals_unavailable: ["dns", "ip_reputation", "cert_transparency"],
            confidence: "partial",
            run_id: "b3f1c2a4-9d8e-4c7a-9f21-6e2d5a1b0c3d",
            duration_ms: 1420,
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /email-report/full": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.emailReportFull,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "One call combines domain email authentication (SPF/DKIM/DMARC), email-address intelligence (deliverability, disposable/role detection), and an optional password breach check into a single email-trust report — each section run concurrently with graceful partial-failure handling — so agents can fully vet an email and its domain in one request.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            email: {
              type: "string",
              description: "Email address to vet (e.g. user@example.com)",
            },
            password: {
              type: "string",
              description: "Optional password — if supplied, the breach section returns {breached, breach_count, risk_level} from a k-anonymity HIBP check; omitted → breach reports error:\"not_requested\"",
            },
          },
          required: ["email"],
        },
        input: { email: "user@example.com" },
        output: {
          schema: {
            type: "object",
            properties: {
              email: { type: "string" },
              domain: { type: "string" },
              generated_at: { type: "string" },
              sections: { type: "object" },
              sections_ok: { type: "number" },
              sections_failed: { type: "number" },
              trust_verdict: { type: "string" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          example: {
            email: "user@example.com",
            domain: "example.com",
            generated_at: "2026-06-16T01:00:00Z",
            sections: {
              authentication: { available: true, spf: "pass", dkim: "present", dmarc: "p=reject" },
              intelligence: { available: true, deliverability: "deliverable", is_disposable: false, is_role_based: false, is_free_provider: false },
              breach: { available: false, error: "not_requested" },
            },
            sections_ok: 2,
            sections_failed: 0,
            trust_verdict: "trusted",
            score: 100,
            grade: "A",
            findings: [],
          },
        },
      }),
    },
  },
  "GET /ip-report/full": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.ipReportFull,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "One premium call returns a complete five-part IP profile — geolocation, ASN/network ownership, multi-DNSBL blacklist status, threat reputation, and an aggregate risk verdict — run concurrently with graceful partial-failure handling, so agents get a full IP workup and a block/allow decision in a single request.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            ip: {
              type: "string",
              description: "IPv4 or IPv6 address to profile (private/reserved ranges are rejected; the blacklist section is IPv4-only and reports error:\"ipv4_only\" for IPv6 input)",
            },
          },
          required: ["ip"],
        },
        input: { ip: "8.8.8.8" },
        output: {
          schema: {
            type: "object",
            properties: {
              ip: { type: "string" },
              generated_at: { type: "string" },
              sections: { type: "object" },
              sections_ok: { type: "number" },
              sections_failed: { type: "number" },
              overall_recommendation: { type: "string" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          // Reflects the live response for 8.8.8.8: a cloud-classified IP
          // ALWAYS carries the is_proxy_or_hosting -20 finding that produces
          // score 80 — findings can't be [] here.
          example: {
            ip: "8.8.8.8",
            generated_at: "2026-06-16T01:00:00Z",
            sections: {
              geo: { available: true, country: "United States", city: "Mountain View", timezone: "America/Los_Angeles", isp: "Google LLC" },
              network: { available: true, asn: "AS15169", organization: "Google LLC", classification: "cloud" },
              blacklist: { available: true, listed_count: 0, lists_checked: 15, listed_on: [] },
              reputation: { available: true, abuse_confidence: 0, otx_pulses: 0 },
              risk: { available: true, risk_score: 80, recommendation: "allow" },
            },
            sections_ok: 5,
            sections_failed: 0,
            overall_recommendation: "allow",
            score: 80,
            grade: "B",
            findings: [
              { rule: "is_proxy_or_hosting", deduction: -20, detail: "Network classified as cloud infrastructure" },
            ],
          },
        },
      }),
    },
  },
  "GET /url-safety/full": {
    accepts: [
      {
        scheme: "exact",
        price: pricing.urlSafetyFull,
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description:
      "One call vets a URL end to end — traces its full redirect chain, checks it against the URLhaus malware database plus phishing heuristics, audits its security headers, and inspects its SSL certificate — concurrent with graceful partial-failure handling, so agents get a complete safety verdict before following a link.",
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "URL to vet, including scheme (e.g. https://example.com/page)",
            },
          },
          required: ["url"],
        },
        input: { url: "https://example.com/page" },
        output: {
          schema: {
            type: "object",
            properties: {
              url: { type: "string" },
              generated_at: { type: "string" },
              sections: { type: "object" },
              sections_ok: { type: "number" },
              sections_failed: { type: "number" },
              final_url: { type: "string" },
              safety_verdict: { type: "string" },
              score: { type: "number" },
              grade: { type: "string" },
              findings: { type: "array", items: { type: "object" } },
            },
          },
          example: {
            url: "https://example.com/page",
            generated_at: "2026-06-16T01:00:00Z",
            sections: {
              redirects: { available: true, hops: 1, final_url: "https://www.example.com/page", open_redirect: false },
              malware: { available: true, in_urlhaus: false, threat_classification: "clean", heuristic_flags: [] },
              security_headers: { available: true, present: ["Strict-Transport-Security"], missing: ["Content-Security-Policy"] },
              ssl: { available: true, valid: true, issuer: "DigiCert Inc", days_until_expiry: 200 },
            },
            sections_ok: 4,
            sections_failed: 0,
            final_url: "https://www.example.com/page",
            safety_verdict: "safe",
            // A missing CSP carries no deduction (only missing_hsts does) and
            // the finding below deducts 0, so the coherent score here is 100.
            score: 100,
            grade: "A",
            findings: [
              { rule: "redirects_elsewhere", deduction: 0, detail: "URL redirects to a different final destination — consider re-checking final_url" },
            ],
          },
        },
      }),
    },
  },
};

// --- x402 wiring (AVM / Algorand) -------------------------------------------
// Receive-only seller: no createAuthHeaders, no signing key. The payer's wallet
// plus the GoPlausible facilitator perform settlement.
const FACILITATOR_URL = "https://facilitator.goplausible.xyz";

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient);

// Registers the algorand:* wildcard exact scheme. The USDC ASA is DERIVED from
// the CAIP-2 network id by the SDK (mainnet -> 31566704, testnet -> 10458941),
// which is why flipping nets is a config-only change.
registerExactAvmScheme(resourceServer);

// Enriches the 402 PaymentRequired declaration with the input/output examples
// each route declares, so endpoints list richly in the facilitator's discovery
// catalog rather than as a bare URL+price. Discovery metadata only — it does
// not touch verification or settlement.
resourceServer.registerExtension(bazaarResourceServerExtension);

// --- App --------------------------------------------------------------------
const app = express();
// Behind Railway's proxy: trust X-Forwarded-Proto so req.protocol is "https"
// and the discovery artifacts advertise https URLs when PUBLIC_BASE_URL is unset.
app.set("trust proxy", true);
app.use(express.json());

// --- Paid-call analytics (passive observer; algo_* tables only) --------------
// Writes into the shared NetIntel Postgres but only ever into this service's own
// algo_paid_call_events / _failures / _misses tables — never the Base/EVM ones.
// Optional: without DATABASE_URL events fall back to NDJSON + tagged stdout.
// Init failures are non-fatal (receive-only resilience).
const paidCallStore = createStore(process.env);
const paidCallFailureStore = createStore(process.env, {
  table: "algo_paid_call_failures",
  fileName: "algo-paid-call-failures.ndjson",
  stdoutTag: "ALGO_PAID_CALL_FAILURE",
});
const missStore = createMissStore(process.env);
console.log(`Paid-call storage: ${paidCallStore.describe()}`);
for (const [name, s] of [
  ["events", paidCallStore],
  ["failures", paidCallFailureStore],
  ["misses", missStore],
] as const) {
  s.init()
    .then(() => console.log(`[paid-call] ${name} schema ready`))
    .catch((err) => console.error(`[paid-call] ${name} init failed (non-fatal):`, err));
}

// Registered BEFORE the payment middleware so it brackets the whole request
// (verification + handler + settlement) and can read PAYMENT-RESPONSE at
// res.finish. Observer only — payment behavior is unchanged.
app.use(
  createPaidCallLogger({
    store: paidCallStore,
    failureStore: paidCallFailureStore,
    priceLookup: buildPriceLookup(routes),
    network: config.network,
  })
);

// Free, unprotected health check (Railway probes this).
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", network: config.network });
});

// Free agent-discovery surfaces (/.well-known/x402, api-catalog, agent card,
// apis.json, ai-plugin.json, openapi.json, llms.txt, security.txt, robots.txt,
// and the / + /api on-ramps). Generated from the same `routes` object that
// drives the payment middleware, so the catalogs can never drift from what is
// actually served and priced. See src/discovery.ts.
app.use(
  discoveryRouter(routes as unknown as Record<string, DiscoveryRoute>, {
    network: config.network,
    payTo: config.payTo,
    facilitatorUrl: FACILITATOR_URL,
    publicBaseUrl: config.publicBaseUrl || undefined,
    supportContact: config.supportContact,
    securityContact: config.securityContact,
  })
);

// Pin every route's x402 resource URL to the canonical host (NetIntel does the
// same). Without this the SDK derives the resource from the incoming Host
// header, so a settlement that arrives on the raw *.railway.app hostname
// registers a DUPLICATE Bazaar listing under that host. Serving is unaffected —
// the middleware matches by path, never by host.
const canonicalBase = config.publicBaseUrl.trim().replace(/\/+$/, "");
if (canonicalBase) {
  for (const [key, cfg] of Object.entries(routes)) {
    (cfg as { resource?: string }).resource = `${canonicalBase}${key.split(" ")[1]}`;
  }
}

// Payment gate: only requests matching `routes` require payment. Everything else
// (health, discovery) has already been served above and passes straight through.
app.use(paymentMiddleware(routes as Record<string, RouteConfig>, resourceServer));

// --- The paid handlers (reached only once payment is satisfied) --------------
app.use(dnsRouter);
app.use(sslRouter);
app.use(subnetRouter);
app.use(redirectRouter);
app.use(securityHeadersRouter);
app.use(emailAuthRouter);
app.use(cloudFingerprintRouter);
app.use(schemaParseRouter);
app.use(classifyRouter);
app.use(messagesRouter);
app.use(aiImageAssetsRouter);
app.use(contentModerateRouter);
app.use(entityExtractRouter);
app.use(extractAddressRouter);
app.use(extractContactRouter);
app.use(extractInvoiceRouter);
app.use(extractResumeRouter);
app.use(extractTableRouter);
app.use(markdownCleanRouter);
app.use(normalizeJsonRouter);
app.use(textToJsonRouter);
app.use(sentimentRouter);
app.use(textSummarizeRouter);
app.use(translateLongRouter);
app.use(translateShortRouter);
app.use(asnLookupRouter);
app.use(whoisRdapRouter);
app.use(certTransparencyRouter);
app.use(dnsPropagationRouter);
app.use(dnssecRouter);
app.use(ipBlacklistRouter);
app.use(ipReputationRouter);
app.use(techFingerprintRouter);
app.use(breachCheckRouter);
app.use(domainAvailabilityRouter);
app.use(emailIntelRouter);
app.use(ogScraperRouter);
app.use(pageExtractRouter);
app.use(webExtractRouter);
app.use(phoneIntelRouter);
app.use(robotsTxtRouter);
app.use(rssParserRouter);
app.use(usernameCheckRouter);
app.use(waybackRouter);
app.use(cronParserRouter);
app.use(currencyExchangeRouter);
app.use(convertRouter);
app.use(moneyParseRouter);
app.use(calendarIcsRouter);
app.use(eventClassifyRouter);
app.use(eventExtractRouter);
app.use(githubIntelRouter);
app.use(holidaysRouter);
app.use(ipGeoRouter);
app.use(jwtInspectorRouter);
app.use(langDetectRouter);
app.use(npmIntelRouter);
app.use(sitemapParserRouter);
app.use(urlSafetyRouter);
app.use(bulkDomainRouter);
app.use(domainAgeRouter);
app.use(domainAppraiseRouter);
app.use(domainReportRouter);
app.use(ipRiskRouter);
app.use(nameGenRouter);
app.use(tldPriceRouter);
app.use(typosquatRouter);
app.use(domainDueDiligenceRouter);
app.use(domainReportFullRouter);
app.use(emailReportFullRouter);
app.use(ipReportFullRouter);
app.use(urlSafetyFullRouter);
app.use(domainVendorRiskRouter);

// Terminal 404: nothing matched. Record the miss (what agents ask us for that we
// don't offer — a product-discovery feed) and answer with a machine-readable 404
// pointing at the discovery manifest.
app.use(createMissLogger({ store: missStore }));

// Bind 0.0.0.0 explicitly so the container is reachable on Railway's network.
app.listen(config.port, "0.0.0.0", () => {
  const paidCount = Object.keys(routes).length;
  console.log(`netintel-algo listening on 0.0.0.0:${config.port}`);
  console.log(`  facilitator: ${FACILITATOR_URL}`);
  console.log(`  network:     ${config.network}`);
  console.log(`  payTo:       ${config.payTo}`);
  console.log(`  paid routes: ${paidCount}`);
});
