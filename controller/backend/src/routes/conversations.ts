// src/routes/conversations.ts
// Console › Conversations (#27, #29): search what's still kept of groups'
// transcripts and chat, export a range as text or CSV (audited), and the
// shift summaries, with "Summarise now". Editors and admins.
import { Router, Request } from 'express';
import { requireAuth, requireRole } from '../middleware/session';
import { query } from '../db/pool';
import { audit } from '../services/auditService';
import { getSettings } from '../services/settingsService';
import { listSummaries, summariseNow } from '../services/summaryService';
import { summaryIsCurrent, summaryLabel } from '../services/shiftTimes';

const router = Router();
router.use(requireAuth, requireRole('admin', 'editor'));

export interface ConversationLine {
  kind: 'said' | 'typed'; id: string; at: string; group: string; group_name: string;
  extension: string; name: string | null; text: string;
}

function filters(req: Request) {
  const q = req.query as Record<string, string | undefined>;
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (q.group) add('g.dial_code = ?', q.group);
  if (q.person) add('l.extension = ?', q.person);
  const from = q.from ? new Date(q.from) : null;
  const to = q.to ? new Date(q.to) : null;
  if (from && !isNaN(+from)) add('l.at >= ?', from);
  if (to && !isNaN(+to)) add('l.at < ?', to);
  if (q.q?.trim()) add('l.text ILIKE ?', `%${q.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (q.kind === 'said' || q.kind === 'typed') add('l.kind = ?', q.kind);
  return { params, where: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

const LINES = `
  SELECT l.kind, l.id, l.at, g.dial_code AS "group", g.name AS group_name, l.extension, l.name, l.text FROM (
    SELECT 'said' AS kind, id::text, spoken_at AS at, group_id, speaker_extension AS extension, speaker_name AS name, text FROM intercom_transcript_lines
    UNION ALL
    SELECT 'typed', id::text, created_at, group_id, author_extension, author_name, body FROM intercom_chat_messages
  ) l JOIN intercom_groups g ON g.id = l.group_id`;

router.get('/', async (req, res, next) => {
  try {
    const { params, where } = filters(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const total = await query<{ n: string }>(`SELECT count(*)::text AS n FROM (${LINES} ${where}) x`, params);
    const { rows } = await query<ConversationLine>(`${LINES} ${where} ORDER BY l.at DESC LIMIT ${limit} OFFSET ${offset}`, params);
    res.json({ total: Number(total.rows[0].n), lines: rows });
  } catch (err) { next(err); }
});

const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

router.get('/export', async (req, res, next) => {
  try {
    const { params, where } = filters(req);
    const { rows } = await query<ConversationLine>(`${LINES} ${where} ORDER BY l.at LIMIT 50000`, params);
    const csv = req.query.format === 'csv';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const body = csv
      ? ['time,group,extension,name,kind,text', ...rows.map((r) =>
          [new Date(r.at).toISOString(), r.group_name, r.extension, r.name, r.kind, r.text].map(csvCell).join(','))].join('\r\n')
      : rows.map((r) => `[${new Date(r.at).toISOString().replace('T', ' ').slice(0, 19)}] ${r.group_name} · ${r.name ?? r.extension} (${r.kind}): ${r.text}`).join('\n');
    await audit(req.user!.email, 'conversations', '00000000-0000-0000-0000-000000000000', 'export',
      { format: csv ? 'csv' : 'text', rows: rows.length, filters: req.query });
    res.setHeader('Content-Type', csv ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="parley-conversations-${stamp}.${csv ? 'csv' : 'txt'}"`);
    res.send(body + '\n');
  } catch (err) { next(err); }
});

router.get('/summaries', async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const s = await getSettings();
    const list = await listSummaries({
      code: q.group || undefined,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: Number(q.limit) || 50,
    });
    const now = Date.now();
    res.json({
      enabled: s.summaries_enabled,
      summaries: list.map((x) => ({ ...x, label: summaryLabel(x, s, now), current: summaryIsCurrent(x, s, now) })),
    });
  } catch (err) { next(err); }
});

router.post('/summarise', async (req, res, next) => {
  try {
    const group = typeof req.body?.group === 'string' && req.body.group ? req.body.group : undefined;
    const r = await summariseNow(group);
    await audit(req.user!.email, 'conversations', '00000000-0000-0000-0000-000000000000', 'update', { action: 'summarise', group: group ?? 'all' });
    res.status(202).json(r);
  } catch (err) { next(err); }
});

export default router;
