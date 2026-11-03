// readAloud.ts -reading typed group messages aloud (migration 017).
//
// Which groups: those whose button has read_aloud on (the user's choice,
// stored on the server like favourites) AND that the user has joined right
// now, AND that have chat. Nothing is read for groups you've only starred,
// and never your own messages.
//
// How: the browser's own speech synthesis, played to this listener only.
// Messages are queued (never spoken over each other), the group's audio is
// turned down while one is read, and reading waits while the user holds
// Push To Talk. Voice, speed and volume are per device (voices differ by
// device), kept in localStorage.
//
// New messages are noticed through the 1s participants poll's `latest`
// chat ids, so groups are read even when their Conversation is closed. The
// first time a group becomes eligible (joined + on) we start from its
// current newest message, so history is never read out.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, LatestIds } from './api';

export const TTS_AVAILABLE = typeof window !== 'undefined' && 'speechSynthesis' in window
  && typeof window.SpeechSynthesisUtterance === 'function';

export interface ReadAloudPrefs {
  voiceURI: string | null; // null = the browser's default voice
  rate: number;            // 0.5..2
  volume: number;          // 0..1
  sayWho: boolean;         // "Producer: ..."
  duck: boolean;           // turn the group's audio down while reading
  waitPtt: boolean;        // hold messages while Push To Talk is held
  sayGroup: boolean;       // "Production, Producer: ..." when more than one group is read
}
export const DEFAULT_PREFS: ReadAloudPrefs = {
  voiceURI: null, rate: 1.1, volume: 0.9, sayWho: true, duck: true, waitPtt: true, sayGroup: false,
};
const KEY = 'parley-read-aloud';
export function loadPrefs(): ReadAloudPrefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(p: ReadAloudPrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode: per session only */ }
}

/** Browsers only allow speech after a user gesture; speaking nothing from
 * inside one (turning read-aloud on, a click) unlocks it for the page. */
export function primeSpeech() {
  if (!TTS_AVAILABLE) return;
  try { window.speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* ignore */ }
}

export function speakNow(text: string, prefs: ReadAloudPrefs, onDone?: () => void) {
  if (!TTS_AVAILABLE) { onDone?.(); return; }
  const u = new SpeechSynthesisUtterance(text);
  const voice = prefs.voiceURI ? window.speechSynthesis.getVoices().find((v) => v.voiceURI === prefs.voiceURI) : undefined;
  if (voice) { u.voice = voice; u.lang = voice.lang; }
  u.rate = prefs.rate;
  u.volume = prefs.volume;
  let finished = false;
  const done = () => { if (!finished) { finished = true; window.clearTimeout(watchdog); onDone?.(); } };
  // Some browsers occasionally never fire 'end'; don't let the queue stall.
  const watchdog = window.setTimeout(done, Math.max(8000, (text.length * 120) / prefs.rate));
  u.onend = done;
  u.onerror = done;
  window.speechSynthesis.speak(u);
}

/** The voices this browser offers (they load asynchronously in Chrome). */
export function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (TTS_AVAILABLE ? window.speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (!TTS_AVAILABLE) return;
    const on = () => setVoices(window.speechSynthesis.getVoices());
    window.speechSynthesis.addEventListener('voiceschanged', on);
    on();
    return () => window.speechSynthesis.removeEventListener('voiceschanged', on);
  }, []);
  return voices;
}

function idGt(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  return a.length !== b.length ? a.length > b.length : a > b;
}

interface Item { code: string; group: string; id: string; who: string; text: string; at: number }
export interface Reading { code: string; id: string }

const STALE_MS = 2 * 60 * 1000; // a message still queued after this is dropped, not read late

