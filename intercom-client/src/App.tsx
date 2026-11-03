import { useState, useEffect, useCallback, useRef, useLayoutEffect, createContext, useContext } from 'react';
import { api, Button, ChatMessage, DirectoryEntry, GroupParticipant, IntercomClientSession, LatestIds, LiveState, TranscriptLine } from './api';
import { createIntercomClientUa, targetUri } from './sipUa';
import { markSvg, PRODUCT_NAME } from '../../brand/mark';
import { TTS_AVAILABLE, ReadAloudPrefs, loadPrefs, savePrefs, primeSpeech, speakNow, useReadAloud, useVoices } from './readAloud';
import { CallManager, SlotId, SlotState, SlotStates, ICM_SLOT, lineSlot, idleSlot, CallEventPayload } from './calls';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Matches pbx-core's config.groupPrefix (GROUP_PREFIX env) -separate
// deployables, no shared code between them. If you change one, change both
// (same convention already used in controller-backend's pbxService.ts).
const GROUP_PREFIX = '*8';

// Extracts just the extension from a SIP URI like "sip:1002@host" -> "1002"
// -same shape as pbx-core's own registrar.ts extOf() helper, duplicated
// here since the intercom client and pbx-core are separate deployables.
// Browsers only expose getUserMedia in a secure context (HTTPS, or plain
// HTTP on localhost). Without it every call fails the instant it asks for
// the mic, so say so up front. nginx already redirects non-localhost HTTP
// visits to HTTPS (see nginx.conf); this is the backstop.
const MIC_AVAILABLE = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

function extOf(uri: string): string {
  const m = uri.match(/sips?:([^@;>]+)@/i);
  return m ? m[1] : uri;
}

function LoginScreen({ onLogin, onSubmitGesture }: {
  onLogin: (s: IntercomClientSession, password: string) => void; onSubmitGesture: () => void;
}) {
  const [extension, setExtension] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Must run BEFORE the `await` below -anything after that is no longer
    // considered part of this click/submit's user gesture by the browser's
    // autoplay policy, and the audio-unlock trick needs a real gesture.
    onSubmitGesture();
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(extension, password);
      // Passed up rather than kept here: sipUa.ts needs the plaintext to
      // authenticate the SIP UA (see its header comment) -App.tsx keeps it
      // in a ref, never sessionStorage, alongside the token api.ts does
      // persist there.
      onLogin(session, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form onSubmit={submit} className="login-form">
        <h1 className="login-brand"><Mark size={32} /> {PRODUCT_NAME}</h1>
        <label>
          Extension
          <input value={extension} onChange={(e) => setExtension(e.target.value)} autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
      </form>
    </div>
  );
}

// Shown when a session was restored from the stored JWT (a same-tab reload
// -see App's api.me() effect) but the plaintext SIP password isn't in
// memory, since it's deliberately never persisted (see sipUa.ts). The
// console-login/button-list session itself is still fully intact -only the
// SIP line needs re-authenticating, so this asks for just the password, not
// a full re-login.
function ReconnectScreen({ name, extension, error, busy, onReconnect, onSubmitGesture, onLogout }: {
  name: string; extension: string; error: string | null; busy: boolean;
  onReconnect: (password: string) => void; onSubmitGesture: () => void; onLogout: () => void;
}) {
  const [password, setPassword] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Same autoplay-policy reasoning as LoginScreen's submit -a fresh page
    // load (this screen only ever shows after one) means audio needs
    // re-priming under a real user gesture again too.
    onSubmitGesture();
    onReconnect(password);
  };
  return (
    <div className="login-screen">
      <form onSubmit={submit} className="login-form">
        <h1>Reconnect your line</h1>
        <p>
          {name} (ext {extension}) -still logged in, but this tab needs your
          password again to reconnect the SIP line.
        </p>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={busy || !password}>{busy ? 'Connecting…' : 'Reconnect'}</button>
        <button type="button" onClick={onLogout}>Log out instead</button>
      </form>
    </div>
  );
}

function ActivityLight({ state }: { state: SlotState }) {
  const on = state.status === 'connected' && state.active;
  return <span className={`activity${on ? ' activity-on' : ''}`} title={on ? 'Audio on this line' : 'Quiet'} />;
}

// How long the call on a slot has been connected, as a chip: m:ss, then
// h:mm:ss after an hour. Ticks once a second while shown.
function CallTimer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const text = h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  return <span className="call-timer" title="Time on this call">{text}</span>;
}

type SlotActions = {
  setMuted: (slot: SlotId, muted: boolean) => void;
  setListenMuted: (slot: SlotId, v: boolean) => void;
  setVolume: (slot: SlotId, v: number) => void;
};

function buttonLabel(b: Button): string {
  return b.label || (b.button_type === 'direct' ? (b.target_name || b.target_extension!) : b.target_group_name!);
}

// Small inline icons (Lucide-style strokes) -no icon library dependency.
const ICON_PATHS: Record<string, string> = {
  chevron: 'M6 9l6 6l6-6',
  volume: 'M11 5L6 9H2v6h4l5 4V5z M15.54 8.46a5 5 0 0 1 0 7.07 M19.07 4.93a10 10 0 0 1 0 14.14',
  volumeOff: 'M11 5L6 9H2v6h4l5 4V5z M22 9l-6 6 M16 9l6 6',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3',
  micOff: 'M2 2l20 20 M18.89 13.23A7 7 0 0 0 19 12v-2 M5 10v2a7 7 0 0 0 12 5 M15 9.34V5a3 3 0 0 0-5.68-1.33 M9 9v3a3 3 0 0 0 5.12 2.12 M12 19v3',
  headset: 'M3 14v-3a9 9 0 0 1 18 0v3 M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z M3 15a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14 M21 21l-4.3-4.3',
  keyboard: 'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z M7 10h.01 M11 10h.01 M15 10h.01 M8 14h8',
};
function Icon({ name, size = 16 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name].split(' M').map((d, i) => <path key={i} d={i ? `M${d}` : d} />)}
    </svg>
  );
}

// BIGSERIAL ids arrive as digit strings; compare without Number overflow.
function idGt(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  return a.length !== b.length ? a.length > b.length : a > b;
}

// The newest chat/transcript id per group this user has had on screen,
// kept in this browser (a convenience: losing it only resets "new"). A
// group seen for the first time starts at its current newest, so history
// from before you ever looked isn't all flagged as new.
type Seen = Record<string, Partial<LatestIds>>;
function useSeen(ext: string | undefined, latest: Record<string, LatestIds>):
  [Seen, (code: string, kind: keyof LatestIds, id: string) => void] {
  const key = ext ? `parley-seen-${ext}` : null;
  const [seen, setSeen] = useState<Seen>({});
  useEffect(() => {
    if (!key) return;
    try { setSeen(JSON.parse(localStorage.getItem(key) || '{}')); } catch { setSeen({}); }
  }, [key]);
  const save = useCallback((next: Seen) => {
    if (key) try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  }, [key]);
  useEffect(() => {
    const fresh = Object.keys(latest).filter((code) => !seen[code]);
    if (!key || !fresh.length) return;
    setSeen((prev) => {
      const next = { ...prev };
      for (const code of fresh) if (!next[code]) next[code] = { chat: latest[code].chat ?? undefined, transcript: latest[code].transcript ?? undefined };
      return save(next);
    });
  }, [latest, seen, key, save]);
  const markSeen = useCallback((code: string, kind: keyof LatestIds, id: string) => {
    setSeen((prev) => {
      if (!idGt(id, prev[code]?.[kind])) return prev;
      return save({ ...prev, [code]: { ...prev[code], [kind]: id } });
    });
  }, [save]);
  return [seen, markSeen];
}

