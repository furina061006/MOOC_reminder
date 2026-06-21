/**
 * Background Service Worker — MOOC Reminder
 *
 * Responsibilities:
 *   1. Manage chrome.alarms for periodic scraping and badge refresh
 *   2. Process messages from content scripts and popup
 *   3. Reconcile scraped data with stored state
 *   4. Update extension badge (count + color)
 *   5. Handle extension lifecycle (install, startup, update)
 *
 * All persistent state is in chrome.storage.local.
 * The SW may be terminated at any time; alarms survive termination.
 */

// ─── Storage Keys ───────────────────────────────────────
const KEYS = {
  HOMEWORK_ITEMS: 'homework_items',
  COURSES: 'courses',
  LAST_SYNC: 'last_sync',
  SYNC_ERRORS: 'sync_errors',
  SCRAPE_STATUS: 'scrape_status',
  API_STATUS: 'api_status',
  USER_SETTINGS: 'user_settings'
};

const DEFAULT_SETTINGS = {
  checkIntervalMinutes: 30,
  badgeRefreshMinutes: 5,
  autoDetectEnabled: true
};

// ─── Lifecycle ──────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[MOOC Reminder] Extension installed/updated:', details.reason);

  await validateAndRepairStorage();
  setupAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[MOOC Reminder] Browser started, validating storage and setting up alarms');
  await validateAndRepairStorage();
  setupAlarms();
});

// ─── Storage Validation ─────────────────────────────────

async function validateAndRepairStorage() {
  try {
    const data = await chrome.storage.local.get([
      KEYS.HOMEWORK_ITEMS,
      KEYS.COURSES,
      KEYS.USER_SETTINGS,
      KEYS.SCRAPE_STATUS
    ]);

    let needsRepair = false;

    // Check homework_items
    const items = data[KEYS.HOMEWORK_ITEMS];
    if (items !== undefined && !Array.isArray(items)) {
      console.warn('[MOOC Reminder] Corrupted homework_items detected, resetting');
      needsRepair = true;
    }

    // Check courses
    const courses = data[KEYS.COURSES];
    if (courses !== undefined && !Array.isArray(courses)) {
      console.warn('[MOOC Reminder] Corrupted courses detected, resetting');
      needsRepair = true;
    }

    if (needsRepair) {
      await chrome.storage.local.set({
        [KEYS.HOMEWORK_ITEMS]: [],
        [KEYS.COURSES]: [],
        [KEYS.LAST_SYNC]: null,
        [KEYS.SYNC_ERRORS]: [],
        [KEYS.SCRAPE_STATUS]: data[KEYS.SCRAPE_STATUS] || null,
        [KEYS.USER_SETTINGS]: data[KEYS.USER_SETTINGS] || DEFAULT_SETTINGS
      });
      console.log('[MOOC Reminder] Storage repaired — all data reset');
    } else {
      // Ensure defaults exist for new installs
      await chrome.storage.local.set({
        [KEYS.HOMEWORK_ITEMS]: Array.isArray(items) ? items.filter(Boolean) : [],
        [KEYS.COURSES]: Array.isArray(courses) ? courses.filter(Boolean) : [],
        [KEYS.LAST_SYNC]: (await chrome.storage.local.get(KEYS.LAST_SYNC))[KEYS.LAST_SYNC] || null,
        [KEYS.SYNC_ERRORS]: [],
        [KEYS.SCRAPE_STATUS]: data[KEYS.SCRAPE_STATUS] || null,
        [KEYS.USER_SETTINGS]: data[KEYS.USER_SETTINGS] || DEFAULT_SETTINGS
      });
    }
  } catch (e) {
    console.error('[MOOC Reminder] Storage validation failed, full reset:', e.message);
    try {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        [KEYS.HOMEWORK_ITEMS]: [],
        [KEYS.COURSES]: [],
        [KEYS.LAST_SYNC]: null,
        [KEYS.SYNC_ERRORS]: [],
        [KEYS.SCRAPE_STATUS]: null,
        [KEYS.USER_SETTINGS]: DEFAULT_SETTINGS
      });
    } catch {}
  }
}

// ─── Alarms ─────────────────────────────────────────────

