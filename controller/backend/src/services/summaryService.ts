// src/services/summaryService.ts
// An AI summary of each group's shift (#29), made with the shared Ollama
// (OLLAMA_URL, OLLAMA_MODEL) and kept after the lines are deleted.
//
// Shifts start at fixed local times (Settings: shift_starts, in
// shift_timezone). Once a minute, if a shift has ended, every group that had
// anything said or typed in it gets a summary, unless it already has a final
// one. "Summarise now" summarises the current shift so far (partial); the
// end-of-shift summary replaces it. If that never happens, the label dates
// the partial once its shift is over (#41). Groups set to "don't keep"
// (keep_days 0) are never summarised. Summaries are made one at a time, so a
// burst can't pile requests onto the shared GPU.
import { query, queryOne } from '../db/pool';
import { getSettings } from './settingsService';
import { SummaryLine, buildSummaryRequest, formatSummaryLines } from './summaryPrompt';
import { currentShift, previousShift, shiftLabel, Shift } from './shiftTimes';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.containers.internal:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const TICK_MS = 60_000;
const MAX_LINES = 400;

// ── Summarising ────────────────────────────────────────────────────────────

type Line = SummaryLine;

async function linesIn(groupId: string, from: Date, to: Date): Promise<Line[]> {
  const { rows } = await query<Line>(
    `SELECT * FROM (
       SELECT spoken_at AS at, speaker_name AS name, speaker_extension AS extension, 'said' AS kind, text
         FROM intercom_transcript_lines WHERE group_id = $1 AND spoken_at >= $2 AND spoken_at < $3
       UNION ALL
       SELECT created_at, author_name, author_extension, 'typed', body
         FROM intercom_chat_messages WHERE group_id = $1 AND created_at >= $2 AND created_at < $3
     ) l ORDER BY at DESC LIMIT ${MAX_LINES}`, [groupId, from, to]);
  return rows.reverse();
}

async function askOllama(groupName: string, lines: Line[], tz: string): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify(buildSummaryRequest(groupName, lines, tz, OLLAMA_MODEL)),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = ((await res.json()) as { message?: { content?: string } }).message?.content?.trim();
  if (!text) throw new Error('Ollama gave an empty summary');
  return text;
}

let queue: Promise<unknown> = Promise.resolve();
/** One summary at a time. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function summariseGroup(g: { id: string; name: string }, shift: Shift, partial: boolean, tz: string): Promise<boolean> {
  const lines = await linesIn(g.id, shift.start, shift.end);
  if (!lines.length) return false;
  const summary = await askOllama(g.name, lines, tz);
  await query(
    `INSERT INTO intercom_shift_summaries (group_id, shift_start, shift_end, summary, line_count, model, partial)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (group_id, shift_start) DO UPDATE
       SET shift_end = $3, summary = $4, line_count = $5, model = $6, partial = $7, created_at = now()`,
    [g.id, shift.start, shift.end, summary, lines.length, OLLAMA_MODEL, partial]);
  console.log(`[summaries] ${g.name} ${shiftLabel(shift, tz)}${partial ? ' (so far)' : ''}: ${lines.length} line(s)`);
  return true;
}

async function summarisableGroups(code?: string) {
  const { rows } = await query<{ id: string; name: string; dial_code: string }>(
    `SELECT id, name, dial_code FROM intercom_groups WHERE COALESCE(keep_days, -1) <> 0 ${code ? 'AND dial_code = $1' : ''} ORDER BY name`,
    code ? [code] : []);
  return rows;
}

/** At the end of each shift: a final summary for every group that had lines. */
async function tick() {
  const s = await getSettings();
  if (!s.summaries_enabled) return;
  const prev = previousShift(Date.now(), s.shift_starts, s.shift_timezone);
  for (const g of await summarisableGroups()) {
    const done = await queryOne<{ partial: boolean }>(
      `SELECT partial FROM intercom_shift_summaries WHERE group_id = $1 AND shift_start = $2`, [g.id, prev.start]);
    if (done && !done.partial) continue;
    await serial(() => summariseGroup(g, prev, false, s.shift_timezone))
      .catch((e) => console.error(`[summaries] ${g.name}: ${(e as Error).message}`));
  }
}

let ticking = false;
export function startSummaries(): void {
  setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick().catch((e) => console.error('[summaries]', (e as Error).message)).finally(() => { ticking = false; });
  }, TICK_MS);
}

/** "Summarise now": the current shift so far, for one group or every group
 * with lines in it. Runs in the background; returns how many groups it'll try. */
export async function summariseNow(code?: string): Promise<{ groups: number; shift: string }> {
  const s = await getSettings();
  const cur = currentShift(Date.now(), s.shift_starts, s.shift_timezone);
  const shift = { start: cur.start, end: new Date() };
  const groups = await summarisableGroups(code);
  for (const g of groups) {
    void serial(() => summariseGroup(g, shift, true, s.shift_timezone))
      .catch((e) => console.error(`[summaries] ${g.name}: ${(e as Error).message}`));
  }
  return { groups: groups.length, shift: shiftLabel(cur, s.shift_timezone, s.shift_names) };
}

export interface ShiftSummary {
  id: string; group_id: string; group_name: string; dial_code: string;
  shift_start: string; shift_end: string; summary: string; line_count: number; partial: boolean; created_at: string;
}

const SUMMARY_SELECT = `SELECT s.id::text, s.group_id, g.name AS group_name, g.dial_code, s.shift_start, s.shift_end,
       s.summary, s.line_count, s.partial, s.created_at
  FROM intercom_shift_summaries s JOIN intercom_groups g ON g.id = s.group_id`;

export async function listSummaries(opts: { code?: string; from?: Date; to?: Date; limit?: number }): Promise<ShiftSummary[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.code) { params.push(opts.code); where.push(`g.dial_code = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`s.shift_end > $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`s.shift_start < $${params.length}`); }
  params.push(Math.min(opts.limit ?? 50, 200));
  const { rows } = await query<ShiftSummary>(
    `${SUMMARY_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.shift_start DESC, g.name LIMIT $${params.length}`, params);
  return rows;
}

export async function findSummary(id: string): Promise<ShiftSummary | undefined> {
  const { rows } = await query<ShiftSummary>(`${SUMMARY_SELECT} WHERE s.id::text = $1`, [id]);
  return rows[0];
}

/** The lines a summary was made from (#42), read live from retention and
 * formatted exactly as they were for the model. Once retention has deleted
 * them this is empty; we don't keep a second copy of the text just to show it. */
export async function summarySourceLines(s: Pick<ShiftSummary, 'group_id' | 'shift_start' | 'shift_end'>): Promise<string> {
  const { shift_timezone } = await getSettings();
  const lines = await linesIn(s.group_id, new Date(s.shift_start), new Date(s.shift_end));
  return formatSummaryLines(lines, shift_timezone);
}