// The favourite toggle on a group's card and tile. Filled in the accent
// colour when on (amber already means talking).
function StarButton({ name, on, onToggle }: { name: string; on: boolean; onToggle: () => void }) {
  return (
    <button className={`star-btn${on ? ' on' : ''}`} onClick={onToggle} aria-pressed={on}
      aria-label={on ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
      title={on ? 'Favourite: always shown in full' : 'Favourite: keep this group shown in full'}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor"
        strokeWidth={1.8} strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3.2l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17.1 6.6 20l1-6.1-4.4-4.3 6.1-.9z" />
      </svg>
    </button>
  );
}

// The product logo, from the shared brand/mark.ts (colours: --mark-a/-b).
function Mark({ size }: { size: number }) {
  return <span className="mark" dangerouslySetInnerHTML={{ __html: markSvg(size) }} />;
}

// People are drawn as initials avatars. Each person keeps one colour (picked
// from the theme's avatar palette by a hash of their extension), so the same
// person looks the same in every card.
function initials(name: string): string {
  const trimmed = name.trim();
  // A trailing number tells people apart ("TestUser1"/"TestUser2" -> T1/T2,
  // "Camera 2" -> C2): plain first letters made them identical.
  const num = trimmed.match(/(\d+)$/);
  if (num && trimmed.length > num[1].length) return (trimmed[0] + num[1]).slice(0, 3).toUpperCase();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
function avatarTone(key: string): number {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 6;
}
// Clicking an openable avatar shows that person's card (PersonCard, below).
// A context, so any avatar can open it without threading a callback through
// every component.
type OpenPerson = (person: { extension: string; name: string }, anchor: HTMLElement) => void;
const PersonCardContext = createContext<OpenPerson>(() => { /* no card host */ });
// extension -> photo version, for people who've set a profile picture.
const AvatarPhotosContext = createContext<Record<string, number>>({});

function Avatar({ name, id, size = 28, talking = false, openable = false }: {
  name: string; id: string; size?: number; talking?: boolean; openable?: boolean;
}) {
  const open = useContext(PersonCardContext);
  const photoVersion = useContext(AvatarPhotosContext)[id];
  const cls = `avatar tone-${avatarTone(id)}${talking ? ' talking' : ''}${photoVersion ? ' has-photo' : ''}`;
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) };
  const face = photoVersion
    ? <img src={api.avatarUrl(id, photoVersion)} alt="" draggable={false} />
    : initials(name);
  if (!openable) return <span className={cls} style={style} aria-hidden="true">{face}</span>;
  return (
    <button type="button" className={`${cls} avatar-btn`} style={style} aria-label={`About ${name}`}
      onClick={(e) => { e.stopPropagation(); open({ extension: id, name }, e.currentTarget); }}>
      {face}
    </button>
  );
}

// Small status tags on cards and in the top bar.
function RecTag({ title }: { title: string }) {
  return <span className="rec-tag" title={title}><span className="rec-dot" aria-hidden="true" />REC</span>;
}

// A person's card, opened from an avatar: who they are, whether they're
// online and talking, which of your groups they're in, and a Call / Hang up
// button when you have an intercom key for them. Escape or a click outside
// closes it.
function PersonCard({ person, anchor, online, talking, groups, keyButton, callable, onCallWith, onCall, onHangup, onClose }: {
  person: { extension: string; name: string }; anchor: DOMRect;
  online: boolean; talking: boolean; groups: string[]; keyButton: Button | undefined; callable: boolean; onCallWith: boolean;
  onCall: () => void; onHangup: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.left, top: anchor.bottom + 8 });
  useLayoutEffect(() => {
    // Below the avatar if it fits, else above; kept inside the viewport.
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, m = 8;
    const left = Math.min(Math.max(m, anchor.left + anchor.width / 2 - w / 2), window.innerWidth - w - m);
    const below = anchor.bottom + m;
    const top = below + h <= window.innerHeight - m ? below : Math.max(m, anchor.top - h - m);
    setPos({ left, top });
  }, [anchor]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div className="person-card" ref={ref} role="dialog" aria-label={`${person.name}, extension ${person.extension}`}
      style={{ left: pos.left, top: pos.top }}>
      <div className="person-card-head">
        <Avatar name={person.name} id={person.extension} size={44} talking={talking} />
        <div>
          <div className="person-card-name">{person.name}</div>
          <div className="person-card-ext">ext {person.extension}</div>
        </div>
      </div>
      <div className="person-card-status">
        <span className={`presence ${online ? 'online' : 'offline'}`}><span className="presence-dot" aria-hidden="true" />{online ? 'Online' : 'Offline'}</span>
        {talking && <span className="presence talking-now"><span className="presence-dot" aria-hidden="true" />Talking</span>}
      </div>
      <div className="person-card-groups">
        <div className="person-card-label">In your groups</div>
        {groups.length ? <div>{groups.join(', ')}</div> : <div className="dim">None right now</div>}
      </div>
      {onCallWith
        ? <button className="act-btn danger" onClick={onHangup}>Hang up</button>
        : callable
          ? <button className="person-card-call" disabled={!online} onClick={onCall}>{online ? `Call ${person.name}` : 'Offline -can\'t call'}</button>
          : <div className="dim person-card-note">That's you.</div>}
      {keyButton && !onCallWith && <div className="dim person-card-note">One of your intercom keys.</div>}
    </div>
  );
}

// A titled, collapsible section of a group card -collapsed by default.
function Section({ title, badge, actions, children }: {
  title: string; badge?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`card-section${open ? ' open' : ''}`}>
      <div className="card-section-headrow">
        <button className="card-section-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span>{title}</span>
          {badge}
          <span className="chevron"><Icon name="chevron" /></span>
        </button>
        {actions}
      </div>
      {open && <div className="card-section-body">{children}</div>}
    </div>
  );
}

function VolumeRow({ slot, state, actions }: { slot: SlotId; state: SlotState; actions: SlotActions }) {
  return (
    <div className="card-volume">
      <button className={`icon-btn${state.listenMuted ? ' off' : ''}`} aria-label={state.listenMuted ? 'Unmute listening' : 'Mute listening'}
        onClick={() => actions.setListenMuted(slot, !state.listenMuted)}>
        <Icon name="volumeOff" size={20} />
      </button>
      <input type="range" min={0} max={100} value={Math.round(state.volume * 100)} disabled={state.listenMuted}
        onChange={(e) => actions.setVolume(slot, Number(e.target.value) / 100)} aria-label="Volume" />
      <span className="icon-static"><Icon name="volume" size={20} /></span>
    </div>
  );
}

// The "All" tab: everyone in the directory, searchable, online first. Rows
// call (or hang up) directly; people who are also your assigned keys are
// tagged. A list rather than tiles, so it still works with hundreds of
// people.
function DirectoryPanel({ directory, keys, online, lineUp, activeExt, onCall, onHangup }: {
  directory: DirectoryEntry[]; keys: Button[]; online: string[]; lineUp: boolean; activeExt: string | null;
  onCall: (extension: string, name: string) => void; onHangup: () => void;
}) {
  const [query, setQuery] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const keyExts = new Set(keys.map((b) => b.target_extension));
  const q = query.trim().toLowerCase();
  const people = directory
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.extension.includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  // The person you're on a call with leads, then online, then offline.
  const onCallWith = people.filter((p) => p.extension === activeExt);
  const on = people.filter((p) => p.extension !== activeExt && online.includes(p.extension));
  const off = onlineOnly ? [] : people.filter((p) => p.extension !== activeExt && !online.includes(p.extension));

  const row = (p: DirectoryEntry) => {
    const isOnline = online.includes(p.extension);
    const isActive = p.extension === activeExt;
    return (
      <div key={p.extension} className={`dir-row${isActive ? ' active' : ''}${isOnline ? '' : ' offline'}`}>
        <span className="dir-avatar">
          <Avatar name={p.name} id={p.extension} size={32} openable />
          <span className={`dir-presence ${isOnline ? 'online' : 'offline'}`} aria-hidden="true" />
        </span>
        <span className="dir-name">
          <span className="dir-name-text">{p.name}</span>
          {isActive && <span className="dir-note">· on call with you</span>}
          {keyExts.has(p.extension) && <span className="info-tag">Your key</span>}
        </span>
        <span className="dir-ext">{p.extension}</span>
        {isActive
          ? <button className="dir-btn danger" onClick={onHangup}>Hang up</button>
          : <button className="dir-btn" disabled={!isOnline || !lineUp} onClick={() => onCall(p.extension, p.name)}
              aria-label={isOnline ? `Call ${p.name}` : `${p.name} is offline`}>{isOnline ? 'Call' : 'Offline'}</button>}
      </div>
    );
  };

  return (
    <div className="card dir-panel">
      <div className="dir-tools">
        <label className="dir-search">
          <Icon name="search" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or extension" aria-label="Search the directory" />
        </label>
        <label className="dir-filter"><input type="checkbox" checked={onlineOnly} onChange={(e) => setOnlineOnly(e.target.checked)} /> Online only</label>
      </div>
      <div className="dir-list">
        {onCallWith.map(row)}
        {on.length > 0 && <div className="dir-heading">Online · {on.length}</div>}
        {on.map(row)}
        {off.length > 0 && <div className="dir-heading">Offline · {off.length}</div>}
        {off.map(row)}
        {people.length === 0 && <div className="empty">{q ? 'Nobody matches.' : 'Nobody else in the directory.'}</div>}
        {people.length > 0 && onCallWith.length + on.length + off.length === 0 && <div className="empty">Nobody online right now.</div>}
      </div>
    </div>
  );
}

// Device preferences used to be stored under 'open-intercom-*' keys (the
// product's name until 2026-10-18); read those once if the new key is unset.
function storedPref(key: string): string | null {
  return localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^parley-/, 'open-intercom-'));
}

// Which Intercom tab is showing, remembered per device.
type IcmTab = 'assigned' | 'all';
const ICM_TAB_KEY = 'parley-icm-tab';
function loadIcmTab(): IcmTab {
  try { return storedPref(ICM_TAB_KEY) === 'all' ? 'all' : 'assigned'; } catch { return 'assigned'; }
}

