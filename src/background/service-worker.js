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
  USER_SETTINGS: 'user_settings',
  POPUP_UI_STATE: 'popup_ui_state',
  LAST_DIGEST_DATE: 'last_digest_date'
};

// Inlined from src/shared/settings.js — keep in sync (shared copy is unit-tested).
const DEFAULT_SETTINGS = {
  checkIntervalMinutes: 30,
  badgeRefreshMinutes: 5,
  autoDetectEnabled: true,
  notificationsEnabled: true,
  notifyLeadHours: [48, 24],
  notifyOverdue: true,
  quietHoursEnabled: false,
  quietStart: 22,
  quietEnd: 8,
  dailyDigestEnabled: false,
  dailyDigestHour: 8,
  mutedCourseIds: [],
  autoDismissErrors: true,
  showSnoozeButton: true,
  showCourseMute: true,
  domScrapingEnabled: false
};

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  if (typeof n !== 'number' || !isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeSettings(stored) {
  const s = (stored && typeof stored === 'object') ? stored : {};
  let leads = Array.isArray(s.notifyLeadHours) ? s.notifyLeadHours : DEFAULT_SETTINGS.notifyLeadHours;
  leads = leads.map(h => {
    const n = typeof h === 'string' ? parseInt(h, 10) : h;
    if (typeof n !== 'number' || !isFinite(n) || n < 1) return null;
    return Math.min(720, Math.round(n));
  }).filter(h => h != null).sort((a, b) => b - a);
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
    domScrapingEnabled: s.domScrapingEnabled !== false
  };
}

function resolveAlarmPeriods(settings) {
  const s = normalizeSettings(settings);
  return { scrapeMinutes: s.checkIntervalMinutes, badgeMinutes: s.badgeRefreshMinutes };
}

function isWithinQuietHours(settings, date) {
  const s = normalizeSettings(settings);
  if (!s.quietHoursEnabled) return false;
  const hour = date.getHours();
  if (s.quietStart === s.quietEnd) return false;
  if (s.quietStart < s.quietEnd) return hour >= s.quietStart && hour < s.quietEnd;
  return hour >= s.quietStart || hour < s.quietEnd;
}

// ─── Lifecycle ──────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[MOOC Reminder] Extension installed/updated:', details.reason);

  await validateAndRepairStorage();
  await setupAlarms();
  await checkMissedDigest();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[MOOC Reminder] Browser started, validating storage and setting up alarms');
  await validateAndRepairStorage();
  await setupAlarms();
  await checkMissedDigest();
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
        [KEYS.USER_SETTINGS]: normalizeSettings(data[KEYS.USER_SETTINGS])
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
        [KEYS.USER_SETTINGS]: normalizeSettings(data[KEYS.USER_SETTINGS])
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
        [KEYS.USER_SETTINGS]: normalizeSettings(DEFAULT_SETTINGS)
      });
    } catch {}
  }
}

// ─── Alarms ─────────────────────────────────────────────

