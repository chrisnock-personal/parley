// src/routes/intercomClient.ts -login + self for the browser intercom client page.
import express, { Router } from 'express';
import config from '../config';
import { requireIntercomClientAuth, signIntercomClientToken } from '../middleware/intercomClientSession';
import { authenticateDirectoryUser, avatarVersions, getAvatar, getDirectoryUser, listButtons, listDirectoryUsers, setAvatar, setButtonFavourite } from '../services/directoryUserService';
import { getSettings } from '../services/settingsService';
import { audit } from '../services/auditService';
import { recordIntercomClientCallStart, recordIntercomClientCallEnd } from '../services/pbxService';
import { getLiveStatus } from '../services/pbxCoreService';
import { listLines } from '../services/transcriptService';

const router = Router();

router.post('/login', async (req, res, next) => {
  try {
    const { extension, password } = req.body ?? {};
    if (!extension || !password) return res.status(400).json({ error: 'extension and password are required' });
    const user = await authenticateDirectoryUser(extension, password);
    const token = signIntercomClientToken({ id: user.id, extension: user.extension, name: user.name });
    // Set for parity with the console's cookie pattern; the intercom client
    // page itself relies on the returned token (sessionStorage + Bearer),
    // not this cookie -see plan notes on hot-desk kiosk semantics.
    res.cookie('intercom_client_session', token, {
      httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production',
      maxAge: 8 * 60 * 60 * 1000,
    });
    const buttons = await listButtons(user.id);
    await audit(user.extension, 'directory_user', user.id, 'login');
    res.json({ token, name: user.name, extension: user.extension, buttons });
  } catch (err) { next(err); }
});

router.post('/logout', requireIntercomClientAuth, async (req, res) => {
  res.clearCookie('intercom_client_session');
  await audit(req.intercomClientUser!.extension, 'directory_user', req.intercomClientUser!.id, 'logout');
  res.json({ ok: true });
});

router.get('/me', requireIntercomClientAuth, async (req, res, next) => {
  try {
    const buttons = await listButtons(req.intercomClientUser!.id);
    res.json({ name: req.intercomClientUser!.name, extension: req.intercomClientUser!.extension, buttons });
  } catch (err) { next(err); }
});