// The Intercom section: a call card (who you're on with, mic / hold / hang up,
// auto-answer, volume) beside the ICM keys as large panel keys. Press a key to
// call that person; press the live key (or Hang up) to end it.
function IcmSection({ state, actions, keys, directory, lineUp, recording, online, autoAnswer, onToggleAutoAnswer, onHold, onHangup, onPress, onCall }: {
  state: SlotState; actions: SlotActions; keys: Button[]; directory: DirectoryEntry[]; lineUp: boolean; recording: boolean; online: string[];
  onCall: (extension: string, name: string) => void;
  autoAnswer: boolean; onToggleAutoAnswer: () => void; onHold: () => void; onHangup: () => void; onPress: (b: Button) => void;
}) {
  const active = state.status !== 'idle';
  const live = state.status === 'connected';
  const activeKey = active ? keys.find((b) => state.counterpart === b.target_extension) : undefined;
  // Calls can now be with anyone in the directory, not only assigned keys.
  const who = activeKey ? buttonLabel(activeKey)
    : directory.find((p) => p.extension === state.counterpart)?.name ?? state.counterpart;
  const [tab, setTab] = useState<IcmTab>(loadIcmTab);
  const pickTab = (t: IcmTab) => { setTab(t); try { localStorage.setItem(ICM_TAB_KEY, t); } catch { /* not remembered */ } };
  return (
    <>
    <div className="section-head">
      <h2>Intercom</h2>
      <div className="seg-tabs" role="tablist" aria-label="Intercom keys">
        <button role="tab" aria-selected={tab === 'assigned'} className={tab === 'assigned' ? 'on' : ''} onClick={() => pickTab('assigned')}>Assigned · {keys.length}</button>
        <button role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'on' : ''} onClick={() => pickTab('all')}>All · {directory.length}</button>
      </div>
    </div>
    <div className="icm-row">
      <div className={`card call-card${live ? ' is-live' : active ? ' is-pending' : ''}${state.onHold ? ' is-held' : ''}`}>
        <div className="call-head">
          {active && who
            ? <Avatar name={who} id={state.counterpart ?? who} size={40} openable />
            : <span className="call-idle-icon"><Icon name="headset" size={20} /></span>}
          <div className="card-title">
            <div className="card-name">
              <span className="card-name-text">{active ? `${live ? 'On call' : 'Calling'} · ${who ?? ''}` : 'No call'}</span>
              {active && recording && <RecTag title="This call is being recorded" />}
            </div>
            <div className="card-sub">
              {active ? `${state.status}${state.onHold ? ' · on hold' : ''}` : 'press a key to call'}
            </div>
          </div>
          {live && state.connectedAt && <CallTimer since={state.connectedAt} />}
          <ActivityLight state={state} />
        </div>
        <VolumeRow slot={ICM_SLOT} state={state} actions={actions} />
        {active && (
          <div className="call-actions">
            {live && (
              <button className={`act-btn${state.muted ? ' off' : ' on'}`} onClick={() => actions.setMuted(ICM_SLOT, !state.muted)}>
                <Icon name={state.muted ? 'micOff' : 'mic'} /> {state.muted ? 'Mic off' : 'Mic on'}
              </button>
            )}
            {live && (
              <button className={`act-btn${state.onHold ? ' held' : ''}`} onClick={onHold}>{state.onHold ? 'Resume' : 'Hold'}</button>
            )}
            <button className="act-btn danger" onClick={onHangup}>Hang up</button>
          </div>
        )}
        <label className="autoanswer-toggle">
          <input type="checkbox" checked={autoAnswer} onChange={onToggleAutoAnswer} /> Auto-answer incoming calls
        </label>
      </div>

      {tab === 'all'
        ? <DirectoryPanel directory={directory} keys={keys} online={online} lineUp={lineUp}
            activeExt={active ? state.counterpart : null} onCall={onCall} onHangup={onHangup} />
        : (
      <div className="key-grid">
        {keys.map((b) => {
          const isActive = !!activeKey && activeKey.id === b.id;
          const isOnline = online.includes(b.target_extension!);
          return (
            <button key={b.id} className={`key-tile${isActive ? ' live' : ''}`}
              disabled={!lineUp && !isActive} onClick={() => onPress(b)}
              aria-label={`${isActive ? 'Hang up' : 'Call'} ${buttonLabel(b)}, ${isOnline ? 'online' : 'offline'}`}>
              {/* Presence: green filled = online (registered), red ring = offline.
                  Shape differs as well as colour, for colour-blind users. */}
              <span className={`key-presence ${isOnline ? 'online' : 'offline'}`} title={isOnline ? 'Online' : 'Offline'} aria-hidden="true" />
              <span className="key-meta">ICM {b.target_extension}{isActive ? ' · LIVE' : ''}</span>
              <span className="key-who">
                <Avatar name={buttonLabel(b)} id={b.target_extension!} size={30} />
                <span className="key-name">{buttonLabel(b)}</span>
              </span>
            </button>
          );
        })}
        {keys.length === 0 && <div className="empty">No intercom keys assigned.</div>}
      </div>
        )}
    </div>
    </>
  );
}

