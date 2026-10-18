import { useState, useEffect, useCallback, useRef, useLayoutEffect, createContext, useContext } from 'react';
import { api, Button, GroupParticipant, IntercomClientSession, LiveState, TranscriptLine } from './api';
import { createIntercomClientUa, targetUri } from './sipUa';
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
        <h1>Intercom Client Login</h1>
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
};
function Icon({ name, size = 16 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name].split(' M').map((d, i) => <path key={i} d={i ? `M${d}` : d} />)}
    </svg>
  );
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

function Avatar({ name, id, size = 28, talking = false, openable = false }: {
  name: string; id: string; size?: number; talking?: boolean; openable?: boolean;
}) {
  const open = useContext(PersonCardContext);
  const cls = `avatar tone-${avatarTone(id)}${talking ? ' talking' : ''}`;
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) };
  if (!openable) return <span className={cls} style={style} aria-hidden="true">{initials(name)}</span>;
  return (
    <button type="button" className={`${cls} avatar-btn`} style={style} aria-label={`About ${name}`}
      onClick={(e) => { e.stopPropagation(); open({ extension: id, name }, e.currentTarget); }}>
      {initials(name)}
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
function PersonCard({ person, anchor, online, talking, groups, keyButton, onCallWith, onCall, onHangup, onClose }: {
  person: { extension: string; name: string }; anchor: DOMRect;
  online: boolean; talking: boolean; groups: string[]; keyButton: Button | undefined; onCallWith: boolean;
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
        : keyButton
          ? <button className="person-card-call" disabled={!online} onClick={onCall}>{online ? `Call ${person.name}` : 'Offline -can\'t call'}</button>
          : <div className="dim person-card-note">No intercom key for this person.</div>}
    </div>
  );
}

// A titled, collapsible section of a group card -collapsed by default.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`card-section${open ? ' open' : ''}`}>
      <button className="card-section-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{title}</span>
        <span className="chevron"><Icon name="chevron" /></span>
      </button>
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

// The Intercom section: a call card (who you're on with, mic / hold / hang up,
// auto-answer, volume) beside the ICM keys as large panel keys. Press a key to
// call that person; press the live key (or Hang up) to end it.
function IcmSection({ state, actions, keys, lineUp, recording, online, autoAnswer, onToggleAutoAnswer, onHold, onHangup, onPress }: {
  state: SlotState; actions: SlotActions; keys: Button[]; lineUp: boolean; recording: boolean; online: string[];
  autoAnswer: boolean; onToggleAutoAnswer: () => void; onHold: () => void; onHangup: () => void; onPress: (b: Button) => void;
}) {
  const active = state.status !== 'idle';
  const live = state.status === 'connected';
  const activeKey = active ? keys.find((b) => state.counterpart === b.target_extension) : undefined;
  const who = activeKey ? buttonLabel(activeKey) : state.counterpart;
  return (
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
    </div>
  );
}

