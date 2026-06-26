/**
 * Popup UI Logic — MOOC Reminder (hardened v2)
 *
 * Principle: this file MUST never crash. Every function has its own
 * try-catch and null-guards. If the background SW is broken, the popup
 * should still show its UI (empty state + error message).
 */

// ─── Recovery Watchdog ──────────────────────────────────
// Runs BEFORE anything else. If init() fails, shows recovery UI after 4s.
// All code is external (no CSP-violating inline scripts).

function wIcon(name, size, color) {
  try {
    var svg = window.MOOC_ICON ? window.MOOC_ICON(name, { size: size }) : '';
    return color ? '<span style="color:' + color + ';display:inline-flex;">' + svg + '</span>' : svg;
  } catch { return ''; }
}

// 全局未捕获 Promise 拒绝处理
window.addEventListener('unhandledrejection', function (e) {
  var msg = e && e.reason ? String(e.reason.message || e.reason) : 'Unknown rejection';
  if (msg.indexOf('Extension context invalidated') >= 0) {
    console.warn('[Popup] Context invalidated, halting');
    e.preventDefault();
    return;
  }
  console.warn('[Popup] Unhandled rejection:', msg);
  e.preventDefault();
});

(function setupWatchdog() {
  window.__popup_ok = false;

  setTimeout(function() {
    if (window.__popup_ok) return;  // init() succeeded

    // Render recovery UI
    var body = document.body;
    if (!body) return;
    body.innerHTML =
      '<div style="padding:24px;text-align:center;font-family:sans-serif;">' +
        '<div style="margin-bottom:12px;">' + wIcon('alert-triangle', 40, '#dc3545') + '</div>' +
        '<p style="font-size:14px;font-weight:600;margin-bottom:4px;">插件加载失败</p>' +
        '<p style="font-size:12px;color:#999;margin-bottom:16px;">可能是缓存数据损坏导致</p>' +
        '<button id="w-recover" style="padding:8px 20px;background:#dc3545;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;margin-right:8px;">清除缓存并重置</button>' +
        '<button id="w-reload" style="padding:8px 20px;background:#6c757d;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;">重新加载扩展</button>' +
        '<p style="font-size:10px;color:#bbb;margin-top:12px;">如仍无法解决，请在 chrome://extensions/ 中移除并重新加载扩展</p>' +
      '</div>';

    var recoverBtn = document.getElementById('w-recover');
    var reloadBtn  = document.getElementById('w-reload');

    if (recoverBtn) {
      recoverBtn.addEventListener('click', function() {
        try {
          chrome.storage.local.clear(function() {
            document.body.innerHTML =
              '<div style="padding:24px;text-align:center;font-family:sans-serif;">' +
                '<div style="margin-bottom:12px;">' + wIcon('check-circle', 40, '#28a745') + '</div>' +
                '<p style="font-size:14px;font-weight:600;">缓存已清除</p>' +
                '<p style="font-size:12px;color:#999;">请关闭后重新打开，或打开课程页面刷新</p>' +
              '</div>';
          });
        } catch(e) {
          alert('清除失败: ' + e.message);
        }
      });
    }

    if (reloadBtn) {
      reloadBtn.addEventListener('click', function() {
        alert('请：\n1. 打开 chrome://extensions/\n2. 找到 MOOC Reminder\n3. 点击刷新按钮\n4. 或移除后重新加载扩展');
      });
    }
  }, 4000);
})();

// ─── State ─────────────────────────────────────────────
const state = {
  items: [],
  allItems: [],
  courses: [],
  lastSync: null,
  syncErrors: [],
  scrapeStatus: null,
  settings: {},
  filter: 'unfinished',  // 'unfinished' | 'overdue' | 'completed' | 'all'
  collapsedCourses: new Set()
};

// ─── Safe DOM access ───────────────────────────────────
function safeQuery(sel) {
  try { return document.querySelector(sel); } catch { return null; }
}

const dom = {};

function initDomRefs() {
  dom.homeworkList    = safeQuery('#homework-list');
  dom.emptyState      = safeQuery('#empty-state');
  dom.loginWarning    = safeQuery('#login-warning');
  dom.diagnostics     = safeQuery('#diagnostics');
  dom.refreshBtn      = safeQuery('#refresh-btn');
  dom.settingsBtn     = safeQuery('#settings-btn');
  dom.emptyRefreshBtn = safeQuery('#empty-refresh-btn');
  dom.resetDataBtn    = safeQuery('#reset-data-btn');
  dom.exportIcsBtn    = safeQuery('#export-ics-btn');
  dom.filterSelect    = safeQuery('#filter-select');
  dom.addManualBtn    = safeQuery('#add-manual-btn');
  dom.manualForm      = safeQuery('#manual-form');
  dom.manualSaveBtn   = safeQuery('#manual-save-btn');
  dom.manualCancelBtn = safeQuery('#manual-cancel-btn');
  dom.manualTitle     = safeQuery('#manual-title');
  dom.manualCourse    = safeQuery('#manual-course');
  dom.manualDeadline  = safeQuery('#manual-deadline');
  dom.manualUrl       = safeQuery('#manual-url');
  dom.clearCompletedBtn = safeQuery('#clear-completed-btn');
  dom.totalCount      = safeQuery('#total-count');
  dom.syncTime        = safeQuery('#sync-time');
  dom.countOverdue    = safeQuery('#count-overdue');
  dom.countSoon       = safeQuery('#count-soon');
  dom.countNormal     = safeQuery('#count-normal');
}

