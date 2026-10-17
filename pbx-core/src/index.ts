import Srf from 'drachtio-srf';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import registrationParser = require('drachtio-mw-registration-parser');
import { config } from './config';
import { upsert, all, aorKey, extOf } from './registrar';
import { registerGroupIntercom } from './groups';
import { registerDirectIntercom } from './intercom';
import { startAdminServer } from './admin';
import { requireDigestAuth } from './digestAuth';

const srf = new Srf();

srf.connect(config.drachtio);
startAdminServer(config.admin.port);

// Populates req.registration on REGISTER requests -drachtio-srf's own type
// definitions declare that shape (SrfRequest.registration) but drachtio-srf
// itself never populates it; that's this separate middleware's job. Without
// it, req.registration is always undefined and the handler below throws.
srf.use(registrationParser);

srf.on('connect', (err: Error | null, hostport: string) => {
  if (err) return console.error('drachtio connect error:', err);
  console.log(`pbx-core connected to drachtio at ${hostport}`);
});
srf.on('error', (err: Error) => console.error('srf error:', err));

// ---- Registrar -----------------------------------------------------------
// drachtio parses REGISTER into req.registration for us.
// NB: must be the `.register()` verb-shorthand, not `srf.on('register', ...)`.
// drachtio-srf only calls its internal client.route('register') -which is
// what tells drachtio's C++ core to actually forward REGISTER requests to
// this app instead of auto-responding 503 itself -when a verb is registered
// via `.use()`/the verb-shorthand methods. `.on()` is a plain EventEmitter
// listener that never touches routing, so it silently never fires. The
// `Srf` type definitions don't declare `.register()` (only `.invite()` is
// typed), even though it exists at runtime same as every other SIP verb
// (see drachtio-srf/lib/connect.js's dynamic method generation) -cast to
// `any` here rather than switching back to the broken `.on()` form.
(srf as any).register(async (req: any, res: any) => {
  const reg = req.registration; // { type, expires, contact: [{uri,...}], aor }
  const aor = aorKey(reg.aor);

  // SIP digest auth -see digestAuth.ts. The identity being authenticated is
  // the AOR's own extension: reject outright (403, not just "wrong
  // password") if a caller somehow authenticates as one extension while
  // registering a different AOR -digest usernames and AORs should always
  // agree for this system's own clients (JsSIP's authorization_user
  // defaults to the URI user part), so a mismatch here means something is
  // actively wrong, not just a bad password.
  const authedExt = await requireDigestAuth(req, res, 'REGISTER');
  if (!authedExt) return; // 401/403 already sent
  if (authedExt !== extOf(aor).toLowerCase()) {
    res.send(403, 'Authenticated identity does not match AOR');
    return;
  }

  const transport = req.protocol; // 'ws' | 'wss' | 'udp' | 'tcp'
  const source = `${req.protocol}/${req.source_address}:${req.source_port}`;
  // Real browser intercom clients send this to flag a WebRTC (DTLS-SRTP/ICE) leg —
  // see registrar.ts's Binding.mediaMode for why this can't just be sniffed
  // from SDP at call time. Anything that doesn't send it (every existing
  // station) defaults to 'plain', fully backward-compatible.
  const mediaMode = req.get('X-Media-Mode') === 'webrtc' ? 'webrtc' : 'plain';

  upsert(
    { aor, contact: reg.contact[0].uri, source, transport, mediaMode },
    reg.type === 'unregister' ? 0 : reg.expires,
  );

  console.log(`REGISTER ${reg.type} ${aor} (${transport}) exp=${reg.expires}`);
  res.send(200, {
    headers: {
      Contact: req.get('Contact'),
      Expires: reg.expires,
    },
  });
});

// ---- Call-origination auth -------------------------------------------------
// SIP digest auth on REGISTER alone doesn't stop someone from sending an
// unauthenticated INVITE with a spoofed From header -groups.ts/intercom.ts's
// handlers only ever look up the CALLEE in the registrar, never check who
// the caller claims to be. Register this BEFORE the group/direct handlers
// (drachtio-srf chains multiple .invite() handlers via next(), same
// mechanism groups.ts already relies on to fall through to intercom.ts) so
// every call attempt is authenticated before either ever sees it. FreeSWITCH
// never sends INVITEs inbound to pbx-core (only pbx-core originates B2BUA
// legs to it, as a UAC), so this can't ever block internal group-call
// traffic -only real external callers hit this at all.
(srf.invite as any)(async (req: any, res: any, next: any) => {
  const authedExt = await requireDigestAuth(req, res, 'INVITE');
  if (!authedExt) return; // 401/403 already sent

  const fromUri = req.getParsedHeader('From').uri;
  if (extOf(fromUri).toLowerCase() !== authedExt) {
    res.send(403, 'From does not match authenticated caller');
    return;
  }
  next();
});

// ---- Routing -------------------------------------------------------------
// Order matters: group handler returns early for non-group URIs, direct
// handler returns early for group URIs. Register groups first.
registerGroupIntercom(srf);   // Phase 2 stub -answers *8… ids
registerDirectIntercom(srf);  // Phase 1 -direct AOR-to-AOR intercom

// ---- Ops -----------------------------------------------------------------
setInterval(() => {
  const n = all().length;
  if (n) console.log(`registered endpoints: ${n}`);
}, 30_000);

process.on('SIGTERM', () => { srf.disconnect(); process.exit(0); });
// Last line of defence: one call's stray promise rejection must never take
// down every other call. Log it loudly instead of letting Node exit.
process.on('unhandledRejection', (err: any) => {
  console.error('[pbx-core] unhandled rejection (kept running):', err?.message || err);
});
