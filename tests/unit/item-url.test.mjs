import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveItemUrl, applyLearnHashRoute, hasPathSection } from '../../src/shared/item-url.js';

test('a new-route pageUrl is opened as-is: its section lives in the path', () => {
  // 2026-10 起普通课程页换到 /mooc/learn/{id}/{section}，栏目在 path 里。
  // 再往上挂旧 SPA 的 hash 路由没有意义，而且会把 hash 一路带进新页面。
  const quiz = {
    courseId: 'NEU-1002822009', termId: '1488060444', type: 'quiz',
    pageUrl: 'https://www.icourse163.org/mooc/learn/NEU-1002822009/assessments?tid=1488060444'
  };
  assert.equal(
    resolveItemUrl(quiz),
    'https://www.icourse163.org/mooc/learn/NEU-1002822009/assessments?tid=1488060444'
  );
  // 考试同样原样打开（新路由的分类在 path 里，不由 hash 决定）
  assert.equal(
    resolveItemUrl({ ...quiz, type: 'exam' }),
    'https://www.icourse163.org/mooc/learn/NEU-1002822009/assessments?tid=1488060444'
  );
  // /learn/{id}/{section} 是新路由的镜像写法，同样不动
  assert.equal(
    applyLearnHashRoute('https://www.icourse163.org/learn/NEU-1002822009/assessments?tid=1', '/learn/testlist'),
    'https://www.icourse163.org/learn/NEU-1002822009/assessments?tid=1'
  );
});

test('hasPathSection only matches a learn URL with a section segment', () => {
  assert.equal(hasPathSection('https://www.icourse163.org/mooc/learn/BIT-1/assessments?tid=2'), true);
  assert.equal(hasPathSection('https://www.icourse163.org/learn/BIT-1/exams?tid=2'), true);
  assert.equal(hasPathSection('https://www.icourse163.org/mooc/learn/BIT-1?tid=2'), false);
  assert.equal(hasPathSection('https://www.icourse163.org/learn/BIT-1?tid=2#/learn/testlist'), false);
  assert.equal(hasPathSection('https://www.icourse163.org/spoc/learn/BIT-1?tid=2'), false);
  assert.equal(hasPathSection('https://www.icourse163.org/home.htm'), false);
  assert.equal(hasPathSection(''), false);
});

test('coursePageUrl is the fallback for items stored before the route was captured', () => {
  // 老条目自身没有 pageUrl，但课程记录里有「用户真实打开过」的路由地址。
  const item = { courseId: 'BIT-268001', termId: '1460270441', type: 'homework' };
  assert.equal(
    resolveItemUrl(item, 'mooc', 'https://www.icourse163.org/mooc/learn/BIT-268001/assessments?tid=1460270441'),
    'https://www.icourse163.org/mooc/learn/BIT-268001/assessments?tid=1460270441'
  );
  // 旧路由课程仍然落到旧地址 + 类型对应的 hash
  assert.equal(
    resolveItemUrl(item, 'mooc', 'https://www.icourse163.org/learn/BIT-268001?tid=1460270441'),
    'https://www.icourse163.org/learn/BIT-268001?tid=1460270441#/learn/testlist'
  );
  // 条目自己的 pageUrl 优先于课程记录的兜底值
  assert.equal(
    resolveItemUrl(
      { ...item, pageUrl: 'https://www.icourse163.org/learn/BIT-268001?tid=1460270441' },
      'mooc',
      'https://www.icourse163.org/mooc/learn/BIT-268001/assessments?tid=1460270441'
    ),
    'https://www.icourse163.org/learn/BIT-268001?tid=1460270441#/learn/testlist'
  );
});

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

test('resolveItemUrl uses the SPOC route when the course type is spoc', () => {
  // SPOC courses live under /spoc/learn/; the /learn/ prefix opens a page that
  // cannot resolve the course (same-named MOOC term does not exist).
  const item = { courseId: 'NEU-1474956162', termId: '1476735472', type: 'homework' };
  assert.equal(
    resolveItemUrl(item, 'spoc'),
    'https://www.icourse163.org/spoc/learn/NEU-1474956162?tid=1476735472#/learn/testlist'
  );
});

test('resolveItemUrl falls back to item.courseType for stored SPOC items', () => {
  const item = { courseId: 'NEU-1002713003', termId: '55', type: 'exam', courseType: 'spoc' };
  assert.equal(
    resolveItemUrl(item),
    'https://www.icourse163.org/spoc/learn/NEU-1002713003?tid=55#/learn/examlist'
  );
});

test('explicit courseType wins over a stale item.courseType', () => {
  const item = { courseId: 'BIT-1', termId: '2', type: 'homework', courseType: 'mooc' };
  assert.match(resolveItemUrl(item, 'spoc'), /^https:\/\/www\.icourse163\.org\/spoc\/learn\//);
});

test('resolveItemUrl keeps a SPOC pageUrl prefix and only fixes its hash route', () => {
  const item = {
    courseId: 'NEU-1', termId: '9', type: 'exam', courseType: 'spoc',
    pageUrl: 'https://www.icourse163.org/spoc/learn/NEU-1?tid=9#/learn/content'
  };
  assert.equal(
    resolveItemUrl(item),
    'https://www.icourse163.org/spoc/learn/NEU-1?tid=9#/learn/examlist'
  );
});

test('a stored SPOC route URL outranks a demoted courseType', () => {
  // Regression: a SPOC course shares its courseId with the plain MOOC course of
  // the same name, and the /learn/ discovery harvest labels every non-/spoc/ href
  // as 'mooc'. The record's courseType can therefore be demoted. The route URL
  // captured from the page the user actually opened is frozen evidence and must
  // still win, so the click never lands on the plain MOOC page. Note the route
  // `tid` (1476735472) is the route shell id, NOT the API id in item.termId.
  const item = {
    courseId: 'NEU-1474956162', termId: '1476504498', type: 'homework', courseType: 'spoc',
    pageUrl: 'https://www.icourse163.org/spoc/learn/NEU-1474956162?tid=1476735472#/learn/content'
  };
  assert.equal(
    resolveItemUrl(item, 'mooc'),
    'https://www.icourse163.org/spoc/learn/NEU-1474956162?tid=1476735472#/learn/testlist'
  );
});
