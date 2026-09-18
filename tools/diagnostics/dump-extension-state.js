/* global copy */
/**
 * 扩展存储诊断脚本 —— 在**扩展自己的** Service Worker Console 里运行。
 *
 * 打开方式：chrome://extensions → 找到 MOOC Reminder → 点「Service Worker」。
 * 注意：网页的 Console 里没有 chrome.storage，必须用这个入口。
 *
 * 用途：当怀疑「某门课的条目没抓到」时，先看扩展**现在到底存了什么**。
 * 它能一次回答：
 *   - 症状确认：那些条目在不在 `homework_items` 里
 *   - 扩展用的是哪个 termId（分组键里有 tid）
 *   - 课程记录的 termId / activeTermId / courseType / pageUrl（可顺带验证 SPOC 路由修复）
 *
 * 输出很短（每门课一行分组 + 条目名），同时复制到剪贴板。
 */
chrome.storage.local.get(['homework_items', 'courses']).then(function (d) {
  var items = d.homework_items || [];
  var groups = {};
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    var key = it.courseId + ' | tid' + it.termId + ' | ' + (it.courseType || '-');
    if (!groups[key]) groups[key] = [];
    groups[key].push((it.title || '').slice(0, 40) +
      (it.checkedOff ? ' [已完成]' : '') +
      ' (ch' + (it.chapterId || '') + '/hw' + (it.homeworkId || '') + ')');
  }
  var out = {
    courses: (d.courses || []).map(function (c) {
      return {
        courseId: c.courseId,
        termId: c.termId,
        activeTermId: c.activeTermId,
        courseType: c.courseType,
        name: c.courseName,
        pageUrl: c.pageUrl
      };
    }),
    itemGroups: groups,
    totalItems: items.length,
    lastSync: d.last_sync
  };
  var text = JSON.stringify(out, null, 1);
  console.log(text);
  try { copy(text); } catch { /* ignore */ }
  return out.totalItems;
});
