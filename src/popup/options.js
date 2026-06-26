/**
 * Options page logic — MOOC Reminder
 *
 * Loads user_settings, renders the form, and on save sends SETTINGS_UPDATED to
 * the background, which normalizes/persists the settings and re-applies the
 * alarm cadence. These settings used to be stored but never read.
 */

const LEAD_CHOICES = [72, 48, 24, 12, 6, 2]; // hours
let currentSettings = null;

const DEFAULTS = {
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
  autoDismissErrors: false,
  showSnoozeButton: true,
  showExternalLink: true,
  showCourseMute: true,
  domScrapingEnabled: true
};

function $(id) { return document.getElementById(id); }

function buildLeadChips() {
  const grid = $('lead-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const h of LEAD_CHOICES) {
    const label = document.createElement('label');
    label.className = 'lead-chip';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'lead-' + h;
    cb.value = String(h);
    const text = document.createElement('span');
    text.textContent = h >= 24 && h % 24 === 0 ? (h / 24) + ' 天' : h + ' 小时';
    label.appendChild(cb);
    label.appendChild(text);
    grid.appendChild(label);
  }
}

function buildHourSelect(sel) {
  if (!sel) return;
  sel.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option');
    opt.value = String(h);
    opt.textContent = (h < 10 ? '0' + h : h) + ':00';
    sel.appendChild(opt);
  }
}

function safeSetChecked(id, val) {
  var el = $(id);
  if (el) el.checked = !!val;
}
function safeSetValue(id, val) {
  var el = $(id);
  if (el) el.value = String(val != null ? val : '');
}
function populate(settings) {
  currentSettings = Object.assign({}, DEFAULTS, settings || {});
  const s = currentSettings;
  safeSetValue('check-interval', s.checkIntervalMinutes);
  safeSetValue('badge-interval', s.badgeRefreshMinutes);
  safeSetChecked('auto-detect', s.autoDetectEnabled !== false);
  safeSetChecked('notify-enabled', s.notificationsEnabled !== false);
  safeSetChecked('notify-overdue', s.notifyOverdue !== false);
  safeSetChecked('quiet-enabled', s.quietHoursEnabled === true);
  safeSetValue('quiet-start', s.quietStart);
  safeSetValue('quiet-end', s.quietEnd);
  safeSetChecked('auto-dismiss-errors', s.autoDismissErrors === true);
  safeSetChecked('show-snooze-btn', s.showSnoozeButton !== false);
  safeSetChecked('show-external-link', s.showExternalLink !== false);
  safeSetChecked('show-course-mute', s.showCourseMute !== false);
  safeSetChecked('dom-scrape', s.domScrapingEnabled !== false);
  safeSetChecked('digest-enabled', s.dailyDigestEnabled === true);
  safeSetValue('digest-hour', s.dailyDigestHour);
  const leads = Array.isArray(s.notifyLeadHours) ? s.notifyLeadHours : DEFAULTS.notifyLeadHours;
  for (const h of LEAD_CHOICES) {
    const cb = $('lead-' + h);
    if (cb) cb.checked = leads.indexOf(h) >= 0;
  }
}

function safeGetChecked(id) {
  var el = $(id);
  return el ? el.checked : false;
}
function safeGetInt(id, fallback) {
  var el = $(id);
  if (!el) return fallback != null ? fallback : 0;
  var v = parseInt(el.value, 10);
  return isNaN(v) ? (fallback != null ? fallback : 0) : v;
}
function collect() {
  const leads = [];
  for (const h of LEAD_CHOICES) {
    const cb = $('lead-' + h);
    if (cb && cb.checked) leads.push(h);
  }
  return {
    checkIntervalMinutes: safeGetInt('check-interval', 30),
    badgeRefreshMinutes: safeGetInt('badge-interval', 5),
    autoDetectEnabled: safeGetChecked('auto-detect'),
    notificationsEnabled: safeGetChecked('notify-enabled'),
    notifyLeadHours: leads,
    notifyOverdue: safeGetChecked('notify-overdue'),
    quietHoursEnabled: safeGetChecked('quiet-enabled'),
    quietStart: safeGetInt('quiet-start', 22),
    quietEnd: safeGetInt('quiet-end', 8),
    dailyDigestEnabled: safeGetChecked('digest-enabled'),
    dailyDigestHour: safeGetInt('digest-hour', 8),
    mutedCourseIds: currentSettings && Array.isArray(currentSettings.mutedCourseIds) ? currentSettings.mutedCourseIds : [],
    autoDismissErrors: safeGetChecked('auto-dismiss-errors'),
    showSnoozeButton: safeGetChecked('show-snooze-btn'),
    showExternalLink: safeGetChecked('show-external-link'),
    showCourseMute: safeGetChecked('show-course-mute'),
    domScrapingEnabled: safeGetChecked('dom-scrape')
  };
}

