import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeIcsText,
  toIcsDateTime,
  getExportableItems,
  generateHomeworkIcs,
  getDigestItems,
  formatDigestMessage
} from '../../src/shared/calendar.js';

test('escapeIcsText escapes RFC5545 text characters', () => {
  assert.equal(escapeIcsText('A,B;C\\D\nE'), 'A\\,B\\;C\\\\D\\nE');
});

test('toIcsDateTime converts ISO to UTC date-time', () => {
  assert.match(toIcsDateTime('2026-06-30T23:59:00+08:00'), /^20260630T155900Z$/);
  assert.equal(toIcsDateTime('not a date'), null);
});

test('getExportableItems keeps unfinished items with valid deadlines only', () => {
  const items = [
    { uid: 'done', checkedOff: true, deadline: '2026-06-30T23:59:00+08:00' },
    { uid: 'bad', checkedOff: false, deadline: 'bad' },
    { uid: 'ok', checkedOff: false, deadline: '2026-06-30T23:59:00+08:00' }
  ];
  assert.deepEqual(getExportableItems(items).map(i => i.uid), ['ok']);
});

test('generateHomeworkIcs emits VEVENT and VALARM for unfinished homework', () => {
  const ics = generateHomeworkIcs([
    {
      uid: 'u1', checkedOff: false, deadline: '2026-06-30T23:59:00+08:00',
      courseName: '数据结构', schoolName: '北理工', title: '单元测验,树;图', type: 'quiz', pageUrl: 'https://example.test'
    }
  ], { now: '2026-06-01T00:00:00Z', alarmMinutes: 90 });
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /SUMMARY:\[数据结构\] 单元测验\\,树\\;图/);
  assert.match(ics, /DTSTART:20260630T155900Z/);
  assert.match(ics, /BEGIN:VALARM/);
  assert.match(ics, /TRIGGER:-PT90M/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
});

test('getDigestItems includes overdue and due-within-48h unfinished items', () => {
  const now = new Date('2026-06-22T08:00:00Z');
  const items = [
    { uid: 'overdue', checkedOff: false, deadline: '2026-06-21T08:00:00Z' },
    { uid: 'soon', checkedOff: false, deadline: '2026-06-23T08:00:00Z' },
    { uid: 'later', checkedOff: false, deadline: '2026-06-25T08:00:01Z' },
    { uid: 'done', checkedOff: true, deadline: '2026-06-22T09:00:00Z' }
  ];
  assert.deepEqual(getDigestItems(items, now).map(i => i.uid), ['overdue', 'soon']);
});

test('formatDigestMessage summarizes a short digest', () => {
  const now = new Date('2026-06-22T08:00:00Z');
  const msg = formatDigestMessage([
    { checkedOff: false, deadline: '2026-06-21T08:00:00Z', courseName: '课程A', title: '作业A' },
    { checkedOff: false, deadline: '2026-06-22T10:00:00Z', courseName: '课程B', title: '作业B' }
  ], now);
  assert.match(msg, /课程A · 作业A（已过期）/);
  assert.match(msg, /课程B · 作业B/);
});
