import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeNextFlight,
  readJsonValueAt,
  findLearnOutline,
  extractLearnOutline,
  hasUsableExam
} from '../../src/shared/next-flight.js';

const outline = {
  termId: '1487856456',
  courseId: '1001638003',
  chapters: [{ id: '1252502335', name: '第一章', lessons: [], assessments: [] }],
  exams: [{
    id: '1233326285', name: '期末考试', taskType: 'exam', examKind: 'legacy',
    deadline: 1793973600000, totalScore: 100,
    parts: [{ id: '1258593238', name: '客观题', deadline: 1793973600000 }]
  }]
};

function flightScript(payloadText) {
  // What the Next.js shell writes into an inline <script>.
  return 'self.__next_f.push([1,' + JSON.stringify(payloadText) + '])';
}

test('decodeNextFlight unwraps escaped React Flight chunks', () => {
  const payload = '14:["$","$L21",null,{"feature":"assessments","outline":' + JSON.stringify(outline) + '}]';
  const text = flightScript(payload);
  assert.equal(decodeNextFlight(text), payload);
});

test('decodeNextFlight concatenates split chunks', () => {
  const a = '14:["$","div",null,{"outline":';
  const b = JSON.stringify(outline) + '}]';
  const text = flightScript(a) + '\n' + flightScript(b);
  assert.equal(decodeNextFlight(text), a + b);
});

test('findLearnOutline locates outline after other flight data', () => {
  const flight = '1:null\n2:{"layout":{}}\n14:["$","$L21",null,{"outline":' + JSON.stringify(outline) + '}]';
  assert.deepEqual(findLearnOutline(flight), outline);
});

test('findLearnOutline prefers an outline that has exams over an empty prefetch', () => {
  const empty = { termId: '1', courseId: '2', chapters: [], exams: [] };
  const flight = '{"outline":' + JSON.stringify(empty) + '}{"outline":' + JSON.stringify(outline) + '}';
  assert.deepEqual(findLearnOutline(flight), outline);
});

test('extractLearnOutline ignores pages without the new shell', () => {
  assert.equal(extractLearnOutline(''), null);
  assert.equal(extractLearnOutline('window.moocTermDto = { id: 1488001444 };'), null);
});

test('hasUsableExam requires a named exam', () => {
  assert.equal(hasUsableExam(outline), true);
  assert.equal(hasUsableExam({ exams: [] }), false);
  assert.equal(hasUsableExam({ exams: [{ id: 1 }] }), false);
});

test('readJsonValueAt handles braces inside strings and nesting', () => {
  const text = 'x {"a":"}","b":[{"c":"\\""}],"d":1} y';
  assert.deepEqual(readJsonValueAt(text, 1), { a: '}', b: [{ c: '"' }], d: 1 });
});
