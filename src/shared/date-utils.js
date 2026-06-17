/**
 * Date parsing utilities for Chinese MOOC platform date formats.
 *
 * icourse163.org commonly displays dates in these formats:
 *   "2026年6月30日 23:59"
 *   "2026-06-30 23:59"
 *   "2026/06/30 23:59"
 *   "06月30日 23:59" (current year implied)
 *   "6月30日" (time omitted, defaults to 23:59:59)
 */

/**
 * Parse a Chinese date string to ISO 8601.
 * Returns null if parsing fails.
 *
 * @param {string} raw - The raw date string from the page
 * @returns {string|null} ISO 8601 datetime string, or null
 */
export function parseChineseDate(raw) {
  if (!raw || typeof raw !== 'string') return null;

  const trimmed = raw.trim();

  // Pattern 1: "2026年6月30日 23:59" or "2026年06月30日 23:59"
  let match = trimmed.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?\s*(\d{1,2}):(\d{2})/);
  if (match) {
    return formatISO(match[1], match[2], match[3], match[4], match[5]);
  }

  // Pattern 2: "2026-06-30 23:59" or "2026-06-30T23:59"
  match = trimmed.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s](\d{1,2}):(\d{2})/);
  if (match) {
    return formatISO(match[1], match[2], match[3], match[4], match[5]);
  }

  // Pattern 3: "6月30日 23:59" (no year — assume current year)
  match = trimmed.match(/(\d{1,2})月(\d{1,2})日?\s*(\d{1,2}):(\d{2})/);
  if (match) {
    const year = new Date().getFullYear().toString();
    return formatISO(year, match[1], match[2], match[3], match[4]);
  }

  // Pattern 4: "2026年6月30日" (date only, no time)
  match = trimmed.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (match) {
    return formatISO(match[1], match[2], match[3], '23', '59');
  }

  // Pattern 5: "2026-06-30" or "2026/06/30" (date only)
  match = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    return formatISO(match[1], match[2], match[3], '23', '59');
  }

  // Pattern 6: "6月30日" (month-day only, assume current year, 23:59)
  match = trimmed.match(/^(\d{1,2})月(\d{1,2})日?$/);
  if (match) {
    const year = new Date().getFullYear().toString();
    return formatISO(year, match[1], match[2], '23', '59');
  }

  // Pattern 7: Relative date "明天 23:59" or "后天 23:59"
  match = trimmed.match(/(明天|后天|今天)\s*(\d{1,2}):(\d{2})/);
  if (match) {
    const now = new Date();
    if (match[1] === '明天') now.setDate(now.getDate() + 1);
    if (match[1] === '后天') now.setDate(now.getDate() + 2);
    const h = match[2], m = match[3];
    now.setHours(parseInt(h), parseInt(m), 0, 0);
    return now.toISOString();
  }

  // If nothing matched, try native Date.parse as last resort
  const native = Date.parse(trimmed);
  if (!isNaN(native)) {
    return new Date(native).toISOString();
  }

  return null;
}

/**
 * Format date parts into ISO 8601 string (local timezone).
 */
function formatISO(year, month, day, hour, minute) {
  const y = parseInt(year);
  const mo = parseInt(month) - 1;
  const d = parseInt(day);
  const h = parseInt(hour);
  const m = parseInt(minute);

  const date = new Date(y, mo, d, h, m, 0, 0);

  // Return in local timezone ISO format
  // e.g., "2026-06-30T23:59:00+08:00"
  const pad = (n) => String(n).padStart(2, '0');
  const tzOffset = -date.getTimezoneOffset();
  const tzSign = tzOffset >= 0 ? '+' : '-';
  const tzHour = pad(Math.floor(Math.abs(tzOffset) / 60));
  const tzMin = pad(Math.abs(tzOffset) % 60);

  return `${y}-${pad(mo + 1)}-${pad(d)}T${pad(h)}:${pad(m)}:00${tzSign}${tzHour}:${tzMin}`;
}

/**
 * Format an ISO date string for display.
 * @param {string} isoString
 * @returns {string} Display-friendly format, e.g., "2026-06-30 23:59"
 */
export function formatDateForDisplay(isoString) {
  if (!isoString) return '无截止日期';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return isoString;
  }
}

/**
 * Get a relative time description in Chinese.
 * @param {string} isoString
 * @returns {string} e.g., "3天后截止", "已过期2天", "今天截止"
 */
export function getRelativeTimeDescription(isoString) {
  if (!isoString) return '';
  const now = new Date();
  const deadline = new Date(isoString);
  if (isNaN(deadline.getTime())) return '';

  const diffMs = deadline - now;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffMs < 0) {
    const overdue = Math.abs(diffDays);
    if (overdue === 0) return '今天已过期';
    return `已过期${overdue}天`;
  }

  if (diffDays === 0) {
    if (diffHours === 0) return '即将截止';
    return `${diffHours}小时后截止`;
  }

  if (diffDays === 1) return '明天截止';
  if (diffDays <= 7) return `${diffDays}天后截止`;
  return `${diffDays}天后截止`;
}