function setupAlarms() {
  // Clear existing alarms to avoid duplicates
  chrome.alarms.clear('periodic-scrape', () => {
    chrome.alarms.create('periodic-scrape', {
      periodInMinutes: 30
    });
  });

  chrome.alarms.clear('badge-refresh', () => {
    chrome.alarms.create('badge-refresh', {
      periodInMinutes: 5
    });
  });

  console.log('[MOOC Reminder] Alarms configured');
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log('[MOOC Reminder] Alarm fired:', alarm.name);

  switch (alarm.name) {
    case 'periodic-scrape':
      // Tab-based DOM scrape (if a course tab is open) AND tab-less API refresh
      // of every known course — the latter is what lets us stay current without
      // the user keeping a course page open.
      await performPeriodicScrape();
      await apiRefreshAllKnownCourses();
      break;
    case 'badge-refresh':
      await updateBadgeFromStorage();
      break;
  }
});

// ─── Message Handler ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Defensive: ensure msg is a valid object with type
  if (!msg || typeof msg !== 'object' || !msg.type) {
    return false;
  }

  const handler = MESSAGE_HANDLERS[msg.type];
  if (handler) {
    handler(msg, sender).then(result => {
      try { sendResponse(result); } catch {}
    }).catch(err => {
      console.error('[MOOC Reminder] Handler error:', msg.type, err);
      try { sendResponse({ success: false, error: String(err?.message || err) }); } catch {}
    });
    return true; // keep channel open for async
  }
  return false;
});

const MESSAGE_HANDLERS = {
  // Content script sends scraped data
  async HOMEWORK_DATA(msg) {
    if (!msg.course || !Array.isArray(msg.homeworkItems)) {
      return { success: false, error: 'Invalid payload' };
    }

    const result = await reconcileHomeworkData(msg.course, msg.homeworkItems);
    if (msg.scrapeStatus) {
      await setScrapeStatus(msg.scrapeStatus);
    }
    await updateBadgeFromStorage();
    console.log(`[MOOC Reminder] Reconciled: +${result.added} added, ~${result.updated} updated`);
    return { success: true, added: result.added, updated: result.updated };
  },

  // Popup marks an item as completed
  async MARK_COMPLETED(msg) {
    if (!msg.homeworkUid || typeof msg.checkedOff !== 'boolean') {
      return { success: false, error: 'Invalid payload' };
    }

    const items = await getHomeworkItems();
    const item = items.find(i => i.uid === msg.homeworkUid);
    if (item) {
      item.checkedOff = msg.checkedOff;
      item.manuallyCheckedOff = msg.checkedOff;
      item.lastUpdated = new Date().toISOString();
      item.completionReason = msg.checkedOff ? 'manual' : null;

      // If un-checking, also reset auto-detection so it can re-detect
      if (!msg.checkedOff) {
        item.autoDetectedCompleted = false;
      }

      await setHomeworkItems(items);
      await updateBadgeFromStorage();
      return { success: true };
    }
    return { success: false, error: 'Item not found' };
  },

  // Content script (course-discovery) reports harvested course links.
  // This is how the extension learns about EVERY enrolled course — not just
  // pages the user manually opened — enabling background API homework refresh.
  async COURSE_LINKS(msg) {
    if (!Array.isArray(msg.courses)) return { success: false, error: 'Invalid payload' };
    const existing = await getCourses();
    const known = new Set(existing.map(c => c && c.courseId));
    let registered = 0;
    let newCourses = 0;
    for (const c of msg.courses) {
      if (!c || !c.courseId || !c.termId) continue;
      if (!known.has(c.courseId)) newCourses++;
      await upsertCourse({
        courseId: c.courseId,
        termId: c.termId,
        courseName: c.courseName || '',
        courseType: c.courseType || 'mooc',
        discovered: true
      });
      registered++;
    }
    // Only kick a (heavy) background refresh when a genuinely new course appeared.
    if (newCourses > 0) {
      apiRefreshAllKnownCourses().catch(() => {});
    }
    return { success: true, registered, newCourses };
  },

  // Popup requests homework data
  async GET_HOMEWORK() {
    const items = await getHomeworkItems();  // already sanitized by getHomeworkItems
    const courses = await getCourses();
    const lastSync = await getLastSync();
    const settings = await getUserSettings();
    const syncErrors = await getSyncErrors();
    const scrapeStatus = await getScrapeStatus();
    const apiStatus = await getApiStatus();

    return {
      items: items.filter(i => i && !i.checkedOff),  // unfinished only
      allItems: items,                                 // including completed
      courses,
      lastSync,
      settings,
      syncErrors,
      scrapeStatus,
      apiStatus
    };
  },

  // Popup requests immediate scrape
  async TRIGGER_SCRAPE() {
    return await triggerManualScrape();
  },

  // Popup clears completed items
  async CLEAR_COMPLETED() {
    const items = await getHomeworkItems();
    const active = items.filter(i => !i.checkedOff);
    await setHomeworkItems(active);
    await updateBadgeFromStorage();
    return { success: true, remaining: active.length };
  },

  // Popup clears all cached data
  async RESET_DATA() {
    await chrome.storage.local.set({
      [KEYS.HOMEWORK_ITEMS]: [],
      [KEYS.COURSES]: [],
      [KEYS.LAST_SYNC]: null,
      [KEYS.SYNC_ERRORS]: [],
      [KEYS.SCRAPE_STATUS]: null
    });
    await updateBadgeFromStorage();
    console.log('[MOOC Reminder] All data reset');
    return { success: true };
  },

  async SCRAPE_STATUS(msg) {
    if (!msg.scrapeStatus || typeof msg.scrapeStatus !== 'object') {
      return { success: false, error: 'Invalid payload' };
    }
    await setScrapeStatus(msg.scrapeStatus);
    if (msg.scrapeStatus.status === 'error') {
      await addSyncError('Scrape status: ' + (msg.scrapeStatus.message || 'unknown error'));
    }
    return { success: true };
  },

  // Refresh badge only
  async REFRESH_BADGE() {
    await updateBadgeFromStorage();
    return { success: true };
  }
};

