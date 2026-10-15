import type { NextFunction, Request, RequestHandler, Response } from "express";
import { PAYMENT_HEADER_NAMES } from "./payment-headers.js";

// HEAD on a paid path → the paywall's own 402 challenge, never the handler.
//
// The @x402 middleware matches routes by their exact "<METHOD> <path>" key, so
// a HEAD request never matches a "GET /x" route and the middleware just calls
// next(). Express then routes HEAD to the .get() handler, which runs in full —
// upstream calls, quota, cache churn — unpaid, and only the body is dropped on
// the wire. Observed on /crypto/market 2026-08-31: every HEAD probe was a 200
// that had fetched Coinbase + CoinGecko. All 61 GET routes behaved the same
// way. (The POST routes carry hand-rolled `.head()` 402 stubs, but those set no
// payment-required header, so even they were not a real challenge.)
//
// The x402-native answer: HEAD must look exactly like an unpaid GET (or POST)
// minus the body — 402 plus the base64 PAYMENT-REQUIRED header, the one
// transport HEAD can carry. A client can then price-discover any endpoint for
// the cost of a header round-trip. We get that without re-implementing the
// envelope by handing the paywall a VIEW of the request whose method is the
// route's real verb and whose payment headers are hidden: the middleware
// produces its genuine 402 (same envelope, same Content-Length as the GET),
// and Express strips the body because the underlying request is still HEAD.
// Payment headers are hidden on purpose — a HEAD is never settled; nobody can
// be charged for a response that has no body.
//
// Free routes (manifest, llms.txt, health, …) are not in `routes` and pass
// through untouched. Register AFTER mirror402Body (the paywall writes through
// its res.json wrapper) and BEFORE the paywall itself.

// The alias list lives in src/payment-headers.ts — one definition, so a new
// alias can never be stripped here and honoured elsewhere (or vice versa).

// The lookup key for a path. Express's default routing is case-insensitive and
// non-strict, so HEAD /Subnet/Calc and HEAD /subnet/calc/ both reach the
// .get("/subnet/calc") handler — and the x402 matcher prices them as that same
// route. An exact `req.path` lookup told them apart: both spellings ran the
// handler unpaid in production until 2026-10-14. Folding case and trailing
// slashes is a superset of what Express matches (it allows only one trailing
// slash), so every spelling that can reach a paid handler gets the challenge;
// the extra ones it catches answer 402 where they used to 404.
function matchKey(path: string): string {
  return path.toLowerCase().replace(/(.+?)\/+$/, "$1");
}

export function headChallenge(routes: Record<string, unknown>, paywall: RequestHandler): RequestHandler {
  // Paid verb per path; GET wins when a path is registered under several verbs.
  const verbByPath = new Map<string, string>();
  for (const key of Object.keys(routes)) {
    const [verb, path] = key.split(" ");
    if (!verb || !path) continue;
    const k = matchKey(path);
    const prev = verbByPath.get(k);
    if (!prev || verb === "GET") verbByPath.set(k, verb);
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "HEAD") return next();
    const verb = verbByPath.get(matchKey(req.path));
    if (!verb) return next();

    const headers = { ...req.headers };
    for (const h of PAYMENT_HEADER_NAMES) delete headers[h];
    // Prototype-chained view: everything the middleware reads (path, query,
    // protocol, originalUrl, header()) resolves to the real request; only the
    // method and the header bag differ. `res` is the real one, so Express still
    // sees req.method === "HEAD" when it decides to omit the body.
    const view = Object.create(req, {
      method: { value: verb, enumerable: true, writable: true, configurable: true },
      headers: { value: headers, enumerable: true, writable: true, configurable: true },
    }) as Request;

    // The paywall only calls next() when it deems the request paid, which the
    // hidden headers make impossible — but never let a HEAD reach a handler.
    paywall(view, res, (err?: unknown) => {
      if (err) return next(err);
      if (!res.headersSent) res.status(402).end();
    });
  };
}
