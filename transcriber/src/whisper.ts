// Client for the shared whisper.cpp whisper-server (POST /inference).
// Requests run one at a time: the server is shared with other projects on
// this host and runs on CPU, so a queue keeps us from piling onto it. A
// failed segment is logged and dropped -transcription is best-effort.
import { config } from './config';
import { cleanWhisperText, rms, toWav, SAMPLE_RATE } from './audio';

// Below this RMS a segment is treated as silence and never sent (whisper
// invents text for near-silence). Same threshold as CallRaven.
const SILENCE_RMS = 150;
const FULL_AUDIO_CTX = 1500;

let queue: Promise<unknown> = Promise.resolve();

export function transcribe(pcm: Int16Array): Promise<string | null> {
  if (rms(pcm) < SILENCE_RMS) return Promise.resolve(null);
  const run = queue.then(() => infer(pcm), () => infer(pcm));
  queue = run.catch(() => undefined);
  return run;
}

async function infer(pcm: Int16Array): Promise<string | null> {
  const seconds = pcm.length / SAMPLE_RATE;
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(toWav(pcm))], { type: 'audio/wav' }), 'segment.wav');
  form.append('response_format', 'text');
  form.append('language', 'en');
  form.append('temperature', '0');
  form.append('prompt', config.prompt);
  // Size the encoder to the clip (CallRaven's audioCtxFor): much faster for
  // the short segments live talkback produces.
  form.append('audio_ctx', String(Math.min(FULL_AUDIO_CTX, Math.ceil(seconds * 50) + 64)));
  try {
    const res = await fetch(`${config.whisperUrl}/inference`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return cleanWhisperText(await res.text(), config.prompt) || null;
  } catch (err) {
    console.error(`[whisper] ${seconds.toFixed(1)}s segment failed: ${(err as Error).message}`);
    return null;
  }
}