// ─── Data Reconciliation ────────────────────────────────

function normalizeIdentityText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isSameHomeworkCandidate(existing, newItem) {
  if (!existing || !newItem) return false;

  if (existing.uid && existing.uid === newItem.uid) return true;
  if (existing.identityKey && newItem.identityKey && existing.identityKey === newItem.identityKey) return true;

  if (existing.courseId !== newItem.courseId || existing.termId !== newItem.termId) return false;
  if ((existing.type || '') !== (newItem.type || '')) return false;
  if (normalizeIdentityText(existing.title) !== normalizeIdentityText(newItem.title)) return false;

  // Existing data from older versions may not have identityKey. Use deadline as a
  // migration hint, but only the caller may merge if the match is unique.
  if (existing.deadline && newItem.deadline && existing.deadline !== newItem.deadline) return false;
  return true;
}

function findUniqueHomeworkCandidate(items, newItem) {
  const matches = items
    .map(function(item, index) { return { item: item, index: index }; })
    .filter(function(entry) { return isSameHomeworkCandidate(entry.item, newItem); });
  return matches.length === 1 ? matches[0].index : -1;
}

async function reconcileHomeworkData(course, newItems) {
  const existingItems = await getHomeworkItems();
  let added = 0;
  let updated = 0;

  for (const newItem of newItems) {
    // Skip null/undefined entries from content script
    if (!newItem || typeof newItem !== 'object') continue;

    // Ensure UID exists
    if (!newItem.uid) {
      console.warn('[MOOC Reminder] Skipping item without UID:', newItem.title);
      continue;
    }

    const existingIdx = existingItems.findIndex(i => i.uid === newItem.uid);

    if (existingIdx >= 0) {
      // --- Existing item: merge ---
      const existing = existingItems[existingIdx];

      // Preserve manual check-off: always wins
      if (existing.manuallyCheckedOff) {
        newItem.checkedOff = true;
        newItem.manuallyCheckedOff = true;
        newItem.completionReason = 'manual';
      }

      // Apply auto-detection (only if not manually overridden)
      if (!newItem.checkedOff && newItem.autoDetectedCompleted) {
        newItem.checkedOff = true;
        newItem.completionReason = 'auto';
      }

      // Preserve firstSeen
      newItem.firstSeen = existing.firstSeen;
      newItem.lastUpdated = new Date().toISOString();

      // Merge into existing
      Object.assign(existingItems[existingIdx], newItem);
      // 确保手动标记不被 Object.assign 覆盖（newItem 来自新爬取，manuallyCheckedOff=false）
      if (existing.manuallyCheckedOff) {
        existingItems[existingIdx].checkedOff = true;
        existingItems[existingIdx].manuallyCheckedOff = true;
        existingItems[existingIdx].completionReason = 'manual';
      }
      updated++;
    } else {
      // --- Secondary dedup: match only when one existing item is an unambiguous candidate. ---
      var dupIdx = findUniqueHomeworkCandidate(existingItems, newItem);
      if (dupIdx >= 0) {
        var dupExisting = existingItems[dupIdx];
        // 保留手动勾选状态（Object.assign 会覆盖）
        var wasManual = dupExisting.manuallyCheckedOff;
        var wasCheckedOff = dupExisting.checkedOff;
        var oldCompletionReason = dupExisting.completionReason;
        var oldFirstSeen = dupExisting.firstSeen;
        var oldUid = dupExisting.uid;
        Object.assign(existingItems[dupIdx], newItem);
        existingItems[dupIdx].firstSeen = oldFirstSeen || new Date().toISOString();
        existingItems[dupIdx].lastUpdated = new Date().toISOString();
        if (oldUid && oldUid !== newItem.uid) {
          existingItems[dupIdx].previousUid = oldUid;
        }
        if (wasManual) {
          existingItems[dupIdx].checkedOff = true;
          existingItems[dupIdx].manuallyCheckedOff = true;
          existingItems[dupIdx].completionReason = 'manual';
        } else if (wasCheckedOff || newItem.autoDetectedCompleted) {
          existingItems[dupIdx].checkedOff = true;
          existingItems[dupIdx].completionReason = newItem.autoDetectedCompleted ? 'auto' : oldCompletionReason;
        }
        updated++;
      } else {
        // --- Genuinely new item ---
        if (newItem.autoDetectedCompleted) {
          newItem.checkedOff = true;
          newItem.completionReason = 'auto';
        }
        newItem.firstSeen = newItem.firstSeen || new Date().toISOString();
        newItem.lastUpdated = newItem.firstSeen;
        existingItems.push(newItem);
        added++;
      }
    }
  }

  // Update course metadata
  if (course && course.courseId) {
    await upsertCourse(course);
  }

  // Save
  await setHomeworkItems(existingItems);
  await chrome.storage.local.set({
    [KEYS.LAST_SYNC]: new Date().toISOString()
  });

  return { added, updated };
}