// ─── Initialization ────────────────────────────────────

async function init() {
  console.log('[Popup] init start');

  // ═══ STEP 0: Validate & auto-repair corrupted storage ═══
  // Runs BEFORE anything else. Bypasses background SW entirely.
  // If stale corrupt data exists, auto-clear it so render won't crash.
  await validateAndAutoRepair();

  initDomRefs();

  try { if (window.MOOC_HYDRATE_ICONS) window.MOOC_HYDRATE_ICONS(); } catch(e) { console.error('[Popup] hydrate icons:', e.message); }
  try { setupEventListeners(); } catch(e) { console.error('[Popup] setupEventListeners:', e.message); }
  try { await loadUiState(); }    catch(e) { console.error('[Popup] loadUiState:', e.message); }
  try { await loadData(); }       catch(e) { console.error('[Popup] loadData:', e.message); }
  try { render(); }               catch(e) {
    console.error('[Popup] render crashed:', e.message, e.stack);
    safeSetBody('<div class="empty-state"><div class="empty-icon">'+wIcon('alert-triangle',44,'#dc3545')+'</div><p class="empty-title">渲染失败</p><p class="empty-desc">'+escapeHtml(String(e.message))+'</p></div>');
  }
  console.log('[Popup] init done, items:', state.items.length, 'courses:', state.courses.length);
  window.__popup_ok = true;
  try { document.body.classList.add('loaded'); } catch {}

  // 首次打开无数据，尝试刷新
  if (state.allItems.length === 0) {
    console.log('[Popup] No items, checking for MOOC tabs...');
    try {
      var hasTabs = await hasMoocTabs();
      if (!hasTabs) {
        render();
        return;
      }
      if (dom.refreshBtn) dom.refreshBtn.classList.add('spinning');
      chrome.runtime.sendMessage({ type: 'TRIGGER_SCRAPE' }).catch(function(){});
      await sleepPopup(1000);
      await chrome.runtime.sendMessage({ type: 'TRIGGER_SCRAPE' });
      for (var retry = 0; retry < 30; retry++) {
        await sleepPopup(500);
        await loadData();
        if (state.allItems.length > 0) break;
      }
      render();
      if (dom.refreshBtn) dom.refreshBtn.classList.remove('spinning');
      if (state.allItems.length === 0) {
        try { showToast('请打开 MOOC 课程页面后重试'); } catch {}
      }
    } catch(e) {
      if (dom.refreshBtn) dom.refreshBtn.classList.remove('spinning');
    }
  }
}

// ─── Storage Self-Repair ────────────────────────────────

async function validateAndAutoRepair() {
  console.log('[Popup] validateAndAutoRepair start');
  try {
    var raw = await chrome.storage.local.get(['homework_items', 'courses']);
    var items   = raw.homework_items;
    var courses = raw.courses;
    var corrupted = false;

    // Check 1: homework_items must be an array
    if (items !== undefined && !Array.isArray(items)) {
      console.warn('[Popup] CORRUPTED: homework_items is not an array, type=', typeof items);
      corrupted = true;
    }

    // Check 2: every item in the array must be an object with a uid
    if (!corrupted && Array.isArray(items) && items.length > 0) {
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item === null || item === undefined || typeof item !== 'object' || !item.uid) {
          console.warn('[Popup] CORRUPTED: item[' + i + '] is invalid:', JSON.stringify(item).substring(0, 80));
          corrupted = true;
          break;
        }
      }
    }

    // Check 3: courses must be an array
    if (courses !== undefined && !Array.isArray(courses)) {
      console.warn('[Popup] CORRUPTED: courses is not an array, type=', typeof courses);
      corrupted = true;
    }

    // Check 4: every course must be an object with a courseId
    if (!corrupted && Array.isArray(courses) && courses.length > 0) {
      for (var j = 0; j < courses.length; j++) {
        var c = courses[j];
        if (c === null || c === undefined || typeof c !== 'object' || !c.courseId) {
          console.warn('[Popup] CORRUPTED: courses[' + j + '] is invalid:', JSON.stringify(c).substring(0, 80));
          corrupted = true;
          break;
        }
      }
    }

    if (corrupted) {
      console.log('[Popup] AUTO-REPAIR: clearing corrupted storage');
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        homework_items: [],
        courses: [],
        last_sync: null,
        sync_errors: [],
        user_settings: {
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
          mutedCourseIds: []
        }
      });
      console.log('[Popup] AUTO-REPAIR: done. Proceeding with clean state.');
      // Don't reload — continue rendering empty state naturally
    } else {
      console.log('[Popup] Storage validation passed');
    }
  } catch (e) {
    console.error('[Popup] validateAndAutoRepair error:', e.message);
    try { await chrome.storage.local.clear(); } catch {}
    // Don't reload — let the rest of init() handle it
  }
}

