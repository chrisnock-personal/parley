// Regression test for issue #35 L1: PGSSL=true used to set
// rejectUnauthorized: false, accepting any certificate. Inspect the Pool
// options only -pg's Pool does not connect until a query is made. Built
// dist/ is used (npm test builds first), so no DB or network is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENV_KEYS = [
  'JWT_SECRET', 'ADMIN_PASSWORD', 'PGPASSWORD', 'INTERNAL_API_TOKEN',
  'PGSSL', 'PGSSL_CA', 'PGSSL_INSECURE',
];
const saved = new Map(ENV_KEYS.filter((k) => k in process.env).map((k) => [k, process.env[k]]));
test.after(() => {
  for (const key of ENV_KEYS) {
    if (saved.has(key)) process.env[key] = saved.get(key);
    else delete process.env[key];
  }
});

function loadPool(env = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    JWT_SECRET: 'x'.repeat(40),
    ADMIN_PASSWORD: 'x'.repeat(20),
    PGPASSWORD: 'x'.repeat(20),
    INTERNAL_API_TOKEN: 'x'.repeat(40),
  }, env);
  const configPath = require.resolve('../dist/config.js');
  const poolPath = require.resolve('../dist/db/pool.js');
  delete require.cache[configPath];
  delete require.cache[poolPath];
  return require('../dist/db/pool.js');
}

function sslOf(env) {
  return loadPool(env).pool.options.ssl;
}

test('TLS off leaves ssl disabled (unchanged behaviour)', () => {
  assert.equal(sslOf({}), false);
  assert.equal(sslOf({ PGSSL: 'false', PGSSL_INSECURE: '1' }), false);
});

test('PGSSL=true verifies the server certificate by default', () => {
  assert.deepEqual(sslOf({ PGSSL: 'true' }), { rejectUnauthorized: true });
});

test('PGSSL_CA is loaded as the trusted CA and verification stays on', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parley-pg-ca-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const caPath = path.join(dir, 'ca.pem');
  const pem = '-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----\n';
  fs.writeFileSync(caPath, pem);

  const ssl = sslOf({ PGSSL: 'true', PGSSL_CA: caPath });
  assert.equal(ssl.rejectUnauthorized, true);
  assert.ok(Buffer.isBuffer(ssl.ca), 'CA should be passed to pg as a Buffer');
  assert.equal(ssl.ca.toString(), pem);
});

test('PGSSL_INSECURE=1 is an explicit opt-out with a loud warning', (t) => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => { console.warn = originalWarn; });

  assert.deepEqual(sslOf({ PGSSL: 'true', PGSSL_INSECURE: '1' }), { rejectUnauthorized: false });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /PGSSL_INSECURE/);
  assert.match(warnings[0], /NOT verified/);
});

test('a bad PGSSL_CA path fails clearly instead of silently downgrading', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parley-pg-ca-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = path.join(dir, 'no-such-ca.pem');

  assert.throws(
    () => sslOf({ PGSSL: 'true', PGSSL_CA: missing }),
    (err) => err instanceof Error && err.message.includes('PGSSL_CA') && err.message.includes(missing),
  );
});
