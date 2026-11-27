// Regression test for #44: two simultaneous POST /admin/db/archive requests
// with identical bodies used to share one deterministic /tmp filename. The
// slow request is held in psql until the fast one has encrypted (and therefore
// deleted) its plaintext; with the old code that unlinked the slow request's
// file too, and both gzip streams wrote to the same path.
//
// No new dependencies: node:test, the installed express/ts-node, and mocks
// for psql/age/transfer. Run with `npm test` in controller/backend.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const Module = require('node:module');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

require('ts-node/register/transpile-only');

const originalTmpdir = os.tmpdir;
const originalExecFile = childProcess.execFile;
const originalSpawn = childProcess.spawn;
const sandbox = fs.mkdtempSync(path.join(originalTmpdir(), 'parley-archive-race-'));
os.tmpdir = () => sandbox;

const als = new AsyncLocalStorage();
let releaseSlow;
const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
const ageInputs = [];
const transfers = [];

childProcess.execFile = function fakeExecFile(cmd, args, options, callback) {
  if (cmd !== 'age') return originalExecFile.apply(this, arguments);
  const token = als.getStore();
  const out = args[args.indexOf('-o') + 1];
  const input = args[args.length - 1];
  ageInputs.push({ token, input, out, existed: fs.existsSync(input) });
  // Stand-in for `age -o`: copy the gzip bytes so the transfer can be checked.
  fs.writeFileSync(out, fs.readFileSync(input));
  process.nextTick(() => {
    callback(null, '', '');
    // Let encryptFile()'s finally remove the plaintext before the slow
    // request is allowed to continue writing.
    if (token === 'fast') setTimeout(releaseSlow, 10);
  });
};

childProcess.spawn = function fakeSpawn(cmd) {
  if (cmd !== 'psql') return originalSpawn.apply(this, arguments);
  const token = als.getStore();
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  setImmediate(async () => {
    proc.stdout.write(`-- request ${token}\n`);
    if (token === 'slow') await slowGate;
    proc.stdout.write(`row from ${token}\n`);
    proc.stdout.end();
    proc.emit('close', 0);
  });
  return proc;
};

function stub(relPath, exports) {
  const filename = require.resolve(relPath);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[filename] = mod;
}

stub('../src/config.ts', {
  __esModule: true,
  default: { pgHost: '127.0.0.1', pgPort: 5432, pgUser: 'test', pgDatabase: 'test', pgPassword: 'x'.repeat(20) },
});
stub('../src/middleware/session.ts', {
  requireAuth: (req, _res, next) => { req.user = { email: 'admin@parley.local' }; next(); },
  requireRole: () => (_req, _res, next) => next(),
});
stub('../src/db/pool.ts', {
  query: async (sql) => {
    if (sql.includes('information_schema.columns')) return { rows: [{ column_name: 'id' }] };
    if (sql.includes('count(*)')) return { rows: [{ n: '7' }] };
    throw new Error(`unexpected query: ${sql}`);
  },
});
stub('../src/services/auditService.ts', { audit: async () => {} });
stub('../src/services/settingsService.ts', { getSettings: async () => ({ backup_recipient: 'age1testrecipient' }) });
stub('../src/services/archiveTransfer.ts', {
  sendArchive: async (file, name, transfer) => {
    transfers.push({ file, name, transfer, content: zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') });
    return `Copied to ${name}`;
  },
});

const router = require('../src/routes/admin.ts').default;
const layer = router.stack.find((l) => l.route && l.route.path === '/db/archive');
assert.ok(layer, 'db/archive route not found');
const handler = layer.route.stack[0].handle;

function runArchive(token) {
  const req = {
    body: { days: 90, transfer: { type: 'local', path: 'archives/' } },
    user: { email: 'admin@parley.local' },
  };
  let status = 200;
  let body;
  let nextError;
  const res = {
    status(code) { status = code; return this; },
    json(value) { body = value; return this; },
    setHeader() { return this; },
  };
  return als.run(token, async () => {
    await handler(req, res, (err) => { if (err) nextError = err; });
    if (nextError) throw nextError;
    assert.equal(status, 200);
    assert.ok(body, 'route did not send a response');
    return body;
  });
}

test('concurrent archives get distinct temp files and keep their own contents', { timeout: 15000 }, async () => {
  const [fast, slow] = await Promise.all([runArchive('fast'), runArchive('slow')]);

  // The user-visible name, including the .age suffix, must be unchanged.
  const date = new Date().toISOString().slice(0, 10);
  const expectedName = `parley-archive-${date}-90d.sql.gz.age`;
  assert.equal(fast.archive_name, expectedName);
  assert.equal(slow.archive_name, expectedName);

  assert.equal(ageInputs.length, 2, 'both requests should encrypt once');
  assert.equal(new Set(ageInputs.map((a) => a.input)).size, 2, 'plaintext paths must differ');
  assert.equal(new Set(ageInputs.map((a) => a.out)).size, 2, 'encrypted paths must differ');
  assert.ok(ageInputs.every((a) => a.existed), 'each request must encrypt a plaintext that still exists');

  assert.equal(transfers.length, 2, 'both requests should transfer their file');
  assert.notEqual(transfers[0].file, transfers[1].file, 'transfer source paths must differ');
  for (const token of ['fast', 'slow']) {
    const own = transfers.find((t) => t.content.includes(`-- request ${token}`));
    const other = token === 'fast' ? 'slow' : 'fast';
    assert.ok(own, `no transferred archive for ${token}`);
    assert.equal(own.name, expectedName);
    assert.ok(!own.content.includes(`-- request ${other}`), `${token}'s archive contains ${other}'s data`);
  }

  assert.deepEqual(fs.readdirSync(sandbox), [], 'request temp directories must be cleaned up');
});

test.after(() => {
  os.tmpdir = originalTmpdir;
  childProcess.execFile = originalExecFile;
  childProcess.spawn = originalSpawn;
  fs.rmSync(sandbox, { recursive: true, force: true });
});
