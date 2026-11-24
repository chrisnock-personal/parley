// src/services/secretBox.ts
// Secrets the backend has to send as they are (endpoint API tokens, #34) are
// stored encrypted: AES-256-GCM, "v1:" + base64(iv | tag | ciphertext).
// The key is derived from JWT_SECRET with HKDF under its own label, so there's
// nothing new to configure; changing JWT_SECRET makes stored secrets
// unreadable (they're logged and treated as unset: regenerate them).
import * as crypto from 'crypto';
import { query } from '../db/pool';
import config from '../config';

const KEY = Buffer.from(crypto.hkdfSync('sha256', config.jwtSecret, 'parley', 'parley secret box v1', 32));
const PREFIX = 'v1:';

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

/** The plaintext, or null if unset or unreadable. A value without the
 * prefix is from before encryption and is returned as it is. */
export function open(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    const b = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    console.error('[secrets] a stored secret can\'t be decrypted (was JWT_SECRET changed?); treating it as unset');
    return null;
  }
}

/** At start: encrypt any endpoint API token still stored in plaintext. */
export async function sealLegacySecrets(): Promise<void> {
  const { rows } = await query<{ id: string; api_token: string }>(
    `SELECT id, api_token FROM intercom_endpoints WHERE api_token IS NOT NULL AND api_token NOT LIKE 'v1:%'`);
  for (const r of rows) await query(`UPDATE intercom_endpoints SET api_token = $1 WHERE id = $2`, [seal(r.api_token), r.id]);
  if (rows.length) console.log(`[secrets] encrypted ${rows.length} endpoint API token(s)`);
}
