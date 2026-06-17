/**
 * Popup UI Logic — MOOC Reminder
 *
 * Handles:
 *   - Loading homework data from background
 *   - Rendering course-grouped homework list
 *   - Manual check-off interaction
 *   - Filtering and sorting
 *   - Refresh trigger
 *   - Summary statistics
 */

// ─── State ─────────────────────────────────────────────
const state = {
  items: [],           // unfinished items (for display)
  allItems: [],        // all items including completed
  courses: [],
  lastSync: null,
  filter: 'unfinished',
  sortBy: 'deadline',
  collapsedCourses: new Set()
};

// ─── DOM References ────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  homeworkList: $('#homework-list'),
  emptyState: $('#empty-state'),
  loginWarning: $('#login-warning'),
  refreshBtn: $('#refresh-btn'),
  emptyRefreshBtn: $('#empty-refresh-btn'),
  clearCompletedBtn: $('#clear-completed-btn'),
  filterSelect: $('#filter-select'),
  sortSelect: $('#sort-select'),
  totalCount: $('#total-count'),
  syncTime: $('#sync-time'),
  countOverdue: $('#count-overdue'),
  countSoon: $('#count-soon'),
  countNormal: $('#count-normal')
};

// ─── Initialization ────────────────────────────────────

async function init() {
  setupEventListeners();
  await loadData();
  render();
}

function setupEventListeners() {
  // Refresh button
  dom.refreshBtn.addEventListener('click', handleRefresh);
  dom.emptyRefreshBtn.addEventListener('click', handleRefresh);

  // Clear completed
  dom.clearCompletedBtn.addEventListener('click', handleClearCompleted);

  // Filter & Sort
  dom.filterSelect.addEventListener('change', (e) => {
    state.filter = e.target.value;
    render();
  });

  dom.sortSelect.addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    render();
  });
}

// ─── Data Loading ──────────────────────────────────────

async function loadData() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_HOMEWORK' });

    if (response) {
      state.allItems = response.allItems || [];
      state.courses = response.courses || [];
      state.lastSync = response.lastSync;
    }
  } catch (e) {
    console.error('[MOOC Reminder] Failed to load data:', e);
  }

  // Apply filter
  applyFilter();
}

function applyFilter() {
  switch (state.filter) {
    case 'all':
      state.items = [...state.allItems];
      break;
    case 'overdue':
      state.items = state.allItems.filter(i => !i.checkedOff && isOverdue(i));
      break;
    case 'unfinished':
    default:
      state.items = state.allItems.filter(i => !i.checkedOff);
      break;
  }

  // Apply sort
  sortItems();
}

function sortItems() {
  switch (state.sortBy) {
    case 'deadline':
      state.items.sort((a, b) => {
        if (!a.deadline && !b.deadline) return 0;
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return new Date(a.deadline) - new Date(b.deadline);
      });
      break;
    case 'course':
      state.items.sort((a, b) => {
        const cn = (a.courseName || '').localeCompare(b.courseName || '');
        if (cn !== 0) return cn;
        if (!a.deadline && !b.deadline) return 0;
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return new Date(a.deadline) - new Date(b.deadline);
      });
      break;
    case 'added':
      state.items.sort((a, b) => {
        return new Date(b.firstSeen || 0) - new Date(a.firstSeen || 0);
      });
      break;
  }
}

// ─── Rendering ─────────────────────────────────────────

function render() {
  if (state.items.length === 0) {
    dom.homeworkList.style.display = 'none';
    dom.emptyState.style.display = 'block';
    dom.loginWarning.style.display = 'none';
  } else {
    dom.homeworkList.style.display = 'block';
    dom.emptyState.style.display = 'none';
    dom.loginWarning.style.display = 'none';
  }

  // Group items by course
  const grouped = groupByCourse(state.items);

  // Render
  dom.homeworkList.innerHTML = '';
  for (const [courseId, items] of Object.entries(grouped)) {
    const course = state.courses.find(c => c.courseId === courseId) || {
      courseId,
      courseName: items[0]?.courseName || '未知课程',
      schoolName: items[0]?.schoolName || ''
    };
    dom.homeworkList.appendChild(createCourseGroup(course, items));
  }

  // Update summary
  updateSummary();
  updateFooter();
}

