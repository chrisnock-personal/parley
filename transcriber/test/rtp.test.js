// Regression checks for issue #45: a malformed RTP header extension used to
// throw ERR_OUT_OF_RANGE from the UDP 'message' callback and kill the
// transcriber. Run with `npm test` (builds TypeScript first).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rtpPayload } = require('../dist/rtp');

function packet({ cc = 0, ext = null, payload = Buffer.from([1, 2, 3]) } = {}) {
  const header = Buffer.alloc(12 + cc * 4 + (ext ? 4 + ext.length : 0));
  header[0] = 0x80 | cc | (ext ? 0x10 : 0); // RTP v2, optional X, CC
  header[1] = 0; // PCMU
  if (ext) {
    assert.equal(ext.length % 4, 0, 'extension must be a whole number of words');
    const at = 12 + cc * 4;
    header.writeUInt16BE(0xbede, at);
    header.writeUInt16BE(ext.length / 4, at + 2);
    ext.copy(header, at + 4);
  }
  return Buffer.concat([header, payload]);
}

test('truncated X-bit packet is skipped, not thrown from the UDP callback', () => {
  // Reproduce the issue: 0x90 (v2 + extension), 13 bytes total.
  const msg = Buffer.alloc(13);
  msg[0] = 0x90;
  let payload;
  assert.doesNotThrow(() => { payload = rtpPayload(msg); });
  assert.equal(payload, null);
});

test('truncated X-bit packet with CSRCs is skipped too', () => {
  const msg = Buffer.alloc(13);
  msg[0] = 0x91; // X=1, CC=1: the CSRC alone overruns the packet
  assert.doesNotThrow(() => assert.equal(rtpPayload(msg), null));
});

test('extension length past the end of the packet is skipped', () => {
  const full = packet({ ext: Buffer.alloc(4, 0xaa) });
  assert.equal(rtpPayload(full.subarray(0, 16)), null); // header says 1 word, none present
  const huge = packet({ ext: Buffer.alloc(4), payload: Buffer.from([1]) });
  huge.writeUInt16BE(0xffff, 14);
  assert.equal(rtpPayload(huge), null);
});

test('valid packets keep their payload, with CSRCs and/or an extension', () => {
  const payload = Buffer.from([1, 2, 3]);
  assert.deepEqual(rtpPayload(packet()), payload);
  assert.deepEqual(rtpPayload(packet({ cc: 2 })), payload);
  assert.deepEqual(rtpPayload(packet({ ext: Buffer.alloc(8, 0xaa) })), payload);
  assert.deepEqual(rtpPayload(packet({ cc: 3, ext: Buffer.alloc(4, 0xbb) })), payload);
});
