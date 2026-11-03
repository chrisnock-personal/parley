// ui.tsx -small shared pieces for the console pages: avatars, switches,
// icons, call durations. Same look as the intercom client's Panel theme.

const AVATAR_COLOURS: [string, string][] = [
  ['#4cc38a', '#10241a'], ['#5bc0eb', '#0b2330'], ['#f2b04c', '#1a1408'],
  ['#b48ef0', '#1f1430'], ['#ef8a7b', '#2c0f0b'], ['#7fb0e8', '#0e1f31'],
];

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  // "Camera 1" -> "C1", "Floor Manager" -> "FM"
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function colourFor(id: string): [string, string] {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLOURS[h % AVATAR_COLOURS.length];
}

export function Avatar({ name, id, size = 28, talking = false }: { name: string; id: string; size?: number; talking?: boolean }) {
  const [bg, fg] = colourFor(id);
  return (
    <span className={`c-avatar${talking ? ' talking' : ''}`} aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36), background: bg, color: fg }}>
      {initials(name)}
    </span>
  );
}

export function Switch({ checked, onChange, label, help, disabled, disabledReason }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; help?: string; disabled?: boolean; disabledReason?: string;
}) {
  return (
    <button type="button" className="c-switch" role="switch" aria-checked={checked} disabled={disabled}
      title={disabled ? disabledReason : undefined} onClick={() => onChange(!checked)}>
      <span className="c-switch-text">{label}{help && <span className="c-switch-help">{help}</span>}</span>
      <span className={`c-track${checked ? ' on' : ''}`}><span className="c-knob" /></span>
    </button>
  );
}

const PATHS: Record<string, string> = {
  live: 'M3 12h4l3-8 4 16 3-8h4',
  people: 'M9 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7 M2.5 20a6.5 6.5 0 0 1 13 0 M16 4.5a3.5 3.5 0 0 1 0 7 M18 14a6 6 0 0 1 3.5 6',
  groups: 'M4 6h16 M4 12h16 M4 18h10',
  settings: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1',
  health: 'M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10z',
  audit: 'M6 3h9l4 4v14H6z M9 11h7 M9 15h7',
  backups: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3s-3.1 3-7 3s-7-1.3-7-3z M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6 M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
  plus: 'M12 5v14 M5 12h14',
  x: 'M6 6l12 12 M18 6L6 18',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14 M21 21l-4.3-4.3',
};
export function Icon({ name, size = 16 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name].split(' M').map((d, i) => <path key={i} d={i ? `M${d}` : d} />)}
    </svg>
  );
}

/** "2:14", "1:02:09" since an ISO time. */
export function since(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** How a group's members talk, from its mode and PTT default. */
export type TalkMode = 'open' | 'ptt' | 'listen';
export function talkModeOf(g: { mode: 'talkback' | 'announce'; ptt_default: boolean }): TalkMode {
  return g.mode === 'announce' ? 'listen' : g.ptt_default ? 'ptt' : 'open';
}
export const TALK_LABEL: Record<TalkMode, string> = { open: 'Open mic', ptt: 'Push to talk', listen: 'Listen only' };
export function talkModeFields(t: TalkMode): { mode: 'talkback' | 'announce'; ptt_default: boolean } {
  return t === 'listen' ? { mode: 'announce', ptt_default: false } : { mode: 'talkback', ptt_default: t === 'ptt' };
}
