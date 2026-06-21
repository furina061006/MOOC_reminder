/**
 * Popup runtime copy of src/shared/calendar.js.
 * Provides window.MOOC_GENERATE_ICS for exporting cached unfinished homework.
 */
(function () {
  'use strict';

  function escapeIcsText(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/\r?\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function toIcsDateTime(isoString) {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return null;
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }

  function getExportableItems(items) {
    return (Array.isArray(items) ? items : [])
      .filter(i => i && !i.checkedOff && i.deadline && toIcsDateTime(i.deadline))
      .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  }

  function makeCalendarUid(item) {
    return 'mooc-reminder-' + encodeURIComponent(item.uid || item.title || 'item') + '@local';
  }

  function generateHomeworkIcs(items, options) {
    options = options || {};
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
      const summary = '[' + (item.courseName || 'MOOC') + '] ' + (item.title || '未命名作业');
      const desc = [
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
        'DESCRIPTION:' + escapeIcsText(desc),
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

  window.MOOC_GENERATE_ICS = generateHomeworkIcs;
  window.MOOC_EXPORTABLE_ITEMS = getExportableItems;
})();