// ─── Badge Management ───────────────────────────────────

async function updateBadgeFromStorage() {
  try {
    const items = await getHomeworkItems();
    const unfinished = items.filter(i => !i.checkedOff);
    const count = unfinished.length;

    if (count === 0) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    await chrome.action.setBadgeText({ text: String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: getUrgencyColor(unfinished) });
    await maybeNotifyDeadlines(items, unfinished);
  } catch (e) {
    console.error('[MOOC Reminder] Badge update failed:', e);
  }
}

function getUrgencyColor(items) {
  const now = new Date();

  const hasOverdue = items.some(i => {
    if (!i.deadline) return false;
    try {
      return new Date(i.deadline) < now;
    } catch {
      return false;
    }
  });

  if (hasOverdue) return '#DC3545'; // red

  const hasUrgent = items.some(i => {
    if (!i.deadline) return false;
    try {
      const diff = new Date(i.deadline) - now;
      return diff > 0 && diff < 48 * 60 * 60 * 1000; // within 48 hours
    } catch {
      return false;
    }
  });

  if (hasUrgent) return '#FFC107'; // orange

  return '#007BFF'; // blue
}

async function processScrapeResponse(response) {
  if (!response || typeof response !== 'object') {
    return { itemCount: 0, changedCount: 0, handled: false };
  }

  if (response.scrapeStatus) {
    await setScrapeStatus(response.scrapeStatus);
  }

  if (response.course && Array.isArray(response.homeworkItems)) {
    const result = await reconcileHomeworkData(response.course, response.homeworkItems);
    return {
      itemCount: response.homeworkItems.length,
      changedCount: result.added + result.updated,
      handled: true
    };
  }

  return { itemCount: 0, changedCount: 0, handled: !!response.scrapeStatus };
}

// ─── Periodic Scraping ──────────────────────────────────


