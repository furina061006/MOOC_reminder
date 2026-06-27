/**
 * User settings — schema, defaults, and the pure logic that the (formerly
 * dormant) settings actually drive: alarm periods, notification thresholds,
 * and quiet hours.
 *
 * These are pure functions, unit-tested here and inlined into the service
 * worker (see [[runtime-vs-shared-duplication]]). Until this PR, user_settings
 * was stored and validated but NEVER read — setupAlarms hard-coded 30/5 and the
 * notifier hard-coded its thresholds. Now both consult these helpers.
 */

export const DEFAULT_SETTINGS = {
  checkIntervalMinutes: 30,    // periodic scrape + API refresh cadence
  badgeRefreshMinutes: 5,      // badge recompute cadence
  autoDetectEnabled: true,     // honor scraper/API auto-completion
  notificationsEnabled: true,  // desktop deadline notifications master switch
  notifyLeadHours: [48, 24],   // fire as each threshold is crossed
  notifyOverdue: true,         // fire once when an item becomes overdue
  quietHoursEnabled: false,    // suppress notifications during quiet hours
  quietStart: 22,              // 22:00 (inclusive)
  quietEnd: 8,                 // 08:00 (exclusive)
  dailyDigestEnabled: false,   // one summary notification per day
  dailyDigestHour: 8,          // local hour for daily digest
  mutedCourseIds: [],          // courses muted for notifications/digests
  autoDismissErrors: true,    // auto-clear sync errors from the UI
  showSnoozeButton: true,       // show snooze button in popup
  showCourseMute: true,         // show course mute button
};

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  if (typeof n !== 'number' || !isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Merge stored settings over defaults and clamp every field to a sane range. */
export function normalizeSettings(stored) {
  const s = (stored && typeof stored === 'object') ? stored : {};
  let leads = Array.isArray(s.notifyLeadHours) ? s.notifyLeadHours : DEFAULT_SETTINGS.notifyLeadHours;
  leads = leads
    .map((h) => {
      const n = typeof h === 'string' ? parseInt(h, 10) : h;
      if (typeof n !== 'number' || !isFinite(n) || n < 1) return null;
      return Math.min(720, Math.round(n));
    })
    .filter((h) => h != null)
    .sort((a, b) => b - a); // descending, so larger thresholds are crossed first
  if (leads.length === 0) leads = DEFAULT_SETTINGS.notifyLeadHours.slice();
  return {
    checkIntervalMinutes: clampInt(s.checkIntervalMinutes, 1, 1440, DEFAULT_SETTINGS.checkIntervalMinutes),
    badgeRefreshMinutes: clampInt(s.badgeRefreshMinutes, 1, 1440, DEFAULT_SETTINGS.badgeRefreshMinutes),
    autoDetectEnabled: s.autoDetectEnabled !== false,
    notificationsEnabled: s.notificationsEnabled !== false,
    notifyLeadHours: leads,
    notifyOverdue: s.notifyOverdue !== false,
    quietHoursEnabled: s.quietHoursEnabled === true,
    quietStart: clampInt(s.quietStart, 0, 23, DEFAULT_SETTINGS.quietStart),
    quietEnd: clampInt(s.quietEnd, 0, 23, DEFAULT_SETTINGS.quietEnd),
    dailyDigestEnabled: s.dailyDigestEnabled === true,
    dailyDigestHour: clampInt(s.dailyDigestHour, 0, 23, DEFAULT_SETTINGS.dailyDigestHour),
    mutedCourseIds: Array.isArray(s.mutedCourseIds) ? s.mutedCourseIds.filter(Boolean).map(String) : [],
    autoDismissErrors: s.autoDismissErrors === true,
    showSnoozeButton: s.showSnoozeButton !== false,
    showCourseMute: s.showCourseMute !== false,
  };
}

/** Alarm periods (minutes) derived from settings. */
export function resolveAlarmPeriods(settings) {
  const s = normalizeSettings(settings);
  return { scrapeMinutes: s.checkIntervalMinutes, badgeMinutes: s.badgeRefreshMinutes };
}

/**
 * Is `date` within the configured quiet-hours window? Handles windows that wrap
 * past midnight (e.g. 22 → 8). Returns false when quiet hours are disabled.
 */
export function isWithinQuietHours(settings, date) {
  const s = normalizeSettings(settings);
  if (!s.quietHoursEnabled) return false;
  const hour = date.getHours();
  if (s.quietStart === s.quietEnd) return false; // empty window
  if (s.quietStart < s.quietEnd) {
    return hour >= s.quietStart && hour < s.quietEnd;
  }
  // wraps midnight
  return hour >= s.quietStart || hour < s.quietEnd;
}

/**
 * Which notification level (if any) an item is at, honoring settings.
 * Returns 'overdue', `due_{h}h` for the smallest crossed lead threshold, or null.
 */
export function getNotificationLevel(item, now, settings) {
  const s = normalizeSettings(settings);
  if (!s.notificationsEnabled || !item || !item.deadline) return null;
  let deadline;
  try {
    deadline = new Date(item.deadline);
  } catch {
    return null;
  }
  if (isNaN(deadline.getTime())) return null;

  const diff = deadline.getTime() - now.getTime();
  if (diff < 0) return s.notifyOverdue ? 'overdue' : null;

  // Smallest lead threshold the item is now within → most specific reminder.
  const ascending = s.notifyLeadHours.slice().sort((a, b) => a - b);
  for (const lead of ascending) {
    if (diff <= lead * 60 * 60 * 1000) return 'due_' + lead + 'h';
  }
  return null;
}