function showStatus(text, isError) {
  const el = $('save-status');
  if (!el) return;
  // Toast-style 提示替代原来的文字显示
  el.textContent = text;
  el.style.color = isError ? '#dc3545' : '#28a745';
  el.style.fontWeight = '600';
  el.style.fontSize = '13px';
  el.style.opacity = '1';
  el.style.transition = 'opacity 0.3s';
  if (text) {
    setTimeout(function () {
      try { el.style.opacity = '0'; } catch {}
      setTimeout(function () { try { el.textContent = ''; el.style.opacity = '1'; } catch {} }, 300);
    }, 4000);
  }
}

function setSaveBtnLoading(loading) {
  const btn = $('save-btn');
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = '<span class="icon-slot" data-icon="refresh" data-icon-size="15" style="display:inline-block;animation:spin 1s linear infinite;"></span>保存中...';
  } else {
    btn.disabled = false;
    btn.innerHTML = '<span class="icon-slot" data-icon="check" data-icon-size="15"></span>保存设置';
  }
}

async function loadSettings() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (resp && resp.settings) return resp.settings;
  } catch (e) {
    console.error('[Options] GET_SETTINGS failed:', e.message);
  }
  // Fallback: read storage directly.
  try {
    const raw = await chrome.storage.local.get('user_settings');
    return raw.user_settings || DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

async function save() {
  // 显示加载中状态
  setSaveBtnLoading(true);
  const statusEl = $('save-status');
  if (statusEl) statusEl.textContent = '';

  // 收集设置
  let settings;
  try {
    settings = collect();
  } catch (e) {
    console.error('[Options] collect failed:', e.message);
    showStatus('读取设置失败：' + e.message, true);
    setSaveBtnLoading(false);
    return;
  }

  // 尝试发送到后台 SW（最多重试 1 次）
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', settings: settings });
      if (resp && resp.success) {
        populate(resp.settings);
        showStatus('✓ 已保存');
        try { if (window.MOOC_HYDRATE_ICONS) window.MOOC_HYDRATE_ICONS(); } catch {}
        setSaveBtnLoading(false);
        return;
      }
      lastError = resp && resp.error ? resp.error : '保存失败';
    } catch (e) {
      lastError = e.message;
      console.error('[Options] save attempt ' + (attempt + 1) + ' failed:', e.message);
      if (attempt === 0) await new Promise(r => setTimeout(r, 500));
    }
  }

  // 两次均失败，直接写入 storage 作为兜底
  try {
    const raw = await chrome.storage.local.get('user_settings');
    const merged = Object.assign({}, raw.user_settings || DEFAULTS, settings);
    await chrome.storage.local.set({ user_settings: merged });
    showStatus('✓ 已保存（本地）');
  } catch (e2) {
    console.error('[Options] storage fallback failed:', e2.message);
    showStatus('✗ 保存失败：' + (lastError || e2.message), true);
  }
  setSaveBtnLoading(false);
}

