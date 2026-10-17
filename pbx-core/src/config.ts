export const config = {
  drachtio: {
    host: process.env.DRACHTIO_HOST || '127.0.0.1',
    port: parseInt(process.env.DRACHTIO_PORT || '9022', 10),
    secret: process.env.DRACHTIO_SECRET || 'cymru',
  },
  rtpengine: {
    host: process.env.RTPENGINE_HOST || '127.0.0.1',
    port: parseInt(process.env.RTPENGINE_PORT || '22222', 10),
  },
  // How we tell an endpoint to pick up instantly. container-sip-endpoint should
  // watch for either of these on an inbound INVITE and auto-accept.
  //
  // Call-Info's ABNF requires a <uri> before any ;params (RFC 3261 §20.9) —
  // a bare ';answer-after=0' is malformed. drachtio-server's SIP stack
  // silently drops a malformed well-known header when building the B2BUA'd
  // INVITE, and empirically took Alert-Info down with it too (boot-tested:
  // fixing just this one line was enough to make auto-answer work at all).
  autoAnswerHeaders: {
    'Call-Info': '<sip:pbx-core@open-intercom.local>;answer-after=0', // Polycom/Cisco-style
    'Alert-Info': '<urn:alert:service:auto-answer>',
  },

  // createB2BUA doesn't synthesize a Contact header for the leg it originates
  // -RFC 3261 requires every INVITE to carry one, and JsSIP-based endpoints
  // reject a Contact-less INVITE outright with 500 "unable to create a
  // Dialog without Contact header field".
  //
  // It MUST be routable: the far end sends in-dialog requests (BYE,
  // re-INVITE) to the Contact. A browser leg doesn't care (JsSIP always uses
  // its own WebSocket), but FreeSWITCH does. With the old placeholder host
  // (open-intercom.local) it could never resolve where to send its BYE, so
  // any hangup FreeSWITCH initiated (kick, restart, media timeout) silently
  // never reached pbx-core, leaving a stale call in calls.ts and a leaked
  // rtpengine session (found 2026-10-17; likely also behind the stale
  // conference members noted in July). PBX_SIP_HOST is this host's LAN IP
  // (compose sets it from RTPENGINE_PUBLIC_IP), PBX_SIP_PORT drachtio's
  // UDP/TCP SIP port (entrypoint.sh).
  ownContact: `<sip:pbx-core@${process.env.PBX_SIP_HOST || '127.0.0.1'}:${process.env.PBX_SIP_PORT || '5063'}>`,
  // Dial-plan conventions for the prototype.
  //   direct intercom : dial a registered AOR/extension directly
  //   group intercom  : dial an id in the GROUP_PREFIX namespace (Phase 2)
  groupPrefix: process.env.GROUP_PREFIX || '*8',

  // FreeSWITCH -pure media resource for group open-mic (mod_conference).
  // pbx-core B2BUAs a group INVITE here; FreeSWITCH's own dialplan answers
  // and joins the destination_number into a conference room of the same name.
  // No ESL/floor-control wiring needed: PTT mute is done at the SIP endpoint
  // (sendonly RTP via /api/hold), so the mixer just mixes whatever it receives.
  freeswitch: {
    host: process.env.FREESWITCH_HOST || '127.0.0.1',
    port: parseInt(process.env.FREESWITCH_PORT || '5080', 10),
  },

  // Read-only HTTP introspection (registrations + in-progress calls) for
  // controller-backend's "Live" view to poll. See admin.ts.
  admin: {
    port: parseInt(process.env.PBX_ADMIN_PORT || '9080', 10),
  },

  // SIP digest auth (RFC 2617/3261) for REGISTER and INVITE -see
  // digestAuth.ts. A deliberate, narrow exception to pbx-core otherwise
  // being database-free (see CLAUDE.md's design decisions): this is a
  // read-only lookup of one precomputed column
  // (intercom_directory_users.sip_ha1), not general DB access. Same
  // Postgres instance controller-backend uses -PGHOST/PGPORT here point at
  // its host-published port (5433 by default), not the in-cluster 5432,
  // because pbx-core runs network_mode: host (see docker-compose.yml) and
  // has no compose-network DNS to resolve the "postgres" service name the
  // way controller-backend does.
  db: {
    host:     process.env.PGHOST || '127.0.0.1',
    port:     parseInt(process.env.PGPORT || '5433', 10),
    database: process.env.PGDATABASE || 'intercom',
    user:     process.env.PGUSER || 'intercom_user',
    password: process.env.PGPASSWORD || 'intercom_pass',
  },

  // Must match controller-backend's directoryUserService.ts SIP_REALM
  // constant -separate deployables, no shared code, same convention as
  // GROUP_PREFIX. If you change one, change both.
  sipRealm: 'open-intercom',
};
