// Durable storage for "miss" events — requests for routes/capabilities that
// DON'T exist yet. Ported from NetIntel src/miss-log-store.ts (algo_* table).
//
// This is a product-discovery signal: what agents ask for and you don't offer.
// The most valuable misses carry a payment header (`had_payment`) — an agent
// that can pay, asking for something you don't sell.
//
// We deliberately store the request *path + query string + metadata* but NEVER
// the request body (only its declared byte size): bodies can hold arbitrary,
// potentially sensitive content.
//
// Same two-backend pattern as paid-call-store: Postgres when DATABASE_URL is
// present, else an NDJSON file fallback (ephemeral on Railway). Read-only
// consumer: the dashboard.

import { appendFile } from "node:fs/promises";
import path from "node:path";
import { pgPoolConfig } from "./paid-call-store.js";

export interface MissEvent {
  timestamp: string; // ISO-8601 UTC
  method: string;
  path: string; // the unmatched route, e.g. "/whois"
  query: string; // raw query string ("" if none)
  reason: string; // why it missed — "unknown_route" today (room to grow)
  status_code: number; // what we returned (404)
  had_payment: boolean; // request carried an x402 payment header => real intent
  payer_wallet: string; // always "" on AVM (request payload is opaque msgpack)
  payer_ip: string;
  client_ua: string;
  referer: string;
  body_bytes: number; // declared Content-Length; the body itself is never stored
  content_type: string;
}

export interface MissStore {
  init(): Promise<void>;
  write(event: MissEvent): Promise<void>;
  describe(): string;
}

class PostgresMissStore implements MissStore {
  private pool: any;
  private ready: Promise<void> | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly tableName: string = "algo_paid_call_misses"
  ) {}

  init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const pg: any = await import("pg");
        const Pool = pg.default?.Pool ?? pg.Pool;
        this.pool = new Pool(pgPoolConfig(this.connectionString, 2));

        const t = this.tableName; // fixed, code-controlled identifier — safe to interpolate
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS ${t} (
            id            BIGSERIAL PRIMARY KEY,
            timestamp     TIMESTAMPTZ NOT NULL,
            method        TEXT        NOT NULL,
            path          TEXT        NOT NULL,
            query         TEXT,
            reason        TEXT,
            status_code   INTEGER,
            had_payment   BOOLEAN     NOT NULL DEFAULT FALSE,
            payer_wallet  TEXT,
            payer_ip      TEXT,
            client_ua     TEXT,
            referer       TEXT,
            body_bytes    INTEGER,
            content_type  TEXT
          )
        `);
        await this.pool.query(
          `CREATE INDEX IF NOT EXISTS idx_${t}_timestamp ON ${t} (timestamp)`
        );
        await this.pool.query(
          `CREATE INDEX IF NOT EXISTS idx_${t}_path ON ${t} (path)`
        );
      })();
    }
    return this.ready;
  }

  async write(e: MissEvent): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO ${this.tableName}
         (timestamp, method, path, query, reason, status_code, had_payment,
          payer_wallet, payer_ip, client_ua, referer, body_bytes, content_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        e.timestamp,
        e.method,
        e.path,
        e.query,
        e.reason,
        e.status_code,
        e.had_payment,
        e.payer_wallet,
        e.payer_ip,
        e.client_ua,
        e.referer,
        e.body_bytes,
        e.content_type,
      ]
    );
  }

  describe(): string {
    return `postgres (durable, table: ${this.tableName})`;
  }
}

class FileMissStore implements MissStore {
  constructor(
    private readonly filePath: string,
    private readonly stdoutTag: string = "ALGO_MISS_EVENT"
  ) {}

  async init(): Promise<void> {
    // Nothing to prepare; the file is created on first append.
  }

  async write(e: MissEvent): Promise<void> {
    const line = JSON.stringify(e);
    console.log(`${this.stdoutTag} ${line}`);
    await appendFile(this.filePath, line + "\n", "utf8");
  }

  describe(): string {
    return `file:${this.filePath} (STOPGAP — no DATABASE_URL; ephemeral on Railway)`;
  }
}

export function createMissStore(
  env: NodeJS.ProcessEnv = process.env,
  opts: { table?: string; fileName?: string; stdoutTag?: string } = {}
): MissStore {
  const table = opts.table ?? "algo_paid_call_misses";
  if (env.DATABASE_URL) {
    return new PostgresMissStore(env.DATABASE_URL, table);
  }
  const filePath = path.join(process.cwd(), opts.fileName ?? "algo-paid-call-misses.ndjson");
  return new FileMissStore(filePath, opts.stdoutTag ?? "ALGO_MISS_EVENT");
}
