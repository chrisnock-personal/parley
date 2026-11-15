// One member's decoded voice (16 kHz PCM) -> speech decisions and
// utterances. Pure: no sockets or rtpengine, so the same code runs live in
// tap.ts and offline against test recordings.
//
// Speech is decided per frame by vad.ts (loud AND speech-shaped spectrum),
// then smoothed: speaking = at least SPEECH_MIN of the last SPEECH_WINDOW
// frames were speech. That drives who's-talking, and STARTS a transcript
// segment, so room noise neither lights the talking ring nor reaches
// whisper. Once started, a segment CONTINUES while there is sound (RMS above
// SOUND_RMS) and ends on pauseMs of real quiet: the VAD alone flags only
// ~40% of frames inside speech (consonants, breaths), so ending on it cut
// sentences apart and lost words between pieces.
//
// Music: tonal music passes vad.ts frame by frame, so on top of that the
// last second is checked for held pitch (pitch.ts): the share of its voiced
// frame-to-frame steps that keep the pitch within PITCH_STEADY. Two
// thresholds, because the two uses fail differently:
//  * who's-talking uses the sensitive one (RING_MUSIC_SHARE): a ring lit by
//    music is the visible problem, and briefly missing the ring is harmless;
//  * transcription only drops sound that is clearly music
//    (SEGMENT_MUSIC_SHARE: bells, pads, held notes). At the sensitive level,
//    a flat voice over background music lost its first ~2 s (the window
//    still held the music before it), and whisper's own gates already turn
//    borderline music into no text, so borderline sound is left to them.
import { rms, SAMPLE_RATE } from './audio';
import { isSpeechFrame } from './vad';
import { MIN_PERIODICITY, PITCH_WINDOW, pitchOf } from './pitch';

export const FRAME_MS = 20;
const FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000;
const SPEECH_WINDOW = 15;      // 300 ms
const SPEECH_MIN = 5;
const SOUND_RMS = 250;
// Keep 500 ms before speech is detected, so first syllables aren't clipped.
// Detection fires on voiced, speech-shaped frames, so an unvoiced opening
// ("St-" of "Stand by") is already behind it; 300 ms didn't reach back far
// enough on a live G.722 leg ("Tanned by", issue #3).
const PREROLL_FRAMES = 25;
const SPLIT_SEARCH_FRAMES = 75; // a segment cut at maxSegmentMs ends at the quietest frame in its last 1.5 s
const MIN_SPEECH_FRAMES = 25;  // at least 500 ms of speech: shorter bursts are clicks, coughs, or fragments whisper garbles
const MUSIC_WINDOW = 50;       // 1 s of frame-to-frame pitch steps
const MUSIC_MIN_STEPS = 5;     // need this many voiced steps in the window to judge
const PITCH_STEADY = 0.003;    // a step within 0.3% counts as held pitch
const RING_MUSIC_SHARE = 0.38;    // speech measured 5-30%, music 45-98% (pitch.ts)
const SEGMENT_MUSIC_SHARE = 0.6;  // clearly music only

export interface Utterance { pcm: Int16Array; spokenAt: Date }

export interface SegmenterOptions { pauseMs: number; maxSegmentMs: number }

export class Segmenter {
  private frames: Int16Array[] = [];   // current segment (incl. pre-roll)
  private pending = new Int16Array(0); // samples not yet making up a whole frame
  private speechFrames = 0;
  private recent: boolean[] = [];      // last SPEECH_WINDOW per-frame VAD results
  private prevFrame: Int16Array = new Int16Array(FRAME_SAMPLES);
  private prevF0: number | null = null; // pitch of the previous frame, if it was voiced
  private steps: (boolean | null)[] = []; // last MUSIC_WINDOW frames: pitch held (true), moved (false), no pitch (null)
  private quietFrames = 0;
  private segmentStart: Date | null = null;
  /** Wall clock of the last smoothed-speech frame: drives who's-talking. */
  lastSpeechAt = 0;

