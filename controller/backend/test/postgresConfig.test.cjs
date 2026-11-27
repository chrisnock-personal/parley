// Config parsing checks for the Postgres TLS knobs added in issue #35 L1.
// config.ts requires secrets at load time, so each load gets valid dummy
// secrets; the built dist/config.js is re-required per case. No DB or network.
const test = require('node:test');
const assert = require('node:assert/strict');

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

function loadConfig(env = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    JWT_SECRET: 'x'.repeat(40),
    ADMIN_PASSWORD: 'x'.repeat(20),
    PGPASSWORD: 'x'.repeat(20),
    INTERNAL_API_TOKEN: 'x'.repeat(40),
  }, env);
  const configPath = require.resolve('../dist/config.js');
  delete require.cache[configPath];
  return require('../dist/config.js').default;
}

test('Postgres TLS settings default to off, no CA, verification on', () => {
  const config = loadConfig();
  assert.equal(config.pgSsl, false);
  assert.equal(config.pgSslCa, '');
  assert.equal(config.pgSslInsecure, false);
});

test('PGSSL_CA is parsed as a path and PGSSL_INSECURE accepts 1 or true', () => {
  const ca = '/etc/ssl/certs/postgres-ca.pem';
  for (const flag of ['1', 'true']) {
    const config = loadConfig({ PGSSL: 'true', PGSSL_CA: ca, PGSSL_INSECURE: flag });
    assert.equal(config.pgSsl, true);
    assert.equal(config.pgSslCa, ca);
    assert.equal(config.pgSslInsecure, true, `${flag} should enable the opt-out`);
  }
});

test('unrecognised PGSSL_INSECURE values fail closed', () => {
  for (const flag of ['0', 'false', 'yes', 'TRUE ']) {
    assert.equal(
      loadConfig({ PGSSL: 'true', PGSSL_INSECURE: flag }).pgSslInsecure,
      false,
      `${JSON.stringify(flag)} must not disable verification`,
    );
  }
});

test('only the exact string true enables PGSSL', () => {
  assert.equal(loadConfig({ PGSSL: 'TRUE' }).pgSsl, false);
  assert.equal(loadConfig({ PGSSL: '1' }).pgSsl, false);
  assert.equal(loadConfig({ PGSSL: 'true' }).pgSsl, true);
});
