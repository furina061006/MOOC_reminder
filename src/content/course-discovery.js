/**
 * Course-discovery content script — MOOC Reminder
 *
 * Runs on ALL icourse163.org pages (not just /learn/). Its only job is to
 * harvest the user's course links — anchors of the form
 *   /learn/{school-courseId}?tid={termId}   (and /spoc/learn/...)
 * — which appear on the MOOC homepage / personal center "我的课程" panel and
 * elsewhere. Each link yields the SAME canonical identity the homework scraper
 * uses, so the background can now know about EVERY enrolled course and refresh
 * its homework in the background (via the API) without the user having to open
 * each course's quiz page.
 *
 * This is intentionally tiny and defensive: it never scrapes homework, only
 * reports discovered {courseId, termId, courseName} triples.
 *
 * Plain content script (not a module) for executeScript compatibility.
 */
(function () {
  'use strict';

  var reported = {}; // schoolCourseId|termId -> true, dedup within this page

  // 学习页不采集锚点。两个理由，都是实测踩出来的：
  //  1. 课程页上的 `/learn/` 锚点不是「我的课程」——它们是**源课程**与**章节内容**链接
  //     （SPOC 页尤其明显，页面把源课程内容并排渲染出来）。采集它们会把用户根本没选的
  //     课程登记进来，甚至把**章节名当成课程名**（2026-09-20 用户报「没选过的大学物理
  //     （力学、电磁学）被自动抓取」；2026-09-23 又出现 courseId=大学物理、
  //     name=『牛顿第二定律』、类型=普通的幽灵课程）。
  //  2. 学习页上 main.js 也在监听 REQUEST_COURSE_LINKS，而且**谁先 sendResponse 谁赢**。
  //     这里同步应答会抢走 main.js 的「自报本页身份」，让那条通路（清空数据后唯一的
  //     自救路径）失效。所以这里必须**完全不参与**学习页，连探测都不回。
  // 本页自己的课程由 main.js 自报；其它课程靠「我的课程」页这类锚点最全的页面采集。
  function isLearnPage() {
    try { return /\/(?:spoc\/)?learn\//i.test(location.pathname); } catch { return false; }
  }

  function parseLearnHref(href) {
    if (!href || typeof href !== 'string') return null;
    var m = href.match(/\/(?:spoc\/)?learn\/([^/?#]+)/i);
    if (!m) return null;
    var schoolCourseId;
    try { schoolCourseId = decodeURIComponent(m[1]); } catch { schoolCourseId = m[1]; }
    if (!/^[^-\s]+-[^-\s]+/.test(schoolCourseId)) return null;
    var tid = href.match(/[?&]tid=(\d+)/);
    if (!tid) return null;
    if (isContentDetailHref(href)) return null;
    return {
      schoolCourseId: schoolCourseId,
      termId: tid[1],
      isSpoc: /\/spoc\/learn\//i.test(href)
    };
  }

  // 内容详情链接不是课程链接：`#/learn/forumdetail?pid=…`（论坛帖）、`#/learn/forum?cid=…`
  // 等指向课程内部的某条内容，**锚点文本一定是那条内容的名字**。
  // 2026-09-23 真实 DOM（/home.htm#/home/spocCourse）：页面右侧「最近发表」的 5 条帖子链接
  // 全部带 ?tid=1476735472 并指向 /learn/NEU-1474956162，于是被登记成一条
  // courseId=SPOC 大学物理、名字=帖子标题「牛顿第二定律」、类型=普通的幽灵课程
  // （按 courseId|termId 去重，所以名字取了 DOM 里第一条帖子）。
  // 这个守卫与 src/shared/icourse163-api.js 的同名函数保持一致。
  function isContentDetailHref(href) {
    var fragment = String(href).split('#')[1] || '';
    return /forum|detail/i.test(fragment);
  }

  // force=true 会清掉本次页面加载的去重记录，用于 SW 要求重新上报
  // （用户在设置页清空数据/删除课程后，已打开的页面否则永远不会再上报）。
  function harvest(force) {
    if (force) reported = {};
    var anchors = document.querySelectorAll('a[href*="/learn/"]');
    var found = [];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var meta = parseLearnHref(a.getAttribute('href') || a.href || '');
      if (!meta) continue;
      var key = meta.schoolCourseId + '|' + meta.termId;
      if (reported[key]) continue;
      reported[key] = true;
      // Course name: nearest non-empty text on/around the link.
      var name = (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
      if (name.length > 60) name = name.slice(0, 60);
      found.push({
        courseId: meta.schoolCourseId,
        termId: meta.termId,
        courseName: name,
        courseType: meta.isSpoc ? 'spoc' : 'mooc'
      });
    }
    if (found.length > 0) {
      try {
        chrome.runtime.sendMessage({ type: 'COURSE_LINKS', courses: found });
        var spocCount = found.filter(function(c){ return c.courseType === 'spoc'; }).length;
        console.log('[MOOC Reminder] Discovered', found.length, 'course link(s), SPOC:', spocCount);
        if (spocCount > 0) {
          console.log('[MOOC Reminder] SPOC courses:', found.filter(function(c){ return c.courseType === 'spoc'; }).map(function(c){ return c.courseId + ' (' + c.courseName + ')'; }));
        }
      } catch { /* SW asleep / context gone — fine, retried next load */ }
    }
  }

  // This script deliberately does NOT handle BATCH_API_FETCH.
  //
  // It used to answer that message on non-learn pages, reading the CSRF token
  // from document.cookie. That could never work — NTESSTUDYSI is HttpOnly — and
  // it is unreachable now anyway: the service worker only sends BATCH_API_FETCH
  // to /learn/ or /spoc/learn/ tabs, or to a temporary proxy tab navigated to a
  // learn URL (where main.js owns the message). The broken branch was removed
  // instead of being left in place as a silent return-empty fallback.

  // 数据被清空后，SW 会要求已打开的学习页重新上报课程链接（见 service-worker
  // 的 askOpenPagesToReport，每轮抓取都会问一次）。没有这个入口，用户就必须手动
  // 刷新页面。
  //
  // 学习页上**故意不处理**这条消息（返回 false 且不应答）：那里的课程由 main.js
  // 自报（见 isLearnPage 的注释）；在这里应答只会抢走它的 sendResponse。
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.type !== 'REQUEST_COURSE_LINKS') return false;
      if (isLearnPage()) return false;
      try { harvest(true); } catch { /* ignore */ }
      try { sendResponse({ success: true }); } catch { /* ignore */ }
      return false;
    });
  } catch { /* ignore */ }

  function start() {
    if (isLearnPage()) return; // 学习页交给 main.js，连 MutationObserver 都不装
    harvest();
    // The homepage renders the course panel asynchronously; re-harvest as the
    // DOM settles, then stop after a short window to stay cheap.
    var observer = new MutationObserver(function () { harvest(); });
    try { observer.observe(document.body, { childList: true, subtree: true }); } catch { /* no body yet */ }
    setTimeout(function () { try { observer.disconnect(); } catch { /* ignore */ } }, 8000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
