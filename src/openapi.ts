/**
 * openapi.ts — x402scan-compatible OpenAPI 3.1 generator.
 *
 * Ported from NetIntel src/openapi.ts, adapted for this service: `accepts` is
 * a single object here (not an array), settlement is USDC on Algorand via the
 * GoPlausible facilitator, and there is no AFTA manifest.
 *
 * Pure (no side effects). Built from the live `routes` object so nothing is
 * hardcoded. The `routes` value's `extensions` field is the *transformed*
 * output of declareDiscoveryExtension (the `bazaar` object), so input params
 * + output schema/example are read back out of `extensions.bazaar`.
 */

interface RouteConfig {
  accepts: { price: string } | ReadonlyArray<{ price: string }>;
  description?: string;
  extensions?: unknown;
}

export interface OpenApiOptions {
  baseUrl?: string;
  title?: string;
  version?: string;
  contactEmail?: string;
  guidance?: string;
}

type Json = Record<string, unknown>;

/** accepts is a single object in this codebase; tolerate the array form too. */
function firstAccepts(route: RouteConfig): { price: string } | undefined {
  return Array.isArray(route.accepts) ? route.accepts[0] : (route.accepts as { price: string });
}

/** "$0.030" -> "0.030000" (strip non-numeric, format to 6 decimals). */
function toAmount(price: string): string {
  const n = parseFloat(price.replace(/[^0-9.]/g, ""));
  return (Number.isFinite(n) ? n : 0).toFixed(6);
}

function tagFor(path: string): string {
  return path.replace(/^\//, "").split("/")[0] || "misc";
}

/** GET /currency-exchange/convert -> "getCurrencyExchangeConvert". */
function operationId(method: string, path: string): string {
  const segs = path
    .replace(/^\//, "")
    .split("/")
    .flatMap((s) => s.split("-"))
    .filter(Boolean);
  return method.toLowerCase() + segs.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

function summaryFrom(text: string, path: string, max = 100): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return path;
  const dot = t.indexOf(". ");
  let s = dot > 0 && dot <= max ? t.slice(0, dot + 1) : t;
  if (s.length > max) s = s.slice(0, max).replace(/\s\S*$/, "").trimEnd() + "…";
  return s;
}

function buildOperation(method: string, path: string, route: RouteConfig): Json {
  const isPost = method.toUpperCase() === "POST";
  const price = firstAccepts(route)?.price ?? "$0";
  const bazaar = (route.extensions as { bazaar?: any } | undefined)?.bazaar;

  // input params: GET -> input.properties.queryParams, POST -> input.properties.body
  const inputProps = bazaar?.schema?.properties?.input?.properties as Record<string, any> | undefined;
  const paramSchema = (isPost ? inputProps?.body : inputProps?.queryParams) as
    | { properties?: Record<string, any>; required?: string[] }
    | undefined;
  const props: Record<string, any> = paramSchema?.properties ?? {};
  const required: string[] = paramSchema?.required ?? [];

  // output: schema lives under output.properties.example, example under info.output.example
  const outSchema = bazaar?.schema?.properties?.output?.properties?.example as Json | undefined;
  const outExample = bazaar?.info?.output?.example;

  const op: Json = {
    operationId: operationId(method, path),
    summary: summaryFrom(route.description ?? "", path),
    tags: [tagFor(path)],
  };

  if (isPost) {
    op.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: { type: "object", properties: props, ...(required.length ? { required } : {}) },
        },
      },
    };
  } else {
    op.parameters = Object.entries(props).map(([name, sch]) => ({
      name,
      in: "query",
      required: required.includes(name),
      ...(sch?.description ? { description: sch.description as string } : {}),
      schema: {
        type: (sch?.type as string) ?? "string",
        ...(sch?.items ? { items: sch.items } : {}),
        ...(sch?.enum ? { enum: sch.enum } : {}),
      },
    }));
  }

  op["x-payment-info"] = {
    price: { mode: "fixed", currency: "USD", amount: toAmount(price) },
    protocols: [{ x402: {} }],
  };

  op.responses = {
    "200": {
      description: "Successful response",
      content: {
        "application/json": {
          schema: outSchema ?? { type: "object" },
          ...(outExample !== undefined ? { example: outExample } : {}),
        },
      },
    },
    "402": { description: "Payment Required" },
  };

  return op;
}

export function buildOpenApiSpec(routes: Record<string, RouteConfig>, opts: OpenApiOptions = {}): Json {
  const entries = Object.entries(routes);
  const count = entries.length;
  const title = opts.title ?? "NetIntel Algo API";
  const version = opts.version ?? "1.0.0";
  const contactEmail = opts.contactEmail ?? "support@netintel.dev";
  const guidance =
    opts.guidance ??
    `NetIntel Algo provides ${count} pay-per-call endpoints for AI agents — currency ` +
      `exchange, domain intelligence, sentiment analysis, structured extraction, chat ` +
      `completions, and AI image generation. Every endpoint is paid per call over the ` +
      `x402 micropayment protocol, settling USDC on Algorand via the GoPlausible ` +
      `facilitator (no API keys, no subscriptions). Call any endpoint normally; if ` +
      `unpaid it returns HTTP 402 with payment requirements, then pay and retry with ` +
      `an X-PAYMENT header. The per-call price is in each operation's x-payment-info.`;

  const paths: Record<string, Json> = {};

  // Free /health — security:[] marks it free so the x402scan scanner skips it.
  paths["/health"] = {
    get: {
      operationId: "getHealth",
      summary: "Health check (free, no payment)",
      tags: ["meta"],
      security: [],
      responses: {
        "200": {
          description: "Service is healthy",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { status: { type: "string" }, network: { type: "string" } },
              },
            },
          },
        },
      },
    },
  };

  for (const [key, route] of entries) {
    const sp = key.indexOf(" ");
    if (sp < 0) continue;
    const method = key.slice(0, sp);
    const path = key.slice(sp + 1);
    if (!method || !path) continue;
    const existing = (paths[path] as Json) ?? {};
    paths[path] = { ...existing, [method.toLowerCase()]: buildOperation(method, path, route) };
  }

  return {
    openapi: "3.1.0",
    info: {
      title,
      version,
      description: `Pay-per-call API for AI agents — ${count} endpoints, all paid per call via x402 micropayments (USDC on Algorand, gasless settlement through the GoPlausible facilitator). Failed calls (HTTP >= 400) are never charged.`,
      "x-guidance": guidance,
      contact: { email: contactEmail },
    },
    ...(opts.baseUrl ? { servers: [{ url: opts.baseUrl }] } : {}),
    paths,
  };
}
