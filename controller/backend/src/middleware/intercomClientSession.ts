// src/middleware/intercomClientSession.ts
// Intercom client login is a SEPARATE auth path from the console operator
// session (session.ts) -a directory user (a person answering calls at a
// desk) has no console role/permissions. Both token kinds are signed with
// the same JWT_SECRET, so the `scope` discriminator below is a one-line but
// real hardening step: without it, a console operator's JWT would silently
// pass requireIntercomClientAuth and vice versa.
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import { clientUserEnabled } from '../services/sessionCheck';

export interface IntercomClientSessionUser {
  id: string;
  extension: string;
  name: string;
  scope: 'intercom-client';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { intercomClientUser?: IntercomClientSessionUser; } }
}

function extractToken(req: Request): string | null {
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.intercom_client_session;
  if (cookie) return cookie;
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

export async function requireIntercomClientAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) { res.status(401).json({ error: 'Unauthorised' }); return; }
    const payload = jwt.verify(token, config.jwtSecret) as IntercomClientSessionUser;
    if (payload.scope !== 'intercom-client') { res.status(401).json({ error: 'Invalid session' }); return; }
    // Still allowed to log in (issue #25): a token outlives turning a login off.
    if (!(await clientUserEnabled(payload.id))) { res.status(401).json({ error: 'This login has been turned off' }); return; }
    req.intercomClientUser = payload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }
  next();
}

export function signIntercomClientToken(user: Omit<IntercomClientSessionUser, 'scope'>): string {
  return jwt.sign({ ...user, scope: 'intercom-client' }, config.jwtSecret, { expiresIn: config.jwtTtl } as jwt.SignOptions);
}
