// One group member's voice, tapped from rtpengine and cut into utterances.
//
// rtpengine's "subscribe request" for the member's own leg (their From tag)
// hands us a copy of what they SEND -just their voice, never the group mix
// -already decrypted from the browser's DTLS-SRTP. The subscription only
// offers the codec the leg actually uses -browser legs into a group
// usually settle on G.722 (FreeSWITCH's pick) -and we take it as-is:
// rtpengine 10.5 rejects any subscription answer that would need
// transcoding ("Failed to process subscription answer"; pass-through
// works), so we decode Opus, G.722 (g722.ts) and G.711 ourselves, all to
// 16 kHz. We answer with a local UDP port and that codec, then segment on
// pauses: a segment ends after `pauseMs` of
// quiet following speech, or at `maxSegmentMs`. Muted (PTT) members send
// silence, which never forms a segment, so they cost nothing.
import dgram from 'dgram';
import { Decoder } from '@evan/opus';
import Client from 'rtpengine-client';
import { config } from './config';
import { g711To16k, rms, SAMPLE_RATE } from './audio';
import { G722Decoder } from './g722';

const ng = new (Client as any).Client();

const FRAME_MS = 20;
const FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1000;
const SPEECH_FRAME_RMS = 400;   // a 20 ms frame louder than this counts as speech
const PREROLL_FRAMES = 15;      // keep 300 ms before speech starts, so first syllables aren't clipped

type Codec = { pt: number; kind: 'opus' | 'g722' | 'pcmu' | 'pcma'; rtpmap: string };

export interface Utterance { pcm: Int16Array; spokenAt: Date }

function pickCodec(offer: string): Codec | null {
  const rtpmaps = [...offer.matchAll(/^a=rtpmap:(\d+) ([^\r\n]+)/gm)].map((m) => ({ pt: +m[1], name: m[2] }));
  const opus = rtpmaps.find((r) => /^opus\/48000/i.test(r.name));
  if (opus) return { pt: opus.pt, kind: 'opus', rtpmap: opus.name };
  const offered = offer.match(/^m=audio \d+ \S+ ([\d ]+)/m)?.[1].split(' ').map(Number) ?? [];
  if (offered.includes(9)) return { pt: 9, kind: 'g722', rtpmap: 'G722/8000' };
  if (offered.includes(0)) return { pt: 0, kind: 'pcmu', rtpmap: 'PCMU/8000' };
  if (offered.includes(8)) return { pt: 8, kind: 'pcma', rtpmap: 'PCMA/8000' };
  return null;
}

export class MemberTap {
  private sock = dgram.createSocket('udp4');
  private toTag: string | null = null;
  private codec: Codec | null = null;
  private opus: Decoder | null = null;
  private g722: G722Decoder | null = null;
  private frames: Int16Array[] = [];   // current segment (incl. pre-roll)
  private pending = new Int16Array(0); // samples not yet making up a whole frame
  private speechFrames = 0;
  private quietFrames = 0;
  private segmentStart: Date | null = null;
  private stopped = false;

