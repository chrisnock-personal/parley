// SIP-REC (RFC 7865/7866) recording client (SRC). For a call involving a
// directory user with siprec_enabled, pbx-core opens a separate recording
// session to the ONE global recording server (SRS, system_settings
// 'siprec_srs_uri' -see db.ts) carrying a copy of the call's media.
//
// The media never passes through pbx-core: rtpengine's "subscribe request"
// (with its SIPREC flag) produces an SDP offer with one sendonly,
// a=label'd m-line per leg, decrypted from any WebRTC DTLS-SRTP; pbx-core
// sends that plus the RFC 7865 metadata to the SRS, and hands the SRS's
// answer back to rtpengine ("subscribe answer"). Metadata shape ported from
// CallRaven's backend/siprec.js, generalised from 2 fixed streams to one
// stream per leg.
//
// Recording is deliberately never in the call's critical path: it starts
// after the call is up, and any failure is logged and dropped -the call
// carries on unrecorded (fail-open). A compliance deployment that must
// block unrecorded calls would need that policy decided explicitly.
import crypto from 'crypto';
import Srf from 'drachtio-srf';
import { config } from './config';
import * as rtp from './rtpengine';
import { getSrsUri, getUserPolicy } from './db';
import * as calls from './calls';

export interface RecordedLeg {
  tag: string;        // rtpengine monologue (from-tag) whose SENT media this stream carries
  aor: string;        // e.g. sip:2001@open-intercom, or sip:*8cameras@open-intercom for a group mix
  name: string;       // fallback display name; a directory user's own name wins
  extension?: string; // set for a directory user's leg -their siprec_enabled decides recording
}

export interface RecordingHandle { stop(): void }

const RECORDING_XMLNS = 'urn:ietf:params:xml:ns:recording:1';

