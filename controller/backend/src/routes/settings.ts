// src/routes/settings.ts -global settings (SIP-REC recording server,
// transcript retention). Admin-only: both are compliance decisions.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/session';
import { audit } from '../services/auditService';
import * as settings from '../services/settingsService';
import { forgetHostKey, pinnedHostKeys } from '../services/archiveTransfer';

const router = Router();
router.use(requireAuth, requireRole('admin'));

router.get('/', async (_req, res, next) => {
  try { res.json(await settings.getSettings()); } catch (err) { next(err); }
});

router.patch('/', async (req, res, next) => {
  try {
    const updated = await settings.updateSettings(req.user!.email, req.body ?? {});
    await audit(req.user!.email, 'settings', '00000000-0000-0000-0000-000000000000', 'update', req.body);
    res.json(updated);
  } catch (err) { next(err); }
});

// The archive SCP server's pinned host key (#30): what's pinned, and
// forgetting it after a legitimate rebuild.
router.get('/archive-host-key', async (_req, res, next) => {
  try {
    const t = (await settings.getSettings()).archive_transfer;
    if (t.type !== 'scp' || !t.host) return res.json({ host: null, fingerprints: [] });
    res.json({ host: t.host, port: t.port ?? 22, fingerprints: await pinnedHostKeys(t.host, t.port ?? 22) });
  } catch (err) { next(err); }
});

router.delete('/archive-host-key', async (req, res, next) => {
  try {
    const t = (await settings.getSettings()).archive_transfer;
    if (t.type !== 'scp' || !t.host) return res.status(400).json({ error: 'Archiving isn\'t set to SCP' });
    await forgetHostKey(t.host, t.port ?? 22);
    await audit(req.user!.email, 'settings', '00000000-0000-0000-0000-000000000000', 'update', { forgot_host_key: t.host });
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
