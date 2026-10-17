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

// What whisper writes for no speech, which isn't speech (ported from
// CallRaven's liveTranscribe.js): its markers ([BLANK_AUDIO], [MUSIC]), a
// segment that's only its prompt's words (it echoes the prompt over
// near-silence), or a lone "you".
export function cleanWhisperText(text: string, prompt: string): string {
  const t = String(text || '').replace(/\[[A-Z][A-Z _]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const words = t.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(' ').filter(Boolean);
  if (!words.length) return '';
  const promptWords = new Set(prompt.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(' ').filter(Boolean));
  if (words.every((w) => promptWords.has(w) || w === 'you')) return '';
  return t;
}
