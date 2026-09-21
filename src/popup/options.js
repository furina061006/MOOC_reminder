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
  checkIntervalMinutes: 12 * 60,
  badgeRefreshMinutes: 12 * 60,
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
  ignoredCourseIds: [],
  autoDismissErrors: true,
  showSnoozeButton: true,
  showCourseMute: true,
  autoCheckUpdates: true,
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
  safeSetValue('check-interval', Math.max(1, Math.round(s.checkIntervalMinutes / 60)));
  safeSetValue('badge-interval', Math.max(1, Math.round(s.badgeRefreshMinutes / 60)));
  safeSetChecked('auto-detect', s.autoDetectEnabled !== false);
  safeSetChecked('notify-enabled', s.notificationsEnabled !== false);
  safeSetChecked('notify-overdue', s.notifyOverdue !== false);
  safeSetChecked('quiet-enabled', s.quietHoursEnabled === true);
  safeSetValue('quiet-start', s.quietStart);
  safeSetValue('quiet-end', s.quietEnd);
  safeSetChecked('auto-dismiss-errors', s.autoDismissErrors === true);
  safeSetChecked('show-snooze-btn', s.showSnoozeButton !== false);
  safeSetChecked('show-course-mute', s.showCourseMute !== false);
  safeSetChecked('auto-check-updates', s.autoCheckUpdates !== false);
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
    checkIntervalMinutes: safeGetInt('check-interval', 12) * 60,
    badgeRefreshMinutes: safeGetInt('badge-interval', 12) * 60,
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
    ignoredCourseIds: currentSettings && Array.isArray(currentSettings.ignoredCourseIds) ? currentSettings.ignoredCourseIds : [],
    autoDismissErrors: safeGetChecked('auto-dismiss-errors'),
    showSnoozeButton: safeGetChecked('show-snooze-btn'),
    showCourseMute: safeGetChecked('show-course-mute'),
    autoCheckUpdates: safeGetChecked('auto-check-updates')
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
        console.log('[Options] save OK');
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
    console.log('[Options] save fallback');
    await chrome.storage.local.set({ user_settings: merged });
    showStatus('✓ 已保存（本地）');
  } catch (e2) {
    console.error('[Options] storage fallback failed:', e2.message);
    showStatus('✗ 保存失败：' + (lastError || e2.message), true);
  }
  setSaveBtnLoading(false);
}

function formatAlarmTime(alarm) {
  if (!alarm || !alarm.scheduledTime) return '未设置';
  try { return new Date(alarm.scheduledTime).toLocaleString('zh-CN'); } catch { return '时间不可用'; }
}

async function loadNotificationDiagnostics() {
  const body = $('notification-diagnostics-body');
  if (!body) return;
  body.innerHTML = '<p class="opt-sub" style="margin:8px 0 0;">加载通知状态中...</p>';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_NOTIFICATION_DIAGNOSTICS' });
    if (!response || !response.success) throw new Error(response && response.error ? response.error : '无法获取通知状态');
    const permission = response.permissionLevel === 'granted' ? '已允许' : response.permissionLevel === 'denied' ? '已禁止' : '未知';
    const settings = response.settings || {};
    const alarm = response.alarms && response.alarms.badgeRefresh;
    const rows = [
      ['Chrome 通知权限', permission],
      ['通知总开关', settings.notificationsEnabled ? '已开启' : '已关闭'],
      ['免打扰时段', response.quietHoursActive ? '当前生效，提醒会延后' : '当前未生效'],
      ['可立即提醒项目', String(response.dueNowCount || 0) + ' 项'],
      ['下次提醒检查', formatAlarmTime(alarm)]
    ];
    let html = '<div style="font-size:12px;margin:8px 0;">';
    for (const row of rows) {
      html += '<div style="display:flex;justify-content:space-between;gap:16px;padding:5px 0;border-bottom:1px solid var(--border-soft);"><span style="color:var(--text-faint);">' + escapeHtml(row[0]) + '</span><span>' + escapeHtml(row[1]) + '</span></div>';
    }
    html += '</div>';
    if (response.permissionLevel === 'denied') {
      html += '<p style="font-size:12px;color:var(--overdue,#dc3545);margin:8px 0;">请在 Chrome 扩展通知权限与 Windows 11 设置 > 系统 > 通知中允许 Chrome 通知。</p>';
    } else if (!settings.notificationsEnabled) {
      html += '<p style="font-size:12px;color:var(--text-faint);margin:8px 0;">开启“启用桌面通知”并保存设置后，系统才会发送截止提醒。</p>';
    } else if (response.quietHoursActive) {
      html += '<p style="font-size:12px;color:var(--text-faint);margin:8px 0;">当前处于插件免打扰时段，截止提醒会在该时段结束后的下一次检查发送。</p>';
    } else if (response.dueNowCount === 0) {
      html += '<p style="font-size:12px;color:var(--text-faint);margin:8px 0;">当前没有跨过提醒阈值的新作业。</p>';
    }
    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = '<p style="color:var(--overdue,#dc3545);font-size:12px;margin:8px 0;">加载失败：' + escapeHtml(String(e.message || e)) + '</p>';
  }
}

