// src/services/retentionService.ts
// Deletes transcript lines and chat once they're past their group's keep
// time (#26), archiving them first when that's switched on (#28), and
// prunes old shift summaries. Replaces the separate hourly prunes in
// transcriptService and chatService. Runs every 5 minutes, so "don't keep"
// (keep_days 0: kept 15 minutes, long enough to be seen live) works.
//
// Archive: one JSONL file per group per day (UTC) per run, each line
// {kind: said|typed, id, at, extension, name, text}, sent like the Backups
// archive (a folder on the archive volume, or SCP). A group whose files
// can't all be written keeps its lines until the next run: nothing is
// deleted unarchived. "Don't keep" groups are never archived.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { query } from '../db/pool';
import { getSettings } from './settingsService';
import { sendArchive } from './archiveTransfer';

const TICK_MS = 5 * 60 * 1000;
const DONT_KEEP_INTERVAL = '15 minutes';
const SUMMARY_KEEP_DAYS = 365;

interface ArchiveRow { kind: 'said' | 'typed'; id: string; at: Date; extension: string; name: string | null; text: string }

async function archiveAndDelete(group: { id: string; dial_code: string }, interval: string,
  transfer: Parameters<typeof sendArchive>[2]): Promise<number> {
  const { rows } = await query<ArchiveRow>(
    `SELECT 'said' AS kind, id::text, spoken_at AS at, speaker_extension AS extension, speaker_name AS name, text
       FROM intercom_transcript_lines WHERE group_id = $1 AND created_at < now() - $2::interval
     UNION ALL
     SELECT 'typed', id::text, created_at, author_extension, author_name, body
       FROM intercom_chat_messages WHERE group_id = $1 AND created_at < now() - $2::interval
     ORDER BY at`, [group.id, interval]);
  if (!rows.length) return 0;
  const byDay = new Map<string, ArchiveRow[]>();
  for (const r of rows) {
    const day = r.at.toISOString().slice(0, 10);
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(r);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  for (const [day, list] of byDay) {
    const name = `parley-${group.dial_code}-${day}-${stamp}.jsonl`;
    const tmp = path.join(os.tmpdir(), name);
    fs.writeFileSync(tmp, list.map((r) => JSON.stringify({ kind: r.kind, id: r.id, at: r.at.toISOString(), extension: r.extension, name: r.name, text: r.text })).join('\n') + '\n');
    try { await sendArchive(tmp, name, transfer, true); }
    finally { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
  }
  const said = rows.filter((r) => r.kind === 'said').map((r) => r.id);
  const typed = rows.filter((r) => r.kind === 'typed').map((r) => r.id);
  if (said.length) await query(`DELETE FROM intercom_transcript_lines WHERE id = ANY($1::bigint[])`, [said]);
  if (typed.length) await query(`DELETE FROM intercom_chat_messages WHERE id = ANY($1::bigint[])`, [typed]);
  return rows.length;
}

export async function runRetention(): Promise<void> {
  try {
    const s = await getSettings();
    const { rows: groups } = await query<{ id: string; dial_code: string; keep_days: number | null }>(
      `SELECT id, dial_code, keep_days FROM intercom_groups`);
    for (const g of groups) {
      const keep = g.keep_days ?? s.transcript_retention_days;
      const interval = keep === 0 ? DONT_KEEP_INTERVAL : `${keep} days`;
      try {
        if (s.archive_enabled && keep > 0) {
          const n = await archiveAndDelete(g, interval, s.archive_transfer);
          if (n) console.log(`[retention] ${g.dial_code}: archived and deleted ${n} line(s) > ${interval}`);
        } else {
          const t = await query(`DELETE FROM intercom_transcript_lines WHERE group_id = $1 AND created_at < now() - $2::interval`, [g.id, interval]);
          const c = await query(`DELETE FROM intercom_chat_messages WHERE group_id = $1 AND created_at < now() - $2::interval`, [g.id, interval]);
          const n = (t.rowCount ?? 0) + (c.rowCount ?? 0);
          if (n) console.log(`[retention] ${g.dial_code}: deleted ${n} line(s) > ${interval}`);
        }
      } catch (err) {
        // Archive failed: keep this group's lines for the next run.
        console.error(`[retention] ${g.dial_code}: not deleted this time: ${(err as Error).message}`);
      }
    }
    const old = await query(`DELETE FROM intercom_shift_summaries WHERE shift_end < now() - ($1 || ' days')::interval`, [SUMMARY_KEEP_DAYS]);
    if (old.rowCount) console.log(`[retention] deleted ${old.rowCount} shift summar(ies) > ${SUMMARY_KEEP_DAYS}d`);
  } catch (err) {
    console.error('[retention] failed:', (err as Error).message);
  }
}

export function startRetention(): void {
  void runRetention();
  setInterval(() => void runRetention(), TICK_MS);
}