function safeSetBody(html) {
  try { document.body.innerHTML = html; } catch {}
}

// ─── Event Listeners ──────────────────────────────────

function setupEventListeners() {
  const safeOn = (el, event, fn) => {
    if (el) { try { el.addEventListener(event, fn); } catch {} }
  };

  safeOn(dom.refreshBtn,      'click', handleRefresh);
  safeOn(dom.settingsBtn,     'click', handleOpenSettings);
  safeOn(dom.emptyRefreshBtn, 'click', handleRefresh);
  safeOn(dom.resetDataBtn,    'click', handleResetData);
  safeOn(dom.exportIcsBtn,    'click', handleExportCalendar);
  safeOn(dom.clearCompletedBtn, 'click', handleClearCompleted);
  safeOn(dom.addManualBtn,    'click', toggleManualForm);
  safeOn(dom.manualCancelBtn, 'click', toggleManualForm);
  safeOn(dom.manualSaveBtn,   'click', handleAddManualItem);

  safeOn(dom.filterSelect, 'change', (e) => {
    try { state.filter = e.target.value; saveUiState(); applyFilter(); render(); } catch {}
  });
}

// ─── Data Loading ──────────────────────────────────────

async function loadUiState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_POPUP_STATE' });
    const ui = response && response.uiState ? response.uiState : {};
    if (ui.filter) state.filter = ui.filter;
    if (Array.isArray(ui.collapsedCourses)) state.collapsedCourses = new Set(ui.collapsedCourses);
    if (dom.filterSelect) dom.filterSelect.value = state.filter;
  } catch (e) {
    console.debug('[Popup] loadUiState failed:', e.message);
  }
}

function saveUiState() {
  try {
    chrome.runtime.sendMessage({
      type: 'SET_POPUP_STATE',
      uiState: {
        filter: state.filter,
        collapsedCourses: Array.from(state.collapsedCourses)
      }
    });
  } catch { /* best effort */ }
}

async function sendMessageSafe(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    if (e && e.message && e.message.indexOf('context invalidated') >= 0) {
      console.warn('[Popup] Extension context invalidated, cannot communicate with background');
    } else {
      console.error('[Popup] sendMessage failed:', e && e.message);
    }
    return null;
  }
}

async function loadData() {
  console.log('[Popup] loadData start');
  // Reset to safe defaults before attempting load
  state.allItems = [];
  state.courses = [];
  state.lastSync = null;
  state.syncErrors = [];
  state.scrapeStatus = null;
  state.items = [];

  var response = await sendMessageSafe({ type: 'GET_HOMEWORK' });
  console.log('[Popup] GET_HOMEWORK response:', response ? 'received' : 'empty');

  if (response && typeof response === 'object') {
    state.allItems = Array.isArray(response.allItems) ? response.allItems.filter(Boolean) : [];
    state.courses  = Array.isArray(response.courses)  ? response.courses.filter(Boolean)  : [];
    state.lastSync = response.lastSync || null;
    state.syncErrors = Array.isArray(response.syncErrors) ? response.syncErrors.filter(Boolean) : [];
    state.scrapeStatus = response.scrapeStatus || null;
    state.settings = response.settings || {};
  }

  try { applyFilter(); } catch(e) { console.error('[Popup] applyFilter:', e.message); }
  console.log('[Popup] loadData done, allItems:', state.allItems.length);
}

function applyFilter() {
  const safe = Array.isArray(state.allItems) ? state.allItems.filter(Boolean) : [];
  var _now = Date.now();

  // Helper: 是否应隐藏（一次缓存 new Date()）
  function isExpiredButShouldHide(item) {
    if (!item || !item.deadline) return false;
    try {
      var dl = new Date(item.deadline).getTime();
      if (dl >= _now) return false;
      if (item.type === 'quiz' || item.type === 'exam') return true;
      if (item.type === 'homework') return true;
      return false;
    } catch { return false; }
  }

  function _isOverdue(item) {
    if (!item || !item.deadline) return false;
    try { return new Date(item.deadline).getTime() < _now; } catch { return false; }
  }

  switch (state.filter) {
    case 'overdue':
      state.items = safe.filter(i => i && !i.checkedOff && _isOverdue(i));
      break;
    case 'completed':
      // 已完成视图中排除过期后被清理的作业
      state.items = safe.filter(i => i && i.checkedOff && !isExpiredButShouldHide(i));
      break;
    case 'all':
      state.items = safe;
      break;
    default:  // 'unfinished'
      // 未完成视图中排除过期测验/考试
      state.items = safe.filter(i => i && !i.checkedOff && !isExpiredButShouldHide(i));
      break;
  }
}


// ─── Rendering ─────────────────────────────────────────

function getScrapeWarning() {
  const status = state.scrapeStatus;
  if (!status || typeof status !== 'object') return null;

  if (status.status === 'login_required') {
    return {
      type: 'login',
      title: '请先登录 icourse163.org',
      message: status.message || '登录过期会导致作业无法刷新'
    };
  }

  if (status.status === 'empty_on_homework_page') {
    return {
      type: 'scrape',
      title: '可能未识别到作业列表',
      message: status.message || '页面已加载，但未抓取到作业条目，可能是网页结构变化'
    };
  }

  if (status.status === 'error') {
    return {
      type: 'error',
      title: '最近一次抓取失败',
      message: status.message || '请重新打开课程页面后刷新'
    };
  }

  return null;
}

