// Group open-mic + PTT floor (Phase 2).
//
// A group INVITE (request URI containing GROUP_PREFIX, e.g. "*8floor-a") is
// B2BUA'd straight to FreeSWITCH. FreeSWITCH's own dialplan (see
// ../../freeswitch/dialplan/intercom.xml) answers and joins the destination
// number into a mod_conference room of the same name -every unmuted
// participant hears every other one, i.e. open mic, with zero custom mixing
// logic on our side.
//
// PTT floor control is NOT done here. Muting a participant is done at the
// SIP endpoint itself (a re-INVITE to sendonly via /api/hold, same mechanism
// as direct-call PTT) -a muted leg simply stops sending RTP, so FreeSWITCH's
// mix naturally excludes it. This keeps the mixer a pure media resource, per
// the agreed design, and avoids needing an ESL/drachtio-fsmrf control channel
// for this prototype.
//
// Media is anchored through rtpengine. The FreeSWITCH-facing leg is ALWAYS
// plain RTP regardless of the caller -FreeSWITCH's "intercom" profile is
// plain UDP, not WebRTC -but the caller (e.g. an intercom client joining a group from
// the Speaker channel) may be real WebRTC, so the leg back to THEM still
// needs to be shaped correctly. See intercom.ts's comment for why the
// caller's mode is sniffable from their SDP but a not-yet-answered leg's
// mode can't be.

import Srf from 'drachtio-srf';
import { config } from './config';
import * as rtp from './rtpengine';
import { sdpMode } from './sdpInspect';
import { wireReinviteHandling } from './reinvite';
import { watchLegs } from './liveness';
import * as mutes from './mutes';
import * as db from './db';
import { extOf } from './registrar';
import * as calls from './calls';
import { startRecordingIfEnabled } from './siprec';

