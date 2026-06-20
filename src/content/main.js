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

  // ─── Initialization ───────────────────────────────────

  async function init() {
    // Load selector configuration
    try {
      selectorConfig = await loadSelectorConfig();
    } catch (e) {
      console.error('[MOOC Reminder] Failed to load selectors:', e);
      selectorConfig = getDefaultSelectors();
    }

    // Detect current route
    currentRoute = getCurrentHashRoute();

    // Diagnostic: log route detection status
    console.log('[MOOC Reminder] Initialized. Route:', `"${currentRoute}"`, '| Allowed:', isHomeworkRelevantRoute(currentRoute));
    console.log('[MOOC Reminder] URL:', window.location.href);
    console.log('[MOOC Reminder] Strategy: scrape all /learn/ pages, filter by deadline presence');

    // Start observers
    setupUrlObserver();
    setupDomObserver();

    // Initial scrape if on relevant page
    if (isHomeworkRelevantRoute(currentRoute)) {
      waitAndScrape();
    }

    // Periodic re-scrape on relevant pages (every 30s)
    setInterval(() => {
      const route = getCurrentHashRoute();
      if (isHomeworkRelevantRoute(route)) {
        waitAndScrape();
      }
    }, 30000);

    // Listen for background requests
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
      return false;
    });

    console.log('[MOOC Reminder] Content script initialized');
  }

  // ─── URL Observation ──────────────────────────────────

  function setupUrlObserver() {
    // Layer 1: hashchange event
    window.addEventListener('hashchange', () => {
      const newRoute = getCurrentHashRoute();
      if (newRoute !== currentRoute) {
        currentRoute = newRoute;
        if (isHomeworkRelevantRoute(newRoute)) {
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
        return null;
      }

      if (data && data.homeworkItems && data.homeworkItems.length > 0) {
        // Send to background
        try {
          await chrome.runtime.sendMessage({
            type: 'HOMEWORK_DATA',
            course: data.course,
            homeworkItems: data.homeworkItems
          });
          console.log(`[MOOC Reminder] Scraped ${data.homeworkItems.length} items from ${data.course.courseName}`);
        } catch (e) {
          console.error('[MOOC Reminder] Failed to send data to background:', e);
        }
      }
      return data;
    } catch (e) {
      console.error('[MOOC Reminder] Scrape failed:', e.message);
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
    // 不依赖特定类名，只要页面有可见内容且 loading 消失即可。
    // 具体元素筛选交给 scrapeHomeworkItems 做文本扫描。
    try {
      // Loading indicator 消失
      const loading = document.querySelector('.j-loading, .m-loading, .loading-spinner, [class*="loading"]');
      if (loading && loading.offsetParent !== null) return false;

      // 页面有可见的内容区域即可
      const body = document.body;
      if (!body) return false;

      // 关键检查：body 有文本内容且不是空壳框架
      const textLen = (body.textContent || '').trim().length;
      return textLen > 20;
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

  function scrapePage() {
    if (!selectorConfig) {
      selectorConfig = getDefaultSelectors();
    }

    // Check for login wall
    if (isLoginWall()) {
      console.log('[MOOC Reminder] Login wall detected, skipping scrape');
      return null;
    }

    // Parse URL metadata
    const urlMeta = parseCourseUrl(window.location.href);

    // Scrape course metadata
    const meta = scrapeCourseMeta();

    // Scrape homework items
    const homeworkItems = scrapeHomeworkItems(urlMeta, meta);

    return {
      course: {
        courseId: urlMeta.courseId,
        termId: urlMeta.termId,
        courseName: meta.courseName,
        schoolName: meta.schoolName,
        courseType: urlMeta.isSpoc ? 'spoc' : 'mooc',
        courseUrl: window.location.href
      },
      homeworkItems: homeworkItems
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

    // ── 全页面文本扫描 ──
    // 不依赖任何特定 CSS 类名，直接扫描页面所有元素中的作业相关文本
    // 然后用截止日期过滤噪音

    // 第一步：扫描所有元素，提取包含作业关键词的文本
    const candidates = [];
    const allEls = document.querySelectorAll('div, li, tr, td, span, a, p, section');

    for (const el of allEls) {
      try {
        const text = (el.textContent || '').trim();
        if (text.length < 4 || text.length > 500) continue;
        if (/加载中|loading|请稍候|spinner/i.test(text)) continue;

        // 跳过已知的导航/菜单/UI文本
        if (/^(测验与作业|考试|课件|公告|讨论区|评分标准|课程介绍|首页|我的学习|我的课程|我的成绩|我的证书)\s*$/.test(text)) continue;
        // 跳过纯表头行（只含列名不含数据）
        if (/^(作业名称|作业标题|考试名称|测验名称|截止日期|提交时间|状态|成绩|操作)\s*$/.test(text)) continue;
        // 跳过按钮/提醒/UI文字（含有这些关键词但不是作业条目）
        if (/一键互评|自动互评|获取答案|不再提醒|查看帮助|使用插件前.*?看看.*?有没有问题/i.test(text)) continue;
        // 跳过导航栏（多个板块名连在一起）
        if (/^(公告课件|课件测验|测验与作业|作业考试|考试讨论)/i.test(text)) continue;
        // 跳过空状态提示
        if (/老师还没有发布|暂无.*(测试|作业|考试)|敬请期待|请耐心等待/i.test(text)) continue;
        // 条件A：包含作业关键词
        // 条件B：包含截止日期（YYYY-MM-DD或YYYY年MM月DD日等格式）
        // 条件C：包含分数（如 95/100）
        // 条件D：包含状态关键词（已完成/未完成等）

        const hasHomeworkKeyword = /作业|测验|考试|测试|quiz|exam|test|homework/i.test(text);
        const hasDeadlinePattern = /(\d{4}[年\-/]\d{1,2}[月\-/]\d{1,2}日?)/.test(text);
        const hasScorePattern   = /\d+\.?\d*\s*[\/分]\s*\d+\.?\d*/.test(text);
        const hasStatusKeyword  = /未完成|已完成|已提交|已批阅|待提交|已通过|待批阅|去完成|查看成绩|已截止|查看分数|已互评|已评价|已评分|互评结束|得分/i.test(text);
        const hasDeadlineLabel  = /截止|deadline|due|提交时间|结束时间/i.test(text);

        // 准入：满足至少一个条件
        if (!hasHomeworkKeyword && !hasDeadlinePattern && !hasScorePattern && !hasStatusKeyword && !hasDeadlineLabel) continue;

        // 提取截止日期（含更多格式）
        const deadlineMatch =
          text.match(/(\d{4}[年\-/]\d{1,2}[月\-/]\d{1,2}日?\s*\d{1,2}:\d{2})/) ||
          text.match(/(\d{1,2}[月\/]\d{1,2}日?\s*\d{1,2}:\d{2})/);

        candidates.push({
          el: el,
          text: text,
          deadlineRaw: deadlineMatch ? deadlineMatch[1] : null,
          hasDeadline: !!deadlineMatch,
          score: text.match(/(\d+\.?\d*)\s*[\/分]\s*(\d+\.?\d*)/)
        });
      } catch {}
    }

    console.log('[MOOC Reminder] Found', candidates.length, 'homework-related elements on page');

    // 第二步：去重 — 只保留最内层的元素（避免父元素和子元素重复）
    const used = new Set();
    for (const c of candidates) {
      let isInner = true;
      for (const other of candidates) {
        if (c.el === other.el) continue;
        if (c.el !== document && other.el.contains(c.el)) {
          isInner = false;
          break;
        }
      }
      if (isInner) {
        const key = c.text.substring(0, 50) + (c.deadlineRaw || '');
        if (!used.has(key)) {
          used.add(key);
          const item = buildHomeworkItem(c.el, urlMeta, courseMeta, '', '');
          if (item) items.push(item);
        }
      }
    }

    console.log('[MOOC Reminder] After dedup and build: got', items.length, 'items');

    // 第三步：如果还一个都没有，输出诊断信息
    if (items.length === 0) {
      console.log('[MOOC Reminder] DIAGNOSTIC: no items found. Page class names sample:');
      const samples = new Set();
      const allWithClass = document.querySelectorAll('[class]');
      allWithClass.forEach(function(el) {
        var cls = el.className;
        if (typeof cls === 'string' && cls.length > 3 && cls.length < 100) {
          samples.add(cls);
        }
      });
      var clsList = Array.from(samples).slice(0, 30);
      clsList.forEach(function(c) { console.log('  [CLASS]', c); });
    }

    return items;
  }

  /**
   * Find quiz/exam list rows on the page.
   * icourse163.org quiz/exam pages typically use tables or structured divs.
   */
  function buildHomeworkItem(el, urlMeta, courseMeta, chapterId, lessonId) {
    const text = (el.textContent || '').trim();

    // Skip if element doesn't look like a homework item
    if (text.length < 2) return null;
    if (/加载中|loading|请稍候|spinner/i.test(text)) return null;

    // Extract homework ID
    const homeworkId = extractId(el, [
      'data-test-id', 'data-testid', 'data-homework-id',
      'data-homeworkid', 'data-hwid', 'data-id', 'data-content-id'
    ]) || hashFromText(text);

    // Generate UID
    const uid = `${urlMeta.courseId}_tid${urlMeta.termId}_ch${chapterId}_le${lessonId}_hw${homeworkId}`;

    // Detect type
    let type = 'homework';
    if (/测验|quiz/i.test(text)) type = 'quiz';
    else if (/考试|exam/i.test(text)) type = 'exam';
    else if (/讨论|discussion/i.test(text)) type = 'discussion';

    // Extract score FIRST so hasScore can use it (avoid JS Temporal Dead Zone)
    const scoreMatch = text.match(/(\d+\.?\d*)\s*[\/分]\s*(\d+\.?\d*)/);
    let score = null, totalScore = null;
    if (scoreMatch) {
      score = parseFloat(scoreMatch[1]);
      totalScore = parseFloat(scoreMatch[2]);
    }

    // Detect status — use broader check that includes score and 互评
    const isDone = checkCompleted(el, text);
    const hasScore = (score !== null && totalScore !== null);
    const isPeerReviewDone = /^已互评$|互评已完成|^已评价$|^已评分$|互评结束|已完成互评|互评已结束|互评得分|同伴互评.*已完成/i.test(text);
    const effectivelyDone = isDone || hasScore || isPeerReviewDone;

    let status = 'unfinished';
    if (effectivelyDone) status = 'completed';
    else if (/已提交|submitted/i.test(text)) status = 'submitted';

    // Extract deadline
    const deadlineRaw = extractDeadlineText(el);
    let deadline = null;
    if (deadlineRaw) {
      deadline = parseChineseDateInline(deadlineRaw);
    }

    // Clean title: remove deadline, score, status-like fragments
    let title = text.split(/截止|deadline|due|提交|submitted/i)[0].trim();
    if (!title || title.length < 2) title = text.substring(0, 40);

    // ── Filter: skip known UI/noise titles ──
    if (/一键互评|自动互评|获取答案|不再提醒|查看帮助|使用插件前/i.test(title)) {
      return null;
    }

    // ── Filter: 没有截止日期也没有分数 → 不是有效作业 ──
    if (!deadlineRaw && !hasScore) {
      return null;
    }

    return {
      uid,
      courseId: urlMeta.courseId,
      termId: urlMeta.termId,
      chapterId,
      lessonId,
      homeworkId,
      title,
      type,
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
      '已完成', '已提交', '已批阅', '已通过', '得分',
      '已互评', '互评已完成', '已评价', '已评分',
      '成绩', '查看成绩', '查看分数'
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
    // Search for deadline-related text in and around the element
    const deadlinePatterns = [
      /(\d{4}[年\-\/]\d{1,2}[月\-\/]\d{1,2}日?\s*\d{1,2}:\d{2})/,
      /(\d{1,2}[月\/]\d{1,2}日?\s*\d{1,2}:\d{2})/,
      /截止.*?(\d{4}[年\-\/]\d{1,2}[月\-\/]\d{1,2}日?)/,
      /截止.*?(\d{1,2}[月\/]\d{1,2}日?)/
    ];

    // Check element text
    const text = (el.textContent || '').trim();
    for (const pattern of deadlinePatterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }

    // Check parent and sibling text
    const parent = el.parentElement;
    if (parent) {
      const parentText = (parent.textContent || '').trim();
      for (const pattern of deadlinePatterns) {
        const match = parentText.match(pattern);
        if (match) return match[1];
      }
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
    for (const name of attrNames) {
      const val = el.getAttribute(name);
      if (val) return val;
    }
    // Try to extract from href
    const href = el.getAttribute('href');
    if (href) {
      const idMatch = href.match(/[?&]id=(\d+)/);
      if (idMatch) return idMatch[1];
      const contentMatch = href.match(/[?&]contentId=(\d+)/);
      if (contentMatch) return contentMatch[1];
    }
    return '';
  }

  function hashFromText(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return 'hw_' + (hash >>> 0).toString(16).padStart(8, '0');
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
      const year = new Date().getFullYear().toString();
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

  // ─── Boot ─────────────────────────────────────────────
  init().catch(err => {
    console.error('[MOOC Reminder] Initialization failed:', err);
  });
})();
