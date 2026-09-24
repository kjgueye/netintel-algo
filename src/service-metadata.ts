// Bazaar catalog metadata for every paid route: serviceName / tags / iconUrl.
//
// These are first-class RouteConfig fields (since @x402 2.18) that flow into the
// facilitator's DiscoveredHTTPResource → the CDP Bazaar catalog and x402scan
// display. They matter for DISCOVERY:
//   - `tags` is the structured retrieval channel. The 2026-07-16 rank audit
//     showed "Search terms: …" tails inside descriptions do NOT retrieve —
//     NetIntel ranked #1 for model-name queries ("gpt-4o") purely via URL-path
//     keywords, but was absent for capability queries ("chat completion",
//     "llm chat") that competitors win with tags.
//   - `serviceName` + `iconUrl` brand the listings in catalog UIs instead of a
//     bare URL.
// Sanitizer limits (enforced by @x402/extensions): serviceName ≤ 32 printable
// ASCII chars; ≤ 5 tags, each ≤ 32 chars, deduped case-insensitively; iconUrl
// must be a real https URL. Stay inside them — violations are dropped SILENTLY.
//
// ⚠ The Bazaar only re-snapshots a listing when a payment SETTLES on it — after
// changing anything here, run the test:pay sweep so listings actually refresh.
// See memory: agent-discovery-2026-07.

export const SERVICE_NAME = "NetIntel";
// Served by the free /favicon.png route; must stay https + real host.
export const ICON_URL = "https://netintel.dev/favicon.png";

