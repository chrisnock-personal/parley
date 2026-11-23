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
import { query } from '../db/pool';

const router = Router();
router.use(requireAuth);

// Plus who's talking right now (group dial code + extension), from the
// transcriber; best-effort, so a transcriber that's down means nobody shows
// as talking rather than an error.
router.get('/', async (_req, res, next) => {
  try { res.json(await getSnapshot()); } catch (err) { next(err); }
});

// The same, pushed whenever it changes (issue #12).
router.get('/stream', (req, res) => {
  const u = req.user!;
  openStream(req, res, (send) => subscribeConsole(send), {
    exp: (u as unknown as { exp?: number }).exp,
    stillAllowed: async () => {
      const r = await query<{ ok: boolean }>(`SELECT is_active AS ok FROM users WHERE id = $1`, [u.id]);
      return !!r.rows[0]?.ok;
    },
  });
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
    // Saved first (issue #19): pbx-core loads these at start and every
    // minute, so a mute outlives a pbx-core restart.
    if (muted) {
      await query(`INSERT INTO intercom_group_mutes (group_id, extension, muted_by) VALUES ($1, $2, $3)
                   ON CONFLICT (group_id, extension) DO UPDATE SET muted_by = $3, muted_at = now()`, [g.id, extension, req.user!.email]);
    } else {
      await query(`DELETE FROM intercom_group_mutes WHERE group_id = $1 AND extension = $2`, [g.id, extension]);
    }
    const r = await pbxCore.setMute(group, extension, muted, req.user!.email);
    await audit(req.user!.email, 'group', g.id, 'update', { member: who, muted });
    res.json({ ok: true, applied: r.applied });
  } catch (err) { next(err); }
});

export default router;
