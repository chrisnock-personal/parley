// src/routes/intercomClient.ts -login + self for the browser intercom client page.
import express, { Router } from 'express';
import config from '../config';
import { requireIntercomClientAuth, signIntercomClientToken } from '../middleware/intercomClientSession';
import { authenticateDirectoryUser, avatarVersions, getAvatar, getDirectoryUser, listButtons, listDirectoryUsers, setAvatar, setButtonPrefs } from '../services/directoryUserService';
import { getSettings } from '../services/settingsService';
import { audit } from '../services/auditService';
import { recordIntercomClientCallStart, recordIntercomClientCallEnd } from '../services/pbxService';
import { getLiveStatus } from '../services/pbxCoreService';
import { listLines } from '../services/transcriptService';
import { latestIds, listMessages, postMessage } from '../services/chatService';
import { buildClientPayload, getSnapshot, groupIdsOf, loadUserCtx, subscribeClient } from '../services/liveHub';
import { openStream } from '../services/stream';
import { listSummaries, summaryLabel } from '../services/summaryService';

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

// Your own preferences on one of your group buttons: the star (favourite)
// and reading chat aloud (read_aloud). Either or both. Display preferences,
// so not audited.
router.patch('/buttons/:id', requireIntercomClientAuth, async (req, res, next) => {
  try {
    const { favourite, read_aloud } = req.body ?? {};
    const bad = (v: unknown) => v !== undefined && typeof v !== 'boolean';
    if (bad(favourite) || bad(read_aloud) || (favourite === undefined && read_aloud === undefined)) {
      return res.status(400).json({ error: 'favourite and/or read_aloud must be true or false' });
    }
    await setButtonPrefs(req.intercomClientUser!.id, req.params.id, { favourite, read_aloud });
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
    const u = req.intercomClientUser!;
    const ctx = await loadUserCtx(u.id, u.extension);
    let live;
    try { live = await getSnapshot(); }
    catch { return res.status(502).json({ error: 'pbx-core unreachable' }); }
    const latestById = await latestIds(groupIdsOf(ctx).map((b) => b.target_group_id!));
    res.json(buildClientPayload(ctx, live, latestById));
  } catch (err) { next(err); }
});

// The same view, pushed (issue #12): one update whenever it changes, from the
// live hub. The client falls back to polling the route above if this drops.
router.get('/stream', requireIntercomClientAuth, (req, res) => {
  const u = req.intercomClientUser!;
  openStream(req, res, (send) => subscribeClient(u.id, u.extension, send), {
    exp: (u as unknown as { exp?: number }).exp,
    stillAllowed: async () => { try { return (await getDirectoryUser(u.id)).enabled; } catch { return false; } },
  });
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

// A group's chat (migration 016), readable and writable by anyone with a
// button for that group whether or not they've joined it, while the group
// has chat switched on. `?after=<id>` returns only newer messages.
async function chatGroup(userId: string, code: string) {
  const buttons = await listButtons(userId);
  const button = buttons.find((b) => b.button_type === 'group' && b.target_group_dial_code === code);
  if (!button?.target_group_id) return { error: 404 as const };
  if (!button.target_group_chat_enabled) return { error: 403 as const };
  return { groupId: button.target_group_id };
}

router.get('/groups/:code/chat', requireIntercomClientAuth, async (req, res, next) => {
  try {
    const g = await chatGroup(req.intercomClientUser!.id, req.params.code);
    if (g.error === 404) return res.status(404).json({ error: 'Not one of your groups' });
    if (g.error === 403) return res.status(403).json({ error: 'Chat is off for this group' });
    const after = typeof req.query.after === 'string' && /^\d+$/.test(req.query.after) ? req.query.after : undefined;
    res.json({ messages: await listMessages(g.groupId!, after) });
  } catch (err) { next(err); }
});

router.post('/groups/:code/chat', requireIntercomClientAuth, async (req, res, next) => {
  try {
    const g = await chatGroup(req.intercomClientUser!.id, req.params.code);
    if (g.error === 404) return res.status(404).json({ error: 'Not one of your groups' });
    if (g.error === 403) return res.status(403).json({ error: 'Chat is off for this group' });
    const text = req.body?.text;
    if (typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
    const u = req.intercomClientUser!;
    res.json(await postMessage(g.groupId!, { extension: u.extension, name: u.name }, text));
  } catch (err) { next(err); }
});

// A group's live transcript (written by the transcriber service), readable
// by anyone with a button for that group whether or not they've joined it.
// `?after=<id>` returns only newer lines -the client polls this way.
// `transcribing` tells the client whether to show the panel at all.
// The group's latest shift summaries (#29), for anyone with a button for it,
// joined or not, like the transcript.
router.get('/groups/:code/summaries', requireIntercomClientAuth, async (req, res, next) => {
  try {
    const buttons = await listButtons(req.intercomClientUser!.id);
    if (!buttons.some((b) => b.button_type === 'group' && b.target_group_dial_code === req.params.code)) {
      return res.status(404).json({ error: 'Not one of your groups' });
    }
    const s = await getSettings();
    const list = await listSummaries({ code: req.params.code, limit: 5 });
    res.json(list.map((x) => ({ id: x.id, shift_start: x.shift_start, shift_end: x.shift_end, summary: x.summary, partial: x.partial,
      label: summaryLabel(x, s) })));
  } catch (err) { next(err); }
});

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
