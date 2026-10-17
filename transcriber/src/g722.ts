// ITU-T G.722 decoder (64 kbit/s mode): sub-band ADPCM -> 16 kHz PCM.
//
// Needed because browser legs into a group usually settle on G.722
// (FreeSWITCH's pick), and rtpengine 10.5 can't transcode a subscription's
// media for us -so the transcriber decodes it itself. The algorithm follows
// the ITU-T reference (blocks 1L-6L / 1H-6H and the QMF synthesis), as in the
// widely used public-domain C implementation. Verified sample-for-sample
// against ffmpeg's decoder (see CLAUDE.md, 2026-10-17).

const QM2 = [-7408, -1616, 7408, 1616];
const QM4 = [0, -20456, -12896, -8968, -6288, -4240, -2584, -1200, 20456, 12896, 8968, 6288, 4240, 2584, 1200, 0];
const QM6 = [
  -136, -136, -136, -136, -24808, -21904, -19008, -16704, -14984, -13512, -12280, -11192, -10232, -9360, -8576, -7856,
  -7192, -6576, -6000, -5456, -4944, -4464, -4008, -3576, -3168, -2776, -2400, -2032, -1688, -1360, -1040, -728,
  24808, 21904, 19008, 16704, 14984, 13512, 12280, 11192, 10232, 9360, 8576, 7856, 7192, 6576, 6000, 5456,
  4944, 4464, 4008, 3576, 3168, 2776, 2400, 2032, 1688, 1360, 1040, 728, 432, 136, -432, -136,
];
const WL = [-60, -30, 58, 172, 334, 538, 1198, 3042];
const RL42 = [0, 7, 6, 5, 4, 3, 2, 1, 7, 6, 5, 4, 3, 2, 1, 0];
const ILB = [
  2048, 2093, 2139, 2186, 2233, 2282, 2332, 2383, 2435, 2489, 2543, 2599, 2656, 2714, 2774, 2834,
  2896, 2960, 3025, 3091, 3158, 3228, 3298, 3371, 3444, 3520, 3597, 3676, 3756, 3838, 3922, 4008,
];
const WH = [0, -214, 798];
const RH2 = [2, 1, 2, 1];
const QMF = [3, -11, 12, 32, -210, 951, 3876, -805, 362, -156, 53, -11];

const sat = (x: number) => (x > 32767 ? 32767 : x < -32768 ? -32768 : x);
// C's arithmetic right shift on values that may exceed int32 (JS >> wraps).
const shr = (x: number, n: number) => Math.floor(x / (1 << n));

class Band {
  s = 0; sp = 0; sz = 0; nb = 0;
  r = [0, 0, 0]; a = [0, 0, 0]; ap = [0, 0, 0]; p = [0, 0, 0];
  d = [0, 0, 0, 0, 0, 0, 0]; b = [0, 0, 0, 0, 0, 0, 0]; bp = [0, 0, 0, 0, 0, 0, 0]; sg = [0, 0, 0, 0, 0, 0, 0];
  constructor(public det: number) {}

