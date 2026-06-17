/**
 * Base scraper class for icourse163.org page scraping.
 *
 * Provides common utilities for:
 * - Querying elements with primary + fallback selectors
 * - Detecting login wall
 * - Checking for loading state
 * - Safe text extraction
 */

export class BaseScraper {
  /**
   * @param {Object} selectorConfig - The loaded selectors.json object
   */
  constructor(selectorConfig) {
    this.config = selectorConfig;
  }

  /**
   * Try to find an element using primary then fallback selectors.
   * @param {Object} selectorDef - { primary: string, fallback: string[] }
   * @param {Element} [root=document] - Root element to query from
   * @returns {Element|null}
   */
  querySelector(selectorDef, root = document) {
    if (!selectorDef) return null;

    // Try primary
    if (selectorDef.primary) {
      try {
        const el = root.querySelector(selectorDef.primary);
        if (el) return el;
      } catch { /* invalid selector */ }
    }

    // Try fallbacks
    if (selectorDef.fallback) {
      for (const sel of selectorDef.fallback) {
        try {
          const el = root.querySelector(sel);
          if (el) return el;
        } catch { /* invalid selector */ }
      }
    }

    return null;
  }

  /**
   * Try to find all elements matching primary then fallback selectors.
   * Returns results from the first selector that matches anything.
   * @param {Object} selectorDef
   * @param {Element} [root=document]
   * @returns {Element[]}
   */
  querySelectorAll(selectorDef, root = document) {
    if (!selectorDef) return [];

    const tryQuery = (sel) => {
      try {
        const nodes = root.querySelectorAll(sel);
        return nodes.length > 0 ? Array.from(nodes) : null;
      } catch {
        return null;
      }
    };

    if (selectorDef.primary) {
      const result = tryQuery(selectorDef.primary);
      if (result) return result;
    }

    if (selectorDef.fallback) {
      for (const sel of selectorDef.fallback) {
        const result = tryQuery(sel);
        if (result) return result;
      }
    }

    return [];
  }

  /**
   * Safely extract text content from an element, trimming whitespace.
   * @param {Element} el
   * @returns {string}
   */
  getText(el) {
    if (!el) return '';
    return (el.textContent || '').trim();
  }

  /**
   * Check if the user is on a login page (not course content).
   * @returns {boolean}
   */
  isLoginWall() {
    const loginSelectors = this.config.loginWall?.selectors || [];
    return loginSelectors.some(sel => {
      try {
        return !!document.querySelector(sel);
      } catch {
        return false;
      }
    });
  }

  /**
   * Check if the page is still loading content.
   * @returns {boolean}
   */
  isLoading() {
    const loadingSelectors = this.config.loadingIndicator?.selectors || [];
    return loadingSelectors.some(sel => {
      try {
        const el = document.querySelector(sel);
        return el && el.offsetParent !== null;
      } catch {
        return false;
      }
    });
  }

  /**
   * Check if an element's class list or text content indicates completion.
   * @param {Element} el - The homework item element
   * @returns {boolean}
   */
  isCompleted(el) {
    if (!el) return false;

    const statusConfig = this.config.homeworkDetection?.statusIndicator;
    if (!statusConfig) return false;

    const className = el.className || '';
    const text = this.getText(el);

    // Check class patterns for "completed"
    const completedPatterns = statusConfig.completed?.classPatterns || [];
    for (const pattern of completedPatterns) {
      if (className.includes(pattern)) return true;
    }

    // Check text patterns for "completed"
    const completedTexts = statusConfig.completed?.textPatterns || [];
    for (const pattern of completedTexts) {
      if (text.includes(pattern)) return true;
    }

    // Also check child elements for status indicators
    const allChildren = el.querySelectorAll('*');
    for (const child of allChildren) {
      const childClass = child.className || '';
      for (const pattern of completedPatterns) {
        if (childClass.includes(pattern)) return true;
      }
    }

    return false;
  }

  /**
   * Check if an element indicates "submitted" (but not yet graded).
   * @param {Element} el
   * @returns {boolean}
   */
  isSubmitted(el) {
    if (!el) return false;

    const statusConfig = this.config.homeworkDetection?.statusIndicator;
    if (!statusConfig) return false;

    const className = el.className || '';
    const text = this.getText(el);

    const submittedPatterns = statusConfig.submitted?.classPatterns || [];
    for (const pattern of submittedPatterns) {
      if (className.includes(pattern)) return true;
    }

    const submittedTexts = statusConfig.submitted?.textPatterns || [];
    for (const pattern of submittedTexts) {
      if (text.includes(pattern)) return true;
    }

    return false;
  }

  /**
   * Detect homework type from element text.
   * @param {string} text
   * @returns {string} "homework" | "quiz" | "exam" | "discussion" | "unknown"
   */
  detectType(text) {
    if (!text) return 'unknown';

    const typeConfig = this.config.homeworkDetection?.homeworkTypeIndicator;
    if (!typeConfig) return 'unknown';

    for (const [type, patterns] of Object.entries(typeConfig)) {
      for (const pattern of patterns) {
        if (text.includes(pattern)) return type;
      }
    }

    return 'homework'; // default to homework
  }

  /**
   * Extract numeric IDs from DOM data attributes or URL params.
   * Tries multiple common attribute patterns.
   * @param {Element} el
   * @returns {{ chapterId: string, lessonId: string, homeworkId: string }}
   */
  extractIds(el) {
    const getAttr = (names) => {
      for (const name of names) {
        const val = el.getAttribute(name);
        if (val) return val;
      }
      return '';
    };

    return {
      chapterId: getAttr([
        'data-chapter-id', 'data-chapterid', 'data-chapterId',
        'chapter-id', 'chapterid',
        'data-ch', 'data-chapter'
      ]),
      lessonId: getAttr([
        'data-lesson-id', 'data-lessonid', 'data-lessonId',
        'lesson-id', 'lessonid',
        'data-le', 'data-lesson'
      ]),
      homeworkId: getAttr([
        'data-test-id', 'data-testid', 'data-homework-id',
        'data-homeworkid', 'data-hwid',
        'test-id', 'homework-id',
        'data-id', 'data-content-id'
      ])
    };
  }

  /**
   * Try to parse the deadline from an element's text.
   * @param {Element} el
   * @returns {{ deadline: string|null, deadlineRaw: string|null }}
   */
  extractDeadline(el) {
    const deadlineConfig = this.config.homeworkDetection?.deadline;
    if (!deadlineConfig) return { deadline: null, deadlineRaw: null };

    // Try to find a dedicated deadline element
    let deadlineEl = this.querySelector(deadlineConfig, el);
    if (!deadlineEl) {
      // Search within all children for deadline-like text
      const allChildren = el.querySelectorAll('*');
      for (const child of allChildren) {
        const text = this.getText(child);
        if (text && /截止|结束|deadline|due|end/i.test(text)) {
          deadlineEl = child;
          break;
        }
      }
    }

    if (deadlineEl) {
      const raw = this.getText(deadlineEl);
      if (raw) {
        return { deadlineRaw: raw, deadline: null }; // Will be parsed by date-utils
      }
    }

    return { deadline: null, deadlineRaw: null };
  }
}
