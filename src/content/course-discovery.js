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
