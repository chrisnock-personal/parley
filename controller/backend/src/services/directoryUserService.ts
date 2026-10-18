// src/services/directoryUserService.ts
// Directory users are intercom-client-login people -distinct from `users`
// (console operator login, userService.ts). See migrations/008_directory_users.sql.
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query, queryOne } from '../db/pool';
import { createError } from '../middleware/errorHandler';

// Must match pbx-core's SIP_REALM (src/digestAuth.ts) -separate
// deployables, no shared code between them, same convention as
// GROUP_PREFIX elsewhere in this codebase. If you change one, change both.
const SIP_REALM = 'parley';

// RFC 2617 HA1 = MD5(username:realm:password), computed once here so the
// plaintext password never has to live at the SIP layer -pbx-core only
// ever reads this precomputed hash (see migrations/011's comment). The
// "username" baked into the hash is the extension, lowercased to match how
// every other extension lookup in this file is case-insensitive.
function computeSipHa1(extension: string, password: string): string {
  return crypto.createHash('md5').update(`${extension.toLowerCase()}:${SIP_REALM}:${password}`).digest('hex');
}

export interface DirectoryUser {
  id: string;
  name: string;
  extension: string;
  enabled: boolean;
  siprec_enabled: boolean; // SIP-REC: pbx-core records this user's calls (migration 013)
  created_at: string;
  updated_at: string;
}

export interface DirectoryUserButton {
  id: string;
  directory_user_id: string;
  button_type: 'direct' | 'group';
  target_extension: string | null;
  target_group_id: string | null;
  target_group_name: string | null;
  target_group_dial_code: string | null; // group buttons dial GROUP_PREFIX + this, e.g. "*8" + "floor-a"
  target_group_ptt_default: boolean | null; // group's PTT default -intercom client starts muted (PTT) or talking (open mic) accordingly
  target_group_transcribe_enabled: boolean | null; // group has live transcription on -client shows its transcript panel
  target_name: string | null; // direct buttons: the target directory user's name, for the key label
  label: string | null;
  sort_order: number;
}

const PUBLIC_COLUMNS = 'id, name, extension, enabled, siprec_enabled, created_at, updated_at';

/** pbx-core's registrar is one flat in-memory AOR namespace shared by
 * intercom_endpoints.aor and directory-user extensions -reject a collision
 * here since Postgres can't enforce it as a cross-table constraint cheaply. */
