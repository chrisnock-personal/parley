// src/routes/live.ts
// Read-only "what's true right now" status for the console's Live view —
// registrations + in-progress calls, polled live from pbx-core. See
// services/pbxCoreService.ts.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/session';
import { audit } from '../services/auditService';
import { listGroups } from '../services/groupService';
import { listDirectoryUsers } from '../services/directoryUserService';
import * as pbxCore from '../services/pbxCoreService';
import { getSnapshot, subscribeConsole } from '../services/liveHub';
import { openStream } from '../services/stream';

const router = Router();
router.use(requireAuth);

// Plus who's talking right now (group dial code + extension), from the
// transcriber; best-effort, so a transcriber that's down means nobody shows
// as talking rather than an error.
router.get('/', async (_req, res, next) => {
  try { res.json(await getSnapshot()); } catch (err) { next(err); }
});

// The same, pushed whenever it changes (issue #12).
router.get('/stream', (req, res) => { openStream(req, res, (send) => subscribeConsole(send)); });

// Remote mute (issue #9): { group: dial code, extension, muted }. Editors and
// admins; audited against the group. The person still hears the group.
router.post('/mute', requireRole('admin', 'editor'), async (req, res, next) => {
  try {
    const { group, extension, muted } = req.body ?? {};
    if (typeof group !== 'string' || typeof extension !== 'string' || typeof muted !== 'boolean') {
      return res.status(400).json({ error: 'group, extension and muted are required' });
    }
    const [groups, users] = await Promise.all([listGroups(), listDirectoryUsers()]);
    const g = groups.find((x) => x.dial_code === group);
    if (!g) return res.status(404).json({ error: 'No such group' });
    const who = users.find((u) => u.extension === extension)?.name ?? extension;
    const r = await pbxCore.setMute(group, extension, muted, req.user!.email);
    await audit(req.user!.email, 'group', g.id, 'update', { member: who, muted });
    res.json({ ok: true, applied: r.applied });
  } catch (err) { next(err); }
});

export default router;
