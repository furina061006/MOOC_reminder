/**
 * Content Script — MOOC Reminder
 *
 * Injected into icourse163.org/learn/* and /spoc/learn/* pages.
 * Responsibilities:
 *   1. Handle BATCH_API_FETCH requests from background SW
 *   2. Page-context API proxy (same-origin XHR bypasses CSRF origin check)
 *   3. SPOC: read real termId from window.moocTermDto.id via WAR script injection
 *   4. Check page-hook data captured by xhr-hook.js (DOM bridge)
 *
 * This script runs at document_idle.
 */

(async function () {
  'use strict';

  // ─── Utilities ──────────────────────────────────────────

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function parseCourseUrl(url) {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      const isSpoc = pathParts.includes('spoc');
      const learnIndex = pathParts.indexOf('learn');
      const schoolCourseId = learnIndex >= 0 ? pathParts[learnIndex + 1] : '';
      const termId = urlObj.searchParams.get('tid') || '';
      const dashIndex = schoolCourseId.indexOf('-');
      const school = dashIndex >= 0 ? schoolCourseId.substring(0, dashIndex) : '';
      return { schoolCourseId, school, courseId: schoolCourseId, termId, isSpoc };
    } catch {
      return { schoolCourseId: '', school: '', courseId: '', termId: '', isSpoc: false };
    }
  }

  // ─── Initialization ─────────────────────────────────────

  async function init() {
    // 尽早注册消息监听器，确保 BATCH_API_FETCH 不丢失
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg !== 'object') return false;
      if (msg.type === 'BATCH_API_FETCH') {
        console.log('[MOOC Reminder] BATCH_API_FETCH received, courses:', (msg.courses||[]).length);
        batchApiFetch(msg.courses || []).then(results => {
          console.log('[MOOC Reminder] BATCH_API_FETCH done, results:', results.length);
          try { sendResponse(results || []); } catch {}
        }).catch(err => {
          console.warn('[MOOC Reminder] BATCH_API_FETCH error:', err.message);
          try { sendResponse([]); } catch {}
        });
        return true;
      }
      return false;
    });

    // ═══ 读取 SPOC 真实 termId（page window.moocTermDto.id）═══
    // 用 web_accessible_resource 绕过 CSP（chrome-extension:// origin 在白名单内）
    try {
      var realTid = await new Promise(function(resolve) {
        var s = document.createElement('script');
        s.src = chrome.runtime.getURL('src/content/spoc-tid-bridge.js');
        s.onload = function() {
          s.remove();
          resolve(document.documentElement.getAttribute('data-mooc-real-termid'));
        };
        s.onerror = function() { s.remove(); resolve(null); };
        (document.head || document.documentElement).appendChild(s);
      });
      if (realTid) {
        console.log('[MOOC Reminder] SPOC real termId:', realTid);
        // 持久化到 storage，后续后台刷新直接可用
        var spocMeta = parseCourseUrl(window.location.href);
        if (spocMeta && spocMeta.isSpoc && spocMeta.courseId) {
          // 从页面读取课程名称
          var spocPageName = '';
          try { var h2 = document.querySelector('h1, .course-name, [class*="courseTitle"], .m-coursename'); if (h2) spocPageName = h2.textContent.trim(); } catch {}
          if (!spocPageName) { try { spocPageName = document.title.replace(/[_-]\s*中国大学MOOC.*$/i, '').trim(); } catch {} }
          chrome.runtime.sendMessage({
            type: 'COURSE_UPDATE',
            courseId: spocMeta.courseId,
            activeTermId: realTid,
            courseName: spocPageName,
            courseType: 'spoc'
          }).catch(function(){});
          console.log('[MOOC Reminder] SPOC real termId persisted for', spocMeta.courseId, 'name:', spocPageName);
        }
      }
    } catch(e) { console.debug('[MOOC Reminder] tid injection error:', e.message); }

    // ═══ 检查 xhr-hook.js 拦截到的页面 API 响应 ═══
    checkPageHookData();

    console.log('[MOOC Reminder] Content script initialized');
  }

  // ─── Page-hook Data Check ───────────────────────────────

  async function checkPageHookData() {
    // 从 DOM bridge 读取 xhr-hook 拦截到的页面 API 响应
    // content script 不能直接读 page window 变量，通过 DOM 属性传值
    for (var retry = 0; retry < 20; retry++) {
      await sleep(500);
      try {
        var container = document.getElementById('mooc-hook-data');
        if (container) {
          var raw = container.getAttribute('data-items');
          if (raw) {
            var items = JSON.parse(raw);
            console.log('[MOOC Reminder] Page hook captured', items.length, 'API response(s)');
            var pageMeta = parseCourseUrl(window.location.href);
            var processed = false;
            for (var i = 0; i < items.length; i++) {
              var entry = items[i];
              if (entry && entry.resp && entry.resp.length > 5000) {
                // 仅处理 tid 与当前页面 URL termId 匹配的数据
                // 避免把其他课程（如 SPOC）的响应错误归属到当前页面 courseId
                var urlTid = pageMeta.termId;
                var entryTid = entry.tid;
                var realTid = document.documentElement.getAttribute('data-mooc-real-termid');

                // SPOC 专属：xhr-hook 从请求体捕获的是假 termId（与 urlTid 相同），
                // 但真实 termId 已知。跳过钩子数据，让 batchApiFetch 用正确 termId 处理。
                if (realTid && realTid !== urlTid && entryTid === urlTid) {
                  console.log('[MOOC Reminder] SPOC: 跳过钩子数据假 tid=' + entryTid + '，等待 batchApiFetch 用真实 tid=' + realTid + ' 处理');
                  continue;
                }

                if (entryTid !== urlTid && entryTid !== realTid && entryTid !== 'unknown') {
                  console.log('[MOOC Reminder] Skipping hook entry tid=' + entryTid + ' (page tid=' + urlTid + '), will be handled by batchApiFetch');
                  continue;
                }
                console.log('[MOOC Reminder] Processing page-hook data, len:', entry.resp.length, 'tid:', entryTid);
                try {
                  // SPOC: 优先用 realTid，避免假 termId 构造出错误的 UID
                  var sendTid = (realTid && realTid !== urlTid) ? realTid : (entryTid || pageMeta.termId);
                  var swResp = await chrome.runtime.sendMessage({
                    type: 'COURSE_API_DATA',
                    course: { courseId: pageMeta.courseId, termId: sendTid, courseName: '', schoolName: '' },
                    rawData: entry.resp
                  });
                  console.log('[MOOC Reminder] Page-hook COURSE_API_DATA response:', JSON.stringify(swResp));
                  processed = true;
                } catch(e) { console.debug('[MOOC Reminder] Page-hook send failed:', e.message); }
              }
            }
            // 完成后删除 DOM bridge 避免重复处理
            container.remove();
            if (processed) break;
          }
        }
      } catch(e) { console.debug('[MOOC Reminder] checkPageHookData error:', e.message); }
    }
  }

  // ─── Batch API Fetch (page-context) ─────────────────────
  // 在 icourse163.org 同源执行 XHR，浏览器自动附带 cookies + CSRF

  async function batchApiFetch(courses) {
    console.log('[MOOC Reminder] batchApiFetch called, courses:', courses.length);
    if (!Array.isArray(courses)) courses = [];

    // 始终加上当前页面的课程（防止 storage 无记录时 courses 为空）
    var pageMeta = parseCourseUrl(window.location.href);
    if (pageMeta && pageMeta.courseId && pageMeta.termId) {
      var hasCurrent = courses.some(function(c){ return c.courseId === pageMeta.courseId; });
      if (!hasCurrent) {
        var pageName = '';
        try { var h = document.querySelector('h1, .course-name, [class*="courseTitle"], .m-coursename'); if (h) pageName = h.textContent.trim(); } catch {}
        if (!pageName) { try { pageName = document.title.replace(/[_-]\s*中国大学MOOC.*$/i, '').trim(); } catch {} }
        courses.push({ courseId: pageMeta.courseId, termId: pageMeta.termId, courseName: pageName, schoolName: '' });
      }
    }
    if (courses.length === 0) return [];

    // 读取 CSRF cookie（HttpOnly → chrome.cookies.get()）
    var csrf = '';
    try {
      var cookieObj = await chrome.cookies.get({ name: 'NTESSTUDYSI', url: 'https://www.icourse163.org/' });
      if (cookieObj && cookieObj.value) {
        csrf = cookieObj.value;
      } else {
        var m = document.cookie.match(/NTESSTUDYSI=([a-z0-9]+);?/i);
        csrf = m ? m[1] : '';
      }
    } catch(e) {
      try {
        var m2 = document.cookie.match(/NTESSTUDYSI=([a-z0-9]+);?/i);
        csrf = m2 ? m2[1] : '';
      } catch(e2) {}
    }
    if (!csrf) {
      console.log('[MOOC Reminder] No NTESSTUDYSI cookie found (tried chrome.cookies + document.cookie), cannot do API fetches');
      return [];
    }

    // Promise-based XHR helper
    function xhrFetch(url, contentType, body) {
      return new Promise(function(resolve, reject) {
        var x = new XMLHttpRequest();
        x.open('POST', url, true);
        if (contentType) x.setRequestHeader('Content-Type', contentType);
        x.onload = function() { resolve(x.responseText); };
        x.onerror = function() { reject(new Error('XHR failed')); };
        x.send(body);
      });
    }

    var results = [];
    var isSpocPage = pageMeta && pageMeta.isSpoc;
    var csrfKey = encodeURIComponent(csrf);

    for (var i = 0; i < courses.length; i++) {
      var c = courses[i];
      if (!c || !c.termId) continue;

      // 标记当前页面是否是 SPOC 学习页面且匹配本课程
      var isCurrentSpocPage = isSpocPage && c.courseId === pageMeta.courseId;
      var courseIsSpoc = (c.courseType === 'spoc') || isCurrentSpocPage;

      // ═══ SPOC: 仅当在本课程页面上时，才用 DOM 属性替换 termId ═══
      // 在其他页面上用 DOM 属性会拿到别的课程的真实 termId，造成数据串
      if (isCurrentSpocPage) {
        try {
          var realTermId = document.documentElement.getAttribute('data-mooc-real-termid');
          if (realTermId && realTermId !== c.termId) {
            console.log('[MOOC Reminder] SPOC: using real termId', realTermId, 'instead of URL termId', c.termId, 'for', c.courseId);
            c.termId = realTermId;
          }
        } catch(e) {}
      } else if (courseIsSpoc) {
        // 在非本页面处理 SPOC 课程——termId 来自 SW 的 activeTermId
        console.debug('[MOOC Reminder] SPOC: cross-page handling', c.courseId, 'termId=' + c.termId);
      }

      try {
        var text = null;
        var tid2 = encodeURIComponent(c.termId);

        // 0) getLastLearnedMocTermDto JSON（SPOC + MOOC 首选）
        for (var retry = 0; retry < 2; retry++) {
          if (text && text.length > 2000) break;
          try {
            text = await xhrFetch(
              'https://www.icourse163.org/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey=' + csrfKey,
              'application/json;charset=UTF-8',
              JSON.stringify({ termId: parseInt(c.termId, 10) }));
            if (text.length < 2000) text = null;
          } catch(eRetry) { text = null; }
          if (!text && retry === 0) await sleep(500);
        console.log('[MOOC Reminder] EP0(getLastLearned) for', c.courseId, 'termId=', c.termId, 'len=', text ? text.length : 0, text && text.length > 500 ? '✅' : '❌');
        }

        // 1) getMocTermDto.rpc + gatewayType=3（MOOC fallback）
        if (!text) { try {
          text = await xhrFetch(
            'https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=' + csrfKey,
            'application/x-www-form-urlencoded;charset=UTF-8',
            'termId=' + tid2 + '&gatewayType=3');
          if (text.length < 100 || /"code":-/.test(text)) text = null;
        } catch(e1) { text = null; }}
        console.log('[MOOC Reminder] EP1(getMocTerm+gw3) for', c.courseId, 'len=', text ? text.length : 0, text && text.length > 500 ? '✅' : '❌');

        // 2) getMocTermDto.rpc 不带 gatewayType
        if (!text) { try {
          text = await xhrFetch(
            'https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=' + csrfKey,
            'application/x-www-form-urlencoded;charset=UTF-8',
            'termId=' + tid2);
          if (text.length < 100 || /"code":-/.test(text)) text = null;
        } catch(e2) { text = null; }}
        console.log('[MOOC Reminder] EP2(getMocTerm) for', c.courseId, 'len=', text ? text.length : 0, text && text.length > 500 ? '✅' : '❌');

        // 3) DWR endpoint
        if (!text) { try {
          text = await xhrFetch(
            'https://www.icourse163.org/dwr/call/plaincall/CourseBean.getMocTermDto.dwr',
            'text/plain;charset=UTF-8',
            ['callCount=1', 'scriptSessionId=', 'httpSessionId=', 'c0-scriptName=CourseBean', 'c0-methodName=getMocTermDto', 'c0-id=0', 'c0-param0=number:' + tid2, 'c0-param1=boolean:true', 'batchId=0'].join('\n'));
          if (text.length < 100 || /exception|forbidden|非法跨域/i.test(text)) text = null;
        } catch(e3) { text = null; }}
        console.log('[MOOC Reminder] EP3(DWR) for', c.courseId, 'len=', text ? text.length : 0, text && text.length > 500 ? '✅' : '❌');

        // 4) getMocTermDto.rpc + courseId（SPOC fallback）
        if (!text && courseIsSpoc) { try {
          text = await xhrFetch(
            'https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=' + csrfKey,
            'application/x-www-form-urlencoded;charset=UTF-8',
            'termId=' + tid2 + '&courseId=' + encodeURIComponent(c.courseId || ''));
          if (text.length < 100 || /"code":-/.test(text)) text = null;
        } catch(e4) { text = null; }}
        console.log('[MOOC Reminder] EP4(+courseId) for', c.courseId, 'len=', text ? text.length : 0, text && text.length > 500 ? '✅' : '❌');

        // 5) getMocTermDto.rpc + JSON body
        if (!text) { try {
          text = await xhrFetch(
            'https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=' + csrfKey,
            'application/json;charset=UTF-8',
            JSON.stringify({ termId: parseInt(c.termId, 10) }));
          if (text.length < 100 || /"code":-/.test(text)) text = null;
        } catch(e5) { text = null; }}
        console.log('[MOOC Reminder] EP5(JSON) for', c.courseId, 'len=', text ? text.length : 0, text && text.length > 500 ? '✅' : '❌');

        // 6) 兜底: getLastLearnedMocTermDto.rpc (JSON)
        if (!text) { try {
          text = await xhrFetch(
            'https://www.icourse163.org/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey=' + csrfKey,
            'application/json;charset=UTF-8',
            JSON.stringify({ termId: parseInt(c.termId, 10) }));
        } catch(e6) { text = null; }}
        console.log('[MOOC Reminder] EP6(final) for', c.courseId, 'len=', text ? text.length : 0, text && text.length > 500 ? '✅' : '❌');

        if (!text || text.length < 50) { console.debug('[MOOC Reminder] API empty/failed for', c.courseId, '(type:', c.courseType || 'unknown', ') textLen:', text ? text.length : 0); continue; }

        results.push({
          course: { courseId: c.courseId, termId: c.termId, courseName: c.courseName || '', schoolName: c.schoolName || '' },
          rawData: text
        });
      } catch(e) {
        console.debug('[MOOC Reminder] API fetch error for', c.courseId, e.message);
      }
    }

    // 逐个发送 COURSE_API_DATA 给 SW 处理
    for (var j = 0; j < results.length; j++) {
      try {
        var swResp = await chrome.runtime.sendMessage({
          type: 'COURSE_API_DATA',
          course: results[j].course,
          rawData: results[j].rawData
        });
        console.log('[MOOC Reminder] COURSE_API_DATA response for', results[j].course.courseId, ':', JSON.stringify(swResp));
      } catch { console.debug('[MOOC Reminder] COURSE_API_DATA send failed for', results[j].course.courseId); }
    }
    console.log('[MOOC Reminder] Batch API fetch done:', results.length, 'courses fetched');
    return results;
  }

  // ─── Boot ───────────────────────────────────────────────

  init().catch(err => {
    console.error('[MOOC Reminder] Initialization failed:', err);
  });
})();