// A group's live transcript (backend transcriber, per speaker) as a chat
// thread, readable whether or not you've joined. Polls for new lines every 2s
// while open and stays pinned to the newest line unless you've scrolled up.
function TranscriptPanel({ dialCode, selfExt }: { dialCode: string; selfExt: string }) {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const lastId = useRef<string | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    let stopped = false;
    const poll = () => api.groupTranscript(dialCode, lastId.current)
      .then((r) => {
        if (stopped || !r.lines.length) return;
        lastId.current = r.lines[r.lines.length - 1].id;
        setLines((prev) => [...prev, ...r.lines].slice(-200));
      })
      .catch(() => { /* keep what we have */ });
    poll();
    const t = window.setInterval(poll, 2000);
    return () => { stopped = true; window.clearInterval(t); };
  }, [dialCode]);

  useLayoutEffect(() => {
    if (pinned.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  return (
    <div className="transcript" ref={box}
      onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      {lines.length === 0 && <div className="transcript-empty">Nothing said yet.</div>}
      {lines.map((l) => {
        const name = l.speaker_name || l.speaker_extension;
        return (
          <div key={l.id} className={`chat-line${l.speaker_extension === selfExt ? ' self' : ''}`}>
            <Avatar name={name} id={l.speaker_extension} size={24} openable />
            <div className="chat-bubble">
              <div className="chat-meta">
                {name}{l.speaker_extension === selfExt ? ' (you)' : ''} · {new Date(l.spoken_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </div>
              {l.text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// One card per assigned group, joined or not. Header: name, state, and who's
// in it as an avatar stack. Joined: volume, listen/mic pair and a wide Push
// To Talk. Then collapsible Participants and (for transcribed groups)
// Transcript, and Join / Leave at the bottom.
const STACK_MAX = 4;
function GroupStrip({ button, state, actions, lineUp, participants, selfExt, recording, onToggleJoin }: {
  button: Button; state: SlotState; actions: SlotActions; lineUp: boolean; recording: boolean;
  participants: GroupParticipant[] | undefined; selfExt: string; onToggleJoin: () => void;
}) {
  const slot = lineSlot(button.target_group_dial_code!);
  const joined = state.status !== 'idle';
  const live = state.status === 'connected';
  const [pttHeld, setPttHeld] = useState(false);
  const releasePtt = () => {
    if (!pttHeld) return;
    setPttHeld(false);
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
            <span className="card-name-text">{buttonLabel(button)}</span>
            {recording && <RecTag title="Someone in this group is being recorded, so the group's audio is recorded" />}
            {button.target_group_transcribe_enabled && <span className="info-tag" title="Speech in this group is transcribed and kept">Transcribed</span>}
          </div>
          <div className="card-sub">
            {GROUP_PREFIX}{button.target_group_dial_code} · {mode} · {joined ? (live ? 'joined' : state.status) : 'not joined'}
            {state.onHold ? ' · on hold' : ''}
          </div>
        </div>
        {people.length > 0
          ? (
            <span className="avatar-stack" title={people.map((p) => p.name + (p.talking ? ' (talking)' : '')).join(', ')}
              aria-label={`${people.length} in group${talkers.length ? `, talking: ${talkers.join(', ')}` : ''}`}>
              {people.slice(0, STACK_MAX).map((p) => <Avatar key={p.extension} name={p.name} id={p.extension} talking={p.talking} openable />)}
              {people.length > STACK_MAX && <span className="avatar more">+{people.length - STACK_MAX}</span>}
            </span>
          )
          : <span className="nobody">nobody here</span>}
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

      {button.target_group_transcribe_enabled && (
        <Section title="Transcript">
          <TranscriptPanel dialCode={button.target_group_dial_code!} selfExt={selfExt} />
        </Section>
      )}

      <button className={joined ? 'card-leave' : 'card-join'} disabled={!joined && !lineUp} onClick={onToggleJoin}>
        {joined ? 'Leave' : 'Join'}
      </button>
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
const THEME_KEY = 'open-intercom-theme';
function loadTheme(): ThemeId {
  try {
    const t = localStorage.getItem(THEME_KEY);
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
  const [live, setLive] = useState<Pick<LiveState, 'online' | 'recording'>>({ online: [], recording: { self: false, icm: false, groups: [] } });
  const [card, setCard] = useState<{ person: { extension: string; name: string }; anchor: DOMRect } | null>(null);
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
        setLive({ online: r.online, recording: r.recording });
      })
      .catch(() => { /* keep last known */ });
    poll();
    const t = window.setInterval(poll, 1000);
    return () => { stopped = true; window.clearInterval(t); };
  }, [session, needsSipPassword]);

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
  }, [session, reconnectTick]);

  const handleLogin = useCallback((s: IntercomClientSession, password: string) => {
    passwordRef.current = password;
    setSession(s);
  }, []);

  const handleReconnect = useCallback((password: string) => {
    passwordRef.current = password;
    setSipAuthError(null);
    setReconnectTick((t) => t + 1);
  }, []);

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
  const handleDirectPress = useCallback((b: Button) => {
    const ua = uaRef.current;
    if (!ua || !sessionRef.current) return;
    const icm = managerRef.current.getState(ICM_SLOT);
    if (icm.status !== 'idle' && icm.counterpart === b.target_extension) {
      managerRef.current.hangup(ICM_SLOT);
      return;
    }
    // Direct calls never start muted -PTT is a group/hoot concept, not a
    // private 2-party line.
    managerRef.current.dial(ua, ICM_SLOT, targetUri(b.target_extension!), buttonLabel(b), {
      kind: 'direct', direction: 'outgoing', counterpartExtension: b.target_extension!,
    });
  }, []);

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
    const onCallWith = icm.status !== 'idle' && icm.counterpart === ext;
    personCard = (
      <PersonCard person={card.person} anchor={card.anchor}
        online={live.online.includes(ext)} talking={talking} groups={inGroups.map(buttonLabel)}
        keyButton={keyButton} onCallWith={onCallWith}
        onCall={() => { if (keyButton) handleDirectPress(keyButton); setCard(null); }}
        onHangup={() => { managerRef.current.hangup(ICM_SLOT); setCard(null); }}
        onClose={closeCard} />
    );
  }

  return (
    <PersonCardContext.Provider value={openPerson}>
    <div className="client-shell">
      <div className="client-topbar">
        <div className="topbar-who">
          <span className="brand"><Icon name="headset" size={20} /> Open Intercom</span>
          <span className="client-name">{session.name}</span>
          <span className="client-ext">ext {session.extension}</span>
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
          <h2>Intercom</h2>
          <IcmSection
              state={icm}
              actions={actions}
              keys={directButtons}
              lineUp={lineUp}
              recording={live.recording.icm}
              online={live.online}
              autoAnswer={intercomAutoAnswer}
              onToggleAutoAnswer={() => setIntercomAutoAnswer((v) => !v)}
              onHold={() => managerRef.current.setHold(ICM_SLOT, !icm.onHold)}
              onHangup={() => managerRef.current.hangup(ICM_SLOT)}
              onPress={handleDirectPress}
            />
        </section>

        <section className="client-section">
          <h2>Groups</h2>
          <div className="card-grid">
            {groupButtons.map((b) => (
              <GroupStrip key={b.id} button={b} state={slotStates[lineSlot(b.target_group_dial_code!)] ?? idleSlot()}
                actions={actions} lineUp={lineUp} participants={participants?.[b.target_group_dial_code!]}
                selfExt={session.extension} recording={live.recording.groups.includes(b.target_group_dial_code!)}
                onToggleJoin={() => handleLineToggle(b)} />
            ))}
          </div>
          {groupButtons.length === 0 && <div className="empty">No groups assigned yet.</div>}
        </section>
        {session.buttons.length === 0 && <div className="empty">No buttons assigned yet.</div>}
      </div>
      {personCard}
    </div>
    </PersonCardContext.Provider>
  );
}
