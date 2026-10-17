// Direct intercom: caller dials a registered AOR, we B2BUA to the callee,
// anchor media in rtpengine, and inject an auto-answer header so the callee
// picks up instantly (open-mic). No mixer needed for 2-party.

import Srf from 'drachtio-srf';
import { config } from './config';
import * as rtp from './rtpengine';
import { lookup, aorKey, extOf, Binding } from './registrar';
import { sdpMode } from './sdpInspect';
import { wireReinviteHandling } from './reinvite';
import * as calls from './calls';
import { startRecordingIfEnabled } from './siprec';

export function registerDirectIntercom(srf: Srf) {
  // Registered after registerGroupIntercom -group calls are handled there
  // and fall through here via next() (see groups.ts's comment on why an
  // explicit next(), not a bare `return`, is required by drachtio-srf).
  srf.invite(async (req: any, res: any) => {
    const targetKey = aorKey(req.uri);

    // Groups are handled by registerGroupIntercom, which runs first. This
    // branch shouldn't normally be reached for a group URI, but respond
    // rather than hang if it ever is (e.g. handler registration order changes).
    if (targetKey.includes(config.groupPrefix)) return res.send(404, 'Group calls are handled elsewhere');

    const callee: Binding | undefined = lookup(targetKey);
    if (!callee) {
      console.warn(`direct intercom call to ${targetKey}: not registered (404)`);
      return res.send(404, 'Endpoint not registered');
    }

    const callId = req.get('Call-ID');
    const fromTag = req.getParsedHeader('From').params.tag;

    // The caller's mode is sniffable from their own SDP (already in hand).
    // The callee's mode can't be -we haven't gotten their SDP yet -so it
    // comes from the registrar hint captured at REGISTER time instead. See
    // rtpengine.ts's header comment and registrar.ts's Binding.mediaMode.
    const callerMode = sdpMode(req.body);
    const calleeMode = callee.mediaMode;

    let mediaUp = false;
    try {
      // 1. Anchor caller media, produce SDP to offer the callee -shaped for
      //    the callee's transport (plain RTP or WebRTC, whichever they are).
      const sdpToCallee = await rtp.offer({ callId, fromTag, sdp: req.body, mode: calleeMode });
      mediaUp = true;

      // 2. B2BUA to the callee's contact, carrying the auto-answer header
      //    and the rtpengine-anchored SDP.
      const { uas, uac } = await srf.createB2BUA(req, res, callee.contact, {
        headers: { Contact: config.ownContact, ...config.autoAnswerHeaders },
        localSdpB: sdpToCallee,
        // 3. When the callee answers, anchor its SDP and hand the result
        //    back to the caller -shaped for the caller's own transport.
        localSdpA: (calleeSdp: string) =>
          rtp.answer({ callId, fromTag, toTag: 'callee', sdp: calleeSdp, mode: callerMode }),
        proxyRequestHeaders: ['User-Agent'],
        proxyResponseHeaders: ['Server'],
      });

      const callerExt = extOf(req.getParsedHeader('From').uri);
      const calleeExt = extOf(targetKey);

      // SIP-REC, if either party is recorded -see siprec.ts. Never blocks
      // or fails the call itself.
      const recording = startRecordingIfEnabled(srf, callId, [
        { tag: fromTag, aor: `sip:${callerExt}@${config.sipRealm}`, name: callerExt, extension: callerExt },
        { tag: 'callee', aor: `sip:${calleeExt}@${config.sipRealm}`, name: calleeExt, extension: calleeExt },
      ]);

      const teardown = () => { recording.stop(); rtp.del(callId, fromTag); calls.end(callId); };
      // When one leg hangs up, hang up the other. Both can end at nearly the
      // same moment (e.g. a member leaves just as FreeSWITCH drops them), and
      // then the second destroy() targets a dialog drachtio has already
      // removed and rejects -expected, so swallowed. Uncaught, it crashed
      // pbx-core (Node exits on unhandled rejections), dropping every call.
      const hangUp = (dlg: any) => dlg.destroy().catch(() => { /* already gone */ });
      uas.on('destroy', () => { hangUp(uac); teardown(); });
      uac.on('destroy', () => { hangUp(uas); teardown(); });

      // Live-view bookkeeping (console's "Live" tab, client participant
      // lists) -not used for any routing decision. See calls.ts.
      calls.start({
        callId, kind: 'direct',
        from: callerExt,
        to: calleeExt,
        callerTag: fromTag, calleeTag: 'callee',
        startedAt: Date.now(),
      });

      // Real hold/resume (or any other mid-call SDP change) -without this,
      // drachtio-srf silently auto-answers every re-INVITE itself with stale
      // SDP, never touching rtpengine or the other leg. See reinvite.ts.
      wireReinviteHandling(uas, uac, {
        callId, callerTag: fromTag, calleeTag: 'callee', callerMode, calleeMode,
      });
    } catch (err: any) {
      console.error(`direct intercom call ${targetKey} failed:`, err?.message || err);
      if (mediaUp) await rtp.del(callId, fromTag);
      // 486 if the callee leg was rejected, 500 otherwise.
      const status = err?.status && err.status >= 400 ? err.status : 500;
      if (!res.finalResponseSent) res.send(status);
    }
  });
}
