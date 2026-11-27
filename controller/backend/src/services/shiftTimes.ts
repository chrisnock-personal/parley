// Shift boundaries and summary labels (#41). Kept free of config/DB imports
// so the label logic can be checked with node:test on its own.
export interface Shift { start: Date; end: Date }
export interface ShiftSettings {
  shift_starts: string[];
  shift_timezone: string;
  shift_names: Record<string, string>;
}
export interface SummarisedShift {
  shift_start: string | Date;
  shift_end: string | Date;
  partial: boolean;
}

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

function timeIn(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/** "Day (06:00–14:00)", or "06:00–14:00" for a shift without a name, in
 * the shift time zone. */
export function shiftLabel(shift: Shift, tz: string, names: Record<string, string> = {}): string {
  const times = `${timeIn(shift.start, tz)}–${timeIn(shift.end, tz)}`;
  const name = names[timeIn(shift.start, tz)];
  return name ? `${name} (${times})` : times;
}

/** Whether a partial summary still belongs to the shift happening now.
 * Final summaries are always for a past shift. */
export function summaryIsCurrent(x: SummarisedShift, s: ShiftSettings, now = Date.now()): boolean {
  if (!x.partial) return false;
  const cur = currentShift(now, s.shift_starts, s.shift_timezone);
  const start = new Date(x.shift_start).getTime();
  return start >= cur.start.getTime() && start < cur.end.getTime();
}

/** The label for a stored summary: a partial one is stored ending when it was
 * made, but is labelled with its shift's real end. Once that shift is over it
 * also carries the time it was made, so an un-finalised partial no longer
 * reads as "THIS SHIFT" on a later day (the date itself is the client's
 * earlier-shift prefix). */
export function summaryLabel(x: SummarisedShift, s: ShiftSettings, now = Date.now()): string {
  const start = new Date(x.shift_start);
  const shift = x.partial
    ? { start, end: currentShift(start.getTime(), s.shift_starts, s.shift_timezone).end }
    : { start, end: new Date(x.shift_end) };
  const label = shiftLabel(shift, s.shift_timezone, s.shift_names);
  if (!x.partial || summaryIsCurrent(x, s, now)) return label;
  return `${label} · so far at ${timeIn(new Date(x.shift_end), s.shift_timezone)}`;
}
