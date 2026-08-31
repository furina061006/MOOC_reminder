import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveItemUrl } from '../../src/shared/item-url.js';

test('resolveItemUrl reuses pageUrl but fixes a mismatched hash route', () => {
  const quiz = { pageUrl: 'https://www.icourse163.org/learn/BIT-268001?tid=1#/learn/content', type: 'quiz' };
  assert.equal(
    resolveItemUrl(quiz),
    'https://www.icourse163.org/learn/BIT-268001?tid=1#/learn/testlist'
  );
  const exam = { pageUrl: 'https://www.icourse163.org/learn/BIT-268001?tid=1#/learn/content', type: 'exam' };
  assert.equal(
    resolveItemUrl(exam),
    'https://www.icourse163.org/learn/BIT-268001?tid=1#/learn/examlist'
  );
});

test('resolveItemUrl appends the route when pageUrl has no hash', () => {
  const item = { pageUrl: 'https://www.icourse163.org/learn/BIT-268001?tid=1', type: 'homework' };
  assert.equal(
    resolveItemUrl(item),
    'https://www.icourse163.org/learn/BIT-268001?tid=1#/learn/testlist'
  );
});

test('resolveItemUrl reconstructs the learn URL when pageUrl is missing (API items)', () => {
  // API-discovered items carry no pageUrl — this is the notification-click
  // fallback that used to be missing in the service worker
  const item = { courseId: 'NEU-1474956162', termId: '1476504498', type: 'homework' };
  assert.equal(
    resolveItemUrl(item),
    'https://www.icourse163.org/learn/NEU-1474956162?tid=1476504498#/learn/testlist'
  );
});

test('resolveItemUrl returns null when it cannot build any URL', () => {
  assert.equal(resolveItemUrl(null), null);
  assert.equal(resolveItemUrl({}), null);
  assert.equal(resolveItemUrl({ type: 'quiz' }), null);
});
