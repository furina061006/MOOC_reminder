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
  TEMPORARY_PROXY_JOB: 'temporary_proxy_job',
  DISMISSED_COMPLETED: 'dismissed_completed_uids',
  API_STATUS: 'api_status',
  USER_SETTINGS: 'user_settings',
  POPUP_UI_STATE: 'popup_ui_state',
  LAST_DIGEST_DATE: 'last_digest_date',
  UPDATE_STATUS: 'update_status'
};

function getNotificationIconUrl() {
  try {
    return chrome.runtime.getURL('src/assets/icons/icon128.png');
  } catch {
    // Test stubs and older browsers may not expose getURL.
    return 'src/assets/icons/icon128.png';
  }
}

// Settings defaults/logic live in src/shared/settings.js (unit-tested) and are
// imported here — the SW is a module worker (manifest "type": "module"), so no
// inlined duplicate copy is kept anymore.
import {
  DEFAULT_SETTINGS,
  clampInt,
  normalizeSettings,
  resolveAlarmPeriods,
  isWithinQuietHours
} from '../shared/settings.js';
import {
  collectDueNotifications,
  isCourseMuted,
  isSnoozed,
  notificationIdFor,
  nextQuietEndWhen
} from '../shared/reminder.js';
import { resolveItemUrl } from '../shared/item-url.js';
import { createSerializedStore } from '../shared/items-mutex.js';
import {
  RELEASES_API_URL,
  RELEASES_PAGE_URL,
  evaluateRelease,
  resolveDownloadTarget
} from '../shared/update-check.js';

// homework_items has many concurrent read-modify-write writers (reconcile,
// notification bookkeeping, popup actions). All RMW mutations must go through
// this serialized store; direct get→mutate→setHomeworkItems sequences race
// and silently revert each other.
const mutateHomeworkItems = createSerializedStore({
  get: getHomeworkItems,
  set: setHomeworkItems
});

// `courses` has the same concurrent-writer problem: COURSE_LINKS loops over
// discovered courses, every COURSE_API_DATA reconcile upserts course metadata,
// and COURSE_UPDATE fires from SPOC pages. Without a serialized RMW store, two
// writers read the same array and the later write silently drops the other's
// course (lost course, reverted activeTermId, overwritten name).
const mutateCourses = createSerializedStore({
  get: getCourses,
  set: setCourses
});

// ─── Lifecycle ──────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[MOOC Reminder] Extension installed/updated:', details.reason);

  await validateAndRepairStorage();
  await recoverTemporaryProxyJob();
  await setupAlarms();
  await sendStartupDigestIfNeeded();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[MOOC Reminder] Browser started, validating storage and setting up alarms');
  await validateAndRepairStorage();
  await recoverTemporaryProxyJob();
  await setupAlarms();
  await sendStartupDigestIfNeeded();
  // 浏览器启动 = 每日新鲜度锚点：配合 12h 兜底周期，构成「事件驱动为主、
  // 周期 alarm 兜底」的调度（作业按天更新，不需要高频轮询）
  maybeTriggerEventRefresh('startup').catch(() => {});
});

// ─── Storage Validation ─────────────────────────────────

