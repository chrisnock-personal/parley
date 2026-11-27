// Minimal read-only HTTP introspection server -no framework dependency,
// just Node's built-in http, for the one thing the console's "Live" view
// needs: what's registered right now, and what calls are in progress right
// now. Deliberately does not touch SIP routing or persist anything; pbx-core
// stays database-free exactly as before.

import { createServer } from 'http';
import * as registrar from './registrar';
import * as calls from './calls';
import * as mutes from './mutes';
import * as rtp from './rtpengine';
import { config } from './config';
import { hasBearer } from './internalAuth';

export function startAdminServer(port: number): void {
  createServer((req, res) => {
    if (!hasBearer(req, config.admin.token)) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Group calls carry their member's remote mute, if any (issue #9).
      const all = calls.all().map((c) => (c.kind === 'group' ? { ...c, muted: mutes.get(c.to, c.from) } : c));
      res.end(JSON.stringify({ registrations: registrar.all(), calls: all }));
      return;
    }
    // Remote mute (issue #9): { group, extension, muted, by }. Kept until
    // unmuted, and applied now to that member's leg if they're in the group.
    if (req.method === 'POST' && req.url === '/mute') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
      req.on('end', async () => {
        try {
          const { group, extension, muted, by } = JSON.parse(body || '{}');
          if (typeof group !== 'string' || typeof extension !== 'string' || typeof muted !== 'boolean') {
            res.writeHead(400); res.end(JSON.stringify({ error: 'group, extension and muted are required' })); return;
          }
          if (muted) mutes.set(group, extension, typeof by === 'string' ? by : 'console');
          else mutes.clear(group, extension);
          const legs = calls.all().filter((c) => c.kind === 'group' && c.to === group && c.from === extension);
          // A listener stays blocked when unmuted (issue #21).
          for (const c of legs) if (muted || !c.listener) await rtp.setBlocked(c.callId, c.callerTag, muted);
          console.log(`[mute] ${extension} in ${group} ${muted ? `muted by ${by}` : 'unmuted'} (${legs.length} leg(s) now)`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, applied: legs.length }));
        } catch (err: any) {
          res.writeHead(500); res.end(JSON.stringify({ error: err?.message || String(err) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  }).listen(port, config.admin.host, () => console.log(`admin HTTP listening on ${config.admin.host}:${port}`));
}
