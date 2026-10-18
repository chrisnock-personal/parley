// Voice activity detection for one 20 ms frame (320 samples at 16 kHz).
//
// Loudness alone can't tell speech from room noise: an iPad in a noisy room
// showed as "talking" non-stop and fed whisper the noise, which it turned
// into invented text. Speech differs from noise in its spectrum: peaky
// (harmonics, formants) and concentrated in the voice band, where noise is
// flat and broadband. A frame counts as speech when it is
//   loud      RMS > 400 (16-bit),
//   peaky     spectral flatness < 0.1 over 250-4000 Hz,
//   voiced    > 30% of its energy in 300-3400 Hz.
// Thresholds measured 2026-10-18 on CallRaven's sample speech vs synthetic
// white/pink/brown noise and mains hum, at equal loudness: speech showed
// talking 61-67% of the time (vs 59% for loudness alone), every noise 0%
// (vs 100%). Tonal music in the voice range passes this per-frame test;
// segmenter.ts catches it over time by its held pitch (pitch.ts).
import { rms } from './audio';

export const FRAME = 320;
const N = 512;
const SR = 16000;
const LOUD_RMS = 400;
const MAX_FLATNESS = 0.1;
const MIN_VOICE_SHARE = 0.3;

const hann = new Float64Array(FRAME).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
const binHz = SR / N;
const bandLo = Math.ceil(250 / binHz), bandHi = Math.floor(4000 / binHz);
const voiceLo = Math.ceil(300 / binHz), voiceHi = Math.floor(3400 / binHz);
const rev = new Uint16Array(N);
for (let i = 0, bits = Math.log2(N); i < N; i++) {
  let r = 0;
  for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
  rev[i] = r;
}
const cosT = new Float64Array(N / 2).map((_, i) => Math.cos((-2 * Math.PI * i) / N));
const sinT = new Float64Array(N / 2).map((_, i) => Math.sin((-2 * Math.PI * i) / N));
const re = new Float64Array(N), im = new Float64Array(N);

// In-place radix-2 FFT of the windowed, zero-padded frame; returns |X|^2 for
// bins 0..N/2.
function powerSpectrum(frame: Int16Array): Float64Array {
  re.fill(0); im.fill(0);
  for (let i = 0; i < FRAME; i++) re[rev[i]] = frame[i] * hann[i];
  for (let size = 2; size <= N; size *= 2) {
    const half = size / 2, step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const a = start + k, b = a + half, t = k * step;
        const xr = re[b] * cosT[t] - im[b] * sinT[t];
        const xi = re[b] * sinT[t] + im[b] * cosT[t];
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  const p = new Float64Array(N / 2 + 1);
  for (let i = 0; i <= N / 2; i++) p[i] = re[i] * re[i] + im[i] * im[i] + 1e-9;
  return p;
}

export function isSpeechFrame(frame: Int16Array): boolean {
  if (rms(frame) <= LOUD_RMS) return false;
  const p = powerSpectrum(frame);
  let logSum = 0, sum = 0;
  for (let i = bandLo; i <= bandHi; i++) { logSum += Math.log(p[i]); sum += p[i]; }
  const n = bandHi - bandLo + 1;
  const flatness = Math.exp(logSum / n) / (sum / n);
  if (flatness >= MAX_FLATNESS) return false;
  let voice = 0, total = 0;
  for (let i = 0; i < p.length; i++) { total += p[i]; if (i >= voiceLo && i <= voiceHi) voice += p[i]; }
  return voice / total > MIN_VOICE_SHARE;
}