async function assertExtensionAvailable(extension: string, excludeId?: string): Promise<void> {
  const endpointClash = await queryOne(
    `SELECT id FROM intercom_endpoints WHERE LOWER(aor) LIKE LOWER($1)`,
    [`sip:${extension}@%`]);
  if (endpointClash) throw createError(`Extension ${extension} is already used by a station`, 409);

  // Cast the fallback literal to uuid explicitly -otherwise Postgres infers
  // COALESCE($2, '...')'s result as text (since a bare string literal
  // defaults to unknown/text), and `id != <text>` has no operator overload
  // against a uuid column ("operator does not exist: uuid <> text").
  const userClash = await queryOne(
    `SELECT id FROM intercom_directory_users WHERE LOWER(extension) = LOWER($1) AND id != COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [extension, excludeId ?? null]);
  if (userClash) throw createError(`Extension ${extension} is already assigned to another directory user`, 409);
}

export async function listDirectoryUsers(): Promise<DirectoryUser[]> {
  const { rows } = await query<DirectoryUser>(
    `SELECT ${PUBLIC_COLUMNS} FROM intercom_directory_users ORDER BY name`);
  return rows;
}

export async function getDirectoryUser(id: string): Promise<DirectoryUser> {
  const u = await queryOne<DirectoryUser>(
    `SELECT ${PUBLIC_COLUMNS} FROM intercom_directory_users WHERE id = $1`, [id]);
  if (!u) throw createError('Directory user not found', 404);
  return u;
}

export async function createDirectoryUser(
  actor: string, fields: { name: string; extension: string; password: string }
): Promise<DirectoryUser> {
  const { name, extension, password } = fields;
  if (!name || !extension || !password) throw createError('name, extension, and password are required', 400);
  await assertExtensionAvailable(extension);

  const hash = await bcrypt.hash(password, 12);
  const ha1 = computeSipHa1(extension, password);
  const u = await queryOne<DirectoryUser>(
    `INSERT INTO intercom_directory_users (name, extension, password_hash, sip_ha1, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING ${PUBLIC_COLUMNS}`,
    [name, extension, hash, ha1, actor]);
  if (!u) throw createError('Failed to create directory user', 500);
  return u;
}

export async function updateDirectoryUser(
  actor: string, id: string, fields: { name?: string; extension?: string; enabled?: boolean; siprec_enabled?: boolean }
): Promise<DirectoryUser> {
  const current = await getDirectoryUser(id);
  const name = fields.name ?? current.name;
  const extension = fields.extension ?? current.extension;
  const enabled = fields.enabled ?? current.enabled;
  const siprecEnabled = fields.siprec_enabled ?? current.siprec_enabled;
  const extensionChanged = !!fields.extension && fields.extension !== current.extension;
  if (extensionChanged) {
    await assertExtensionAvailable(fields.extension!, id);
  }

  // sip_ha1 bakes the extension into the hash (HA1 = MD5(username:realm:
  // password), RFC 2617) -changing the extension without the plaintext
  // password (which we never have after bcrypt-hashing it) makes the old
  // hash wrong for the new username. Null it out rather than leave a stale
  // value that would just fail every SIP auth attempt with no clear cause;
  // a password reset (which recomputes it against the new extension) is
  // required afterward for SIP registration to work again -console UI
  // should surface that, not silently swallow it.
  const u = await queryOne<DirectoryUser>(
    `UPDATE intercom_directory_users
     SET name = $1, extension = $2, enabled = $3, siprec_enabled = $4, updated_by = $5
         ${extensionChanged ? ', sip_ha1 = NULL' : ''}
     WHERE id = $6 RETURNING ${PUBLIC_COLUMNS}`,
    [name, extension, enabled, siprecEnabled, actor, id]);
  if (!u) throw createError('Directory user not found', 404);
  return u;
}

export async function deleteDirectoryUser(id: string): Promise<void> {
  const result = await query(`DELETE FROM intercom_directory_users WHERE id = $1`, [id]);
  if (result.rowCount === 0) throw createError('Directory user not found', 404);
}

export async function resetPassword(id: string, password: string): Promise<void> {
  if (!password || password.length < 4) throw createError('password must be at least 4 characters', 400);
  const current = await getDirectoryUser(id); // need the extension for sip_ha1 -see computeSipHa1
  const hash = await bcrypt.hash(password, 12);
  const ha1 = computeSipHa1(current.extension, password);
  const result = await query(
    `UPDATE intercom_directory_users SET password_hash = $1, sip_ha1 = $2 WHERE id = $3`,
    [hash, ha1, id]);
  if (result.rowCount === 0) throw createError('Directory user not found', 404);
}

/** Used by the intercom client login endpoint. Extension is the login identifier. */
export async function authenticateDirectoryUser(extension: string, password: string): Promise<DirectoryUser> {
  const user = await queryOne<DirectoryUser & { password_hash: string; sip_ha1: string | null }>(
    `SELECT * FROM intercom_directory_users WHERE LOWER(extension) = LOWER($1) AND enabled = TRUE`,
    [extension]);
  if (!user) throw createError('Invalid credentials', 401);
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw createError('Invalid credentials', 401);
  // Login is the one moment the plaintext password is here, so bring the
  // SIP digest hash up to date if it's stale: after the realm changed
  // (open-intercom -> parley, 2026-10-18), or after an extension change
  // nulled it (see updateDirectoryUser). The client registers right after
  // logging in; pbx-core's HA1 cache (15 s) may make that first attempt
  // fail once, and JsSIP retries.
  const ha1 = computeSipHa1(user.extension, password);
  if (user.sip_ha1 !== ha1) {
    await query(`UPDATE intercom_directory_users SET sip_ha1 = $1 WHERE id = $2`, [ha1, user.id]);
  }
  return user;
}

export async function listButtons(directoryUserId: string): Promise<DirectoryUserButton[]> {
  const { rows } = await query<DirectoryUserButton>(
    `SELECT b.id, b.directory_user_id, b.button_type, b.target_extension, b.target_group_id,
            g.name AS target_group_name, g.dial_code AS target_group_dial_code,
            g.ptt_default AS target_group_ptt_default,
            g.transcribe_enabled AS target_group_transcribe_enabled,
            t.name AS target_name,
            b.label, b.sort_order
     FROM intercom_directory_user_buttons b
     LEFT JOIN intercom_groups g ON g.id = b.target_group_id
     LEFT JOIN intercom_directory_users t ON b.button_type = 'direct' AND t.extension = b.target_extension
     WHERE b.directory_user_id = $1
     ORDER BY b.sort_order, b.created_at`,
    [directoryUserId]);
  return rows;
}

export async function addButton(
  directoryUserId: string,
  fields: {
    button_type: 'direct' | 'group';
    target_extension?: string;
    target_group_id?: string;
    label?: string;
    sort_order?: number;
  }
): Promise<DirectoryUserButton> {
  const { button_type, target_extension, target_group_id, label, sort_order } = fields;
  if (!['direct', 'group'].includes(button_type)) throw createError('button_type must be direct or group', 400);
  if (button_type === 'direct' && !target_extension) throw createError('target_extension is required for a direct button', 400);
  if (button_type === 'group' && !target_group_id) throw createError('target_group_id is required for a group button', 400);

  // One button per target: a second one for the same person or group just
  // showed up as a duplicate card in the intercom client (both driving the
  // same call), so refuse it.
  const dup = await queryOne<{ id: string }>(
    `SELECT id FROM intercom_directory_user_buttons
      WHERE directory_user_id = $1 AND button_type = $2
        AND (target_extension = $3 OR target_group_id = $4)`,
    [directoryUserId, button_type,
      button_type === 'direct' ? target_extension : null,
      button_type === 'group' ? target_group_id : null]);
  if (dup) throw createError('This user already has a button for that target', 409);

  const b = await queryOne<{ id: string }>(
    `INSERT INTO intercom_directory_user_buttons
       (directory_user_id, button_type, target_extension, target_group_id, label, sort_order)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,0))
     RETURNING id`,
    [directoryUserId, button_type,
      button_type === 'direct' ? target_extension : null,
      button_type === 'group' ? target_group_id : null,
      label ?? null, sort_order ?? null]);
  if (!b) throw createError('Failed to create button', 500);
  const all = await listButtons(directoryUserId);
  return all.find((x) => x.id === b.id)!;
}

export async function removeButton(directoryUserId: string, buttonId: string): Promise<void> {
  const result = await query(
    `DELETE FROM intercom_directory_user_buttons WHERE id = $1 AND directory_user_id = $2`,
    [buttonId, directoryUserId]);
  if (result.rowCount === 0) throw createError('Button not found', 404);
}

// ---- Profile pictures (migration 014) -------------------------------------

/** extension -> version (ms since epoch of the last change), for everyone
 * who has a picture. Versions go into the image URL, so caches refresh. */
export async function avatarVersions(): Promise<Record<string, number>> {
  const { rows } = await query<{ extension: string; v: string }>(
    `SELECT extension, (EXTRACT(EPOCH FROM avatar_updated_at) * 1000)::bigint AS v
       FROM intercom_directory_users WHERE avatar IS NOT NULL AND enabled = TRUE`);
  return Object.fromEntries(rows.map((r) => [r.extension, Number(r.v)]));
}

export async function getAvatar(extension: string): Promise<{ data: Buffer; mime: string } | null> {
  const r = await queryOne<{ avatar: Buffer; avatar_mime: string }>(
    `SELECT avatar, avatar_mime FROM intercom_directory_users WHERE extension = $1 AND avatar IS NOT NULL`, [extension]);
  return r ? { data: r.avatar, mime: r.avatar_mime } : null;
}

export async function setAvatar(id: string, data: Buffer | null, mime: string | null): Promise<void> {
  await query(
    `UPDATE intercom_directory_users SET avatar = $1, avatar_mime = $2,
            avatar_updated_at = CASE WHEN $1::bytea IS NULL THEN NULL ELSE now() END
      WHERE id = $3`, [data, mime, id]);
}
