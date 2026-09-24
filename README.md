# netintel-algo

NetIntel's full pay-per-call API surface — **141 paid endpoints** — settling on
**Algorand mainnet** via the [GoPlausible](https://facilitator.goplausible.xyz)
x402 facilitator. It is **receive-only**: it holds no signing key — it only
advertises a payout address, and the payer's wallet + the facilitator do the
settlement.

Sibling of the main NetIntel service (`netintel.dev`), which serves the same
endpoints on Base. This is a peer resource server, not a proxy: it re-implements
nothing and calls nothing upstream.

## Architecture: three Algorand-specific files, everything else is a copy

`src/routes/*.ts` (121 files), `src/utils/*.ts` and `src/services/*.ts` are
**byte-identical copies of NetIntel's**, as are `src/netintel-config.ts` (NetIntel's
whole config module), `src/mirror-402-body.ts`, `src/payment-headers.ts`,
`src/head-challenge.ts` and `src/service-metadata.ts`. They are payment-agnostic —
handler logic, pricing tables and 402-shape helpers that never name a rail.
`src/route-table.ts` is **generated** from NetIntel's `index.ts`: the helper consts,
the `routes` map, its post-map fixups and every router. Only three files are
Algorand-specific:

| File | Role |
| --- | --- |
| `src/config.ts` | Binds `config` (payTo, network, challenge tag) to Algorand env vars and re-exports NetIntel's `pricing` / `timeouts` / `limits` / … tables verbatim. |
| `src/accepts.ts` | The rail adapter. `paidAccepts()` / `signableAccepts()` — the same names NetIntel binds to Base + Solana — build ONE Algorand USDC option, carrying the challenge tag in `extra.tag`. |
| `src/index.ts` | The AVM resource server: `@x402-avm/*` + GoPlausible + `registerExactAvmScheme`, the 402-shape middleware, discovery and analytics wiring. ~170 lines. |

Keeping the copies verbatim is what makes upstream changes a one-command replay —
a new NetIntel endpoint appears here on the next sync, priced and described
identically:

```bash
npm run sync:from-netintel            # replay routes/ utils/ services/, the single files and the route table
npm run sync:from-netintel -- --check # report drift, write nothing (exit 1 if drift)
npm run typecheck                     # then prove the lift still compiles
```

The lift is anchored on markers in NetIntel's `index.ts` and derives its import
header from what the lifted text actually references (parsed, not grepped). It
refuses loudly if Base wiring or a module this repo cannot provide would leak
through — extend `src/accepts.ts` / `src/config.ts` or the sync's `MODULE_MAP`
when that happens. `src/SYNCED-FROM.txt` records the NetIntel commit last
synced. **Never hand-edit a synced or generated file** — changes belong in the
three files above, or upstream in NetIntel.

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
| `X402_CHALLENGE_TAG` | Algorand Global x402 Challenge tag put in every accept's `extra.tag` (the facilitator copies it into its catalog row; the hackathon filter + leaderboard select on it). Defaults to `x402-global-challenge`; set empty to stop tagging. |
| `EXA_API_KEY` | Required by `/exa/*` and `/web/search` (503, uncharged, without it). Other upstream keys — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ABUSEIPDB_API_KEY`, `OTX_API_KEY` and the optional ones — are listed in `.env.example`. |
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
