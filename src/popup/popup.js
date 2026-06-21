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
  try { await loadData(); }       catch(e) { console.error('[Popup] loadData:', e.message); }
  try { render(); }               catch(e) {
    console.error('[Popup] render crashed:', e.message, e.stack);
    safeSetBody('<div class="empty-state"><div class="empty-icon">'+wIcon('alert-triangle',44,'#dc3545')+'</div><p class="empty-title">渲染失败</p><p class="empty-desc">'+escapeHtml(String(e.message))+'</p></div>');
  }
  console.log('[Popup] init done, items:', state.items.length, 'courses:', state.courses.length);
  window.__popup_ok = true;
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
          dailyDigestHour: 8
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

  safeOn(dom.filterSelect, 'change', (e) => {
    try { state.filter = e.target.value; applyFilter(); render(); } catch {}
  });
}

// ─── Data Loading ──────────────────────────────────────

async function loadData() {
  console.log('[Popup] loadData start');
  // Reset to safe defaults before attempting load
  state.allItems = [];
  state.courses = [];
  state.lastSync = null;
  state.syncErrors = [];
  state.scrapeStatus = null;
  state.items = [];

  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_HOMEWORK' });
    console.log('[Popup] GET_HOMEWORK response:', response ? 'received' : 'empty');

    if (response && typeof response === 'object') {
      state.allItems = Array.isArray(response.allItems) ? response.allItems.filter(Boolean) : [];
      state.courses  = Array.isArray(response.courses)  ? response.courses.filter(Boolean)  : [];
      state.lastSync = response.lastSync || null;
      state.syncErrors = Array.isArray(response.syncErrors) ? response.syncErrors.filter(Boolean) : [];
      state.scrapeStatus = response.scrapeStatus || null;
    }
  } catch (e) {
    console.error('[Popup] loadData failed:', e.message);
    // Stay with empty defaults — render will show empty state
  }

  try { applyFilter(); } catch(e) { console.error('[Popup] applyFilter:', e.message); }
  console.log('[Popup] loadData done, allItems:', state.allItems.length);
}

function applyFilter() {
  const safe = Array.isArray(state.allItems) ? state.allItems.filter(Boolean) : [];

  switch (state.filter) {
    case 'overdue':
      state.items = safe.filter(i => i && !i.checkedOff && isOverdue(i));
      break;
    case 'completed':
      state.items = safe.filter(i => i && i.checkedOff);
      break;
    case 'all':
      state.items = safe;
      break;
    default:  // 'unfinished' — includes overdue, so the list matches the badge/footer count
      state.items = safe.filter(i => i && !i.checkedOff);
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

  const latest = errors[errors.length - 1];
  const errorText = latest && (latest.error || latest.message) ? String(latest.error || latest.message) : '未知错误';
  const timeText = latest && latest.time ? formatDeadline(latest.time) : '';
  dom.diagnostics.style.display = 'block';
  dom.diagnostics.innerHTML =
    '<details>' +
      '<summary>最近抓取错误（' + errors.length + '）</summary>' +
      '<div class="diagnostics-body">' + escapeHtml(timeText ? timeText + ' · ' + errorText : errorText) + '</div>' +
    '</details>';
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
    const orderedEntries = Object.entries(grouped).sort((a, b) => {
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
  if (item.pageUrl) return item.pageUrl;
  if (item.courseId && item.termId) {
    return 'https://www.icourse163.org/learn/' + item.courseId + '?tid=' + item.termId + '#/learn/content';
  }
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

  const group = document.createElement('div');
  group.className = 'course-group' + (isCollapsed ? ' collapsed' : '');
  group.dataset.courseId = courseId;

  // Header
  const header = document.createElement('div');
  header.className = 'course-group-header';
  header.innerHTML =
    '<div class="course-group-title">' +
      '<span class="course-group-arrow">' + wIcon('chevron-down', 14) + '</span>' +
      '<span>' + escapeHtml(courseName) + '</span>' +
      (schoolName ? '<span style="font-weight:400;font-size:11px;color:#999;">' + escapeHtml(schoolName) + '</span>' : '') +
    '</div>' +
    '<span class="course-group-count">' + (Array.isArray(items) ? items.length : 0) + ' 项</span>';

  header.addEventListener('click', function() {
    try {
      group.classList.toggle('collapsed');
      if (group.classList.contains('collapsed')) {
        state.collapsedCourses.add(courseId);
      } else {
        state.collapsedCourses.delete(courseId);
      }
    } catch {}
  });

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

  // 阶段/提醒标签（已完成的也显示，样式和未完成一样）
  if (item.type === 'quiz') {
    var autoEl = document.createElement('span');
    autoEl.className = 'item-type';
    autoEl.textContent = '自动检测';
    autoEl.style.fontSize = '10px';
    autoEl.style.background = '#d4edda';
    autoEl.style.color = '#155724';
    meta.appendChild(autoEl);
  }
  if (item.type !== 'quiz') {
    var mnEl = document.createElement('span');
    mnEl.className = 'item-type';
    mnEl.textContent = '手动确认';
    mnEl.style.fontSize = '10px';
    mnEl.style.background = '#e2e3e5';
    mnEl.style.color = '#6c757d';
    meta.appendChild(mnEl);
  }
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

  if (url) {
    const openBtn = document.createElement('span');
    openBtn.className = 'item-open';
    openBtn.title = '打开页面';
    openBtn.setAttribute('role', 'button');
    openBtn.innerHTML = wIcon('external-link', 14);
    openBtn.addEventListener('click', function () { openUrl(url); });
    el.appendChild(openBtn);
  }

  return el;
}

// ─── Summary & Footer ─────────────────────────────────

function updateSummary() {
  const safe = Array.isArray(state.allItems) ? state.allItems.filter(Boolean) : [];
  const unfinished = safe.filter(i => i && !i.checkedOff);
  const overdue = unfinished.filter(i => isOverdue(i)).length;
  const soon    = unfinished.filter(i => !isOverdue(i) && isDueWithin(i, 48)).length;
  const normal  = unfinished.filter(i => !isOverdue(i) && !isDueWithin(i, 48)).length;

  if (dom.countOverdue) dom.countOverdue.textContent = overdue;
  if (dom.countSoon)    dom.countSoon.textContent    = soon;
  if (dom.countNormal)  dom.countNormal.textContent  = normal;
}

function updateFooter() {
  const safe = Array.isArray(state.allItems) ? state.allItems.filter(Boolean) : [];
  // Badge truth: all unfinished items, including overdue ones.
  const count = safe.filter(i => i && !i.checkedOff).length;

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

async function handleRefresh() {
  console.log('[Popup] handleRefresh');
  try { if (dom.refreshBtn) dom.refreshBtn.classList.add('spinning'); } catch {}

  try {
    const response = await chrome.runtime.sendMessage({ type: 'TRIGGER_SCRAPE' });
    console.log('[Popup] TRIGGER_SCRAPE response:', response);

    // 无论刷新是否成功，重新加载数据并重新渲染（保持当前 filter 状态）
    await loadData();
    render();

    if (response && response.success) {
      showToast('刷新成功，扫描到 ' + (response.scrapedCount || 0) + ' 项');
    } else if (response && response.error) {
      showToast(response.error);
    } else {
      showToast('刷新完成（无新数据）');
    }
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
