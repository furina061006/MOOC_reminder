import test from 'node:test';
import assert from 'node:assert/strict';

import { parseChineseDate } from '../../src/shared/date-utils.js';

test('parseChineseDate parses Chinese date-time with explicit year', () => {
  const parsed = parseChineseDate('2026年6月30日 23:59');
  assert.match(parsed, /^2026-06-30T23:59:00/);
});

test('parseChineseDate parses dash-separated date-time', () => {
  const parsed = parseChineseDate('2026-06-30 08:05');
  assert.match(parsed, /^2026-06-30T08:05:00/);
});

test('parseChineseDate defaults date-only explicit-year deadlines to 23:59', () => {
  const parsed = parseChineseDate('2026年6月30日');
  assert.match(parsed, /^2026-06-30T23:59:00/);
});

test('parseChineseDate returns null for invalid text', () => {
  assert.equal(parseChineseDate('不是日期'), null);
});
