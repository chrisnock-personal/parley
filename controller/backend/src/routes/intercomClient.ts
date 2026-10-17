// src/routes/intercomClient.ts -login + self for the browser intercom client page.
import { Router } from 'express';
import config from '../config';
import { requireIntercomClientAuth, signIntercomClientToken } from '../middleware/intercomClientSession';
import { authenticateDirectoryUser, listButtons } from '../services/directoryUserService';
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

// Who is in each of this user's groups right now, Eyevinn-style, so a
// group's strip can list its participants whether or not you've joined it.
// Comes straight from pbx-core's in-memory call list (each group call is
// one member's leg into the FreeSWITCH conference), enriched with names by
// getLiveStatus(). Only groups this user has a button for are returned.
// Polled by the client every few seconds; pbx-core being unreachable is a
// 502 the client just skips, never an error dialog.
router.get('/groups/participants', requireIntercomClientAuth, async (req, res, next) => {
  try {
    const buttons = await listButtons(req.intercomClientUser!.id);
    const mine = new Set(buttons.filter((b) => b.button_type === 'group' && b.target_group_dial_code)
      .map((b) => b.target_group_dial_code!));
    let live;
    try { live = await getLiveStatus(); }
    catch { return res.status(502).json({ error: 'pbx-core unreachable' }); }
    const participants: Record<string, { extension: string; name: string }[]> = {};
    for (const code of mine) participants[code] = [];
    for (const c of live.calls) {
      if (c.kind === 'group' && mine.has(c.to)) participants[c.to].push({ extension: c.from, name: c.fromName });
    }
    res.json({ participants });
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
