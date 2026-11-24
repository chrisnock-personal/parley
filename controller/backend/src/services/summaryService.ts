// src/services/summaryService.ts
// An AI summary of each group's shift (#29), made with the shared Ollama
// (OLLAMA_URL, OLLAMA_MODEL) and kept after the lines are deleted.
//
// Shifts start at fixed local times (Settings: shift_starts, in
// shift_timezone). Once a minute, if a shift has ended, every group that had
// anything said or typed in it gets a summary, unless it already has a final
// one. "Summarise now" summarises the current shift so far (partial); the
// end-of-shift summary replaces it. Groups set to "don't keep" (keep_days 0)
// are never summarised. Summaries are made one at a time, so a burst can't
// pile requests onto the shared GPU.
import { query, queryOne } from '../db/pool';
import { getSettings } from './settingsService';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.containers.internal:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const TICK_MS = 60_000;
const MAX_LINES = 400;

// ── Shift times ────────────────────────────────────────────────────────────

/** How far `tz` is ahead of UTC at instant `t`, in ms. */
function tzOffsetMs(t: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}

/** The UTC instant of local time y-m-d hh:mm in `tz`. */
function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const naive = Date.UTC(y, m, d, hh, mm);
  const first = naive - tzOffsetMs(naive, tz);
  return naive - tzOffsetMs(first, tz); // second pass: right across a daylight-saving change
}

/** Every shift start from two days before `now` to two days after, as UTC ms, sorted. */
function boundaries(now: number, starts: string[], tz: string): number[] {
  const out: number[] = [];
  for (let dayShift = -2; dayShift <= 2; dayShift++) {
    const local = new Date(now + tzOffsetMs(now, tz) + dayShift * 86_400_000);
    for (const s of starts) {
      const [hh, mm] = s.split(':').map(Number);
      out.push(zonedToUtc(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hh, mm, tz));
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export interface Shift { start: Date; end: Date }

export function currentShift(now: number, starts: string[], tz: string): Shift {
  const b = boundaries(now, starts, tz);
  const i = b.findIndex((x) => x > now);
  return { start: new Date(b[i - 1]), end: new Date(b[i]) };
}
export function previousShift(now: number, starts: string[], tz: string): Shift {
  const b = boundaries(now, starts, tz);
  const i = b.findIndex((x) => x > now);
  return { start: new Date(b[i - 2]), end: new Date(b[i - 1]) };
}

/** "06:00–14:00", in the shift time zone. */
export function shiftLabel(shift: Shift, tz: string): string {
  const f = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${f(shift.start)}–${f(shift.end)}`;
}

// ── Summarising ────────────────────────────────────────────────────────────

interface Line { at: Date; name: string | null; extension: string; kind: 'said' | 'typed'; text: string }

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

const SYSTEM_PROMPT = `You summarise a broadcast crew's intercom group for the people coming on next.
You get the group's lines in time order: what people said (transcribed speech, which can contain recognition errors) and what they typed.
Write 2 to 4 plain sentences of facts: decisions, changes to plans, problems and whether they were solved, and who is doing what.
Use only what is in the lines. Don't invent names, times or events, don't add advice, and don't start with a preamble like "Here is a summary".`;

async function askOllama(groupName: string, lines: Line[], tz: string): Promise<string> {
  const time = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const body = lines.map((l) => `[${time(l.at)}] ${l.name ?? l.extension} (${l.kind}): ${l.text}`).join('\n');
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: OLLAMA_MODEL, stream: false, options: { temperature: 0.2 },
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: `Group: ${groupName}\n\n${body}` }],
    }),
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
  return { groups: groups.length, shift: shiftLabel(cur, s.shift_timezone) };
}

export interface ShiftSummary {
  id: string; group_id: string; group_name: string; dial_code: string;
  shift_start: string; shift_end: string; summary: string; line_count: number; partial: boolean; created_at: string;
}

export async function listSummaries(opts: { code?: string; from?: Date; to?: Date; limit?: number }): Promise<ShiftSummary[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.code) { params.push(opts.code); where.push(`g.dial_code = $${params.length}`); }
  if (opts.from) { params.push(opts.from); where.push(`s.shift_end > $${params.length}`); }
  if (opts.to) { params.push(opts.to); where.push(`s.shift_start < $${params.length}`); }
  params.push(Math.min(opts.limit ?? 50, 200));
  const { rows } = await query<ShiftSummary>(
    `SELECT s.id::text, s.group_id, g.name AS group_name, g.dial_code, s.shift_start, s.shift_end, s.summary,
            s.line_count, s.partial, s.created_at
       FROM intercom_shift_summaries s JOIN intercom_groups g ON g.id = s.group_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.shift_start DESC, g.name LIMIT $${params.length}`, params);
  return rows;
}