// ─── 更新 ──────────────────────────────────────────────
//
// 本扩展是开发者模式加载的，Chrome 不会自动更新它；这里只负责「告诉你有没有新版」
// 并给出下载入口。版本判定在 shared/update-check.js（有单测），SW 负责网络请求。

const SAFE_RELEASE_URL = /^https:\/\/github\.com\//;

function formatCheckTime(iso) {
  if (!iso) return '尚未检查';
  try { return new Date(iso).toLocaleString('zh-CN'); } catch { return '时间不可用'; }
}

function renderUpdateStatus(payload) {
  const body = $('update-status-body');
  if (!body) return;
  const status = (payload && payload.status) || null;
  // 「当前版本」是**正在运行的那个实例**的属性，不是上次检查的快照：优先用响应里的实时值，
  // 缓存里的 status.currentVersion 只作兜底（SW 侧已经用 reconcileStatus 对齐过一次，这是第二道保险）
  const current = (payload && payload.currentVersion) || (status && status.currentVersion) || '未知';

  const rows = [['当前版本', 'v' + current]];
  if (status && status.latestVersion) rows.push(['最新版本', 'v' + status.latestVersion]);
  rows.push(['上次检查', formatCheckTime(status && status.checkedAt)]);

  let html = '<div style="font-size:12px;margin:8px 0;">';
  for (const row of rows) {
    html += '<div style="display:flex;justify-content:space-between;gap:16px;padding:5px 0;border-bottom:1px solid var(--border-soft);">'
      + '<span style="color:var(--text-faint);">' + escapeHtml(row[0]) + '</span>'
      + '<span>' + escapeHtml(row[1]) + '</span></div>';
  }
  html += '</div>';

  const notice = (text, color) =>
    '<p style="font-size:12px;color:' + (color || 'var(--text-faint)') + ';margin:8px 0;">'
    + escapeHtml(text) + '</p>';

  // 「本次没查成」与「有新版本」是两件独立的事，必须各自呈现。以前写成 if/else if，
  // 于是只要上次的结论是「有更新」，失败提示就被吞掉，页面变成「当前版本 = 最新版本，
  // 却让你点『前往下载』」且完全不解释原因（2026-09-22 真机截图）。
  if (!status) {
    html += notice('尚未检查过更新。');
  } else {
    if (status.updateAvailable) {
      html += notice('发现新版本 v' + status.latestVersion + '，点击「前往下载」获取。', 'var(--accent,#2f6fed)');
    }
    if (status.error) {
      // 网络失败时保留上次成功的结果，只提示这次没查成
      html += notice('本次检查失败：' + status.error + '（上方显示的是上次成功的结果）');
    }
    if (!status.updateAvailable && !status.error) {
      html += notice('已是最新版本。');
    }
  }
  body.innerHTML = html;

  const btn = $('download-update-btn');
  if (!btn) return;
  const url = (status && (status.downloadUrl || status.releaseUrl)) || '';
  const ok = !!(status && status.updateAvailable && SAFE_RELEASE_URL.test(url));
  btn.style.display = ok ? '' : 'none';
  btn.dataset.url = ok ? url : '';
}