async function validateAndRepairStorage() {
  try {
    const data = await chrome.storage.local.get([
      KEYS.HOMEWORK_ITEMS,
      KEYS.COURSES,
      KEYS.USER_SETTINGS,
      KEYS.SCRAPE_STATUS,
      KEYS.TEMPORARY_PROXY_JOB,
      KEYS.DISMISSED_COMPLETED
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

    // Check dismissed_completed_uids
    const dismissed = data[KEYS.DISMISSED_COMPLETED];
    if (dismissed !== undefined && !Array.isArray(dismissed)) {
      console.warn('[MOOC Reminder] Corrupted dismissed_completed_uids detected, resetting');
      needsRepair = true;
    }

    if (needsRepair) {
      await chrome.storage.local.set({
        [KEYS.HOMEWORK_ITEMS]: [],
        [KEYS.COURSES]: [],
        [KEYS.LAST_SYNC]: null,
        [KEYS.SYNC_ERRORS]: [],
        [KEYS.SCRAPE_STATUS]: data[KEYS.SCRAPE_STATUS] || null,
        [KEYS.TEMPORARY_PROXY_JOB]: data[KEYS.TEMPORARY_PROXY_JOB] || null,
        [KEYS.DISMISSED_COMPLETED]: [],
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
        [KEYS.TEMPORARY_PROXY_JOB]: data[KEYS.TEMPORARY_PROXY_JOB] || null,
        [KEYS.DISMISSED_COMPLETED]: Array.isArray(dismissed) ? dismissed.filter(Boolean) : [],
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
        [KEYS.TEMPORARY_PROXY_JOB]: null,
        [KEYS.DISMISSED_COMPLETED]: [],
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

// ─── Update check ───────────────────────────────────────
//
// This extension is side-loaded, so Chrome never updates it (no update_url/key).
// We can only tell the user a newer release exists and hand them the download
// link. Pure version logic lives in shared/update-check.js.

const UPDATE_NOTIFICATION_PREFIX = 'mooc-reminder:update:';

async function getUpdateStatus() {
  const result = await chrome.storage.local.get(KEYS.UPDATE_STATUS);
  const raw = result[KEYS.UPDATE_STATUS];
  return (raw && typeof raw === 'object') ? raw : null;
}

// chrome.runtime.getManifest() exists in every real extension, but reading it
// must never be the thing that breaks an alarm tick (test stubs, odd runtimes).
function getRunningVersion() {
  try {
    return String(chrome.runtime.getManifest().version || '');
  } catch {
    return '';
  }
}

/** Returns true only when a notification was actually created. */
async function notifyUpdateAvailable(status) {
  if (!chrome.notifications || !chrome.notifications.create) return false;
  // An update is not urgent — never wake the user during quiet hours. The next
  // tick will retry, because lastNotifiedVersion is only advanced on success.
  const settings = normalizeSettings(await getUserSettings());
  if (isWithinQuietHours(settings, new Date())) return false;
  try {
    await chrome.notifications.create(UPDATE_NOTIFICATION_PREFIX + status.latestVersion, {
      type: 'basic',
      iconUrl: getNotificationIconUrl(),
      title: 'MOOC Reminder 有新版本',
      message: `v${status.currentVersion} → v${status.latestVersion}，点击前往下载`,
      priority: 1
    });
    return true;
  } catch (e) {
    console.warn('[MOOC Reminder] Update notification failed:', e.message);
    return false;
  }
}

/**
 * Ask GitHub for the newest release and remember the answer.
 *
 * Rides the existing 12h `badge-refresh` tick rather than adding an alarm: an
 * update check is not worth extra service-worker wake-ups. The result is cached
 * in `update_status` so the options page renders without a network call.
 *
 * Never throws — the status object carries an `error` field instead.
 */
async function checkForUpdates({ manual = false } = {}) {
  const settings = normalizeSettings(await getUserSettings());
  if (!manual && !settings.autoCheckUpdates) return await getUpdateStatus();

  const previous = (await getUpdateStatus()) || {};
  const currentVersion = getRunningVersion();
  let result;
  let error = null;

  try {
    const response = await fetch(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store'
    });
    if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : '?'));
    const evaluated = evaluateRelease(await response.json(), currentVersion);
    if (!evaluated) throw new Error('无法解析 Release 信息');
    result = {
      currentVersion,
      latestVersion: evaluated.version,
      updateAvailable: evaluated.updateAvailable,
      downloadUrl: evaluated.downloadUrl,
      releaseUrl: evaluated.releaseUrl,
      notes: evaluated.notes,
      publishedAt: evaluated.publishedAt
    };
  } catch (e) {
    // Offline / rate-limited / API drift. Keep the last known good answer so a
    // transient failure neither blanks the UI nor makes an existing "update
    // available" indicator flip back to "up to date".
    console.warn('[MOOC Reminder] Update check failed:', e.message);
    error = String(e && e.message ? e.message : e);
    result = {
      currentVersion,
      latestVersion: previous.latestVersion || '',
      updateAvailable: !!(previous.latestVersion && previous.updateAvailable),
      downloadUrl: previous.downloadUrl || '',
      releaseUrl: previous.releaseUrl || '',
      notes: previous.notes || '',
      publishedAt: previous.publishedAt || ''
    };
  }

  const next = {
    ...result,
    checkedAt: new Date().toISOString(),
    error,
    // Persisted so the 12h tick does not re-announce the same version.
    notifiedVersion: previous.notifiedVersion || null
  };

  if (!error && next.updateAvailable && next.latestVersion &&
      next.latestVersion !== next.notifiedVersion) {
    if (await notifyUpdateAvailable(next)) next.notifiedVersion = next.latestVersion;
  }

  await chrome.storage.local.set({ [KEYS.UPDATE_STATUS]: next });
  return next;
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
      // 更新检查搭 12h 周期的便车，不额外增加 SW 唤醒（见 CLAUDE.md 调度策略）
      await checkForUpdates();
      break;    case 'daily-digest':
      await sendDailyDigestNotification();
      break;
    case 'daily-digest-retry':
      // 免打扰时段结束时的一次性补发（sendDailyDigestNotification 内部
      // 自查当天是否已发，无需重复判断）
      await sendDailyDigestNotification();
      break;
    case TEMPORARY_PROXY_TIMEOUT_ALARM:
      await expireTemporaryProxyJob();
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

// `courseId` is part of the hash input: two courses can share a display name,
// and without it the same title+deadline in both would collide on one UID, so
// MARK_COMPLETED / SNOOZE / notification clicks could only ever address one of
// them. `identityKey` (built at the call site) already treats courseId as part
// of the identity, so this keeps the two consistent.
function makeManualHomeworkUid(title, deadline, courseName, courseId) {
  const text = [title || '', deadline || '', courseName || '', courseId || ''].join('|');
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return 'manual_tidmanual_ch_le_hw' + (hash >>> 0).toString(16).padStart(8, '0');
}

const MESSAGE_HANDLERS = {
  // Content script proxies API results (page-context same-origin fetch)
  async COURSE_API_DATA(msg) {
    if (!msg.course || !msg.rawData) return { success: false, error: 'Invalid payload' };
    try {
      const course = await resolveCourseForExtraction(msg.course);
      const items = apiExtractHomework(msg.rawData, course);
      if (items.length === 0) {
        // A successful API response can legitimately contain no assessable items.
        // It still proves the batch completed and must advance the sync timestamp.
        await chrome.storage.local.set({ [KEYS.LAST_SYNC]: new Date().toISOString() });
        console.log('[MOOC Reminder] COURSE_API_DATA: 0 items extracted for', course.courseId, '(courseName:', course.courseName || '?', 'rawData len:', (msg.rawData||'').length, ')');
        return { success: true, itemCount: 0 };
      }
      const result = await reconcileHomeworkData(course, items);
      await updateBadgeFromStorage();
      await chrome.storage.local.set({ [KEYS.LAST_SYNC]: new Date().toISOString() });
      console.log(`[MOOC Reminder] Course API data: ${items.length} items from ${course.courseId} (${course.courseName || ''})`);
      return { success: true, added: result.added, updated: result.updated, itemCount: items.length };
    } catch (e) {
      console.warn('[MOOC Reminder] COURSE_API_DATA error:', e.message, 'courseId:', msg.course?.courseId);
      return { success: false, error: e.message };
    }
  },

  // Popup marks an item as completed
  async MARK_COMPLETED(msg) {
    if (!msg.homeworkUid || typeof msg.checkedOff !== 'boolean') {
      return { success: false, error: 'Invalid payload' };
    }

    let found = false;
    await mutateHomeworkItems(items => {
      const item = items.find(i => i && i.uid === msg.homeworkUid);
      if (!item) return;
      found = true;
      item.checkedOff = msg.checkedOff;
      item.manuallyCheckedOff = msg.checkedOff;
      item.lastUpdated = new Date().toISOString();
      item.completionReason = msg.checkedOff ? 'manual' : null;

      // If un-checking, also reset auto-detection so it can re-detect
      if (!msg.checkedOff) {
        item.autoDetectedCompleted = false;
      }
    });
    await updateBadgeFromStorage();
    if (found) return { success: true };
    return { success: false, error: 'Item not found' };
  },

  // Content script (main.js) persists SPOC real termId so background refreshes
  // work without re-opening the SPOC course page.
  async COURSE_UPDATE(msg) {
    if (!msg.courseId || !msg.activeTermId) return { success: false, error: 'Invalid payload' };
    const patch = {
      courseId: msg.courseId,
      activeTermId: msg.activeTermId,
      courseName: msg.courseName || '',
      courseType: msg.courseType || 'spoc'
    };
    // Persist the route URL the user's browser actually loaded. It is the only
    // thing that pairs the correct /spoc/learn/ prefix with the route shell
    // `tid`, and it is frozen here so later weak /learn/ discovery harvests of
    // the same courseId cannot rewrite it. API items inherit it via
    // `pageUrl: course.pageUrl`, which resolveItemUrl() already prefers over any
    // courseType guess.
    if (isIcCourseLearnUrl(msg.routeUrl)) patch.pageUrl = msg.routeUrl;
    await upsertCourse(patch);
    console.log('[MOOC Reminder] COURSE_UPDATE:', msg.courseId, 'activeTermId=', msg.activeTermId, 'name=', msg.courseName);
    return { success: true };
  },

  // Content script (course-discovery) reports harvested course links.
  async COURSE_LINKS(msg) {
    if (!Array.isArray(msg.courses)) return { success: false, error: 'Invalid payload' };
    const existing = await getCourses();
    const known = new Set(existing.map(c => c && c.courseId));
    let registered = 0;
    let newCourses = 0;
    let spocCount = 0;
    for (const c of msg.courses) {
      if (!c || !c.courseId || !c.termId) continue;
      if (c.courseType === 'spoc') spocCount++;
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
    console.log('[MOOC Reminder] COURSE_LINKS: registered', registered, 'courses, new:', newCourses, 'SPOC:', spocCount);
    // Only kick a (heavy) background refresh when a genuinely new course appeared.
    // During a scrape the SW is already fetching everything through the content
    // script (and it now asks every open page to report on every pass), so the
    // SW-side refresh would only duplicate the same API calls.
    if (newCourses > 0 && !periodicScrapeInFlight) {
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
    const apiStatus = await getApiStatus();

    return {
      items: items.filter(i => i && !i.checkedOff),  // unfinished only
      allItems: items,                                 // including completed
      courses,
      lastSync,
      settings,
      syncErrors,
      apiStatus
    };
  },

  // Popup requests immediate scrape
  async TRIGGER_SCRAPE() {
    return await triggerManualScrape();
  },

  // Content script (main.js) signals a learn/spoc page just loaded — the user
  // is actively on MOOC, so all known courses can refresh right now (throttled).
  async PAGE_OPENED(msg, sender) {
    const temporaryProxy = await handleTemporaryProxyPageOpened(sender && sender.tab && sender.tab.id);
    if (temporaryProxy.handled) {
      return { success: true, refreshTriggered: temporaryProxy.refreshTriggered, temporaryProxy: true };
    }
    const kicked = await maybeTriggerEventRefresh('page-open');
    return { success: true, refreshTriggered: kicked };
  },

  // Sent after main.js has delivered every COURSE_API_DATA message. This lets a
  // revived MV3 worker finish an in-progress temporary job after its in-memory
  // await chain was discarded.
  async TEMPORARY_PROXY_BATCH_COMPLETE(msg, sender) {
    return await handleTemporaryProxyBatchComplete(msg, sender && sender.tab && sender.tab.id);
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
    const manualUid = makeManualHomeworkUid(title, deadline.toISOString(), courseName, courseId);
    const item = {
      uid: manualUid,
      identityKey: ['manual', courseId, title, deadline.toISOString()].join('|'),
      courseId,
      termId: 'manual',
      chapterId: '',
      lessonId: '',
      homeworkId: manualUid.replace(/^manual_tidmanual_ch_le_hw/, ''),
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
    await mutateHomeworkItems(items => {
      items.push(item);
    });
    await upsertCourse({ courseId, termId: 'manual', courseName, schoolName: item.schoolName, courseType: 'manual' });    await updateBadgeFromStorage();
    return { success: true, item };
  },

  // Popup snoozes notification for one item (badge count is unchanged)
  async SNOOZE_ITEM(msg) {
    if (!msg.homeworkUid) return { success: false, error: 'Invalid payload' };
    const hours = clampInt(msg.hours, 1, 168, 24);
    const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    let found = false;
    await mutateHomeworkItems(items => {
      const item = items.find(i => i && i.uid === msg.homeworkUid);
      if (!item) return;
      found = true;
      item.snoozedUntil = until;
      item.lastUpdated = new Date().toISOString();
      // 必须同时清掉已通知档位：否则 snooze 到期后 level 与记忆值相同，
      // maybeNotifyDeadlines 会永远跳过同档位提醒（对已过期条目尤其致命）
      item.lastNotificationLevel = null;
      item.lastNotifiedAt = null;
    });
    if (!found) return { success: false, error: 'Item not found' };
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

  // Settings page: stop tracking a course. Unlike mute this also removes it from
  // the refresh batch, so an unwanted course costs no API calls. Stored in settings
  // (not on the Course record) so course-discovery re-registering the course cannot
  // silently un-ignore it.
  async TOGGLE_COURSE_IGNORE(msg) {
    const courseId = String(msg.courseId || '').trim();
    if (!courseId) return { success: false, error: 'Invalid payload' };
    const settings = normalizeSettings(await getUserSettings());
    const ignored = new Set(settings.ignoredCourseIds || []);
    if (msg.ignored === false) ignored.delete(courseId);
    else if (msg.ignored === true) ignored.add(courseId);
    else if (ignored.has(courseId)) ignored.delete(courseId); else ignored.add(courseId);
    settings.ignoredCourseIds = Array.from(ignored);
    await chrome.storage.local.set({ [KEYS.USER_SETTINGS]: settings });
    await updateBadgeFromStorage();
    return { success: true, ignored: settings.ignoredCourseIds.indexOf(courseId) >= 0, settings };
  },

  // Settings page: drop a course and everything recorded for it.
  async DELETE_COURSE(msg) {
    const courseId = String(msg.courseId || '').trim();
    if (!courseId) return { success: false, error: 'Invalid payload' };
    await mutateCourses(courses => courses.filter(c => !c || c.courseId !== courseId));
    await mutateHomeworkItems(items => items.filter(i => !i || i.courseId !== courseId));
    // Drop this course's cleared-completed tombstones too. They exist to stop cleared
    // items from being resurrected, but the items are gone now, and a stale tombstone
    // would keep hiding items if the course is ever added again.
    const tombstones = await getDismissedCompletedUids();
    const kept = new Set(Array.from(tombstones).filter(uid => !String(uid).startsWith(courseId + '_')));
    if (kept.size !== tombstones.size) await setDismissedCompletedUids(kept);
    await updateBadgeFromStorage();
    return { success: true, courseId };
  },

  // Settings page: the tracked-course list with per-course counts, plus which
  // courses the user has ignored.
  async GET_COURSE_LIST() {
    const courses = await getCourses();
    const items = await getHomeworkItems();
    const settings = normalizeSettings(await getUserSettings());
    const counts = new Map();
    for (const item of items) {
      if (!item || !item.courseId) continue;
      const entry = counts.get(item.courseId) || { total: 0, unfinished: 0 };
      entry.total++;
      if (!item.checkedOff) entry.unfinished++;
      counts.set(item.courseId, entry);
    }
    const list = courses
      .filter(c => c && c.courseId && c.courseType !== 'manual')
      .map(c => {
        const count = counts.get(c.courseId) || { total: 0, unfinished: 0 };
        return {
          courseId: c.courseId,
          courseName: c.courseName || '',
          schoolName: c.schoolName || '',
          courseType: isProvenSpocCourse(c) ? 'spoc' : (c.courseType || ''),
          termId: c.termId || '',
          activeTermId: c.activeTermId || '',
          itemCount: count.total,
          unfinishedCount: count.unfinished
        };
      });
    return { success: true, courses: list, ignoredCourseIds: settings.ignoredCourseIds || [] };
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

  // Popup clears completed items. Cleared UIDs are remembered as dismissed so
  // the next API sync (which still returns those completed items) does not
  // resurrect them — "clear completed" is otherwise not a persistent action.
  async CLEAR_COMPLETED() {
    let remaining = 0;
    const clearedUids = [];
    await mutateHomeworkItems(items => {
      for (const item of items) {
        if (item && item.checkedOff && item.uid) clearedUids.push(item.uid);
      }
      const active = items.filter(i => !i.checkedOff);
      remaining = active.length;
      return active;
    });
    if (clearedUids.length > 0) {
      const dismissed = await getDismissedCompletedUids();
      for (const uid of clearedUids) dismissed.add(uid);
      await setDismissedCompletedUids(dismissed);
    }
    await updateBadgeFromStorage();
    return { success: true, remaining };
  },

  // Popup clears all cached data
  async RESET_DATA() {
    const temporaryProxyJob = await getTemporaryProxyJob();
    if (temporaryProxyJob) {
      await finishTemporaryProxyJob(temporaryProxyJob, { success: false, error: 'Data reset' }, true);
    }
    await chrome.storage.local.set({
      [KEYS.HOMEWORK_ITEMS]: [],
      [KEYS.LAST_SYNC]: null,
      [KEYS.SYNC_ERRORS]: [],
      [KEYS.SCRAPE_STATUS]: null,
      [KEYS.TEMPORARY_PROXY_JOB]: null,
      [KEYS.DISMISSED_COMPLETED]: []
    });
    // Clear courses through the serialized store so an in-flight upsert cannot
    // re-add a course after the reset wrote an empty array.
    await mutateCourses(() => []);
    await updateBadgeFromStorage();
    console.log('[MOOC Reminder] All data reset');
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
    // Apply notification-related setting changes immediately instead of waiting
    // for the next badge-refresh alarm tick.
    await updateBadgeFromStorage();
    console.log('[MOOC Reminder] Settings updated');
    return { success: true, settings: saved };
  },

  // Diagnostic snapshot for the options page. Notification delivery beyond this
  // point is controlled by Chrome and Windows notification settings.
  async GET_NOTIFICATION_DIAGNOSTICS() {
    const settings = normalizeSettings(await getUserSettings());
    const now = new Date();
    const items = await getHomeworkItems();
    const unfinished = items.filter(item => item && !item.checkedOff && !isCourseMuted(item, settings));
    const dueNow = collectDueNotifications(unfinished, settings, now);
    const alarms = await Promise.all([
      chrome.alarms.get('badge-refresh'),
      chrome.alarms.get('periodic-scrape'),
      chrome.alarms.get('daily-digest'),
      chrome.alarms.get('daily-digest-retry')
    ]);
    let permissionLevel = 'unknown';
    try {
      if (chrome.notifications && chrome.notifications.getPermissionLevel) {
        permissionLevel = await chrome.notifications.getPermissionLevel();
      }
    } catch {
      permissionLevel = 'unknown';
    }
    return {
      success: true,
      now: now.toISOString(),
      permissionLevel,
      notificationsApiAvailable: !!(chrome.notifications && chrome.notifications.create),
      settings,
      unfinishedCount: unfinished.length,
      dueNowCount: dueNow.length,
      dueNow: dueNow.map(item => ({ uid: item.uid, level: item.level, message: item.message })),
      quietHoursActive: isWithinQuietHours(settings, now),
      alarms: {
        badgeRefresh: alarms[0] || null,
        periodicScrape: alarms[1] || null,
        dailyDigest: alarms[2] || null,
        dailyDigestRetry: alarms[3] || null
      }
    };
  },

  // Options page: cached update state (no network — renders instantly).
  async GET_UPDATE_STATUS() {
    return {
      success: true,
      status: await getUpdateStatus(),
      currentVersion: chrome.runtime.getManifest().version
    };
  },

  // Options page: explicit "check now" button. Bypasses the autoCheckUpdates
  // switch on purpose — that switch governs the background tick, not a click.
  async CHECK_UPDATES() {
    return { success: true, status: await checkForUpdates({ manual: true }) };
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
  const autoDetect = normalizeSettings(await getUserSettings()).autoDetectEnabled;
  let added = 0;
  let updated = 0;

  // Tombstones for items the user cleared from "已完成". Read once per merge;
  // a UID that comes back as unfinished (new attempt) is un-dismissed so it can
  // legitimately reappear.
  const dismissedCompleted = await getDismissedCompletedUids();
  let dismissedChanged = false;

  // Whole merge runs inside the items lock so a concurrent notification
  // write-back can't interleave between our read and write.
  await mutateHomeworkItems(async function(existingItems) {
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
          // The user cleared this completed item earlier: do not resurrect it on
          // the next sync. If it now reports as unfinished (e.g. a new attempt),
          // drop the tombstone and let it show again.
          if (dismissedCompleted.has(newItem.uid)) {
            if (newItem.checkedOff) {
              continue;
            }
            dismissedCompleted.delete(newItem.uid);
            dismissedChanged = true;
          }
          newItem.firstSeen = newItem.firstSeen || new Date().toISOString();
          newItem.lastUpdated = newItem.firstSeen;
          existingItems.push(newItem);
          added++;
      }
    }
  }

  // Update course metadata — 不覆写已有的课程名称（checkPageHookData 发来的可能为空）
  // 也不写 pageUrl/termId：
  //   - pageUrl 只由 COURSE_UPDATE（真实页面）冻结写入，API payload 的空值会把它抹掉；
  //   - Course.termId 全项目都当作「路由 termId」用（getProxyRouteTermId、
  //     buildTemporaryProxyUrl、点击跳转），而这里的 course.termId 是抓取用的
  //     termId —— SPOC 下等于 activeTermId（API id），写进去就把路由壳 id 毁掉了。
  // 这门课必然已在 courses 里（buildApiCourseList / apiRefreshAllKnownCourses 都
  // 从已存储课程派生），所以不同步这两个字段不会丢数据。
  if (course && course.courseId) {
    var courseMeta = {};
    for (var key in course) {
      if (Object.prototype.hasOwnProperty.call(course, key) &&
          key !== 'courseName' && key !== 'schoolName' && key !== 'pageUrl' && key !== 'termId') {
        courseMeta[key] = course[key];
      }
    }
    if (course.courseName) courseMeta.courseName = course.courseName;
    if (course.schoolName) courseMeta.schoolName = course.schoolName;
    await upsertCourse(courseMeta);
  }

  return existingItems;
  });

  if (dismissedChanged) await setDismissedCompletedUids(dismissedCompleted);

  // Save（mutateHomeworkItems 已写回 items；LAST_SYNC 单独记录）
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
    // Ignored courses are not tracked at all, so keep them out of the badge count —
    // and therefore out of deadline notifications as well.
    const ignoredIds = new Set(settings.ignoredCourseIds || []);
    const unfinished = items.filter(i =>
      !i.checkedOff && !mutedIds.has(i.courseId) && !ignoredIds.has(i.courseId));
    const count = unfinished.length;

    if (count === 0) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    await chrome.action.setBadgeText({ text: String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: getUrgencyColor(unfinished) });
    await maybeNotifyDeadlines(unfinished);
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

async function sendStartupDigestIfNeeded() {
  const settings = normalizeSettings(await getUserSettings());
  if (!settings.dailyDigestEnabled) return;
  const raw = await chrome.storage.local.get(KEYS.LAST_DIGEST_DATE);
  if (raw[KEYS.LAST_DIGEST_DATE] === localDateStr(new Date())) return;

  // 每天首次启动浏览器时直接尝试推送临期摘要，而不等待用户设置的定时
  // alarm。sendDailyDigestNotification 会继续处理通知总开关、免打扰、无
  // 临期项目和当天去重；免打扰时会安排结束后的补发。
  console.log('[MOOC Reminder] First browser start today, sending pending digest');
  await sendDailyDigestNotification();
}

async function sendDailyDigestNotification() {
  if (!chrome.notifications) return;
  const settings = normalizeSettings(await getUserSettings());
  if (!settings.dailyDigestEnabled || !settings.notificationsEnabled) return;

  // 当天已发过就直接返回（retry alarm / 补发 / 正常 alarm 共用本函数）
  const todayStr = localDateStr(new Date());
  const raw = await chrome.storage.local.get(KEYS.LAST_DIGEST_DATE);
  if (raw[KEYS.LAST_DIGEST_DATE] === todayStr) return;

  const now = new Date();
  if (isWithinQuietHours(settings, now)) {
    // 免打扰时段命中：daily-digest alarm 周期是 24h，直接 return 会丢掉
    // 当天摘要——改为在免打扰结束时安排一次性重试
    const retryAt = nextQuietEndWhen(settings, now);
    if (retryAt) {
      chrome.alarms.create('daily-digest-retry', { when: retryAt });
      console.log('[MOOC Reminder] Daily digest deferred to quiet-hours end');
    }
    return;
  }

  const items = (await getHomeworkItems()).filter(item => !isCourseMuted(item, settings) && !isSnoozed(item, now));
  const message = formatDigestMessage(items, now);
  if (!message) return;
  try {
    await chrome.notifications.create('mooc-reminder:daily-digest', {
      type: 'basic',
      iconUrl: getNotificationIconUrl(),
      title: '今日 MOOC 作业汇总',
      message,
      priority: 1
    });
    // 先发成功再记日期：create 失败时当天还有重试机会（补发/下一次触发）
    await chrome.storage.local.set({ [KEYS.LAST_DIGEST_DATE]: todayStr });
    await chrome.alarms.clear('daily-digest-retry');
  } catch (e) {
    console.warn('[MOOC Reminder] Daily digest notification failed:', e.message);
  }
}

function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 通知判重基于读取时的快照；两个 maybeNotifyDeadlines 并发在途（如
// badge-refresh tick 撞上 COURSE_API_DATA 触发的更新）会各自基于旧数据
// 决定弹通知而重复。在途时直接跳过，下一 tick 会补上。
let notifyInFlight = false;

async function maybeNotifyDeadlines(unfinishedItems) {
  if (!chrome.notifications || !Array.isArray(unfinishedItems)) return;
  if (notifyInFlight) return;
  notifyInFlight = true;
  try {
  const settings = normalizeSettings(await getUserSettings());
  if (!settings.notificationsEnabled) return;

  const now = new Date();
  // During quiet hours, hold off — the next badge-refresh tick outside the
  // window will deliver any still-pending reminders.
  if (isWithinQuietHours(settings, now)) return;

  // 纯判定逻辑（档位/去重/静音/snooze 过滤）在 shared/reminder.js，可单测
  const due = collectDueNotifications(unfinishedItems, settings, now);
  if (due.length === 0) return;

  const fired = [];
  for (const d of due) {
    try {
      await chrome.notifications.create(notificationIdFor(d.uid, d.level), {
        type: 'basic',
        iconUrl: getNotificationIconUrl(),
        title: d.title,
        message: d.message,
        priority: d.priority
      });
      fired.push(d);
    } catch (e) {
      console.warn('[MOOC Reminder] Notification failed:', e.message);
    }
  }
  if (fired.length === 0) return;

  // 在锁内基于最新数据按 uid 补丁通知字段——绝不整体写回进入函数时的
  // 陈旧快照，否则会覆盖并发的 reconcile 结果（完成状态被复活等）
  const nowIso = new Date().toISOString();
  await mutateHomeworkItems(items => {
    for (const d of fired) {
      const item = items.find(i => i && i.uid === d.uid);
      if (item) {
        item.lastNotificationLevel = d.level;
        item.lastNotifiedAt = nowIso;
      }
    }
  });
  } finally {
    notifyInFlight = false;
  }
}

chrome.notifications?.onClicked?.addListener(async (notificationId) => {
  if (!notificationId || notificationId.indexOf('mooc-reminder:') !== 0) return;

  // Update announcement: open the download page instead of a homework item.
  if (notificationId.indexOf(UPDATE_NOTIFICATION_PREFIX) === 0) {
    try {
      const status = await getUpdateStatus();
      const url = resolveDownloadTarget(status) || RELEASES_PAGE_URL;
      await chrome.tabs.create({ url });
      await chrome.notifications.clear(notificationId);
    } catch (e) {
      console.debug('[MOOC Reminder] Update notification click failed:', e.message);
    }
    return;
  }

  const parts = notificationId.split(':');
  const uid = parts.length >= 2 ? decodeURIComponent(parts[1]) : '';
  if (!uid) return;

  try {
    const items = await getHomeworkItems();
    const item = items.find(i => i && i.uid === uid);
    // API 抓取的条目常没有 pageUrl——与 popup 相同的兜底：按 courseId+termId
    // 重建课程学习页 URL，并按条目类型修正 hash 路由。课程类型决定是
    // /learn/ 还是 /spoc/learn/，所以显式传入 Course 元数据。
    let courseType = item && item.courseType;
    if (item) {
      const courses = await getCourses();
      const course = courses.find(c => c && c.courseId === item.courseId);
      if (course) {
        // activeTermId outranks courseType — see isProvenSpocCourse.
        courseType = isProvenSpocCourse(course) ? 'spoc' : (course.courseType || courseType);
      }
    }
    const url = item ? resolveItemUrl(item, courseType) : null;
    if (url) {
      await chrome.tabs.create({ url });
    }
    await chrome.notifications.clear(notificationId);
  } catch (e) {
    console.debug('[MOOC Reminder] Notification click failed:', e.message);
  }
});
// 事件驱动全量刷新的最小间隔：打开课程页/浏览器启动都触发，但 30 分钟内
// 不重复全量抓取（每次全量 = 课程数 × ~200KB API 响应）
const EVENT_REFRESH_MIN_GAP_MS = 30 * 60 * 1000;

async function maybeTriggerEventRefresh(reason) {
  try {
    const last = await getLastSync();
    const lastMs = last ? new Date(last).getTime() : 0;
    if (lastMs && Date.now() - lastMs < EVENT_REFRESH_MIN_GAP_MS) {
      console.log('[MOOC Reminder] Event refresh (' + reason + ') skipped: synced ' + Math.round((Date.now() - lastMs) / 60000) + ' min ago');
      return false;
    }
    console.log('[MOOC Reminder] Event refresh triggered by', reason);
    performPeriodicScrape().catch(function() {});
    return true;
  } catch (e) {
    console.debug('[MOOC Reminder] Event refresh check failed:', e.message);
    return false;
  }
}

// A batch is deliberately sent to one proxy tab only. Every matching tab would
// otherwise fetch the full course list and multiply network traffic.
const TEMPORARY_PROXY_TIMEOUT_ALARM = 'temporary-proxy-timeout';
const TEMPORARY_PROXY_TIMEOUT_MS = 90 * 1000;
let periodicScrapeInFlight = null;
let activeTemporaryProxyJob = null;
let temporaryProxyWaiter = null;
let temporaryProxyDispatchingJobId = null;
const temporaryProxyFinalizingJobIds = new Set();

// chrome.tabs.sendMessage rejects like this when the target tab has no listener —
// typically a learn page that was already open when the extension was reloaded,
// because reloading never injects content scripts into existing tabs.
function isContentScriptMissingError(error) {
  const message = String((error && error.message) || error || '');
  return /Receiving end does not exist|Could not establish connection/i.test(message);
}

// A SPOC course can be split across TWO terms, and the page renders both side by
// side:
//   - the ROUTE term — the `?tid=` the user actually opens. Carries the teacher's
//     own additions (verified 2026-09 on 模拟电子技术基础: term 1488279445 held
//     only the 线上学习任务 / 翻转课堂 chapters).
//   - the ACTIVE/source term — `window.moocTermDto.id`, the source MOOC course the
//     SPOC was cloned from (same course: term 1488001444 held the 10 source
//     chapters).
// They are disjoint, and `isSameHomeworkCandidate` refuses to merge across
// termIds, so fetching only one silently loses half the course — which is exactly
// how the teacher's 线上学习任务 group went missing. Emit one entry per term.
function buildApiCourseList(courses, ignoredCourseIds) {
  const ignored = ignoredCourseIds instanceof Set ? ignoredCourseIds : new Set(ignoredCourseIds || []);
  const out = [];
  for (const course of (Array.isArray(courses) ? courses : [])) {
    if (!course || course.courseType === 'manual' || !course.courseId) continue;
    // 被用户忽略的课程不参与任何抓取（设置页「已追踪课程」）
    if (ignored.has(course.courseId)) continue;
    // activeTermId is written ONLY by COURSE_UPDATE, which main.js sends ONLY
    // from a genuine SPOC page. So its presence proves SPOC regardless of what
    // courseType says — a /learn/ discovery harvest of the same courseId may have
    // demoted courseType to 'mooc'. Deriving the effective type here keeps SPOC
    // items correctly labelled all the way to the popup click target.
    const provenSpoc = isProvenSpocCourse(course);
    const courseType = provenSpoc ? 'spoc' : (course.courseType || '');

    const terms = [];
    const active = String(course.activeTermId || course.termId || '');
    if (active) terms.push(active);
    if (provenSpoc) {
      // 路由 term：老师自己加的内容在这里。非 SPOC 不扩展 —— MOOC 的 active 与路由
      // 本来就是同一个 id，扩展了也只会重复。
      // pageUrl 是 COURSE_UPDATE 冻结的「用户真实打开过的 URL」，它的 ?tid= 比
      // course.termId 更可靠：旧版本曾把 termId 覆盖成 API id（不变量 10），
      // 那些历史记录要靠这里救回来。
      const routeCandidates = [String(course.termId || '')];
      const fromPage = /[?&]tid=(\d+)/.exec(String(course.pageUrl || ''));
      if (fromPage) routeCandidates.push(fromPage[1]);
      for (const route of routeCandidates) {
        if (route && route !== 'manual' && !terms.includes(route)) terms.push(route);
      }
    }
    if (terms.length === 0) continue;

    for (const termId of terms) {
      out.push({
        courseId: course.courseId,
        termId,
        courseName: course.courseName || '',
        schoolName: course.schoolName || '',
        courseType
      });
    }
  }
  return out;
}

function getProxyRouteTermId(course) {
  if (!course) return '';
  if (course.termId && course.termId !== 'manual') return String(course.termId);
  // A SPOC activeTermId is an API ID and can differ from the route shell ID, so
  // it must never be used as the route `tid`. See isProvenSpocCourse.
  return isProvenSpocCourse(course) ? '' : String(course.activeTermId || '');
}

// A usable icourse163 learn route: right origin, /learn/ or /spoc/learn/ path, and
// a `tid`. Anything else (homepage links, user-typed junk) must never be stored as
// a course route, because it would be handed straight to chrome.tabs.create.
function isIcCourseLearnUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.origin === ICOURSE_ORIGIN &&
      /\/(?:spoc\/)?learn\//.test(url.pathname) &&
      !!url.searchParams.get('tid');
  } catch {
    return false;
  }
}

function buildTemporaryProxyUrl(course) {
  const routeTermId = getProxyRouteTermId(course);
  if (!course || !course.courseId || !routeTermId) return null;

  const storedUrl = course.pageUrl || course.courseUrl || '';
  if (isIcCourseLearnUrl(storedUrl)) {
    const url = new URL(storedUrl);
    url.hash = '/learn/testlist';
    return url.toString();
  }

  const path = course.courseType === 'spoc' ? '/spoc/learn/' : '/learn/';
  return 'https://www.icourse163.org' + path + encodeURIComponent(course.courseId) +
    '?tid=' + encodeURIComponent(routeTermId) + '#/learn/testlist';
}

function pickTemporaryProxyCourse(courses, ignoredCourseIds) {
  const ignored = ignoredCourseIds instanceof Set ? ignoredCourseIds : new Set(ignoredCourseIds || []);
  return (Array.isArray(courses) ? courses : [])
    .filter(course => course && course.courseType !== 'manual' && !ignored.has(course.courseId) && buildTemporaryProxyUrl(course))
    .sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0))[0] || null;
}

function isTemporaryProxyJob(value) {
  return !!(value && value.kind === 'temporary-proxy' && value.temporary === true && value.id && Number.isInteger(value.tabId));
}

function serializeTemporaryProxyJob(job) {
  return {
    kind: 'temporary-proxy',
    id: job.id,
    tabId: job.tabId,
    temporary: true,
    phase: job.phase,
    source: job.source,
    courseId: job.courseId,
    proxyUrl: job.proxyUrl,
    createdAt: job.createdAt,
    deadlineAt: job.deadlineAt,
    expectedCourseIds: job.expectedCourseIds
  };
}

async function getTemporaryProxyJob() {
  if (isTemporaryProxyJob(activeTemporaryProxyJob)) return activeTemporaryProxyJob;
  const raw = await chrome.storage.local.get(KEYS.TEMPORARY_PROXY_JOB);
  return isTemporaryProxyJob(raw[KEYS.TEMPORARY_PROXY_JOB]) ? raw[KEYS.TEMPORARY_PROXY_JOB] : null;
}

async function setTemporaryProxyJobPhase(job, phase) {
  job.phase = phase;
  await chrome.storage.local.set({ [KEYS.TEMPORARY_PROXY_JOB]: serializeTemporaryProxyJob(job) });
}

async function clearTemporaryProxyJob(job) {
  const raw = await chrome.storage.local.get(KEYS.TEMPORARY_PROXY_JOB);
  const stored = raw[KEYS.TEMPORARY_PROXY_JOB];
  if (isTemporaryProxyJob(stored) && stored.id === job.id) {
    await chrome.storage.local.set({ [KEYS.TEMPORARY_PROXY_JOB]: null });
  }
  if (activeTemporaryProxyJob && activeTemporaryProxyJob.id === job.id) {
    activeTemporaryProxyJob = null;
  }
}

function createTemporaryProxyWaiter(job) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  temporaryProxyWaiter = { jobId: job.id, promise, resolve };
  return promise;
}

function settleTemporaryProxyWaiter(job, outcome) {
  if (temporaryProxyWaiter && temporaryProxyWaiter.jobId === job.id) {
    temporaryProxyWaiter.resolve(outcome);
    temporaryProxyWaiter = null;
  }
}

async function finishTemporaryProxyJob(job, outcome, removeTab) {
  if (!job || temporaryProxyFinalizingJobIds.has(job.id)) return false;
  temporaryProxyFinalizingJobIds.add(job.id);
  let finalized = false;
  try {
    // Never clear an unrelated or already-completed job. This also makes a
    // timeout racing a late batch response resolve to one authoritative result.
    const raw = await chrome.storage.local.get(KEYS.TEMPORARY_PROXY_JOB);
    const stored = raw[KEYS.TEMPORARY_PROXY_JOB];
    if (!isTemporaryProxyJob(stored) || stored.id !== job.id) return false;

    await chrome.alarms.clear(TEMPORARY_PROXY_TIMEOUT_ALARM);
    if (removeTab && Number.isInteger(job.tabId)) {
      try {
        await chrome.tabs.remove(job.tabId);
      } catch (e) {
        console.debug('[MOOC Reminder] Temporary proxy tab was already closed:', e.message);
      }
    }
    await clearTemporaryProxyJob(job);
    finalized = true;
    return true;
  } finally {
    temporaryProxyFinalizingJobIds.delete(job.id);
    if (finalized) settleTemporaryProxyWaiter(job, outcome);
  }
}

async function recoverTemporaryProxyJob() {
  const raw = await chrome.storage.local.get(KEYS.TEMPORARY_PROXY_JOB);
  const job = raw[KEYS.TEMPORARY_PROXY_JOB];
  if (!isTemporaryProxyJob(job)) return;
  console.warn('[MOOC Reminder] Cleaning up an interrupted temporary proxy job:', job.id);
  await finishTemporaryProxyJob(job, { success: false, error: 'Temporary proxy interrupted by extension restart' }, true);
}

async function expireTemporaryProxyJob() {
  const job = await getTemporaryProxyJob();
  if (!job) return;
  const error = 'Temporary MOOC proxy timed out before the batch completed';
  const finalized = await finishTemporaryProxyJob(job, { success: false, error, temporaryProxy: true }, true);
  if (finalized) {
    console.warn('[MOOC Reminder]', error, job.id);
    await addSyncError(error);
  }
}

chrome.tabs.onRemoved.addListener(tabId => {
  handleTemporaryProxyTabRemoved(tabId).catch(error => {
    console.debug('[MOOC Reminder] Temporary proxy tab removal cleanup failed:', error.message);
  });
});

async function handleTemporaryProxyTabRemoved(tabId) {
  const job = await getTemporaryProxyJob();
  if (!job || job.tabId !== tabId || temporaryProxyFinalizingJobIds.has(job.id)) return;
  await finishTemporaryProxyJob(job, {
    success: false,
    error: 'Temporary MOOC proxy tab was closed before the batch completed',
    temporaryProxy: true
  }, false);
}

function withTimeout(promise, timeoutMs, errorMessage) {
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function createTemporaryProxyJob(courses, source) {
  const existing = await getTemporaryProxyJob();
  if (existing) {
    if (temporaryProxyWaiter && temporaryProxyWaiter.jobId === existing.id) {
      return temporaryProxyWaiter.promise;
    }
    return { success: false, pending: true, error: 'Temporary MOOC proxy is already running', temporaryProxy: true };
  }

  const ignoredCourseIds = normalizeSettings(await getUserSettings()).ignoredCourseIds || [];
  const proxyCourse = pickTemporaryProxyCourse(courses, ignoredCourseIds);
  const proxyUrl = buildTemporaryProxyUrl(proxyCourse);
  if (!proxyCourse || !proxyUrl) {
    return { success: false, error: '没有可用于后台刷新的已载入 MOOC 课程', temporaryProxy: false };
  }

  let job = null;
  try {
    // about:blank cannot run our content script, so it gives the worker a safe
    // point to persist ownership before navigating to a fast-loading MOOC page.
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    if (!tab || !Number.isInteger(tab.id)) throw new Error('Unable to create temporary MOOC proxy tab');

    const createdAt = Date.now();
    job = {
      kind: 'temporary-proxy',
      id: 'temporary-proxy-' + createdAt + '-' + Math.random().toString(36).slice(2, 8),
      tabId: tab.id,
      temporary: true,
      phase: 'waiting_ready',
      source: source || 'periodic',
      courseId: proxyCourse.courseId,
      proxyUrl,
      createdAt,
      deadlineAt: createdAt + TEMPORARY_PROXY_TIMEOUT_MS,
      // A SPOC course now contributes one batch entry per term, so dedupe: this is
      // a set of course ids to wait for, not a per-request count.
      expectedCourseIds: [...new Set(buildApiCourseList(courses, ignoredCourseIds).map(course => course.courseId))]
    };
    activeTemporaryProxyJob = job;
    const completion = createTemporaryProxyWaiter(job);

    // Store ownership before the page can report PAGE_OPENED. The timeout alarm
    // survives a service-worker restart and prevents a background tab leak.
    job.readyPromise = (async function() {
      await chrome.storage.local.set({ [KEYS.TEMPORARY_PROXY_JOB]: serializeTemporaryProxyJob(job) });
      await chrome.alarms.create(TEMPORARY_PROXY_TIMEOUT_ALARM, { when: job.deadlineAt });
    })();
    await job.readyPromise;
    await chrome.tabs.update(job.tabId, { url: proxyUrl });
    console.log('[MOOC Reminder] Created temporary proxy tab', job.tabId, 'for', job.courseId);

    return await completion;
  } catch (e) {
    const outcome = { success: false, error: e.message, temporaryProxy: true };
    if (job) {
      await finishTemporaryProxyJob(job, outcome, true);
    }
    return outcome;
  }
}

async function handleTemporaryProxyPageOpened(tabId) {
  if (!Number.isInteger(tabId)) return { handled: false, refreshTriggered: false };
  const job = await getTemporaryProxyJob();
  if (!job || job.tabId !== tabId) return { handled: false, refreshTriggered: false };
  if (job.phase === 'fetching' || temporaryProxyDispatchingJobId === job.id) {
    return { handled: true, refreshTriggered: false };
  }
  if (job.phase !== 'waiting_ready') return { handled: true, refreshTriggered: false };
  if (job.readyPromise) await job.readyPromise;

  await runTemporaryProxyBatch(job);
  return { handled: true, refreshTriggered: true };
}

async function handleTemporaryProxyBatchComplete(msg, tabId) {
  if (!msg || !msg.proxyJobId || !Number.isInteger(tabId)) {
    return { success: false, error: 'Invalid temporary proxy completion payload' };
  }
  const job = await getTemporaryProxyJob();
  if (!job || job.id !== msg.proxyJobId || job.tabId !== tabId || job.phase !== 'fetching') {
    return { success: false, ignored: true };
  }

  const fetchedCourseCount = Number.isInteger(msg.resultCount) ? msg.resultCount : 0;
  const outcome = fetchedCourseCount > 0
    ? { success: true, temporaryProxy: true, fetchedCourseCount, tabsScanned: 1 }
    : { success: false, error: 'Temporary MOOC proxy returned no course data', temporaryProxy: true, tabsScanned: 1 };
  if (outcome.success) await updateBadgeFromStorage();
  const finalized = await finishTemporaryProxyJob(job, outcome, true);
  if (finalized && !outcome.success) await addSyncError('Temporary proxy batch: ' + outcome.error);
  return { success: finalized && outcome.success, ignored: !finalized, error: outcome.error };
}

async function runTemporaryProxyBatch(job) {
  if (temporaryProxyDispatchingJobId === job.id) return;
  temporaryProxyDispatchingJobId = job.id;
  let outcome;
  try {
    await setTemporaryProxyJobPhase(job, 'fetching');
    const ignoredCourseIds = normalizeSettings(await getUserSettings()).ignoredCourseIds || [];
    const apiCourses = buildApiCourseList(await getCourses(), ignoredCourseIds);
    if (apiCourses.length === 0) throw new Error('没有可抓取的已载入课程');

    const remainingMs = Math.max(1, job.deadlineAt - Date.now());
    const results = await withTimeout(
      chrome.tabs.sendMessage(job.tabId, {
        type: 'BATCH_API_FETCH',
        courses: apiCourses,
        proxyJobId: job.id
      }),
      remainingMs,
      'Temporary MOOC proxy job timed out'
    );
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error('Temporary MOOC proxy returned no course data');
    }
    await updateBadgeFromStorage();
    outcome = {
      success: true,
      temporaryProxy: true,
      fetchedCourseCount: Array.isArray(results) ? results.length : 0,
      tabsScanned: 1
    };
  } catch (e) {
    console.warn('[MOOC Reminder] Temporary proxy batch failed:', e.message);
    const stillOwned = await getTemporaryProxyJob();
    if (stillOwned && stillOwned.id === job.id) {
      await addSyncError('Temporary proxy batch: ' + e.message);
    }
    outcome = { success: false, error: e.message, temporaryProxy: true, tabsScanned: 1 };
  } finally {
    temporaryProxyDispatchingJobId = null;
    await finishTemporaryProxyJob(job, outcome || { success: false, error: 'Temporary proxy batch did not finish', temporaryProxy: true }, true);
  }
  return outcome;
}

const LEARN_TAB_URLS = [
  'https://www.icourse163.org/learn/*',
  'https://www.icourse163.org/spoc/learn/*'
];

// Every icourse163 page may know about courses (`course-discovery.js` runs on all
// of them), so every scrape asks the whole site — not only the learn tabs: the
// 「我的课程」page is the richest source of course links, and a learn tab answers
// for itself (main.js). The answers also tell the SW which pages are still alive.
const ICOURSE_TAB_URLS = ['https://www.icourse163.org/*'];

// A page that cannot answer must never be trusted with anything. Two ways to get
// no answer: the content script is missing (page predates the last extension
// reload, or the browser discarded the tab — rejects immediately) or the renderer
// is frozen/unresponsive as a long-hidden background tab (the promise never
// settles). Both are normal in a browser that has been open for a while, so every
// ask is bounded and the answer decides what that page is used for.
const PAGE_ANSWER_TIMEOUT_MS = 1500;

// main.js answers REQUEST_COURSE_LINKS only after its own COURSE_LINKS /
// COURSE_UPDATE were handled, but course-discovery's anchor harvest is
// fire-and-forget: give those messages a moment to land before reading `courses`.
const COURSE_REPORT_SETTLE_MS = 800;

/**
 * Ask every open icourse163 page to re-report the courses it knows, and return the
 * ids of the pages that answered.
 *
 * One cheap round trip does two jobs:
 *  - **registration**: `course-discovery` reports each course once per page load and
 *    `main.js` registers its own course only while loading, so a course whose page
 *    has been sitting in the background since before 清除数据 (or whose page load
 *    never captured the API hook) would otherwise never be known again. Asking on
 *    every scrape makes the course list self-healing instead of only recoverable
 *    when it is empty.
 *  - **liveness**: only a page that answers may be chosen to serve the heavy
 *    BATCH_API_FETCH. A frozen/unloaded page never answers, and sending it the batch
 *    used to abort the whole pass after a 90-second timeout even though another tab
 *    — or the temporary proxy — could have served it.
 */
async function askOpenPagesToReport(tabs) {
  const candidates = (Array.isArray(tabs) ? tabs : []).filter(tab => tab && Number.isInteger(tab.id));
  const responders = new Set();
  if (candidates.length === 0) return responders;

  // Ask every page at once: sequentially awaiting a frozen page would add its whole
  // timeout to the pass, and one silent page must not delay the others.
  await Promise.all(candidates.map(async tab => {
    try {
      await withTimeout(
        chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_COURSE_LINKS' }),
        PAGE_ANSWER_TIMEOUT_MS,
        'no answer within ' + PAGE_ANSWER_TIMEOUT_MS + 'ms'
      );
      responders.add(tab.id);
    } catch (e) {
      console.warn('[MOOC Reminder] Page', tab.id, 'did not answer (' + (e && e.message) +
        ') — it cannot report courses or serve the batch');
    }
  }));

  console.log('[MOOC Reminder] Open icourse163 pages:', candidates.length, '— answered:', responders.size);
  if (responders.size > 0) {
    await new Promise(resolve => setTimeout(resolve, COURSE_REPORT_SETTLE_MS));
  }
  return responders;
}

async function performPeriodicScrape(source) {
  if (periodicScrapeInFlight) return periodicScrapeInFlight;

  const run = (async function() {
    console.log('[MOOC Reminder] Periodic scrape started');
    try {
      // Ask first, then read: the answers may register courses this very pass needs.
      const openTabs = await chrome.tabs.query({ url: ICOURSE_TAB_URLS });
      const responders = await askOpenPagesToReport(openTabs);

      let courses = await getCourses();
      const ignoredCourseIds = normalizeSettings(await getUserSettings()).ignoredCourseIds || [];
      let apiCourses = buildApiCourseList(courses, ignoredCourseIds);

      if (apiCourses.length === 0) {
        // This used to return in TOTAL silence, which made 「popup 一点都抓不到」
        // almost undiagnosable: the empty popup blamed the login and neither the
        // console nor 错误报告 said anything. Say which of the two reasons it is,
        // and record it so the popup/设置页 can show it too.
        const trackable = courses.filter(c => c && c.courseType !== 'manual' && c.courseId);
        const reason = courses.length === 0
          ? '还没有任何已载入的课程：请先打开一次 icourse163 课程页面（刚重新加载过扩展的话，还需要刷新已打开的页面）'
          : trackable.length === 0
            ? '没有可抓取的已载入课程（已知的只有手动提醒条目）'
            : '所有课程都被跳过（共 ' + courses.length + ' 门；已忽略 ' + ignoredCourseIds.length + ' 门）';
        console.warn('[MOOC Reminder] Periodic scrape skipped:', reason);
        await addSyncError('抓取跳过：' + reason);
        return { success: false, error: reason, tabsScanned: 0 };
      }

      // Only pages that just proved they can answer are candidates. This is what
      // makes a refresh independent of which course tabs the browser froze or
      // unloaded while the user was looking elsewhere.
      const learnTabs = await chrome.tabs.query({ url: LEARN_TAB_URLS });
      const candidates = (Array.isArray(learnTabs) ? learnTabs : [])
        .filter(tab => tab && responders.has(tab.id))
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));

      if (candidates.length === 0) {
        console.log('[MOOC Reminder] No responsive learn tab, creating a temporary proxy tab');
        return await createTemporaryProxyJob(courses, source || 'periodic');
      }

      // Try the most recently used responsive learn tab first, then the others. A
      // learn tab that was already open when the extension was reloaded has NO
      // content script, and chrome.tabs.sendMessage then rejects with "Receiving
      // end does not exist" — that used to abort the entire scrape even though
      // other tabs could have served it. Only that definitive "nobody is
      // listening" failure moves on to the next candidate (it can still happen if
      // the page navigated right after answering); a real timeout on a page that
      // just answered fails loudly, because the data would be lost silently.
      for (const tab of candidates) {
        console.log('[MOOC Reminder] Sending BATCH_API_FETCH:', apiCourses.length, 'courses to tab', tab.id);
        try {
          const results = await withTimeout(
            chrome.tabs.sendMessage(tab.id, { type: 'BATCH_API_FETCH', courses: apiCourses }),
            TEMPORARY_PROXY_TIMEOUT_MS,
            'MOOC proxy batch timed out'
          );
          if (!Array.isArray(results) || results.length === 0) {
            throw new Error('MOOC proxy returned no course data');
          }
          await updateBadgeFromStorage();
          console.log('[MOOC Reminder] Periodic scrape complete');
          return {
            success: true,
            temporaryProxy: false,
            fetchedCourseCount: results.length,
            tabsScanned: 1,
            tabId: tab.id
          };
        } catch (e) {
          if (!isContentScriptMissingError(e)) throw e;
          console.warn('[MOOC Reminder] Tab', tab.id, 'has no content script (page predates the last extension reload)');
        }
      }

      // Every candidate turned out to be stale (they answered, then navigated).
      // The temporary proxy is created fresh, so it always gets the content
      // script — use it rather than failing the scrape.
      console.warn('[MOOC Reminder] No learn tab could serve the batch, falling back to a temporary proxy tab');
      return await createTemporaryProxyJob(courses, source || 'periodic');
    } catch (e) {
      console.error('[MOOC Reminder] Periodic scrape failed:', e);
      await addSyncError('Periodic scrape: ' + e.message);
      return { success: false, error: e.message, tabsScanned: 0 };
    }
  })();

  periodicScrapeInFlight = run;
  try {
    return await run;
  } finally {
    if (periodicScrapeInFlight === run) periodicScrapeInFlight = null;
  }
}

async function triggerManualScrape() {
  console.log('[MOOC Reminder] Manual scrape triggered');
  const outcome = await performPeriodicScrape('manual');
  const allItems = await getHomeworkItems();
  return {
    success: outcome.success === true,
    error: outcome.error || null,
    scrapedCount: allItems.length,
    tabsScanned: outcome.tabsScanned || 0,
    temporaryProxy: outcome.temporaryProxy === true,
    errors: outcome.success === true ? 0 : 1
  };
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

async function setCourses(courses) {
  const clean = Array.isArray(courses) ? courses.filter(Boolean) : [];
  await chrome.storage.local.set({ [KEYS.COURSES]: clean });
}

// UIDs the user removed via "清理已完成". Kept as a tombstone list so a later
// API sync does not re-create them as brand-new completed items.
async function getDismissedCompletedUids() {
  const result = await chrome.storage.local.get(KEYS.DISMISSED_COMPLETED);
  const raw = result[KEYS.DISMISSED_COMPLETED];
  return new Set(Array.isArray(raw) ? raw.filter(Boolean) : []);
}

async function setDismissedCompletedUids(uids) {
  await chrome.storage.local.set({
    [KEYS.DISMISSED_COMPLETED]: Array.from(uids || []).filter(Boolean)
  });
}

// A courseId can carry BOTH a MOOC and a SPOC offering (a SPOC course shares its
// {school}-{id} with the plain course of the same name). `courses` holds one
// record per courseId, so the two offerings collide on every write.
//
// SPOC evidence is considered proven when activeTermId is present — it is written
// only by COURSE_UPDATE, which main.js sends only from a genuine SPOC page — or
// when the recorded courseType is already 'spoc' (a /spoc/learn/ link harvest).
// A 'mooc' patch without that proof is a weak signal: course-discovery.js labels
// every href lacking /spoc/ as 'mooc', so the same course's plain /learn/ link
// would otherwise demote the record (popup title flips to the MOOC name and the
// item's click target becomes /learn/).
function isProvenSpocCourse(course) {
  return !!(course && (course.activeTermId || course.courseType === 'spoc'));
}

function isWeakMoocPatch(course) {
  return !!(course && course.courseType === 'mooc');
}

// Serialized read-modify-write: see mutateCourses above. Every course write
// must go through here so concurrent COURSE_LINKS / COURSE_UPDATE /
// COURSE_API_DATA updates cannot drop each other's courses.
async function upsertCourse(course) {
  if (!course || !course.courseId) return;
  await mutateCourses(courses => {
    const idx = courses.findIndex(c => c && c.courseId === course.courseId);
    const lastSeen = new Date().toISOString();
    if (idx >= 0) {
      const existing = courses[idx];
      if (isProvenSpocCourse(existing) && isWeakMoocPatch(course)) {
        // Drop the patch whole, not just courseType: the weak patch also carries
        // a MOOC termId, and overwriting the SPOC route termId would break the
        // temporary-proxy route. lastSeen still advances so proxy picking sees
        // the course as recently active.
        courses[idx] = { ...existing, lastSeen };
        return courses;
      }
      courses[idx] = { ...existing, ...course, lastSeen };
    } else {
      courses.push({ ...course, firstSeen: course.firstSeen || lastSeen, lastSeen });
    }
    return courses;
  });
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

// ─── icourse163 API — experimental direct refresh ──────────────────────
// Inlined from src/shared/icourse163-api.js — keep the two in sync (the shared
// copy is unit-tested; this copy is what actually runs). This path remains for
// course-link discovery diagnostics, but periodic/manual refreshes use a
// same-origin Content Script proxy, including a temporary proxy tab when no
// learning page is open. termId (from the canonical learn URL) is the bridge
// key; our own courseId is attached to results so they dedup with API items.

const ICOURSE_ORIGIN = 'https://www.icourse163.org';
const API_TERM_DTO_RPC = 'web/j/courseBean.getMocTermDto.rpc';
const API_TERM_DTO_SPOC_RPC = 'web/j/courseBean.getSpocTermDto.rpc';
const API_TERM_DTO_DWR = 'dwr/call/plaincall/CourseBean.getMocTermDto.dwr';
const API_TERM_DTO_SPOC_DWR = 'dwr/call/plaincall/CourseBean.getSpocTermDto.dwr';

const API_DEADLINE_FIELDS = ['deadline', 'endTime', 'submitEndTime', 'evaluateEnd', 'evaluationEndTime', 'examEndTime', 'testEndTime', 'homeworkEndTime', 'jobDeadline', 'closeTime'];
const API_SCORE_FIELDS = ['userScore', 'mark', 'score', 'studentScore', 'finalMark'];
const API_TOTAL_FIELDS = ['totalMark', 'totalScore', 'fullMark', 'allMark'];

function apiPad(n) { return String(n).padStart(2, '0'); }

function apiDetectPhase(node) {
  // 测验(type:2)无互评，作业(type:3)才有
  // 部分 SPOC 课程的这些字段在 node.test 中
  var nt = node.test || {};
  var t = String(node.type || nt.type || node.contentType || '');
  if (t !== '3') return null;
  var e = node.enableEvaluation != null ? node.enableEvaluation : nt.enableEvaluation;
  var es = node.evaluateStart != null ? node.evaluateStart : nt.evaluateStart;
  if (!e || es == null) return null;
  var pub = parseInt(node.scorePubStatus != null ? node.scorePubStatus : nt.scorePubStatus, 10) || 0;
  if (pub === 2) return 'results';
  if (pub === 1) {
    // scorePubStatus=1 表示平台标记了窗口关闭，但实际 evaluateEnd 可能未到
    // 只有 evaluateEnd 真正过了才当 results，否则按时间降级判断
    var now = Date.now();
    var start = parseInt(es, 10);
    var end = parseInt((node.evaluateScoreReleaseTime || nt.evaluateScoreReleaseTime) || (node.evaluateEnd || nt.evaluateEnd), 10);
    if (end && now >= end) return 'results';
    if (start && now < start) return 'submit';
    return 'peerreview';
  }
  now = Date.now();
  start = parseInt(es, 10);
  end = parseInt((node.evaluateScoreReleaseTime || nt.evaluateScoreReleaseTime) || (node.evaluateEnd || nt.evaluateEnd), 10);
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

// The content script reports only what it fetched. The click target and the
// collision-proof SPOC evidence live on the stored Course record, which the SW
// owns, so resolve them here rather than trusting a round-tripped echo:
//   - pageUrl      — the route URL frozen by COURSE_UPDATE from the page the user
//                    actually opened. API items must inherit it, because their own
//                    termId is the API id, which is the wrong `tid` for a route.
//   - activeTermId — proves SPOC even when courseType was demoted (see above).
// A page-supplied pageUrl still wins when present: the page-hook path captured
// its response from that exact URL.
async function resolveCourseForExtraction(course) {
  if (!course || !course.courseId) return course;
  try {
    const courses = await getCourses();
    const stored = courses.find(c => c && c.courseId === course.courseId);
    if (!stored) return course;
    return {
      ...course,
      courseType: isProvenSpocCourse(stored) ? 'spoc' : (course.courseType || stored.courseType || ''),
      pageUrl: course.pageUrl || stored.pageUrl || ''
    };
  } catch {
    return course;
  }
}

function apiExtractHomework(input, course) {
  const data = apiCoerceJson(input);
  if (!data || !course) return [];
  const out = [];
  const seen = new Set();
  // Nodes that carry a name AND a signal but fail the type gate. They used to be
  // dropped in total silence, which made "this course's items are missing" almost
  // undiagnosable — the contentType that caused it was never reported anywhere.
  // Kept in sync with src/shared/icourse163-api.js (invariant 12).
  const nearMisses = [];
  let visited = 0;
  function looksLikeChapter(node) { return Array.isArray(node.lessons) || /chapter/i.test(node.type || ''); }
  function looksLikeLesson(node) { return Array.isArray(node.units) || /lesson/i.test(node.type || ''); }
  function visit(node, chapterId, lessonId) {
    if (!node || typeof node !== 'object' || visited > 5000) return;
    visited++;
    if (Array.isArray(node)) { for (const c of node) visit(c, chapterId, lessonId); return; }
    const name = node.name || node.title || node.unitName || '';
    // deadline/score 可能在 node.test 子对象中（SPOC 课程常见）
    const deadlineMs = apiFirstNumber(node, API_DEADLINE_FIELDS) || (node.test ? apiFirstNumber(node.test, API_DEADLINE_FIELDS) : null);
    const score = apiFirstNumber(node, API_SCORE_FIELDS) || (node.test ? apiFirstNumber(node.test, API_SCORE_FIELDS) : null);
    const totalScore = apiFirstNumber(node, API_TOTAL_FIELDS) || (node.test ? apiFirstNumber(node.test, API_TOTAL_FIELDS) : null);
    const hasSignal = deadlineMs != null || (score != null && totalScore != null);
    // contentType 是权威字段：2=测验, 3=作业, 6=考试；名字正则作为后备
    var ct = String(node.contentType || '');
    var ctIsAssessed = ct === '2' || ct === '3' || ct === '6';
    var isAssessed = typeof name === 'string' && name.trim() && hasSignal &&
        (ctIsAssessed || (!ct && /测验|作业|考试|测试|quiz|exam|homework|test/i.test(name)));
    if (isAssessed) {

      const homeworkId = String(node.id || node.jobId || node.quizId || node.testId || node.homeworkId || '') || ('h' + (out.length + 1));
      const uid = `${course.courseId}_tid${course.termId}_ch${chapterId || ''}_le${lessonId || ''}_hw${homeworkId}`;
      if (!seen.has(uid)) {
        seen.add(uid);
        // 互评中：用 evaluateEnd 代替原来的提交截止日期
        var nt2 = node.test || {};
        var phaseDeadline = deadlineMs;
        if (apiDetectPhase(node) === 'peerreview') {
          var pe = parseInt(node.evaluateEnd || nt2.evaluateEnd,10);
          if (pe > 0) phaseDeadline = pe;
        }
        const deadline = phaseDeadline != null ? apiMsToLocalIso(phaseDeadline) : null;
        // 完成判定：有分数 OR 已提交（互评中除外）OR 节点含完成文本
        var nType = parseInt(node.type || nt2.type || node.contentType, 10);
        var submitted = parseInt(node.usedTryCount || nt2.usedTryCount,10) > 0 && (nType === 3 || nType === 6);
        // 互评中不算完成（等待评分），互评期结束后回到已提交则算完成
        var inPeerReview = apiDetectPhase(node) === 'peerreview';
        var done = (score != null && totalScore != null && score > 0)
                || (submitted && !inPeerReview)
                || apiHasCompletedText(node, 0);
        out.push({
          uid, courseId: course.courseId, termId: course.termId,
          chapterId: chapterId || '', lessonId: lessonId || '', homeworkId,
          title: name.trim(), type: apiClassifyType(name, node.contentType || nt2.type || null),
          courseName: course.courseName || '', schoolName: course.schoolName || '',
          // Kept in sync with src/shared/icourse163-api.js extractHomeworkFromTermDto:
          // items must self-describe their route type, otherwise a demoted Course
          // record is the only thing deciding /learn/ vs /spoc/learn/.
          courseType: course.courseType || '',
          status: done ? 'completed' : 'unfinished',
          checkedOff: done, manuallyCheckedOff: false,
          autoDetectedCompleted: done, completionReason: done ? 'auto' : null,
          hwPhase: apiDetectPhase(node),
          deadline, deadlineRaw: deadline ? '(API)' : null,
          score, totalScore, source: 'api', pageUrl: course.pageUrl || '',
          apiCompleted: done
        });
      }
    } else if (typeof name === 'string' && name.trim() && hasSignal) {
      // Name + signal but the type gate rejected it. Record why, capped so a
      // 200KB DTO cannot flood the console.
      if (nearMisses.length < 5) {
        nearMisses.push({
          name: String(name).trim().slice(0, 40),
          contentType: ct || null,
          type: node.type != null ? node.type : null,
          testType: (node.test && node.test.type != null) ? node.test.type : null
        });
      } else if (nearMisses.length === 5) {
        nearMisses.push('…');
      }
    }

    const nextChapter = node.chapterId || (looksLikeChapter(node) ? node.id : chapterId);
    const nextLesson = node.lessonId || (looksLikeLesson(node) ? node.id : lessonId);
    for (const key of Object.keys(node)) {
      // `test` 是节点自身的元数据，不是子作业 —— 它自带 name/type/deadline，
      // 访问它会以 test.id 为 homeworkId 再生成一条重复条目（2026-09 在真实 DTO
      // 上实测：「第一章 测验」和三条 Multisim 测验都中招，只因为末尾的同名去重
      // 才没露出）。所需字段都通过 node.test 显式读取，故跳过该子树。
      // 与 src/shared/icourse163-api.js 保持一致（不变量 12）。
      if (key === 'test') continue;
      const v = node[key];
      if (v && typeof v === 'object') {
        visit(v, nextChapter, nextLesson);
      } else if (typeof v === 'string' && v.length > 50 && (v.charAt(0) === '{' || v.charAt(0) === '[')) {
        // 内嵌 JSON 字符串（如 jsonContent, outline 等字段可能存为 JSON 文本）
        var embedded = apiCoerceJson(v);
        if (embedded && typeof embedded === 'object') {
          console.log('[MOOC Reminder] apiExtractHomework: found embedded JSON in key "' + key + '" len=' + v.length);
          visit(embedded, nextChapter, nextLesson);
        }
      }
    }
  }
  visit(data, '', '');
  console.log('[MOOC Reminder] apiExtractHomework: visited', visited, 'nodes, found', out.length, 'candidate items for', course.courseId, course.courseName || '');
  if (out.length === 0) {
    // 诊断：输出数据中的关键字段帮助定位
    var topKeys = data ? Object.keys(data) : [];
    console.log('[MOOC Reminder] apiExtractHomework: top-level keys:', topKeys);
    var resultObj = data && data.result;
    if (resultObj && typeof resultObj === 'object') {
      console.log('[MOOC Reminder] apiExtractHomework: result keys:', Object.keys(resultObj));
      // 遍历 result 所有直接子级，找出哪个有 chapters/lessons/units/homework 相关结构
      for (var rk in resultObj) {
        if (Object.prototype.hasOwnProperty.call(resultObj, rk) && typeof resultObj[rk] === 'object' && resultObj[rk] !== null) {
          var subKeys = Object.keys(resultObj[rk]).slice(0, 15);
          console.log('[MOOC Reminder] result.' + rk + ' keys:', subKeys);
        }
      }
    } else if (data && typeof data === 'object') {
      // result 不在顶层，遍历 data 所有直接子级
      for (var dk in data) {
        if (Object.prototype.hasOwnProperty.call(data, dk) && typeof data[dk] === 'object' && data[dk] !== null) {
          subKeys = Object.keys(data[dk]).slice(0, 15);
          console.log('[MOOC Reminder] data.' + dk + ' keys:', subKeys);
        }
      }
    }
  }
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

  if (nearMisses.length > 0) {
    // Deliberately actionable: when a course looks like it is missing items, this
    // line names the contentType the gate rejected. See CLAUDE.md「抓不到/抓不全条目」.
    console.log('[MOOC Reminder] apiExtractHomework: ' + nearMisses.length +
      ' 个节点有名字+截止/分数但被类型门槛拦下（若某课程条目缺失，先看这里）:', JSON.stringify(nearMisses));
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

async function apiFetchRpcTermDto(csrfKey, termId, endpoint) {
  const url = `${ICOURSE_ORIGIN}/${endpoint}?csrfKey=${encodeURIComponent(csrfKey)}`;
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
    throw makeApiError('rpc', 'HTTP ' + resp.status, { endpoint, status: resp.status, body: responseSnippet(text) });
  }
  if (/非法跨域|csrf|forbidden|error/i.test(text)) {
    throw makeApiError('rpc', 'server rejected request', { endpoint, body: responseSnippet(text) });
  }
  return { text, endpoint };
}

async function apiFetchDwrTermDto(termId, endpoint) {
  const url = `${ICOURSE_ORIGIN}/${endpoint}`;
  // Extract method name from endpoint: "dwr/call/plaincall/CourseBean.getMocTermDto.dwr"
  const methodMatch = endpoint.match(/CourseBean\.(\w+)\.dwr$/);
  const methodName = methodMatch ? methodMatch[1] : 'getMocTermDto';
  const body = [
    'callCount=1',
    'scriptSessionId=',
    'httpSessionId=',
    'c0-scriptName=CourseBean',
    'c0-methodName=' + methodName,
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
    throw makeApiError('dwr', 'HTTP ' + resp.status, { endpoint, status: resp.status, body: responseSnippet(text) });
  }
  if (/exception|forbidden|csrf|非法跨域/i.test(text)) {
    throw makeApiError('dwr', 'server rejected request', { endpoint, body: responseSnippet(text) });
  }
  return { text, endpoint };
}

async function apiFetchTermDto(csrfKey, termId) {
  const errors = [];
  const hasCsrf = !!csrfKey;
  try {
    const result = await apiFetchRpcTermDto(csrfKey, termId, API_TERM_DTO_RPC);
    result.csrfOk = hasCsrf;
    return result;
  } catch (e) {
    e.details = e.details || {};
    e.details.csrfKeyFound = hasCsrf;
    errors.push(e.details || { message: e.message });
  }
  try {
    const result = await apiFetchDwrTermDto(termId, API_TERM_DTO_DWR);
    result.csrfOk = hasCsrf;
    return result;
  } catch (e) {
    e.details = e.details || {};
    e.details.csrfKeyFound = hasCsrf;
    errors.push(e.details || { message: e.message });
  }
  throw makeApiError('termDto', 'all endpoints failed', { termId, errors, csrfKeyFound: hasCsrf });
}

async function apiFetchTermDtoSpoc(csrfKey, termId) {
  const errors = [];
  const hasCsrf = !!csrfKey;
  try {
    const result = await apiFetchRpcTermDto(csrfKey, termId, API_TERM_DTO_SPOC_RPC);
    result.csrfOk = hasCsrf;
    return result;
  } catch (e) {
    e.details = e.details || {};
    e.details.csrfKeyFound = hasCsrf;
    errors.push(e.details || { message: e.message });
  }
  try {
    const result = await apiFetchDwrTermDto(termId, API_TERM_DTO_SPOC_DWR);
    result.csrfOk = hasCsrf;
    return result;
  } catch (e) {
    e.details = e.details || {};
    e.details.csrfKeyFound = hasCsrf;
    errors.push(e.details || { message: e.message });
  }
  throw makeApiError('termDtoSpoc', 'all SPOC endpoints failed', { termId, errors, csrfKeyFound: hasCsrf });
}

async function apiRefreshCourse(course, csrfKey) {
  // SPOC: 用 activeTermId（真实 termId）替换 URL 假 termId
  const apiTermId = course.activeTermId || course.termId;
  if (!course || !apiTermId) return { changed: 0, itemCount: 0, endpoint: null };
  const courseIsSpoc = course.courseType === 'spoc';

  // 先尝试 Moc 端点
  let fetched;
  try {
    fetched = await apiFetchTermDto(csrfKey, apiTermId);
  } catch (e) {
    // Moc 端点全部失败，SPOC 课程尝试 Spoc 端点
    if (courseIsSpoc) {
      console.log('[MOOC Reminder] SPOC: Moc endpoints failed for', course.courseId, ', trying SPOC endpoints...');
      try {
        fetched = await apiFetchTermDtoSpoc(csrfKey, apiTermId);
        console.log('[MOOC Reminder] SPOC: SPOC endpoint succeeded for', course.courseId);
      } catch (e2) {
        console.warn('[MOOC Reminder] SPOC: All endpoints failed for', course.courseId, e2.message);
        return { changed: 0, itemCount: 0, endpoint: null };
      }
    } else {
      throw e;
    }
  }

  const items = apiExtractHomework(fetched.text, course);
  if (items.length === 0 && courseIsSpoc) {
    // Moc 端点成功但提取到 0 条，尝试 Spoc 端点
    console.log('[MOOC Reminder] SPOC: Moc endpoint returned 0 items for', course.courseId, ', trying SPOC endpoint...');
    try {
      const spocFetched = await apiFetchTermDtoSpoc(csrfKey, apiTermId);
      const spocItems = apiExtractHomework(spocFetched.text, course);
      if (spocItems.length > 0) {
        console.log('[MOOC Reminder] SPOC: SPOC endpoint returned', spocItems.length, 'items for', course.courseId);
        const result = await reconcileHomeworkData(course, spocItems);
        return { changed: result.added + result.updated, itemCount: spocItems.length, endpoint: spocFetched.endpoint };
      }
    } catch (e2) {
      console.debug('[MOOC Reminder] SPOC: SPOC endpoint also failed:', e2.message);
    }
    return { changed: 0, itemCount: 0, endpoint: fetched.endpoint };
  }
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
