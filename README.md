# netintel-algo

NetIntel's full pay-per-call API surface — **74 paid endpoints** — settling on
**Algorand mainnet** via the [GoPlausible](https://facilitator.goplausible.xyz)
x402 facilitator. It is **receive-only**: it holds no signing key — it only
advertises a payout address, and the payer's wallet + the facilitator do the
settlement.

Sibling of the main NetIntel service (`netintel.dev`), which serves the same
endpoints on Base. This is a peer resource server, not a proxy: it re-implements
nothing and calls nothing upstream.

## Architecture: two Algorand-specific files, everything else is a copy

`src/routes/*.ts` (73 files) and `src/utils/*.ts` are **byte-identical copies of
NetIntel's**. They are payment-agnostic — plain Express routers with handler
logic only, no price, no network, no payTo. Only two files are Algorand-specific:

| File | Role |
| --- | --- |
| `src/config.ts` | The adapter. Exports the same `config` / `pricing` / `timeouts` / `limits` / `dnsResolvers` / `vendorRiskWeights` symbols as NetIntel's config, but binds `config.network` / `config.payTo` to Algorand env vars. This is *why* the copied routes work unchanged: their inline 402 stubs read `pricing.*` / `config.network` / `config.payTo` and now resolve to Algorand values. |
| `src/index.ts` | The AVM resource server: `@x402-avm/*` + GoPlausible + `registerExactAvmScheme`, plus the `routes` map (lifted from NetIntel's `index.ts`, which already indirects through `pricing.*`/`config.*`, so it needed no per-entry edits). |

Keeping the copies verbatim is what makes upstream fixes a one-command replay:

```bash
npm run sync:from-netintel            # replay NetIntel's routes/ + utils/
npm run sync:from-netintel -- --check # report drift, write nothing (exit 1 if drift)
```

`src/SYNCED-FROM.txt` records the NetIntel commit last synced. **Never hand-edit
`src/routes` or `src/utils`** — changes belong in `src/config.ts`, `src/index.ts`,
or upstream in NetIntel.

Prices are NetIntel's, verbatim: Algorand and Base charge the same per call.

## Discovery (free, generated)

Every catalog is a pure function of the `routes` object, so they cannot drift
from what is actually served and priced:

`/.well-known/x402` · `/openapi.json` · `/.well-known/agent-card.json` ·
`/.well-known/api-catalog` · `/apis.json` · `/.well-known/ai-plugin.json` ·
`/llms.txt` · `/llms-full.txt` · `/.well-known/security.txt` · `/robots.txt` · `/`

`GET /health` is free (Railway healthcheck).

## Paying

Make a normal HTTP request. Unpaid, you get `402` with the payment requirements
in the `PAYMENT-REQUIRED` header (x402 `exact` scheme, USDC on Algorand). Retry
with an `X-PAYMENT` header. Settlement is gasless via the facilitator and only
occurs when the call succeeds — **failed calls (HTTP >= 400) are never charged.**

## Configuration (env only)

| Var | Purpose |
| --- | --- |
| `X402_NETWORK` | CAIP-2 network id. Mainnet: `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=`. The USDC ASA (mainnet `31566704`) is **derived** from this, not hardcoded — so testnet↔mainnet is a config-only flip. |
| `PAYTO_ADDRESS` | Algorand payout address (must be opted in to the USDC ASA). |
| `ANTHROPIC_API_KEY` | **Required** — ~20 endpoints are Claude-backed and the client is constructed at module load, so a missing key fails the boot. |
| `OPENAI_API_KEY` | Required by `/ai-image/generate`. |
| `ABUSEIPDB_API_KEY`, `OTX_API_KEY` | Required by `/ip-reputation`, `/ip-risk`, `/ip-report/full`. |
| `PUBLIC_BASE_URL` | Canonical origin. Also pins each route's x402 `resource` so settlements arriving on the raw Railway host don't register duplicate Bazaar listings. |
| `DATABASE_URL` | Optional. Paid-call analytics into the shared NetIntel Postgres — **only** this service's `algo_paid_call_events` / `_failures` / `_misses` tables, never the Base/EVM ones. Falls back to NDJSON + stdout. |
| `PORT` | HTTP port. Injected by Railway. |

No signing key is required. See `.env.example`.

### Known gap: `WALLET_DENYLIST` is inert on Algorand

On Base the payer is read from the request's `X-PAYMENT` header. On Algorand the
payload is opaque msgpack, so the payer is only known *after* settlement —
`extractPayerFromRequest()` always returns `null` here. The denylist therefore
never matches. Do not rely on it for abuse prevention on this service.

## Run locally

```bash
npm install
cp .env.example .env   # fill in PAYTO_ADDRESS + keys
npm start              # listens on 0.0.0.0:$PORT
```

## Deploy

Nixpacks-based Railway deploy: `npm start` runs `tsx src/index.ts`.
Healthcheck path is `/health` (see `railway.json`).