  // Blocks 4L/4H: reconstruction, pole/zero predictor adaptation, prediction.
  update(d: number) {
    this.d[0] = d;
    this.r[0] = sat(this.s + d);
    this.p[0] = sat(this.sz + d);

    for (let i = 0; i < 3; i++) this.sg[i] = this.p[i] >> 15;
    const wd1 = sat(this.a[1] * 4);
    let wd2 = this.sg[0] === this.sg[1] ? -wd1 : wd1;
    if (wd2 > 32767) wd2 = 32767;
    let wd3 = (wd2 >> 7) + (this.sg[0] === this.sg[2] ? 128 : -128);
    wd3 += (this.a[2] * 32512) >> 15;
    this.ap[2] = wd3 > 12288 ? 12288 : wd3 < -12288 ? -12288 : wd3;

    this.sg[0] = this.p[0] >> 15;
    this.sg[1] = this.p[1] >> 15;
    this.ap[1] = sat((this.sg[0] === this.sg[1] ? 192 : -192) + ((this.a[1] * 32640) >> 15));
    const lim = sat(15360 - this.ap[2]);
    if (this.ap[1] > lim) this.ap[1] = lim; else if (this.ap[1] < -lim) this.ap[1] = -lim;

    const step = d === 0 ? 0 : 128;
    this.sg[0] = d >> 15;
    for (let i = 1; i < 7; i++) {
      this.sg[i] = this.d[i] >> 15;
      this.bp[i] = sat((this.sg[i] === this.sg[0] ? step : -step) + ((this.b[i] * 32640) >> 15));
    }

    for (let i = 6; i > 0; i--) { this.d[i] = this.d[i - 1]; this.b[i] = this.bp[i]; }
    for (let i = 2; i > 0; i--) { this.r[i] = this.r[i - 1]; this.p[i] = this.p[i - 1]; this.a[i] = this.ap[i]; }

    const f1 = (this.a[1] * sat(this.r[1] + this.r[1])) >> 15;
    const f2 = (this.a[2] * sat(this.r[2] + this.r[2])) >> 15;
    this.sp = sat(f1 + f2);
    let sz = 0;
    for (let i = 6; i > 0; i--) sz += (this.b[i] * sat(this.d[i] + this.d[i])) >> 15;
    this.sz = sat(sz);
    this.s = sat(this.sp + this.sz);
  }
}

export class G722Decoder {
  private low = new Band(32);
  private high = new Band(8);
  private x = new Array<number>(24).fill(0); // QMF synthesis delay line

  /** One G.722 payload (1 byte per 2 output samples) -> 16 kHz PCM. */
  decode(payload: Uint8Array): Int16Array {
    const out = new Int16Array(payload.length * 2);
    let o = 0;
    for (const code of payload) {
      // Low band (6 bits): blocks 5L, 2L, 3L.
      let wd1 = code & 0x3f;
      const ihigh = (code >> 6) & 0x03;
      let wd2 = QM6[wd1];
      wd1 >>= 2;
      wd2 = (this.low.det * wd2) >> 15;
      let rlow = this.low.s + wd2;
      rlow = rlow > 16383 ? 16383 : rlow < -16384 ? -16384 : rlow;
      const dlowt = (this.low.det * QM4[wd1]) >> 15;
      let nb = ((this.low.nb * 127) >> 7) + WL[RL42[wd1]];
      this.low.nb = nb < 0 ? 0 : nb > 18432 ? 18432 : nb;
      let sh = 8 - (this.low.nb >> 11);
      let base = ILB[(this.low.nb >> 6) & 31];
      this.low.det = (sh < 0 ? base << -sh : base >> sh) << 2;
      this.low.update(dlowt);

      // High band (2 bits): blocks 2H, 5H, 3H.
      const dhigh = (this.high.det * QM2[ihigh]) >> 15;
      let rhigh = dhigh + this.high.s;
      rhigh = rhigh > 16383 ? 16383 : rhigh < -16384 ? -16384 : rhigh;
      nb = ((this.high.nb * 127) >> 7) + WH[RH2[ihigh]];
      this.high.nb = nb < 0 ? 0 : nb > 22528 ? 22528 : nb;
      sh = 10 - (this.high.nb >> 11);
      base = ILB[(this.high.nb >> 6) & 31];
      this.high.det = (sh < 0 ? base << -sh : base >> sh) << 2;
      this.high.update(dhigh);

      // QMF synthesis: two output samples per code.
      const x = this.x;
      for (let i = 0; i < 22; i++) x[i] = x[i + 2];
      x[22] = rlow + rhigh;
      x[23] = rlow - rhigh;
      let xout1 = 0, xout2 = 0;
      for (let i = 0; i < 12; i++) {
        xout2 += x[2 * i] * QMF[i];
        xout1 += x[2 * i + 1] * QMF[11 - i];
      }
      out[o++] = sat(shr(xout1, 11));
      out[o++] = sat(shr(xout2, 11));
    }
    return out;
  }
}
