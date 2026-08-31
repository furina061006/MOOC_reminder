/**
 * Deadline-reminder pure logic shared by the service worker: which items are
 * due for a notification right now, notification id/title/message shaping,
 * and quiet-hours retry scheduling. All functions are pure so the dedup /
 * snooze / mute interplay is unit-testable without chrome.* APIs.
 */

import {
  normalizeSettings,
  getNotificationLevel
} from './settings.js';

export function isCourseMuted(item, settings) {
  const muted = settings && Array.isArray(settings.mutedCourseIds) ? settings.mutedCourseIds : [];
  return !!(item && muted.indexOf(item.courseId) >= 0);
}

export function isSnoozed(item, now) {
  if (!item || !item.snoozedUntil) return false;
  const t = new Date(item.snoozedUntil).getTime();
  return !isNaN(t) && t > now.getTime();
}

export function notificationIdFor(uid, level) {
  return `mooc-reminder:${encodeURIComponent(uid || '')}:${level}`;
}

export function formatNotificationDeadline(deadline) {
  try {
    const d = new Date(deadline);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '';
  }
}

/**
 * Items that should fire a desktop notification at `now`: unfinished, not
 * muted, not snoozed, at a notification level that differs from the last one
 * already delivered (each level notifies once — snoozing clears the remembered
 * level so it may fire again after the snooze expires).
 */
export function collectDueNotifications(items, settings, now) {
  const s = normalizeSettings(settings);
  if (!s.notificationsEnabled) return [];
  const due = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.checkedOff) continue;
    if (isCourseMuted(item, s) || isSnoozed(item, now)) continue;
    const level = getNotificationLevel(item, now, s);
    if (!level || item.lastNotificationLevel === level) continue;
    const deadlineText = formatNotificationDeadline(item.deadline);
    due.push({
      uid: item.uid || '',
      level,
      title: level === 'overdue' ? 'MOOC 作业已过期' : 'MOOC 作业即将截止',
      message: `${item.courseName || '未知课程'} · ${item.title || '未命名作业'}${deadlineText ? '（' + deadlineText + '）' : ''}`,
      priority: level === 'overdue' ? 2 : 1
    });
  }
  return due;
}

/**
 * Timestamp of the next quiet-end boundary strictly after `now` (the moment
 * suppressed notifications may go out), or null when quiet hours are disabled
 * or the window is empty. Used to schedule a one-shot digest retry when the
 * daily digest alarm fires inside the quiet window.
 */
export function nextQuietEndWhen(settings, now) {
  const s = normalizeSettings(settings);
  if (!s.quietHoursEnabled || s.quietStart === s.quietEnd) return null;
  const d = new Date(now.getTime());
  d.setHours(s.quietEnd, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}