// Star / unstar one of your own group buttons. A display preference, so
// not audited.
router.patch('/buttons/:id', requireIntercomClientAuth, async (req, res, next) => {
  try {
    const { favourite } = req.body ?? {};
    if (typeof favourite !== 'boolean') return res.status(400).json({ error: 'favourite must be true or false' });
    await setButtonFavourite(req.intercomClientUser!.id, req.params.id, favourite);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Who is in each of this user's groups right now, Eyevinn-style, so a
// group's card can list its participants whether or not you've joined it.
// Comes straight from pbx-core's in-memory call list (each group call is
// one member's leg into the FreeSWITCH conference), enriched with names by
// getLiveStatus(), plus who's talking from the transcriber (best-effort:
// unreachable means nobody shows as talking). Only groups this user has a
// button for are returned. Polled by the client every second; pbx-core
// being unreachable is a 502 the client just skips, never an error dialog.
// Also carries what the client's indicators need on the same tick: who's
// online (registered), and recording state -whether this user is recorded
// by policy, and which of their calls/groups are being recorded right now.
router.get('/groups/participants', requireIntercomClientAuth, async (req, res, next) => {
  try {
    const buttons = await listButtons(req.intercomClientUser!.id);
    const mine = new Set(buttons.filter((b) => b.button_type === 'group' && b.target_group_dial_code)
      .map((b) => b.target_group_dial_code!));
    let live;
    try { live = await getLiveStatus(); }
    catch { return res.status(502).json({ error: 'pbx-core unreachable' }); }
    const talking = new Set<string>();
    try {
      const r = await fetch(`${config.transcriberUrl}/talking`, { signal: AbortSignal.timeout(500) });
      const body = await r.json() as { talking: { group: string; extension: string }[] };
      for (const t of body.talking) talking.add(`${t.group}/${t.extension}`);
    } catch { /* transcriber down: nobody shows as talking */ }
    const me = req.intercomClientUser!.extension;
    const participants: Record<string, { extension: string; name: string; talking: boolean }[]> = {};
    const recordingGroups = new Set<string>();
    let icmRecording = false;
    for (const code of mine) participants[code] = [];
    for (const c of live.calls) {
      if (c.kind === 'group' && mine.has(c.to)) {
        participants[c.to].push({ extension: c.from, name: c.fromName, talking: talking.has(`${c.to}/${c.from}`) });
        // Any member's recorded leg includes the group mix, so everyone's
        // voice in that group is being recorded.
        if (c.recording) recordingGroups.add(c.to);
      }
      if (c.kind === 'direct' && c.recording && (c.from === me || c.to === me)) icmRecording = true;
    }
    // Policy, not a live session: this user's calls get recorded (their
    // "Record calls" switch is on AND a recording server is configured).
    const [self, settings] = await Promise.all([getDirectoryUser(req.intercomClientUser!.id), getSettings()]);
    res.json({
      participants,
      online: live.registrations.map((r) => r.extension),
      avatars: await avatarVersions(),
      recording: {
        self: self.siprec_enabled && !!settings.siprec_srs_uri,
        icm: icmRecording,
        groups: [...recordingGroups],
      },
    });
  } catch (err) { next(err); }
});

// The intercom directory for the client's "All" tab: every enabled user
// except yourself, name + extension only (no policy flags). Who's online
// comes with the 1s poll.
router.get('/directory', requireIntercomClientAuth, async (req, res, next) => {
  try {
    const users = await listDirectoryUsers();
    res.json(users
      .filter((u) => u.enabled && u.id !== req.intercomClientUser!.id)
      .map((u) => ({ extension: u.extension, name: u.name })));
  } catch (err) { next(err); }
});

// ---- Profile pictures -------------------------------------------------------
// The client uploads an already-cropped small square image; the server only
// accepts JPEG/PNG/WebP (checked by magic bytes, not the header alone) up to
// AVATAR_MAX_BYTES. Images are served to signed-in intercom-client users only
// (<img> requests carry the login cookie), cached privately: the URL carries
// a version, so a new picture is a new URL.
const AVATAR_MAX_BYTES = 256 * 1024;
function imageMime(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

router.put('/me/avatar', requireIntercomClientAuth,
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: AVATAR_MAX_BYTES }),
  async (req, res, next) => {
    try {
      const body = req.body as Buffer;
      const mime = Buffer.isBuffer(body) ? imageMime(body) : null;
      if (!mime) return res.status(400).json({ error: 'Send a JPEG, PNG or WebP image' });
      await setAvatar(req.intercomClientUser!.id, body, mime);
      await audit(req.intercomClientUser!.extension, 'directory_user', req.intercomClientUser!.id, 'update', { avatar: 'set', bytes: body.length });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

router.delete('/me/avatar', requireIntercomClientAuth, async (req, res, next) => {
  try {
    await setAvatar(req.intercomClientUser!.id, null, null);
    await audit(req.intercomClientUser!.extension, 'directory_user', req.intercomClientUser!.id, 'update', { avatar: 'removed' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/avatars/:extension', requireIntercomClientAuth, async (req, res, next) => {
  try {
    const a = await getAvatar(req.params.extension);
    if (!a) return res.status(404).end();
    res.set({ 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.send(a.data);
  } catch (err) { next(err); }
});

// A group's live transcript (written by the transcriber service), readable
// by anyone with a button for that group whether or not they've joined it.
// `?after=<id>` returns only newer lines -the client polls this way.
// `transcribing` tells the client whether to show the panel at all.
router.get('/groups/:code/transcript', requireIntercomClientAuth, async (req, res, next) => {
  try {
    const buttons = await listButtons(req.intercomClientUser!.id);
    const button = buttons.find((b) => b.button_type === 'group' && b.target_group_dial_code === req.params.code);
    if (!button?.target_group_id) return res.status(404).json({ error: 'Not one of your groups' });
    const after = typeof req.query.after === 'string' && /^\d+$/.test(req.query.after) ? req.query.after : undefined;
    const lines = await listLines(button.target_group_id, after);
    res.json({ transcribing: !!button.target_group_transcribe_enabled, lines });
  } catch (err) { next(err); }
});

// Best-effort ping from the intercom client's own SIP call lifecycle
// (channels.ts's wireSession()/clear()) -the intercom client dials directly
// through pbx-core, so nothing else in this backend ever sees these calls
// happen. Never call-critical: the intercom client treats this as
// fire-and-forget on its side, and this route mirrors that by never
// surfacing a failure that would suggest the actual call was affected.
router.post('/call-events', requireIntercomClientAuth, async (req, res, next) => {
  try {
    const { event, clientCallId, kind, direction, counterpartExtension, reason } = req.body ?? {};
    if (!clientCallId) return res.status(400).json({ error: 'clientCallId is required' });

    if (event === 'start') {
      if (!kind || !direction || !counterpartExtension) {
        return res.status(400).json({ error: 'kind, direction, and counterpartExtension are required for a start event' });
      }
      await recordIntercomClientCallStart(req.intercomClientUser!, clientCallId, kind, direction, counterpartExtension);
    } else if (event === 'end') {
      await recordIntercomClientCallEnd(req.intercomClientUser!, clientCallId, reason);
    } else {
      return res.status(400).json({ error: 'event must be "start" or "end"' });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