async function loadErrorReport() {
  var body = $('error-report-body');
  if (!body) return;
  try {
    var raw;
    try {
      raw = await chrome.storage.local.get('sync_errors');
    } catch (e) {
      body.innerHTML = '<p style="color:var(--text-faint);font-size:12px;margin:8px 0;">存储不可用</p>';
      return;
    }
    var errors = Array.isArray(raw.sync_errors) ? raw.sync_errors.filter(Boolean) : [];
    if (errors.length === 0) {
      body.innerHTML = '<p style="color:var(--text-faint);font-size:12px;margin:8px 0;">暂无错误记录</p>';
      return;
    }
    var html = '<div style="max-height:300px;overflow-y:auto;font-size:12px;">';
    for (var i = errors.length - 1; i >= 0; i--) {
      var e = errors[i];
      var errText = e && (e.error || e.message) ? String(e.error || e.message) : '未知错误';
      var timeStr = '';
      if (e && e.time) {
        try { var d = new Date(e.time); timeStr = d.toLocaleString('zh-CN'); } catch {}
      }
      html += '<div style="padding:8px 0;border-bottom:1px solid var(--border-soft);">';
      html += '<div style="color:var(--text-faint);margin-bottom:2px;">' + escapeHtml(timeStr || '') + '</div>';
      html += '<div style="color:var(--overdue,#dc3545);word-break:break-all;">' + escapeHtml(errText) + '</div>';
      html += '</div>';
    }
    html += '</div>';
    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = '<p style="color:var(--overdue);font-size:12px;">加载失败：' + escapeHtml(String(e.message)) + '</p>';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  var d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

async function handleClearErrors() {
  // 尝试通过后台 SW 清除
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_ERRORS' });
  } catch (e) {
    // SW 不可用时直接写 storage
    try {
      await chrome.storage.local.set({ sync_errors: [] });
    } catch (e2) {
      showStatus('清除失败：' + e2.message, true);
      return;
    }
  }
  // 验证清除是否真正生效
  try {
    var verify = await chrome.storage.local.get('sync_errors');
    var remaining = Array.isArray(verify.sync_errors) ? verify.sync_errors.length : 0;
    if (remaining > 0) {
      // 还有残留，再清一次
      await chrome.storage.local.set({ sync_errors: [] });
    }
  } catch {}
  // 重新加载显示
  await loadErrorReport();
  showStatus('错误已清除');
}

async function loadMutedCourses() {
  var body = document.getElementById('muted-courses-body');
  if (!body) return;

  // 获取课程列表
  var courses = [];
  try {
    var resp = await chrome.runtime.sendMessage({ type: 'GET_COURSES' });
    if (resp && resp.success) courses = Array.isArray(resp.courses) ? resp.courses : [];
  } catch (e) {
    body.innerHTML = '<p style="color:var(--text-faint);font-size:12px;margin:8px 0;">无法加载课程列表</p>';
    return;
  }

  // 获取已静音课程 ID
  var mutedIds = currentSettings && Array.isArray(currentSettings.mutedCourseIds) ? currentSettings.mutedCourseIds : [];
  if (mutedIds.length === 0) {
    body.innerHTML = '<p style="color:var(--text-faint);font-size:12px;margin:8px 0;">暂无已静音的课程</p>';
    return;
  }

  var mutedCourses = courses.filter(function(c) { return c && c.courseId && mutedIds.indexOf(c.courseId) >= 0; });

  if (mutedCourses.length === 0) {
    body.innerHTML = '<p style="color:var(--text-faint);font-size:12px;margin:8px 0;">暂无已静音的课程</p>';
    return;
  }

  var html = '';
  for (var i = 0; i < mutedCourses.length; i++) {
    var c = mutedCourses[i];
    var name = escapeHtml(c.courseName || '未知课程');
    var school = escapeHtml(c.schoolName || '');
    html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border-soft);">'
      + '<div><div style="font-size:13px;">' + name + '</div>'
      + (school ? '<div style="font-size:11px;color:var(--text-faint);">' + school + '</div>' : '')
      + '</div>'
      + '<button class="btn btn-sm btn-ghost muted-unmute-btn" data-course-id="' + escapeHtml(c.courseId) + '" style="font-size:12px;">取消静音</button>'
      + '</div>';
  }
  body.innerHTML = html;

  // 绑定取消静音按钮事件
  var btns = body.querySelectorAll('.muted-unmute-btn');
  for (var j = 0; j < btns.length; j++) {
    btns[j].addEventListener('click', async function() {
      var courseId = this.getAttribute('data-course-id');
      if (!courseId) return;
      try {
        var resp2 = await chrome.runtime.sendMessage({ type: 'TOGGLE_COURSE_MUTE', courseId: courseId, muted: false });
        if (resp2 && resp2.success) {
          currentSettings = resp2.settings || currentSettings;
          showStatus('已取消静音');
          loadMutedCourses(); // 刷新列表
        } else {
          showStatus('操作失败：' + (resp2 && resp2.error ? resp2.error : '未知错误'), true);
        }
      } catch (e) {
        showStatus('操作失败：' + e.message, true);
      }
    });
  }
}

async function init() {
  buildLeadChips();
  buildHourSelect($('quiet-start'));
  buildHourSelect($('quiet-end'));
  buildHourSelect($('digest-hour'));
  try { if (window.MOOC_HYDRATE_ICONS) window.MOOC_HYDRATE_ICONS(); } catch(e) { console.error('[Options] hydrate icons:', e.message); }
  try {
    const settings = await loadSettings();
    populate(settings);
  } catch (e) {
    console.error('[Options] loadSettings failed:', e.message);
    populate(DEFAULTS);
    try { showStatus('加载设置失败，已使用默认值', true); } catch {}
  }
  var saveBtn = $('save-btn');
  if (saveBtn) saveBtn.addEventListener('click', save);
  // 错误报告（独立 try-catch，不影响主流程）
  try {
    loadErrorReport();
    var refreshErrBtn = $('refresh-errors-btn');
    if (refreshErrBtn) refreshErrBtn.addEventListener('click', loadErrorReport);
    var clearErrBtn = $('clear-errors-btn');
    if (clearErrBtn) clearErrBtn.addEventListener('click', handleClearErrors);
  } catch(e) { console.error('[Options] error report init:', e.message); }
  try { loadMutedCourses(); } catch(e) { console.error('[Options] loadMutedCourses:', e.message); }
}

// 全局未捕获 Promise 拒绝处理
window.addEventListener('unhandledrejection', function (e) {
  var msg = e && e.reason ? String(e.reason.message || e.reason) : 'Unknown rejection';
  if (msg.indexOf('Extension context invalidated') >= 0 || msg.indexOf('context invalidated') >= 0) {
    console.warn('[Options] Extension context was invalidated, stopping');
    e.preventDefault();
    return;
  }
  console.warn('[Options] Unhandled rejection:', msg);
  e.preventDefault();
});

document.addEventListener('DOMContentLoaded', function () {
  init().catch(function (e) { console.error('[Options] init failed:', e.message); });
});
