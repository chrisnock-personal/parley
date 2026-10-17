import { useState, useEffect, useCallback, useRef } from 'react';
import { api, Button, IntercomClientSession } from './api';
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

// Talk side, Eyevinn-style: a latching mute toggle plus a hold-to-talk
// button for PTT while latched muted. Both drive CallManager.setMuted(). The
// PTT button stays rendered while held (pttHeld), even though muted flips
// to false underneath it -otherwise it would unmount mid-press and the
// release would never arrive.
function TalkControls({ state, onSetMuted }: { state: SlotState; onSetMuted: (muted: boolean) => void }) {
  const [pttHeld, setPttHeld] = useState(false);
  const release = () => {
    if (!pttHeld) return;
    setPttHeld(false);
    onSetMuted(true);
  };
  return (
    <>
      {!pttHeld && (
        <button className={state.muted ? 'mute-btn muted' : 'mute-btn talking'} onClick={() => onSetMuted(!state.muted)}>
          {state.muted ? '🔇 Muted' : '🎙️ Talking'}
        </button>
      )}
      {(state.muted || pttHeld) && (
        <button
          className={`ptt-btn${pttHeld ? ' ptt-live' : ''}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setPttHeld(true);
            onSetMuted(false);
          }}
          onPointerUp={release}
          onPointerCancel={release}
        >
          {pttHeld ? '🎙️ Talking…' : 'Hold to talk'}
        </button>
      )}
    </>
  );
}

// Listen side: playback mute + volume for this slot only, nothing on the wire.
function ListenControls({ state, onListenMute, onVolume }: {
  state: SlotState; onListenMute: () => void; onVolume: (v: number) => void;
}) {
  return (
    <div className="listen-controls">
      <button className={state.listenMuted ? 'listen-btn listen-off' : 'listen-btn'} onClick={onListenMute}
        title={state.listenMuted ? 'Listening muted' : 'Listening'}>
        {state.listenMuted ? '🔈 Off' : '🔊'}
      </button>
      <input type="range" min={0} max={100} value={Math.round(state.volume * 100)}
        disabled={state.listenMuted} onChange={(e) => onVolume(Number(e.target.value) / 100)} aria-label="Volume" />
    </div>
  );
}

function slotStatusText(state: SlotState): string {
  if (state.status === 'idle') return 'idle';
  return `${state.status}${state.label ? ` -${state.label}` : ''}${state.onHold ? ' (on hold)' : ''}`;
}

type SlotActions = {
  setMuted: (slot: SlotId, muted: boolean) => void;
  setListenMuted: (slot: SlotId, v: boolean) => void;
  setVolume: (slot: SlotId, v: number) => void;
};

// The direct-intercom (ICM) slot: one private 2-party call at a time, with
// real SIP hold (pbx-core/src/reinvite.ts) and the auto-answer toggle.
function IcmPanel({ state, actions, autoAnswer, onToggleAutoAnswer, onHold, onHangup }: {
  state: SlotState; actions: SlotActions; autoAnswer: boolean; onToggleAutoAnswer: () => void;
  onHold: () => void; onHangup: () => void;
}) {
  const live = state.status === 'connected';
  return (
    <div className={`slot slot-icm slot-${state.status}${state.muted ? ' slot-muted' : ''}${state.onHold ? ' slot-onhold' : ''}`}>
      <div className="slot-head">
        <ActivityLight state={state} />
        <span className="slot-name">Intercom</span>
        <label className="autoanswer-toggle">
          <input type="checkbox" checked={autoAnswer} onChange={onToggleAutoAnswer} /> Auto-answer
        </label>
      </div>
      <div className="slot-status">{slotStatusText(state)}</div>
      {state.status !== 'idle' && (
        <div className="slot-controls">
          {/* Only meaningful once media is flowing -muting/holding during
              'calling'/'ringing' has no confirmed dialog to act on yet. */}
          {live && <TalkControls state={state} onSetMuted={(m) => actions.setMuted(ICM_SLOT, m)} />}
          {live && (
            <button className={state.onHold ? 'hold-btn on-hold' : 'hold-btn'} onClick={onHold}>
              {state.onHold ? '▶ Resume' : '⏸ Hold'}
            </button>
          )}
          <button onClick={onHangup}>Hang up</button>
        </div>
      )}
      <ListenControls state={state} onListenMute={() => actions.setListenMuted(ICM_SLOT, !state.listenMuted)}
        onVolume={(v) => actions.setVolume(ICM_SLOT, v)} />
    </div>
  );
}

function buttonLabel(b: Button): string {
  return b.label || (b.button_type === 'direct' ? b.target_extension! : b.target_group_name!);
}

// Direct-intercom keys: pressing one calls that extension on the ICM slot;
// pressing the key of the call that's already up hangs it up.
// Starting a call needs a registered line; hanging up the active one doesn't.
function DirectKeys({ buttons, icm, lineUp, onPress }: {
  buttons: Button[]; icm: SlotState; lineUp: boolean; onPress: (b: Button) => void;
}) {
  if (buttons.length === 0) return null;
  return (
    <div className="key-grid">
      {buttons.map((b) => {
        const active = icm.status !== 'idle' && icm.counterpart === b.target_extension;
        return (
          <button key={b.id} className={`client-btn client-btn-direct${active ? ' client-btn-active' : ''}`}
            disabled={!lineUp && !active} onClick={() => onPress(b)}>
            <div className="btn-type">ICM · {b.target_extension}</div>
            <div className="btn-label">{buttonLabel(b)}</div>
          </button>
        );
      })}
    </div>
  );
}

// One strip per assigned group line, joined or not -Eyevinn's "lines in a
// production" view. Any number can be joined at once, each with its own
// talk and listen controls.
function LineStrip({ button, state, actions, lineUp, onToggleJoin }: {
  button: Button; state: SlotState; actions: SlotActions; lineUp: boolean; onToggleJoin: () => void;
}) {
  const slot = lineSlot(button.target_group_dial_code!);
  const joined = state.status !== 'idle';
  const live = state.status === 'connected';
  return (
    <div className={`slot slot-line slot-${state.status}${state.muted ? ' slot-muted' : ''}`}>
      <div className="slot-head">
        <ActivityLight state={state} />
        <span className="slot-name">{buttonLabel(button)}</span>
        <span className="btn-type">GRP · {GROUP_PREFIX}{button.target_group_dial_code}</span>
      </div>
      <div className="slot-status">{joined ? slotStatusText(state) : (button.target_group_ptt_default ? 'not joined · PTT line' : 'not joined')}</div>
      <div className="slot-controls">
        <button className={joined ? 'leave-btn' : 'join-btn'} disabled={!joined && !lineUp} onClick={onToggleJoin}>{joined ? 'Leave' : 'Join'}</button>
        {live && <TalkControls state={state} onSetMuted={(m) => actions.setMuted(slot, m)} />}
      </div>
      <ListenControls state={state} onListenMute={() => actions.setListenMuted(slot, !state.listenMuted)}
        onVolume={(v) => actions.setVolume(slot, v)} />
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
    ua.on('disconnected', () => setLineStatus('down'));
    ua.on('unregistered', () => setLineStatus('down'));
    ua.on('registered', () => {
      setLineStatus('registered');
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
  const directButtons = session.buttons.filter((b) => b.button_type === 'direct');
  const groupButtons = session.buttons.filter((b) => b.button_type === 'group');
  const actions: SlotActions = {
    setMuted: (slot, m) => managerRef.current.setMuted(slot, m),
    setListenMuted: (slot, v) => managerRef.current.setListenMuted(slot, v),
    setVolume: (slot, v) => managerRef.current.setVolume(slot, v),
  };

  return (
    <div className="client-shell">
      <div className="client-topbar">
        <div>
          <span className="client-name">{session.name}</span>
          <span className="client-ext">ext {session.extension}</span>
          <span className={`line-status line-${lineStatus}`}>
            {lineStatus === 'registered' ? '● line up' : lineStatus === 'connecting' ? '○ connecting…' : '✕ line down -retrying'}
          </span>
        </div>
        <button onClick={handleLogout}>Log out</button>
      </div>

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
        <section className="client-section">
          <h2>Intercom</h2>
          <IcmPanel
            state={icm}
            actions={actions}
            autoAnswer={intercomAutoAnswer}
            onToggleAutoAnswer={() => setIntercomAutoAnswer((v) => !v)}
            onHold={() => managerRef.current.setHold(ICM_SLOT, !icm.onHold)}
            onHangup={() => managerRef.current.hangup(ICM_SLOT)}
          />
          <DirectKeys buttons={directButtons} icm={icm} lineUp={lineUp} onPress={handleDirectPress} />
        </section>

        <section className="client-section">
          <h2>Lines</h2>
          <div className="line-list">
            {groupButtons.map((b) => (
              <LineStrip key={b.id} button={b} state={slotStates[lineSlot(b.target_group_dial_code!)] ?? idleSlot()}
                actions={actions} lineUp={lineUp} onToggleJoin={() => handleLineToggle(b)} />
            ))}
            {groupButtons.length === 0 && <div className="empty">No group lines assigned yet.</div>}
          </div>
        </section>
        {session.buttons.length === 0 && <div className="empty">No buttons assigned yet.</div>}
      </div>
    </div>
  );
}
