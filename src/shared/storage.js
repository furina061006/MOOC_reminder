/**
 * chrome.storage.local wrapper for reading and writing
 * homework items, courses, settings, and sync metadata.
 */

const STORAGE_KEYS = {
  HOMEWORK_ITEMS: 'homework_items',
  COURSES: 'courses',
  LAST_SYNC: 'last_sync',
  SYNC_ERRORS: 'sync_errors',
  USER_SETTINGS: 'user_settings'
};

const DEFAULT_SETTINGS = {
  checkIntervalMinutes: 30,
  badgeRefreshMinutes: 5,
  autoDetectEnabled: true
};

// ─── Homework Items ───────────────────────────────────────

export async function getHomeworkItems() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.HOMEWORK_ITEMS);
  return result[STORAGE_KEYS.HOMEWORK_ITEMS] || [];
}

export async function setHomeworkItems(items) {
  await chrome.storage.local.set({ [STORAGE_KEYS.HOMEWORK_ITEMS]: items });
}

export async function getHomeworkByUid(uid) {
  const items = await getHomeworkItems();
  return items.find(i => i.uid === uid) || null;
}

export async function upsertHomeworkItem(item) {
  const items = await getHomeworkItems();
  const idx = items.findIndex(i => i.uid === item.uid);
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...item };
  } else {
    items.push(item);
  }
  await setHomeworkItems(items);
}

// ─── Courses ──────────────────────────────────────────────

export async function getCourses() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.COURSES);
  return result[STORAGE_KEYS.COURSES] || [];
}

export async function setCourses(courses) {
  await chrome.storage.local.set({ [STORAGE_KEYS.COURSES]: courses });
}

export async function upsertCourse(course) {
  const courses = await getCourses();
  const idx = courses.findIndex(c => c.courseId === course.courseId);
  if (idx >= 0) {
    courses[idx] = { ...courses[idx], ...course, lastSeen: new Date().toISOString() };
  } else {
    course.firstSeen = course.firstSeen || new Date().toISOString();
    course.lastSeen = new Date().toISOString();
    courses.push(course);
  }
  await setCourses(courses);
}

// ─── Sync Metadata ────────────────────────────────────────

export async function getLastSync() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LAST_SYNC);
  return result[STORAGE_KEYS.LAST_SYNC] || null;
}

export async function setLastSync(timestamp) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.LAST_SYNC]: timestamp || new Date().toISOString()
  });
}

// ─── Sync Errors (ring buffer, last 20) ───────────────────

export async function getSyncErrors() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SYNC_ERRORS);
  return result[STORAGE_KEYS.SYNC_ERRORS] || [];
}

export async function addSyncError(errorMessage) {
  const errors = await getSyncErrors();
  errors.push({
    time: new Date().toISOString(),
    error: errorMessage
  });
  // Keep only last 20 errors
  const trimmed = errors.length > 20 ? errors.slice(errors.length - 20) : errors;
  await chrome.storage.local.set({ [STORAGE_KEYS.SYNC_ERRORS]: trimmed });
}

// ─── User Settings ────────────────────────────────────────

export async function getUserSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.USER_SETTINGS);
  return result[STORAGE_KEYS.USER_SETTINGS] || { ...DEFAULT_SETTINGS };
}

export async function updateUserSettings(partial) {
  const current = await getUserSettings();
  const updated = { ...current, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEYS.USER_SETTINGS]: updated });
  return updated;
}

// ─── Bulk Operations ──────────────────────────────────────

export async function initializeStorage() {
  const existing = await chrome.storage.local.get([
    STORAGE_KEYS.HOMEWORK_ITEMS,
    STORAGE_KEYS.COURSES
  ]);

  const defaults = {
    [STORAGE_KEYS.HOMEWORK_ITEMS]: existing[STORAGE_KEYS.HOMEWORK_ITEMS] || [],
    [STORAGE_KEYS.COURSES]: existing[STORAGE_KEYS.COURSES] || [],
    [STORAGE_KEYS.LAST_SYNC]: null,
    [STORAGE_KEYS.SYNC_ERRORS]: [],
    [STORAGE_KEYS.USER_SETTINGS]: DEFAULT_SETTINGS
  };

  await chrome.storage.local.set(defaults);
}

export { STORAGE_KEYS, DEFAULT_SETTINGS };