// A group's transcript (backend transcriber, per speaker) and typed chat,
// whichever the group has switched on, as one timeline; readable (and chat
// writable) whether or not you've joined. With both on, a filter narrows it
// to Spoken or Typed. Polls every 2s while open and stays pinned to the
// newest line unless you've scrolled up.
function ConversationPanel({ dialCode, selfExt, transcribe, chat, onSeen, fill = false, readingId = null }: {
  dialCode: string; selfExt: string; transcribe: boolean; chat: boolean;
  readingId?: string | null; // chat message being read aloud, outlined
  onSeen: (kind: keyof LatestIds, id: string) => void;
  fill?: boolean; // the phone sheet: take the whole height
}) {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [show, setShow] = useState<'all' | 'spoken' | 'typed'>('all');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const lastLine = useRef<string | undefined>(undefined);
  const lastMsg = useRef<string | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const seen = useRef(onSeen);
  seen.current = onSeen;

  const pollChat = useCallback(() => api.groupChat(dialCode, lastMsg.current)
    .then((r) => {
      if (!r.messages.length) return;
      lastMsg.current = r.messages[r.messages.length - 1].id;
      seen.current('chat', lastMsg.current);
      // A message can come back twice (posted, then polled), so key by id.
      setMessages((prev) => {
        const have = new Set(prev.map((m) => m.id));
        return [...prev, ...r.messages.filter((m) => !have.has(m.id))].slice(-200);
      });
    })
    .catch(() => { /* keep what we have */ }), [dialCode]);

  useEffect(() => {
    let stopped = false;
    const pollLines = () => api.groupTranscript(dialCode, lastLine.current)
      .then((r) => {
        if (stopped || !r.lines.length) return;
        lastLine.current = r.lines[r.lines.length - 1].id;
        seen.current('transcript', lastLine.current);
        setLines((prev) => [...prev, ...r.lines].slice(-200));
      })
      .catch(() => { /* keep what we have */ });
    const poll = () => {
      if (transcribe) void pollLines();
      if (chat && !stopped) void pollChat();
    };
    poll();
    const t = window.setInterval(poll, 2000);
    return () => { stopped = true; window.clearInterval(t); };
  }, [dialCode, transcribe, chat, pollChat]);

  const both = transcribe && chat;
  type Item = { key: string; at: number; ext: string; name: string; text: string; typed: boolean };
  const items: Item[] = [
    ...(show !== 'typed' ? lines.map((l) => ({
      key: `t${l.id}`, at: Date.parse(l.spoken_at), ext: l.speaker_extension,
      name: l.speaker_name || l.speaker_extension, text: l.text, typed: false })) : []),
    ...(show !== 'spoken' ? messages.map((m) => ({
      key: `c${m.id}`, at: Date.parse(m.created_at), ext: m.author_extension,
      name: m.author_name || m.author_extension, text: m.body, typed: true })) : []),
  ].sort((a, b) => a.at - b.at);

  useLayoutEffect(() => {
    if (pinned.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [items.length, show]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await api.postChat(dialCode, text);
      setDraft('');
      pinned.current = true;
      await pollChat();
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const empty = show === 'typed' || !transcribe ? 'No messages yet.' : show === 'spoken' || !chat ? 'Nothing said yet.' : 'Nothing said or typed yet.';
  return (
    <div className={`convo${fill ? ' fill' : ''}`}>
      {both && (
        <div className="convo-filter" role="group" aria-label="Show">
          {(['all', 'spoken', 'typed'] as const).map((k) => (
            <button key={k} className={show === k ? 'on' : ''} aria-pressed={show === k} onClick={() => setShow(k)}>
              {k === 'all' ? 'Everything' : k === 'spoken' ? 'Spoken' : 'Typed'}
            </button>
          ))}
        </div>
      )}
      <div className="transcript" ref={box}
        onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
        {items.length === 0 && <div className="transcript-empty">{empty}</div>}
        {items.map((it) => (
          <div key={it.key} className={`chat-line${it.ext === selfExt ? ' self' : ''}`}>
            <Avatar name={it.name} id={it.ext} size={24} openable />
            <div className={`chat-bubble${it.typed ? ' typed' : ''}${it.key === `c${readingId}` ? ' reading' : ''}`}>
              <div className="chat-meta">
                {it.name}{it.ext === selfExt ? ' (you)' : ''} · {new Date(it.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                {both && <> · <Icon name={it.typed ? 'keyboard' : 'mic'} size={11} /> {it.typed ? 'typed' : 'said'}</>}
                {it.key === `c${readingId}` && <span className="reading-label"> · reading aloud</span>}
              </div>
              {it.text}
            </div>
          </div>
        ))}
      </div>
      {chat && (
        <form className="convo-composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label className="sr-only" htmlFor={`chat-${dialCode}`}>Message the group</label>
          <input id={`chat-${dialCode}`} type="text" value={draft} maxLength={1000} placeholder="Message the group"
            autoComplete="off" onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="convo-send" disabled={!draft.trim() || sending}>Send</button>
        </form>
      )}
      {sendError && <div className="convo-error">Not sent: {sendError}</div>}
    </div>
  );
}

// The phone layout (the client's 600px breakpoint).
function useNarrow(): boolean {
  const q = '(max-width: 600px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

// A group's transcript and/or chat, whichever it has switched on: a
// collapsible section in the card, or on a phone a full-screen sheet.
// A group's read-aloud state and controls, from App's useReadAloud.
type ReadAloudCtl = {
  on: boolean; joined: boolean; readingId: string | null; waiting: number;
  toggle: () => void; skip: () => void; stop: () => void;
};

function ReadAloudToggle({ ra, compact = false }: { ra: ReadAloudCtl; compact?: boolean }) {
  if (!TTS_AVAILABLE) return null;
  const label = ra.on ? 'Read aloud: on' : 'Read aloud';
  const title = ra.on
    ? (ra.joined ? 'Typed messages in this group are read aloud. Click to stop.' : 'On: typed messages will be read aloud once you join')
    : 'Read typed messages in this group aloud while you\'re in it';
  return (
    <button className={`ra-btn${ra.on ? ' on' : ''}${compact ? ' compact' : ''}`} aria-pressed={ra.on}
      aria-label={compact ? label : undefined} title={title} onClick={ra.toggle}>
      <Icon name={ra.on ? 'volume' : 'volumeOff'} size={compact ? 20 : 14} />{!compact && <span>{label}</span>}
    </button>
  );
}

function ReadAloudQueue({ ra }: { ra: ReadAloudCtl }) {
  if (!ra.readingId && !ra.waiting) return null;
  return (
    <div className="ra-queue" role="status">
      <Icon name="volume" size={13} />
      <span>{ra.readingId ? 'Reading aloud' : 'Waiting'}{ra.waiting ? ` · ${ra.waiting} more` : ''}</span>
      {ra.readingId && <button className="link-btn" onClick={ra.skip}>Skip</button>}
      <button className="link-btn" onClick={ra.stop}>Stop</button>
    </div>
  );
}

function ConversationSection({ button, selfExt, hasNew, onSeen, ra }: {
  button: Button; selfExt: string; hasNew: boolean; onSeen: (kind: keyof LatestIds, id: string) => void; ra: ReadAloudCtl;
}) {
  const transcribe = !!button.target_group_transcribe_enabled;
  const chat = !!button.target_group_chat_enabled;
  const title = transcribe && chat ? 'Conversation' : chat ? 'Chat' : 'Transcript';
  const narrow = useNarrow();
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheet(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);
  const panel = (fill: boolean) => (
    <ConversationPanel dialCode={button.target_group_dial_code!} selfExt={selfExt}
      transcribe={transcribe} chat={chat} onSeen={onSeen} fill={fill} readingId={ra.readingId} />
  );
  const badge = hasNew ? <span className="new-badge">new</span> : null;
  const toggle = chat ? <ReadAloudToggle ra={ra} /> : null;
  if (!narrow) return <><Section title={title} badge={badge} actions={toggle}>{panel(false)}</Section><ReadAloudQueue ra={ra} /></>;
  return (
    <div className="card-section">
      <div className="card-section-headrow">
        <button className="card-section-head" onClick={() => setSheet(true)}>
          <span>{title}</span>{badge}
          <span className="chevron open-right"><Icon name="chevron" /></span>
        </button>
        {toggle}
      </div>
      <ReadAloudQueue ra={ra} />
      {sheet && (
        <div className="convo-sheet" role="dialog" aria-modal="true" aria-label={`${buttonLabel(button)} ${title.toLowerCase()}`}>
          <div className="convo-sheet-head">
            <button className="icon-btn" onClick={() => setSheet(false)} aria-label="Back to groups">
              <span className="back-chevron"><Icon name="chevron" size={20} /></span>
            </button>
            <div className="convo-sheet-title">
              <div className="card-name-text">{buttonLabel(button)}</div>
              <div className="card-sub">{title}</div>
            </div>
            {chat && <ReadAloudToggle ra={ra} compact />}
          </div>
          <ReadAloudQueue ra={ra} />
          {panel(true)}
        </div>
      )}
    </div>
  );
}

// One card per assigned group, joined or not. Header: name, state, and who's
// in it as an avatar stack. Joined: volume, listen/mic pair and a wide Push
// To Talk. Then collapsible Participants and (for transcribed groups)
// Transcript, and Join / Leave at the bottom.
const STACK_MAX = 4;
function GroupStrip({ button, state, actions, lineUp, participants, selfExt, recording, hasNew, onSeen, ra, onPttHeld, onToggleJoin, onToggleFavourite, onCollapse }: {
  button: Button; state: SlotState; actions: SlotActions; lineUp: boolean; recording: boolean;
  participants: GroupParticipant[] | undefined; selfExt: string; onToggleJoin: () => void;
  hasNew: boolean; onSeen: (kind: keyof LatestIds, id: string) => void;
  ra: ReadAloudCtl; onPttHeld: (held: boolean) => void;
  onToggleFavourite: () => void;
  onCollapse?: () => void; // an unjoined group opened from its tile: shrink it back
}) {
  const slot = lineSlot(button.target_group_dial_code!);
  const joined = state.status !== 'idle';
  const live = state.status === 'connected';
  const [pttHeld, setPttHeld] = useState(false);
  // Never leave read-aloud paused for a card that's gone.
  const pttCb = useRef(onPttHeld);
  pttCb.current = onPttHeld;
  useEffect(() => () => pttCb.current(false), []);
  const releasePtt = () => {
    if (!pttHeld) return;
    setPttHeld(false);
    onPttHeld(false);
    actions.setMuted(slot, true);
  };
  // Talkers first, so they stay visible when the stack is cut off at STACK_MAX.
  const people = [...(participants ?? [])].sort((x, y) => Number(y.talking) - Number(x.talking));
  const talkers = people.filter((p) => p.talking).map((p) => p.name);
  const mode = button.target_group_ptt_default ? 'PTT' : 'open mic';

  return (
    <div className={`card group-card${live ? ' is-live' : joined ? ' is-pending' : ''}`}>
      <div className="card-head">
        <ActivityLight state={state} />
        <div className="card-title">
          <div className="card-name">
            <span className="card-name-text" title={buttonLabel(button)}>{buttonLabel(button)}</span>
          </div>
          {/* Tags sit on this line, not beside the name: next to the name they
              squeezed short group names ("Production") down to an ellipsis. */}
          <div className="card-sub">
            {recording && <RecTag title="Someone in this group is being recorded, so the group's audio is recorded" />}
            {button.target_group_transcribe_enabled && <span className="info-tag" title="Speech in this group is transcribed and kept">Transcribed</span>}
            {button.target_group_chat_enabled && <span className="info-tag" title="This group has a typed chat">Chat</span>}
            {button.target_group_chat_enabled && ra.on && TTS_AVAILABLE && (
              <span className="info-tag ra-tag" title={joined ? 'Typed messages are read aloud' : 'Typed messages will be read aloud once you join'}>
                {joined ? 'Read aloud' : 'Read aloud when joined'}
              </span>
            )}
            <span>
              {GROUP_PREFIX}{button.target_group_dial_code} · {mode} · {joined ? (live ? 'joined' : state.status) : 'not joined'}
              {state.onHold ? ' · on hold' : ''}
            </span>
          </div>
        </div>
        {live && state.connectedAt && <CallTimer since={state.connectedAt} />}
        {people.length > 0
          ? (
            <span className="avatar-stack" title={people.map((p) => p.name + (p.talking ? ' (talking)' : '')).join(', ')}
              aria-label={`${people.length} in group${talkers.length ? `, talking: ${talkers.join(', ')}` : ''}`}>
              {people.slice(0, STACK_MAX).map((p) => <Avatar key={p.extension} name={p.name} id={p.extension} talking={p.talking} openable />)}
              {people.length > STACK_MAX && <span className="avatar more">+{people.length - STACK_MAX}</span>}
            </span>
          )
          : <span className="nobody">nobody here</span>}
        {onCollapse && (
          <button className="card-collapse" onClick={onCollapse} title="Show less" aria-label={`Show less of ${buttonLabel(button)}`}>
            <Icon name="chevron" />
          </button>
        )}
        <StarButton name={buttonLabel(button)} on={button.favourite} onToggle={onToggleFavourite} />
      </div>

      {joined && <VolumeRow slot={slot} state={state} actions={actions} />}

      {live && (
        <>
          <div className="card-pair">
            <button className={`act-btn${state.listenMuted ? ' off' : ' on'}`} onClick={() => actions.setListenMuted(slot, !state.listenMuted)}>
              <Icon name={state.listenMuted ? 'volumeOff' : 'volume'} /> {state.listenMuted ? 'Listen off' : 'Listening'}
            </button>
            <button className={`act-btn${state.muted && !pttHeld ? ' off' : ' on'}`} onClick={() => actions.setMuted(slot, !state.muted)}
              title={state.muted ? 'Click to latch the mic open' : 'Click to mute'}>
              <Icon name={state.muted && !pttHeld ? 'micOff' : 'mic'} /> {state.muted && !pttHeld ? 'Mic muted' : 'Mic open'}
            </button>
          </div>
          <button
            className={`ptt-wide${pttHeld ? ' held' : ''}`}
            disabled={!state.muted && !pttHeld}
            onPointerDown={(e) => {
              if (!state.muted) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              setPttHeld(true);
              onPttHeld(true);
              actions.setMuted(slot, false);
            }}
            onPointerUp={releasePtt}
            onPointerCancel={releasePtt}
          >
            {pttHeld ? 'Talking…' : state.muted ? 'Push To Talk' : 'Mic latched open'}
          </button>
        </>
      )}

      {participants && (
        <Section title={`Participants · ${people.length}`}>
          {people.length === 0
            ? <div className="participants-empty">Nobody in this group</div>
            : people.map((p) => (
              <div key={p.extension} className={`person-row${p.extension === selfExt ? ' self' : ''}${p.talking ? ' talking' : ''}`}>
                <Avatar name={p.name} id={p.extension} size={26} talking={p.talking} openable />
                <span className="person-name">{p.name}{p.extension === selfExt ? ' (you)' : ''}</span>
                <span className="person-ext">{p.talking ? 'talking' : p.extension}</span>
              </div>
            ))}
        </Section>
      )}

      {(button.target_group_transcribe_enabled || button.target_group_chat_enabled) && (
        <ConversationSection button={button} selfExt={selfExt} hasNew={hasNew} onSeen={onSeen} ra={ra} />
      )}

      <button className={joined ? 'card-leave' : 'card-join'} disabled={!joined && !lineUp} onClick={onToggleJoin}>
        {joined ? 'Leave' : 'Join'}
      </button>
    </div>
  );
}

// A group you haven't joined, as a small tile: who's in it, whether anyone
// is talking, its tags, and Join. Clicking the tile (not Join) opens the
// full card, for its participants and transcript.
function GroupTile({ button, participants, recording, lineUp, hasNew, onJoin, onOpen, onToggleFavourite }: {
  button: Button; participants: GroupParticipant[] | undefined; recording: boolean; lineUp: boolean; hasNew: boolean;
  onJoin: () => void; onOpen: () => void; onToggleFavourite: () => void;
}) {
  const people = [...(participants ?? [])].sort((x, y) => Number(y.talking) - Number(x.talking));
  const talking = people.some((p) => p.talking);
  const name = buttonLabel(button);
  return (
    <div className="group-tile">
      <div className="tile-top">
      <button className="tile-open" onClick={onOpen} title={`Show ${name}`}>
        <span className="tile-head">
          <span className={`activity${talking ? ' activity-on' : ''}`} />
          <span className="tile-name">{name}</span>
          {button.read_aloud && button.target_group_chat_enabled && TTS_AVAILABLE && (
            <span className="tile-ra" title="Read aloud is on (once you join)"><Icon name="volume" size={14} /></span>
          )}
        </span>
        <span className="tile-meta">
          {people.length > 0
            ? (
              <span className="avatar-stack" aria-label={`${people.length} in group`}>
                {people.slice(0, STACK_MAX).map((p) => <Avatar key={p.extension} name={p.name} id={p.extension} size={24} talking={p.talking} />)}
                {people.length > STACK_MAX && <span className="avatar more" style={{ width: 24, height: 24 }}>+{people.length - STACK_MAX}</span>}
              </span>
            )
            : <span className="nobody">nobody here</span>}
          {recording && <RecTag title="Someone in this group is being recorded, so the group's audio is recorded" />}
          {button.target_group_transcribe_enabled && <span className="info-tag">Transcribed</span>}
          {button.target_group_chat_enabled && <span className="info-tag">Chat</span>}
          {hasNew && <span className="new-badge" title="New messages or transcript lines">new</span>}
        </span>
      </button>
      <StarButton name={name} on={button.favourite} onToggle={onToggleFavourite} />
      </div>
      <button className="card-join tile-join" disabled={!lineUp} onClick={onJoin}>Join</button>
    </div>
  );
}

// Crop a chosen image to a centred square and shrink it to PHOTO_SIZE px
// JPEG in the browser, so uploads are a few KB whatever the camera made.
const PHOTO_SIZE = 192;
async function cropToSquare(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PHOTO_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser can\'t process images');
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))), 'image/jpeg', 0.85));
}

