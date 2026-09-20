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

// ── near-miss diagnostics ────────────────────────────────────────────────
// A node with a name AND a deadline/score that fails the `contentType ∈ {2,3,6}`
// gate used to vanish without a trace, which is why "this course's items are
// missing" was so hard to diagnose. It must now be reported.

/** Run the extractor while capturing console.log lines. */
function captureLogs(fn) {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    return { result: fn(), logs };
  } finally {
    console.log = original;
  }
}

/** A chapter/lesson/unit DTO whose units are the given assessment-ish nodes. */
function dtoWithUnits(units) {
  return {
    result: {
      mocTermDto: {
        chapters: [{
          id: 1, name: '第1章', type: 'chapter',
          lessons: [{ id: 11, name: '1.1', type: 'lesson', units }]
        }]
      }
    }
  };
}

test('extractHomeworkFromTermDto reports nodes it rejected on content type', () => {
  const deadline = Date.now() + 86400000;
  const dto = dtoWithUnits([
    { id: 101, name: '第一章 测验', contentType: 2, test: { deadline } },
    // name + deadline but an unrecognised contentType → currently gated out
    { id: 102, name: '“Multisim” 对应的测试', contentType: 9, test: { deadline } }
  ]);

  const { result, logs } = captureLogs(() =>
    extractHomeworkFromTermDto(dto, { courseId: 'NEU-1', termId: '1476504498' }));

  assert.equal(result.length, 1);
  assert.equal(result[0].title, '第一章 测验');

  const line = logs.find((l) => l.includes('被类型门槛拦下'));
  assert.ok(line, 'expected a near-miss diagnostic line');
  assert.match(line, /Multisim/);
  // contentType is stringified by the extractor, so it reports "9" not 9
  assert.match(line, /"contentType":"9"/);
});

test('the near-miss report is capped so a large DTO cannot flood the console', () => {
  const deadline = Date.now() + 86400000;
  const units = [];
  for (let i = 0; i < 9; i++) {
    units.push({ id: 200 + i, name: '未识别类型 ' + i, contentType: 8, test: { deadline } });
  }

  const { result, logs } = captureLogs(() =>
    extractHomeworkFromTermDto(dtoWithUnits(units), { courseId: 'NEU-1', termId: '1' }));

  assert.deepEqual(result, []);
  const line = logs.find((l) => l.includes('被类型门槛拦下'));
  assert.ok(line);
  // the log prefix is "[MOOC Reminder] …", so cut at the ": [" that precedes the array
  const reported = JSON.parse(line.slice(line.indexOf(': [') + 2));
  assert.equal(reported.length, 6, '5 real entries plus an ellipsis marker');
  assert.equal(reported[5], '…');
});

test('a node.test sub-object never becomes a second item', () => {
  // Real shape (2026-09): the assessment node and its `test` metadata BOTH carry a
  // name that matches the keyword regex, but with different ids — parent id vs
  // test.id. Recursing into `test` used to mint a duplicate item keyed by test.id.
  const deadline = Date.now() + 86400000;
  const dto = dtoWithUnits([
    {
      id: 1278666208, name: '第一章 测验', contentType: 2,
      test: { id: 1258634750, name: '第一章 测验', type: 2, deadline, totalScore: 35 }
    }
  ]);

  const items = extractHomeworkFromTermDto(dto, { courseId: 'NEU-1', termId: '1488001444' });

  assert.equal(items.length, 1, 'the test sub-object must not be extracted separately');
  assert.ok(items[0].uid.includes('hw1278666208'), 'kept item is keyed by the parent id');

  // The duplicate used to be hidden by the name-prefix dedup; that safety net is
  // name-based and fragile, so assert it is not needed in the first place.
  assert.deepEqual(items.map((i) => i.title), ['第一章 测验']);
});