// Explicit per-path tag sets for the retrieval-critical endpoints (the LLM
// surface where the capability-query gap was measured, plus flagships).
const TAG_OVERRIDES: Record<string, string[]> = {
  "/messages": ["chat completion", "llm api", "ai chat", "claude", "no api key"],
  // TAG EXPERIMENT (intel/plans/gateway-14day-2026-09/EXPOSURE-ACTION.md).
  // Baseline 2026-09-13: this path and its alias below carried BYTE-IDENTICAL tags and
  // were both ABSENT from "llm inference" and "pay per call llm" (hybrid search,
  // curatedOnly=false, limit=20, every price filter). Swapping two tags here — and
  // deliberately NOT on the alias — makes the alias a comparison control. Both get a
  // settled refresh so refresh is held constant; only tag content differs.
  // Aliases are a comparison pair, NOT proven interchangeable experimental units.
  "/v1/chat/completions": ["chat completion", "openai compatible", "llm api", "llm inference", "pay per call llm"],
  // CONTROL — leave byte-identical until the experiment concludes.
  "/api/v1/chat/completions": ["chat completion", "openai compatible", "llm api", "ai chat", "no api key"],
  "/v1/embeddings": ["embeddings", "text embeddings", "vector search", "rag", "no api key"],
  "/api/v1/embeddings": ["embeddings", "text embeddings", "vector search", "rag", "no api key"],
  "/embeddings": ["embeddings", "multilingual embeddings", "vector search", "rag", "no api key"],
  "/semantic/rank": ["semantic search", "rank", "similarity", "rag", "no api key"],
  "/ai-image/generate": ["image generation", "ai image", "logo generator", "icon generator", "no api key"],
  "/schema-parse/extract": ["structured extraction", "text to json", "llm parsing", "data extraction", "json schema"],
  "/classify": ["text classification", "zero-shot", "categorization", "intent detection", "llm"],
  "/content-moderate": ["content moderation", "toxicity detection", "safety filter", "text analysis", "llm"],
  "/entity-extract": ["entity extraction", "ner", "data extraction", "text analysis", "llm"],
  "/sentiment/analyze": ["sentiment analysis", "aspect sentiment", "emotion detection", "text analysis", "llm"],
  "/text-summarize": ["summarize", "text summary", "tldr", "key points", "article summary"],
  "/text/chunk": ["text chunking", "rag chunking", "split text", "chunk text", "rag ingestion"],
  "/text/stats": ["text statistics", "word count", "reading time", "character count", "text analysis"],
  "/text-to-json": ["text to json", "structured extraction", "json schema", "data extraction", "llm"],
  "/normalize/json": ["json normalization", "data cleaning", "schema mapping", "text to json", "llm"],
  "/json/repair": ["json repair", "fix json", "malformed json", "data cleaning", "json parser"],
  "/schema/validate": ["json schema", "validation", "data quality", "json parser", "schema check"],
  "/schema/map": ["schema mapping", "data transformation", "field mapping", "json schema", "etl"],
  "/markdown/clean": ["html to markdown", "content extraction", "markdown", "text cleaning", "web content"],
  "/currency-exchange/convert": ["currency conversion", "exchange rates", "forex", "crypto prices", "fiat"],
  "/convert": ["currency conversion", "exchange rates", "forex", "crypto prices", "fiat"],
  "/crypto/market": ["crypto price", "bitcoin price", "market data", "token price", "no api key"],
  "/gas/price": ["gas price", "gas fees", "transaction cost", "base gas", "ethereum gas"],
  "/crypto/price": ["crypto price", "token price", "coin price", "spot price", "bitcoin price"],
  "/crypto/ohlc": ["ohlc", "candles", "price history", "bitcoin history", "backtest data"],
  "/currency-exchange/batch": ["currency convert", "exchange rates", "batch fx", "forex api", "no api key"],
  "/currency-exchange/history": ["historical rates", "exchange rate history", "fx timeseries", "currency chart", "no api key"],
  "/token/info": ["token price", "market cap", "erc20", "token metadata", "contract lookup"],
  "/wallet/balance": ["wallet balance", "token balance", "address balance", "usdc balance", "wallet holdings"],
  "/wallet/intel": ["wallet intel", "wallet risk", "counterparty check", "wallet age", "trust score"],
  "/iban/validate": ["iban", "iban validation", "bank account check", "sepa", "payment validation"],
  "/market/snapshot": ["market data", "market briefing", "fear and greed", "crypto snapshot", "no api key"],
  "/web/fetch": ["fetch url", "retrieve url content", "web content", "json api", "http get"],
  "/web/extract": ["web content", "retrieve url content", "read webpage", "html to markdown", "web reader"],
  "/page-extract/read": ["read webpage", "web content", "url to markdown", "page reader", "article extract"],
  "/weather/current": ["weather", "forecast", "current weather", "temperature", "climate"],
  "/weather/forecast": ["weather forecast", "forecast", "7 day forecast", "hourly weather", "precipitation"],
  "/prediction/markets": ["prediction markets", "polymarket", "betting odds", "event probability", "forecasting"],
  "/prediction/market": ["prediction market", "polymarket", "market odds", "event probability", "resolution"],
  "/ssl/cert": ["ssl certificate", "cert check", "certificate expiry", "tls cert", "days remaining"],
  "/exa/search": ["exa search", "web search", "neural search", "search engine", "search results"],
  "/web/search": ["web search", "internet search", "search the web", "search results", "serp"],
  "/exa/contents": ["exa contents", "page text", "url to text", "web content", "read webpage"],
  "/exa/answer": ["exa answer", "web answer", "question answering", "grounded answer", "cited answer"],
  "/email/verify": ["email verification", "verify email", "email deliverability", "email validation", "mx check"],
  // Task-vocabulary tags. The 2026-09-09 discovery audit found /dns/lookup absent
  // from CDP search for task-shaped DNS phrasings ("resolve a hostname to its
  // addresses", "mail and text records") while ranking #7 for the endpoint-shaped
  // query "dns lookup" — the old tags spent 2 of 5 slots on product-category words
  // ("dns api", "network intelligence") that appear in no user task. Every tag below
  // names a record type this route documents returning (A, MX, TXT). An override is
  // used rather than editing the "/dns" prefix rule so /dns-propagation/check and
  // /dnssec/validate keep their current tags as experiment controls.
  "/dns/lookup": ["dns lookup", "resolve hostname", "mx records", "txt records", "a record lookup"],
  // The "/dns" prefix rule below is first-match-wins, so it also swallowed
  // "/dnssec/..." and "/dns-propagation/..." — leaving a DNSSEC validator and a
  // propagation checker both advertising DNS-LOOKUP vocabulary, and making the
  // "/dnssec" prefix rule unreachable. These overrides state what each route
  // actually implements: dnssec.ts returns DS/DNSKEY/RRSIG/NSEC + chain_of_trust;
  // dns-propagation.ts queries RESOLVERS and reports propagation consistency.
  // (Neither returns TTL, so no ttl tag.)
  "/dnssec/validate": ["dnssec", "dnssec validation", "ds records", "dnskey", "rrsig signatures"],
  "/dns-propagation/check": ["dns propagation", "nameserver change", "global resolvers", "propagation check", "resolver consistency"],
};