function groupByCourse(items) {
  const groups = {};
  for (const item of items) {
    const key = item.courseId || '__unknown__';
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

function createCourseGroup(course, items) {
  const isCollapsed = state.collapsedCourses.has(course.courseId);

  const group = document.createElement('div');
  group.className = `course-group${isCollapsed ? ' collapsed' : ''}`;
  group.dataset.courseId = course.courseId;

  // Header
  const header = document.createElement('div');
  header.className = 'course-group-header';
  header.innerHTML = `
    <div class="course-group-title">
      <span class="course-group-arrow">▼</span>
      <span>${escapeHtml(course.courseName)}</span>
      ${course.schoolName ? `<span style="font-weight:400;font-size:11px;color:#999;">${escapeHtml(course.schoolName)}</span>` : ''}
    </div>
    <span class="course-group-count">${items.length} 项</span>
  `;
  header.addEventListener('click', () => {
    group.classList.toggle('collapsed');
    if (group.classList.contains('collapsed')) {
      state.collapsedCourses.add(course.courseId);
    } else {
      state.collapsedCourses.delete(course.courseId);
    }
  });

  // Items container
  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'course-group-items';

  for (const item of items) {
    itemsContainer.appendChild(createHomeworkItem(item));
  }

  group.appendChild(header);
  group.appendChild(itemsContainer);
  return group;
}

function createHomeworkItem(item) {
  const urgency = getUrgency(item);
  const isDone = item.checkedOff;

  const itemEl = document.createElement('div');
  itemEl.className = `homework-item urgency-${urgency}${isDone ? ' completed' : ''}`;
  itemEl.dataset.uid = item.uid;

  // Checkbox
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'item-checkbox';
  checkbox.checked = isDone;
  checkbox.addEventListener('change', () => handleCheckOff(item.uid, checkbox.checked));

  // Content
  const content = document.createElement('div');
  content.className = 'item-content';

  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = item.title;

  const meta = document.createElement('div');
  meta.className = 'item-meta';

  // Type badge
  const typeBadge = document.createElement('span');
  typeBadge.className = `item-type ${item.type || 'homework'}`;
  typeBadge.textContent = typeLabel(item.type);

  // Deadline
  const deadline = document.createElement('span');
  deadline.className = `item-deadline ${urgency === 'overdue' ? 'overdue' : urgency === 'soon' ? 'soon' : ''}`;
  deadline.textContent = item.deadline
    ? formatDeadline(item.deadline, urgency)
    : '无截止日期';

  meta.appendChild(typeBadge);
  meta.appendChild(deadline);

  // Completion reason badge
  if (item.checkedOff && item.completionReason) {
    const badge = document.createElement('span');
    badge.className = `item-completion-badge ${item.completionReason}`;
    badge.textContent = item.completionReason === 'manual' ? '手动标记' : '自动检测';
    meta.appendChild(badge);
  }

  content.appendChild(title);
  content.appendChild(meta);

  itemEl.appendChild(checkbox);
  itemEl.appendChild(content);

  return itemEl;
}

function updateSummary() {
  const unfinished = state.allItems.filter(i => !i.checkedOff);
  const overdue = unfinished.filter(i => isOverdue(i)).length;
  const soon = unfinished.filter(i => !isOverdue(i) && isDueWithin(i, 48)).length;
  const normal = unfinished.filter(i => !isOverdue(i) && !isDueWithin(i, 48)).length;

  dom.countOverdue.textContent = overdue;
  dom.countSoon.textContent = soon;
  dom.countNormal.textContent = normal;
}

function updateFooter() {
  const unfinished = state.allItems.filter(i => !i.checkedOff).length;
  dom.totalCount.textContent = `共 ${unfinished} 项未完成`;

  if (state.lastSync) {
    const d = new Date(state.lastSync);
    const pad = (n) => String(n).padStart(2, '0');
    dom.syncTime.textContent = `上次同步: ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } else {
    dom.syncTime.textContent = '尚未同步';
  }
}

// ─── Actions ───────────────────────────────────────────

async function handleCheckOff(uid, checked) {
  try {
    await chrome.runtime.sendMessage({
      type: 'MARK_COMPLETED',
      homeworkUid: uid,
      checkedOff: checked
    });

    // Update local state optimistically
    const item = state.allItems.find(i => i.uid === uid);
    if (item) {
      item.checkedOff = checked;
      item.manuallyCheckedOff = checked;
      item.completionReason = checked ? 'manual' : null;
    }

    // Re-apply filter and re-render
    applyFilter();
    render();

    // Also refresh badge
    chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
  } catch (e) {
    console.error('[MOOC Reminder] Check-off failed:', e);
  }
}

async function handleRefresh() {
  dom.refreshBtn.classList.add('spinning');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'TRIGGER_SCRAPE' });

    if (response && response.success) {
      await loadData();
      render();
    } else if (response && response.error) {
      showToast(response.error);
    }
  } catch (e) {
    showToast('刷新失败: ' + e.message);
  } finally {
    dom.refreshBtn.classList.remove('spinning');
  }
}

async function handleClearCompleted() {
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_COMPLETED' });
    await loadData();
    render();
  } catch (e) {
    console.error('[MOOC Reminder] Clear completed failed:', e);
  }
}

// ─── Utility Functions ─────────────────────────────────

function isOverdue(item) {
  if (!item.deadline) return false;
  try {
    return new Date(item.deadline) < new Date();
  } catch {
    return false;
  }
}

function isDueWithin(item, hours) {
  if (!item.deadline) return false;
  try {
    const now = new Date();
    const deadline = new Date(item.deadline);
    if (deadline < now) return false;
    return (deadline - now) <= hours * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function getUrgency(item) {
  if (item.checkedOff) return 'normal';
  if (isOverdue(item)) return 'overdue';
  if (isDueWithin(item, 48)) return 'soon';
  return 'normal';
}

function typeLabel(type) {
  const labels = {
    homework: '作业',
    quiz: '测验',
    exam: '考试',
    discussion: '讨论'
  };
  return labels[type] || '作业';
}

function formatDeadline(isoString, urgency) {
  try {
    const d = new Date(isoString);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');

    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    // Relative description
    const diffMs = d - now;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

    let relative = '';
    if (diffMs < 0) {
      const overdueDays = Math.abs(diffDays);
      relative = overdueDays === 0 ? '今天已过期' : `${overdueDays}天前过期`;
    } else if (diffDays === 0) {
      relative = diffHours === 0 ? '即将截止' : `${diffHours}小时后`;
    } else if (diffDays === 1) {
      relative = '明天截止';
    } else if (diffDays <= 7) {
      relative = `${diffDays}天后`;
    } else {
      relative = dateStr;
    }

    return `${relative} (${dateStr} ${timeStr})`;
  } catch {
    return isoString || '';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message) {
  // Simple toast implementation
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 50px;
    left: 50%;
    transform: translateX(-50%);
    background: #333;
    color: #fff;
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 12px;
    z-index: 100;
    opacity: 0;
    transition: opacity 0.3s;
  `;

  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  });
}

// ─── Boot ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