function renderScrapeWarning() {
  const warning = getScrapeWarning();
  if (!dom.loginWarning) return;

  if (!warning) {
    dom.loginWarning.style.display = 'none';
    return;
  }

  dom.loginWarning.style.display = 'block';
  dom.loginWarning.className = 'login-warning ' + (warning.type || 'scrape');
  dom.loginWarning.innerHTML =
    '<div class="warning-icon">' + wIcon(warning.type === 'login' ? 'lock' : 'alert-triangle', 32) + '</div>' +
    '<p class="warning-title">' + escapeHtml(warning.title) + '</p>' +
    '<p class="warning-desc">' + escapeHtml(warning.message) + '</p>';
}

function renderDiagnostics() {
  if (!dom.diagnostics) return;
  const errors = Array.isArray(state.syncErrors) ? state.syncErrors : [];
  if (errors.length === 0) {
    dom.diagnostics.style.display = 'none';
    dom.diagnostics.innerHTML = '';
    return;
  }

  // 自动清除模式：直接清空错误并隐藏
  if (state.settings && state.settings.autoDismissErrors) {
    chrome.runtime.sendMessage({ type: 'CLEAR_ERRORS' }).catch(function(){});
    dom.diagnostics.style.display = 'none';
    dom.diagnostics.innerHTML = '';
    return;
  }

  const latest = errors[errors.length - 1];
  const errorText = latest && (latest.error || latest.message) ? String(latest.error || latest.message) : '未知错误';
  const timeText = latest && latest.time ? formatDeadline(latest.time) : '';
  dom.diagnostics.style.display = 'block';
  dom.diagnostics.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
      '<details style="flex:1;">' +
        '<summary>最近抓取错误（' + errors.length + '）</summary>' +
        '<div class="diagnostics-body">' + escapeHtml(timeText ? timeText + ' · ' + errorText : errorText) + '</div>' +
      '</details>' +
      '<button id="dismiss-errors-btn" style="background:none;border:none;cursor:pointer;color:#999;padding:2px 6px;font-size:18px;line-height:1;border-radius:4px;" title="关闭" aria-label="关闭">×</button>' +
    '</div>';

  try {
    var dismissBtn = document.getElementById('dismiss-errors-btn');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function() {
        dom.diagnostics.style.display = 'none';
        dom.diagnostics.innerHTML = '';
      });
      dismissBtn.addEventListener('mouseenter', function() { this.style.background = '#eee'; });
      dismissBtn.addEventListener('mouseleave', function() { this.style.background = 'none'; });
    }
  } catch(e) { console.error('[Popup] dismiss-btn handler:', e.message); }
}


function render() {
  console.log('[Popup] render start');

  const list  = dom.homeworkList;
  const empty = dom.emptyState;

  if (!list || !empty) {
    console.error('[Popup] render: missing list or empty element');
    safeSetBody('<div style="padding:20px;text-align:center;color:#999;">界面加载失败，请重新打开</div>');
    return;
  }

  const itemCount = Array.isArray(state.items) ? state.items.length : 0;
  const hasWarning = !!getScrapeWarning();
  try { renderScrapeWarning(); } catch(e) { console.error('[Popup] renderScrapeWarning:', e.message); }
  try { renderDiagnostics(); } catch(e) { console.error('[Popup] renderDiagnostics:', e.message); }

  if (itemCount === 0) {
    try { list.style.display = 'none'; } catch {}
    try { empty.style.display = hasWarning ? 'none' : 'block'; } catch {}
  } else {
    try { list.style.display = 'block'; } catch {}
    try { empty.style.display = 'none'; } catch {}

    try { list.innerHTML = ''; } catch {}

    const grouped = groupByCourse(state.items);
    const courses = Array.isArray(state.courses) ? state.courses.filter(Boolean) : [];

    // Order course groups by their most urgent (earliest) deadline.
    // Skip muted courses
    var mutedIds = new Set(Array.isArray(state.settings.mutedCourseIds) ? state.settings.mutedCourseIds : []);
    const orderedEntries = Object.entries(grouped).filter(function(e) { return !mutedIds.has(e[0]); }).sort((a, b) => {
      const am = Math.min.apply(null, a[1].map(deadlineMs));
      const bm = Math.min.apply(null, b[1].map(deadlineMs));
      return am - bm;
    });

    for (const [courseId, items] of orderedEntries) {
      if (!Array.isArray(items) || items.length === 0) continue;

      const course = courses.find(c => c && c.courseId === courseId) || {
        courseId: courseId || '__unknown__',
        courseName: items[0]?.courseName || '未知课程',
        schoolName: items[0]?.schoolName || ''
      };

      try {
        const groupEl = createCourseGroup(course, items);
        if (groupEl && groupEl.nodeType) list.appendChild(groupEl);
      } catch(e) {
        console.error('[Popup] createCourseGroup failed:', e.message);
      }
    }
  }

  try { updateSummary(); } catch(e) { console.error('[Popup] updateSummary:', e.message); }
  try { updateFooter();   } catch(e) { console.error('[Popup] updateFooter:', e.message); }
}