async function loadUpdateStatus() {
  try {
    renderUpdateStatus(await chrome.runtime.sendMessage({ type: 'GET_UPDATE_STATUS' }));
  } catch (e) {
    console.error('[Options] GET_UPDATE_STATUS failed:', e.message);
    renderUpdateStatus(null);
  }
}

async function handleCheckUpdates() {
  const btn = $('check-updates-btn');
  if (btn) btn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CHECK_UPDATES' });
    if (!resp || !resp.success) throw new Error((resp && resp.error) || '无法获取更新状态');
    renderUpdateStatus({ status: resp.status });
    showStatus(resp.status && resp.status.updateAvailable
      ? '发现新版本 v' + resp.status.latestVersion
      : '已是最新版本');
  } catch (e) {
    showStatus('检查更新失败：' + e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function handleDownloadUpdate() {
  const btn = $('download-update-btn');
  const url = (btn && btn.dataset && btn.dataset.url) || '';
  if (!SAFE_RELEASE_URL.test(url)) return;
  try {
    if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url: url });
    else window.open(url, '_blank');
  } catch { try { window.open(url, '_blank'); } catch { /* ignore */ } }
}

// 反馈优先走 Issues：别人能搜到同样的问题，模板会引导用户附上版本与日志；
// 邮件入口留在同一段里，给没有 GitHub 账号或不想公开讨论的人。
function handleOpenIssues(e) {
  if (e && e.preventDefault) e.preventDefault();
  const url = 'https://github.com/furina061006/MOOC_reminder/issues/new/choose';
  try {
    if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url: url });
    else window.open(url, '_blank');
  } catch { try { window.open(url, '_blank'); } catch { /* ignore */ } }
}

// ─── 已追踪课程 ────────────────────────────────────────
//
// 列出所有被追踪的课程，并允许「忽略」（停止追踪，保留记录）或「删除」（清掉课程
// 与它的作业记录）。语义差别在 HTML 的说明里写清楚了：删除后课可能被页面采集重新
// 加回来，想彻底不再出现要用忽略。

