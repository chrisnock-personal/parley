// Postgres access: which groups have transcription on, members' display
// names, and writing transcript lines (migration 013). Lookups are cached
// briefly; the poll loop asks every couple of seconds.
import { Pool } from 'pg';
import { config } from './config';

const pool = new Pool({ ...config.db, max: 3 });
pool.on('error', (err) => console.error('[db] unexpected pool error:', err.message));

const CACHE_TTL_MS = 5_000;
let groupsCache: { value: Map<string, string>; expiresAt: number } | null = null;
const nameCache = new Map<string, { value: string | null; expiresAt: number }>();

/** dial code -> group id, for groups with transcribe_enabled. */
export async function transcribedGroups(): Promise<Map<string, string>> {
  if (groupsCache && groupsCache.expiresAt > Date.now()) return groupsCache.value;
  const { rows } = await pool.query<{ id: string; dial_code: string }>(
    `SELECT id, dial_code FROM intercom_groups WHERE transcribe_enabled = TRUE`);
  const value = new Map(rows.map((r) => [r.dial_code, r.id]));
  groupsCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export async function displayName(extension: string): Promise<string | null> {
  const cached = nameCache.get(extension);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM intercom_directory_users WHERE extension = $1`, [extension]);
  const value = rows[0]?.name ?? null;
  nameCache.set(extension, { value, expiresAt: Date.now() + 30_000 });
  return value;
}

export async function insertLine(groupId: string, extension: string, name: string | null, text: string, spokenAt: Date) {
  await pool.query(
    `INSERT INTO intercom_transcript_lines (group_id, speaker_extension, speaker_name, text, spoken_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [groupId, extension, name, text, spokenAt]);
}
