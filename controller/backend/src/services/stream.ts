// src/services/stream.ts
// A server-sent-events response (issue #12): `data: <json>` per update and a
// comment every HEARTBEAT_MS, so nginx (proxy_read_timeout) and browsers keep
// the connection open. X-Accel-Buffering: no stops nginx holding updates
// back. Clients read it with fetch(), so the Authorization header still
// carries the token (EventSource can't send one).
import { Request, Response } from 'express';

const HEARTBEAT_MS = 15_000;

export function openStream(req: Request, res: Response, subscribe: (send: (json: string) => void) => () => void) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const unsubscribe = subscribe((json) => { res.write(`data: ${json}\n\n`); });
  const heartbeat = setInterval(() => res.write(': hb\n\n'), HEARTBEAT_MS);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
}
