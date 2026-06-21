/**
 * Calendar export + daily digest helpers (pure functions).
 *
 * Runtime note: popup/service-worker use plain scripts, so equivalent logic is
 * duplicated there. Keep this tested module in sync with those runtime copies.
 */

export function escapeIcsText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function pad(n) { return String(n).padStart(2, '0'); }

export function toIcsDateTime(isoString) {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return null;
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}

export function makeCalendarUid(item) {
  return 'mooc-reminder-' + encodeURIComponent(item.uid || item.title || 'item') + '@local';
}

export function getExportableItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter(i => i && !i.checkedOff && i.deadline && toIcsDateTime(i.deadline))
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
}

export function generateHomeworkIcs(items, options = {}) {
  const now = toIcsDateTime(options.now || new Date().toISOString());
  const exportable = getExportableItems(items);
  const alarmMinutes = typeof options.alarmMinutes === 'number' ? options.alarmMinutes : 60;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MOOC Reminder//Homework Calendar//ZH-CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:MOOC Reminder 作业截止'
  ];

  for (const item of exportable) {
    const due = toIcsDateTime(item.deadline);
    const summary = `[${item.courseName || 'MOOC'}] ${item.title || '未命名作业'}`;
    const description = [
      item.schoolName ? '学校：' + item.schoolName : '',
      item.type ? '类型：' + item.type : '',
      item.pageUrl ? '页面：' + item.pageUrl : ''
    ].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      'UID:' + makeCalendarUid(item),
      'DTSTAMP:' + now,
      'DTSTART:' + due,
      'DTEND:' + due,
      'SUMMARY:' + escapeIcsText(summary),
      'DESCRIPTION:' + escapeIcsText(description),
      'BEGIN:VALARM',
      'TRIGGER:-PT' + Math.max(1, Math.round(alarmMinutes)) + 'M',
      'ACTION:DISPLAY',
      'DESCRIPTION:' + escapeIcsText(summary + ' 即将截止'),
      'END:VALARM',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export function getDigestItems(items, now, horizonHours = 48) {
  const ts = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const horizon = ts + horizonHours * 60 * 60 * 1000;
  return (Array.isArray(items) ? items : [])
    .filter(item => {
      if (!item || item.checkedOff || !item.deadline) return false;
      const due = new Date(item.deadline).getTime();
      return !isNaN(due) && due <= horizon;
    })
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
}

export function formatDigestMessage(items, now, limit = 3) {
  const digestItems = getDigestItems(items, now);
  if (digestItems.length === 0) return null;
  const shown = digestItems.slice(0, limit).map(item => {
    const due = new Date(item.deadline);
    const overdue = due < now;
    const day = pad(due.getMonth() + 1) + '/' + pad(due.getDate()) + ' ' + pad(due.getHours()) + ':' + pad(due.getMinutes());
    return (item.courseName || 'MOOC') + ' · ' + (item.title || '未命名作业') + (overdue ? '（已过期）' : '（' + day + '）');
  });
  const more = digestItems.length > shown.length ? `，另有 ${digestItems.length - shown.length} 项` : '';
  return shown.join('；') + more;
}