export function registerGroupIntercom(srf: Srf) {
  // NB: drachtio-srf's middleware chain requires an explicit next() to
  // advance -unlike Express, a bare `return` does NOT fall through to the
  // next .invite() handler (intercom.ts). Every early-exit path here that
  // isn't actually handling the request must call next(), or non-group
  // INVITEs silently hang forever (100 Trying with no further response).
  // Cast to any: the Srf type definitions only declare a 2-arg (req, res)
  // callback for .invite(), but drachtio-srf always invokes middleware with
  // a 3rd `next` argument at runtime (see proto.js) -same class of
  // incomplete typing as the missing `.register()` declaration in index.ts.
  (srf.invite as any)(async (req: any, res: any, next: any) => {
    const uri: string = req.uri || '';
    if (!uri.includes(config.groupPrefix)) return next(); // not a group call -fall through to direct handler

    // Extract the code after the prefix, e.g. "sip:*8floor-a@pbx-core" -> "floor-a"
    const match = uri.match(new RegExp(`\\${config.groupPrefix}([a-z0-9-]+)`, 'i'));
    const groupCode = match?.[1];
    if (!groupCode) return res.send(404, 'No group code in request URI');

    const callId = req.get('Call-ID');
    const fromTag = req.getParsedHeader('From').params.tag;
    const fsTarget = `sip:${groupCode}@${config.freeswitch.host}:${config.freeswitch.port}`;

    const callerMode = sdpMode(req.body);

    let mediaUp = false;
    try {
      // Anchor caller media, produce SDP to offer FreeSWITCH -always plain,
      // FreeSWITCH's profile never speaks WebRTC. iceLite is still needed
      // here whenever the CALLER is webrtc (e.g. an intercom client joining the
      // group): this is the only offer() call for the whole session, and
      // the caller's own leg is shaped later via answer() -which can't
      // carry 'ICE-lite' itself (only valid on 'offer') -so it has to ride
      // along on this one, even though this call's own output is plain. See
      // rtpengine.ts's Leg.iceLite comment.
      const sdpToFs = await rtp.offer({ callId, fromTag, sdp: req.body, mode: 'plain', iceLite: callerMode === 'webrtc' });
      mediaUp = true;

      const { uas, uac } = await srf.createB2BUA(req, res, fsTarget, {
        headers: { Contact: config.ownContact },
        localSdpB: sdpToFs,
        // FreeSWITCH's dialplan answers unconditionally (application="answer"
        // then "conference") -no auto-answer header needed on this leg.
        // The leg back to the caller must match THEIR transport, though.
        localSdpA: (fsSdp: string) =>
          rtp.answer({ callId, fromTag, toTag: 'fs', sdp: fsSdp, mode: callerMode }),
      });

      const memberExt = extOf(req.getParsedHeader('From').uri);

      // SIP-REC, if this member is recorded: their own voice plus the group
      // mix they hear (FreeSWITCH's leg). See siprec.ts.
      const recording = startRecordingIfEnabled(srf, callId, [
        { tag: fromTag, aor: `sip:${memberExt}@${config.sipRealm}`, name: memberExt, extension: memberExt },
        { tag: 'fs', aor: `sip:${config.groupPrefix}${groupCode}@${config.sipRealm}`, name: `Group ${groupCode}` },
      ]);

      let stopWatching = () => {};
      const teardown = () => { stopWatching(); recording.stop(); rtp.del(callId, fromTag); calls.end(callId); };
      // When one leg hangs up, hang up the other. Both can end at nearly the
      // same moment (e.g. a member leaves just as FreeSWITCH drops them), and
      // then the second destroy() targets a dialog drachtio has already
      // removed and rejects -expected, so swallowed. Uncaught, it crashed
      // pbx-core (Node exits on unhandled rejections), dropping every call.
      const hangUp = (dlg: any) => dlg.destroy().catch(() => { /* already gone */ });
      uas.on('destroy', () => { hangUp(uac); teardown(); });
      uac.on('destroy', () => { hangUp(uas); teardown(); });
      // A browser that vanished without BYE (crash, sleep, lost network):
      // hang up both legs ourselves, or it stays in as a ghost (liveness.ts).
      stopWatching = watchLegs([...(callerMode === 'webrtc' || config.livenessPlain ? [{ dlg: uas, label: memberExt }] : [])], (who, why) => {
        console.log(`[liveness] ${callId}: ${who} has gone (${why}); ending the call`);
        hangUp(uas); hangUp(uac); teardown();
      });

      // Live-view bookkeeping (console's "Live" tab, client participant
      // lists, the transcriber) -not used for any routing decision.
      calls.start({
        callId, kind: 'group',
        from: memberExt,
        to: groupCode,
        callerTag: fromTag, calleeTag: 'fs',
        startedAt: Date.now(),
      });
      pokeTranscriber();
      // Blocked from the start: a listener in a listen-only group (issue
      // #21; their client offers no audio, this makes sure), or someone the
      // console has muted in this group (issue #9).
      void (async () => {
        let listener = false;
        try { listener = await db.isListener(groupCode, memberExt); }
        catch (e: any) { console.error(`[listen-only] looking up ${memberExt} in ${groupCode} failed:`, e?.message || e); }
        if (listener) { const c = calls.all().find((x) => x.callId === callId); if (c) c.listener = true; }
        if (listener || mutes.get(groupCode, memberExt)) {
          try { await rtp.setBlocked(callId, fromTag, true); }
          catch (e: any) { console.error(`[mute] blocking ${memberExt} in ${groupCode} failed:`, e?.message || e); }
        }
      })();

      // Real hold/resume on a group leg (e.g. an intercom client member holding their
      // own line) -see reinvite.ts / intercom.ts's identical wiring.
      wireReinviteHandling(uas, uac, {
        callId, callerTag: fromTag, calleeTag: 'fs', callerMode, calleeMode: 'plain',
      });
    } catch (err: any) {
      console.error(`group intercom call ${groupCode} failed:`, err?.message || err);
      if (mediaUp) await rtp.del(callId, fromTag);
      const status = err?.status && err.status >= 400 ? err.status : 502;
      if (!res.finalResponseSent) res.send(status, 'Failed to join conference');
    }
  });
}

/** Fire-and-forget: a transcriber that's down or slow must never affect the call. */
function pokeTranscriber() {
  if (!config.transcriberPokeUrl) return;
  fetch(config.transcriberPokeUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(500),
    headers: { Authorization: `Bearer ${config.admin.token}` },
  }).catch(() => { /* it polls anyway */ });
}
