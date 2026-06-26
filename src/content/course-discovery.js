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

            // 1) getMocTermDto.rpc + gatewayType=3
            try {
              text = await new Promise(function(resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open('POST', 'https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=' + encodeURIComponent(csrf), true);
                xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
                xhr.onload = function() { resolve(xhr.responseText); };
                xhr.onerror = function() { reject(); };
                xhr.send('termId=' + encodeURIComponent(c.termId) + '&gatewayType=3');
              });
              if (courseIsSpoc) console.log('[MOOC Reminder] discovery SPOC endpoint 1 (getMocTermDto+gw): len=' + text.length);
              if (text.length < 100 || /"code":-/.test(text)) text = null;
            } catch(e) { text = null; }

            // 2) getMocTermDto.rpc 不带 gatewayType
            if (!text) {
              try {
                text = await new Promise(function(resolve, reject) {
                  var xhr2 = new XMLHttpRequest();
                  xhr2.open('POST', 'https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=' + encodeURIComponent(csrf), true);
                  xhr2.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
                  xhr2.onload = function() { resolve(xhr2.responseText); };
                  xhr2.onerror = function() { reject(); };
                  xhr2.send('termId=' + encodeURIComponent(c.termId));
                });
                if (courseIsSpoc) console.log('[MOOC Reminder] discovery SPOC endpoint 2 (getMocTermDto no gw): len=' + text.length);
                if (text.length < 100 || /"code":-/.test(text)) text = null;
              } catch(e) { text = null; }
            }

            // 3) getSpocTermDto.rpc
            if (!text && courseIsSpoc) {
              try {
                text = await new Promise(function(resolve, reject) {
                  var xhr3 = new XMLHttpRequest();
                  xhr3.open('POST', 'https://www.icourse163.org/web/j/courseBean.getSpocTermDto.rpc?csrfKey=' + encodeURIComponent(csrf), true);
                  xhr3.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
                  xhr3.onload = function() { resolve(xhr3.responseText); };
                  xhr3.onerror = function() { reject(); };
                  xhr3.send('termId=' + encodeURIComponent(c.termId));
                });
                console.log('[MOOC Reminder] discovery SPOC endpoint 3 (getSpocTermDto): len=' + text.length);
                if (text.length < 100 || /"code":-/.test(text)) text = null;
              } catch(e) { text = null; }
            }

            // 4) fallback: getLastLearnedMocTermDto.rpc (JSON)
            if (!text) {
              try {
                text = await new Promise(function(resolve, reject) {
                  var xhr4 = new XMLHttpRequest();
                  xhr4.open('POST', 'https://www.icourse163.org/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey=' + encodeURIComponent(csrf), true);
                  xhr4.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
                  xhr4.onload = function() { resolve(xhr4.responseText); };
                  xhr4.onerror = function() { reject(); };
                  xhr4.send(JSON.stringify({ termId: parseInt(c.termId, 10) }));
                });
                console.log('[MOOC Reminder] discovery endpoint 4 (LastLearned fallback): len=' + text.length);
              } catch(e) { text = null; }
            }

            if (text && text.length > 50) {
              try {
                var swResp2 = await chrome.runtime.sendMessage({ type: 'COURSE_API_DATA', course: { courseId: c.courseId, termId: c.termId, courseName: c.courseName || '', schoolName: c.schoolName || '' }, rawData: text });
                console.log('[MOOC Reminder] course-discovery COURSE_API_DATA response for', c.courseId, ':', JSON.stringify(swResp2));
              } catch(e2) {}
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
