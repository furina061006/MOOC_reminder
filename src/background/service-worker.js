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
      await performPeriodicScrape();
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

  // Popup requests homework data
  async GET_HOMEWORK() {
    const items = await getHomeworkItems();  // already sanitized by getHomeworkItems
    const courses = await getCourses();
    const lastSync = await getLastSync();
    const settings = await getUserSettings();
    const syncErrors = await getSyncErrors();
    const scrapeStatus = await getScrapeStatus();

    return {
      items: items.filter(i => i && !i.checkedOff),  // unfinished only
      allItems: items,                                 // including completed
      courses,
      lastSync,
      settings,
      syncErrors,
      scrapeStatus
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
      // --- Secondary dedup: 标题+截止日期相同视为同一项（防hash变化导致重复） ---
      var dupIdx = existingItems.findIndex(function(i) { return i.title === newItem.title && i.deadline === newItem.deadline; });
      if (dupIdx >= 0) {
        var dupExisting = existingItems[dupIdx];
        // 保留手动勾选状态（Object.assign 会覆盖）
        var wasManual = dupExisting.manuallyCheckedOff;
        Object.assign(existingItems[dupIdx], newItem);
        existingItems[dupIdx].firstSeen = existingItems[dupIdx].firstSeen || new Date().toISOString();
        existingItems[dupIdx].lastUpdated = new Date().toISOString();
        if (wasManual) {
          existingItems[dupIdx].checkedOff = true;
          existingItems[dupIdx].manuallyCheckedOff = true;
          existingItems[dupIdx].completionReason = 'manual';
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

  try {
    const tabs = await chrome.tabs.query({
      url: [
        'https://www.icourse163.org/learn/*',
        'https://www.icourse163.org/spoc/learn/*'
      ]
    });

    if (tabs.length === 0) {
      return {
        success: false,
        error: '请打开 icourse163.org 课程页面后重试',
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
      scrapedCount: totalItems,
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

// ─── Utilities ──────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
