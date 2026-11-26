// Focused checks for #41: a partial summary keeps the THIS SHIFT treatment
// only while its shift is actually running. Built with `npx tsc -p .` first.
const assert = require('node:assert/strict');
const test = require('node:test');
const { currentShift, summaryIsCurrent, summaryLabel } = require('../dist/services/shiftTimes.js');

const settings = {
  shift_starts: ['06:00', '14:00', '22:00'],
  shift_timezone: 'UTC',
  shift_names: { '06:00': 'Day' },
};

test('a partial made in the running shift keeps its plain label', () => {
  const now = Date.parse('2026-11-24T09:30:00Z');
  const cur = currentShift(now, settings.shift_starts, settings.shift_timezone);
  const x = { shift_start: cur.start, shift_end: new Date(now), partial: true };
  assert.equal(summaryIsCurrent(x, settings, now), true);
  assert.equal(summaryLabel(x, settings, now), 'Day (06:00–14:00)');
});

test('the same partial becomes dated once its shift ends without a final summary', () => {
  const now = Date.parse('2026-11-24T14:00:00Z');
  const x = {
    shift_start: new Date('2026-11-24T06:00:00Z'),
    shift_end: new Date('2026-11-24T09:30:00Z'),
    partial: true,
  };
  assert.equal(summaryIsCurrent(x, settings, now), false);
  assert.equal(summaryLabel(x, settings, now), 'Day (06:00–14:00) · so far at 09:30');
});

test('a partial from an earlier day carries the time it was made', () => {
  const now = Date.parse('2026-11-24T09:30:00Z');
  const x = {
    shift_start: new Date('2026-11-23T06:00:00Z'),
    shift_end: new Date('2026-11-23T07:54:00Z'),
    partial: true,
  };
  assert.equal(summaryIsCurrent(x, settings, now), false);
  assert.equal(summaryLabel(x, settings, now), 'Day (06:00–14:00) · so far at 07:54');
});

test('final summaries are unchanged and never current', () => {
  const now = Date.parse('2026-11-24T09:30:00Z');
  const x = {
    shift_start: new Date('2026-11-23T06:00:00Z'),
    shift_end: new Date('2026-11-23T14:00:00Z'),
    partial: false,
  };
  assert.equal(summaryIsCurrent(x, settings, now), false);
  assert.equal(summaryLabel(x, settings, now), 'Day (06:00–14:00)');
});