function getNotificationLevel(item, now) {
  if (!item || !item.deadline) return null;
  let deadline;
  try {
    deadline = new Date(item.deadline);
  } catch {
    return null;
  }
  if (isNaN(deadline.getTime())) return null;

  const diff = deadline - now;
  if (diff < 0) return 'overdue';
  if (diff <= 24 * 60 * 60 * 1000) return 'due_24h';
  if (diff <= 48 * 60 * 60 * 1000) return 'due_48h';
  return null;
}

function formatNotificationDeadline(deadline) {
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

async function maybeNotifyDeadlines(allItems, unfinishedItems) {
  if (!chrome.notifications || !Array.isArray(allItems) || !Array.isArray(unfinishedItems)) return;

  const now = new Date();
  let changed = false;

  for (const item of unfinishedItems) {
    const level = getNotificationLevel(item, now);
    if (!level || item.lastNotificationLevel === level) continue;

    const notificationId = `mooc-reminder:${encodeURIComponent(item.uid || '')}:${level}`;
    const title = level === 'overdue' ? 'MOOC 作业已过期' : 'MOOC 作业即将截止';
    const deadlineText = formatNotificationDeadline(item.deadline);
    const message = `${item.courseName || '未知课程'} · ${item.title || '未命名作业'}${deadlineText ? '（' + deadlineText + '）' : ''}`;

    try {
      await chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: 'src/assets/icons/icon128.png',
        title,
        message,
        priority: level === 'overdue' ? 2 : 1
      });
      item.lastNotificationLevel = level;
      item.lastNotifiedAt = new Date().toISOString();
      changed = true;
    } catch (e) {
      console.warn('[MOOC Reminder] Notification failed:', e.message);
    }
  }

  if (changed) {
    await setHomeworkItems(allItems);
  }
}

chrome.notifications?.onClicked?.addListener(async (notificationId) => {
  if (!notificationId || notificationId.indexOf('mooc-reminder:') !== 0) return;
  const parts = notificationId.split(':');
  const uid = parts.length >= 2 ? decodeURIComponent(parts[1]) : '';
  if (!uid) return;

  try {
    const items = await getHomeworkItems();
    const item = items.find(i => i && i.uid === uid);
    if (item && item.pageUrl) {
      await chrome.tabs.create({ url: item.pageUrl });
    }
    await chrome.notifications.clear(notificationId);
  } catch (e) {
    console.debug('[MOOC Reminder] Notification click failed:', e.message);
  }
});
async function performPeriodicScrape() {
  console.log('[MOOC Reminder] Periodic scrape started');

  try {
    // Find open icourse163 tabs
    const tabs = await chrome.tabs.query({
      url: [
        'https://www.icourse163.org/learn/*',
        'https://www.icourse163.org/spoc/learn/*'
      ]
    });

    if (tabs.length === 0) {
      console.log('[MOOC Reminder] No icourse163 tabs open, skipping periodic scrape');
      return;
    }

    let scrapedCount = 0;
    for (const tab of tabs) {
      try {
        // Try sending SCRAPE_NOW message to content script
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'SCRAPE_NOW'
        });

        const processed = await processScrapeResponse(response);
        scrapedCount += processed.itemCount;
      } catch (e) {
        // Tab might not have content script ready — skip
        console.debug('[MOOC Reminder] Could not scrape tab', tab.id, e.message);
      }
    }

    await updateBadgeFromStorage();
    console.log(`[MOOC Reminder] Periodic scrape complete: ${scrapedCount} items from ${tabs.length} tabs`);
  } catch (e) {
    console.error('[MOOC Reminder] Periodic scrape failed:', e);
    await addSyncError(`Periodic scrape: ${e.message}`);
  }
}

