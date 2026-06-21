/**
 * Options page logic — MOOC Reminder
 *
 * Loads user_settings, renders the form, and on save sends SETTINGS_UPDATED to
 * the background, which normalizes/persists the settings and re-applies the
 * alarm cadence. These settings used to be stored but never read.
 */

const LEAD_CHOICES = [72, 48, 24, 12, 6, 2]; // hours
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
  dailyDigestHour: 8
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

function populate(settings) {
  const s = Object.assign({}, DEFAULTS, settings || {});
  $('check-interval').value = s.checkIntervalMinutes;
  $('badge-interval').value = s.badgeRefreshMinutes;
  $('auto-detect').checked = s.autoDetectEnabled !== false;
  $('notify-enabled').checked = s.notificationsEnabled !== false;
  $('notify-overdue').checked = s.notifyOverdue !== false;
  $('quiet-enabled').checked = s.quietHoursEnabled === true;
  $('quiet-start').value = String(s.quietStart);
  $('quiet-end').value = String(s.quietEnd);
  $('digest-enabled').checked = s.dailyDigestEnabled === true;
  $('digest-hour').value = String(s.dailyDigestHour);
  const leads = Array.isArray(s.notifyLeadHours) ? s.notifyLeadHours : DEFAULTS.notifyLeadHours;
  for (const h of LEAD_CHOICES) {
    const cb = $('lead-' + h);
    if (cb) cb.checked = leads.indexOf(h) >= 0;
  }
}

function collect() {
  const leads = [];
  for (const h of LEAD_CHOICES) {
    const cb = $('lead-' + h);
    if (cb && cb.checked) leads.push(h);
  }
  return {
    checkIntervalMinutes: parseInt($('check-interval').value, 10),
    badgeRefreshMinutes: parseInt($('badge-interval').value, 10),
    autoDetectEnabled: $('auto-detect').checked,
    notificationsEnabled: $('notify-enabled').checked,
    notifyLeadHours: leads,
    notifyOverdue: $('notify-overdue').checked,
    quietHoursEnabled: $('quiet-enabled').checked,
    quietStart: parseInt($('quiet-start').value, 10),
    quietEnd: parseInt($('quiet-end').value, 10),
    dailyDigestEnabled: $('digest-enabled').checked,
    dailyDigestHour: parseInt($('digest-hour').value, 10)
  };
}

function showStatus(text, isError) {
  const el = $('save-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--overdue)' : '#25703a';
  if (text) {
    setTimeout(function () { try { el.textContent = ''; } catch { /* ignore */ } }, 2500);
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
  const settings = collect();
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', settings: settings });
    if (resp && resp.success) {
      populate(resp.settings); // reflect normalized/clamped values
      showStatus('已保存');
    } else {
      showStatus('保存失败', true);
    }
  } catch (e) {
    console.error('[Options] save failed:', e.message);
    showStatus('保存失败：' + e.message, true);
  }
}

async function init() {
  buildLeadChips();
  buildHourSelect($('quiet-start'));
  buildHourSelect($('quiet-end'));
  buildHourSelect($('digest-hour'));
  if (window.MOOC_HYDRATE_ICONS) window.MOOC_HYDRATE_ICONS();
  const settings = await loadSettings();
  populate(settings);
  const saveBtn = $('save-btn');
  if (saveBtn) saveBtn.addEventListener('click', save);
}

document.addEventListener('DOMContentLoaded', function () {
  init().catch(function (e) { console.error('[Options] init failed:', e.message); });
});
