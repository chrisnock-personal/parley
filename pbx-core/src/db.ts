// src/db.ts -the one narrow exception to pbx-core being database-free (see
// config.ts's comment and CLAUDE.md's design decisions): read-only lookups
// of what pbx-core needs per call and can't get any other way:
//  * a directory user's precomputed SIP digest credential (digestAuth.ts),
//    plus, in the same row/query, whether they're SIP-REC recorded and
//    their display name (siprec.ts's metadata);
//  * the global SIP-REC recording server URI (system_settings).
// No writes, and all short-TTL cached -everything else pbx-core does stays
// exactly as in-memory/stateless as before.
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

// Short -just enough to absorb a REGISTER's two-request challenge round
// trip and a call's setup, without leaving credential or recording-policy
// changes stale for long.
const CACHE_TTL_MS = 15_000;

export interface UserPolicy {
  ha1: string | null;     // null: unknown/disabled user, or no SIP credential set yet
  siprecEnabled: boolean;
  name: string | null;
}

const userCache = new Map<string, { value: UserPolicy; expiresAt: number }>();

/** Per-extension lookup (case-insensitive). A missing or disabled user comes
 * back as { ha1: null, siprecEnabled: false, name: null }. */
export async function getUserPolicy(extension: string): Promise<UserPolicy> {
  const key = extension.toLowerCase();
  const cached = userCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const { rows } = await pool.query<{ sip_ha1: string | null; siprec_enabled: boolean; name: string }>(
    `SELECT sip_ha1, siprec_enabled, name FROM intercom_directory_users
      WHERE LOWER(extension) = $1 AND enabled = TRUE`,
    [key],
  );
  const r = rows[0];
  const value: UserPolicy = { ha1: r?.sip_ha1 ?? null, siprecEnabled: !!r?.siprec_enabled, name: r?.name ?? null };
  userCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** sip_ha1 for a directory user by extension -see digestAuth.ts. */
export async function getHa1(extension: string): Promise<string | null> {
  return (await getUserPolicy(extension)).ha1;
}

let srsCache: { value: string | null; expiresAt: number } | null = null;

/** The global SIP-REC recording server URI (console: Settings), or null if
 * recording is off globally. */
export async function getSrsUri(): Promise<string | null> {
  if (srsCache && srsCache.expiresAt > Date.now()) return srsCache.value;
  const { rows } = await pool.query<{ value: string | null }>(
    `SELECT value FROM system_settings WHERE key = 'siprec_srs_uri'`,
  );
  const value = rows[0]?.value?.trim() || null;
  srsCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}
