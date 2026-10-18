// Audio helpers: G.711 decode, 8k->16k upsampling, level measurement, WAV
// framing, and whisper output cleanup. Everything is 16 kHz mono 16-bit PCM
// by the time it reaches whisper (what whisper.cpp expects).

export const SAMPLE_RATE = 16000;

function buildTable(decode: (u: number) => number): Int16Array {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) t[i] = decode(i);
  return t;
}

const ULAW = buildTable((u) => {
  u = ~u & 0xff;
  const sign = u & 0x80, exp = (u >> 4) & 0x07, mant = u & 0x0f;
  const x = (((mant << 3) + 0x84) << exp) - 0x84;
  return sign ? -x : x;
});

const ALAW = buildTable((a) => {
  a ^= 0x55;
  const sign = a & 0x80, exp = (a >> 4) & 0x07, mant = a & 0x0f;
  let x = exp === 0 ? (mant << 4) + 8 : ((mant << 4) + 0x108) << (exp - 1);
  return sign ? x : -x;
});

/** G.711 (PCMU/PCMA, 8 kHz) payload -> 16 kHz PCM, linear-interpolated. */
export function g711To16k(payload: Buffer, alaw: boolean): Int16Array {
  const table = alaw ? ALAW : ULAW;
  const out = new Int16Array(payload.length * 2);
  for (let i = 0; i < payload.length; i++) {
    const cur = table[payload[i]];
    const next = i + 1 < payload.length ? table[payload[i + 1]] : cur;
    out[2 * i] = cur;
    out[2 * i + 1] = (cur + next) >> 1;
  }
  return out;
}

export function rms(pcm: Int16Array, from = 0, to = pcm.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += pcm[i] * pcm[i];
  return to > from ? Math.sqrt(sum / (to - from)) : 0;
}

export function toWav(pcm: Int16Array): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(SAMPLE_RATE, 24); hdr.writeUInt32LE(SAMPLE_RATE * 2, 28);
  hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  return Buffer.concat([hdr, data]);
}

// What whisper writes for no speech, which isn't speech (extended from
// CallRaven's liveTranscribe.js): its markers in any case ([BLANK_AUDIO],
// [Music], (applause), *laughs*, music notes), a segment that's only its
// prompt's words (it echoes the prompt over near-silence), a lone "you",
// and repetition loops ("No points. No points. No points." -whisper's
// signature failure on poor audio).
export function cleanWhisperText(text: string, prompt: string): string {
  const t = String(text || '')
    .replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\*[^*]*\*/g, ' ').replace(/[♪♫]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const words = t.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(' ').filter(Boolean);
  if (!words.length) return '';
  const promptWords = new Set(prompt.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(' ').filter(Boolean));
  if (words.every((w) => promptWords.has(w) || w === 'you')) return '';
  if (isRepetitionLoop(words)) return '';
  return t;
}

// A 2-4 word phrase three or more times in a row, or one word four or more
// times. A single word three times is real talkback ("go go go").
function isRepetitionLoop(words: string[]): boolean {
  for (let n = 1; n <= 4; n++) {
    const times = n === 1 ? 4 : 3;
    for (let i = 0; i + times * n <= words.length; i++) {
      const a = words.slice(i, i + n).join(' ');
      let all = true;
      for (let k = 1; k < times && all; k++) all = words.slice(i + k * n, i + (k + 1) * n).join(' ') === a;
      if (all) return true;
    }
  }
  return false;
}
