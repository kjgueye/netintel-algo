// Durable storage for paid-call events, ported from NetIntel src/paid-call-store.ts.
//
// Two backends, chosen at runtime by whether DATABASE_URL is present:
//   - PostgresStore  : the real, durable path. Auto-creates an additive
//                      `algo_paid_call_events` table. This service shares the
//                      main NetIntel Postgres but ONLY ever touches its own
//                      algo_* tables — CREATE TABLE IF NOT EXISTS never alters
//                      existing tables, so the Base/EVM data cannot be affected.
//   - FileStore      : STOPGAP fallback when no DB is configured. Appends NDJSON
//                      and echoes a tagged line to stdout (ephemeral on Railway).
//
// Deltas from the NetIntel original: algo_* default table names, a `network`
// column (CAIP-2, e.g. "algorand:wGHE2…") so a testnet/mainnet split never needs
// a second table set, TLS sniffing for Railway public-proxy connection strings,
// and pool max 2 (shared Postgres, three small pools in this service).

import { appendFile } from "node:fs/promises";
import path from "node:path";

export interface PaidCallEvent {
  timestamp: string; // ISO-8601 UTC
  endpoint: string;
  method: string;
  price_usdc: string; // decimal string, e.g. "0.010" — SUM(price_usdc::numeric) works
  payer_wallet: string; // 58-char Algorand address (from the settlement result), or ""
  payer_ip: string;
  client_ua: string;
  status_code: number;
  duration_ms: number;
  cached: boolean;
  tx_hash: string | null; // Algorand transaction id (52 chars); name kept for query symmetry
  network: string; // CAIP-2 network id the call settled on
  meta?: Record<string, unknown> | null;
}

export interface PaidCallStore {
  /** Prepare the backend (create table + indexes). Idempotent; called at boot. */
  init(): Promise<void>;
  write(event: PaidCallEvent): Promise<void>;
  /** Human-readable description of the active backend, for the boot log. */
  describe(): string;
}

/**
 * Pool config for a Railway Postgres connection string: internal hosts speak
 * plaintext, the public proxy requires TLS (self-signed chain → no verify).
 */
export function pgPoolConfig(connectionString: string, max: number): Record<string, unknown> {
  return {
    connectionString,
    max,
    ssl: /railway\.internal/.test(connectionString) ? false : { rejectUnauthorized: false },
  };
}

class PostgresStore implements PaidCallStore {
  private pool: any;
  private ready: Promise<void> | null = null;

  // `tableName` is a fixed, code-controlled identifier (never user input), so it
  // is safe to interpolate into DDL/DML.
  constructor(
    private readonly connectionString: string,
    private readonly tableName: string = "algo_paid_call_events"
  ) {}

  init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        // Dynamic import so the app still builds/runs on the file-fallback path.
        const pg: any = await import("pg");
        const Pool = pg.default?.Pool ?? pg.Pool;
        this.pool = new Pool(pgPoolConfig(this.connectionString, 2));

        const t = this.tableName;
        // Additive only — CREATE TABLE IF NOT EXISTS never alters existing tables.
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS ${t} (
            id            BIGSERIAL PRIMARY KEY,
            timestamp     TIMESTAMPTZ NOT NULL,
            endpoint      TEXT        NOT NULL,
            method        TEXT        NOT NULL,
            price_usdc    TEXT,
            payer_wallet  TEXT,
            payer_ip      TEXT,
            client_ua     TEXT,
            status_code   INTEGER,
            duration_ms   INTEGER,
            cached        BOOLEAN     NOT NULL DEFAULT FALSE,
            tx_hash       TEXT,
            network       TEXT,
            meta          JSONB
          )
        `);
        await this.pool.query(
          `CREATE INDEX IF NOT EXISTS idx_${t}_timestamp ON ${t} (timestamp)`
        );
        await this.pool.query(
          `CREATE INDEX IF NOT EXISTS idx_${t}_endpoint ON ${t} (endpoint)`
        );
        await this.pool.query(
          `CREATE INDEX IF NOT EXISTS idx_${t}_payer_wallet ON ${t} (payer_wallet)`
        );
      })();
    }
    return this.ready;
  }

  async write(e: PaidCallEvent): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO ${this.tableName}
         (timestamp, endpoint, method, price_usdc, payer_wallet, payer_ip,
          client_ua, status_code, duration_ms, cached, tx_hash, network, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        e.timestamp,
        e.endpoint,
        e.method,
        e.price_usdc,
        e.payer_wallet,
        e.payer_ip,
        e.client_ua,
        e.status_code,
        e.duration_ms,
        e.cached,
        e.tx_hash,
        e.network,
        e.meta == null ? null : JSON.stringify(e.meta),
      ]
    );
  }

  describe(): string {
    return `postgres (durable, table: ${this.tableName})`;
  }
}

class FileStore implements PaidCallStore {
  constructor(
    private readonly filePath: string,
    private readonly stdoutTag: string = "ALGO_PAID_CALL_EVENT"
  ) {}

  async init(): Promise<void> {
    // Nothing to prepare; the file is created on first append.
  }

  async write(e: PaidCallEvent): Promise<void> {
    const line = JSON.stringify(e);
    // Tagged stdout line so it's greppable in Railway logs even if the file is lost.
    console.log(`${this.stdoutTag} ${line}`);
    await appendFile(this.filePath, line + "\n", "utf8");
  }

  describe(): string {
    return `file:${this.filePath} (STOPGAP — no DATABASE_URL; ephemeral on Railway)`;
  }
}

export interface CreateStoreOptions {
  /** Postgres table name (default "algo_paid_call_events"). */
  table?: string;
  /** File-fallback filename, relative to cwd. */
  fileName?: string;
  /** Stdout prefix for the file fallback (default "ALGO_PAID_CALL_EVENT"). */
  stdoutTag?: string;
}

export function createStore(
  env: NodeJS.ProcessEnv = process.env,
  opts: CreateStoreOptions = {}
): PaidCallStore {
  const table = opts.table ?? "algo_paid_call_events";
  const stdoutTag = opts.stdoutTag ?? "ALGO_PAID_CALL_EVENT";
  if (env.DATABASE_URL) {
    return new PostgresStore(env.DATABASE_URL, table);
  }
  const filePath = path.join(process.cwd(), opts.fileName ?? "algo-paid-call-events.ndjson");
  return new FileStore(filePath, stdoutTag);
}