export function useReadAloud(opts: {
  eligible: { code: string; group: string }[]; // joined, chat on, read_aloud on
  latest: Record<string, LatestIds>;
  selfExt: string;
  prefs: ReadAloudPrefs;
  isPttHeld: () => boolean;
  duck: (code: string, on: boolean) => void;
}) {
  const { eligible, latest, selfExt } = opts;
  const prefsRef = useRef(opts.prefs);
  prefsRef.current = opts.prefs;
  const pttRef = useRef(opts.isPttHeld);
  pttRef.current = opts.isPttHeld;
  const duckRef = useRef(opts.duck);
  duckRef.current = opts.duck;
  const eligibleRef = useRef(eligible);
  eligibleRef.current = eligible;

  const lastId = useRef<Record<string, string>>({});
  const fetching = useRef(new Set<string>());
  const queue = useRef<Item[]>([]);
  const readingRef = useRef<Item | null>(null);
  const retry = useRef<number | null>(null);
  const [, setTick] = useState(0);
  const rerender = () => setTick((t) => t + 1);

  const pump = useCallback(() => {
    if (readingRef.current || !TTS_AVAILABLE) return;
    if (retry.current !== null) { window.clearTimeout(retry.current); retry.current = null; }
    const now = Date.now();
    queue.current = queue.current.filter((m) => now - m.at < STALE_MS);
    if (!queue.current.length) { rerender(); return; }
    const p = prefsRef.current;
    if (p.waitPtt && pttRef.current()) { retry.current = window.setTimeout(pump, 300); rerender(); return; }
    const item = queue.current.shift()!;
    readingRef.current = item;
    rerender();
    const several = eligibleRef.current.length > 1;
    const text = `${p.sayGroup && several ? `${item.group}, ` : ''}${p.sayWho ? `${item.who}: ` : ''}${item.text}`;
    if (p.duck) duckRef.current(item.code, true);
    speakNow(text, p, () => {
      duckRef.current(item.code, false);
      readingRef.current = null;
      rerender();
      pump();
    });
  }, []);

  // Track eligibility and pick up new messages from the poll's newest ids.
  const key = eligible.map((e) => e.code).join(',');
  useEffect(() => {
    const codes = new Set(eligible.map((e) => e.code));
    // Groups no longer eligible (left, or switched off): forget them.
    for (const code of Object.keys(lastId.current)) {
      if (codes.has(code)) continue;
      delete lastId.current[code];
      queue.current = queue.current.filter((m) => m.code !== code);
      if (readingRef.current?.code === code) window.speechSynthesis.cancel();
    }
    for (const e of eligible) {
      const l = latest[e.code];
      if (!l) continue; // poll hasn't reported this group yet
      if (!(e.code in lastId.current)) { lastId.current[e.code] = l.chat ?? '0'; continue; } // start from now
      if (!idGt(l.chat, lastId.current[e.code]) || fetching.current.has(e.code)) continue;
      fetching.current.add(e.code);
      api.groupChat(e.code, lastId.current[e.code])
        .then((r) => {
          if (!(e.code in lastId.current)) return; // left while fetching
          for (const m of r.messages) {
            lastId.current[e.code] = m.id;
            if (m.author_extension === selfExt) continue;
            queue.current.push({ code: e.code, group: e.group, id: m.id, who: m.author_name || m.author_extension, text: m.body, at: Date.now() });
          }
          pump();
        })
        .catch(() => { /* try again on the next poll */ })
        .finally(() => fetching.current.delete(e.code));
    }
  }, [key, latest, selfExt, pump]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (TTS_AVAILABLE) window.speechSynthesis.cancel(); }, []);

  const waiting: Record<string, number> = {};
  for (const m of queue.current) waiting[m.code] = (waiting[m.code] ?? 0) + 1;
  const reading: Reading | null = readingRef.current ? { code: readingRef.current.code, id: readingRef.current.id } : null;

  /** Skip the message being read (the next one follows). */
  const skip = useCallback(() => { if (TTS_AVAILABLE) window.speechSynthesis.cancel(); }, []);
  /** Drop everything waiting for this group, and stop it if it's being read. */
  const stop = useCallback((code: string) => {
    queue.current = queue.current.filter((m) => m.code !== code);
    if (readingRef.current?.code === code) window.speechSynthesis.cancel();
    rerender();
  }, []);

  return { reading, waiting, skip, stop };
}
