// src/services/chatService.ts -typed group messages (migration 016): read,
// post, and prune to the same retention as transcripts.
import { query, queryOne } from '../db/pool';
import { createError } from '../middleware/errorHandler';

export interface ChatMessage {
  id: string;               // BIGSERIAL, as a string (pg returns int8 as text)
  author_extension: string;
  author_name: string | null;
  body: string;
  created_at: string;
}

export const MAX_CHAT_LENGTH = 1000;

/** Messages for one group, oldest first. With `afterId`, only newer ones
 * (the client polls this way); without it, the most recent `limit`. */
export async function listMessages(groupId: string, afterId?: string, limit = 100): Promise<ChatMessage[]> {
  if (afterId) {
    const { rows } = await query<ChatMessage>(
      `SELECT id, author_extension, author_name, body, created_at FROM intercom_chat_messages
        WHERE group_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [groupId, afterId, limit]);
    return rows;
  }
  const { rows } = await query<ChatMessage>(
    `SELECT * FROM (
       SELECT id, author_extension, author_name, body, created_at FROM intercom_chat_messages
        WHERE group_id = $1 ORDER BY id DESC LIMIT $2
     ) recent ORDER BY id`,
    [groupId, limit]);
  return rows;
}

export async function postMessage(groupId: string, author: { extension: string; name: string }, body: string): Promise<ChatMessage> {
  const text = body.trim();
  if (!text) throw createError('Message is empty', 400);
  if (text.length > MAX_CHAT_LENGTH) throw createError(`Message is longer than ${MAX_CHAT_LENGTH} characters`, 400);
  const m = await queryOne<ChatMessage>(
    `INSERT INTO intercom_chat_messages (group_id, author_extension, author_name, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, author_extension, author_name, body, created_at`,
    [groupId, author.extension, author.name, text]);
  if (!m) throw createError('Failed to save message', 500);
  return m;
}

/** group id -> newest chat message id and newest transcript line id, for
 * the client's "new" markers. One query per table, both on indexes. */
export async function latestIds(groupIds: string[]): Promise<Record<string, { chat: string | null; transcript: string | null }>> {
  const out: Record<string, { chat: string | null; transcript: string | null }> = {};
  if (!groupIds.length) return out;
  for (const id of groupIds) out[id] = { chat: null, transcript: null };
  const [chat, lines] = await Promise.all([
    query<{ group_id: string; id: string }>(
      `SELECT group_id, MAX(id)::text AS id FROM intercom_chat_messages WHERE group_id = ANY($1::uuid[]) GROUP BY group_id`, [groupIds]),
    query<{ group_id: string; id: string }>(
      `SELECT group_id, MAX(id)::text AS id FROM intercom_transcript_lines WHERE group_id = ANY($1::uuid[]) GROUP BY group_id`, [groupIds]),
  ]);
  for (const r of chat.rows) out[r.group_id].chat = r.id;
  for (const r of lines.rows) out[r.group_id].transcript = r.id;
  return out;
}