// ─── Grouping ──────────────────────────────────────────

function groupByCourse(items) {
  const groups = {};
  if (!Array.isArray(items)) return groups;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const key = item.courseId || '__unknown__';
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

// Earliest-deadline-first sort key; items without a deadline sink to the bottom.
function deadlineMs(item) {
  if (!item || !item.deadline) return Infinity;
  try {
    const t = new Date(item.deadline).getTime();
    return isNaN(t) ? Infinity : t;
  } catch { return Infinity; }
}

function sortItemsByDeadline(items) {
  return (Array.isArray(items) ? items.slice() : []).sort((a, b) => deadlineMs(a) - deadlineMs(b));
}

// Where clicking an item should take you: its own page, else a reconstructed
// course learn URL (API-discovered items may not carry a pageUrl).
function resolveItemUrl(item) {
  if (!item) return null;
  var base = item.courseId && item.termId
    ? 'https://www.icourse163.org/learn/' + item.courseId + '?tid=' + item.termId
    : null;
  // pageUrl 可能有错误的 hash（如 /learn/content），按类型修正
  var route = item.type === 'exam' ? '/learn/examlist' : '/learn/testlist';
  if (item.pageUrl) {
    // 如果 pageUrl 的 hash 不匹配类型，修正它
    var hashIdx = item.pageUrl.indexOf('#');
    if (hashIdx >= 0) return item.pageUrl.slice(0, hashIdx) + '#' + route;
    return item.pageUrl + '#' + route;
  }
  if (base) return base + '#' + route;
  return null;
}

function openUrl(url) {
  if (!url) return;
  try {
    if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url: url });
    else window.open(url, '_blank');
  } catch { try { window.open(url, '_blank'); } catch { /* ignore */ } }
}

function createCourseGroup(course, items) {
  if (!course || typeof course !== 'object') return document.createElement('div');

  const courseId   = course.courseId || '__unknown__';
  const courseName = course.courseName || '未知课程';
  const schoolName = course.schoolName || '';
  const isCollapsed = state.collapsedCourses.has(courseId);
  const mutedCourses = Array.isArray(state.settings.mutedCourseIds) ? state.settings.mutedCourseIds : [];
  const isMuted = mutedCourses.indexOf(courseId) >= 0;

  const group = document.createElement('div');
  group.className = 'course-group' + (isCollapsed ? ' collapsed' : '');
  group.dataset.courseId = courseId;

  // Header
  const header = document.createElement('div');
  header.className = 'course-group-header';
  // 根据设置决定是否显示静音按钮
  var showMute = state.settings.showCourseMute !== false;
  var muteBtnHtml = showMute
    ? '<button class="item-action-btn course-mute-btn" title="' + (isMuted ? '取消静音' : '静音课程') + '" aria-label="静音课程">' + wIcon(isMuted ? 'bell' : 'bell-off', 13) + '</button>'
    : '';
  header.innerHTML =
    '<div class="course-group-title">' +
      '<span class="course-group-arrow">' + wIcon('chevron-down', 14) + '</span>' +
      '<span>' + escapeHtml(courseName) + '</span>' +
      (schoolName ? '<span style="font-weight:400;font-size:11px;color:#999;">' + escapeHtml(schoolName) + '</span>' : '') +
      (isMuted ? '<span class="course-muted-badge" title="课程通知已静音">' + wIcon('bell-off', 13) + '</span>' : '') +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:6px;">' +
      muteBtnHtml +
      '<span class="course-group-count">' + (Array.isArray(items) ? items.length : 0) + ' 项</span>' +
    '</div>';

  header.addEventListener('click', function() {
    try {
      group.classList.toggle('collapsed');
      if (group.classList.contains('collapsed')) {
        state.collapsedCourses.add(courseId);
      } else {
        state.collapsedCourses.delete(courseId);
      }
      saveUiState();
    } catch {}
  });
  const muteBtn = header.querySelector('.course-mute-btn');
  if (muteBtn) {
    muteBtn.addEventListener('click', function(e) {
      try { e.stopPropagation(); handleToggleCourseMute(courseId, isMuted); } catch {}
    });
  }

  // Items
  const container = document.createElement('div');
  container.className = 'course-group-items';

  if (Array.isArray(items)) {
    for (const item of sortItemsByDeadline(items)) {
      try {
        const el = createHomeworkItem(item);
        if (el && el.nodeType) container.appendChild(el);
      } catch {}
    }
  }

  group.appendChild(header);
  group.appendChild(container);
  return group;
}

