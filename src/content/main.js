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
    // Check for quiz/exam page specific containers
    const quizExamIndicators = [
      // 测验与作业 页面容器
      '.j-quizlist', '.m-quizlist', '.quiz-list',
      '.j-testlist', '.m-testlist', '.test-list',
      // 考试 页面容器
      '.j-examlist', '.m-examlist', '.exam-list',
      // 通用列表容器
      '.j-list-container', '.m-list-container',
      // 表格行 (某些课程用表格展示)
      'table tr', '.j-table-row',
      // Fallback: any element with quiz/test/exam in class
      '[class*="quiz"]', '[class*="test"]', '[class*="exam"]',
      // Generic: any div with substantial content
      '.j-content-body', '.m-content-body'
    ];

    for (const sel of quizExamIndicators) {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim().length > 10) return true;
      } catch { /* skip */ }
    }

    return false;
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
    const route = getCurrentHashRoute();

    // ── 策略: 测验与作业 / 考试 页面 ──
    // These pages have a flat list structure:
    //   - Table rows or list items, each representing one quiz/homework/exam
    //   - Each row has: title, type, deadline, status, score

    // Find all quiz/exam list items
    const rowElements = findQuizExamRows();

    if (rowElements.length > 0) {
      for (const rowEl of rowElements) {
        try {
          const item = buildHomeworkItem(rowEl, urlMeta, courseMeta, '', '');
          if (item) items.push(item);
        } catch (e) {
          console.debug('[MOOC Reminder] buildHomeworkItem failed for row:', e.message);
        }
      }
    }

    // Fallback: if no rows found, try searching for homework-like elements
    if (items.length === 0) {
      const allElements = document.querySelectorAll(
        'tr, li, .j-quiz-item, .m-quiz-item, .j-test-item, .m-test-item, ' +
        '[class*="quizItem"], [class*="testItem"], [class*="examItem"], ' +
        '.j-list-item, .m-list-item, [class*="list-item"]'
      );

      for (const el of allElements) {
        try {
          const text = (el.textContent || '').trim();
          if (/作业|测验|考试|测试|quiz|exam|test/i.test(text) &&
              text.length > 4 && text.length < 300 &&
              !/加载中|loading/i.test(text)) {
            const item = buildHomeworkItem(el, urlMeta, courseMeta, '', '');
            if (item) items.push(item);
          }
        } catch (e) {
          console.debug('[MOOC Reminder] buildHomeworkItem failed for fallback el:', e.message);
        }
      }
    }

    // Deduplicate by title+deadline
    const seen = new Set();
    return items.filter(item => {
      const key = `${item.title}_${item.deadline || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Find quiz/exam list rows on the page.
   * icourse163.org quiz/exam pages typically use tables or structured divs.
   */
  function findQuizExamRows() {
    // Strategy 1: Look for table rows in quiz/exam containers
    const tableSelectors = [
      '.j-quizlist table tr', '.m-quizlist table tr',
      '.j-testlist table tr', '.m-testlist table tr',
      '.j-examlist table tr', '.m-examlist table tr',
      'table.j-table tr', 'table.m-table tr',
      'table tbody tr'
    ];

    for (const sel of tableSelectors) {
      try {
        const rows = document.querySelectorAll(sel);
        // Filter: only keep rows with text content (skip header rows with all <th>)
        const dataRows = Array.from(rows).filter(row => {
          const text = (row.textContent || '').trim();
          const hasTH = row.querySelectorAll('th').length > 0;
          const hasTD = row.querySelectorAll('td').length > 0;
          return text.length > 5 && (!hasTH || hasTD);
        });
        if (dataRows.length > 0) return dataRows;
      } catch { /* skip */ }
    }

    // Strategy 2: Look for structured div/card items
    const divSelectors = [
      '.j-quiz-item', '.m-quiz-item', '.quiz-item',
      '.j-test-item', '.m-test-item', '.test-item',
      '.j-exam-item', '.m-exam-item', '.exam-item',
      '[class*="quizItem"]', '[class*="testItem"]',
      '[class*="examItem"]',
      '.j-list-item', '.m-list-item',
      '[class*="listItem"]', '[class*="list-item"]'
    ];

    for (const sel of divSelectors) {
      try {
        const items = document.querySelectorAll(sel);
        const validItems = Array.from(items).filter(el => {
          const text = (el.textContent || '').trim();
          return text.length > 4 && !/加载中|loading/i.test(text);
        });
        if (validItems.length > 0) return validItems;
      } catch { /* skip */ }
    }

    return [];
  }

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

    // Detect status — use broader check that includes score and 互评
    const isDone = checkCompleted(el, text);
    const hasScore = (score !== null && totalScore !== null);
    const isPeerReviewDone = /已互评|互评已完成|已评价|已评分|互评结束/i.test(text);
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

    // Extract score
    const scoreMatch = text.match(/(\d+\.?\d*)\s*[\/分]\s*(\d+\.?\d*)/);
    let score = null, totalScore = null;
    if (scoreMatch) {
      score = parseFloat(scoreMatch[1]);
      totalScore = parseFloat(scoreMatch[2]);
    }

    // Clean title: remove deadline, score, status-like fragments
    let title = text.split(/截止|deadline|due|提交|submitted/i)[0].trim();
    if (!title || title.length < 2) title = text.substring(0, 40);

    // ── Filter: skip section headers (no deadline + looks like a label) ──
    if (!deadlineRaw && !hasScore) {
      // Known section headers on icourse163.org
      if (/^(测验与作业|考试|课件|公告|讨论区|评分标准|课程介绍)\s*$/.test(title)) {
        return null;
      }
      // Generic: very short text without deadline is probably a header
      if (title.length <= 6 && /^[一-龥\s]+$/.test(title)) {
        return null;
      }
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
