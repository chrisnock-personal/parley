// src/services/stream.ts
// A server-sent-events response (issue #12): `data: <json>` per update and a
// comment every HEARTBEAT_MS, so nginx (proxy_read_timeout) and browsers keep
// the connection open. X-Accel-Buffering: no stops nginx holding updates
// back. Clients read it with fetch(), so the Authorization header still
// carries the token (EventSource can't send one).
import { Request, Response } from 'express';

const HEARTBEAT_MS = 15_000;
const RECHECK_MS = 60_000;

export interface StreamAuth {
  /** The token's expiry (JWT exp, seconds since the epoch): the stream ends then. */
  exp?: number;
  /** Whether the user may still see this (exists, enabled): asked every minute. */
  stillAllowed: () => Promise<boolean>;
}

// A stream outlives the one check made when it opens, so it re-checks
// (issue #20): it ends when the token expires, and when stillAllowed() says
// the user has been disabled or removed. The client then falls back to the
// REST route, which applies its own check.
export async function openStream(req: Request, res: Response, subscribe: (send: (json: string) => void) => () => void, auth: StreamAuth) {
  // Checked when it opens too, or a disabled user's client would just
  // reconnect (its token is still valid) and be cut off a minute later, over and over.
  if (!(await auth.stillAllowed().catch(() => false))) { res.status(401).json({ error: 'Session no longer valid' }); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const unsubscribe = subscribe((json) => { res.write(`data: ${json}\n\n`); });
  const heartbeat = setInterval(() => res.write(': hb\n\n'), HEARTBEAT_MS);
  let ended = false;
  const end = () => { if (!ended) { ended = true; res.end(); } };
  const untilExpiry = auth.exp ? auth.exp * 1000 - Date.now() : Infinity;
  // setTimeout can't take more than ~24.8 days; tokens last far less.
  const expiry = Number.isFinite(untilExpiry) ? setTimeout(end, Math.max(0, Math.min(untilExpiry, 2 ** 31 - 1))) : null;
  const recheck = setInterval(() => { auth.stillAllowed().then((ok) => { if (!ok) end(); }).catch(() => { /* a DB blip: try again next time */ }); }, RECHECK_MS);
  req.on('close', () => { ended = true; clearInterval(heartbeat); clearInterval(recheck); if (expiry) clearTimeout(expiry); unsubscribe(); });
}