function createHomeworkItem(item) {
  if (!item || typeof item !== 'object') return document.createElement('div');

  const urgency = getUrgency(item);
  const isDone  = !!item.checkedOff;
  const uid     = item.uid || '';

  const el = document.createElement('div');
  el.className = 'homework-item urgency-' + urgency + (isDone ? ' completed' : '');
  if (uid) el.dataset.uid = uid;

  // Checkbox
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'item-checkbox';
  cb.checked = isDone;
  cb.addEventListener('change', function() {
    try { handleCheckOff(uid, cb.checked); } catch {}
  });

  // Content wrapper
  const content = document.createElement('div');
  content.className = 'item-content';

  const titleEl = document.createElement('div');
  titleEl.className = 'item-title';
  titleEl.textContent = item.title || '(无标题)';

  const meta = document.createElement('div');
  meta.className = 'item-meta';

  // Type badge
  const typeBadge = document.createElement('span');
  typeBadge.className = 'item-type ' + (item.type || 'homework');
  typeBadge.textContent = typeLabel(item.type);

  // Deadline
  const deadlineEl = document.createElement('span');
  deadlineEl.className = 'item-deadline' + (urgency === 'overdue' ? ' overdue' : urgency === 'soon' ? ' soon' : '');
  deadlineEl.textContent = item.deadline ? formatDeadline(item.deadline, urgency) : '无截止日期';

  meta.appendChild(typeBadge);

  // 自动检测标签（API 已覆盖所有类型）
  var autoEl = document.createElement('span');
  autoEl.className = 'item-type';
  autoEl.textContent = '自动检测';
  autoEl.style.fontSize = '10px';
  autoEl.style.background = '#d4edda';
  autoEl.style.color = '#155724';
  meta.appendChild(autoEl);
  // 作业互评阶段：额外显示[互评中]标签
  if (item.type === 'homework' && item.hwPhase === 'peerreview') {
    var prEl = document.createElement('span');
    prEl.className = 'item-type';
    prEl.textContent = '互评中';
    prEl.style.fontSize = '10px';
    prEl.style.background = '#fff3cd';
    prEl.style.color = '#856404';
    meta.appendChild(prEl);
  }

  meta.appendChild(deadlineEl);

  content.appendChild(titleEl);
  content.appendChild(meta);

  // Clicking the item (anywhere but the checkbox) opens its page.
  const url = resolveItemUrl(item);
  if (url) {
    content.classList.add('clickable');
    content.setAttribute('role', 'button');
    content.title = '打开页面';
    content.addEventListener('click', function () { openUrl(url); });
  }

  el.appendChild(cb);
  el.appendChild(content);

  const actions = document.createElement('span');
  actions.className = 'item-actions';
  if (!isDone && state.settings.showSnoozeButton !== false) {
    const snoozeBtn = document.createElement('button');
    snoozeBtn.type = 'button';
    snoozeBtn.className = 'item-action-btn';
    snoozeBtn.title = item.snoozedUntil ? '已稍后提醒至 ' + formatDeadline(item.snoozedUntil) : '24 小时后再提醒';
    snoozeBtn.innerHTML = wIcon('clock', 13);
    snoozeBtn.addEventListener('click', function (e) { e.stopPropagation(); handleSnoozeItem(uid); });
    actions.appendChild(snoozeBtn);
  }
  if (actions.children.length > 0) el.appendChild(actions);

  return el;
}

// ─── Summary & Footer ─────────────────────────────────

function updateSummary() {
  const safe = Array.isArray(state.allItems) ? state.allItems.filter(Boolean) : [];
  const mutedIds = new Set(Array.isArray(state.settings.mutedCourseIds) ? state.settings.mutedCourseIds : []);
  const visible = safe.filter(i => i && !mutedIds.has(i.courseId));
  const unfinished = visible.filter(i => i && !i.checkedOff);
  const overdue = unfinished.filter(i => isOverdue(i)).length;
  const soon    = unfinished.filter(i => !isOverdue(i) && isDueWithin(i, 48)).length;
  const normal  = unfinished.filter(i => !isOverdue(i) && !isDueWithin(i, 48)).length;

  if (dom.countOverdue) dom.countOverdue.textContent = overdue;
  if (dom.countSoon)    dom.countSoon.textContent    = soon;
  if (dom.countNormal)  dom.countNormal.textContent  = normal;
}

function updateFooter() {
  const safe = Array.isArray(state.allItems) ? state.allItems.filter(Boolean) : [];
  const mutedIds = new Set(Array.isArray(state.settings.mutedCourseIds) ? state.settings.mutedCourseIds : []);
  const visible = safe.filter(i => i && !mutedIds.has(i.courseId));
  // Badge truth: all unfinished items, including overdue ones.
  const count = visible.filter(i => i && !i.checkedOff).length;

  if (dom.totalCount) dom.totalCount.textContent = '共 ' + count + ' 项未完成';

  if (dom.syncTime) {
    if (state.lastSync) {
      try {
        const d = new Date(state.lastSync);
        const pad = function(n) { return String(n).padStart(2, '0'); };
        dom.syncTime.textContent = '上次同步: ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      } catch {
        dom.syncTime.textContent = '同步时间异常';
      }
    } else {
      dom.syncTime.textContent = '尚未同步';
    }
  }
}

// ─── Actions ───────────────────────────────────────────