async function setupAlarms() {
  const { scrapeMinutes, badgeMinutes } = resolveAlarmPeriods(await getUserSettings());

  // Recreate alarms with the user-configured cadence (no callback form so we
  // can await; create() replaces an existing alarm of the same name).
  await chrome.alarms.clear('periodic-scrape');
  await chrome.alarms.create('periodic-scrape', { periodInMinutes: scrapeMinutes });

  await chrome.alarms.clear('badge-refresh');
  await chrome.alarms.create('badge-refresh', { periodInMinutes: badgeMinutes });

  await chrome.alarms.clear('daily-digest');
  const digestSettings = normalizeSettings(await getUserSettings());
  if (digestSettings.dailyDigestEnabled) {
    await chrome.alarms.create('daily-digest', {
      when: nextDailyDigestWhen(digestSettings.dailyDigestHour),
      periodInMinutes: 24 * 60
    });
  }

  console.log(`[MOOC Reminder] Alarms configured: scrape=${scrapeMinutes}m badge=${badgeMinutes}m digest=${digestSettings.dailyDigestEnabled ? digestSettings.dailyDigestHour + ':00' : 'off'}`);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log('[MOOC Reminder] Alarm fired:', alarm.name);

  switch (alarm.name) {
    case 'periodic-scrape':
      // Tab-based DOM scrape + content-script-proxied API fetch for all courses.
      // The content script uses page-context same-origin requests to bypass CSRF.
      await performPeriodicScrape();
      break;
    case 'badge-refresh':
      await updateBadgeFromStorage();
      break;
    case 'daily-digest':
      await sendDailyDigestNotification();
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

function makeManualHomeworkUid(title, deadline, courseName) {
  const text = [title || '', deadline || '', courseName || ''].join('|');
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return 'manual_tidmanual_ch_le_hw' + (hash >>> 0).toString(16).padStart(8, '0');
}

function isCourseMuted(item, settings) {
  const muted = settings && Array.isArray(settings.mutedCourseIds) ? settings.mutedCourseIds : [];
  return !!(item && muted.indexOf(item.courseId) >= 0);
}

function isSnoozed(item, now) {
  if (!item || !item.snoozedUntil) return false;
  const t = new Date(item.snoozedUntil).getTime();
  return !isNaN(t) && t > now.getTime();
}

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

  // Content script proxies API results (page-context same-origin fetch)
  async COURSE_API_DATA(msg) {
    if (!msg.course || !msg.rawData) return { success: false, error: 'Invalid payload' };
    try {
      const items = apiExtractHomework(msg.rawData, msg.course);
      if (items.length === 0) return { success: true, itemCount: 0 };
      const result = await reconcileHomeworkData(msg.course, items);
      await updateBadgeFromStorage();
      await chrome.storage.local.set({ [KEYS.LAST_SYNC]: new Date().toISOString() });
      console.log(`[MOOC Reminder] Course API data: ${items.length} items from ${msg.course.courseId}`);
      return { success: true, added: result.added, updated: result.updated, itemCount: items.length };
    } catch (e) {
      console.warn('[MOOC Reminder] COURSE_API_DATA error:', e.message);
      return { success: false, error: e.message };
    }
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
    const settings = normalizeSettings(await getUserSettings());
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

  // Popup adds a manually-created reminder (for missed scraper items or offline homework)
  async ADD_MANUAL_ITEM(msg) {
    const title = String(msg.title || '').trim();
    const deadline = msg.deadline ? new Date(msg.deadline) : null;
    if (!title || !deadline || isNaN(deadline.getTime())) {
      return { success: false, error: '标题和截止时间必填' };
    }
    const courseName = String(msg.courseName || '手动提醒').trim() || '手动提醒';
    const courseId = String(msg.courseId || 'manual').trim() || 'manual';
    const now = new Date().toISOString();
    const item = {
      uid: makeManualHomeworkUid(title, deadline.toISOString(), courseName),
      identityKey: ['manual', courseId, title, deadline.toISOString()].join('|'),
      courseId,
      termId: 'manual',
      chapterId: '',
      lessonId: '',
      homeworkId: makeManualHomeworkUid(title, deadline.toISOString(), courseName).replace(/^manual_tidmanual_ch_le_hw/, ''),
      title,
      type: msg.type || 'homework',
      courseName,
      schoolName: String(msg.schoolName || '').trim(),
      status: 'unfinished',
      checkedOff: false,
      manuallyCheckedOff: false,
      autoDetectedCompleted: false,
      completionReason: null,
      deadline: deadline.toISOString(),
      deadlineRaw: '(手动添加)',
      firstSeen: now,
      lastUpdated: now,
      pageUrl: String(msg.pageUrl || '').trim(),
      source: 'manual'
    };
    const items = await getHomeworkItems();
    items.push(item);
    await setHomeworkItems(items);
    await upsertCourse({ courseId, termId: 'manual', courseName, schoolName: item.schoolName, courseType: 'manual' });
    await updateBadgeFromStorage();
    return { success: true, item };
  },

  // Popup snoozes notification for one item (badge count is unchanged)
  async SNOOZE_ITEM(msg) {
    if (!msg.homeworkUid) return { success: false, error: 'Invalid payload' };
    const hours = clampInt(msg.hours, 1, 168, 24);
    const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    const items = await getHomeworkItems();
    const item = items.find(i => i && i.uid === msg.homeworkUid);
    if (!item) return { success: false, error: 'Item not found' };
    item.snoozedUntil = until;
    item.lastUpdated = new Date().toISOString();
    await setHomeworkItems(items);
    return { success: true, snoozedUntil: until };
  },

  // Popup mutes/unmutes a course for notifications/digests
  async TOGGLE_COURSE_MUTE(msg) {
    const courseId = String(msg.courseId || '').trim();
    if (!courseId) return { success: false, error: 'Invalid payload' };
    const settings = normalizeSettings(await getUserSettings());
    const muted = new Set(settings.mutedCourseIds || []);
    if (msg.muted === false) muted.delete(courseId);
    else if (msg.muted === true) muted.add(courseId);
    else if (muted.has(courseId)) muted.delete(courseId); else muted.add(courseId);
    settings.mutedCourseIds = Array.from(muted);
    await chrome.storage.local.set({ [KEYS.USER_SETTINGS]: settings });
    return { success: true, muted: settings.mutedCourseIds.indexOf(courseId) >= 0, settings };
  },

  // Popup UI state persistence (filter + collapsed courses)
  async GET_POPUP_STATE() {
    const raw = await chrome.storage.local.get(KEYS.POPUP_UI_STATE);
    return { success: true, uiState: raw[KEYS.POPUP_UI_STATE] || {} };
  },

  async SET_POPUP_STATE(msg) {
    const current = (await chrome.storage.local.get(KEYS.POPUP_UI_STATE))[KEYS.POPUP_UI_STATE] || {};
    const uiState = { ...current, ...(msg.uiState || {}) };
    await chrome.storage.local.set({ [KEYS.POPUP_UI_STATE]: uiState });
    return { success: true, uiState };
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

  // Options page reads current settings
  async GET_SETTINGS() {
    return { success: true, settings: normalizeSettings(await getUserSettings()) };
  },

  // Options page reads courses list
  async GET_COURSES() {
    const courses = await getCourses();
    return { success: true, courses };
  },

  // Options page saves settings → persist (normalized) and re-apply alarm cadence
  async SETTINGS_UPDATED(msg) {
    const saved = normalizeSettings(msg && msg.settings);
    await chrome.storage.local.set({ [KEYS.USER_SETTINGS]: saved });
    await setupAlarms();
    await updateBadgeFromStorage();
    console.log('[MOOC Reminder] Settings updated, domScrapingEnabled:', saved.domScrapingEnabled);
    return { success: true, settings: saved };
  },

  // Clear sync errors from storage
  async CLEAR_ERRORS() {
    await chrome.storage.local.set({ [KEYS.SYNC_ERRORS]: [] });
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
  const autoDetect = normalizeSettings(await getUserSettings()).autoDetectEnabled;
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

    // If auto-detect is disabled, scraped/API auto-completion must not mark
    // items as badge-done. Manual check-off is still preserved below.
    if (!autoDetect && newItem.autoDetectedCompleted) {
      newItem.checkedOff = false;
      newItem.autoDetectedCompleted = false;
      newItem.completionReason = null;
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

      // Apply auto-detection (only if enabled and not manually overridden)
      if (autoDetect && !newItem.checkedOff && newItem.autoDetectedCompleted) {
        newItem.checkedOff = true;
        newItem.completionReason = 'auto';
      }

      // Preserve firstSeen
      newItem.firstSeen = existing.firstSeen;
      newItem.lastUpdated = new Date().toISOString();

      // apiCompleted 标记保护：API 确认的完成状态不被 DOM 数据回退
      if (existing.apiCompleted && !newItem.apiCompleted && !newItem.manuallyCheckedOff) {
        newItem.checkedOff = true;
        newItem.autoDetectedCompleted = true;
        if (!newItem.completionReason) newItem.completionReason = 'auto';
      }

      // 保留作业互评阶段：如果新爬取未检测到阶段，沿用已有值
      if (!newItem.hwPhase && existing.hwPhase) {
        newItem.hwPhase = existing.hwPhase;
      }

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
        var wasApiCompleted = dupExisting.apiCompleted;
        var oldCompletionReason = dupExisting.completionReason;
        var oldFirstSeen = dupExisting.firstSeen;
        var oldUid = dupExisting.uid;
        var oldHwPhase = dupExisting.hwPhase;
        Object.assign(existingItems[dupIdx], newItem);
        // 保留互评阶段：新爬取未检测到时沿用旧值
        if (!existingItems[dupIdx].hwPhase && oldHwPhase) {
          existingItems[dupIdx].hwPhase = oldHwPhase;
        }
        existingItems[dupIdx].firstSeen = oldFirstSeen || new Date().toISOString();
        existingItems[dupIdx].lastUpdated = new Date().toISOString();
        if (oldUid && oldUid !== newItem.uid) {
          existingItems[dupIdx].previousUid = oldUid;
        }
        // API 自动检测优先：若已存条目已完成，新数据不可回退
        if (!existingItems[dupIdx].checkedOff && wasApiCompleted) {
          existingItems[dupIdx].checkedOff = true;
          existingItems[dupIdx].completionReason = existingItems[dupIdx].completionReason || 'auto';
        }
        if (wasManual) {
          existingItems[dupIdx].checkedOff = true;
          existingItems[dupIdx].manuallyCheckedOff = true;
          existingItems[dupIdx].completionReason = 'manual';
        } else if (wasCheckedOff || (autoDetect && newItem.autoDetectedCompleted)) {
          existingItems[dupIdx].checkedOff = true;
          existingItems[dupIdx].completionReason = (autoDetect && newItem.autoDetectedCompleted) ? 'auto' : oldCompletionReason;
        }
        updated++;
      } else {
        // --- Genuinely new item ---
        if (autoDetect && newItem.autoDetectedCompleted) {
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
    const settings = normalizeSettings(await getUserSettings());
    const mutedIds = new Set(settings.mutedCourseIds || []);
    const unfinished = items.filter(i => !i.checkedOff && !mutedIds.has(i.courseId));
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


function nextDailyDigestWhen(hour) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(clampInt(hour, 0, 23, DEFAULT_SETTINGS.dailyDigestHour), 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

function getDigestItems(items, now, horizonHours) {
  const ts = now.getTime();
  const horizon = ts + (horizonHours || 48) * 60 * 60 * 1000;
  return (Array.isArray(items) ? items : [])
    .filter(item => {
      if (!item || item.checkedOff || !item.deadline) return false;
      const due = new Date(item.deadline).getTime();
      return !isNaN(due) && due <= horizon;
    })
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
}

function formatDigestMessage(items, now) {
  const digestItems = getDigestItems(items, now, 48);
  if (digestItems.length === 0) return null;
  const shown = digestItems.slice(0, 3).map(item => {
    const due = new Date(item.deadline);
    const overdue = due < now;
    const pad = function(n) { return String(n).padStart(2, '0'); };
    const day = pad(due.getMonth() + 1) + '/' + pad(due.getDate()) + ' ' + pad(due.getHours()) + ':' + pad(due.getMinutes());
    return (item.courseName || 'MOOC') + ' · ' + (item.title || '未命名作业') + (overdue ? '（已过期）' : '（' + day + '）');
  });
  const more = digestItems.length > shown.length ? `，另有 ${digestItems.length - shown.length} 项` : '';
  return shown.join('；') + more;
}

async function checkMissedDigest() {
  var settings = normalizeSettings(await getUserSettings());
  if (!settings.dailyDigestEnabled) return;
  var today = new Date();
  var todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  var raw = await chrome.storage.local.get(KEYS.LAST_DIGEST_DATE);
  if (raw[KEYS.LAST_DIGEST_DATE] === todayStr) return;
  var nowHour = today.getHours();
  var digestHour = clampInt(settings.dailyDigestHour, 0, 23, 8);
  if (nowHour < digestHour) return;
  console.log('[MOOC Reminder] Missed daily digest at ' + digestHour + ':00, sending now');
  await sendDailyDigestNotification();
}

async function sendDailyDigestNotification() {
  if (!chrome.notifications) return;
  const settings = normalizeSettings(await getUserSettings());
  if (!settings.dailyDigestEnabled || !settings.notificationsEnabled) return;
  const now = new Date();
  if (isWithinQuietHours(settings, now)) return;
  const items = (await getHomeworkItems()).filter(item => !isCourseMuted(item, settings) && !isSnoozed(item, now));
  const message = formatDigestMessage(items, now);
  if (!message) return;
  try {
    await chrome.storage.local.set({ [KEYS.LAST_DIGEST_DATE]: new Date().getFullYear() + '-' + String(new Date().getMonth()+1).padStart(2,'0') + '-' + String(new Date().getDate()).padStart(2,'0') });
    await chrome.notifications.create('mooc-reminder:daily-digest', {
      type: 'basic',
      iconUrl: 'src/assets/icons/icon128.png',
      title: '今日 MOOC 作业汇总',
      message,
      priority: 1
    });
  } catch (e) {
    console.warn('[MOOC Reminder] Daily digest notification failed:', e.message);
  }
}

function getNotificationLevel(item, now, settings) {
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

  const ascending = s.notifyLeadHours.slice().sort((a, b) => a - b);
  for (const lead of ascending) {
    if (diff <= lead * 60 * 60 * 1000) return 'due_' + lead + 'h';
  }
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

  const settings = normalizeSettings(await getUserSettings());
  if (!settings.notificationsEnabled) return;

  const now = new Date();
  // During quiet hours, hold off — the next badge-refresh tick outside the
  // window will deliver any still-pending reminders.
  if (isWithinQuietHours(settings, now)) return;

  let changed = false;

  for (const item of unfinishedItems) {
    if (isCourseMuted(item, settings) || isSnoozed(item, now)) continue;
    const level = getNotificationLevel(item, now, settings);
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

    // 把已知课程发一份给 content script，让它用页面上下文拉 API
    const courses = await getCourses();
    console.log('[MOOC Reminder] Periodic: Sending BATCH_API_FETCH, courses:', courses.length);
    var apiCourses = courses.map(function(c) { return { courseId: c.courseId, termId: c.activeTermId || c.termId || '', courseName: c.courseName || '', schoolName: c.schoolName || '' }; });
    for (const tab of tabs) {
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'BATCH_API_FETCH', courses: apiCourses }).catch(function(){});
        } catch {}
      }

    var settings = normalizeSettings(await getUserSettings());
    var doDomScrape = settings.domScrapingEnabled !== false;

    let scrapedCount = 0;
    if (doDomScrape) {
      for (const tab of tabs) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, {
            type: 'SCRAPE_NOW'
        });

        const processed = await processScrapeResponse(response);
        scrapedCount += processed.itemCount;
        } catch (e) {
          console.debug('[MOOC Reminder] Could not scrape tab', tab.id, e.message);
        }
      }
    } else {
      console.log('[MOOC Reminder] DOM scraping disabled, using API-only mode');
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
      // 没有打开的页面——不可能。让用户打开任一课程页面即可
      return {
        success: false,
        error: '请打开任一 icourse163 课程页面后重试',
        scrapedCount: 0
      };
    }

    // 把已知课程发给 content script 做页面上下文 API 抓取
    const courses = await getCourses();
    console.log('[MOOC Reminder] Sending BATCH_API_FETCH:', courses.length, 'courses to', tabs.length, 'tabs');
    var apiCourses = courses.map(function(c) { return { courseId: c.courseId, termId: c.activeTermId || c.termId || '', courseName: c.courseName || '', schoolName: c.schoolName || '' }; });
    for (const tab of tabs) {
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'BATCH_API_FETCH', courses: apiCourses }).catch(function(){});
      } catch {}
    }

    let totalItems = 0;
    let errorCount = 0;

    var s = normalizeSettings(await getUserSettings());
    if (s.domScrapingEnabled !== false) {
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
    } // end domScrapingEnabled guard

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
  return normalizeSettings(result[KEYS.USER_SETTINGS]);
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
const API_TERM_DTO_RPC = 'web/j/courseBean.getMocTermDto.rpc';
const API_TERM_DTO_DWR = 'dwr/call/plaincall/CourseBean.getMocTermDto.dwr';

const API_DEADLINE_FIELDS = ['deadline', 'endTime', 'submitEndTime', 'evaluateEnd', 'evaluationEndTime', 'examEndTime', 'testEndTime', 'homeworkEndTime', 'jobDeadline', 'closeTime'];
const API_SCORE_FIELDS = ['userScore', 'mark', 'score', 'studentScore', 'finalMark'];
const API_TOTAL_FIELDS = ['totalMark', 'totalScore', 'fullMark', 'allMark'];

function apiPad(n) { return String(n).padStart(2, '0'); }

function apiDetectPhase(node) {
  // 测验(type:2)无互评，作业(type:3)才有
  if (String(node.type||'') !== '3') return null;
  if (!node.enableEvaluation || node.evaluateStart == null) return null;
  var pub = parseInt(node.scorePubStatus,10) || 0;
  if (pub === 2) return 'results';
  if (pub === 1) return 'peerreview';
  var now = Date.now();
  var start = parseInt(node.evaluateStart,10);
  var end = parseInt(node.evaluateScoreReleaseTime||node.evaluateEnd,10);
  if (start && now < start) return 'submit';
  if (end && now >= end) return 'results';
  return 'peerreview';
}

function apiHasCompletedText(node, depth) {
  if (!node || typeof node !== 'object' || (depth||0) > 6) return false;
  var d = depth || 0;
  var pat = /已完成|已成功提交|已提交|已批阅|已通过|已互评|查看成绩|查看分数/i;
  for (var key of Object.keys(node)) {
    var v = node[key];
    if (typeof v === 'string' && pat.test(v)) return true;
    if (Array.isArray(v)) { for (var e of v) { if (e && typeof e === 'object' && apiHasCompletedText(e, d + 1)) return true; } }
    else if (v && typeof v === 'object' && apiHasCompletedText(v, d + 1)) return true;
  }
  return false;
}

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

function apiClassifyType(name, rawType) {
  // API 的 type 字段是权威值：2=测验, 3=作业, 6=考试
  // 名字正则作为 fallback
  var rt = rawType !== undefined ? String(rawType) : '';
  if (rt === '6' || rt === '2' || rt === '3') {
    if (rt === '6') return 'exam';
    if (rt === '2') return 'quiz';
    if (rt === '3') return 'homework';
  }
  var t = String(name || '');
  // "期末" 前缀的测试/考试都是 exam，不是 quiz
  if (rt === '6' || /期末|考试|exam/i.test(t)) return 'exam';
  if (rt === '2' || /测验|quiz|测试/i.test(t)) return 'quiz';
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
        // 互评中：用 evaluateEnd 代替原来的提交截止日期
        var phaseDeadline = deadlineMs;
        if (apiDetectPhase(node) === 'peerreview' && (parseInt(node.scorePubStatus,10) || 0) === 0) {
          var pe = parseInt(node.evaluateEnd,10);
          if (pe > 0) phaseDeadline = pe;
        }
        const deadline = phaseDeadline != null ? apiMsToLocalIso(phaseDeadline) : null;
        // 完成判定：有分数 OR 节点含 "已提交/已完成" 文本
        var submitted = parseInt(node.usedTryCount,10) > 0 && (parseInt(node.type,10) === 3);
        // 互评中不算完成（等待评分），已公布的才算
        var inPeerReview = apiDetectPhase(node) === 'peerreview' && (parseInt(node.scorePubStatus,10) || 0) === 0;
        var done = (score != null && totalScore != null && score > 0) || (submitted && !inPeerReview) || apiHasCompletedText(node, 0);
        out.push({
          uid, courseId: course.courseId, termId: course.termId,
          chapterId: chapterId || '', lessonId: lessonId || '', homeworkId,
          title: name.trim(), type: apiClassifyType(name, node.type !== undefined ? node.type : null),
          courseName: course.courseName || '', schoolName: course.schoolName || '',
          status: done ? 'completed' : 'unfinished',
          checkedOff: done, manuallyCheckedOff: false,
          autoDetectedCompleted: done, completionReason: done ? 'auto' : null,
          hwPhase: apiDetectPhase(node),
          deadline, deadlineRaw: deadline ? '(API)' : null,
          score, totalScore, source: 'api', pageUrl: course.pageUrl || '',
          apiCompleted: done
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
  // 去重：名字几乎相同且共前缀的噪音项（如 "期末测试题" vs "期末测试"）
  for (var i = out.length - 1; i >= 0; i--) {
    var nameA = out[i].title || '';
    for (var j = 0; j < i; j++) {
      var nameB = out[j].title || '';
      if (nameB.length > 0 && nameA.indexOf(nameB) === 0 && nameA.length - nameB.length <= 2) {
        // nameA 是 nameB 的扩大版（如 "期末测试题" vs "期末测试"），去掉 nameA
        out.splice(i, 1);
        break;
      }
      if (nameA.length > 0 && nameB.indexOf(nameA) === 0 && nameB.length - nameA.length <= 2) {
        // nameB 是 nameA 的扩大版，去掉 nameB
        out.splice(j, 1);
        j--;
      }
    }
  }

  return out;
}

const CSRF_COOKIE_NAMES = ['NTESSTUDYSI', 'EDUWEB', 'SESSION'];

async function getCsrfKey() {
  if (!chrome.cookies || !chrome.cookies.get) return null;
  for (const name of CSRF_COOKIE_NAMES) {
    try {
      const cookie = await chrome.cookies.get({ url: ICOURSE_ORIGIN + '/', name: name });
      if (cookie && cookie.value) {
        console.log('[MOOC Reminder] Found CSRF cookie:', name);
        return cookie.value;
      }
    } catch {
      continue;
    }
  }
  console.warn('[MOOC Reminder] No CSRF cookie found among:', CSRF_COOKIE_NAMES);
  return null;
}

function makeApiError(label, message, details) {
  const e = new Error(label + ': ' + message);
  e.details = details || {};
  return e;
}

function responseSnippet(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 180);
}

async function apiFetchRpcTermDto(csrfKey, termId) {
  const url = `${ICOURSE_ORIGIN}/${API_TERM_DTO_RPC}?csrfKey=${encodeURIComponent(csrfKey)}`;
  const body = `termId=${encodeURIComponent(termId)}&gatewayType=3`;
  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Origin': ICOURSE_ORIGIN,
      'Referer': ICOURSE_ORIGIN + '/learn/'
    },
    body
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw makeApiError('rpc', 'HTTP ' + resp.status, { endpoint: API_TERM_DTO_RPC, status: resp.status, body: responseSnippet(text) });
  }
  if (/非法跨域|csrf|forbidden|error/i.test(text)) {
    throw makeApiError('rpc', 'server rejected request', { endpoint: API_TERM_DTO_RPC, body: responseSnippet(text) });
  }
  return { text, endpoint: API_TERM_DTO_RPC };
}

