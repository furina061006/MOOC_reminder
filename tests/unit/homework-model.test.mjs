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
