// src/sipUa.ts -one real browser JsSIP.UA for the whole intercom client session.
//
// Unlike intercom-endpoint (headless Node, fakes RTCPeerConnection), this
// runs in an actual browser: real getUserMedia + RTCPeerConnection, real
// DTLS-SRTP negotiated by the browser itself. No shims, no hand-rolled RTP,
// no raw re-INVITEs for hold -JsSIP's normal session methods work natively.
import JsSIP from 'jssip';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function createIntercomClientUa(extension: string, password: string): any {
  // Same origin the page itself loaded from -nginx proxies /ws through to
  // pbx-core's plain ws://:8188 listener (see nginx.conf), so this is
  // always correct regardless of host/scheme, no server-handed config
  // needed. wss:// automatically when the page itself is HTTPS.
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUri = `${proto}://${window.location.host}/ws`;
  const socket = new JsSIP.WebSocketInterface(wsUri);
  // JsSIP derives the Via transport from the URL scheme, so a wss:// page
  // sends "Via: SIP/2.0/WSS". But nginx terminates TLS, and drachtio only
  // ever receives plain ws -and Sofia-SIP silently DROPS a request whose Via
  // transport doesn't match the connection it arrived on (no response, no
  // log). Every https:// client hung on "connecting" until registration
  // failed (an iPad, 2026-10-17; desktop only worked because it was on
  // http://localhost). Declare the transport drachtio actually sees.
  socket.via_transport = 'WS';
  const ua = new JsSIP.UA({
    sockets: [socket],
    uri: `sip:${extension}@${window.location.hostname}`,
    // The SAME password used to log into this app (see api.ts) -pbx-core
    // now digest-authenticates REGISTER/INVITE against a hash of it
    // (controller-backend's directoryUserService.ts computes and stores
    // HA1 = MD5(extension:realm:password) whenever this password is set;
    // pbx-core never sees the plaintext, only JsSIP does, to compute the
    // digest response). JsSIP defaults `authorization_user` to the uri's
    // user part (the extension) when not set, which is exactly the
    // username pbx-core expects -no separate config needed. This is why
    // App.tsx has to keep the plaintext in memory (never sessionStorage)
    // rather than just the token: a same-tab reload can restore the login
    // session from the stored JWT alone, but there's no way to restore
    // this from that -see App.tsx's reconnect-prompt flow.
    password,
    display_name: extension,
    register: true,
    register_expires: 300,
    user_agent: 'IntercomClient/1.0',
    // Tells pbx-core's registrar this AOR's media is WebRTC (DTLS-SRTP/ICE),
    // so rtpengine bridges legs to/from this UA correctly -see
    // pbx-core/src/registrar.ts's Binding.mediaMode. NB: the correct JsSIP
    // config key is `extra_headers` (global, added to every request) -there
    // is no `register_extra_headers` key at all; using that silently did
    // nothing (JsSIP ignores unrecognized config keys), which is why this
    // header was never actually sent and every registration defaulted to
    // 'plain' -root cause of the WebRTC leg getting offered a plain-RTP SDP
    // with no DTLS, which a real browser correctly rejects with 488.
    extra_headers: ['X-Media-Mode: webrtc'],
  });
  return ua;
}

export function targetUri(extension: string): string {
  return `sip:${extension}@${window.location.hostname}`;
}