async function triggerManualScrape() {
  console.log('[MOOC Reminder] Manual scrape triggered');

  // First try the tab-less API refresh of every known course.
  const apiResult = await apiRefreshAllKnownCourses();
  const apiChanged = (apiResult && apiResult.changed) || 0;

  try {
    const tabs = await chrome.tabs.query({
      url: [
        'https://www.icourse163.org/learn/*',
        'https://www.icourse163.org/spoc/learn/*'
      ]
    });

    if (tabs.length === 0) {
      if (apiResult && apiResult.okCount > 0) {
        return { success: true, scrapedCount: apiChanged, tabsScanned: 0, viaApi: true };
      }
      return {
        success: false,
        error: '没有打开的课程页面；后台接口也未刷新成功（请确认已登录 icourse163，或打开任一课程页面）',
        scrapedCount: 0
      };
    }

    let totalItems = 0;
    let errorCount = 0;

    for (const tab of tabs) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          type: 'SCRAPE_NOW'
        });

        const processed = await processScrapeResponse(response);
        totalItems += processed.changedCount;
      } catch (e) {
        errorCount++;
        // Try injecting content script and retrying
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['src/content/main.js']
          });
          await sleep(2000);
          const response = await chrome.tabs.sendMessage(tab.id, {
            type: 'SCRAPE_NOW'
          });
          if (response && response.course && response.homeworkItems) {
            const result = await reconcileHomeworkData(response.course, response.homeworkItems);
            totalItems += result.added + result.updated;
          }
        } catch (e2) {
          console.debug('[MOOC Reminder] Inject+retry failed for tab', tab.id, e2.message);
          await addSyncError(`Manual scrape tab ${tab.id}: ${e2.message}`);
        }
      }
    }

    await updateBadgeFromStorage();

    return {
      success: true,
      scrapedCount: totalItems + apiChanged,
      tabsScanned: tabs.length,
      errors: errorCount
    };
  } catch (e) {
    console.error('[MOOC Reminder] Manual scrape failed:', e);
    await addSyncError(`Manual scrape: ${e.message}`);
    return { success: false, error: e.message, scrapedCount: 0 };
  }
}

// ─── Storage Helpers ────────────────────────────────────

async function getHomeworkItems() {
  const result = await chrome.storage.local.get(KEYS.HOMEWORK_ITEMS);
  const raw = result[KEYS.HOMEWORK_ITEMS];
  // Filter out corrupted entries that may have been stored from previous crashes
  const items = Array.isArray(raw) ? raw.filter(Boolean) : [];
  return items;
}

async function setHomeworkItems(items) {
  // Never store null/undefined entries
  const clean = Array.isArray(items) ? items.filter(Boolean) : [];
  await chrome.storage.local.set({ [KEYS.HOMEWORK_ITEMS]: clean });
}

async function getCourses() {
  const result = await chrome.storage.local.get(KEYS.COURSES);
  const raw = result[KEYS.COURSES];
  const courses = Array.isArray(raw) ? raw.filter(Boolean) : [];
  return courses;
}

async function upsertCourse(course) {
  const courses = await getCourses();
  const idx = courses.findIndex(c => c.courseId === course.courseId);
  if (idx >= 0) {
    courses[idx] = { ...courses[idx], ...course, lastSeen: new Date().toISOString() };
  } else {
    course.firstSeen = course.firstSeen || new Date().toISOString();
    course.lastSeen = new Date().toISOString();
    courses.push(course);
  }
  await chrome.storage.local.set({ [KEYS.COURSES]: courses });
}

async function getLastSync() {
  const result = await chrome.storage.local.get(KEYS.LAST_SYNC);
  return result[KEYS.LAST_SYNC] || null;
}

async function getUserSettings() {
  const result = await chrome.storage.local.get(KEYS.USER_SETTINGS);
  return result[KEYS.USER_SETTINGS] || DEFAULT_SETTINGS;
}

async function getSyncErrors() {
  const result = await chrome.storage.local.get(KEYS.SYNC_ERRORS);
  const raw = result[KEYS.SYNC_ERRORS];
  return Array.isArray(raw) ? raw.filter(Boolean) : [];
}

async function getScrapeStatus() {
  const result = await chrome.storage.local.get(KEYS.SCRAPE_STATUS);
  return result[KEYS.SCRAPE_STATUS] || null;
}

async function setScrapeStatus(status) {
  if (!status || typeof status !== 'object') return;
  await chrome.storage.local.set({
    [KEYS.SCRAPE_STATUS]: {
      ...status,
      checkedAt: status.checkedAt || new Date().toISOString()
    }
  });
}

async function addSyncError(errorMessage) {
  const errors = await getSyncErrors();
  errors.push({
    time: new Date().toISOString(),
    error: errorMessage
  });
  // Keep last 20
  const trimmed = errors.length > 20 ? errors.slice(errors.length - 20) : errors;
  await chrome.storage.local.set({ [KEYS.SYNC_ERRORS]: trimmed });
}

