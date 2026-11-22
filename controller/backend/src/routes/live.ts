// src/routes/live.ts
// Read-only "what's true right now" status for the console's Live view —
// registrations + in-progress calls, polled live from pbx-core. See
// services/pbxCoreService.ts.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/session';
import { audit } from '../services/auditService';
import { listGroups } from '../services/groupService';
import { listDirectoryUsers } from '../services/directoryUserService';
import config from '../config';
import * as pbxCore from '../services/pbxCoreService';

const router = Router();
router.use(requireAuth);

// Plus who's talking right now (group dial code + extension), from the
// transcriber; best-effort, so a transcriber that's down means nobody shows
// as talking rather than an error.
router.get('/', async (_req, res, next) => {
  try {
    const status = await pbxCore.getLiveStatus();
    let talking: { group: string; extension: string }[] = [];
    try {
      const r = await fetch(`${config.transcriberUrl}/talking`, {
        signal: AbortSignal.timeout(500),
        headers: { Authorization: `Bearer ${config.internalToken}` },
      });
      talking = ((await r.json()) as { talking: { group: string; extension: string }[] }).talking;
    } catch { /* transcriber down */ }
    res.json({ ...status, talking });
  } catch (err) { next(err); }
});

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
