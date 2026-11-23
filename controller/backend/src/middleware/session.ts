// src/middleware/session.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import { consoleUserState } from '../services/sessionCheck';

export interface SessionUser { id: string; email: string; role: string; }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { user?: SessionUser; } }
}

function extractToken(req: Request): string | null {
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.intercom_session;
  if (cookie) return cookie;
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // NB: Walk the Nxt Floor also accepts an x-api-key here via apiKeyService.
  // Layer that in the same way if machine clients need non-JWT access.
  try {
    const token = extractToken(req);
    if (!token) { res.status(401).json({ error: 'Unauthorised' }); return; }
    const payload = jwt.verify(token, config.jwtSecret) as SessionUser & { scope?: string };
    // Intercom client tokens (signIntercomClientToken, intercomClientSession.ts)
    // share this same JWT_SECRET and are scoped 'intercom-client' precisely so
    // they can be told apart from a console operator's token here -a directory
    // user has no console role/permissions at all. See intercomClientSession.ts's
    // matching check.
    if (payload.scope === 'intercom-client') { res.status(401).json({ error: 'Invalid session' }); return; }
    // Still active, and the role as it is now, not as it was at login (issue #25).
    const state = await consoleUserState(payload.id);
    if (!state.active || !state.role) { res.status(401).json({ error: 'This account is no longer active' }); return; }
    req.user = { id: payload.id, email: payload.email, role: state.role };
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) { res.status(401).json({ error: 'Unauthorised' }); return; }
    if (!roles.includes(req.user.role)) { res.status(403).json({ error: 'Insufficient permissions' }); return; }
    next();
  };
}

export function signToken(user: SessionUser): string {
  return jwt.sign(user, config.jwtSecret, { expiresIn: config.jwtTtl } as jwt.SignOptions);
}
