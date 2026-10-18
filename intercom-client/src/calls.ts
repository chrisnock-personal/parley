// src/calls.ts -intercom client call-slot state machine.
//
// Shape borrowed from Eyevinn's open intercom (intercom-frontend): instead of
// a turret's fixed Handset A/B/Speaker channels, the client has one
// direct-intercom slot ('icm') plus one slot per group line it has joined,
// any number of which can be live at once. Each slot has its own talk state
// (latched mute + hold-to-talk PTT), its own listen state (mute + volume),
// and an activity light driven by the inbound audio level. Multiple <audio>
// elements just play simultaneously through the OS mixer -no Web Audio
// mixing needed.
/* eslint-disable @typescript-eslint/no-explicit-any */

// 'icm' is the one direct-intercom slot (both directions) -see App.tsx's
// handleDirectPress/newRTCSession handler. Group lines are keyed by dial code
// via lineSlot(), so a line's slot is stable across leave/re-join and its
// listen preferences (volume, listen mute) carry over.
export type SlotId = string;
export const ICM_SLOT: SlotId = 'icm';
export const lineSlot = (dialCode: string): SlotId => `line:${dialCode}`;

export type CallStatus = 'idle' | 'calling' | 'ringing' | 'connected';

// Fire-and-forget call-lifecycle pings for the console's audit/session
// history -intercom clients dial directly through pbx-core, so nothing else
// in the backend ever sees these calls happen otherwise. Never call-critical: a
// reporting failure must not affect the actual call (see App.tsx's wiring).
export interface CallMeta {
  kind: 'direct' | 'group';
  direction: 'outgoing' | 'incoming';
  counterpartExtension: string;
}
export interface CallEventPayload extends Partial<CallMeta> {
  type: 'start' | 'end';
  clientCallId: string;
  reason?: string;
}

export interface SlotState {
  status: CallStatus;
  label: string | null; // who/what this slot is currently talking to (display only)
  // Stable identity (extension or group dial code) for matching a button's
  // target against a live call -distinct from `label`, which can be a
  // custom display string (b.label) or a raw SIP URI on an incoming call.
  // Populated from CallMeta.counterpartExtension, which App.tsx computes
  // consistently for both dial() and answer() (see App.tsx's extOf()).
  counterpart: string | null;
  muted: boolean; // talk side: local mic gated for this slot's call (latch and PTT share it)
  onHold: boolean; // true if either side has this slot's call on hold (SIP-level, not local mute)
  // Listen side -kept per slot across calls (see prefs below), so a line
  // you turned down stays turned down when you re-join it.
  listenMuted: boolean;
  volume: number; // 0..1, applied to this slot's <audio> element
  active: boolean; // inbound audio above threshold right now (someone is talking)
  connectedAt: number | null; // epoch ms the call connected: drives the call timer
}

export type SlotStates = Record<SlotId, SlotState>;
type Listener = (states: SlotStates) => void;

const IDLE_CALL = { status: 'idle' as const, label: null, counterpart: null, muted: false, onHold: false, active: false, connectedAt: null };
export const idleSlot = (): SlotState => ({ ...IDLE_CALL, listenMuted: false, volume: 1 });

// Browsers block .play() that isn't tied to a user gesture, and the play()
// that matters (wireSession's 'track' handler) fires from an async WebRTC
// event. Calling .play() on an element once inside a real gesture (the
// login/reconnect submit) unlocks that element for later programmatic
// play() calls. Slots are dynamic now (one per joined line), so a fixed pool
// is primed up front and handed out on demand. 16 covers the ICM slot plus
// far more simultaneous lines than anyone listens to; past that, new
// elements are created unprimed and usually still play, since the page has
// had a user gesture by then.
const AUDIO_POOL_SIZE = 16;

// inbound-rtp audioLevel is 0..1 (RFC 6464-style, linear). Speech on a
// conference mix sits well above this; comfort noise and silence sit below.
const ACTIVITY_THRESHOLD = 0.02;
const ACTIVITY_POLL_MS = 250;

export class CallManager {
  private sessions = new Map<SlotId, any>();
  // Reverse lookup so a session's event handlers can tell whether they're
  // still the live occupant of their slot (a slot redialled before the old
  // session's async events settle must not clobber the new call's state).
  private sessionSlot = new Map<any, SlotId>();
  private sessionCallId = new Map<any, string>();
  private audioPool: HTMLAudioElement[] = [];
  private audioEls = new Map<SlotId, HTMLAudioElement>();
  private states: SlotStates = { [ICM_SLOT]: idleSlot() };
  private listeners = new Set<Listener>();
  private activityTimer: number | null = null;