async function apiFetchDwrTermDto(termId) {
  const url = `${ICOURSE_ORIGIN}/${API_TERM_DTO_DWR}`;
  // DWR format used by public icourse163 downloaders. batchId/scriptSessionId
  // values are tolerated by many DWR deployments when empty; this is a fallback
  // only, so failures are diagnostic rather than fatal to DOM scraping.
  const body = [
    'callCount=1',
    'scriptSessionId=',
    'httpSessionId=',
    'c0-scriptName=CourseBean',
    'c0-methodName=getMocTermDto',
    'c0-id=0',
    'c0-param0=number:' + encodeURIComponent(termId),
    'c0-param1=boolean:true',
    'batchId=0'
  ].join('&');
  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Origin': ICOURSE_ORIGIN
    },
    body
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw makeApiError('dwr', 'HTTP ' + resp.status, { endpoint: API_TERM_DTO_DWR, status: resp.status, body: responseSnippet(text) });
  }
  if (/exception|forbidden|csrf|非法跨域/i.test(text)) {
    throw makeApiError('dwr', 'server rejected request', { endpoint: API_TERM_DTO_DWR, body: responseSnippet(text) });
  }
  return { text, endpoint: API_TERM_DTO_DWR };
}

async function apiFetchTermDto(csrfKey, termId) {
  const errors = [];
  const hasCsrf = !!csrfKey;
  try {
    const result = await apiFetchRpcTermDto(csrfKey, termId);
    result.csrfOk = hasCsrf;
    return result;
  } catch (e) {
    e.details = e.details || {};
    e.details.csrfKeyFound = hasCsrf;
    errors.push(e.details || { message: e.message });
  }
  try {
    const result = await apiFetchDwrTermDto(termId);
    result.csrfOk = hasCsrf;
    return result;
  } catch (e) {
    e.details = e.details || {};
    e.details.csrfKeyFound = hasCsrf;
    errors.push(e.details || { message: e.message });
  }
  throw makeApiError('termDto', 'all endpoints failed', { termId, errors, csrfKeyFound: hasCsrf });
}

