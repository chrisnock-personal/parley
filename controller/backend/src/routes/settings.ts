// src/routes/settings.ts -global settings (SIP-REC recording server,
// transcript retention). Admin-only: both are compliance decisions.
import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/session';
import { audit } from '../services/auditService';
import * as settings from '../services/settingsService';

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

export default router;
