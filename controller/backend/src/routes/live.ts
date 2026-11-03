// src/routes/live.ts
// Read-only "what's true right now" status for the console's Live view —
// registrations + in-progress calls, polled live from pbx-core. See
// services/pbxCoreService.ts.
import { Router } from 'express';
import { requireAuth } from '../middleware/session';
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
      const r = await fetch(`${config.transcriberUrl}/talking`, { signal: AbortSignal.timeout(500) });
      talking = ((await r.json()) as { talking: { group: string; extension: string }[] }).talking;
    } catch { /* transcriber down */ }
    res.json({ ...status, talking });
  } catch (err) { next(err); }
});

export default router;
