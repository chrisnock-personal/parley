// src/services/sessionCheck.ts
// What a token alone can't tell (issue #25): whether its user is still
// allowed in. A JWT stays valid until it expires, so without this a client
// user whose login was turned off, or a console user set inactive, kept
// using the API, and a console role change only applied at the next login.
// Checked on every request by the two auth middlewares, cached per user for
// TTL_MS (one indexed query per user per 15 s at most); console edits to a
// person drop their entry at once.
import { queryOne } from '../db/pool';

const TTL_MS = 15_000;

type ConsoleState = { active: boolean; role: string | null; passwordChanged: boolean };
const consoleUsers = new Map<string, { value: ConsoleState; expiresAt: number }>();
const clientUsers = new Map<string, { value: boolean; expiresAt: number }>();

/** A console user: still active, their current role, and whether they've
 * replaced the password they were given (#36). */
export async function consoleUserState(id: string): Promise<ConsoleState> {
  const hit = consoleUsers.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const row = await queryOne<{ is_active: boolean; role: string; password_changed: boolean }>(
    `SELECT is_active, role, password_changed FROM users WHERE id = $1`, [id]);
  const value = { active: !!row?.is_active, role: row?.role ?? null, passwordChanged: !!row?.password_changed };
  consoleUsers.set(id, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

/** A directory (intercom client) user: still exists and may log in. */
export async function clientUserEnabled(id: string): Promise<boolean> {
  const hit = clientUsers.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const row = await queryOne<{ enabled: boolean }>(`SELECT enabled FROM intercom_directory_users WHERE id = $1`, [id]);
  const value = !!row?.enabled;
  clientUsers.set(id, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export function forgetClientUser(id: string) { clientUsers.delete(id); }
export function forgetConsoleUser(id: string) { consoleUsers.delete(id); }
