// Keyboard shortcuts (issue #6, option H1 + H3 from the "Open Intercom client
// styles" canvas). Each group gets a key: hold it to talk in a joined group,
// tap it to join; Shift+key leaves. Intercom keys get F1-F12 (press to call or
// hang up), plus answer/hang up, hold, talk to all joined groups, and mute
// everywhere. Defaults follow the order of the user's buttons (not the order
// cards are shown in, which changes as groups are joined), and can be changed
// in the profile menu's Keyboard section, saved per device.
//
// Keys are stored as KeyboardEvent.code ("Digit1", "KeyH", "F1"): the
// physical key, so Shift+1 and other keyboard layouts don't change what a
// binding means.
import { useEffect, useState } from 'react';

export type HotkeyAction =
  | { kind: 'group'; code: string; name: string }
  | { kind: 'icm'; ext: string; name: string }
  | { kind: 'answer' } | { kind: 'hold' } | { kind: 'talkAll' } | { kind: 'muteAll' };

export interface HotkeyRow { id: string; label: string; action: HotkeyAction; key: string | null }

/** Per-device changes from the defaults: action id -> key code (null = none). */
export type HotkeyOverrides = Record<string, string | null>;

const STORE = 'parley-hotkeys';
const GROUP_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
const ICM_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);

export function loadHotkeys(): HotkeyOverrides {
  try { return JSON.parse(localStorage.getItem(STORE) ?? '{}') as HotkeyOverrides; } catch { return {}; }
}
export function saveHotkeys(o: HotkeyOverrides) {
  try { localStorage.setItem(STORE, JSON.stringify(o)); } catch { /* this session only */ }
}

/** Every shortcut with its current key, defaults then this device's changes. */
export function hotkeyRows(groups: { code: string; name: string }[], icm: { ext: string; name: string }[], overrides: HotkeyOverrides): HotkeyRow[] {
  const rows: HotkeyRow[] = [
    { id: 'answer', label: 'Intercom: answer / hang up', action: { kind: 'answer' }, key: 'Enter' },
    { id: 'hold', label: 'Intercom: hold / resume', action: { kind: 'hold' }, key: 'KeyH' },
    { id: 'talkAll', label: 'Talk to all joined groups (hold)', action: { kind: 'talkAll' }, key: 'Space' },
    { id: 'muteAll', label: 'Mute my mic everywhere', action: { kind: 'muteAll' }, key: 'KeyM' },
    ...groups.map((g, i) => ({ id: `g:${g.code}`, label: `${g.name}: talk (hold) or join · Shift leaves`, action: { kind: 'group' as const, ...g }, key: GROUP_KEYS[i] ?? null })),
    ...icm.map((p, i) => ({ id: `i:${p.ext}`, label: `Call ${p.name}`, action: { kind: 'icm' as const, ...p }, key: ICM_KEYS[i] ?? null })),
  ];
  for (const r of rows) if (r.id in overrides) r.key = overrides[r.id];
  // A key moved to another action leaves the default it took over.
  const taken = new Map<string, string>();
  for (const r of rows) if (r.id in overrides && r.key) taken.set(r.key, r.id);
  for (const r of rows) if (r.key && taken.has(r.key) && taken.get(r.key) !== r.id) r.key = null;
  return rows;
}

export function keyLabel(code: string): string {
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  const names: Record<string, string> = { Space: 'Space', Enter: 'Enter', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  return names[code] ?? code;
}

/** Keys only act outside text fields and without Ctrl/Alt/Cmd, so typing
 * and the browser's own shortcuts are never taken over. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function Keycap({ code, shift = false }: { code: string | null | undefined; shift?: boolean }) {
  if (!code) return null;
  return <kbd className="keycap" title={`Keyboard: ${shift ? 'Shift+' : ''}${keyLabel(code)}`}>{shift ? '⇧' : ''}{keyLabel(code)}</kbd>;
}

// While the Keyboard section is waiting for a key, the shortcuts themselves
// must not fire.
let capturing = false;
export const isCapturing = () => capturing;

export function KeyboardSettings({ rows, overrides, onChange }: {
  rows: HotkeyRow[]; overrides: HotkeyOverrides; onChange: (o: HotkeyOverrides) => void;
}) {
  const [waiting, setWaiting] = useState<string | null>(null);
  useEffect(() => {
    capturing = waiting !== null;
    if (!waiting) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape') { setWaiting(null); return; }
      const next = { ...overrides };
      if (e.code === 'Backspace' || e.code === 'Delete') next[waiting] = null;
      else {
        // The key leaves whatever had it before.
        for (const r of rows) if (r.key === e.code && r.id !== waiting) next[r.id] = null;
        next[waiting] = e.code;
      }
      onChange(next);
      setWaiting(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); capturing = false; };
  }, [waiting, rows, overrides, onChange]);
  return (
    <div className="ra-settings kb-settings">
      <div className="ra-settings-head">Keyboard</div>
      <div className="dim ra-help">Saved on this device. Click a key to change it: press the new key, Backspace for none, Esc to cancel. Keys never act while you're typing.</div>
      {rows.map((r) => (
        <div key={r.id} className="kb-row">
          <span className="kb-what">{r.label}</span>
          <button className={`kb-key${waiting === r.id ? ' waiting' : ''}`} onClick={() => setWaiting(waiting === r.id ? null : r.id)}
            aria-label={`${r.label}: ${r.key ? keyLabel(r.key) : 'no key'}. Change`}>
            {waiting === r.id ? 'press a key…' : r.key ? keyLabel(r.key) : 'none'}
          </button>
        </div>
      ))}
      <button className="link-btn" onClick={() => onChange({})}>Reset to defaults</button>
    </div>
  );
}
