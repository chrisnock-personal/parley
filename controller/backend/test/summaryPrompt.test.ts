// Focused check for #42: what actually goes to the model when a shift is
// summarised. No DB, no network, no new dependencies -run with
//   node -r ts-node/register --test test/summaryPrompt.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_TEMPERATURE, SYSTEM_PROMPT, buildSummaryRequest, formatSummaryLines } from '../src/services/summaryPrompt';

const lines = [
  { at: new Date('2026-11-24T09:00:00Z'), name: 'Producer', extension: '1111', kind: 'said' as const, text: 'Move the package after the interview.' },
  { at: new Date('2026-11-24T09:01:00Z'), name: 'Editor', extension: '1112', kind: 'said' as const, text: 'The intro package stays in the studio.' },
  { at: new Date('2026-11-24T09:02:00Z'), name: 'Chef', extension: '1113', kind: 'typed' as const, text: 'Chef is in the studio kitchen, mic check done' },
  { at: new Date('2026-11-24T09:03:00Z'), name: 'Producer', extension: '1111', kind: 'typed' as const, text: 'Interview is clear.' },
];

const payload = buildSummaryRequest('Production', lines, 'UTC', 'qwen2.5:7b');
const [system, user] = payload.messages;

test('prompt asks for exact item names and every typed note', () => {
  assert.equal(system.role, 'system');
  assert.equal(system.content, SYSTEM_PROMPT);
  assert.match(system.content, /exact names of items/i);
  assert.match(system.content, /never rename/i);
  assert.match(system.content, /Include every typed note/i);
  assert.match(system.content, /don't leave one out/i);
});

test('every line, including typed notes, is in the model input verbatim', () => {
  assert.equal(user.role, 'user');
  assert.match(user.content, /^Group: Production\n\n/);
  for (const l of lines) {
    assert.ok(user.content.includes(l.text), `missing line text: ${l.text}`);
    assert.ok(user.content.includes(`${l.name} (${l.kind === 'typed' ? 'typed note' : 'said'}): ${l.text}`));
  }
  assert.ok(user.content.includes('the package after the interview'));
  assert.ok(user.content.includes('The intro package stays'));
  assert.equal(user.content.trim().split('\n').length, lines.length + 2);
});

test('source-line formatting matches what is sent to the model', () => {
  const formatted = formatSummaryLines(lines, 'UTC');
  assert.equal(user.content, `Group: Production\n\n${formatted}`);
  assert.match(formatted.split('\n')[0], /^\[09:00\] Producer \(said\): /);
  assert.ok(formatted.includes('[09:02] Chef (typed note): Chef is in the studio kitchen, mic check done'));
});

test('uses a low temperature and leaves the model choice to configuration', () => {
  assert.equal(payload.model, 'qwen2.5:7b');
  assert.equal(payload.stream, false);
  assert.ok(SUMMARY_TEMPERATURE > 0 && SUMMARY_TEMPERATURE <= 0.1);
  assert.deepEqual(payload.options, { temperature: SUMMARY_TEMPERATURE });
});