async function getApiStatus() {
  const result = await chrome.storage.local.get(KEYS.API_STATUS);
  return result[KEYS.API_STATUS] || null;
}

async function setApiStatus(status) {
  if (!status || typeof status !== 'object') return;
  await chrome.storage.local.set({
    [KEYS.API_STATUS]: { ...status, checkedAt: new Date().toISOString() }
  });
}

// ─── icourse163 API — background, no-tab homework refresh ───────────────
// Inlined from src/shared/icourse163-api.js — keep the two in sync (the shared
// copy is unit-tested; this copy is what actually runs). Pulls homework
// deadlines for known course-terms WITHOUT an open tab, by calling the site's
// web JSON-RPC with the logged-in session cookie. Experimental and fully
// fenced: any failure is swallowed and the existing tab-based DOM scrape remains
// the authoritative path. termId (from the canonical learn URL) is the bridge
// key; our own courseId is attached to results so they dedup with DOM items.

const ICOURSE_ORIGIN = 'https://www.icourse163.org';
const CSRF_COOKIE_NAME = 'NTESSTUDYSI';
const API_TERM_DTO = 'web/j/courseBean.getMocTermDto.rpc';

const API_DEADLINE_FIELDS = ['deadline', 'endTime', 'submitEndTime', 'evaluationEndTime', 'examEndTime', 'testEndTime', 'homeworkEndTime', 'jobDeadline', 'closeTime'];
const API_SCORE_FIELDS = ['mark', 'score', 'studentScore', 'finalMark'];
const API_TOTAL_FIELDS = ['totalMark', 'totalScore', 'fullMark', 'allMark'];

function apiPad(n) { return String(n).padStart(2, '0'); }

function apiFirstNumber(obj, fields) {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === 'number' && isFinite(v) && v > 0) return v;
    if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  }
  return null;
}

function apiMsToLocalIso(ms) {
  const n = typeof ms === 'string' ? parseInt(ms, 10) : ms;
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  if (isNaN(d.getTime())) return null;
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${apiPad(d.getMonth() + 1)}-${apiPad(d.getDate())}T` +
    `${apiPad(d.getHours())}:${apiPad(d.getMinutes())}:00${sign}` +
    `${apiPad(Math.floor(Math.abs(tz) / 60))}:${apiPad(Math.abs(tz) % 60)}`;
}

function apiClassifyType(name) {
  const t = String(name || '');
  if (/考试|exam/i.test(t)) return 'exam';
  if (/测验|quiz|测试/i.test(t)) return 'quiz';
  if (/讨论|discussion/i.test(t)) return 'discussion';
  return 'homework';
}

function apiCoerceJson(input) {
  if (input == null) return null;
  if (typeof input === 'object') return input;
  if (typeof input !== 'string') return null;
  try { return JSON.parse(input); } catch { /* try prefix strip */ }
  const i = input.search(/[{[]/);
  if (i > 0) { try { return JSON.parse(input.slice(i)); } catch { return null; } }
  return null;
}

function apiExtractHomework(input, course) {
  const data = apiCoerceJson(input);
  if (!data || !course) return [];
  const out = [];
  const seen = new Set();
  let visited = 0;
  function looksLikeChapter(node) { return Array.isArray(node.lessons) || /chapter/i.test(node.type || ''); }
  function looksLikeLesson(node) { return Array.isArray(node.units) || /lesson/i.test(node.type || ''); }
  function visit(node, chapterId, lessonId) {
    if (!node || typeof node !== 'object' || visited > 5000) return;
    visited++;
    if (Array.isArray(node)) { for (const c of node) visit(c, chapterId, lessonId); return; }
    const name = node.name || node.title || node.unitName || '';
    const deadlineMs = apiFirstNumber(node, API_DEADLINE_FIELDS);
    const score = apiFirstNumber(node, API_SCORE_FIELDS);
    const totalScore = apiFirstNumber(node, API_TOTAL_FIELDS);
    const hasSignal = deadlineMs != null || (score != null && totalScore != null);
    if (typeof name === 'string' && name.trim() && hasSignal &&
        /测验|作业|考试|测试|quiz|exam|homework|test/i.test(name)) {
      const homeworkId = String(node.id || node.jobId || node.quizId || node.testId || node.homeworkId || '') || ('h' + (out.length + 1));
      const uid = `${course.courseId}_tid${course.termId}_ch${chapterId || ''}_le${lessonId || ''}_hw${homeworkId}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        const deadline = deadlineMs != null ? apiMsToLocalIso(deadlineMs) : null;
        const done = score != null && totalScore != null && score > 0;
        out.push({
          uid, courseId: course.courseId, termId: course.termId,
          chapterId: chapterId || '', lessonId: lessonId || '', homeworkId,
          title: name.trim(), type: apiClassifyType(name),
          courseName: course.courseName || '', schoolName: course.schoolName || '',
          status: done ? 'completed' : 'unfinished',
          checkedOff: done, manuallyCheckedOff: false,
          autoDetectedCompleted: done, completionReason: done ? 'auto' : null,
          deadline, deadlineRaw: deadline ? '(API)' : null,
          score, totalScore, source: 'api', pageUrl: course.pageUrl || ''
        });
      }
    }
    const nextChapter = node.chapterId || (looksLikeChapter(node) ? node.id : chapterId);
    const nextLesson = node.lessonId || (looksLikeLesson(node) ? node.id : lessonId);
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === 'object') visit(v, nextChapter, nextLesson);
    }
  }
  visit(data, '', '');
  return out;
}

