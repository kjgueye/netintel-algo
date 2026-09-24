import "dotenv/config";

export const config = {
  payTo: process.env.PAY_TO_ADDRESS || "0xdaDc335482AD545296Fd7b28518A251fFCbEb9Df",
  network: (process.env.NETWORK || "eip155:8453") as `${string}:${string}`,
  // Solana (SVM) receiving wallet for USDC-on-Solana x402 payments. UNSET by
  // default: Solana settlement only activates on routes that add a solana
  // accepts entry, and only when this is configured — so a deploy without the
  // env var changes nothing. The wallet's USDC ATA must exist before go-live
  // (a first inbound USDC transfer creates it). See memory: solana-x402-expansion.
  solanaPayTo: process.env.SOLANA_PAY_TO || "",
  port: parseInt(process.env.PORT || "4021", 10),
  devMode: process.env.DEV_MODE === "true",
  // Canonical domain advertised by discovery artifacts (llms.txt, openapi,
  // x402 manifest, agent card, landing). When unset, artifacts fall back to the
  // request's own Host header. The app always responds on every hostname
  // regardless of this value — see resolveBaseUrl in src/base-url.ts.
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  // Security contact advertised in /.well-known/security.txt (RFC 9116). Override
  // with SECURITY_CONTACT (a mailto: or https: URL) once an inbox is set up.
  securityContact: process.env.SECURITY_CONTACT || "mailto:security@netintel.dev",
  // General/support contact shown on the landing page + discovery artifacts
  // (llms.txt, agent card, ai-plugin). Override with SUPPORT_CONTACT.
  supportContact: process.env.SUPPORT_CONTACT || "support@netintel.dev",
};