async function loadTrackedCourses() {
  const body = $('tracked-courses-body');
  if (!body) return;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_COURSE_LIST' });
    if (!resp || !resp.success) throw new Error((resp && resp.error) || '无法获取课程列表');
    const courses = Array.isArray(resp.courses) ? resp.courses : [];
    const ignored = new Set(resp.ignoredCourseIds || []);

    if (courses.length === 0) {
      body.innerHTML = '<p class="opt-sub" style="margin:8px 0 0;">还没有追踪任何课程。打开一门课程的学习页即可自动添加。</p>';
      return;
    }

    let html = '';
    for (const c of courses) {
      const isIgnored = ignored.has(c.courseId);
      const typeLabel = c.courseType === 'spoc' ? 'SPOC' : '普通';
      const title = escapeHtml(c.courseName || c.courseId);
      const sub = escapeHtml(
        c.courseId + ' · ' + typeLabel +
        ' · ' + c.unfinishedCount + ' 项未完成 / 共 ' + c.itemCount + ' 项'
      );
      html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-soft);' +
        (isIgnored ? 'opacity:.55;' : '') + '">' +
        '<div style="min-width:0;">' +
          '<div style="font-size:13px;word-break:break-all;">' + title +
            (isIgnored ? ' <span style="font-size:11px;color:var(--text-faint);">（已忽略）</span>' : '') + '</div>' +
          '<div style="font-size:11px;color:var(--text-faint);word-break:break-all;">' + sub + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-shrink:0;">' +
          '<button class="btn btn-sm btn-ghost tracked-ignore-btn" data-course-id="' + escapeHtml(c.courseId) +
            '" data-ignored="' + (isIgnored ? '1' : '0') + '">' + (isIgnored ? '恢复追踪' : '忽略') + '</button>' +
          '<button class="btn btn-sm btn-ghost btn-danger tracked-delete-btn" data-course-id="' + escapeHtml(c.courseId) +
            '"><span class="icon-slot" data-icon="trash" data-icon-size="12"></span>删除</button>' +
        '</div>' +
      '</div>';
    }
    body.innerHTML = html;
    // 内联的 data-icon 占位需要水合才会变成 SVG（icons.js 提供）
    try { if (window.MOOC_HYDRATE_ICONS) window.MOOC_HYDRATE_ICONS(body); } catch {}

    const ignoreBtns = body.querySelectorAll('.tracked-ignore-btn');
    for (let i = 0; i < ignoreBtns.length; i++) {
      ignoreBtns[i].addEventListener('click', async function () {
        const id = this.getAttribute('data-course-id');
        const nowIgnored = this.getAttribute('data-ignored') === '0';
        this.disabled = true;
        try {
          const r = await chrome.runtime.sendMessage({ type: 'TOGGLE_COURSE_IGNORE', courseId: id, ignored: nowIgnored });
          if (!r || !r.success) throw new Error((r && r.error) || '操作失败');
          currentSettings = r.settings || currentSettings;
          showStatus(nowIgnored ? '已忽略该课程' : '已恢复追踪');
          loadTrackedCourses();
        } catch (e) {
          showStatus('操作失败：' + e.message, true);
          this.disabled = false;
        }
      });
    }

    const deleteBtns = body.querySelectorAll('.tracked-delete-btn');
    for (let j = 0; j < deleteBtns.length; j++) {
      deleteBtns[j].addEventListener('click', async function () {
        const id = this.getAttribute('data-course-id');
        if (!window.confirm('删除「' + id + '」及其全部作业记录？\n\n（如果只是不想再追踪，用「忽略」更好 —— 删除后它可能被页面重新自动添加）')) return;
        this.disabled = true;
        try {
          const r = await chrome.runtime.sendMessage({ type: 'DELETE_COURSE', courseId: id });
          if (!r || !r.success) throw new Error((r && r.error) || '删除失败');
          showStatus('已删除该课程');
          loadTrackedCourses();
          loadMutedCourses();
        } catch (e) {
          showStatus('删除失败：' + e.message, true);
          this.disabled = false;
        }
      });
    }
  } catch (e) {
    body.innerHTML = '<p style="color:var(--overdue,#dc3545);font-size:12px;margin:8px 0;">加载失败：' + escapeHtml(String(e.message || e)) + '</p>';
  }
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
    var feedbackIssues = $('feedback-issues');
    if (feedbackIssues) feedbackIssues.addEventListener('click', handleOpenIssues);
  } catch(e) { console.error('[Options] error report init:', e.message); }
  try { loadMutedCourses(); } catch(e) { console.error('[Options] loadMutedCourses:', e.message); }
  try { loadTrackedCourses(); } catch(e) { console.error('[Options] loadTrackedCourses:', e.message); }
  try {
    loadNotificationDiagnostics();
  } catch(e) { console.error('[Options] notification diagnostics init:', e.message); }
  try {
    loadUpdateStatus();
    var checkUpdatesBtn = $('check-updates-btn');
    if (checkUpdatesBtn) checkUpdatesBtn.addEventListener('click', handleCheckUpdates);
    var downloadUpdateBtn = $('download-update-btn');
    if (downloadUpdateBtn) downloadUpdateBtn.addEventListener('click', handleDownloadUpdate);
  } catch(e) { console.error('[Options] update section init:', e.message); }
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