async function getCsrfKey() {
  if (!chrome.cookies || !chrome.cookies.get) return null;
  try {
    const cookie = await chrome.cookies.get({ url: ICOURSE_ORIGIN + '/', name: CSRF_COOKIE_NAME });
    return cookie && cookie.value ? cookie.value : null;
  } catch {
    return null;
  }
}

async function apiFetchTermDto(csrfKey, termId) {
  const url = `${ICOURSE_ORIGIN}/${API_TERM_DTO}?csrfKey=${encodeURIComponent(csrfKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: `termId=${encodeURIComponent(termId)}&gatewayType=3`
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return await resp.text();
}

async function apiRefreshCourse(course, csrfKey) {
  if (!course || !course.termId) return 0;
  const text = await apiFetchTermDto(csrfKey, course.termId);
  const items = apiExtractHomework(text, course);
  if (items.length > 0) {
    const result = await reconcileHomeworkData(course, items);
    return result.added + result.updated;
  }
  return 0;
}

let apiRefreshInFlight = false;

async function apiRefreshAllKnownCourses() {
  if (apiRefreshInFlight) return { ok: false, reason: 'in_flight' };
  apiRefreshInFlight = true;
  try {
    const csrfKey = await getCsrfKey();
    if (!csrfKey) {
      await setApiStatus({ status: 'api_no_session', message: '未检测到 icourse163 登录态，已回退到打开页面时抓取' });
      return { ok: false, reason: 'no_csrf', okCount: 0, changed: 0 };
    }
    const courses = await getCourses();
    if (courses.length === 0) {
      await setApiStatus({ status: 'api_idle', message: '暂无已知课程，访问 icourse163 主页即可自动发现' });
      return { ok: true, changed: 0, courses: 0, okCount: 0 };
    }
    let changed = 0, okCount = 0, failed = 0;
    for (const course of courses) {
      try {
        changed += await apiRefreshCourse(course, csrfKey);
        okCount++;
      } catch (e) {
        failed++;
        console.debug('[MOOC Reminder] API refresh failed for', course.courseId, e.message);
      }
    }
    if (okCount > 0) {
      await updateBadgeFromStorage();
      await chrome.storage.local.set({ [KEYS.LAST_SYNC]: new Date().toISOString() });
      await setApiStatus({ status: 'api_ok', message: `后台已刷新 ${okCount}/${courses.length} 门课程`, itemCount: changed });
    } else {
      await setApiStatus({ status: 'api_unavailable', message: '后台接口暂不可用，已回退到打开页面时抓取' });
      await addSyncError(`API refresh: all ${failed} course(s) failed`);
    }
    return { ok: okCount > 0, changed, courses: courses.length, okCount, failed };
  } catch (e) {
    await addSyncError('API refresh: ' + e.message);
    return { ok: false, reason: e.message, okCount: 0, changed: 0 };
  } finally {
    apiRefreshInFlight = false;
  }
}

// ─── Utilities ──────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