// RFC 7865: session/participant/stream IDs are 16 random bytes, base64.
const newId = () => crypto.randomBytes(16).toString('base64');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildMetadataXml(legs: RecordedLeg[], labels: string[]): string {
  const sessionId = newId();
  const ids = legs.map(() => ({ participant: newId(), stream: newId() }));
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<recording xmlns='${RECORDING_XMLNS}'>`,
    '  <datamode>complete</datamode>',
    `  <session session_id="${sessionId}"/>`,
  ];
  legs.forEach((leg, i) => {
    lines.push(
      `  <participant participant_id="${ids[i].participant}">`,
      `    <nameID aor="${esc(leg.aor)}">`,
      `      <name>${esc(leg.name)}</name>`,
      '    </nameID>',
      '  </participant>',
    );
  });
  legs.forEach((_, i) => {
    lines.push(
      `  <stream stream_id="${ids[i].stream}" session_id="${sessionId}">`,
      `    <label>${esc(labels[i])}</label>`,
      '  </stream>',
    );
  });
  // Each participant sends its own stream and receives everyone else's.
  legs.forEach((_, i) => {
    lines.push(`  <participantstreamassoc participant_id="${ids[i].participant}">`);
    lines.push(`    <send>${ids[i].stream}</send>`);
    ids.forEach((other, j) => { if (j !== i) lines.push(`    <recv>${other.stream}</recv>`); });
    lines.push('  </participantstreamassoc>');
  });
  lines.push('</recording>', '');
  return lines.join('\r\n');
}

/** a=label value of each m-section, in order (rtpengine's SIPREC flag adds them). */
function mediaLabels(sdp: string): string[] {
  return sdp.split(/\r?\nm=/).slice(1).map((section, i) => section.match(/^a=label:(\S+)/m)?.[1] ?? String(i));
}

// rtpengine 10.5 rejects a subscription answer that drops a codec the offer
// carries -including telephone-event, which every browser leg has next to
// its audio codec ("Failed to process subscription answer"; filtering DTMF
// out counts as a media change it won't make for a subscriber). Recording
// servers commonly answer audio only, so recording failed for every browser
// call (found 2026-10-18; plain-RTP test legs had no DTMF, so earlier tests
// passed). Add the offer's telephone-event back into each answered section:
// rtpengine is then satisfied, and the recorder just receives DTMF packets
// it can ignore.
function keepOfferedDtmf(offer: string, answer: string): string {
  const sections = (sdp: string) => sdp.split(/(?=^m=)/m);
  const offerSecs = sections(offer);
  const [head, ...ansSecs] = sections(answer);
  const offerMedia = offerSecs.filter((x) => x.startsWith('m='));
  return head + ansSecs.map((sec, i) => {
    const off = offerMedia[i];
    const te = off?.match(/^a=rtpmap:(\d+) (telephone-event\/\d+)/m);
    if (!te || new RegExp(`^a=rtpmap:\\d+ telephone-event`, 'm').test(sec)) return sec;
    const fmtp = off.match(new RegExp(`^a=fmtp:${te[1]} [^\\r\\n]+`, 'm'));
    const eol = sec.includes('\r\n') ? '\r\n' : '\n';
    const [mline, ...rest] = sec.split(eol);
    return [`${mline} ${te[1]}`, `a=rtpmap:${te[1]} ${te[2]}`, ...(fmtp ? [fmtp[0]] : []), ...rest].join(eol);
  }).join('');
}

/** The SDP part of an SRS answer, which may itself be multipart. */
function sdpPart(body: string, contentType: string | undefined): string {
  const boundary = contentType?.match(/boundary="?([^";]+)"?/i)?.[1];
  if (!boundary) return body;
  for (const part of body.split(`--${boundary}`)) {
    const [head, ...rest] = part.split(/\r?\n\r?\n/);
    if (/content-type:\s*application\/sdp/i.test(head)) return rest.join('\r\n\r\n').trim() + '\r\n';
  }
  return body;
}

/** Start recording this call if any leg's directory user has siprec_enabled
 * and a global SRS is configured. Returns at once; the recording session is
 * set up in the background, and stop() is safe to call at any point. */
export function startRecordingIfEnabled(srf: Srf, callId: string, legs: RecordedLeg[]): RecordingHandle {
  let stopped = false;
  let teardown: (() => void) | null = null;

  (async () => {
    const srsUri = await getSrsUri();
    if (!srsUri) return;
    const policies = await Promise.all(legs.map((l) => (l.extension ? getUserPolicy(l.extension) : null)));
    if (!policies.some((p) => p?.siprecEnabled)) return;
    if (stopped) return;
    legs = legs.map((l, i) => ({ ...l, name: policies[i]?.name || l.name }));

    const sub = await rtp.subscribeRequest(callId, legs.map((l) => l.tag), ['SIPREC']);
    let uac: any = null;
    const release = () => {
      rtp.unsubscribe(callId, sub.toTag);
      if (uac) uac.destroy().catch(() => { /* already gone */ });
    };
    try {
      const labels = mediaLabels(sub.sdp);
      const boundary = `siprec-${crypto.randomBytes(8).toString('hex')}`;
      const body = [
        `--${boundary}`, 'Content-Type: application/sdp', '', sub.sdp.trimEnd(),
        `--${boundary}`, 'Content-Type: application/rs-metadata', 'Content-Disposition: recording-session', '',
        buildMetadataXml(legs, labels).trimEnd(),
        `--${boundary}--`, '',
      ].join('\r\n');

      uac = await (srf as any).createUAC(srsUri, {
        localSdp: body,
        headers: {
          'Content-Type': `multipart/mixed;boundary=${boundary}`,
          Require: 'siprec',
          Accept: 'application/sdp, application/rs-metadata',
          // RFC 7866 section 6.1.1: the SRC marks itself with +sip.src.
          Contact: `${config.ownContact};+sip.src`,
        },
      });
      const srsSdp = sdpPart(uac.remote.sdp, uac.res?.get?.('Content-Type'));
      await rtp.subscribeAnswer(callId, sub.toTag, keepOfferedDtmf(sub.sdp, srsSdp));
    } catch (err) {
      release();
      throw err;
    }
    if (stopped) { release(); return; }
    teardown = () => { calls.setRecording(callId, false); release(); };
    calls.setRecording(callId, true);
    // The SRS can end the recording itself; free the subscription if so.
    uac.on('destroy', () => { rtp.unsubscribe(callId, sub.toTag); calls.setRecording(callId, false); teardown = null; });
    console.log(`[siprec] recording call ${callId} (${legs.map((l) => l.name).join(' / ')}) to ${srsUri}`);
  })().catch((err) => console.error(`[siprec] call ${callId} not recorded:`, err?.message || err));

  return {
    stop() {
      stopped = true;
      if (teardown) { teardown(); teardown = null; }
    },
  };
}
