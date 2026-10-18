// Client for the shared whisper.cpp whisper-server (POST /inference).
// Requests run one at a time: the server is shared with other projects on
// this host and runs on CPU, so a queue keeps us from piling onto it. A
// failed segment is logged and dropped -transcription is best-effort.
//
// Whisper will happily invent text for audio that isn't speech (noise,
// music, a beep), so every result goes through three gates, in order:
//  1. the segment's own level (RMS) -near-silence is never sent at all;
//  2. whisper's per-segment confidence (verbose_json): a high no_speech_prob
//     or a low avg_logprob is dropped;
//  3. cleanWhisperText(): markers like [Music], prompt echoes, a lone "you",
//     and repetition loops.
// There is deliberately NO prompt by default. Measured 2026-10-18 on this
// whisper-server: with the old prompt, pure noise scored no_speech_prob 0.00
// (so gate 2 could never fire) and live audio came back as an echo of the
// prompt ("welcome to the broadcast production crew"); without it, the same
// noise scored 0.60-0.67. TRANSCRIPT_PROMPT can still opt back in.
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { cleanWhisperText, rms, toWav, SAMPLE_RATE } from './audio';

// Below this RMS a segment is treated as silence and never sent. Same
// threshold as CallRaven.
const SILENCE_RMS = 150;
const FULL_AUDIO_CTX = 1500;
// Gate 2 thresholds. Real speech measured nsp ~0.05 / logprob ~-0.04;
// noise ~0.6-0.8 / -0.3 to -0.5.
const MAX_NO_SPEECH_PROB = 0.5;
const MIN_AVG_LOGPROB = -0.8;

interface WhisperSegment { text: string; no_speech_prob?: number; avg_logprob?: number }

let queue: Promise<unknown> = Promise.resolve();
let debugSeq = 0;

/** `who` (extension, group) only labels the optional debug dump. */
export function transcribe(pcm: Int16Array, who: { extension: string; group: string }): Promise<string | null> {
  if (rms(pcm) < SILENCE_RMS) return Promise.resolve(null);
  const run = queue.then(() => infer(pcm, who), () => infer(pcm, who));
  queue = run.catch(() => undefined);
  return run;
}

async function infer(pcm: Int16Array, who: { extension: string; group: string }): Promise<string | null> {
  const seconds = pcm.length / SAMPLE_RATE;
  const wav = toWav(pcm);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'segment.wav');
  form.append('response_format', 'verbose_json');
  form.append('language', 'en');
  form.append('temperature', '0');
  if (config.prompt) form.append('prompt', config.prompt);
  // Size the encoder to the clip (CallRaven's audioCtxFor): much faster for
  // the short segments live talkback produces.
  form.append('audio_ctx', String(Math.min(FULL_AUDIO_CTX, Math.ceil(seconds * 50) + 64)));
  try {
    const res = await fetch(`${config.whisperUrl}/inference`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json() as { segments?: WhisperSegment[]; text?: string };
    const segments = body.segments ?? [{ text: body.text ?? '' }];
    const kept = segments.filter((s) =>
      (s.no_speech_prob ?? 0) < MAX_NO_SPEECH_PROB && (s.avg_logprob ?? 0) > MIN_AVG_LOGPROB);
    const text = cleanWhisperText(kept.map((s) => s.text).join(' '), config.prompt) || null;
    debugDump(wav, seconds, segments, text, who);
    return text;
  } catch (err) {
    console.error(`[whisper] ${seconds.toFixed(1)}s segment failed: ${(err as Error).message}`);
    return null;
  }
}

// TRANSCRIPT_DEBUG_DIR set: keep each sent segment's audio and whisper's
// verdict (kept or dropped, and why), to trace an odd line back to the
// sound that produced it. This records people's voices: limit it to one
// test extension with TRANSCRIPT_DEBUG_EXT, and clear the directory after.
function debugDump(wav: Buffer, seconds: number, segments: WhisperSegment[], kept: string | null,
  who: { extension: string; group: string }) {
  if (!config.debugDir) return;
  if (config.debugExt && who.extension !== config.debugExt) return;
  try {
    fs.mkdirSync(config.debugDir, { recursive: true });
    const base = path.join(config.debugDir, `${Date.now()}-${debugSeq++}-${who.extension}-${who.group}`);
    fs.writeFileSync(`${base}.wav`, wav);
    fs.writeFileSync(`${base}.json`, JSON.stringify({ ...who, seconds, kept, segments }, null, 2));
  } catch (err) {
    console.error('[whisper] debug dump failed:', (err as Error).message);
  }
}
