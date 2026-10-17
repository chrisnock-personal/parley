// src/routes/intercomClient.ts -login + self for the browser intercom client page.
import { Router } from 'express';
import config from '../config';
import { requireIntercomClientAuth, signIntercomClientToken } from '../middleware/intercomClientSession';
import { authenticateDirectoryUser, listButtons } from '../services/directoryUserService';
import { audit } from '../services/auditService';
import { recordIntercomClientCallStart, recordIntercomClientCallEnd } from '../services/pbxService';

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