// Family rules by path prefix — first match wins. Each ≤5 tags, ≤32 chars.
const PREFIX_TAGS: Array<[string, string[]]> = [
  ["/openai/", ["chat completion", "llm api", "ai chat", "openai", "no api key"]],
  ["/translate/", ["translation", "translate api", "localization", "language", "llm translation"]],
  ["/extract/", ["data extraction", "document parsing", "structured data", "text to json", "llm extraction"]],
  ["/dns", ["dns", "dns lookup", "domain records", "dns api", "network intelligence"]],
  ["/dnssec", ["dnssec", "dns security", "dns validation", "domain security", "dns"]],
  ["/ssl", ["ssl", "tls certificate", "https check", "certificate analysis", "security"]],
  ["/cert-transparency", ["certificate transparency", "ct logs", "ssl certificates", "subdomain discovery", "security"]],
  ["/whois", ["whois", "rdap", "domain lookup", "domain intelligence", "domain research"]],
  ["/domain", ["domain intelligence", "domain research", "domain valuation", "whois", "due diligence"]],
  ["/bulk-domain", ["domain availability", "bulk check", "domain search", "tld", "naming"]],
  ["/name-gen", ["name generator", "brand names", "domain names", "naming", "startup names"]],
  ["/tld-price", ["domain prices", "tld comparison", "registrar prices", "domain registration", "naming"]],
  ["/typosquat", ["typosquatting", "brand protection", "phishing domains", "domain security", "osint"]],
  ["/ip-", ["ip intelligence", "ip lookup", "geolocation", "ip reputation", "network intelligence"]],
  ["/asn", ["asn lookup", "bgp", "ip intelligence", "network intelligence", "autonomous system"]],
  ["/subnet", ["subnet calculator", "cidr", "ip networking", "network tools", "ip ranges"]],
  ["/email", ["email security", "spf dkim dmarc", "email verification", "deliverability", "email intelligence"]],
  ["/breach-check", ["breach check", "password security", "credential leak", "security", "osint"]],
  ["/phone-intel", ["phone validation", "phone lookup", "carrier lookup", "phone intelligence", "osint"]],
  ["/username-check", ["username search", "social media", "osint", "handle availability", "profile lookup"]],
  ["/github-intel", ["github", "repository analysis", "open source", "dependency research", "osint"]],
  ["/npm-intel", ["npm", "package analysis", "dependency research", "supply chain", "open source"]],
  ["/url-safety", ["url safety", "phishing detection", "malware check", "link scanner", "security"]],
  ["/security-headers", ["security headers", "http security", "csp", "website security", "security audit"]],
  ["/tech-fingerprint", ["tech stack", "website fingerprint", "technology detection", "web intelligence", "osint"]],
  ["/cloud-fingerprint", ["cloud provider", "cdn detection", "infrastructure", "web intelligence", "osint"]],
  ["/redirect", ["redirect trace", "url unshortener", "link analysis", "web intelligence", "security"]],
  ["/robots-txt", ["robots.txt", "crawl rules", "seo", "web intelligence", "scraping"]],
  ["/sitemap-parser", ["sitemap", "seo", "site structure", "web intelligence", "crawling"]],
  ["/rss-parser", ["rss", "feed parser", "news monitoring", "content feeds", "web content"]],
  ["/og-scraper", ["open graph", "link preview", "metadata extraction", "web content", "seo"]],
  ["/page-extract", ["web scraping", "content extraction", "article text", "web content", "readability"]],
  ["/web/", ["web scraping", "content extraction", "web content", "html parsing", "no api key"]],
  ["/wayback", ["wayback machine", "web archive", "website history", "osint", "web intelligence"]],
  ["/jwt-inspector", ["jwt", "token decoder", "authentication", "security tools", "debugging"]],
  ["/cron-parser", ["cron", "schedule parser", "cron expression", "developer tools", "automation"]],
  ["/calendar", ["ics", "calendar", "ical parser", "events", "scheduling"]],
  ["/holidays", ["holidays", "public holidays", "calendar", "scheduling", "business days"]],
  ["/money", ["money parsing", "currency amounts", "price extraction", "financial data", "parsing"]],
  ["/lang-detect", ["language detection", "text analysis", "localization", "language", "nlp"]],
  ["/event-", ["event extraction", "calendar events", "date parsing", "text analysis", "llm"]],
];

const DEFAULT_TAGS = ["network intelligence", "api for agents", "pay per call", "x402", "no api key"];

export function tagsForPath(path: string): string[] {
  const override = TAG_OVERRIDES[path];
  if (override) return override;
  for (const [prefix, tags] of PREFIX_TAGS) {
    if (path.startsWith(prefix)) return tags;
  }
  return DEFAULT_TAGS;
}

/**
 * Stamp serviceName/tags/iconUrl onto every route config (mutates in place,
 * same pattern as the canonical-host resource pin in index.ts).
 */
export function applyServiceMetadata(routes: Record<string, object>): void {
  for (const [key, cfg] of Object.entries(routes)) {
    const path = key.split(" ")[1] ?? key;
    const rc = cfg as { serviceName?: string; tags?: string[]; iconUrl?: string };
    rc.serviceName = SERVICE_NAME;
    rc.iconUrl = ICON_URL;
    rc.tags = tagsForPath(path);
  }
}