async function handleCheckOff(uid, checked) {
  try {
    await chrome.runtime.sendMessage({ type: 'MARK_COMPLETED', homeworkUid: uid, checkedOff: checked });
  } catch(e) {
    console.error('[Popup] MARK_COMPLETED failed:', e.message);
  }

  try {
    const item = state.allItems.find(i => i && i.uid === uid);
    if (item) {
      item.checkedOff = checked;
      item.manuallyCheckedOff = checked;
      item.completionReason = checked ? 'manual' : null;
    }
  } catch(e) { console.error('[Popup] local update failed:', e.message); }

  try { applyFilter(); render(); } catch {}
  try { chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' }); } catch {}
}

function sleepPopup(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function hasMoocTabs() {
  return chrome.runtime.sendMessage({ type: 'HAS_TABS' }).then(function(r) { return r && r.hasTabs; }).catch(function() { return false; });
}

async function handleRefresh() {
  console.log('[Popup] handleRefresh');
  try { if (dom.refreshBtn) dom.refreshBtn.classList.add('spinning'); } catch {}

  try {
    var hasTabs = await hasMoocTabs();
    if (!hasTabs) {
      await loadData(); render();
      if (dom.refreshBtn) dom.refreshBtn.classList.remove('spinning');
      if (state.allItems.length > 0) { showToast('已加载缓存数据'); } else { showToast('请打开 MOOC 课程页面后刷新'); }
      return;
    }
    // 第一次：预热
    chrome.runtime.sendMessage({ type: 'TRIGGER_SCRAPE' }).catch(function(){});
    await sleepPopup(1000);
    // 第二次：轮询 storage 直到数据到达
    await chrome.runtime.sendMessage({ type: 'TRIGGER_SCRAPE' });
    for (var retry = 0; retry < 30; retry++) {
      await sleepPopup(500);
      await loadData();
      if (state.allItems.length > 0) break;
    }
    render();
    showToast(state.allItems.length > 0 ? '刷新成功' : '请打开 MOOC 课程页面后重试');
  } catch(e) {
    console.error('[Popup] handleRefresh failed:', e.message);
    // 刷新失败也重新渲染（应用当前filter）
    try { await loadData(); render(); } catch {}
    showToast('刷新失败: ' + e.message);
  }

  try { if (dom.refreshBtn) dom.refreshBtn.classList.remove('spinning'); } catch {}
}

function handleOpenSettings() {
  try {
    if (chrome.runtime && chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('src/popup/options.html'), '_blank');
    }
  } catch (e) {
    console.error('[Popup] openOptionsPage failed:', e.message);
  }
}

function toggleManualForm() {
  if (!dom.manualForm) return;
  dom.manualForm.style.display = dom.manualForm.style.display === 'none' ? 'block' : 'none';
}

async function handleAddManualItem() {
  try {
    const title = (dom.manualTitle && dom.manualTitle.value || '').trim();
    const courseName = (dom.manualCourse && dom.manualCourse.value || '').trim() || '手动提醒';
    const rawDeadline = dom.manualDeadline && dom.manualDeadline.value;
    const pageUrl = (dom.manualUrl && dom.manualUrl.value || '').trim();
    if (!title || !rawDeadline) {
      showToast('请填写标题和截止时间');
      return;
    }
    const response = await chrome.runtime.sendMessage({
      type: 'ADD_MANUAL_ITEM',
      title,
      courseName,
      deadline: new Date(rawDeadline).toISOString(),
      pageUrl
    });
    if (response && response.success) {
      showToast('已添加提醒');
      if (dom.manualTitle) dom.manualTitle.value = '';
      if (dom.manualCourse) dom.manualCourse.value = '';
      if (dom.manualDeadline) dom.manualDeadline.value = '';
      if (dom.manualUrl) dom.manualUrl.value = '';
      if (dom.manualForm) dom.manualForm.style.display = 'none';
      await loadData();
      render();
    } else {
      showToast(response && response.error ? response.error : '添加失败');
    }
  } catch (e) {
    console.error('[Popup] add manual item failed:', e.message);
    showToast('添加失败: ' + e.message);
  }
}

async function handleSnoozeItem(uid) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'SNOOZE_ITEM', homeworkUid: uid, hours: 24 });
    if (response && response.success) {
      const item = state.allItems.find(i => i && i.uid === uid);
      if (item) item.snoozedUntil = response.snoozedUntil;
      showToast('已设置 24 小时后再提醒');
      render();
    } else {
      showToast(response && response.error ? response.error : '设置失败');
    }
  } catch (e) {
    console.error('[Popup] snooze failed:', e.message);
    showToast('设置失败: ' + e.message);
  }
}

async function handleToggleCourseMute(courseId, wasMuted) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'TOGGLE_COURSE_MUTE', courseId, muted: !wasMuted });
    if (response && response.success) {
      state.settings = response.settings || state.settings;
      showToast(response.muted ? '课程已静音' : '课程已取消静音');
      render();
    } else {
      showToast(response && response.error ? response.error : '操作失败');
    }
  } catch (e) {
    console.error('[Popup] toggle course mute failed:', e.message);
    showToast('操作失败: ' + e.message);
  }
}

async function handleClearCompleted() {
  if (!confirm('清除所有已完成记录？未完成作业不会受影响。')) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_COMPLETED' });
    if (response && response.success) {
      showToast('已清除已完成记录');
      await loadData();
      render();
    } else {
      showToast(response && response.error ? response.error : '清除失败');
    }
  } catch (e) {
    console.error('[Popup] clear completed failed:', e.message);
    showToast('清除失败: ' + e.message);
  }
}