  constructor(private onCallEvent?: (evt: CallEventPayload) => void) {
    for (let i = 0; i < AUDIO_POOL_SIZE; i++) {
      const el = new Audio();
      el.autoplay = true;
      this.audioPool.push(el);
    }
  }

  /** Call from a real user gesture (login/reconnect submit) -see AUDIO_POOL_SIZE. */
  primeAudio(): void {
    for (const el of [...this.audioPool, ...this.audioEls.values()]) {
      el.play().catch((err) => {
        console.warn(`[audio] priming failed (expected if not yet interacted with the page): ${err.message}`);
      });
    }
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    fn({ ...this.states });
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn({ ...this.states });
  }

  getState(slot: SlotId): SlotState {
    return this.states[slot] ?? idleSlot();
  }

  private patch(slot: SlotId, changes: Partial<SlotState>) {
    this.states[slot] = { ...this.getState(slot), ...changes };
    this.emit();
  }

  private audioFor(slot: SlotId): HTMLAudioElement {
    let el = this.audioEls.get(slot);
    if (!el) {
      el = this.audioPool.pop() ?? Object.assign(new Audio(), { autoplay: true });
      this.audioEls.set(slot, el);
    }
    const st = this.getState(slot);
    el.muted = st.listenMuted;
    el.volume = st.volume;
    return el;
  }

  private wireSession(slot: SlotId, session: any, label: string, callMeta: CallMeta, initialMuted = false) {
    this.sessions.set(slot, session);
    this.sessionSlot.set(session, slot);
    const clientCallId = crypto.randomUUID();
    this.sessionCallId.set(session, clientCallId);
    this.patch(slot, { status: 'calling', label, counterpart: callMeta.counterpartExtension, muted: initialMuted, onHold: false, active: false });
    this.onCallEvent?.({ type: 'start', clientCallId, ...callMeta });

    const isLive = () => this.sessionSlot.get(session) === slot && this.sessions.get(slot) === session;

    session.on('progress', () => {
      if (isLive()) this.patch(slot, { status: 'ringing' });
    });
    session.on('confirmed', () => {
      if (!isLive()) return;
      // Applied here (not at dial/answer time) because the local mic track
      // isn't guaranteed to exist on the peer connection until negotiation
      // has actually completed -getUserMedia is async.
      if (initialMuted) this.applyMuteToSession(session, true);
      this.patch(slot, { status: 'connected', connectedAt: Date.now() });
      this.ensureActivityPolling();
    });
    // jssip creates the RTCPeerConnection and emits 'peerconnection'
    // SYNCHRONOUSLY inside ua.call()/session.answer(), before either call
    // returns to us -by the time this function runs, that event has
    // already fired and been missed, every time, on both dial() and
    // answer(). RTCSession does expose the already-created pc via a plain
    // getter, though, and 'track' itself can't have fired yet (it needs a
    // full SDP round trip) -so grab it directly instead of racing the event.
    const pc: RTCPeerConnection | undefined = session.connection;
    const wireTrackListener = (peerconnection: RTCPeerConnection) => {
      peerconnection.addEventListener('track', (event: RTCTrackEvent) => {
        if (!isLive()) return;
        const el = this.audioFor(slot);
        el.srcObject = event.streams[0];
        el.play().catch((err) => {
          console.error(`[audio] playback blocked on ${slot}: ${err.message} -click anywhere on the page and try again`);
        });
      });
    };
    if (pc) {
      wireTrackListener(pc);
    } else {
      // Defensive fallback only -shouldn't happen given jssip's own
      // connect()/answer() always create the pc before returning.
      session.on('peerconnection', ({ peerconnection }: { peerconnection: RTCPeerConnection }) => {
        wireTrackListener(peerconnection);
      });
    }
    // jssip fires 'hold'/'unhold' synchronously and optimistically from
    // within hold()/unhold() itself, before the underlying re-INVITE/UPDATE
    // completes. isOnHold() reports {local, remote} independently, so this
    // reflects either side holding, not just a locally-initiated hold.
    const updateHoldState = () => {
      if (!isLive()) return;
      const { local, remote } = session.isOnHold();
      this.patch(slot, { onHold: local || remote });
    };
    session.on('hold', updateHoldState);
    session.on('unhold', updateHoldState);
    session.on('ended', () => {
      const live = isLive();
      this.sessionSlot.delete(session);
      if (live) this.clear(slot, 'ended');
    });
    session.on('failed', () => {
      const live = isLive();
      this.sessionSlot.delete(session);
      if (live) this.clear(slot, 'failed');
    });
  }