  constructor(
    readonly callId: string,
    private readonly tag: string,
    private readonly onUtterance: (u: Utterance) => void,
  ) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.sock.bind(0, config.mediaIp, resolve));
    const port = this.sock.address().port;

    const req = await ng.subscribeRequest(config.rtpengine.port, config.rtpengine.host, {
      'call-id': this.callId, 'from-tags': [this.tag],
      ICE: 'remove', 'transport-protocol': 'RTP/AVP', 'rtcp-mux': ['demux'],
    });
    if (req.result !== 'ok') throw new Error(`subscribe request: ${req['error-reason'] || req.result}`);
    this.toTag = req['to-tag'];
    this.codec = pickCodec(req.sdp);
    if (!this.codec) throw new Error(`no Opus, G.722 or G.711 on offer: ${req.sdp.match(/^m=.*$/m)?.[0]}`);
    if (this.codec.kind === 'opus') this.opus = new Decoder({ channels: 1, sample_rate: SAMPLE_RATE });
    if (this.codec.kind === 'g722') this.g722 = new G722Decoder();

    // The answer must also accept telephone-event when it's on offer: rtpengine
    // treats dropping it as a change it can't make on a subscription and
    // rejects the whole answer. Its packets are ignored on receipt (onRtp).
    const dtmf = req.sdp.match(/^a=rtpmap:(\d+) (telephone-event\/\d+)/m);
    const dtmfFmtp = dtmf && req.sdp.match(new RegExp(`^a=fmtp:${dtmf[1]} [^\r\n]+`, 'm'));
    const answer = [
      'v=0', `o=- ${Date.now()} 1 IN IP4 ${config.mediaIp}`, 's=transcriber', `c=IN IP4 ${config.mediaIp}`, 't=0 0',
      `m=audio ${port} RTP/AVP ${this.codec.pt}${dtmf ? ` ${dtmf[1]}` : ''}`,
      `a=rtpmap:${this.codec.pt} ${this.codec.rtpmap}`,
      ...(dtmf ? [`a=rtpmap:${dtmf[1]} ${dtmf[2]}`, ...(dtmfFmtp ? [dtmfFmtp[0]] : [])] : []),
      'a=recvonly', '',
    ].join('\r\n');
    const ans = await ng.subscribeAnswer(config.rtpengine.port, config.rtpengine.host, {
      'call-id': this.callId, 'to-tag': this.toTag, sdp: answer,
    });
    if (ans.result !== 'ok') throw new Error(`subscribe answer: ${ans['error-reason'] || ans.result}`);

    this.sock.on('message', (msg) => this.onRtp(msg));
  }

  private onRtp(msg: Buffer) {
    if (this.stopped || msg.length < 12 || (msg[0] >> 6) !== 2) return;
    const pt = msg[1] & 0x7f;
    if (!this.codec || pt !== this.codec.pt) return; // RTCP, telephone-event, comfort noise...
    let offset = 12 + (msg[0] & 0x0f) * 4;
    if (msg[0] & 0x10) offset += 4 + msg.readUInt16BE(offset + 2) * 4; // header extension
    const payload = msg.subarray(offset);
    if (!payload.length) return;

    let pcm: Int16Array;
    try {
      if (this.opus) {
        const out = this.opus.decode(payload);
        pcm = new Int16Array(out.buffer, out.byteOffset, out.byteLength >> 1).slice();
      } else if (this.g722) {
        pcm = this.g722.decode(payload);
      } else {
        pcm = g711To16k(payload, this.codec.kind === 'pcma');
      }
    } catch {
      return; // a corrupt packet -skip it
    }
    this.push(pcm);
  }

  private push(samples: Int16Array) {
    const buf = new Int16Array(this.pending.length + samples.length);
    buf.set(this.pending); buf.set(samples, this.pending.length);
    let i = 0;
    for (; i + FRAME_SAMPLES <= buf.length; i += FRAME_SAMPLES) this.frame(buf.slice(i, i + FRAME_SAMPLES));
    this.pending = buf.slice(i);
  }

  private frame(f: Int16Array) {
    const speech = rms(f) > SPEECH_FRAME_RMS;
    this.frames.push(f);
    if (speech) {
      if (!this.speechFrames) this.segmentStart = new Date(Date.now() - (this.frames.length - 1) * FRAME_MS);
      this.speechFrames++;
      this.quietFrames = 0;
    } else if (this.speechFrames) {
      this.quietFrames++;
    }

    if (!this.speechFrames) {
      // No speech yet: keep only the pre-roll.
      if (this.frames.length > PREROLL_FRAMES) this.frames.shift();
      return;
    }
    const total = this.frames.length * FRAME_MS;
    if (this.quietFrames * FRAME_MS >= config.pauseMs || total >= config.maxSegmentMs) this.flush();
  }

  private flush() {
    if (this.speechFrames >= 10) { // at least 200 ms of speech, or it's a click
      const pcm = new Int16Array(this.frames.length * FRAME_SAMPLES);
      this.frames.forEach((f, k) => pcm.set(f, k * FRAME_SAMPLES));
      this.onUtterance({ pcm, spokenAt: this.segmentStart ?? new Date() });
    }
    this.frames = [];
    this.speechFrames = 0;
    this.quietFrames = 0;
    this.segmentStart = null;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.speechFrames) this.flush();
    this.sock.close();
    if (this.toTag) {
      try {
        await ng.unsubscribe(config.rtpengine.port, config.rtpengine.host, { 'call-id': this.callId, 'to-tag': this.toTag });
      } catch { /* the call may already be gone */ }
    }
  }
}