  constructor(
    private readonly opts: SegmenterOptions,
    private readonly onUtterance: (u: Utterance) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Feed decoded samples (any length). */
  push(samples: Int16Array) {
    const buf = new Int16Array(this.pending.length + samples.length);
    buf.set(this.pending); buf.set(samples, this.pending.length);
    let i = 0;
    for (; i + FRAME_SAMPLES <= buf.length; i += FRAME_SAMPLES) this.frame(buf.slice(i, i + FRAME_SAMPLES));
    this.pending = buf.slice(i);
  }

  /** End of input: send whatever speech is in progress. */
  finish() {
    if (this.speechFrames) this.flush(this.frames.length);
  }

  private frame(f: Int16Array) {
    const voiced = isSpeechFrame(f);
    this.recent.push(voiced);
    if (this.recent.length > SPEECH_WINDOW) this.recent.shift();
    const steady = this.steadyShare(f, voiced); // null: too few pitch steps to judge yet
    const voiceLike = this.recent.filter(Boolean).length >= SPEECH_MIN;
    // The ring waits for a verdict (~100 ms); transcription doesn't, since
    // the segment's pre-roll would cover it anyway.
    if (voiceLike && steady !== null && steady <= RING_MUSIC_SHARE) this.lastSpeechAt = this.now();
    const music = steady !== null && steady > SEGMENT_MUSIC_SHARE;
    const speech = voiceLike && !music;
    this.frames.push(f);

    if (!this.speechFrames) {
      if (!speech) {
        // Not in a segment: keep only the pre-roll.
        if (this.frames.length > PREROLL_FRAMES) this.frames.shift();
        return;
      }
      this.segmentStart = new Date(this.now() - (this.frames.length - 1) * FRAME_MS);
    }
    if (speech) this.speechFrames++;
    this.quietFrames = speech || (!music && rms(f) > SOUND_RMS) ? 0 : this.quietFrames + 1;

    if (this.quietFrames * FRAME_MS >= this.opts.pauseMs) this.flush(this.frames.length);
    else if (this.frames.length * FRAME_MS >= this.opts.maxSegmentMs) this.flush(this.splitPoint());
  }

  /** Records this frame's pitch step; returns the share of the last
   * second's voiced steps that held their pitch, or null when there were
   * too few to judge. */
  private steadyShare(f: Int16Array, voiced: boolean): number | null {
    let step: boolean | null = null;
    let f0: number | null = null;
    if (voiced) {
      const win = new Int16Array(PITCH_WINDOW);
      win.set(this.prevFrame.subarray(FRAME_SAMPLES - (PITCH_WINDOW - FRAME_SAMPLES)));
      win.set(f, PITCH_WINDOW - FRAME_SAMPLES);
      const p = pitchOf(win);
      if (p.periodicity >= MIN_PERIODICITY) f0 = p.f0;
      if (f0 !== null && this.prevF0 !== null) step = Math.abs(f0 - this.prevF0) / this.prevF0 < PITCH_STEADY;
    }
    this.prevF0 = f0;
    this.prevFrame = f;
    this.steps.push(step);
    if (this.steps.length > MUSIC_WINDOW) this.steps.shift();
    let judged = 0, held = 0;
    for (const s of this.steps) if (s !== null) { judged++; if (s) held++; }
    // No hold-over once it stops sounding like music: tried (300 ms, 1 s), and
    // it cut words from a monotone speaker more than it stopped music.
    return judged >= MUSIC_MIN_STEPS ? held / judged : null;
  }

  // Where to cut a segment that hit maxSegmentMs: the quietest frame in its
  // last 1.5 s, so a word in progress isn't cut in half (ported from
  // CallRaven's liveTranscribe.js findSplitPoint). Frames after it carry
  // into the next segment.
  private splitPoint(): number {
    let best = this.frames.length, bestEnergy = Infinity;
    for (let k = Math.max(1, this.frames.length - SPLIT_SEARCH_FRAMES); k < this.frames.length; k++) {
      const e = rms(this.frames[k]);
      if (e < bestEnergy) { bestEnergy = e; best = k + 1; }
    }
    return best;
  }

  /** Send frames[0..cut) as an utterance; anything after `cut` starts the
   * next segment (carried over by a max-length split). */
  private flush(cut: number) {
    const sent = this.frames.slice(0, cut);
    const carry = this.frames.slice(cut);
    if (this.speechFrames >= MIN_SPEECH_FRAMES) {
      const pcm = new Int16Array(sent.length * FRAME_SAMPLES);
      sent.forEach((f, k) => pcm.set(f, k * FRAME_SAMPLES));
      this.onUtterance({ pcm, spokenAt: this.segmentStart ?? new Date(this.now()) });
    }
    this.frames = carry;
    this.speechFrames = carry.length ? 1 : 0; // a carried-over tail is mid-speech by construction
    this.quietFrames = 0;
    this.segmentStart = carry.length ? new Date(this.now() - carry.length * FRAME_MS) : null;
  }
}
