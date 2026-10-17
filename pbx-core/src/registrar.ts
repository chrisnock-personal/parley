// Minimal in-memory location service. Good enough to prototype; swap for a
// Redis/Postgres-backed store when you want persistence + multi-instance.

export interface Binding {
  aor: string;          // e.g. sip:1001@intercom.lab
  contact: string;      // the endpoint's contact URI
  source: string;       // protocol/ip:port drachtio saw the REGISTER from
  transport: string;    // 'ws' | 'wss' | 'udp' | 'tcp' -signalling only.
  // Media transport hint, captured from the REGISTER's X-Media-Mode header
  // (defaults to 'plain'). Needed because rtpengine.ts's offer() has to know
  // the CALLEE's media mode before the callee has sent any SDP back -a
  // caller's mode can be sniffed from their INVITE body (see sdpInspect.ts),
  // but there's no SDP to sniff for the leg you're about to generate.
  mediaMode: 'plain' | 'webrtc';
  expiresAt: number;    // epoch ms
}

// Keyed by extension alone, not the full user@host AOR. This is a
// single-domain system, and the host part is just whatever address the
// client happened to reach us by: a browser opened on localhost registers
// sip:1001@localhost, one on the LAN IP registers sip:1002@192.168.1.150,
// and each dials others under its OWN host. Keying on the full AOR made
// every cross-host direct call miss the lookup and 404 (2026-10-17).
const bindings = new Map<string, Binding>();
const keyOf = (aor: string) => extOf(aor).toLowerCase();

export function upsert(b: Omit<Binding, 'expiresAt'>, expiresSecs: number): void {
  if (expiresSecs <= 0) {
    bindings.delete(keyOf(b.aor));
    return;
  }
  bindings.set(keyOf(b.aor), { ...b, expiresAt: Date.now() + expiresSecs * 1000 });
}

export function lookup(aor: string): Binding | undefined {
  const key = keyOf(aor);
  const b = bindings.get(key);
  if (!b) return undefined;
  if (b.expiresAt < Date.now()) {
    bindings.delete(key);
    return undefined;
  }
  return b;
}

export function all(): Binding[] {
  const now = Date.now();
  return [...bindings.values()].filter((b) => b.expiresAt >= now);
}

/** Normalise a request URI down to a bare AOR key (user@host, no params). */
export function aorKey(uri: string): string {
  const m = uri.match(/sips?:([^@;>]+@[^;>]+)/i);
  return m ? `sip:${m[1]}` : uri;
}

/** Extract just the user part (extension) from a SIP URI/AOR, e.g.
 * "sip:2001@intercom.lab" -> "2001". Falls back to the input unchanged if
 * it doesn't look like a SIP URI (e.g. it's already a bare extension). */
export function extOf(uri: string): string {
  const m = uri.match(/sips?:([^@;>]+)@/i);
  return m ? m[1] : uri;
}
