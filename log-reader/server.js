// log-reader: the only Parley container with the podman API socket (#37).
//
// The Health page's log viewer used to mount the socket into
// controller-backend, which gave anything that took over the backend control
// of every container and volume on the host. Now the backend asks this
// service instead, and all it will do is return the last N lines of one of
// Parley's own containers:
//   GET /logs/<service>?lines=N   Authorization: Bearer $INTERNAL_API_TOKEN
// It builds the podman request itself from a fixed list, so nothing a caller
// sends can reach any other part of the podman API (inspect, env, exec...).
// No dependencies; not published on any host port.
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 9300);
const SOCKET = process.env.PODMAN_SOCKET_PATH || '/run/podman/podman.sock';
const TOKEN = process.env.INTERNAL_API_TOKEN || '';
if (TOKEN.length < 32) { console.error('INTERNAL_API_TOKEN must be set (32+ characters)'); process.exit(1); }

const CONTAINERS = {
  postgres: 'parley-postgres',
  'controller-backend': 'parley-controller-backend',
  'controller-frontend': 'parley-controller-frontend',
  'pbx-core': 'parley-pbx-core',
  rtpengine: 'parley-rtpengine',
  freeswitch: 'parley-freeswitch',
  transcriber: 'parley-transcriber',
};

function authorised(req) {
  const got = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
  if (!authorised(req)) return send(res, 401, { error: 'Unauthorised' });
  const url = new URL(req.url, 'http://x');
  const m = /^\/logs\/([a-z-]+)$/.exec(url.pathname);
  if (req.method !== 'GET' || !m) return send(res, 404, { error: 'Not found' });
  const name = Object.prototype.hasOwnProperty.call(CONTAINERS, m[1]) ? CONTAINERS[m[1]] : null;
  if (!name) return send(res, 404, { error: 'Unknown service' });
  const lines = Math.min(Math.max(parseInt(url.searchParams.get('lines') || '100', 10) || 100, 1), 1000);

  const up = http.request({
    socketPath: SOCKET, method: 'GET', timeout: 10_000,
    path: `/v4.0.0/libpod/containers/${name}/logs?stdout=true&stderr=true&tail=${lines}`,
  }, (r) => {
    res.writeHead(r.statusCode || 502, { 'Content-Type': 'application/octet-stream' });
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('podman socket timed out')));
  up.on('error', (e) => { if (!res.headersSent) send(res, 502, { error: e.message }); else res.destroy(); });
  up.end();
}).listen(PORT, () => console.log(`log-reader on :${PORT}, ${Object.keys(CONTAINERS).length} containers`));
