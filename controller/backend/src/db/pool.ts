// src/db/pool.ts
import { readFileSync } from 'node:fs';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import config from '../config';

type PgSslOptions = false | { rejectUnauthorized: boolean; ca?: Buffer };

// Issue #35 L1: PGSSL=true used to disable certificate verification entirely.
// Verify the server by default (system CA store, or PGSSL_CA for a private
// CA). PGSSL_INSECURE is a deliberate, noisy opt-out for self-signed labs.
// A configured but unreadable CA is a hard error: never fall back silently
// to an unverified connection.
export function pgSslOptions(): PgSslOptions {
  if (!config.pgSsl) return false;

  let ca: Buffer | undefined;
  if (config.pgSslCa) {
    try {
      ca = readFileSync(config.pgSslCa);
    } catch (err) {
      throw new Error(`PGSSL_CA file "${config.pgSslCa}" could not be read: ${(err as Error).message}`);
    }
  }

  if (config.pgSslInsecure) {
    console.warn('[db] WARNING: PGSSL_INSECURE is enabled -the Postgres TLS certificate is NOT verified.'
      + ' DB traffic is open to man-in-the-middle attacks. Supply PGSSL_CA instead.');
  }

  return {
    rejectUnauthorized: !config.pgSslInsecure,
    ...(ca ? { ca } : {}),
  };
}

export const pool = new Pool({
  host:     config.pgHost,
  port:     config.pgPort,
  database: config.pgDatabase,
  user:     config.pgUser,
  password: config.pgPassword,
  max:      config.pgPoolMax,
  ssl:      pgSslOptions(),
});

pool.on('error', (err) => console.error('[db] Unexpected pool error:', err.message));

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  sql: string, params?: unknown[]
): Promise<QueryResult<T>> {
  const client = await pool.connect();
  try { return await client.query<T>(sql, params); }
  finally { client.release(); }
}

export async function queryOne<T extends QueryResultRow = Record<string, unknown>>(
  sql: string, params?: unknown[]
): Promise<T | null> {
  const result = await query<T>(sql, params);
  return result.rows[0] ?? null;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
