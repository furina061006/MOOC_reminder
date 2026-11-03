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

test('parseLearnHref handles the 2026-10 /mooc/learn/ MOOC links', () => {
  // 「我的课程」等页面的锚点现在长这样；课程 key 仍是 `learn/` 之后那段，
  // 新版 shell 还会再带 section（/assessments 之类），isSpoc 必须仍是 false。
  assert.deepEqual(
    parseLearnHref('https://www.icourse163.org/mooc/learn/BIT-268001?tid=1460270441#/learn/testlist'),
    { schoolCourseId: 'BIT-268001', termId: '1460270441', isSpoc: false }
  );
  assert.deepEqual(
    parseLearnHref('/mooc/learn/BIT-268001/assessments?tid=1460270441'),
    { schoolCourseId: 'BIT-268001', termId: '1460270441', isSpoc: false }
  );
});

test('parseLearnHref rejects non-course links and links without tid', () => {
  assert.equal(parseLearnHref('/about.htm'), null);
  assert.equal(parseLearnHref('/learn/explore'), null);          // no dash, no tid
  assert.equal(parseLearnHref('/learn/BIT-268001'), null);       // no tid
});

test('parseLearnHref rejects links into a course\'s content, not the course', () => {
  // 2026-09-23 真实 DOM（/home.htm#/home/spocCourse）：首页「最近发表」的 5 条论坛帖链接
  // 全部带 ?tid= 且指向 /learn/NEU-1474956162，锚点文本是帖子标题（如「牛顿第二定律」）——
  // 采进来就变成一条名字=帖子标题、类型=普通的幽灵课程。内容详情链接不是课程链接。
  assert.equal(parseLearnHref('https://www.icourse163.org/learn/NEU-1474956162?tid=1476735472#/learn/forumdetail?pid=1353455440'), null);
  assert.equal(parseLearnHref('/learn/BIT-268001?tid=1460270441#/learn/forum?cid=1'), null);
  // 课程级路由不受影响（拿到真实锚点后确认这些仍然要收）
  assert.ok(parseLearnHref('/learn/BIT-268001?tid=1460270441#/learn/content'));
  assert.ok(parseLearnHref('/learn/BIT-268001?tid=1460270441'));
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

// ── cross-chapter same-name items (2026-10 智慧慕课) ───────────────────────
// NEU-1002123005（高级语言程序设计，/mooc/learn/…/assessments）把八周的作业都叫
// 「本周作业」、测验都叫「本周测验」。DTO 里 16 个节点全部带 deadline，但旧的纯名字
// 去重把后七周整批删掉，界面只剩 3 条。同名不等于同一条 —— 不同章必须都保留。

test('same-named assessments in different chapters are not deduped', () => {
  const deadline = new Date('2026-10-12T23:59:00').getTime();
  const chapters = [];
  for (let w = 0; w < 8; w++) {
    chapters.push({
      id: 1252615054 + w, name: '第' + (w + 1) + '周', type: 'chapter',
      lessons: [{ id: 9000 + w, name: '课时', type: 'lesson', units: [] }],
      homeworks: [{ id: 1278713336 + w, name: '本周作业', contentType: 3, deadline, totalScore: 30 }],
      quizs: [{ id: 1278713335 + w, name: '本周测验', contentType: 2, deadline, totalScore: 10 }]
    });
  }
  const payload = { result: { mocTermDto: { chapters } } };

  const items = extractHomeworkFromTermDto(payload, { courseId: 'NEU-1002123005', termId: '1488158441' });

  assert.equal(items.length, 16, 'every week keeps its homework and quiz');
  assert.equal(new Set(items.map((i) => i.chapterId)).size, 8);
  assert.equal(items.filter((i) => i.title === '本周作业').length, 8);
  assert.equal(items.filter((i) => i.title === '本周测验').length, 8);
});

test('near-duplicate names inside one chapter still collapse', () => {
  const deadline = new Date('2026-10-12T23:59:00').getTime();
  const dto = dtoWithUnits([
    { id: 301, name: '期末测试', contentType: 2, test: { deadline } },
    { id: 302, name: '期末测试题', contentType: 2, test: { deadline } }
  ]);

  const items = extractHomeworkFromTermDto(dto, { courseId: 'NEU-1', termId: '1' });

  assert.equal(items.length, 1, 'the longer variant is noise, not a second assessment');
  assert.equal(items[0].title, '期末测试');
});

// ── 2026-10 新版学习页的考试（issue #15） ─────────────────────────────
// 新版页面的 exams[] 用 taskType:'exam' / nodeType:'legacy-exam' / examId 明确
// 标注考试，可能没有 contentType，或 contentType 被复用；截止时间也可能只在
// parts[]（客观题/主观题）里。这些是显式类型字段，不属于「放宽名字门槛」。

test('exams declared by taskType/nodeType/examId are extracted', () => {
  const deadline = new Date('2026-11-06T22:00:00').getTime();
  const payload = {
    result: { mocTermDto: { chapters: [], exams: [
      // 真实 RSC 形状：没有 type/contentType，只有 taskType + deadline
      { id: 1233326285, name: '期末考试', deadline, totalScore: 100, taskType: 'exam', examKind: 'legacy' },
      // legacy-exam 伪章节节点
      { id: 1252502343, name: '补考', nodeType: 'legacy-exam', examId: '1234000000', deadline, totalScore: 60 },
      // 显式 examId，但 contentType 被标成了别的值
      { id: 1234000001, name: '期中考核', examId: '1234000001', contentType: 1, deadline, totalScore: 50 }
    ] } }
  };
  const items = extractHomeworkFromTermDto(payload, { courseId: 'NEU-1001638003', termId: '1487856456' });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.type), ['exam', 'exam', 'exam']);
  assert.ok(items.every((i) => i.deadline && !i.checkedOff));
});