export const pricing = {
  dnsLookup: "$0.002",
  sslAnalyze: "$0.007",
  // Light, fast tier under /ssl/analyze (GET|POST /ssl/cert) — one TLS
  // handshake, cert facts only (no grading/protocol probing). Catches the
  // pure cert-expiry-check buyer class a full analysis over-serves.
  sslCertQuick: "$0.003",
  subnetCalc: "$0.005",
  redirectTrace: "$0.010",
  securityHeaders: "$0.010",
  emailAuth: "$0.002",
  cloudFingerprint: "$0.010",
  // Cut $0.100 → $0.01 on 2026-09-02: the $0.10-tolerant whale (0x035a) has been
  // gone ~1 month and traffic is near-zero, so the premium was survivorship luck,
  // not a market. Model swapped Haiku → gpt-4o-mini (see src/routes/schema-parse.ts)
  // so worst-case COGS (~$0.0046 at the 10k-word cap) clears margin at the $0.01
  // Bazaar-median price. See the pricing deep-dive.
  schemaParse: "$0.010",
  asnLookup: "$0.030",
  whoisRdap: "$0.003",
  certTransparency: "$0.010",
  dnsPropagation: "$0.030",
  dnssec: "$0.030",
  ipBlacklist: "$0.050",
  techFingerprint: "$0.050",
  breachCheck: "$0.010",
  domainAvailability: "$0.010",
  emailIntel: "$0.005",
  // Boolean-first deliverability gate (GET|POST /email/verify) — thin
  // presentation of email-intel's existing logic under the name/price agents
  // actually search for ("email verify" is the #4 x402 capability by calls;
  // the leader charges $0.001). Zero new logic, zero COGS (DNS only via the
  // shared runEmailIntel). CDP settle floor ⇒ pure margin. See
  // EXA-SEARCH-HANDOFF.md spec 24.
  emailVerify: "$0.001",
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
  // Structured spot price + 24h stats + mcap/supply from keyless upstreams
  // (Coinbase Exchange + CoinGecko) behind a 60s in-process cache, so upstream
  // load is ~1 round/min/symbol at any paid volume — effectively pure margin.
  // Positioned just above the /web/extract scrape ($0.003) it replaces.
  cryptoMarket: "$0.005",
  // Multi-chain gas oracle (GET /gas/price) — keyless public RPCs behind a 15s
  // per-chain cache with per-provider cooldowns, so upstream load stays bounded
  // at any paid volume (COGS ~$0). Funnel-probe tier; cut $0.005→$0.002 on
  // 2026-09-02 to match the Bazaar market median ($0.002; we were 2.5× over,
  // 7/11 competitors cheaper) — see the pricing deep-dive.
  gasPrice: "$0.002",
  // Batch spot-price oracle (GET /crypto/price): up to 25 symbols in one call
  // from keyless upstreams (Coinbase spot → CoinGecko → Kraken) behind a 30s
  // per-symbol cache, so upstream load stays bounded at any paid volume. The
  // pitch is 25 prices for $0.01 vs 25 × $0.005 /crypto/market calls — the
  // purpose-built upgrade for the proven oracle polling on
  // /currency-exchange/convert. See FINANCE-BATCH-HANDOFF.md.
  cryptoPrice: "$0.005",
  // Historical OHLC candles (GET /crypto/ohlc) — Coinbase Exchange with Kraken
  // fallback behind a 5min window-keyed cache (history is immutable; only the
  // newest candle churns), so upstream load stays bounded at any paid volume.
  // $0.02 workhorse tier per the Finance batch ladder; OHLC is a near-empty
  // Bazaar category (~60 resources) and price-at-date/history is the natural
  // follow-on for the spot-oracle agents already paying us. See
  // FINANCE-BATCH-HANDOFF.md.
  cryptoOhlc: "$0.02",
  // One base → up to 30 targets (GET /currency-exchange/batch) — fiat via the
  // frankfurter → fawazahmed0-CDN → er-api chain behind a 1h per-base table
  // cache, crypto legs via Coinbase spot on a 30s cache, so upstream load stays
  // bounded at any paid volume. $0.02 workhorse tier per the Finance batch
  // ladder: the direct upsell for /currency-exchange/convert's remittance-
  // corridor callers — 30 pairs for $0.02 vs 30 × $0.01 singles. See
  // FINANCE-BATCH-HANDOFF.md.
  currencyBatch: "$0.02",
  // Daily historical rate series + stats (GET /currency-exchange/history) —
  // fiat via the frankfurter range API (one call per range) → ECB 90-day XML,
  // non-ECB fiat via per-date fawazahmed0 CDN files, crypto via Coinbase daily
  // candles — all behind a 6h per-query cache (history is immutable; only
  // today's point churns), so upstream load stays bounded at any paid volume.
  // $0.02 workhorse tier per the Finance batch ladder: trend/repricing context
  // for the same agents already paying for /currency-exchange/convert spot.
  // See FINANCE-BATCH-HANDOFF.md.
  currencyHistory: "$0.02",
  // ERC-20 token profile by contract address (GET /token/info) — identity
  // (name/symbol/decimals/supply) read straight from the chain via the keyless
  // RPC rotation, enriched with DexScreener market data and Blockscout holder
  // count, all behind a 10min per-token cache (metadata is immutable; only the
  // market fields churn), so upstream load stays bounded at any paid volume.
  // $0.02 workhorse tier per the Finance batch ladder; token metadata is a
  // near-empty Bazaar category (~46 resources). See FINANCE-BATCH-HANDOFF.md.
  tokenInfo: "$0.02",
  // The cheap wallet probe (GET /wallet/balance) — native + USDC + up to 10
  // caller-named ERC-20 balances for one address on Base, Ethereum, or Solana,
  // read straight from the keyless public RPC rotation behind a 60s cache, so
  // upstream load stays bounded at any paid volume. $0.005 funnel-probe tier per
  // the Finance batch ladder — the acquisition funnel for /wallet/intel,
  // mirroring the proven ip-geo→ip-risk ladder; wallet intel is a near-empty
  // Bazaar category (~58 resources). See FINANCE-BATCH-HANDOFF.md.
  walletBalance: "$0.005",
  // Counterparty due-diligence report (GET /wallet/intel) — wallet age, first
  // funder, USDC in/out flow, distinct counterparties, 30d activity pattern,
  // and risk flags rolled into one scored report, derived from keyless
  // Blockscout tokentx (the dashboard-proven signal: x402 wallets are gasless,
  // so token transfers — not nonce/txlist — carry the story) behind a 5min
  // cache. $0.05 composite tier per the Finance batch ladder — the upsell
  // above the /wallet/balance $0.005 funnel probe, mirroring the proven
  // ip-geo→ip-risk ladder; wallet intel is a near-empty Bazaar category
  // (~58 resources, mostly single-metric). See FINANCE-BATCH-HANDOFF.md.
  walletIntel: "$0.05",
  // Offline IBAN validation (GET|POST /iban/validate) — mod-97 + per-country
  // structure against the hardcoded registry, pure local compute, no upstream
  // at all (the one unburnable endpoint in the Finance batch). $0.005
  // funnel-probe tier per the Finance batch ladder; IBAN is a near-empty
  // Bazaar category (~67 resources). See FINANCE-BATCH-HANDOFF.md.
  ibanValidate: "$0.005",
  // One-call market briefing (GET /market/snapshot) — crypto majors, fiat
  // crosses, Base/Ethereum gas, and the fear/greed index fetched concurrently
  // with graceful partial failure, all behind a 60s whole-snapshot cache (the
  // sections keep their own inner caches), so upstream load stays bounded at
  // any paid volume. $0.05 composite tier per the Finance batch ladder — the
  // upsell for the 76 wallets first-acquired through /currency-exchange/convert:
  // one call instead of orchestrating four. See FINANCE-BATCH-HANDOFF.md.
  marketSnapshot: "$0.05",
  githubIntel: "$0.030",
  holidays: "$0.005",
  ipGeo: "$0.002",
  // Live weather + 3-day forecast (GET|POST /weather/current) — keyless
  // open-meteo geocoding + forecast behind a required 10-min per-location
  // cache, so upstream load stays bounded at any paid volume: the same
  // pure-margin model as ip-geo, priced at the same probe tier.
  weatherCurrent: "$0.002",
  // Multi-day + hourly forecast (GET|POST /weather/forecast) — the planning
  // companion to /weather/current: same keyless open-meteo upstream behind the
  // same required 10-min cache, one step up the value ladder ($0.002 current →
  // $0.003 forecast) for the longer range + richer daily fields.
  weatherForecast: "$0.003",
  // Live Polymarket prediction-market odds (GET|POST /prediction/markets) —
  // keyless Gamma API behind a 60s per-query cache: top active markets by
  // volume, or keyword search. Same pure-margin model as weather, priced at
  // the $0.005 funnel tier to undercut the ~$0.0085 incumbents (blockrun
  // Polymarket/Kalshi wrappers: ~76 combined 30-day payers in the intel
  // snapshots — a category NetIntel had nothing in).
  predictionMarkets: "$0.005",
  // Single-market drill-in (GET|POST /prediction/market): one keyless Gamma
  // call by id or slug behind a 60s cache. Cheaper than the list ($0.003) —
  // an agent that found a market via /prediction/markets pays a small step to
  // pull its full state (all outcomes + odds + description + resolution terms).
  predictionMarket: "$0.003",
  jwtInspector: "$0.005",
  langDetect: "$0.005",
  npmIntel: "$0.010",
  sitemapParser: "$0.010",
  // Cut $0.050→$0.010 on 2026-09-02 to match the Bazaar market median ($0.01;
  // we were 5× over, 10/12 competitors cheaper, 73 payers going elsewhere).
  // Keyless upstreams (COGS ~$0). See the pricing deep-dive. urlSafetyFull
  // ($0.15) stays as the premium bundle.
  urlSafety: "$0.010",
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
  // Composite name-selection bundle (POST /domain/vet). Verified in-band against
  // the three primitives it composes, read from this same table: bulk-domain
  // $0.100 + domain-appraise $0.030 + typosquat $0.050 = $0.180 sum, $0.100 max
  // single. $0.20 clears BOTH — it is above the priciest single call (the spec's
  // floor rule) and above the sum, which the à-la-carte funnel cannot undercut
  // because the parts don't include the rank/select step or the brand-collision
  // check this endpoint adds. Lands on the existing $0.20 composite tier
  // (domain-due-diligence / ip-report-full). Guarded by a test that recomputes
  // the sum from this table, so a price change to any part fails CI here.
  domainVet: "$0.20",
  classify: "$0.005",
  // Cut $0.05 → $0.005 on 2026-09-02 to reach the Bazaar market (median $0.003;
  // 15/16 competitors cheaper, 126 payers going elsewhere). Model swapped Haiku →
  // gpt-4o-mini (see src/routes/content-moderate.ts) so worst-case COGS (~$0.0027
  // at the 10k-word cap) clears margin. See the pricing deep-dive.
  contentModerate: "$0.005",
  entityExtract: "$0.050",
  sentiment: "$0.002",
  textSummarize: "$0.005",
  // Deterministic RAG text chunker (POST /text/chunk). Pure function, zero COGS;
  // priced at the CDP $0.001 floor to match the agent402.tools listing our
  // returning embeddings customer already buys. First $0.001 endpoint — the
  // priceRange.min in index.ts tracks this.
  textChunk: "$0.001",
  // Deterministic text statistics (GET|POST /text/stats). Pure function, zero
  // COGS; same $0.001 floor as /text/chunk — completes the chunk → stats → embed
  // bundle the returning embeddings customer buys elsewhere.
  textStats: "$0.001",
  // translate/* cut to the Bazaar market 2026-09-02 (median $0.01, we were 3-8x
  // over) + backend swapped Haiku → gpt-4o-mini (see src/services/openai-json.ts),
  // so worst-case COGS clears margin at these prices. Long keeps a premium (8192
  // out-tok → ~$0.007 worst-case). See the pricing deep-dive.
  translateLong: "$0.02",
  translateShort: "$0.01",
  // Structure-preserving translation (POST /translate/structured): placeholder/tag
  // extraction + post-translation diff + corrective retry on top of prose. Cut
  // $0.05 → $0.02 (still a premium over short's $0.01 for the guarantee).
  translateStructured: "$0.02",
  // Base price of POST /translate/batch, covering the first
  // translateBatch.includedItems (25) strings. LEFT at $0.05 (not cut): it runs one
  // model call per item, so 25 items ≈ $0.002/translation — already 5x under the
  // $0.01 single-translate market (bulk product, like bulk-domain). It inherits the
  // gpt-4o-mini swap via translate-structured's shared core.
  translateBatch: "$0.05",
  // extract/* cut to market 2026-09-02 (structured-extraction median $0.02, broad
  // payers at $0.01) + Haiku → gpt-4o-mini. Light extracts $0.01, document extracts
  // $0.02 (bigger output). Worst-case COGS $0.0024-0.0039. See the pricing deep-dive.
  extractAddress: "$0.01",
  extractContact: "$0.01",
  extractInvoice: "$0.02",
  extractResume: "$0.02",
  extractTable: "$0.02",
  markdownClean: "$0.03",
  normalizeJson: "$0.05",
  textToJson: "$0.05",
  webExtract: "$0.003",
  // Raw fetch sibling of /web/extract (same price, keyless ⇒ pure margin).
  webFetch: "$0.003",
  // Exa neural web search resale (GET|POST /exa/search + alias /web/search).
  // Flat $0.01 vs Exa's list price (checked 2026-09-05): $0.007/request for
  // up to 10 results, +$0.001 per result above 10, +$0.001/page when snippets
  // are requested. Handler clamps num_results to 10 (COGS $0.007, 30% margin)
  // and to 2 when snippets are on ($0.009 worst case, 10%) — never a loss.
  // Brand-named resale play: agents search the
  // Bazaar by brand ("exa search"), the same mechanic that makes /openai/*
  // own "openai api" queries. See EXA-SEARCH-HANDOFF.md.
  exaSearch: "$0.01",
  // Exa page-contents batch resale (GET|POST /exa/contents). Up to 3 URLs/call,
  // text-only content type ($0.001/page COGS) — worst case $0.003 (40% margin),
  // typical 1-url call 80%. Closes the search -> contents loop /exa/search
  // opens; see EXA-SEARCH-HANDOFF.md.
  exaContents: "$0.005",
  // Exa web-grounded answer resale (GET|POST /exa/answer). Flat $0.01 vs Exa's
  // own $0.005/query COGS — 50% margin. include_citation_text does NOT add
  // COGS (paid prod probe 2026-09-05: 8 citations w/ text logged $0.005), so
  // the per-citation 4000-char cap in the handler is a payload guard only.
  // Exa does both retrieval and generation — no OpenAI call on our side. See
  // EXA-SEARCH-HANDOFF.md.
  exaAnswer: "$0.01",
  moneyParse: "$0.01",
  // Repair-only, and deterministic on the overwhelming majority of calls (no LLM
  // cost at all on the fast path). Deliberately BELOW the schema-driven LLM
  // endpoints it sits next to — normalize-json/text-to-json ($0.05) and
  // schema-parse ($0.10) — because it does strictly less: it fixes syntax, it
  // does not extract or map data to a target shape. Nothing it does is offered
  // by a cheaper endpoint, so it undercuts nothing.
  jsonRepair: "$0.02",
  // Validation is deterministic on every straight call — the LLM only runs when
  // the caller explicitly asks for repair AND the deterministic repair failed, so
  // the fast path costs nothing but compute. Priced at the jsonRepair tier: it
  // verifies data against a schema, it does not extract or map it, so it undercuts
  // neither normalize-json ($0.05, maps to a target shape) nor schema-parse
  // ($0.10, extracts from prose). Nothing cheaper offers a validation verdict.
  schemaValidate: "$0.02",
  // Reshaping data between systems. Priced ABOVE its two siblings (jsonRepair /
  // schemaValidate, $0.02 — they fix or judge one document) and BELOW
  // normalize-json ($0.05, LLM on every call): mapping resolves most fields
  // deterministically and only pays for Haiku on the leftovers, so the marginal
  // cost sits between them and the price follows.
  schemaMap: "$0.04",
  calendarIcs: "$0.005",
  eventClassify: "$0.02",
  // HISTORY: schemaParse rode at $0.10 for months on one price-tolerant whale
  // (0x035a). That whale has been gone ~1 month (2026-09-02 review), so schemaParse
  // was cut to $0.01 (market median) and swapped to gpt-4o-mini. eventExtract is
  // still $0.050 pending its own demand signal (thin traffic) — no longer priced
  // in parity with schemaParse. See src/routes/event-extract.ts + the pricing deep-dive.
  eventExtract: "$0.050",
  // Flat per-call price for /messages. Bounded input (24k chars) + max_tokens
  // caps (see src/routes/messages.ts) hold the theoretical worst-case Sonnet 4.6
  // cost to ~$0.038 (~1.6× at the ceiling); real calls cost ~$0.01–0.03, so this
  // clears margin on every call.
  messages: "$0.06",
  // Flat per-call price for POST /openai/gpt-4o — an OpenAI-direct chat passthrough
  // (no translation; request/response are OpenAI chat.completions-shaped). Derived
  // from the enforced caps (48000 in-chars ~16k tok, 2048 out-tok) at gpt-4o's
  // $2.50/$10.00 per-1M rates: worst case ≈ (16000×2.50 + 2048×10.00)/1e6 ≈ $0.061,
  // so $0.10 clears ~1.6× at the ceiling. Guarantee holds only while the caps are
  // enforced AND the real gpt-4o rate stays ≤ 2.50/10.00 — verify on the OpenAI
  // dashboard before go-live and never raise a cap without re-deriving. See
  // src/routes/openai-gpt-4o.ts + src/services/openai-passthrough.ts.
  openaiGpt4o: "$0.10",
  // Flat per-call price for POST /openai/gpt-4-1 — an OpenAI-direct chat passthrough
  // (no translation; request/response are OpenAI chat.completions-shaped). Derived
  // from the enforced caps (48000 in-chars ~16k tok, 2048 out-tok) at gpt-4.1's
  // $2.00/$8.00 per-1M rates: worst case ≈ (16000×2.00 + 2048×8.00)/1e6 ≈ $0.049,
  // so $0.09 clears ~1.6× at the ceiling. Guarantee holds only while the caps are
  // enforced AND the real gpt-4.1 rate stays ≤ 2.00/8.00 — verify on the OpenAI
  // dashboard before go-live and never raise a cap without re-deriving. See
  // src/routes/openai-gpt-4-1.ts + src/services/openai-passthrough.ts.
  openaiGpt41: "$0.09",
  // Flat per-call price for POST /openai/gpt-4-1-mini — an OpenAI-direct chat
  // passthrough (no translation; request/response are OpenAI chat.completions-
  // shaped). Derived from the enforced caps (12000 in-chars ~4k tok, 1024 out-tok)
  // at gpt-4.1-mini's $0.40/$1.60 per-1M rates: worst case ≈ (4000×0.40 +
  // 1024×1.60)/1e6 ≈ $0.0033, so the flat $0.005 clears ~1.5× at the ceiling.
  // (2026-07-24 market reprice: caps CUT 36000→12000 / 2048→1024 with the price —
  // the x402 chat-resale market clears at $0.001–0.02/call.)
  // Guarantee holds only while the caps are enforced AND the real gpt-4.1-mini
  // rate stays ≤ 0.40/1.60 — verify on the OpenAI dashboard before go-live and
  // never raise a cap without re-deriving. See src/routes/openai-gpt-4-1-mini.ts +
  // src/services/openai-passthrough.ts.
  openaiGpt41Mini: "$0.005",
  // Flat per-call price for POST /openai/gpt-4o-mini — an OpenAI-direct chat
  // passthrough (no translation; request/response are OpenAI chat.completions-
  // shaped). Cap RAISED 24000→40000 in-chars on 2026-09-03 (token budget 40000/3
  // ≈ 13.3k tok) to fit real agent workloads — a Claude-Code-style gateway
  // customer was bouncing off the 24k cap (26k-55k-char prompts). Re-derived at
  // gpt-4o-mini's $0.15/$0.60 per-1M rates: worst case ≈ (13333×0.15 +
  // 1024×0.60)/1e6 ≈ $0.0026, so the flat $0.005 still clears ~1.9× (48% margin);
  // even the pessimistic 1.5× CJK-token tail stays ~28% positive. Also raises the
  // /v1/chat/completions gateway cap for this model (same config). Guarantee holds
  // only while caps are enforced AND the real rate stays ≤ 0.15/0.60 — never raise
  // a cap without re-deriving. See src/routes/openai-gpt-4o-mini.ts + openai-passthrough.ts.
  openaiGpt4oMini: "$0.005",
  // Flat per-call price for POST /openai/gpt-4-1-nano — an OpenAI-direct chat
  // passthrough (no translation; request/response are OpenAI chat.completions-
  // shaped). Derived from the enforced caps (24000 in-chars ~8k tok, 1024 out-tok)
  // at gpt-4.1-nano's $0.10/$0.40 per-1M rates: worst case ≈ (8000×0.10 +
  // 1024×0.40)/1e6 ≈ $0.0012, so the flat $0.005 clears ~4× at the ceiling
  // (2026-07-24 market reprice from $0.01; caps unchanged).
  // Guarantee holds only while the caps are enforced AND the real gpt-4.1-nano
  // rate stays ≤ 0.10/0.40 — verify on the OpenAI dashboard before go-live and
  // never raise a cap without re-deriving. See src/routes/openai-gpt-4-1-nano.ts +
  // src/services/openai-passthrough.ts.
  openaiGpt41Nano: "$0.005",
  // Flat per-call price for POST /openai/gpt-5-5 — an OpenAI-direct chat
  // passthrough to the reasoning-family gpt-5.5 (max_completion_tokens; sampling
  // params rejected). Derived from the enforced caps (96000 in-chars ~32k tok,
  // 8192 out-tok) at gpt-5.5's $5.00/$30.00 per-1M rates: worst case ≈
  // (32000×5.00 + 8192×30.00)/1e6 ≈ $0.406, so the flat $0.65 clears ~1.6× at the
  // ceiling. Guarantee holds only while the caps are enforced AND the real
  // gpt-5.5 rate stays ≤ 5.00/30.00 — verify on the OpenAI dashboard before
  // go-live and never raise a cap without re-deriving. See
  // src/routes/openai-gpt-5-5.ts + src/services/openai-passthrough.ts.
  openaiGpt55: "$0.65",
  // Flat per-call price for POST /openai/gpt-5-4 — an OpenAI-direct chat
  // passthrough to the reasoning-family gpt-5.4 (max_completion_tokens; sampling
  // params rejected). Derived from the enforced caps (96000 in-chars ~32k tok,
  // 4096 out-tok) at gpt-5.4's $2.50/$15.00 per-1M rates: worst case ≈
  // (32000×2.50 + 4096×15.00)/1e6 ≈ $0.142, so the flat $0.25 clears ~1.6× at the
  // ceiling. Guarantee holds only while the caps are enforced AND the real
  // gpt-5.4 rate stays ≤ 2.50/15.00 — verify on the OpenAI dashboard before
  // go-live and never raise a cap without re-deriving. See
  // src/routes/openai-gpt-5-4.ts + src/services/openai-passthrough.ts.
  openaiGpt54: "$0.25",
  // Flat per-call price for POST /openai/gpt-5-4-mini — an OpenAI-direct chat
  // passthrough to the reasoning-family gpt-5.4-mini (max_completion_tokens;
  // sampling params rejected). Derived from the enforced caps (36000 in-chars
  // ~12k tok, 2048 out-tok) at gpt-5.4-mini's $0.75/$4.50 per-1M rates: worst
  // case ≈ (12000×0.75 + 2048×4.50)/1e6 ≈ $0.0182, so the flat $0.04 clears ~2.2×
  // at the ceiling. Guarantee holds only while the caps are enforced AND the real
  // gpt-5.4-mini rate stays ≤ 0.75/4.50 — verify on the OpenAI dashboard before
  // go-live and never raise a cap without re-deriving. See
  // src/routes/openai-gpt-5-4-mini.ts + src/services/openai-passthrough.ts.
  openaiGpt54Mini: "$0.04",
  // Flat per-call price for POST /openai/gpt-5-4-nano — an OpenAI-direct chat
  // passthrough to the reasoning-family gpt-5.4-nano (max_completion_tokens;
  // sampling params rejected). Derived from the enforced caps (24000 in-chars
  // ~8k tok, 1024 out-tok) at gpt-5.4-nano's $0.20/$1.25 per-1M rates: worst
  // case ≈ (8000×0.20 + 1024×1.25)/1e6 ≈ $0.0029, so the flat $0.005 clears ~1.7×
  // at the ceiling (2026-07-24 market reprice from $0.01; caps unchanged).
  // Guarantee holds only while the caps are enforced AND the real
  // gpt-5.4-nano rate stays ≤ 0.20/1.25 — verify on the OpenAI dashboard before
  // go-live and never raise a cap without re-deriving. See
  // src/routes/openai-gpt-5-4-nano.ts + src/services/openai-passthrough.ts.
  openaiGpt54Nano: "$0.005",
  // Flat per-call price for POST /openai/gpt-5-2 — an OpenAI-direct chat
  // passthrough to the reasoning-family gpt-5.2 (max_completion_tokens; sampling
  // params rejected). Derived from the enforced caps (96000 in-chars ~32k tok,
  // 4096 out-tok) at gpt-5.2's $1.75/$14.00 per-1M rates: worst case ≈
  // (32000×1.75 + 4096×14.00)/1e6 ≈ $0.113, so the flat $0.20 clears ~1.6× at the
  // ceiling. Guarantee holds only while the caps are enforced AND the real
  // gpt-5.2 rate stays ≤ 1.75/14.00 — verify on the OpenAI dashboard before
  // go-live and never raise a cap without re-deriving. See
  // src/routes/openai-gpt-5-2.ts + src/services/openai-passthrough.ts.
  openaiGpt52: "$0.20",
  // Flat per-call price for POST /openai/gpt-5-6-sol — an OpenAI-direct chat
  // passthrough to the reasoning-family gpt-5.6-sol (max_completion_tokens; sampling
  // params rejected). Derived from the enforced caps (96000 in-chars ~32k tok,
  // 8192 out-tok) at gpt-5.6-sol's $5.00/$30.00 per-1M rates: worst case ≈
  // (32000×5.00 + 8192×30.00)/1e6 ≈ $0.406, so the flat $0.65 clears ~1.6× at the
  // ceiling. Guarantee holds only while the caps are enforced AND the real
  // gpt-5.6-sol rate stays ≤ 5.00/30.00 — verify on the OpenAI dashboard before
  // go-live and never raise a cap without re-deriving. See
  // src/routes/openai-gpt-5-6-sol.ts + src/services/openai-passthrough.ts.
  openaiGpt56Sol: "$0.65",
  // Flat per-call price for POST /openai/gpt-5-6-terra — an OpenAI-direct chat
  // passthrough to the reasoning-family gpt-5.6-terra (max_completion_tokens; sampling
  // params rejected). Derived from the enforced caps (96000 in-chars ~32k tok,
  // 4096 out-tok) at gpt-5.6-terra's $2.50/$15.00 per-1M rates: worst case ≈
  // (32000×2.50 + 4096×15.00)/1e6 ≈ $0.142, so the flat $0.25 clears ~1.6× at the
  // ceiling. Guarantee holds only while the caps are enforced AND the real
  // gpt-5.6-terra rate stays ≤ 2.50/15.00 — verify on the OpenAI dashboard before
  // go-live and never raise a cap without re-deriving. See
  // src/routes/openai-gpt-5-6-terra.ts + src/services/openai-passthrough.ts.
  openaiGpt56Terra: "$0.25",
  // Flat per-call price for POST /openai/gpt-5-6-luna — an OpenAI-direct chat
  // passthrough to the reasoning-family gpt-5.6-luna (max_completion_tokens; sampling
  // params rejected). Derived from the enforced caps (48000 in-chars ~16k tok,
  // 2048 out-tok) at gpt-5.6-luna's $1.00/$6.00 per-1M rates: worst case ≈
  // (16000×1.00 + 2048×6.00)/1e6 ≈ $0.028, so the flat $0.06 clears ~2× at the
  // ceiling. Guarantee holds only while the caps are enforced AND the real
  // gpt-5.6-luna rate stays ≤ 1.00/6.00 — verify on the OpenAI dashboard before
  // go-live and never raise a cap without re-deriving. See
  // src/routes/openai-gpt-5-6-luna.ts + src/services/openai-passthrough.ts.
  openaiGpt56Luna: "$0.06",
  // Flat per-call price for POST /openai/gpt-5-1 — an OpenAI-direct chat
  // passthrough to the reasoning-family gpt-5.1 (max_completion_tokens; sampling
  // params rejected). Derived from the enforced caps (96000 in-chars ~32k tok,
  // 4096 out-tok) at gpt-5.1's $1.25/$10.00 per-1M rates: worst case ≈
  // (32000×1.25 + 4096×10.00)/1e6 ≈ $0.081, so the flat $0.15 clears ~1.6× at the
  // ceiling. Guarantee holds only while the caps are enforced AND the real
  // gpt-5.1 rate stays ≤ 1.25/10.00 — verify on the OpenAI dashboard before
  // go-live and never raise a cap without re-deriving. See
  // src/routes/openai-gpt-5-1.ts + src/services/openai-passthrough.ts.
  openaiGpt51: "$0.15",
  // Flat per-call price for POST /openai/gpt-5-nano — an OpenAI-direct chat
  // passthrough to the reasoning-family gpt-5-nano (max_completion_tokens; sampling
  // params rejected). Derived from the enforced caps (24000 in-chars ~8k tok,
  // 1024 out-tok) at gpt-5-nano's $0.05/$0.40 per-1M rates: worst case ≈
  // (8000×0.05 + 1024×0.40)/1e6 ≈ $0.0008, so the flat $0.005 clears ~6× at the
  // ceiling (2026-07-24 market reprice from $0.01; caps unchanged).
  // Guarantee holds only while the caps are enforced AND
  // the real gpt-5-nano rate stays ≤ 0.05/0.40 — verify on the OpenAI dashboard
  // before go-live and never raise a cap without re-deriving. See
  // src/routes/openai-gpt-5-nano.ts + src/services/openai-passthrough.ts.
  openaiGpt5Nano: "$0.005",
  // Flat per-call price for POST /v1/chat/completions — the OpenAI-compat
  // GATEWAY (model chosen in the body, dispatched to the per-model passthrough
  // with that model's own caps). One flat x402 price must cover the priciest
  // model the gateway accepts, so it only serves models whose dedicated price
  // is <= this value (gpt-4o at $0.10 is the ceiling; worst-case upstream cost
  // there ≈ $0.061). Pricier models get a 400 pointing at their dedicated
  // endpoint. Cheap models cost the full flat price here by design — the
  // per-model endpoints remain the best-price path (GET /v1/models says so).
  v1ChatCompletions: "$0.005",
  // Flat per-call price for POST /v1/embeddings (+ /api/v1 alias) — OpenAI-direct
  // embeddings passthrough (text-embedding-3-small default, -large selectable).
  // Embeddings cost is INPUT-ONLY; derived from the caps enforced in the route
  // (128 items, 64000 chars total ≈ 21.3k tokens at 3 chars/tok): worst case ≈
  // $0.00043 small ($0.02/1M) / $0.00277 large ($0.13/1M), so $0.005 clears
  // ~1.8× on the pricier model at the ceiling and ~12× on the default. Rates
  // verified 2026-07-18. Never raise MAX_TOTAL_CHARS without re-deriving. See
  // src/routes/v1-embeddings.ts. (CDP settle floor is ~$0.001 — safely above.)
  v1Embeddings: "$0.005",
  // Flat per-call price for POST /semantic/rank — semantic similarity ranking
  // (query + up to 100 candidates → candidates sorted by embedding-cosine
  // score). Cost is ONE input-only OpenAI embeddings call; caps in the route
  // are derived at the worst-case ~1 token/char (CJK): 64000 chars on
  // text-embedding-3-small ($0.02/1M) → $0.00128 (~16× at the ceiling); 24000
  // chars on -large ($0.13/1M) → $0.00312 (~6.4×). Priced as an OUTCOME at 4×
  // raw /v1/embeddings — it replaces embedding query + candidates, cosine math,
  // sorting, and index bookkeeping in one call. Rates verified 2026-07-18.
  // NEVER raise a cap in src/routes/semantic-rank.ts without re-deriving this.
  // (CDP settle floor is ~$0.001 — safely above.)
  semanticRank: "$0.02",
  // Flat per-call price for POST /embeddings — self-hosted multilingual-e5-small
  // text embeddings (384-dim), served in-process via ONNX (no OpenAI dependency,
  // no per-token upstream cost). COGS is a fixed ~$3/month of RAM, not per-call
  // metered spend, so this can undercut the /v1/embeddings resell endpoint
  // ($0.005) and offer bigger batches (256 vs 128 items). Matches the CDP
  // $0.001 floor (see pricing.textChunk). See src/services/local-embeddings.ts +
  // src/routes/embeddings-local.ts.
  embeddingsLocal: "$0.001",
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

// Pricing knobs for POST /translate/batch. Each item is its own model call (that
// is what buys per-item detection, per-item validation, and partial success), so
// marginal cost scales with item count while the x402 price does not: CDP cannot
// settle a dynamic price (see memory x402-dynamic-price-unsupported), so the
// SETTLED amount is always the flat pricing.translateBatch. `overagePerItem` is
// therefore reported in the response (pricing.overage_usd / billed_items) for
// margin telemetry, and is NOT yet charged. Overage revenue needs either a
// facilitator that settles dynamic prices or a separate higher-priced route —
// until then, keep includedItems and maxItems close enough that the worst-case
// batch still clears cost.
export const translateBatch = {
  /** Items covered by the flat base price. */
  includedItems: 25,
  /** USD per item beyond includedItems — reported, not yet settled (see above). */
  overagePerItem: 0.002,
} as const;

export const timeouts = {
  dns: 3000,
  ssl: 5000,
  // One TLS handshake for GET|POST /ssl/cert — no protocol-version probing.
  sslCertQuick: 6000,
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
  // Per-upstream-call deadline for /crypto/market (Coinbase ticker/stats and
  // the CoinGecko markets call each race this individually).
  cryptoMarket: 8000,
  // Per-RPC-LEG deadline for /gas/price: each provider attempt (and the
  // Coinbase spot call) races this individually; the rotation moves on and
  // benches the provider on timeout.
  gasPrice: 6000,
  // Per-upstream-call deadline for /crypto/price: each Coinbase spot leg, the
  // CoinGecko batch call, and the Kraken batch call race this individually;
  // a timed-out provider is benched and the chain moves on.
  cryptoPrice: 8000,
  // Per-upstream-call deadline for /crypto/ohlc: the Coinbase Exchange candles
  // call and the Kraken OHLC fallback each race this individually; a timed-out
  // provider is benched and the chain moves on.
  cryptoOhlc: 10000,
  // Per-upstream-call deadline for /currency-exchange/batch: each fiat table
  // fetch (frankfurter / currency-api CDN / er-api) and each Coinbase spot leg
  // races this individually; a failed provider is benched and the chain moves on.
  currencyBatch: 8000,
  // Per-upstream-call deadline for /currency-exchange/history: the frankfurter
  // range call, the ECB XML fetch, each per-date CDN file, and the Coinbase
  // candles call each race this individually; a failed daily-data provider is
  // benched and the chain moves on.
  currencyHistory: 10000,
  // Per-upstream-call deadline for /token/info: each RPC batch attempt, the
  // DexScreener call, and the Blockscout call race this individually; a failed
  // provider is benched and the chain moves on.
  tokenInfo: 8000,
  // Per-upstream-call deadline for /wallet/balance: each ≤10-item RPC batch
  // (EVM), the Solana batch, and the Coinbase spot call race this individually;
  // a failed provider is benched and the rotation moves on.
  walletBalance: 6000,
  // Per-upstream-call deadline for /wallet/intel: the Blockscout tokentx and
  // v2-address calls, the Etherscan fallback, and each RPC-basics attempt race
  // this individually (Blockscout can be slow on deep transfer histories); a
  // failed provider is benched and the chain moves on.
  walletIntel: 12000,
  // Pure compute (in-code registry + mod-97) — no external calls; safety
  // ceiling only, kept for parity with the other endpoints.
  ibanValidate: 1000,
  // OVERALL wall-clock for the whole /market/snapshot composite. The four
  // sections run concurrently and each races its own shorter 6s budget (see
  // the route), so one slow section degrades to null instead of eating this.
  marketSnapshot: 10000,
  githubIntel: 8000,
  holidays: 8000,
  ipGeo: 15000,
  // ONE shared deadline for the whole /weather/current chain (geocode +
  // forecast) — each upstream call races whatever remains of it.
  weatherCurrent: 8000,
  // Same shared-deadline model for the /weather/forecast chain (geocode +
  // forecast) — each upstream call races whatever remains of it.
  weatherForecast: 8000,
  // One Gamma API call per /prediction/markets request (browse OR search).
  predictionMarkets: 8000,
  // One Gamma API call per /prediction/market lookup (by id OR by slug).
  predictionMarket: 8000,
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
  // run concurrently, so wall-clock ≈ the SLOWEST signal, not the sum; a
  // slow/failing signal degrades to signals_unavailable rather than failing the
  // whole call. Must exceed the slowest collector's own worst case, or that
  // signal can never complete here even though its standalone endpoint works:
  // cert_transparency legitimately needs crt.sh (12s) + the certspotter
  // fallback (12s), and domain_age's RDAP→WHOIS→wayback chain uses up to 10s.
  // At the old 10s value the 2026-07-30 sweep paid $0.10 for a
  // confidence:"partial" answer missing both, minutes after each standalone
  // endpoint answered fine.
  domainVendorRisk: 25000,
  // HARD WALL-CLOCK for the whole domain-vet composite (breadth pass + the
  // deep-check drill-down), not a per-sub-call budget: each sub-call is raced
  // against whatever remains of it, so a slow primitive degrades to
  // signals_unavailable + a partial return instead of holding a paid request
  // open. Sized for a 5-candidate × 5-TLD RDAP breadth pass.
  domainVet: 12000,
  classify: 30000,
  contentModerate: 30000,
  entityExtract: 30000,
  sentiment: 30000,
  textSummarize: 30000,
  // Formality — /text/chunk makes no network calls.
  textChunk: 5000,
  // Formality — /text/stats makes no network calls.
  textStats: 5000,
  translateLong: 30000,
  translateShort: 30000,
  // Per-ATTEMPT deadline for /translate/structured. A structure-broken first pass
  // is retried once, so the worst case is ~2x this.
  translateStructured: 30000,
  // WHOLE-BATCH deadline for /translate/batch. Items run in concurrency waves and
  // each item's own model call is bounded by translateStructured above; this caps
  // the wall-clock of the batch itself — items still unstarted when it expires
  // come back status="failed"/reason="timeout" rather than holding the request
  // open. Generous, because a 200-item batch is legitimately slow.
  translateBatch: 120000,
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
  // Data APIs (ArcGIS, open-data portals) are slow — the whole point vs extract's 12s.
  webFetch: 25000,
  // One POST to Exa's /search for GET|POST /exa/search (+ /web/search alias).
  exaSearch: 20000,
  // One POST to Exa's /contents for GET|POST /exa/contents. Longer than
  // exaSearch — live-crawl fallback (livecrawl:"fallback") is slow when a URL
  // is missing from Exa's index.
  exaContents: 25000,
  // One POST to Exa's /answer for GET|POST /exa/answer — answer = search +
  // generation, so this runs longer than a plain search.
  exaAnswer: 30000,
  // LLM fallback path only; the deterministic fast path uses no timer.
  moneyParse: 30000,
  // LLM fallback path only; the deterministic tokenizer is pure compute.
  jsonRepair: 30000,
  // Opt-in LLM repair path only; deterministic validation is pure compute.
  schemaValidate: 30000,
  // Semantic-mapping LLM call only; alias/hint/normalized matching is pure compute.
  schemaMap: 30000,
  // Pure compute (RFC 5545 construction) — no external calls; cap is a safety
  // ceiling only, kept for parity with the other endpoints.
  calendarIcs: 5000,
  eventClassify: 30000,
  eventExtract: 30000,
  // Anthropic Messages call for /messages (non-streaming, max_tokens <= 4096).
  messages: 60000,
  // Upstream OpenAI chat.completions call for every /openai/<model> passthrough
  // (non-streaming). Shared across all OpenAI-direct endpoints; the flat price on
  // each is derived assuming the call completes within this wall-clock. A timeout
  // is treated as an upstream error → 502 uncharged (see openai-passthrough.ts).
  openaiChat: 60000,
  // Upstream OpenAI embeddings call for /v1/embeddings (input-only, fast even
  // on a 128-item batch). Timeout → 502 uncharged, same as the chat routes.
  embeddings: 30000,
  // Upstream OpenAI embeddings call for /semantic/rank (one batched request:
  // query + up to 100 candidates). Timeout → 502 uncharged.
  semanticRank: 30000,
  // Bounds a hung model load (first-boot HF Hub fetch) or a pathological batch
  // for POST /embeddings. Model-load/inference failure → 502 uncharged.
  embeddingsLocal: 30000,
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
