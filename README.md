# netintel-algo

Standalone currency-exchange microservice that settles payments on **Algorand
mainnet** via the [GoPlausible](https://facilitator.goplausible.xyz) x402
facilitator. It is **receive-only**: it holds no signing key and no secrets — it
only advertises a payout address, and the payer's wallet + the facilitator do
the settlement.

## Endpoints

- `GET /health` — free, returns `200` (used by Railway's healthcheck).
- `GET /currency-exchange/convert?from=USD&to=EUR&amount=100` — paid ($0.010).
  Without payment it returns `402` with Algorand payment requirements; with a
  valid `X-PAYMENT` it settles USDC and returns the conversion.

Fiat↔fiat uses ECB reference rates (Frankfurter); crypto pairs use Coinbase spot
rates. Both upstreams are keyless.

## Configuration (env only)

| Var | Purpose |
| --- | --- |
| `X402_NETWORK` | CAIP-2 network id. Mainnet: `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=`. The USDC ASA (mainnet `31566704`) is derived from this — not hardcoded. |
| `PAYTO_ADDRESS` | Algorand payout address (must be opted in to USDC ASA `31566704`). |
| `PORT` | HTTP port. Injected automatically by Railway. |

No signing key is required. See `.env.example`.

## Run locally

```bash
npm install
cp .env.example .env   # fill in PAYTO_ADDRESS
npm start              # listens on 0.0.0.0:$PORT
```

## Deploy

Nixpacks-based Railway deploy: `npm start` runs `tsx src/server.ts`.
Healthcheck path is `/health` (see `railway.json`).