test('an exam deadline inside parts[] is a signal and is not a separate item', () => {
  const deadline = new Date('2026-11-06T22:00:00').getTime();
  const payload = {
    result: { mocTermDto: { chapters: [], exams: [{
      id: 1234000002, name: '期末考试', taskType: 'exam', totalScore: 100,
      parts: [{ id: 1, name: '客观题', deadline, totalScore: 100, usedTryCount: 0 }]
    }] } }
  };
  const items = extractHomeworkFromTermDto(payload, { courseId: 'NEU-1', termId: '2' });
  assert.equal(items.length, 1, 'parts are sub-papers, not assessments');
  assert.equal(items[0].type, 'exam');
  assert.equal(items[0].homeworkId, '1234000002');
  assert.ok(items[0].deadline);
});

test('an exam submitted through a part is marked completed', () => {
  const deadline = new Date('2026-11-06T22:00:00').getTime();
  const payload = {
    result: { mocTermDto: { chapters: [], exams: [{
      // contentType 被复用成 1（内容），也必须按显式考试处理完成判定
      id: 1234000003, name: '期末考试', taskType: 'exam', contentType: 1, totalScore: 100,
      deadline, parts: [{ id: 1, name: '客观题', usedTryCount: 1, submitStatus: 2, score: 88 }]
    }] } }
  };
  const items = extractHomeworkFromTermDto(payload, { courseId: 'NEU-1', termId: '3' });
  assert.equal(items.length, 1);
  assert.equal(items[0].checkedOff, true, 'a used exam attempt counts as submitted');
  assert.equal(items[0].score, 88);
});

test('a non-exam node with examId:-1 is not promoted to an exam', () => {
  const deadline = new Date('2026-11-06T22:00:00').getTime();
  const dto = dtoWithUnits([
    { id: 501, name: '第一章 测验', contentType: 2, examId: '-1', test: { deadline } }
  ]);
  const items = extractHomeworkFromTermDto(dto, { courseId: 'NEU-1', termId: '1' });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'quiz');
});