  private clear(slot: SlotId, reason = 'hangup') {
    const session = this.sessions.get(slot);
    if (session) {
      const clientCallId = this.sessionCallId.get(session);
      if (clientCallId) {
        this.onCallEvent?.({ type: 'end', clientCallId, reason });
        this.sessionCallId.delete(session);
      }
    }
    this.sessions.delete(slot);
    // Element goes back to the (already primed) pool for the next slot.
    const el = this.audioEls.get(slot);
    if (el) {
      el.srcObject = null;
      this.audioEls.delete(slot);
      this.audioPool.push(el);
    }
    // Call state resets; listen preferences (volume, listen mute) persist.
    this.patch(slot, { ...IDLE_CALL });
  }

  // Polls inbound audio level for every connected slot -drives the per-slot
  // activity light. getStats rather than a Web Audio AnalyserNode: no
  // AudioContext lifecycle/autoplay issues, and it measures what actually
  // arrived on the wire. Stops itself once nothing is connected.
  private ensureActivityPolling() {
    if (this.activityTimer !== null) return;
    this.activityTimer = window.setInterval(async () => {
      if (this.sessions.size === 0) {
        window.clearInterval(this.activityTimer!);
        this.activityTimer = null;
        return;
      }
      let changed = false;
      for (const [slot, session] of this.sessions) {
        const pc: RTCPeerConnection | undefined = session.connection;
        if (!pc || this.getState(slot).status !== 'connected') continue;
        let level = 0;
        try {
          const stats = await pc.getStats();
          stats.forEach((r: any) => {
            if (r.type === 'inbound-rtp' && r.kind === 'audio' && typeof r.audioLevel === 'number') level = r.audioLevel;
          });
        } catch {
          continue; // pc closed mid-poll
        }
        const active = level > ACTIVITY_THRESHOLD;
        if (this.sessions.get(slot) === session && this.states[slot].active !== active) {
          this.states[slot] = { ...this.states[slot], active };
          changed = true;
        }
      }
      if (changed) this.emit();
    }, ACTIVITY_POLL_MS);
  }

  // Gates the local mic by disabling (not removing) the outgoing audio
  // track -the far end keeps receiving silence rather than the RTP stream
  // dropping, and it's instant to re-enable (no renegotiation needed).
  private applyMuteToSession(session: any, muted: boolean): void {
    const pc: RTCPeerConnection | undefined = session.connection;
    if (!pc) return;
    for (const sender of pc.getSenders()) {
      if (sender.track && sender.track.kind === 'audio') sender.track.enabled = !muted;
    }
  }

  /** Talk side. The latch toggle and hold-to-talk PTT both drive this -see App.tsx's TalkControls. */
  setMuted(slot: SlotId, muted: boolean): void {
    const session = this.sessions.get(slot);
    if (!session) return;
    this.applyMuteToSession(session, muted);
    this.patch(slot, { muted });
  }

  /** Listen side: silences this slot's playback only -nothing goes on the wire. */
  setListenMuted(slot: SlotId, listenMuted: boolean): void {
    const el = this.audioEls.get(slot);
    if (el) el.muted = listenMuted;
    this.patch(slot, { listenMuted });
  }

  setVolume(slot: SlotId, volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    const el = this.audioEls.get(slot);
    if (el) el.volume = v;
    this.patch(slot, { volume: v });
  }

  /** Real SIP hold via re-INVITE, not just local mic gating -pbx-core's
   * reinvite.ts re-anchors it through rtpengine. Only valid once a session is
   * CONFIRMED; jssip's hold()/unhold() harmlessly no-op otherwise. Resulting
   * state is applied via the 'hold'/'unhold' listeners in wireSession. */
  setHold(slot: SlotId, hold: boolean): void {
    const session = this.sessions.get(slot);
    if (!session) return;
    if (hold) session.hold();
    else session.unhold();
  }

  /** Dial out on a slot. Tears down whatever's already there first.
   * `initialMuted` seeds a group's PTT default (see App.tsx) -direct calls
   * never pass this, always starting talking. */
  dial(ua: any, slot: SlotId, target: string, label: string, callMeta: CallMeta, initialMuted = false): void {
    this.hangup(slot);
    const session = ua.call(target, { mediaConstraints: { audio: true, video: false } });
    this.wireSession(slot, session, label, callMeta, initialMuted);
  }

  /** Answer an incoming session on a slot. Tears down whatever's there first. */
  answer(slot: SlotId, session: any, label: string, callMeta: CallMeta): void {
    this.hangup(slot);
    session.answer({ mediaConstraints: { audio: true, video: false } });
    this.wireSession(slot, session, label, callMeta);
  }

  hangup(slot: SlotId): void {
    const s = this.sessions.get(slot);
    if (!s) return;
    this.sessionSlot.delete(s);
    try {
      s.terminate();
    } catch {
      /* already terminating */
    }
    this.clear(slot);
  }

  hangupAll(): void {
    for (const slot of [...this.sessions.keys()]) this.hangup(slot);
  }
}