// "My profile": opened from your name in the top bar. Your picture (change /
// remove), who you are, your line, whether your calls are recorded, and the
// groups you have.
// Read-aloud voice settings, in the profile menu. Per device: voices differ
// between browsers and machines. Which groups are read is set on each card.
function ReadAloudSettings({ prefs, onChange, groups }: {
  prefs: ReadAloudPrefs; onChange: (p: ReadAloudPrefs) => void; groups: string[];
}) {
  const voices = useVoices();
  if (!TTS_AVAILABLE) return null;
  const set = (patch: Partial<ReadAloudPrefs>) => onChange({ ...prefs, ...patch });
  const check = (key: 'sayWho' | 'duck' | 'waitPtt' | 'sayGroup', label: string, help?: string) => (
    <label className="ra-check">
      <input type="checkbox" checked={prefs[key]} onChange={(e) => set({ [key]: e.target.checked })} />
      <span>{label}{help && <span className="dim ra-help">{help}</span>}</span>
    </label>
  );
  return (
    <div className="ra-settings">
      <div className="ra-settings-head">Read messages aloud</div>
      <div className="dim ra-help">
        {groups.length ? `On for ${groups.join(', ')}, while you're in them.` : 'Turn it on with the speaker on a group\'s conversation.'} These voice settings are for this device.
      </div>
      <label className="ra-field">Voice
        <select value={prefs.voiceURI ?? ''} onChange={(e) => set({ voiceURI: e.target.value || null })}>
          <option value="">This browser's default</option>
          {voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
        </select>
      </label>
      <label className="ra-field">Speed
        <span className="ra-slider">
          <input type="range" min={50} max={200} step={10} value={Math.round(prefs.rate * 100)} onChange={(e) => set({ rate: Number(e.target.value) / 100 })} />
          <span className="mono">{prefs.rate.toFixed(1)}×</span>
        </span>
      </label>
      <label className="ra-field">Volume
        <span className="ra-slider">
          <input type="range" min={0} max={100} step={5} value={Math.round(prefs.volume * 100)} onChange={(e) => set({ volume: Number(e.target.value) / 100 })} />
          <span className="mono">{Math.round(prefs.volume * 100)}%</span>
        </span>
      </label>
      {check('sayWho', 'Say who sent it', '"Producer: guest two is in make-up"')}
      {check('duck', 'Turn group audio down while reading')}
      {check('waitPtt', 'Wait while I\'m talking', 'Held until you let go of Push To Talk')}
      {check('sayGroup', 'Say which group, when more than one is on')}
      <button onClick={() => speakNow(`${prefs.sayWho ? 'Producer: ' : ''}guest two is in make-up, ten minutes`, prefs)}>Play a test message</button>
    </div>
  );
}

function ProfileMenu({ name, extension, lineStatus, recorded, groups, hasPhoto, onPhotoChanged, raPrefs, onRaPrefs, raGroups }: {
  name: string; extension: string; lineStatus: string; recorded: boolean; groups: string[];
  hasPhoto: boolean; onPhotoChanged: () => void;
  raPrefs: ReadAloudPrefs; onRaPrefs: (p: ReadAloudPrefs) => void; raGroups: string[];
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      await api.uploadAvatar(await cropToSquare(file));
      onPhotoChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const remove = async () => {
    setBusy(true); setError(null);
    try { await api.removeAvatar(); onPhotoChanged(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="profile" ref={wrap}>
      <button className="profile-btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        <Avatar name={name} id={extension} size={28} />
        <span className="client-name">{name}</span>
        <span className="client-ext">ext {extension}</span>
        <span className="chevron"><Icon name="chevron" size={14} /></span>
      </button>
      {open && (
        <div className="profile-panel" role="dialog" aria-label="My profile">
          <div className="profile-photo">
            <Avatar name={name} id={extension} size={88} />
            <div className="profile-photo-actions">
              <button disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? 'Saving…' : hasPhoto ? 'Change photo' : 'Add photo'}</button>
              {hasPhoto && <button className="link-btn" disabled={busy} onClick={remove}>Remove photo</button>}
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} />
            </div>
          </div>
          {error && <div className="login-error">{error}</div>}
          <div className="profile-name">{name}</div>
          <div className="profile-rows">
            <div><span className="dim">Extension</span><span className="mono">{extension}</span></div>
            <div><span className="dim">Line</span><span>{lineStatus === 'registered' ? 'Up' : lineStatus === 'connecting' ? 'Connecting…' : 'Down'}</span></div>
            <div><span className="dim">Call recording</span><span>{recorded ? 'Your calls are recorded' : 'Off'}</span></div>
            <div><span className="dim">Groups</span><span>{groups.length ? groups.join(', ') : 'None'}</span></div>
          </div>
          <ReadAloudSettings prefs={raPrefs} onChange={onRaPrefs} groups={raGroups} />
        </div>
      )}
    </div>
  );
}

// Visual themes: same layout and behaviour, different look. Panel is the
// default; the choice is a per-browser preference (localStorage), applied as
// <html data-theme="..."> so styles.css swaps its variables.
const THEMES = [
  { id: 'panel', label: 'Panel' },
  { id: 'warm', label: 'Warm' },
] as const;
type ThemeId = typeof THEMES[number]['id'];
const THEME_KEY = 'parley-theme';
function loadTheme(): ThemeId {
  try {
    const t = storedPref(THEME_KEY);
    return THEMES.some((x) => x.id === t) ? (t as ThemeId) : 'panel';
  } catch {
    return 'panel';
  }
}
function useTheme(): [ThemeId, (t: ThemeId) => void] {
  const [theme, setTheme] = useState<ThemeId>(loadTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode: not remembered */ }
  }, [theme]);
  return [theme, setTheme];
}
function ThemeSwitch({ theme, onChange }: { theme: ThemeId; onChange: (t: ThemeId) => void }) {
  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t.id} className={theme === t.id ? 'on' : ''} aria-pressed={theme === t.id} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<IntercomClientSession | null>(null);
  const [slotStates, setSlotStates] = useState<SlotStates>({ [ICM_SLOT]: idleSlot() });
  // A queue, not a single slot: a second manual-answer-path incoming call
  // (see newRTCSession below) must not silently overwrite/strand the first
  // one, which is still ringing with no other UI reference to it. Only the
  // head of the queue is shown in the banner; answering/rejecting it reveals
  // the next, if any.
  const [incomingQueue, setIncomingQueue] = useState<{ session: any; from: string }[]>([]);
  const incoming = incomingQueue[0] ?? null;
  // Not persisted -resets to true (today's behavior) on reload/re-login.
  // Unjoined groups opened from their tile into a full card (dial codes).
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const [intercomAutoAnswer, setIntercomAutoAnswer] = useState(true);
  const [theme, setTheme] = useTheme();
  // The plaintext SIP password, kept in memory ONLY -never sessionStorage,
  // unlike api.ts's token -see sipUa.ts's header comment on why pbx-core's
  // digest auth needs it and ReconnectScreen on what happens when it's
  // missing (a same-tab reload).
  const passwordRef = useRef('');
  const [needsSipPassword, setNeedsSipPassword] = useState(false);
  const [sipConnecting, setSipConnecting] = useState(false);
  const [sipAuthError, setSipAuthError] = useState<string | null>(null);
  // The SIP line itself, shown in the top bar. JsSIP retries a dead
  // WebSocket silently (no registrationFailed), so without this a broken
  // /ws proxy just looked like calls "flashing" and failing instantly.
  const [lineStatus, setLineStatus] = useState<'connecting' | 'registered' | 'down'>('connecting');
  // dial code -> current members, polled from the backend (pbx-core's live
  // call list), so a group shows who's in it even if you haven't joined.
  const [participants, setParticipants] = useState<Record<string, GroupParticipant[]> | null>(null);
  // Who's online and what's being recorded, from the same poll.
  // Newest chat/transcript ids per group (from the 1s poll) against the
  // newest this user has had on screen, for the "new" markers.
  const [latest, setLatest] = useState<Record<string, LatestIds>>({});
  const [seen, markSeen] = useSeen(session?.extension, latest);
  // Read aloud: voice settings per device; which groups is per button
  // (server). Push To Talk held anywhere pauses reading.
  const [raPrefs, setRaPrefsState] = useState<ReadAloudPrefs>(loadPrefs);
  const setRaPrefs = (p: ReadAloudPrefs) => { setRaPrefsState(p); savePrefs(p); };
  const pttHeldSlots = useRef(new Set<string>());
  const readAloud = useReadAloud({
    eligible: (session?.buttons ?? [])
      .filter((b) => b.button_type === 'group' && b.read_aloud && b.target_group_chat_enabled
        && slotStates[lineSlot(b.target_group_dial_code!)]?.status === 'connected')
      .map((b) => ({ code: b.target_group_dial_code!, group: buttonLabel(b) })),
    latest,
    selfExt: session?.extension ?? '',
    prefs: raPrefs,
    isPttHeld: () => pttHeldSlots.current.size > 0,
    duck: (code, on) => managerRef.current.duck(lineSlot(code), on ? 0.3 : 1),
  });
  const [live, setLive] = useState<Pick<LiveState, 'online' | 'recording' | 'avatars'>>({ online: [], recording: { self: false, icm: false, groups: [] }, avatars: {} });
  const [pollTick, setPollTick] = useState(0); // bump to poll right away (e.g. after changing your photo)
  const [card, setCard] = useState<{ person: { extension: string; name: string }; anchor: DOMRect } | null>(null);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const openPerson = useCallback<OpenPerson>((person, el) => setCard({ person, anchor: el.getBoundingClientRect() }), []);
  const closeCard = useCallback(() => setCard(null), []);
  // Why the last WebSocket attempt failed, shown in the badge. 1006 with no
  // reason is the browser's generic "connection failed", typically a TLS
  // trust failure on wss:// (see README -> TLS).
  const [lineError, setLineError] = useState<string | null>(null);
  const [reconnectTick, setReconnectTick] = useState(0);
  const uaRef = useRef<any>(null);
  const managerRef = useRef<CallManager>(new CallManager((evt: CallEventPayload) => {
    // Fire-and-forget by design -a reporting failure must never affect an
    // actual call. See calls.ts's comment on CallEventPayload.
    api.reportCallEvent(evt).catch((err) => console.warn(`[call-events] report failed: ${(err as Error).message}`));
  }));
  const sessionRef = useRef<IntercomClientSession | null>(null);
  // newRTCSession below is registered once per login (effect keyed on
  // [session]), so it needs a ref rather than the state value directly to
  // avoid seeing a stale toggle after the operator flips it.
  const intercomAutoAnswerRef = useRef(true);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  // Effects that set up the line, polls and directory key on WHO is logged
  // in, not on the session object: that object changes whenever a button
  // preference does (a star, read aloud), and re-running the line's effect
  // would tear down the SIP registration and every call on it.
  const sessionExt = session?.extension;

  useEffect(() => {
    intercomAutoAnswerRef.current = intercomAutoAnswer;
  }, [intercomAutoAnswer]);

  useEffect(() => managerRef.current.onChange(setSlotStates), []);

  // Every second: quick enough for the who's-talking rings to feel live, and
  // cheap for the backend (one pbx-core status fetch, one transcriber fetch,
  // two small queries). A failed poll (pbx-core briefly down) keeps the last
  // list rather than blanking it.
  useEffect(() => {
    if (!session || needsSipPassword) return;
    let stopped = false;
    const poll = () => api.groupParticipants()
      .then((r) => {
        if (stopped) return;
        setParticipants(r.participants);
        setLive({ online: r.online, recording: r.recording, avatars: r.avatars ?? {} });
        setLatest(r.latest ?? {});
      })
      .catch(() => { /* keep last known */ });
    poll();
    const t = window.setInterval(poll, 1000);
    return () => { stopped = true; window.clearInterval(t); };
  }, [sessionExt, needsSipPassword, pollTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reattach an existing intercom client session on a same-tab reload.
  useEffect(() => {
    if (!api.isLoggedIn()) return;
    api.me().then(setSession).catch(() => {});
  }, []);

  useEffect(() => {
    if (!session) return;
    if (!passwordRef.current) { setNeedsSipPassword(true); return; }
    setSipConnecting(true);
    const ua = createIntercomClientUa(session.extension, passwordRef.current);
    uaRef.current = ua;

    setLineStatus('connecting');
    ua.on('connecting', () => setLineStatus('connecting'));
    ua.on('disconnected', (e: any) => {
      setLineStatus('down');
      const code = e?.code;
      const why = e?.reason || (e?.error ? 'connection error' : '');
      setLineError(code ? `ws ${code}${why ? ` ${why}` : ''}` : why || null);
      console.warn('[sip] websocket disconnected', e);
    });
    ua.on('unregistered', () => setLineStatus('down'));
    ua.on('registered', () => {
      setLineStatus('registered');
      setLineError(null);
      setSipConnecting(false);
      setNeedsSipPassword(false);
      setSipAuthError(null);
    });
    // A wrong password (or a directory user with no sip_ha1 set yet -e.g.
    // right after an admin changed their extension, see
    // directoryUserService.ts) fails here, not silently -drop back to
    // ReconnectScreen with an error rather than a UA that's stuck retrying
    // forever with credentials that will never work.
    ua.on('registrationFailed', (e: any) => {
      console.error('[sip] registration failed:', e?.cause || e);
      passwordRef.current = '';
      setSipConnecting(false);
      setNeedsSipPassword(true);
      setSipAuthError('Could not connect -check your password and try again.');
    });

    ua.on('newRTCSession', (data: any) => {
      const rtcSession = data.session;
      if (rtcSession.direction !== 'incoming') return;

      // pbx-core unconditionally injects these on a direct call between
      // intercom-family endpoints (see pbx-core/src/config.ts's
      // autoAnswerHeaders) -honour it exactly like intercom-endpoint does,
      // matching real ring-down turret behaviour: instant pickup, no manual
      // step. Only show the manual banner for the rare inbound call without
      // these headers.
      const inviteRequest = rtcSession._request;
      const callInfo = inviteRequest?.getHeader ? inviteRequest.getHeader('Call-Info') : null;
      const alertInfo = inviteRequest?.getHeader ? inviteRequest.getHeader('Alert-Info') : null;
      const autoAnswer = /answer-after\s*=\s*0/i.test(callInfo || '') || /auto-?answer/i.test(alertInfo || '');
      const from = rtcSession.remote_identity?.uri?.toString() || 'unknown';

      // Direct-intercom calls always land on the ICM slot. Busy (already
      // occupied) rejects with 486.
      if (autoAnswer && intercomAutoAnswerRef.current) {
        if (managerRef.current.getState(ICM_SLOT).status !== 'idle') {
          try { rtcSession.terminate({ status_code: 486 }); } catch { /* ignore */ }
          return;
        }
        managerRef.current.answer(ICM_SLOT, rtcSession, from, {
          kind: 'direct', direction: 'incoming', counterpartExtension: extOf(from),
        });
        return;
      }

      setIncomingQueue((q) => [...q, { session: rtcSession, from }]);
      // Remove THIS session specifically, wherever it sits in the queue -not
      // a blind setIncoming(null), which would wrongly clear a later call
      // that arrived (and is now being shown) while this one was still ringing.
      const dequeue = () => setIncomingQueue((q) => q.filter((i) => i.session !== rtcSession));
      rtcSession.on('ended', dequeue);
      rtcSession.on('failed', dequeue);
    });

    ua.start();
    return () => {
      ua.stop();
      uaRef.current = null;
    };
  }, [sessionExt, reconnectTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogin = useCallback((s: IntercomClientSession, password: string) => {
    passwordRef.current = password;
    setSession(s);
  }, []);

  // Checked with the server first: a wrong password gets a clear error, and
  // a right one refreshes the stored SIP hash if it's stale (see
  // authenticateDirectoryUser), so the registration that follows can work.
  const handleReconnect = useCallback((password: string) => {
    if (!session) return;
    api.login(session.extension, password).then(() => {
      passwordRef.current = password;
      setSipAuthError(null);
      setReconnectTick((t) => t + 1);
    }, (err: Error) => setSipAuthError(err.message));
  }, [session]);

  const handleLogout = useCallback(() => {
    managerRef.current.hangupAll();
    uaRef.current?.stop();
    passwordRef.current = '';
    setNeedsSipPassword(false);
    setSipAuthError(null);
    api.logout();
    setSession(null);
  }, []);

  // Direct key: call that extension on the ICM slot, or hang up if it's the
  // call already up there. Matched by counterpart identity, not display
  // label: an incoming call's label comes from the SIP URI, which won't
  // equal a button's custom label -counterpart is what both sides agree on.
  // Direct call to an extension on the ICM slot, or hang up if it's the call
  // already up there. Used by ICM keys, the All tab and the person card.
  const callExtension = useCallback((extension: string, label: string) => {
    const ua = uaRef.current;
    if (!ua || !sessionRef.current) return;
    const icm = managerRef.current.getState(ICM_SLOT);
    if (icm.status !== 'idle' && icm.counterpart === extension) {
      managerRef.current.hangup(ICM_SLOT);
      return;
    }
    // Direct calls never start muted -PTT is a group/hoot concept, not a
    // private 2-party line.
    managerRef.current.dial(ua, ICM_SLOT, targetUri(extension), label, {
      kind: 'direct', direction: 'outgoing', counterpartExtension: extension,
    });
  }, []);
  const handleDirectPress = useCallback((b: Button) => callExtension(b.target_extension!, buttonLabel(b)), [callExtension]);

  // The directory for the All tab: at sign-in, then every minute (people
  // get added or renamed rarely; who's online comes with the 1s poll).
  useEffect(() => {
    if (!session) return;
    const load = () => api.directory().then(setDirectory).catch(() => { /* keep the last list */ });
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, [sessionExt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Group line: join or leave. Each line has its own slot, so joining one
  // never disturbs another. A group's PTT default seeds the initial talk state.
  const handleLineToggle = useCallback((b: Button) => {
    const ua = uaRef.current;
    if (!ua || !sessionRef.current) return;
    const code = b.target_group_dial_code!;
    const slot = lineSlot(code);
    if (managerRef.current.getState(slot).status !== 'idle') {
      managerRef.current.hangup(slot);
      return;
    }
    managerRef.current.dial(ua, slot, targetUri(`${GROUP_PREFIX}${code}`), buttonLabel(b), {
      kind: 'group', direction: 'outgoing', counterpartExtension: code,
    }, !!b.target_group_ptt_default);
  }, []);

  const answerIncoming = useCallback(() => {
    if (!incoming) return;
    managerRef.current.answer(ICM_SLOT, incoming.session, incoming.from, {
      kind: 'direct', direction: 'incoming', counterpartExtension: extOf(incoming.from),
    });
    setIncomingQueue((q) => q.slice(1));
  }, [incoming]);

  const rejectIncoming = useCallback(() => {
    if (!incoming) return;
    try { incoming.session.terminate({ status_code: 486 }); } catch { /* ignore */ }
    setIncomingQueue((q) => q.slice(1));
  }, [incoming]);

  if (!session) {
    return <LoginScreen onLogin={handleLogin} onSubmitGesture={() => managerRef.current.primeAudio()} />;
  }

  if (needsSipPassword) {
    return (
      <ReconnectScreen
        name={session.name}
        extension={session.extension}
        error={sipAuthError}
        busy={sipConnecting}
        onReconnect={handleReconnect}
        onSubmitGesture={() => managerRef.current.primeAudio()}
        onLogout={handleLogout}
      />
    );
  }

  const icm = slotStates[ICM_SLOT] ?? idleSlot();
  const lineUp = lineStatus === 'registered';
  // One key/card per target: duplicate buttons (possible in older data; the
  // backend now refuses new ones) would otherwise draw twin cards driving
  // the same call.
  const firstPerTarget = (bs: Button[], key: (b: Button) => string | null) =>
    bs.filter((b, i) => bs.findIndex((x) => key(x) === key(b)) === i);
  const directButtons = firstPerTarget(session.buttons.filter((b) => b.button_type === 'direct'), (b) => b.target_extension);
  const groupButtons = firstPerTarget(session.buttons.filter((b) => b.button_type === 'group'), (b) => b.target_group_dial_code);
  const isJoined = (b: Button) => (slotStates[lineSlot(b.target_group_dial_code!)]?.status ?? 'idle') !== 'idle';
  // Full cards: joined groups first, then favourites, then any opened from
  // a tile; everything else is a tile under "Other groups".
  const fullRank = (b: Button) => isJoined(b) ? 0 : b.favourite ? 1 : openGroups.has(b.target_group_dial_code!) ? 2 : 3;
  const fullGroups = groupButtons.filter((b) => fullRank(b) < 3)
    .map((b, i) => ({ b, i })).sort((x, y) => fullRank(x.b) - fullRank(y.b) || x.i - y.i).map((x) => x.b);
  const tileGroups = groupButtons.filter((b) => fullRank(b) === 3);
  const setOpenGroup = (code: string, open: boolean) => setOpenGroups((prev) => {
    const next = new Set(prev);
    if (open) next.add(code); else next.delete(code);
    return next;
  });
  const hasNew = (b: Button) => {
    const code = b.target_group_dial_code!;
    const l = latest[code], s = seen[code];
    if (!l || !s) return false;
    return (!!b.target_group_chat_enabled && idGt(l.chat, s.chat))
      || (!!b.target_group_transcribe_enabled && idGt(l.transcript, s.transcript));
  };
  // A button preference (the star, read aloud), shown at once and saved in
  // the background; a failed save puts it back.
  const setButtonPref = (b: Button, field: 'favourite' | 'read_aloud', value: boolean) => {
    const apply = (v: boolean) => setSession((s) => s && ({
      ...s, buttons: s.buttons.map((x) => x.id === b.id ? { ...x, [field]: v } : x),
    }));
    apply(value);
    api.setButtonPrefs(b.id, { [field]: value }).catch((err) => {
      console.warn(`saving ${field} failed`, err);
      apply(!value);
    });
  };
  // Unstarring also clears "opened", so the group drops to a tile.
  const setFavourite = (b: Button, favourite: boolean) => {
    if (!favourite) setOpenGroup(b.target_group_dial_code!, false);
    setButtonPref(b, 'favourite', favourite);
  };
  const raFor = (b: Button): ReadAloudCtl => {
    const code = b.target_group_dial_code!;
    return {
      on: b.read_aloud,
      joined: slotStates[lineSlot(code)]?.status === 'connected',
      readingId: readAloud.reading?.code === code ? readAloud.reading.id : null,
      waiting: readAloud.waiting[code] ?? 0,
      toggle: () => {
        if (!b.read_aloud) primeSpeech(); // inside the click, so the browser allows speech
        else readAloud.stop(code);
        setButtonPref(b, 'read_aloud', !b.read_aloud);
      },
      skip: readAloud.skip,
      stop: () => readAloud.stop(code),
    };
  };
  // Joining or leaving clears "opened", so a group you leave goes back to
  // being a tile (or stays a card, if it's a favourite).
  const joinOrLeave = (b: Button) => {
    setOpenGroup(b.target_group_dial_code!, false);
    handleLineToggle(b);
  };
  const actions: SlotActions = {
    setMuted: (slot, m) => managerRef.current.setMuted(slot, m),
    setListenMuted: (slot, v) => managerRef.current.setListenMuted(slot, v),
    setVolume: (slot, v) => managerRef.current.setVolume(slot, v),
  };

  // The person card's facts, worked out from what's already polled.
  let personCard: React.ReactNode = null;
  if (card) {
    const ext = card.person.extension;
    const inGroups = groupButtons.filter((b) => (participants?.[b.target_group_dial_code!] ?? []).some((p) => p.extension === ext));
    const talking = inGroups.some((b) => participants?.[b.target_group_dial_code!]?.some((p) => p.extension === ext && p.talking));
    const keyButton = directButtons.find((b) => b.target_extension === ext);
    const inDirectory = directory.some((p) => p.extension === ext);
    const onCallWith = icm.status !== 'idle' && icm.counterpart === ext;
    personCard = (
      <PersonCard person={card.person} anchor={card.anchor}
        online={live.online.includes(ext)} talking={talking} groups={inGroups.map(buttonLabel)}
        keyButton={keyButton} callable={!!keyButton || inDirectory} onCallWith={onCallWith}
        onCall={() => { callExtension(ext, keyButton ? buttonLabel(keyButton) : card.person.name); setCard(null); }}
        onHangup={() => { managerRef.current.hangup(ICM_SLOT); setCard(null); }}
        onClose={closeCard} />
    );
  }

  return (
    <AvatarPhotosContext.Provider value={live.avatars}>
    <PersonCardContext.Provider value={openPerson}>
    <div className="client-shell">
      <div className="client-topbar">
        <div className="topbar-who">
          <span className="brand"><Mark size={26} /> {PRODUCT_NAME}</span>
          <ProfileMenu name={session.name} extension={session.extension} lineStatus={lineStatus}
            recorded={live.recording.self} groups={groupButtons.map(buttonLabel)}
            hasPhoto={!!live.avatars[session.extension]} onPhotoChanged={() => setPollTick((t) => t + 1)}
            raPrefs={raPrefs} onRaPrefs={setRaPrefs}
            raGroups={groupButtons.filter((b) => b.read_aloud && b.target_group_chat_enabled).map(buttonLabel)} />
          <span className={`line-status line-${lineStatus}`}>
            {lineStatus === 'registered' ? '● line up' : lineStatus === 'connecting' ? '○ connecting…' : '✕ line down -retrying'}
            {lineStatus !== 'registered' && lineError && ` (${lineError})`}
          </span>
          {/* Policy, shown all the time: your calls are recorded. The REC tag
              on a card means that particular call is being recorded now. */}
          {live.recording.self && <RecTag title="Your calls are recorded" />}
        </div>
        <div className="topbar-actions">
          <ThemeSwitch theme={theme} onChange={setTheme} />
          <button onClick={handleLogout}>Log out</button>
        </div>
      </div>

      {!MIC_AVAILABLE && (
        <div className="error-banner">
          Microphone unavailable: this page isn't a secure context, so calls can't connect.
          Open it over https:// instead.
        </div>
      )}

      {incoming && (
        <div className="incoming-banner">
          <span>
            Incoming call from {incoming.from}
            {incomingQueue.length > 1 && ` (+${incomingQueue.length - 1} more waiting)`}
          </span>
          {/* Reachable only via a genuine direct-intercom call with
              auto-answer toggled off (pbx-core injects the auto-answer
              header unconditionally today, so nothing else currently
              produces a header-less inbound INVITE) -Intercom is the only
              sensible answer target. */}
          <button onClick={answerIncoming} disabled={icm.status !== 'idle'}>
            Answer on Intercom
          </button>
          <button onClick={rejectIncoming}>Reject</button>
        </div>
      )}

      <div className="client-body">
        {/* Direct intercom and groups are different things, so they get
            separate sections -but each is a grid of cards, so the Intercom
            card stays card-sized instead of spanning the page. */}
        <section className="client-section">
          <IcmSection
              state={icm}
              actions={actions}
              keys={directButtons}
              directory={directory}
              lineUp={lineUp}
              recording={live.recording.icm}
              online={live.online}
              autoAnswer={intercomAutoAnswer}
              onToggleAutoAnswer={() => setIntercomAutoAnswer((v) => !v)}
              onHold={() => managerRef.current.setHold(ICM_SLOT, !icm.onHold)}
              onHangup={() => managerRef.current.hangup(ICM_SLOT)}
              onPress={handleDirectPress}
              onCall={callExtension}
            />
        </section>

        <section className="client-section">
          <div className="section-head">
            <h2>Groups</h2>
            {groupButtons.length > 0 && <span className="section-hint">★ a group to keep it open here, joined or not</span>}
          </div>
          {/* Joined and favourite groups (and any opened from a tile) get the
              full card; the rest are small tiles. */}
          {fullGroups.length > 0 && (
            <div className="card-grid">
              {fullGroups.map((b) => {
                const state = slotStates[lineSlot(b.target_group_dial_code!)] ?? idleSlot();
                return (
                  <GroupStrip key={b.id} button={b} state={state}
                    actions={actions} lineUp={lineUp} participants={participants?.[b.target_group_dial_code!]}
                    selfExt={session.extension} recording={live.recording.groups.includes(b.target_group_dial_code!)}
                    hasNew={hasNew(b)} onSeen={(kind, id) => markSeen(b.target_group_dial_code!, kind, id)}
                    ra={raFor(b)}
                    onPttHeld={(held) => { const k = b.target_group_dial_code!; if (held) pttHeldSlots.current.add(k); else pttHeldSlots.current.delete(k); }}
                    onToggleJoin={() => joinOrLeave(b)}
                    onToggleFavourite={() => setFavourite(b, !b.favourite)}
                    onCollapse={state.status === 'idle' && !b.favourite ? () => setOpenGroup(b.target_group_dial_code!, false) : undefined} />
                );
              })}
            </div>
          )}
          {tileGroups.length > 0 && (
            <>
              {fullGroups.length > 0 && <div className="sub-head">Other groups · {tileGroups.length}</div>}
              <div className="tile-grid">
                {tileGroups.map((b) => (
                  <GroupTile key={b.id} button={b} participants={participants?.[b.target_group_dial_code!]}
                    recording={live.recording.groups.includes(b.target_group_dial_code!)} lineUp={lineUp}
                    hasNew={hasNew(b)}
                    onJoin={() => joinOrLeave(b)} onOpen={() => setOpenGroup(b.target_group_dial_code!, true)}
                    onToggleFavourite={() => setFavourite(b, true)} />
                ))}
              </div>
            </>
          )}
          {groupButtons.length === 0 && <div className="empty">No groups assigned yet.</div>}
        </section>
        {session.buttons.length === 0 && <div className="empty">No buttons assigned yet.</div>}
      </div>
      {personCard}
    </div>
    </PersonCardContext.Provider>
    </AvatarPhotosContext.Provider>
  );
}
