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

  function parseLearnHref(href) {
    if (!href || typeof href !== 'string') return null;
    var m = href.match(/\/(?:spoc\/)?learn\/([^/?#]+)/i);
    if (!m) return null;
    var schoolCourseId;
    try { schoolCourseId = decodeURIComponent(m[1]); } catch { schoolCourseId = m[1]; }
    if (!/^[^-\s]+-[^-\s]+/.test(schoolCourseId)) return null;
    var tid = href.match(/[?&]tid=(\d+)/);
    if (!tid) return null;
    return {
      schoolCourseId: schoolCourseId,
      termId: tid[1],
      isSpoc: /\/spoc\/learn\//i.test(href)
    };
  }

  function harvest() {
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
        console.log('[MOOC Reminder] Discovered', found.length, 'course link(s)');
      } catch { /* SW asleep / context gone — fine, retried next load */ }
    }
  }

  // ─── BATCH_API_FETCH handler (runs on non-learn pages only; learn pages handled by main.js) ───
  chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'BATCH_API_FETCH') {
      // 如果在 learn 页面，main.js 已经处理 BATCH_API_FETCH，避免重复
      var isLearnPage = /\/(?:spoc\/)?learn\//i.test(location.pathname);
      if (isLearnPage) {
        // 仅补充当前页面课程到列表（如果缺失），但不重复发 API 请求
        try {
          var tid2 = new URL(location.href).searchParams.get('tid');
          var m2 = location.pathname.match(/\/(?:spoc\/)?learn\/([^/?#]+)/i);
          if (tid2 && m2) {
            var courseList2 = Array.isArray(msg.courses) ? msg.courses : [];
            var has2 = courseList2.some(function(c){ return c.courseId === m2[1]; });
            if (!has2 && courseList2.length === 0) {
              // storage 为空时补充当前课程，帮助 main.js 的 batchApiFetch 能取到数据
              // 但 main.js 自己也做这件事，所以这里只是额外保障
            }
          }
        } catch {}
        return false; // 让 main.js 处理
      }

      // 非 learn 页面（如 MOOC 首页）：由本脚本处理 BATCH_API_FETCH
      var courseList = Array.isArray(msg.courses) ? msg.courses : [];
      try {
        var tid = new URL(location.href).searchParams.get('tid');
        var m = location.pathname.match(/\/(?:spoc\/)?learn\/([^/?#]+)/i);
        if (tid && m) {
          var has = courseList.some(function(c){ return c.courseId === m[1]; });
          if (!has) {
            var pageName = '';
            try { var h = document.querySelector('h1, .course-name, [class*="courseTitle"], .m-coursename'); if (h) pageName = h.textContent.trim(); } catch {}
            if (!pageName) { try { pageName = document.title.replace(/[_-]\s*中国大学MOOC.*$/i, '').trim(); } catch {} }
            courseList.push({ courseId: m[1], termId: tid, courseName: pageName, schoolName: '' });
          }
        }
      } catch {}
      if (courseList.length === 0) return false;
      (async function() {
        var csrf = '';
        try { var c2 = document.cookie.match(/NTESSTUDYSI=([a-z0-9]+);?/i); csrf = c2 ? c2[1] : ''; } catch {}
        if (!csrf) { try { sendResponse([]); } catch {} return; }
        for (var i = 0; i < courseList.length; i++) {
          var c = courseList[i];
          if (!c || !c.termId) continue;
          try {
            var text = await new Promise(function(resolve, reject) {
              var xhr = new XMLHttpRequest();
              xhr.open('POST', 'https://www.icourse163.org/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey=' + encodeURIComponent(csrf), true);
              xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
              xhr.onload = function() { resolve(xhr.responseText); };
              xhr.onerror = function() { reject(); };
              xhr.send(JSON.stringify({ termId: parseInt(c.termId, 10) }));
            });
            if (text.length > 50) {
              chrome.runtime.sendMessage({ type: 'COURSE_API_DATA', course: { courseId: c.courseId, termId: c.termId, courseName: c.courseName || '', schoolName: c.schoolName || '' }, rawData: text }).catch(function(){});
            }
          } catch {}
        }
        try { sendResponse([]); } catch {}
      })();
      return true;
    }
    return false;
  });

  function start() {
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
