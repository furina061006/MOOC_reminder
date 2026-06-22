import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  resolveAlarmPeriods,
  isWithinQuietHours,
  getNotificationLevel
} from '../../src/shared/settings.js';

test('normalizeSettings fills defaults and clamps numeric fields', () => {
  const s = normalizeSettings({
    checkIntervalMinutes: '-5',
    badgeRefreshMinutes: 9999,
    notifyLeadHours: ['24', 2, -1, 'bad'],
    quietStart: 99,
    quietEnd: -3
  });
  assert.equal(s.checkIntervalMinutes, 1);
  assert.equal(s.badgeRefreshMinutes, 1440);
  assert.deepEqual(s.notifyLeadHours, [24, 2]);
  assert.equal(s.quietStart, 23);
  assert.equal(s.quietEnd, 0);
});

test('normalizeSettings preserves default booleans when missing', () => {
  const s = normalizeSettings(null);
  assert.equal(s.autoDetectEnabled, DEFAULT_SETTINGS.autoDetectEnabled);
  assert.equal(s.notificationsEnabled, true);
  assert.equal(s.notifyOverdue, true);
  assert.equal(s.quietHoursEnabled, false);
  assert.equal(s.dailyDigestEnabled, false);
  assert.equal(s.dailyDigestHour, 8);
  assert.deepEqual(s.mutedCourseIds, []);
});

test('resolveAlarmPeriods derives alarm cadence from settings', () => {
  assert.deepEqual(resolveAlarmPeriods({ checkIntervalMinutes: 17, badgeRefreshMinutes: 3 }), {
    scrapeMinutes: 17,
    badgeMinutes: 3
  });
});

test('isWithinQuietHours handles windows that wrap midnight', () => {
  const settings = { quietHoursEnabled: true, quietStart: 22, quietEnd: 8 };
  assert.equal(isWithinQuietHours(settings, new Date('2026-06-22T23:00:00')), true);
  assert.equal(isWithinQuietHours(settings, new Date('2026-06-22T07:00:00')), true);
  assert.equal(isWithinQuietHours(settings, new Date('2026-06-22T12:00:00')), false);
});

test('isWithinQuietHours handles daytime windows and disabled state', () => {
  assert.equal(isWithinQuietHours({ quietHoursEnabled: true, quietStart: 9, quietEnd: 17 }, new Date('2026-06-22T10:00:00')), true);
  assert.equal(isWithinQuietHours({ quietHoursEnabled: true, quietStart: 9, quietEnd: 17 }, new Date('2026-06-22T18:00:00')), false);
  assert.equal(isWithinQuietHours({ quietHoursEnabled: false, quietStart: 0, quietEnd: 23 }, new Date('2026-06-22T10:00:00')), false);
});

test('getNotificationLevel respects lead thresholds and overdue setting', () => {
  const now = new Date('2026-06-22T08:00:00');
  assert.equal(getNotificationLevel({ deadline: '2026-06-22T12:00:00' }, now, { notifyLeadHours: [48, 24, 6] }), 'due_6h');
  assert.equal(getNotificationLevel({ deadline: '2026-06-24T08:00:01' }, now, { notifyLeadHours: [48, 24] }), null);
  assert.equal(getNotificationLevel({ deadline: '2026-06-21T08:00:00' }, now, { notifyOverdue: true }), 'overdue');
  assert.equal(getNotificationLevel({ deadline: '2026-06-21T08:00:00' }, now, { notifyOverdue: false }), null);
});

test('getNotificationLevel returns null when notifications are disabled', () => {
  const now = new Date('2026-06-22T08:00:00');
  assert.equal(getNotificationLevel({ deadline: '2026-06-22T09:00:00' }, now, { notificationsEnabled: false }), null);
});