function handleExportCalendar() {
  try {
    if (!window.MOOC_GENERATE_ICS || !window.MOOC_EXPORTABLE_ITEMS) {
      showToast('日历导出模块未加载');
      return;
    }
    const exportable = window.MOOC_EXPORTABLE_ITEMS(state.allItems);
    if (exportable.length === 0) {
      showToast('没有可导出的未完成作业');
      return;
    }
    const ics = window.MOOC_GENERATE_ICS(exportable, { alarmMinutes: 60 });
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const pad = function(n) { return String(n).padStart(2, '0'); };
    a.href = url;
    a.download = 'mooc-reminder-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.ics';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { URL.revokeObjectURL(url); a.remove(); } catch { /* ignore */ }
    }, 1000);
    showToast('已导出 ' + exportable.length + ' 项到日历文件');
  } catch (e) {
    console.error('[Popup] export calendar failed:', e.message);
    showToast('导出失败: ' + e.message);
  }
}

async function handleResetData() {
  if (!confirm('确定要清除所有缓存的作业数据吗？\n\n这将删除所有已爬取的课程和作业记录，下次需要重新打开课程页面来爬取。')) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: 'RESET_DATA' });
    console.log('[Popup] RESET_DATA response:', response);

    state.allItems = [];
    state.courses = [];
    state.items = [];
    state.lastSync = null;
    state.collapsedCourses.clear();
    render();
    showToast('数据已清除');
  } catch(e) {
    console.error('[Popup] RESET_DATA failed:', e.message);
    showToast('重置失败，请尝试在 chrome://extensions/ 中重新加载扩展');
  }
}

// ─── Utility Functions ─────────────────────────────────

function isOverdue(item) {
  if (!item || !item.deadline) return false;
  try { return new Date(item.deadline) < new Date(); } catch { return false; }
}

function isDueWithin(item, hours) {
  if (!item || !item.deadline) return false;
  try {
    const now = new Date();
    const dl  = new Date(item.deadline);
    return dl > now && (dl - now) <= hours * 3600000;
  } catch { return false; }
}

function getUrgency(item) {
  if (!item || item.checkedOff) return 'normal';
  if (isOverdue(item)) return 'overdue';
  if (isDueWithin(item, 48)) return 'soon';
  return 'normal';
}

function typeLabel(type) {
  var map = { homework: '作业', quiz: '测验', exam: '考试', discussion: '讨论' };
  return map[type] || '作业';
}

function formatDeadline(isoString, urgency) {
  if (!isoString) return '无截止日期';
  try {
    var d = new Date(isoString);
    var now = new Date();
    var pad = function(n) { return String(n).padStart(2, '0'); };
    var dateStr = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
    var timeStr = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var diffMs = d - now;
    var diffDays = Math.floor(diffMs / 86400000);
    var diffHours = Math.floor(diffMs / 3600000);
    var relative = '';
    if (diffMs < 0) {
      var overdueDays = Math.abs(diffDays);
      relative = overdueDays === 0 ? '今天已过期' : overdueDays + '天前过期';
    } else if (diffDays === 0) {
      relative = diffHours === 0 ? '即将截止' : diffHours + '小时后';
    } else if (diffDays === 1) {
      relative = '明天截止';
    } else if (diffDays <= 7) {
      relative = diffDays + '天后';
    } else {
      relative = dateStr;
    }
    return relative + ' (' + dateStr + ' ' + timeStr + ')';
  } catch {
    return String(isoString);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  try {
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  } catch { return String(str); }
}

function showToast(message) {
  try {
    var old = document.querySelector('.toast');
    if (old) old.remove();

    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = String(message);
    toast.style.cssText =
      'position:fixed;bottom:50px;left:50%;transform:translateX(-50%);' +
      'background:#333;color:#fff;padding:8px 16px;border-radius:6px;' +
      'font-size:12px;z-index:100;opacity:0;transition:opacity 0.3s;';
    document.body.appendChild(toast);

    requestAnimationFrame(function() {
      toast.style.opacity = '1';
      setTimeout(function() {
        toast.style.opacity = '0';
        setTimeout(function() { try { toast.remove(); } catch {} }, 300);
      }, 2000);
    });
  } catch {}
}

// ─── Boot ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  console.log('[Popup] DOMContentLoaded');
  init().catch(function(e) {
    console.error('[Popup] FATAL:', e.message, e.stack);
    safeSetBody('<div class="empty-state"><div class="empty-icon">' + wIcon('alert-triangle', 44, '#dc3545') + '</div><p class="empty-title">插件加载失败</p><p class="empty-desc">' + escapeHtml(String(e.message)) + '</p><p style="margin-top:12px;"><button id="fatal-clear-btn" class="btn btn-primary btn-danger">清除缓存</button></p></div>');
    // Attach listener instead of an inline onclick (MV3 CSP forbids inline handlers).
    var clearBtn = document.getElementById('fatal-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', function() {
        try { chrome.storage.local.clear(); clearBtn.textContent = '已清除，请重新打开'; } catch (err) { console.error(err); }
      });
    }
  });
});