async function apiRefreshCourse(course, csrfKey) {
  if (!course || !course.termId) return { changed: 0, itemCount: 0, endpoint: null };
  const fetched = await apiFetchTermDto(csrfKey, course.termId);
  const items = apiExtractHomework(fetched.text, course);
  if (items.length > 0) {
    const result = await reconcileHomeworkData(course, items);
    return { changed: result.added + result.updated, itemCount: items.length, endpoint: fetched.endpoint };
  }
  return { changed: 0, itemCount: 0, endpoint: fetched.endpoint };
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
    let changed = 0, okCount = 0, failed = 0, itemCount = 0;
    const failureDetails = [];
    const endpoints = {};
    for (const course of courses) {
      try {
        const refreshed = await apiRefreshCourse(course, csrfKey);
        changed += refreshed.changed || 0;
        itemCount += refreshed.itemCount || 0;
        if (refreshed.endpoint) endpoints[refreshed.endpoint] = (endpoints[refreshed.endpoint] || 0) + 1;
        okCount++;
      } catch (e) {
        failed++;
        const detail = {
          courseId: course && course.courseId,
          termId: course && course.termId,
          message: e.message,
          details: e.details || null
        };
        failureDetails.push(detail);
        console.debug('[MOOC Reminder] API refresh failed for', course.courseId, e.message, e.details || '');
      }
    }
    if (okCount > 0) {
      await updateBadgeFromStorage();
      await chrome.storage.local.set({ [KEYS.LAST_SYNC]: new Date().toISOString() });
      await setApiStatus({
        status: 'api_ok',
        message: `后台接口连通 ${okCount}/${courses.length} 门课程，识别到 ${itemCount} 个条目`,
        itemCount,
        changedCount: changed,
        endpoints
      });
    } else {
      const first = failureDetails[0];
      // 检查是否因未登录导致失败
      const csrfFound = !failureDetails.some(function(f) { return f.details && f.details.csrfKeyFound === false; });
      const csrfNote = csrfFound ? 'CSRF密钥已找到但被拒绝' : '未找到CSRF登录态密钥，请确认已登录icourse163.org';
      await setApiStatus({
        status: 'api_unavailable',
        message: first ? ('后台接口暂不可用：' + first.message + '。' + csrfNote) : '后台接口暂不可用，已回退到打开页面时抓取',
        failures: failureDetails.slice(0, 3),
        csrfFound: csrfFound
      });
      await addSyncError('API refresh failed: ' + JSON.stringify(failureDetails.slice(0, 2)));
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
