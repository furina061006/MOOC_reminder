import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectDueNotifications,
  isCourseMuted,
  isSnoozed,
  notificationIdFor,
  nextQuietEndWhen
} from '../../src/shared/reminder.js';

const NOW = new Date('2026-08-16T12:00:00');
const SETTINGS = { notificationsEnabled: true, notifyLeadHours: [48, 24], notifyOverdue: true };

function item(overrides) {
  return Object.assign({
    uid: 'C1_tid1_ch_le_hw1',
    courseId: 'C1',
    title: '第三周作业',
    courseName: '大学物理',
    checkedOff: false,
    deadline: '2026-08-17T12:00:00' // 24h away → due_24h
  }, overrides);
}

test('collectDueNotifications fires once per newly-crossed level', () => {
  const due = collectDueNotifications([item()], SETTINGS, NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0].level, 'due_24h');
  assert.equal(due[0].uid, 'C1_tid1_ch_le_hw1');
  assert.match(due[0].message, /大学物理 · 第三周作业/);
  assert.equal(due[0].priority, 1);

  // Same level already delivered → deduped
  const seen = collectDueNotifications([item({ lastNotificationLevel: 'due_24h' })], SETTINGS, NOW);
  assert.equal(seen.length, 0);

  // A deeper level still fires
  const deeper = collectDueNotifications([item({ lastNotificationLevel: 'due_48h', deadline: '2026-08-16T13:00:00' })], SETTINGS, NOW);
  assert.equal(deeper.length, 1);
  assert.equal(deeper[0].level, 'due_24h');
});

test('collectDueNotifications skips completed, muted, snoozed and disabled items', () => {
  assert.equal(collectDueNotifications([item({ checkedOff: true })], SETTINGS, NOW).length, 0);
  assert.equal(collectDueNotifications([item()], { ...SETTINGS, mutedCourseIds: ['C1'] }, NOW).length, 0);
  assert.equal(collectDueNotifications([item({ snoozedUntil: '2026-08-17T00:00:00' })], SETTINGS, NOW).length, 0);
  assert.equal(collectDueNotifications([item()], { ...SETTINGS, notificationsEnabled: false }, NOW).length, 0);
  assert.equal(collectDueNotifications([item({ deadline: null })], SETTINGS, NOW).length, 0);
});

test('overdue items get the overdue level and higher priority', () => {
  const due = collectDueNotifications([item({ deadline: '2026-08-15T12:00:00' })], SETTINGS, NOW);
  assert.equal(due[0].level, 'overdue');
  assert.equal(due[0].title, 'MOOC 作业已过期');
  assert.equal(due[0].priority, 2);
});

test('snooze expiry re-arms the same level once lastNotificationLevel is cleared', () => {
  // This is the B1 contract: SNOOZE_ITEM clears lastNotificationLevel, so
  // after snoozedUntil passes, the same level must fire again.
  const snoozed = item({ snoozedUntil: '2026-08-16T18:00:00', lastNotificationLevel: 'due_24h' });
  assert.equal(collectDueNotifications([snoozed], SETTINGS, NOW).length, 0); // still snoozed

  const afterSnooze = new Date('2026-08-16T19:00:00');
  const stillRemembered = item({ snoozedUntil: '2026-08-16T18:00:00', lastNotificationLevel: 'due_24h' });
  assert.equal(collectDueNotifications([stillRemembered], SETTINGS, afterSnooze).length, 0); // old buggy behavior

  const cleared = item({ snoozedUntil: '2026-08-16T18:00:00', lastNotificationLevel: null });
  const reFired = collectDueNotifications([cleared], SETTINGS, afterSnooze);
  assert.equal(reFired.length, 1);
  assert.equal(reFired[0].level, 'due_24h');
});

test('notificationIdFor round-trips uid and level', () => {
  const id = notificationIdFor('C1_tid1_ch_le_hw1', 'due_24h');
  assert.equal(id.indexOf('mooc-reminder:'), 0);
  const parts = id.split(':');
  assert.equal(decodeURIComponent(parts[1]), 'C1_tid1_ch_le_hw1');
  assert.equal(parts[2], 'due_24h');
});

test('isCourseMuted and isSnoozed guard helpers', () => {
  assert.equal(isCourseMuted({ courseId: 'C1' }, { mutedCourseIds: ['C1'] }), true);
  assert.equal(isCourseMuted({ courseId: 'C2' }, { mutedCourseIds: ['C1'] }), false);
  assert.equal(isCourseMuted({}, {}), false);
  assert.equal(isSnoozed({ snoozedUntil: '2099-01-01T00:00:00' }, NOW), true);
  assert.equal(isSnoozed({ snoozedUntil: '2000-01-01T00:00:00' }, NOW), false);
  assert.equal(isSnoozed({}, NOW), false);
});

test('nextQuietEndWhen returns the next quiet-end boundary', () => {
  const quiet = { quietHoursEnabled: true, quietStart: 22, quietEnd: 8 };
  // 23:00 inside a midnight-wrapping window → next end is tomorrow 08:00
  assert.equal(nextQuietEndWhen(quiet, new Date('2026-08-16T23:00:00')), new Date('2026-08-17T08:00:00').getTime());
  // 07:30 still inside → today 08:00
  assert.equal(nextQuietEndWhen(quiet, new Date('2026-08-16T07:30:00')), new Date('2026-08-16T08:00:00').getTime());
  // disabled / empty window → null
  assert.equal(nextQuietEndWhen({ quietHoursEnabled: false, quietStart: 22, quietEnd: 8 }, NOW), null);
  assert.equal(nextQuietEndWhen({ quietHoursEnabled: true, quietStart: 8, quietEnd: 8 }, NOW), null);
});
