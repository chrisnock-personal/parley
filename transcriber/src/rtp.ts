// RTP fixed-header parsing for tapped media. Kept separate from tap.ts so the
// parse can be tested without a UDP socket or rtpengine subscription.
//
// Layout: 12-byte fixed header, CC*4 CSRCs, then (when X is set) a 4-byte
// extension header whose last 16 bits hold the extension length in 32-bit
// words excluding that header. A packet from an untrusted UDP sender can be
// shorter than any of those fields, so every read is bounded first: a
// malformed packet is skipped, never allowed to throw out of the UDP callback.
export function rtpPayload(msg: Buffer): Buffer | null {
  if (msg.length < 12 || (msg[0] >> 6) !== 2) return null;

  let offset = 12 + (msg[0] & 0x0f) * 4; // fixed header + CSRCs
  if (msg[0] & 0x10) {
    // Need the whole 4-byte extension header before reading its length.
    if (msg.length < offset + 4) return null;
    offset += 4 + msg.readUInt16BE(offset + 2) * 4;
  }
  if (msg.length < offset) return null;

  const payload = msg.subarray(offset);
  return payload.length ? payload : null;
}
