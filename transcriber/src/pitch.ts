// Pitch (F0) of a voiced stretch, for telling speech from music.
//
// vad.ts judges one 20 ms frame at a time, and one frame of a musical note
// looks just like a voiced syllable: loud, peaky, in the voice band. The
// difference shows over time. A note holds its pitch dead steady, then
// jumps to the next; a voice's pitch is always gliding (intonation), even
// within a syllable. So segmenter.ts tracks, over the last second, how often
// the pitch from one frame to the next stays within 0.3%.
//
// Measured 2026-10-18 on 1 s windows (median), CallRaven's sample prompts,
// flite and espeak-ng voices vs 13 GNOME/Steam tunes (bells, guitar, piano,
// synths): speech 5-22% steady (22% is flite's monotone "slt" voice), speech
// over music at -10 dB 13-30%, music 45-98%.

const SR = 16000;
const MIN_LAG = Math.floor(SR / 500); // 500 Hz
const MAX_LAG = Math.ceil(SR / 60);   // 60 Hz
/** Samples examined: two 20 ms frames, enough for a 60 Hz period twice over. */
export const PITCH_WINDOW = 640;
/** Below this autocorrelation peak the stretch isn't periodic enough to have a pitch. */
export const MIN_PERIODICITY = 0.5;

const R = new Float64Array(MAX_LAG + 2);

/** Normalised-autocorrelation pitch of `x` (PITCH_WINDOW samples), refined
 * between lags by a parabola through the peak: at 16 kHz a whole-sample lag
 * step is already ~1% for a 200 Hz voice, too coarse for the 0.3% test. */
export function pitchOf(x: Int16Array): { f0: number; periodicity: number } {
  const n = x.length;
  let best = 0, lag = MIN_LAG;
  for (let L = MIN_LAG - 1; L <= MAX_LAG + 1; L++) {
    let ab = 0, aa = 0, bb = 0;
    for (let i = L; i < n; i++) { const a = x[i], b = x[i - L]; ab += a * b; aa += a * a; bb += b * b; }
    R[L] = ab / Math.sqrt(aa * bb + 1);
    if (L >= MIN_LAG && L <= MAX_LAG && R[L] > best) { best = R[L]; lag = L; }
  }
  const a = R[lag - 1], b = R[lag], c = R[lag + 1], d = a - 2 * b + c;
  const frac = d < 0 ? (0.5 * (a - c)) / d : 0;
  return { f0: SR / (lag + frac), periodicity: best };
}
