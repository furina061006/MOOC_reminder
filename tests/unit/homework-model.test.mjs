import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateHomeworkUid,
  generateFallbackUid,
  parseCourseUrl,
  createHomeworkItem,
  isEffectivelyDone
} from '../../src/shared/homework-model.js';

test('generateHomeworkUid uses the documented structural format', () => {
  assert.equal(
    generateHomeworkUid('BIT-268001', '1460270441', '3', '2', '5'),
    'BIT-268001_tid1460270441_ch3_le2_hw5'
  );
});

test('generateFallbackUid is deterministic for identical inputs', () => {
  const a = generateFallbackUid('BIT-268001', '单元测验', '2026-06-30T23:59:00+08:00', 1);
  const b = generateFallbackUid('BIT-268001', '单元测验', '2026-06-30T23:59:00+08:00', 1);
  assert.equal(a, b);
  assert.match(a, /^fb_[0-9a-f]{8}$/);
});

test('parseCourseUrl handles normal learn URLs', () => {
  const meta = parseCourseUrl('https://www.icourse163.org/learn/BIT-268001?tid=1460270441#/learn/content');
  assert.equal(meta.courseId, 'BIT-268001');
  assert.equal(meta.school, 'BIT');
  assert.equal(meta.termId, '1460270441');
  assert.equal(meta.isSpoc, false);
});

test('parseCourseUrl handles the 2026-10 /mooc/learn/ MOOC route', () => {
  // 普通 MOOC 课程页从 /learn/ 搬到了 /mooc/learn/；课程 key 仍是 `learn/` 之后的
  // 那一段，tid 仍在 query 里。新版 shell 还会再带一个 section（如 /assessments）。
  const meta = parseCourseUrl('https://www.icourse163.org/mooc/learn/BIT-268001?tid=1460270441#/learn/testlist');
  assert.equal(meta.courseId, 'BIT-268001');
  assert.equal(meta.school, 'BIT');
  assert.equal(meta.termId, '1460270441');
  assert.equal(meta.isSpoc, false, '/mooc/learn/ is a MOOC route, not SPOC');

  const withSection = parseCourseUrl('https://www.icourse163.org/mooc/learn/BIT-268001/assessments?tid=1460270441');
  assert.equal(withSection.courseId, 'BIT-268001');
  assert.equal(withSection.termId, '1460270441');
  assert.equal(withSection.isSpoc, false);
});

test('parseCourseUrl handles SPOC URLs', () => {
  const meta = parseCourseUrl('https://www.icourse163.org/spoc/learn/BIT-268001?tid=1460270441#/learn/quiz');
  assert.equal(meta.courseId, 'BIT-268001');
  assert.equal(meta.isSpoc, true);
});

test('isEffectivelyDone follows checkedOff as badge truth', () => {
  const item = createHomeworkItem({
    uid: 'u1',
    courseId: 'c',
    termId: 't',
    chapterId: '',
    lessonId: '',
    homeworkId: 'h',
    title: '作业'
  });
  assert.equal(isEffectivelyDone(item), false);
  item.checkedOff = true;
  assert.equal(isEffectivelyDone(item), true);
});
