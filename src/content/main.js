/**
 * Content Script Entry Point — MOOC Reminder
 *
 * Injected into icourse163.org/learn/* and /spoc/learn/* pages.
 * Responsibilities:
 *   1. Monitor SPA hash route changes
 *   2. Wait for DOM content to render
 *   3. Scrape homework data from the page
 *   4. Send scraped data to the background service worker
 *   5. Respond to SCRAPE_NOW requests from background
 *
 * This script runs at document_idle (after DOM is ready).
 * It is NOT an ES module to ensure compatibility with
 * chrome.scripting.executeScript dynamic injection.
 */

(async function () {
  'use strict';

  // ─── Dynamic Imports ──────────────────────────────────
  // Content scripts declared in manifest.json can't use ES modules
  // directly in all browsers. We use import() where supported, or
  // inline fallback logic.

  // For now, we inline the core logic. The observer/scraper classes
  // are designed to be import()-ed when ES module support is confirmed.
  // In practice, Chrome/Edge M3 supports static imports in content scripts
  // declared as modules via manifest. We use a self-contained approach
  // that works either way.

  // ─── Configuration ────────────────────────────────────
  const SELECTOR_CONFIG_PATH = 'src/content/selectors.json';

  // ── 爬取范围: 所有 /learn/* 页面，用截止日期过滤噪音 ──
  // 不依赖精确路由匹配（icourse163.org 路由因课程版本而异）
  // 改为：在所有 learn 页面试着爬，但只保留有截止日期的条目
  // 这样 "测验与作业" 的标题（无截止日期）会被自然过滤掉

  const ALLOWED_ROUTES = [
    '/learn/'   // 匹配所有 learn 子页面
  ];

  // ─── State ────────────────────────────────────────────
  let currentRoute = '';
  let isScraping = false;
  let selectorConfig = null;
  let domScrapingDisabled = false;   // 设置页关闭 DOM 抓取后跳过自动爬

  // ─── Initialization ───────────────────────────────────

  async function init() {
    // ═══ 尽早注册消息监听器（在任何异步操作之前），确保 BATCH_API_FETCH 不会丢失 ═══
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      // Defensive: msg may be undefined or lack type
      if (!msg || typeof msg !== 'object') return false;
      if (msg.type === 'SCRAPE_NOW') {
        waitAndScrape().then(data => {
          try { sendResponse(data || { course: null, homeworkItems: [] }); } catch {}
        }).catch(err => {
          try { sendResponse({ course: null, homeworkItems: [], error: String(err?.message || err) }); } catch {}
        });
        return true; // async response
      }
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

    // Load selector configuration
    try {
      selectorConfig = await loadSelectorConfig();
    } catch (e) {
      console.error('[MOOC Reminder] Failed to load selectors:', e);
      selectorConfig = getDefaultSelectors();
    }

    // 查询设置：是否需要 DOM 抓取
    try {
      var resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (resp && resp.settings) {
        domScrapingDisabled = (resp.settings.domScrapingEnabled === false);
        if (domScrapingDisabled) console.log('[MOOC Reminder] DOM scraping disabled by settings, API-only mode');
      }
    } catch {}

    // Detect current route
    currentRoute = getCurrentHashRoute();

    // Diagnostic: log route detection status
    console.log('[MOOC Reminder] Initialized. Route:', `"${currentRoute}"`, '| Allowed:', isHomeworkRelevantRoute(currentRoute));
    console.log('[MOOC Reminder] URL:', window.location.href);
    console.log('[MOOC Reminder] Strategy: scrape all /learn/ pages, filter by deadline presence');

    // Start observers
    setupUrlObserver();
    setupDomObserver();

    // Initial scrape if on relevant page AND DOM scraping enabled
    if (isHomeworkRelevantRoute(currentRoute) && !domScrapingDisabled) {
      waitAndScrape();
    }

    // Periodic re-scrape on relevant pages (every 30s), only if DOM enabled
    setInterval(() => {
      if (domScrapingDisabled) return;
      const route = getCurrentHashRoute();
      if (isHomeworkRelevantRoute(route)) {
        waitAndScrape();
      }
    }, 30000);

    console.log('[MOOC Reminder] Content script initialized');
  }

  // ─── URL Observation ──────────────────────────────────

  function setupUrlObserver() {
    // Layer 1: hashchange event
    window.addEventListener('hashchange', () => {
      const newRoute = getCurrentHashRoute();
      if (newRoute !== currentRoute) {
        currentRoute = newRoute;
        if (isHomeworkRelevantRoute(newRoute) && !domScrapingDisabled) {
          waitAndScrape();
        }
      }
    });

    // Layer 2: Intercept history.pushState / replaceState
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const result = origPushState.apply(this, args);
      checkRouteChange();
      return result;
    };

    history.replaceState = function (...args) {
      const result = origReplaceState.apply(this, args);
      checkRouteChange();
      return result;
    };

    // Layer 3: Fallback polling (every 1s)
    setInterval(checkRouteChange, 1000);
  }

  function checkRouteChange() {
    if (domScrapingDisabled) return;
    const newRoute = getCurrentHashRoute();
    if (newRoute !== currentRoute) {
      currentRoute = newRoute;
      if (isHomeworkRelevantRoute(newRoute)) {
        waitAndScrape();
      }
    }
  }

  // ─── DOM Observation ──────────────────────────────────

  function setupDomObserver() {
    // Watch for DOM changes that indicate new content loaded
    const observer = new MutationObserver(() => {
      // Not actioned immediately — scrape is triggered by route change
      // or periodic timer. This observer is here for future enhancement
      // (e.g., detecting when a dynamic list finishes loading).
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // ─── Scraping Orchestration ───────────────────────────

  async function waitAndScrape() {
    if (isScraping) return null;
    isScraping = true;

    try {
      // Wait for content to appear (up to 10s)
      await waitForContent(10000);

      // Additional wait for loading indicators to clear
      await sleep(500);

      // Perform the scrape (wrapped in try for safety)
      let data = null;
      try {
        data = scrapePage();
      } catch (scrapeErr) {
        console.error('[MOOC Reminder] scrapePage() threw:', scrapeErr);
        try {
          await chrome.runtime.sendMessage({
            type: 'SCRAPE_STATUS',
            scrapeStatus: createScrapeStatus('error', {
              message: String(scrapeErr?.message || scrapeErr)
            })
          });
        } catch {}
        return null;
      }

      if (data && data.homeworkItems && data.homeworkItems.length > 0) {
        // Send to background
        try {
          await chrome.runtime.sendMessage({
            type: 'HOMEWORK_DATA',
            course: data.course,
            homeworkItems: data.homeworkItems,
            scrapeStatus: data.scrapeStatus
          });
          console.log(`[MOOC Reminder] Scraped ${data.homeworkItems.length} items from ${data.course.courseName}`);
        } catch (e) {
          console.error('[MOOC Reminder] Failed to send data to background:', e);
        }
      } else if (data && data.scrapeStatus) {
        try {
          await chrome.runtime.sendMessage({
            type: 'SCRAPE_STATUS',
            scrapeStatus: data.scrapeStatus
          });
        } catch (e) {
          console.error('[MOOC Reminder] Failed to send scrape status:', e);
        }
      }
      return data;
    } catch (e) {
      console.error('[MOOC Reminder] Scrape failed:', e.message);
      try {
        await chrome.runtime.sendMessage({
          type: 'SCRAPE_STATUS',
          scrapeStatus: createScrapeStatus('error', { message: e.message })
        });
      } catch {}
      return null;
    } finally {
      isScraping = false;
    }
  }

  /**
   * Wait for homework content to render in the DOM.
   * On quiz/exam pages, we look for quiz/exam list items specifically.
   */
  function waitForContent(timeoutMs) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      // Check immediately
      if (isContentReady()) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        // Don't reject — just resolve and try to scrape anyway
        resolve();
      }, timeoutMs);

      const observer = new MutationObserver(() => {
        if (isContentReady() && !isLoading()) {
          // Wait for DOM to stabilize
          setTimeout(() => {
            cleanup();
            resolve();
          }, 500);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      function cleanup() {
        clearTimeout(timeout);
        observer.disconnect();
      }
    });
  }

  function isContentReady() {
    try {
      // Loading 还没消失
      const loading = document.querySelector('.j-loading, .m-loading, .loading-spinner, [class*="loading"]');
      if (loading && loading.offsetParent !== null) return false;

      // 目标列表项已渲染
      const items = document.querySelectorAll('.u-quizHwListItem');
      if (items.length > 0) return true;

      // 退路：页面有足够内容
      const body = document.body;
      if (!body) return false;
      return (body.textContent || '').trim().length > 20;
    } catch {
      return false;
    }
  }

  function isLoading() {
    const loadingIndicators = [
      '.j-loading', '.m-loading', '.loading-spinner',
      '[class*="loading"]', '[class*="Loading"]',
      '.el-loading-mask'
    ];

    return loadingIndicators.some(sel => {
      try {
        const el = document.querySelector(sel);
        return el && el.offsetParent !== null;
      } catch {
        return false;
      }
    });
  }

  // ─── Page Scraping Logic ──────────────────────────────

  function createScrapeStatus(status, details) {
    return Object.assign({
      status,
      url: window.location.href,
      route: getCurrentHashRoute(),
      checkedAt: new Date().toISOString()
    }, details || {});
  }

  function isDedicatedHomeworkRoute(route) {
    return /\/learn\/(quiz|exam|homework)/i.test(route || '');
  }

  function scrapePage() {
    if (!selectorConfig) {
      selectorConfig = getDefaultSelectors();
    }

    // Check for login wall
    if (isLoginWall()) {
      console.log('[MOOC Reminder] Login wall detected, skipping scrape');
      return {
        course: null,
        homeworkItems: [],
        scrapeStatus: createScrapeStatus('login_required', {
          message: '请先登录 icourse163.org'
        })
      };
    }

    // Parse URL metadata
    const urlMeta = parseCourseUrl(window.location.href);

    // Scrape course metadata
    const meta = scrapeCourseMeta();

    // Scrape homework items
    const homeworkItems = scrapeHomeworkItems(urlMeta, meta);
    const route = getCurrentHashRoute();
    const status = homeworkItems.length > 0 ? 'ok' : (isDedicatedHomeworkRoute(route) ? 'empty_on_homework_page' : 'empty');

    return {
      course: {
        courseId: urlMeta.courseId,
        termId: urlMeta.termId,
        courseName: meta.courseName,
        schoolName: meta.schoolName,
        courseType: urlMeta.isSpoc ? 'spoc' : 'mooc',
        courseUrl: window.location.href
      },
      homeworkItems: homeworkItems,
      scrapeStatus: createScrapeStatus(status, {
        courseId: urlMeta.courseId,
        termId: urlMeta.termId,
        courseName: meta.courseName,
        itemCount: homeworkItems.length,
        message: status === 'empty_on_homework_page' ? '页面已加载，但未识别到作业条目，可能是网页结构变化' : null
      })
    };
  }

  function scrapeCourseMeta() {
    const cfg = selectorConfig?.coursePage || {};

    let courseName = '';
    let schoolName = '';

    // Try to get course name
    const nameSelectors = [
      cfg.courseName?.primary,
      ...(cfg.courseName?.fallback || [])
    ].filter(Boolean);

    for (const sel of nameSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          courseName = el.textContent.trim();
          break;
        }
      } catch { /* skip */ }
    }

    if (!courseName) {
      courseName = document.title || '未知课程';
    }

    // Try to get school name
    const schoolSelectors = [
      cfg.schoolName?.primary,
      ...(cfg.schoolName?.fallback || [])
    ].filter(Boolean);

    for (const sel of schoolSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          schoolName = el.textContent.trim();
          break;
        }
      } catch { /* skip */ }
    }

    return { courseName, schoolName };
  }

  function scrapeHomeworkItems(urlMeta, courseMeta) {
    const items = [];
    var seenFallback = new Set();

    // ── 策略1: .u-quizHwListItem（用户HTML中确认的类名） ──
    var itemEls = document.querySelectorAll('.u-quizHwListItem');
    console.log('[MOOC Reminder] Strategy1 .u-quizHwListItem:', itemEls.length, 'found');

    var debugCount = { found: itemEls.length, deadline: 0, hasScore: 0, passed: 0 };
    for (var i = 0; i < itemEls.length; i++) {
      try {
        // 快速诊断：检查是否包含截止日期和标题
        var t = (itemEls[i].textContent || '').trim();
        var hasDL = /(\d{4}[年\-/]\d{1,2}[月\-/]\d{1,2}日?)\s*\d{1,2}:\d{2}/.test(t);
        var hasTitle = /测验|作业|考试|测试|quiz|exam|test|homework/i.test(t);
        if (hasDL) debugCount.deadline++;
        if (hasTitle) { debugCount.hasScore++; } // repurpose counter

        var item = buildHomeworkItem(itemEls[i], urlMeta, courseMeta, '', '', i);
        if (item) { items.push(item); seenFallback.add(itemEls[i]); debugCount.passed++; }
      } catch(e) { console.debug('[MOOC Reminder] build failed:', e.message); }
    }
    console.log('[MOOC Reminder] Strategy1 breakdown:', JSON.stringify(debugCount));

    // ── 策略2: 找包含"截止时间"的元素，取其父容器 ──
    if (items.length === 0) {
      var timeEls = document.querySelectorAll('.j-submitTime');
      console.log('[MOOC Reminder] Strategy2 .j-submitTime:', timeEls.length, 'found');
      for (var j = 0; j < timeEls.length; j++) {
        var parent = timeEls[j].closest('div[class]');
        if (parent && !seenFallback.has(parent)) {
          seenFallback.add(parent);
          try {
            var item2 = buildHomeworkItem(parent, urlMeta, courseMeta, '', '', j);
            if (item2) items.push(item2);
          } catch(e) {}
        }
      }
    }

    // ── 策略3: 找 class 名含 quizHwItem/listItem/list 的 div ──
    if (items.length === 0) {
      var fallbackSelectors = [
        '.m-chapterQuizHwItem', '[class*="quizHwItem"]',
        '.j-quiz-item', '.m-quiz-item', '.j-test-item',
        'tr[class*="row"]', 'tr[class*="item"]'
      ];
      for (var s = 0; s < fallbackSelectors.length; s++) {
        try {
          var els = document.querySelectorAll(fallbackSelectors[s]);
          if (els.length > 0) {
            console.log('[MOOC Reminder] Strategy3', fallbackSelectors[s] + ':', els.length, 'found');
            for (var k = 0; k < els.length; k++) {
              if (!seenFallback.has(els[k])) {
                seenFallback.add(els[k]);
                try {
                  var item3 = buildHomeworkItem(els[k], urlMeta, courseMeta, '', '', k);
                  if (item3) items.push(item3);
                } catch(e) {}
              }
            }
            if (items.length > 0) break;
          }
        } catch(e) {}
      }
    }

    // ── 诊断：零结果时输出页面环境信息 ──
    if (items.length === 0) {
      console.log('[MOOC Reminder] ZERO ITEMS. Page info:');
      console.log('  URL:', window.location.href);
      console.log('  Hash:', window.location.hash);
      console.log('  Route:', getCurrentHashRoute());
      // 页面上实际有哪些 class 名包含 quiz/test/exam/homework
      var classSamples = {};
      var all = document.querySelectorAll('[class]');
      for (var di = 0; di < all.length; di++) {
        var cls = all[di].className;
        if (typeof cls === 'string') {
          cls.split(/\s+/).forEach(function(c) {
            if (c.length > 2 && /quiz|test|exam|homework|hw|item|list/i.test(c)) {
              classSamples[c] = (classSamples[c] || 0) + 1;
            }
          });
        }
      }
      var keys = Object.keys(classSamples).sort();
      if (keys.length > 0) {
        console.log('  Related class names on page:');
        keys.slice(0, 25).forEach(function(k) { console.log('   ', k, '(' + classSamples[k] + ')'); });
      } else {
        console.log('  No quiz/test/exam/homework classes found on page');
        // 输出前50个类名看看
        var allClasses = {};
        for (var dj = 0; dj < Math.min(all.length, 200); dj++) {
          var c2 = all[dj].className;
          if (typeof c2 === 'string' && c2.length > 2) {
            allClasses[c2] = (allClasses[c2] || 0) + 1;
          }
        }
        console.log('  All classes (up to 30):', Object.keys(allClasses).sort().slice(0, 30).join(', '));
      }
    }

    console.log('[MOOC Reminder] After build: got', items.length, 'items');
    return items;
  }

  /**
   * Find quiz/exam list rows on the page.
   * icourse163.org quiz/exam pages typically use tables or structured divs.
   */
  function extractHomeworkTitle(el, text) {
    try {
      var titleEl = el.querySelector('.j-name, [class*="name"], h4, h3');
      if (titleEl && titleEl.textContent && titleEl.textContent.trim()) {
        return titleEl.textContent.trim();
      }
    } catch {}

    var cleaned = (text || '')
      .replace(/\s+/g, ' ')
      .replace(/(截止时间?|提交截止|截止日期)[:：]?\s*\d{1,4}[年\-/月\d日\s:：]+.*$/i, '')
      .replace(/(有效分数|测验得分|作业得分|考试得分|得分)[:：]?\s*\d{1,3}(?:\.\d+)?\s*(?:[\/分]\s*\d{1,3}(?:\.\d+)?)?.*$/i, '')
      .replace(/(已完成|已提交|已批阅|已通过|查看成绩|查看分数).*$/i, '')
      .trim();

    if (!cleaned || cleaned.length < 2) {
      cleaned = (text || '').substring(0, 40).trim();
    }
    return cleaned;
  }

  function buildStableHomeworkIdentity(urlMeta, type, title, domPosition) {
    return [
      urlMeta.courseId || '',
      urlMeta.termId || '',
      type || '',
      title || '',
      String(domPosition || 0)
    ].join('|');
  }

  function buildHomeworkItem(el, urlMeta, courseMeta, chapterId, lessonId, domPosition) {
    try {
    const text = (el.textContent || '').trim();

    // Skip if element doesn't look like a homework item
    if (text.length < 2) return null;
    if (/加载中|loading|请稍候|spinner/i.test(text)) return null;


    // Detect type
    // 按钮文字优先——用 .j-quizBtn 的文字判断（最可靠）
    var btnEl = el.querySelector('.j-quizBtn');
    var btnText = btnEl ? (btnEl.textContent || '') : '';
    let type = 'homework';
    if (btnText.indexOf('测验') >= 0) type = 'quiz';
    else if (btnText.indexOf('考试') >= 0) type = 'exam';

    // 按钮无指示，查元素全文（考试优先于测验，防止考试项被“测验”标签文字误伤）
    if (type === 'homework') {
      if (/\u671f\u672b|\u8003\u8bd5|exam/i.test(text)) type = 'exam';
      else if (/\u6d4b\u9a8c|quiz/i.test(text)) type = 'quiz';
      else if (/\u8ba8\u8bba|discussion/i.test(text)) type = 'discussion';
    }

    // 路由默认：examlist 只会有考试
    if (type === 'homework') {
      var pageRoute = getCurrentHashRoute();
      if (/\/learn\/examlist|\/learn\/exam\b/i.test(pageRoute)) {
        type = 'exam';
      }
    }

    // ── 作业多阶段处理（提交/互评/成绩） ──
    var homeworkPhase = null;
    var homeworkPhaseDeadline = null;
    if (type === 'homework' || btnText.indexOf('作业') >= 0) {
      var phaseEls = el.querySelectorAll('.j-phase');
      for (var pi = 0; pi < phaseEls.length; pi++) {
        if (phaseEls[pi].className.indexOf('current') >= 0) {
          var phaseText = (phaseEls[pi].textContent || '');
          if (phaseText.indexOf('作业提交阶段') >= 0) {
            homeworkPhase = 'submit';
            var st = phaseEls[pi].querySelector('.j-submitTime');
            if (st) homeworkPhaseDeadline = (st.textContent || '').trim();
          } else if (phaseText.indexOf('作业批改阶段') >= 0 || phaseText.indexOf('互评') >= 0) {
            homeworkPhase = 'peerreview';
            var ee = phaseEls[pi].querySelector('.j-evalEnd');
            if (ee) homeworkPhaseDeadline = (ee.textContent || '').trim();
          } else if (phaseText.indexOf('成绩公布阶段') >= 0) {
            homeworkPhase = 'results';
          }
          break;
        }
      }
    }

    // Extract score
    const scoreMatch = text.match(/(\d{1,3}(?:\.\d+)?)\s*[\/分]\s*(\d{1,3}(?:\.\d+)?)(?![\/\-年.\d])/);
    let score = null, totalScore = null;
    if (scoreMatch) {
      var s1 = parseFloat(scoreMatch[1]);
      var s2 = parseFloat(scoreMatch[2]);
      // 防日期误配（"26/06" 日/月）：无小数点 + 两数都 ≤31 → 跳过
      var hasDot = scoreMatch[1].indexOf('.') >= 0 || scoreMatch[2].indexOf('.') >= 0;
      if (hasDot || s1 > 31 || s2 > 31) {
        score = s1;
        totalScore = s2;
      }
    }

    // Detect status — use broader check that includes score and 互评
    const isDone = checkCompleted(el, text);
    const hasScore = (score !== null && totalScore !== null && score > 0);
    const isPeerReviewDone = /^已互评$|互评已完成|^已评价$|^已评分$|互评结束|已完成互评|互评已结束|互评得分|同伴互评.*已完成/i.test(text);

    // 作业在互评阶段：提交截止过了也不算完成，除非互评完毕
    var effectivelyDone;
    if (homeworkPhase === 'peerreview') {
      effectivelyDone = isPeerReviewDone || hasScore;
    } else if (homeworkPhase === 'results') {
      effectivelyDone = true;
    } else {
      effectivelyDone = isDone || hasScore || isPeerReviewDone;
    }

    // 诊断：为什么标记为完成（title 在下方声明，所以此处不用 title）
    if (effectivelyDone) {
      var _why = [];
      if (isDone) _why.push('checkCompleted');
      if (hasScore) _why.push('score>0:' + score);
      if (isPeerReviewDone) _why.push('peerReview');
      console.log('[MOOC Reminder] COMPLETED, 原因:', _why.join(','));
    }

    let status = 'unfinished';
    if (effectivelyDone) status = 'completed';
    else if (/已提交|submitted/i.test(text)) status = 'submitted';

    // Extract deadline（作业优先用当前阶段的截止时间）
    var dlRaw = null;
    if (homeworkPhaseDeadline) {
      dlRaw = homeworkPhaseDeadline;
    } else {
      dlRaw = extractDeadlineText(el);
    }
    const deadlineRaw = dlRaw;
    let deadline = null;
    if (deadlineRaw) {
      deadline = parseChineseDateInline(deadlineRaw);
    }

    // Clean itemName using the dedicated title element when available.
    var itemName = extractHomeworkTitle(el, text);

    // ── Filter: skip known UI/noise itemNames ──
    if (/一键互评|自动互评|获取答案|不再提醒|查看帮助|使用插件前/i.test(itemName)) {
      return null;
    }

    // ── Filter: 没有截止日期也没有分数 → 不是有效作业 ──
    if (!deadlineRaw && !hasScore) {
      return null;
    }

    // ── Filter: itemName是纯截止日期文本 → 不是有效作业 ──
    if (/^截止时间|^提交时间|^有效分数|^开始时间/.test(itemName)) {
      return null;
    }

    // Prefer stable DOM IDs; otherwise hash stable fields, not full text/status.
    const extractedId = extractId(el, [
      'data-test-id', 'data-testid', 'data-homework-id',
      'data-homeworkid', 'data-hwid', 'data-id', 'data-content-id'
    ]);
    const identityKey = buildStableHomeworkIdentity(urlMeta, type, itemName, domPosition);
    const homeworkId = extractedId || hashFromText(identityKey);
    const uid = `${urlMeta.courseId}_tid${urlMeta.termId}_ch${chapterId}_le${lessonId}_hw${homeworkId}`;

    return {
      uid,
      identityKey,
      courseId: urlMeta.courseId,
      termId: urlMeta.termId,
      chapterId,
      lessonId,
      homeworkId,
      title: itemName,
      type,
      hwPhase: homeworkPhase,
      courseName: courseMeta.courseName,
      schoolName: courseMeta.schoolName,
      status,
      checkedOff: effectivelyDone,
      manuallyCheckedOff: false,
      autoDetectedCompleted: effectivelyDone,
      completionReason: effectivelyDone ? 'auto' : null,
      deadline,
      deadlineRaw,
      firstSeen: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      pageUrl: window.location.href,
      score,
      totalScore
    };
    } catch (buildErr) {
      console.error('[MOOC Reminder] buildHomeworkItem FATAL:', buildErr.message, buildErr.stack);
      return null;
    }
  }

  function checkCompleted(el, text) {
    // Safely get class name — SVG elements return SVGAnimatedString, not string
    let className = '';
    try {
      const raw = el.className;
      if (typeof raw === 'string') {
        className = raw;
      } else if (raw && typeof raw.baseVal === 'string') {
        // SVGAnimatedString (SVG elements)
        className = raw.baseVal;
      } else if (raw) {
        className = String(raw);
      }
    } catch {
      className = '';
    }

    // Check class patterns
    const completeClassPatterns = [
      'done', 'finished', 'completed', 'is-pass', 'is-done',
      'm-homeworkItem-done', 'status-done', 'j-done', 'is-finished'
    ];
    for (const pattern of completeClassPatterns) {
      if (className.includes(pattern)) return true;
    }

    // Check text patterns
    const completeTextPatterns = [
      '已完成', '已成功提交', '已提交', '已批阅', '已通过',
      '测验得分', '作业得分', '考试得分',   // 具体得分项目，不是"最高得分"这种说明文字
      '得分：',                            // 有冒号的具体分数
      '已互评', '互评已完成', '已评价', '已评分',
      '查看成绩', '查看分数'               // 去掉独立'成绩'，防"直接影响作业成绩"误匹配
    ];
    if (typeof text === 'string') {
      for (const pattern of completeTextPatterns) {
        if (text.includes(pattern)) return true;
      }
    }

    // Check child elements for status indicators
    try {
      const children = el.querySelectorAll('*');
      for (const child of children) {
        // Safely get child's class name (same SVG issue)
        let childClass = '';
        try {
          const raw = child.className;
          if (typeof raw === 'string') {
            childClass = raw;
          } else if (raw && typeof raw.baseVal === 'string') {
            childClass = raw.baseVal;
          } else if (raw) {
            childClass = String(raw);
          }
        } catch {
          childClass = '';
        }

        if (typeof childClass === 'string') {
          for (const pattern of completeClassPatterns) {
            if (childClass.includes(pattern)) return true;
          }
        }

        const childText = (child.textContent || '');
        if (typeof childText === 'string') {
          for (const pattern of completeTextPatterns) {
            if (childText.includes(pattern)) return true;
          }
        }
      }
    } catch {
      // DOM traversal error — skip child checks
    }

    return false;
  }

  function extractDeadlineText(el) {
    // 只检查元素自身的文本，不查父节点 — 防止子元素窃取父元素的截止日期
    const deadlinePatterns = [
      /(\d{4}[年\-\/]\d{1,2}[月\-\/]\d{1,2}日?\s*\d{1,2}:\d{2})/,
      /(\d{1,2}[月\/]\d{1,2}日?\s*\d{1,2}:\d{2})/,
      /截止.*?(\d{4}[年\-\/]\d{1,2}[月\-\/]\d{1,2}日?)/,
      /截止.*?(\d{1,2}[月\/]\d{1,2}日?)/
    ];

    const text = (el.textContent || '').trim();
    for (const pattern of deadlinePatterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }

    return null;
  }

  // ─── Utility Functions ────────────────────────────────

  function getCurrentHashRoute() {
    const hash = window.location.hash;
    if (!hash || hash === '#') return '';
    return hash.startsWith('#/') ? hash.slice(1) : hash.slice(1);
  }

  function isHomeworkRelevantRoute(route) {
    if (!route) return false;

    // Any /learn/ page is potentially relevant
    // The buildHomeworkItem deadline filter will skip non-homework items
    return ALLOWED_ROUTES.some(r => route.startsWith(r));
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

      // SPOC 诊断日志
      if (isSpoc) {
        console.log('[MOOC Reminder] SPOC course detected:', JSON.stringify({ schoolCourseId, termId, school, pathParts }));
      }

      return { schoolCourseId, school, courseId: schoolCourseId, termId, isSpoc };
    } catch {
      return { schoolCourseId: '', school: '', courseId: '', termId: '', isSpoc: false };
    }
  }

  function isLoginWall() {
    const loginSelectors = [
      '.login-form', '.j-login', '.m-login', '#login-form',
      '.login-container', '.j-loginForm'
    ];
    return loginSelectors.some(sel => {
      try { return !!document.querySelector(sel); } catch { return false; }
    });
  }

 function extractId(el, attrNames) {
    function fromElement(target) {
      if (!target) return '';
      for (const name of attrNames) {
        const val = target.getAttribute && target.getAttribute(name);
        if (val) return val;
      }
      const href = target.getAttribute && target.getAttribute('href');
      if (href) {
        const idMatch = href.match(/[?&](?:id|testId|quizId|examId|homeworkId)=(\d+)/i);
        if (idMatch) return idMatch[1];
        const contentMatch = href.match(/[?&]contentId=(\d+)/i);
        if (contentMatch) return contentMatch[1];
      }
      return '';
    }

    const ownId = fromElement(el);
    if (ownId) return ownId;

    try {
      const child = el.querySelector('[data-test-id], [data-testid], [data-homework-id], [data-homeworkid], [data-hwid], [data-id], [data-content-id], a[href], .j-quizBtn[href]');
      return fromElement(child);
    } catch {
      return '';
    }
  }

  function hashFromText(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return 'hw_' + (hash >>> 0).toString(16).padStart(8, '0');
  }

  function inferDeadlineYear(month, day, hour, minute) {
    const now = new Date();
    let year = now.getFullYear();
    const candidate = new Date(
      year,
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hour || '23'),
      parseInt(minute || '59'),
      0,
      0
    );

    // Keep recently-past dates as overdue, but roll distant past dates into
    // next year. This avoids parsing January deadlines as last January when
    // a course shows dates without a year near the semester boundary.
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    if (!isNaN(candidate.getTime()) && candidate.getTime() < now.getTime() - sevenDaysMs) {
      year += 1;
    }
    return String(year);
  }

  function parseChineseDateInline(raw) {
    // Simple inline parser — mirrors date-utils.js logic
    if (!raw) return null;

    // "2026年6月30日 23:59"
    let match = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?\s*(\d{1,2}):(\d{2})/);
    if (match) {
      return formatISO(match[1], match[2], match[3], match[4], match[5]);
    }

    // "2026-06-30 23:59"
    match = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T\s](\d{1,2}):(\d{2})/);
    if (match) {
      return formatISO(match[1], match[2], match[3], match[4], match[5]);
    }

    // "6月30日 23:59" (no year)
    match = raw.match(/(\d{1,2})月(\d{1,2})日?\s*(\d{1,2}):(\d{2})/);
    if (match) {
      const year = inferDeadlineYear(match[1], match[2], match[3], match[4]);
      return formatISO(year, match[1], match[2], match[3], match[4]);
    }


    // "2026年6月30日" (date only)
    match = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
    if (match) {
      return formatISO(match[1], match[2], match[3], '23', '59');
    }

    // "2026-06-30" (date only)
    match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (match) {
      return formatISO(match[1], match[2], match[3], '23', '59');
    }

    // "6月30日" (date only, no year)
    match = raw.match(/(\d{1,2})月(\d{1,2})日?/);
    if (match) {
      const year = inferDeadlineYear(match[1], match[2], '23', '59');
      return formatISO(year, match[1], match[2], '23', '59');
    }

    return null;
  }

  function formatISO(year, month, day, hour, minute) {
    const y = parseInt(year), mo = parseInt(month) - 1, d = parseInt(day);
    const h = parseInt(hour), m = parseInt(minute);
    const date = new Date(y, mo, d, h, m, 0, 0);
    if (isNaN(date.getTime())) return null;

    const pad = (n) => String(n).padStart(2, '0');
    const tzOffset = -date.getTimezoneOffset();
    const tzSign = tzOffset >= 0 ? '+' : '-';
    const tzHour = pad(Math.floor(Math.abs(tzOffset) / 60));
    const tzMin = pad(Math.abs(tzOffset) % 60);

    return `${y}-${pad(mo + 1)}-${pad(d)}T${pad(h)}:${pad(m)}:00${tzSign}${tzHour}:${tzMin}`;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function loadSelectorConfig() {
    const url = chrome.runtime.getURL(SELECTOR_CONFIG_PATH);
    const response = await fetch(url);
    return response.json();
  }

  function getDefaultSelectors() {
    // Minimal default selectors as fallback
    return {
      coursePage: {
        courseName: { primary: 'h1', fallback: ['title'] },
        schoolName: { primary: '.school', fallback: [] },
        chapterContainer: { primary: '[class*="chapter"]', fallback: [] },
        chapterItems: { primary: '[class*="chapterItem"], [class*="chapter-item"]', fallback: [] },
        lessonItems: { primary: '[class*="lesson"]', fallback: [] }
      },
      homeworkDetection: {
        homeworkRow: { primary: '[class*="test"], [class*="homework"]', fallback: ['a'] },
        homeworkTitle: { primary: 'a', fallback: ['span'] },
        statusIndicator: {
          completed: { classPatterns: ['done', 'finished', 'completed'], textPatterns: ['已完成', '已提交'] },
          submitted: { classPatterns: ['submitted'], textPatterns: ['已提交'] },
          unfinished: { classPatterns: ['undone', 'todo'], textPatterns: ['未完成', '待提交'] }
        }
      }
    };
  }

  // ─── Batch API Fetch (page-context) ───────────────────
  // Runs in the icourse163.org origin, so cookies + CSRF are
  // handled automatically by the browser. GinsMooc-inspired.
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

    var csrf = '';
    try {
      var m = document.cookie.match(/NTESSTUDYSI=([a-z0-9]+);?/i);
      csrf = m ? m[1] : '';
    } catch {}
    if (!csrf) {
      console.log('[MOOC Reminder] No NTESSTUDYSI cookie found, cannot do API fetches');
      return [];
    }

    var results = [];
    var isSpocPage = pageMeta && pageMeta.isSpoc;
    for (var i = 0; i < courses.length; i++) {
      var c = courses[i];
      if (!c || !c.termId) continue;

      var courseIsSpoc = isSpocPage || (c.courseType === 'spoc');
      if (courseIsSpoc) {
        console.log('[MOOC Reminder] SPOC API fetch for:', c.courseId, 'termId:', c.termId, 'courseName:', c.courseName);
      }

      try {
        // ═══ API 端点链式 fallback ═══
        // 不同课程类型（MOOC/SPOC）接受的参数格式可能不同
        var text = null;

        // 1) 首选：getMocTermDto.rpc + form body（SW 后台同款，MOOC 课程验证可用）
        try {
          var url1 = 'https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=' + encodeURIComponent(csrf);
          var body1 = 'termId=' + encodeURIComponent(c.termId) + '&gatewayType=3';
          text = await new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', url1, true);
            xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
            xhr.onload = function() { resolve(xhr.responseText); };
            xhr.onerror = function() { reject(new Error('XHR failed')); };
            xhr.send(body1);
          });
          if (courseIsSpoc) {
            console.log('[MOOC Reminder] SPOC endpoint 1 (getMocTermDto+gatewayType): len=' + text.length, 'preview:', text.substring(0, 150));
          }
          // 如果返回错误（code != 0），尝试下一步
          if (text.length < 100 || /"code":-/.test(text)) {
            if (courseIsSpoc) console.log('[MOOC Reminder] SPOC: endpoint 1 returned error/too-short, trying next...');
            text = null;
          }
        } catch(e1) { text = null; }

        // 2) getMocTermDto.rpc 不带 gatewayType
        if (!text) {
          try {
            var url2 = 'https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=' + encodeURIComponent(csrf);
            var body2 = 'termId=' + encodeURIComponent(c.termId);
            text = await new Promise(function(resolve, reject) {
              var xhr2 = new XMLHttpRequest();
              xhr2.open('POST', url2, true);
              xhr2.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
              xhr2.onload = function() { resolve(xhr2.responseText); };
              xhr2.onerror = function() { reject(new Error('XHR failed')); };
              xhr2.send(body2);
            });
            if (courseIsSpoc) {
              console.log('[MOOC Reminder] SPOC endpoint 2 (getMocTermDto no gatewayType): len=' + text.length, 'preview:', text.substring(0, 150));
            }
            if (text.length < 100 || /"code":-/.test(text)) {
              if (courseIsSpoc) console.log('[MOOC Reminder] SPOC: endpoint 2 also failed, trying Spoc endpoint...');
              text = null;
            }
          } catch(e2) { text = null; }
        }

        // 3) SPOC: getSpocTermDto.rpc（不带 gatewayType）
        if (!text && courseIsSpoc) {
          try {
            var url3 = 'https://www.icourse163.org/web/j/courseBean.getSpocTermDto.rpc?csrfKey=' + encodeURIComponent(csrf);
            var body3 = 'termId=' + encodeURIComponent(c.termId);
            text = await new Promise(function(resolve, reject) {
              var xhr3 = new XMLHttpRequest();
              xhr3.open('POST', url3, true);
              xhr3.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
              xhr3.onload = function() { resolve(xhr3.responseText); };
              xhr3.onerror = function() { reject(new Error('XHR failed')); };
              xhr3.send(body3);
            });
            console.log('[MOOC Reminder] SPOC endpoint 3 (getSpocTermDto): len=' + text.length, 'preview:', text.substring(0, 150));
            if (text.length < 100 || /"code":-/.test(text)) {
              console.log('[MOOC Reminder] SPOC: endpoint 3 also failed, falling back to LastLearned...');
              text = null;
            }
          } catch(e3) { text = null; }
        }

        // 4) 最终 fallback: getLastLearnedMocTermDto.rpc (JSON body) — 之前可用但数据有限
        if (!text) {
          try {
            var url4 = 'https://www.icourse163.org/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey=' + encodeURIComponent(csrf);
            var body4 = JSON.stringify({ termId: parseInt(c.termId, 10) });
            text = await new Promise(function(resolve, reject) {
              var xhr4 = new XMLHttpRequest();
              xhr4.open('POST', url4, true);
              xhr4.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
              xhr4.onload = function() { resolve(xhr4.responseText); };
              xhr4.onerror = function() { reject(new Error('XHR failed')); };
              xhr4.send(body4);
            });
            console.log('[MOOC Reminder] endpoint 4 (getLastLearnedMocTermDto fallback): len=' + text.length, 'preview:', text.substring(0, 150));
          } catch(e4) { text = null; }
        }

        if (!text || text.length < 50) { console.debug('[MOOC Reminder] API empty/failed for', c.courseId, '(type:', c.courseType || 'unknown', ') textLen:', text ? text.length : 0); continue; }
        results.push({
          course: { courseId: c.courseId, termId: c.termId, courseName: c.courseName || '', schoolName: c.schoolName || '' },
          rawData: text
        });
      } catch(e) {
        console.debug('[MOOC Reminder] API fetch error for', c.courseId, e.message);
      }
    }
    // 逐个发送 COURSE_API_DATA 给 SW 处理，捕获 SW 返回的结果
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

  // ─── Boot ─────────────────────────────────────────────
  init().catch(err => {
    console.error('[MOOC Reminder] Initialization failed:', err);
  });
})();
