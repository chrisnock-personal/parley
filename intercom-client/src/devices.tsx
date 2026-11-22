// Microphone and speaker choice (issue #7), in the profile menu. Per browser
// (localStorage): device ids differ between machines, so each computer, iPad
// or phone keeps its own. CallManager applies the choice to new calls and
// to calls already up (calls.ts setMic/setSpeaker).
//
// Speakers need HTMLMediaElement.setSinkId. Where the browser hasn't got it
// (Safari on iPad and iPhone), the picker is replaced by a pointer to the
// device's own output choice.
import { useEffect, useRef, useState } from 'react';

export interface DevicePrefs { micId: string | null; speakerId: string | null }

const KEY = 'parley-devices';

export function loadDevicePrefs(): DevicePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<DevicePrefs>;
      return { micId: p.micId ?? null, speakerId: p.speakerId ?? null };
    }
  } catch { /* private window, blocked storage: defaults */ }
  return { micId: null, speakerId: null };
}

export function saveDevicePrefs(p: DevicePrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* not saved: still applies this session */ }
}

export const CAN_PICK_SPEAKER = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/** Two short tones through the chosen speakers. */
async function playTestSound(speakerId: string | null) {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const gain = ctx.createGain();
  gain.gain.value = 0.2;
  gain.connect(dest);
  [0, 0.35].forEach((at, i) => {
    const osc = ctx.createOscillator();
    osc.frequency.value = i ? 660 : 880;
    osc.connect(gain);
    osc.start(ctx.currentTime + at);
    osc.stop(ctx.currentTime + at + 0.25);
  });
  const el = new Audio() as SinkAudio;
  if (speakerId && el.setSinkId) await el.setSinkId(speakerId).catch(() => undefined);
  el.srcObject = dest.stream;
  await el.play().catch(() => undefined);
  window.setTimeout(() => { el.srcObject = null; void ctx.close(); }, 900);
}

async function micPermitted(): Promise<boolean> {
  try {
    const st = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return st.state === 'granted';
  } catch {
    return false; // Firefox and older Safari can't be asked: wait for the button
  }
}

export function DeviceSettings({ prefs, onChange }: { prefs: DevicePrefs; onChange: (p: DevicePrefs) => void }) {
  const [started, setStarted] = useState(false);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // Only start by ourselves if the browser already lets us use the mic, so
  // opening the profile menu never pops up a permission prompt.
  useEffect(() => { void micPermitted().then((ok) => { if (ok) setStarted(true); }); }, []);

  // While open: a preview of the chosen mic for the level bar, and the
  // device lists (their names only appear once the mic is allowed).
  useEffect(() => {
    if (!started || !navigator.mediaDevices) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let stopped = false;
    const list = async () => {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (stopped) return;
      setMics(all.filter((d) => d.kind === 'audioinput'));
      setSpeakers(all.filter((d) => d.kind === 'audiooutput'));
    };
    (async () => {
      try {
        // exact (Chromium ignores ideal), falling back to the default when
        // the chosen mic isn't plugged in.
        stream = prefs.micId
          ? await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: prefs.micId } }, video: false })
            .catch(() => navigator.mediaDevices.getUserMedia({ audio: true, video: false }))
          : await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        setError(null);
        await list();
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          // Decibels, like a level meter: -60 dBFS empty, 0 dBFS full, so
          // ordinary speech (around -30 to -15) fills half or more.
          const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-6);
          setLevel(Math.min(1, Math.max(0, (db + 60) / 60)));
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (err) {
        setError(`Can't use the microphone: ${(err as Error).message}`);
      }
    })();
    navigator.mediaDevices.addEventListener('devicechange', list);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      navigator.mediaDevices.removeEventListener('devicechange', list);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
  }, [started, prefs.micId]);

  const label = (d: MediaDeviceInfo, i: number, what: string) => d.label || `${what} ${i + 1}`;

  return (
    <div className="ra-settings dev-settings">
      <div className="ra-settings-head">Microphone and speakers</div>
      <div className="dim ra-help">For this browser. Check them before you go live.</div>
      {!started ? (
        <button onClick={() => setStarted(true)}>Show my devices</button>
      ) : (
        <>
          {error && <div className="login-error">{error}</div>}
          <label className="ra-field">Microphone
            <select value={prefs.micId ?? ''} onChange={(e) => onChange({ ...prefsRef.current, micId: e.target.value || null })}>
              <option value="">This browser's default</option>
              {mics.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i, 'Microphone')}</option>)}
            </select>
          </label>
          <div className="dev-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
            <i style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          <div className="dim ra-help">Speak: the bar should move.</div>
          {CAN_PICK_SPEAKER ? (
            <label className="ra-field">Speakers
              <select value={prefs.speakerId ?? ''} onChange={(e) => onChange({ ...prefsRef.current, speakerId: e.target.value || null })}>
                <option value="">This browser's default</option>
                {speakers.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i, 'Speakers')}</option>)}
              </select>
            </label>
          ) : (
            <div className="ra-field">Speakers
              <span className="dim ra-help">This browser plays through the device's own output: choose it in Control Centre (headphones, AirPlay).</span>
            </div>
          )}
          <button onClick={() => void playTestSound(prefs.speakerId)}>Play a test sound</button>
          <div className="dim ra-help">Saved in this browser, so each device keeps its own. A change moves calls you're in at once.</div>
        </>
      )}
    </div>
  );
}
