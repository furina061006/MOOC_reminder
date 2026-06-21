import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLearnHref,
  coerceJson,
  msToLocalIso,
  buildTermDtoRequest,
  extractHomeworkFromTermDto
} from '../../src/shared/icourse163-api.js';

test('parseLearnHref extracts canonical identity from a learn link', () => {
  const meta = parseLearnHref('/learn/BIT-268001?tid=1460270441#/learn/content');
  assert.deepEqual(meta, { schoolCourseId: 'BIT-268001', termId: '1460270441', isSpoc: false });
});

test('parseLearnHref handles absolute SPOC links', () => {
  const meta = parseLearnHref('https://www.icourse163.org/spoc/learn/ZJU-2?tid=42#/learn/quiz');
  assert.equal(meta.schoolCourseId, 'ZJU-2');
  assert.equal(meta.termId, '42');
  assert.equal(meta.isSpoc, true);
});

test('parseLearnHref rejects non-course links and links without tid', () => {
  assert.equal(parseLearnHref('/about.htm'), null);
  assert.equal(parseLearnHref('/learn/explore'), null);          // no dash, no tid
  assert.equal(parseLearnHref('/learn/BIT-268001'), null);       // no tid
});

test('coerceJson parses objects, strings, and junk-prefixed payloads', () => {
  assert.deepEqual(coerceJson({ a: 1 }), { a: 1 });
  assert.deepEqual(coerceJson('{"a":1}'), { a: 1 });
  assert.deepEqual(coerceJson('/*safe*/{"a":1}'), { a: 1 });
  assert.equal(coerceJson('not json'), null);
});

test('msToLocalIso emits a local-offset ISO string matching the DOM format', () => {
  const iso = msToLocalIso(new Date('2026-06-30T23:59:00').getTime());
  assert.match(iso, /^2026-06-30T23:59:00[+-]\d{2}:\d{2}$/);
  assert.equal(msToLocalIso(0), null);
  assert.equal(msToLocalIso('nope'), null);
});

test('buildTermDtoRequest targets the rpc endpoint with csrfKey + termId body', () => {
  const req = buildTermDtoRequest('CSRF123', '1460270441');
  assert.match(req.url, /\/web\/j\/courseBean\.getMocTermDto\.rpc\?csrfKey=CSRF123$/);
  assert.equal(req.method, 'POST');
  assert.match(req.headers['Content-Type'], /x-www-form-urlencoded/);
  assert.match(req.body, /termId=1460270441/);
});

test('extractHomeworkFromTermDto pulls only signal-bearing assessables and dedups', () => {
  const course = { courseId: 'BIT-268001', termId: '1460270441', courseName: '数据结构', schoolName: '北理工' };
  const deadlineMs = new Date('2026-06-30T23:59:00').getTime();
  const payload = {
    result: {
      mocTermDto: {
        chapters: [
          {
            id: 3, name: '第3章', type: 'chapter',
            lessons: [
              {
                id: 21, name: '3.1 树', type: 'lesson',
                units: [
                  { id: 100, name: '3.1 视频讲解', contentType: 1 },               // no signal → excluded
                  { id: 101, name: '单元测验：树', endTime: deadlineMs, mark: 18, totalMark: 20 }, // quiz, done
                  { id: 102, name: '编程作业：最小堆', submitEndTime: deadlineMs }    // homework, deadline only
                ]
              }
            ]
          }
        ]
      }
    }
  };

  const items = extractHomeworkFromTermDto(payload, course);
  assert.equal(items.length, 2);

  const quiz = items.find(i => i.homeworkId === '101');
  assert.equal(quiz.type, 'quiz');
  assert.equal(quiz.courseId, 'BIT-268001');
  assert.equal(quiz.checkedOff, true);             // has a positive score → auto-done
  assert.equal(quiz.completionReason, 'auto');
  assert.match(quiz.deadline, /^2026-06-30T23:59:00/);
  assert.equal(quiz.uid, 'BIT-268001_tid1460270441_ch3_le21_hw101');

  const hw = items.find(i => i.homeworkId === '102');
  assert.equal(hw.type, 'homework');
  assert.equal(hw.checkedOff, false);              // deadline only, no score
  assert.match(hw.deadline, /^2026-06-30T23:59:00/);
});

test('extractHomeworkFromTermDto returns [] for empty / unparseable input', () => {
  const course = { courseId: 'X', termId: '1' };
  assert.deepEqual(extractHomeworkFromTermDto(null, course), []);
  assert.deepEqual(extractHomeworkFromTermDto('garbage', course), []);
  assert.deepEqual(extractHomeworkFromTermDto({ result: {} }, course), []);
});
