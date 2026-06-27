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
        var spocCount = found.filter(function(c){ return c.courseType === 'spoc'; }).length;
        console.log('[MOOC Reminder] Discovered', found.length, 'course link(s), SPOC:', spocCount);
        if (spocCount > 0) {
          console.log('[MOOC Reminder] SPOC courses:', found.filter(function(c){ return c.courseType === 'spoc'; }).map(function(c){ return c.courseId + ' (' + c.courseName + ')'; }));
        }
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
        var isSpocPage = /\/spoc\/learn\//i.test(location.href);
        for (var i = 0; i < courseList.length; i++) {
          var c = courseList[i];
          if (!c || !c.termId) continue;
          var courseIsSpoc = isSpocPage || (c.courseType === 'spoc');
          try {
            // ═══ API 端点链式 fallback（同 main.js batchApiFetch）═══
            var text = null;
            var csrfK = encodeURIComponent(csrf);
            var tId = encodeURIComponent(c.termId);

            // 辅助：Promise-based XHR
            function xhrFetch(url, ct, body) {
              return new Promise(function(resolve, reject) {
                var x = new XMLHttpRequest();
                x.open('POST', url, true);
                if (ct) x.setRequestHeader('Content-Type', ct);
                x.onload = function() { resolve(x.responseText); };
                x.onerror = function() { reject(); };
                x.send(body);
              });
            }

            // 1) getMocTermDto.rpc + gatewayType=3
            try {
              text = await xhrFetch(
                'https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=' + csrfK,
                'application/x-www-form-urlencoded;charset=UTF-8',
                'termId=' + tId + '&gatewayType=3');
              if (courseIsSpoc) console.log('[MOOC Reminder] disc EP1 +gw3: len=' + text.length);
              if (text.length < 100 || /"code":-/.test(text)) text = null;
            } catch(e) { text = null; }

            // 2) getMocTermDto.rpc 不带 gatewayType
            if (!text) { try {
              text = await xhrFetch(
                'https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=' + csrfK,
                'application/x-www-form-urlencoded;charset=UTF-8',
                'termId=' + tId);
              if (courseIsSpoc) console.log('[MOOC Reminder] disc EP2 no-gw: len=' + text.length);
              if (text.length < 100 || /"code":-/.test(text)) text = null;
            } catch(e) { text = null; }}

            // 3) DWR endpoint
            if (!text) { try {
              text = await xhrFetch(
                'https://www.icourse163.org/dwr/call/plaincall/CourseBean.getMocTermDto.dwr',
                'text/plain;charset=UTF-8',
                ['callCount=1', 'scriptSessionId=', 'httpSessionId=', 'c0-scriptName=CourseBean', 'c0-methodName=getMocTermDto', 'c0-id=0', 'c0-param0=number:' + tId, 'c0-param1=boolean:true', 'batchId=0'].join('\n'));
              console.log('[MOOC Reminder] disc EP3 DWR: len=' + text.length);
              if (text.length < 100 || /exception|forbidden|非法跨域/i.test(text)) text = null;
            } catch(e) { text = null; }}

            // 4) getMocTermDto.rpc + courseId
            if (!text && courseIsSpoc) { try {
              text = await xhrFetch(
                'https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=' + csrfK,
                'application/x-www-form-urlencoded;charset=UTF-8',
                'termId=' + tId + '&courseId=' + encodeURIComponent(c.courseId || ''));
              console.log('[MOOC Reminder] disc EP4 +courseId: len=' + text.length);
              if (text.length < 100 || /"code":-/.test(text)) text = null;
            } catch(e) { text = null; }}

            // 5) getMocTermDto.rpc + JSON body
            if (!text) { try {
              text = await xhrFetch(
                'https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=' + csrfK,
                'application/json;charset=UTF-8',
                JSON.stringify({ termId: parseInt(c.termId, 10) }));
              console.log('[MOOC Reminder] disc EP5 JSON: len=' + text.length);
              if (text.length < 100 || /"code":-/.test(text)) text = null;
            } catch(e) { text = null; }}

            // 6) fallback: getLastLearnedMocTermDto.rpc (JSON)
            if (!text) { try {
              text = await xhrFetch(
                'https://www.icourse163.org/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey=' + csrfK,
                'application/json;charset=UTF-8',
                JSON.stringify({ termId: parseInt(c.termId, 10) }));
              console.log('[MOOC Reminder] disc EP6 LastLearned: len=' + text.length);
            } catch(e) { text = null; }}

            if (text && text.length > 50) {
              // SPOC: 尝试从 DOM 读取真实 termId，避免用假 termId 构造错误 UID
              var effectiveTermId = c.termId;
              try { var realTid = document.documentElement.getAttribute('data-mooc-real-termid'); if (realTid) effectiveTermId = realTid; } catch(e) {}
              try {
                var swResp2 = await chrome.runtime.sendMessage({ type: 'COURSE_API_DATA', course: { courseId: c.courseId, termId: effectiveTermId, courseName: c.courseName || '', schoolName: c.schoolName || '' }, rawData: text });
                console.log('[MOOC Reminder] course-discovery COURSE_API_DATA response for', c.courseId, ': termId=', effectiveTermId, JSON.stringify(swResp2));
              } catch(e2) {}
            } else if (text && text.length <= 50 && c.courseType === 'spoc') {
              console.log('[MOOC Reminder] course-discovery: SPOC', c.courseId, 'returned empty data (dummy termId?), will be handled by background API');
            } else {
              console.log('[MOOC Reminder] course-discovery: API empty/failed for', c.courseId, 'type:', c.courseType || '?', 'textLen:', text ? text.length : 0);
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
