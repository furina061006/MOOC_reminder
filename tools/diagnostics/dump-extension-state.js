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
 *   - 课程是不是被忽略了、最近的错误是什么
 *   - **每个 icourse163 标签页的存活状态**：`discarded: true` 表示该页已被浏览器
 *     卸载（内存节省器 / 标签页冻结）；`answered: false` 表示它**现在**不响应消息
 *     （被冻结、已卸载，或页面早于上次扩展重载）。
 *     这类页面**没有可用的内容脚本**：既不能上报自己的课程（课程因此登记不上），
 *     也不能接手批量抓取。它们只要变回当前标签页就会自动重新加载 —— 这正是
 *     「不切到那个页面就抓不到」的机制。
 *
 * 侧效：探测用的 `REQUEST_COURSE_LINKS` 会让**能应答**的页面重新登记自己的课程，
 * 所以它同时也是一次手动「重新发现」。`answered` 是探测**之后**的课程数量。
 *
 * 输出很短（每门课一行分组 + 条目名），同时复制到剪贴板。
 */
(async function () {
  function withTimeout(promise, ms) {
    var timer;
    return Promise.race([
      promise,
      new Promise(function (_resolve, reject) {
        timer = setTimeout(function () { reject(new Error('timeout')); }, ms);
      })
    ]).finally(function () { clearTimeout(timer); });
  }

  function groupItems(items) {
    var groups = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var key = it.courseId + ' | tid' + it.termId + ' | ' + (it.courseType || '-');
      if (!groups[key]) groups[key] = [];
      groups[key].push((it.title || '').slice(0, 40) +
        (it.checkedOff ? ' [已完成]' : '') +
        ' (ch' + (it.chapterId || '') + '/hw' + (it.homeworkId || '') + ')');
    }
    return groups;
  }

  function courseRows(courses) {
    return (courses || []).map(function (c) {
      return {
        courseId: c.courseId,
        termId: c.termId,
        activeTermId: c.activeTermId,
        courseType: c.courseType,
        name: c.courseName,
        pageUrl: c.pageUrl
      };
    });
  }

  try {
    var tabs = await chrome.tabs.query({ url: 'https://www.icourse163.org/*' });

    // 逐个页面探测（并行），1.5 秒不应答就是「这个页面帮不上忙」
    var probes = await Promise.all((tabs || []).map(async function (t) {
      var answered = false;
      try {
        await withTimeout(chrome.tabs.sendMessage(t.id, { type: 'REQUEST_COURSE_LINKS' }), 1500);
        answered = true;
      } catch { /* 冻结 / 已卸载 / 没有内容脚本 */ }
      return {
        id: t.id,
        active: t.active === true,
        discarded: t.discarded === true,
        status: t.status || '',
        windowId: t.windowId,
        answered: answered,
        url: String(t.url || '').slice(0, 90)
      };
    }));

    var d = await chrome.storage.local.get([
      'homework_items', 'courses', 'sync_errors', 'user_settings',
      'last_sync', 'temporary_proxy_job', 'scrape_status'
    ]);
    var out = {
      courses: courseRows(d.courses),
      icourseTabs: probes,
      ignoredCourseIds: (d.user_settings && d.user_settings.ignoredCourseIds) || [],
      temporaryProxyJob: d.temporary_proxy_job
        ? { id: d.temporary_proxy_job.id, tabId: d.temporary_proxy_job.tabId, phase: d.temporary_proxy_job.phase }
        : null,
      scrapeStatus: d.scrape_status || null,
      // 最近 5 条错误：抓取跳过 / 超时 / 无内容脚本都会记在这里
      syncErrors: (d.sync_errors || []).slice(-5),
      itemGroups: groupItems(d.homework_items || []),
      totalItems: (d.homework_items || []).length,
      lastSync: d.last_sync
    };
    var text = JSON.stringify(out, null, 1);
    console.log(text);
    console.table(probes);
    try { copy(text); } catch { /* ignore */ }
  } catch (e) {
    console.error('[diagnostics] dump failed:', e);
  }
})();
