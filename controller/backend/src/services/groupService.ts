// src/services/groupService.ts
import { query, queryOne } from '../db/pool';
import { createError } from '../middleware/errorHandler';

export interface Group {
  id: string;
  name: string;
  description: string | null;
  mode: 'talkback' | 'announce';
  ptt_default: boolean;
  dial_code: string;
  transcribe_enabled: boolean; // live transcription by the transcriber service (migration 013)
  chat_enabled: boolean;       // typed group chat (migration 016)
  created_at: string;
  updated_at: string;
}

export interface GroupMember {
  id: string;
  group_id: string;
  endpoint_id: string;
  endpoint_name: string;
  rest_url: string | null;
  role: 'member' | 'announcer';
  can_talk: boolean;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
}

export async function listGroups(): Promise<Group[]> {
  const { rows } = await query<Group>(`SELECT * FROM intercom_groups ORDER BY name`);
  return rows;
}

/** The console's Groups list: each group plus how many people have a
 * button for it. */
export async function listGroupsSummary(): Promise<(Group & { holder_count: number })[]> {
  const { rows } = await query<Group & { holder_count: number }>(
    `SELECT g.*, COUNT(b.id)::int AS holder_count
       FROM intercom_groups g
       LEFT JOIN intercom_directory_user_buttons b ON b.target_group_id = g.id
      GROUP BY g.id
      ORDER BY g.name`);
  return rows;
}

/** Who has a button for this group (so it's on their intercom client). */
export interface GroupHolder { button_id: string; user_id: string; name: string; extension: string; can_talk: boolean }

export async function listGroupHolders(groupId: string): Promise<GroupHolder[]> {
  await getGroup(groupId);
  const { rows } = await query<GroupHolder>(
    `SELECT b.id AS button_id, u.id AS user_id, u.name, u.extension, b.can_talk
       FROM intercom_directory_user_buttons b
       JOIN intercom_directory_users u ON u.id = b.directory_user_id
      WHERE b.target_group_id = $1
      ORDER BY u.name`, [groupId]);
  return rows;
}

/** Listen-only groups: whether this holder talks (issue #11). Returns the
 * holder's name for the audit entry. */
export async function setHolderCanTalk(groupId: string, buttonId: string, canTalk: boolean): Promise<GroupHolder> {
  const row = await queryOne<GroupHolder>(
    `UPDATE intercom_directory_user_buttons b SET can_talk = $3
       FROM intercom_directory_users u
      WHERE b.id = $2 AND b.target_group_id = $1 AND u.id = b.directory_user_id
      RETURNING b.id AS button_id, u.id AS user_id, u.name, u.extension, b.can_talk`,
    [groupId, buttonId, canTalk]);
  if (!row) throw createError('Not a holder of this group', 404);
  return row;
}

/** Extensions that talk in each listen-only group, by dial code. */
export async function talkersByDialCode(dialCodes: string[]): Promise<Record<string, string[]>> {
  if (!dialCodes.length) return {};
  const { rows } = await query<{ dial_code: string; extension: string }>(
    `SELECT g.dial_code, u.extension
       FROM intercom_directory_user_buttons b
       JOIN intercom_groups g ON g.id = b.target_group_id
       JOIN intercom_directory_users u ON u.id = b.directory_user_id
      WHERE g.mode = 'announce' AND b.can_talk AND g.dial_code = ANY($1)`, [dialCodes]);
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.dial_code] ??= []).push(r.extension);
  return out;
}

export async function getGroup(id: string): Promise<Group> {
  const g = await queryOne<Group>(`SELECT * FROM intercom_groups WHERE id = $1`, [id]);
  if (!g) throw createError('Group not found', 404);
  return g;
}

export async function getGroupByDialCode(dialCode: string): Promise<Group | null> {
  return queryOne<Group>(`SELECT * FROM intercom_groups WHERE dial_code = $1`, [dialCode]);
}

export async function createGroup(
  actor: string,
  fields: { name: string; description?: string; mode?: 'talkback' | 'announce'; ptt_default?: boolean; dial_code?: string }
): Promise<Group> {
  const dialCode = fields.dial_code?.trim() || slugify(fields.name);
  if (!dialCode) throw createError('Could not derive a dial code from the group name', 400);
  const g = await queryOne<Group>(
    `INSERT INTO intercom_groups (name, description, mode, ptt_default, dial_code, created_by, updated_by)
     VALUES ($1,$2,COALESCE($3,'talkback'),COALESCE($4,FALSE),$5,$6,$6)
     RETURNING *`,
    [fields.name, fields.description ?? null, fields.mode ?? null, fields.ptt_default ?? null, dialCode, actor]
  );
  if (!g) throw createError('Failed to create group', 500);
  return g;
}

export async function updateGroup(
  actor: string,
  id: string,
  fields: { name?: string; description?: string; mode?: 'talkback' | 'announce'; ptt_default?: boolean; dial_code?: string; transcribe_enabled?: boolean; chat_enabled?: boolean }
): Promise<Group> {
  const current = await getGroup(id);
  const name = fields.name ?? current.name;
  const description = fields.description ?? current.description;
  const mode = fields.mode ?? current.mode;
  const pttDefault = fields.ptt_default ?? current.ptt_default;
  const dialCode = fields.dial_code?.trim() || current.dial_code;
  const transcribe = fields.transcribe_enabled ?? current.transcribe_enabled;
  const chat = fields.chat_enabled ?? current.chat_enabled;

  const g = await queryOne<Group>(
    `UPDATE intercom_groups SET name = $1, description = $2, mode = $3, ptt_default = $4, dial_code = $5,
            transcribe_enabled = $6, chat_enabled = $7, updated_by = $8
     WHERE id = $9 RETURNING *`,
    [name, description, mode, pttDefault, dialCode, transcribe, chat, actor, id]
  );
  if (!g) throw createError('Group not found', 404);
  return g;
}

/** Cascades: intercom_directory_user_buttons.target_group_id and
 * intercom_group_members.group_id both ON DELETE CASCADE -any button
 * pointing at this group is removed too, along with its membership rows. */
export async function deleteGroup(id: string): Promise<void> {
  const result = await query(`DELETE FROM intercom_groups WHERE id = $1`, [id]);
  if (result.rowCount === 0) throw createError('Group not found', 404);
}

export async function listMembers(groupId: string): Promise<GroupMember[]> {
  const { rows } = await query<GroupMember>(
    `SELECT m.id, m.group_id, m.endpoint_id, e.name AS endpoint_name, e.rest_url, m.role, m.can_talk
     FROM intercom_group_members m
     JOIN intercom_endpoints e ON e.id = m.endpoint_id
     WHERE m.group_id = $1
     ORDER BY e.name`, [groupId]
  );
  return rows;
}

export async function addMember(
  groupId: string, endpointId: string, role: 'member' | 'announcer' = 'member', canTalk = true
): Promise<GroupMember> {
  const m = await queryOne<{ id: string }>(
    `INSERT INTO intercom_group_members (group_id, endpoint_id, role, can_talk)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (group_id, endpoint_id) DO UPDATE SET role = $3, can_talk = $4
     RETURNING id`,
    [groupId, endpointId, role, canTalk]
  );
  const all = await listMembers(groupId);
  return all.find(x => x.id === m!.id) ?? all[0];
}

export async function removeMember(groupId: string, endpointId: string): Promise<void> {
  await query(`DELETE FROM intercom_group_members WHERE group_id = $1 AND endpoint_id = $2`, [groupId, endpointId]);
}
