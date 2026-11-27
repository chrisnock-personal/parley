// Regression test for issue #43: a client whose directory user has been
// deleted (or whose context load otherwise fails) must not reject the live
// hub's interval callback, which Node 22 treats as fatal. No DB or services
// are needed -the DB-backed service modules are stubbed before liveHub is
// loaded. Run with `npm test` from controller/backend.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

require('ts-node').register({ compilerOptions: { module: 'commonjs' }, transpileOnly: true });

const src = (rel) => path.resolve(__dirname, '..', 'src', rel);

// A module that lives only in require.cache: config normally refuses to load
// without real secrets, and none of that matters to the live hub.
function fakeConfig() {
  const filename = src('config.ts');
  const m = new Module(filename, module);
  m.filename = filename;
  m.loaded = true;
  m.exports = {
    __esModule: true,
    default: {
      transcriberUrl: 'http://transcriber.test', internalToken: 'test-token',
      pgHost: '127.0.0.1', pgPort: 5432, pgDatabase: 'test', pgUser: 'test',
      pgPassword: 'test', pgPoolMax: 1, pgSsl: false,
    },
  };
  require.cache[filename] = m;
}

// Load the real service module, then replace the functions liveHub calls.
function stub(rel, overrides) {
  const filename = src(rel);
  require(filename);
  Object.assign(require.cache[filename].exports, overrides);
}

const GOOD = { id: 'good-user', name: 'Good User', extension: '1001', enabled: true,
  siprec_enabled: false, created_at: '', updated_at: '' };
const GROUP_BUTTON = { id: 'button-1', directory_user_id: GOOD.id, button_type: 'group',
  target_group_id: 'group-1', target_group_name: 'Floor A', target_group_dial_code: 'floor-a',
  target_group_mode: 'talkback' };

const latestCalls = [];

fakeConfig();
stub('services/directoryUserService.ts', {
  listButtons: async (userId) => userId === GOOD.id ? [GROUP_BUTTON] : [],
  getDirectoryUser: async (userId) => {
    if (userId !== GOOD.id) throw new Error('Directory user not found');
    return GOOD;
  },
  avatarVersions: async () => ({}),
});
stub('services/settingsService.ts', { getSettings: async () => ({ siprec_srs_uri: null }) });
stub('services/groupService.ts', { talkersByDialCode: async () => ({}) });
stub('services/chatService.ts', { latestIds: async (ids) => { latestCalls.push(ids); return {}; } });
stub('services/pbxCoreService.ts', {
  getLiveStatus: async () => ({ registrations: [], calls: [] }),
});

const liveHub = require('../src/services/liveHub.ts');

test('a client with no loadable context does not stop other clients receiving updates', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ json: async () => ({ talking: [] }) });
  t.after(() => { global.fetch = originalFetch; });

  const received = [];
  let resolveGood;
  const goodReceived = new Promise((resolve) => { resolveGood = resolve; });

  // Both subscriptions happen in the same turn, so the first tick sees both
  // clients: the deleted one has no cached context, the other has a group.
  const stopBad = liveHub.subscribeClient('deleted-user', '1000',
    (json) => received.push({ who: 'bad', payload: JSON.parse(json) }));
  const stopGood = liveHub.subscribeClient(GOOD.id, GOOD.extension, (json) => {
    received.push({ who: 'good', payload: JSON.parse(json) });
    resolveGood();
  });
  t.after(() => { stopBad(); stopGood(); });

  let timer;
  try {
    await Promise.race([
      goodReceived,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('good client never received a live update')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  const good = received.find((r) => r.who === 'good');
  assert.ok(good, 'the healthy client got a payload');
  assert.deepEqual(good.payload.participants, { 'floor-a': [] });
  assert.deepEqual(good.payload.latest, { 'floor-a': { chat: null, transcript: null } });
  assert.equal(received.some((r) => r.who === 'bad'), false, 'no payload for a client with no context');
  assert.ok(latestCalls.some((ids) => ids.includes('group-1')), 'healthy client groups still queried');
});
