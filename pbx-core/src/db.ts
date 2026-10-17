// src/db.ts -the one narrow exception to pbx-core being database-free (see
// config.ts's comment and CLAUDE.md's design decisions): a read-only lookup
// of directory users' precomputed SIP digest credential, for digestAuth.ts.
// No writes, no other tables -everything else pbx-core does stays exactly
// as in-memory/stateless as before.
import { Pool } from 'pg';
import { config } from './config';

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: 5,
});
pool.on('error', (err) => console.error('[db] unexpected pool error:', err.message));

interface CacheEntry { ha1: string | null; expiresAt: number; }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15_000; // short -just enough to absorb a REGISTER's two-request challenge round trip and any retries, without leaving credential changes stale for long

/** sip_ha1 for a directory user by extension (case-insensitive), or null if
 * the user doesn't exist, is disabled, or has no SIP credential set yet
 * (e.g. right after an extension change -see directoryUserService.ts). */
export async function getHa1(extension: string): Promise<string | null> {
  const key = extension.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.ha1;

  const { rows } = await pool.query<{ sip_ha1: string | null }>(
    `SELECT sip_ha1 FROM intercom_directory_users WHERE LOWER(extension) = $1 AND enabled = TRUE`,
    [key],
  );
  const ha1 = rows[0]?.sip_ha1 ?? null;
  cache.set(key, { ha1, expiresAt: Date.now() + CACHE_TTL_MS });
  return ha1;
}
