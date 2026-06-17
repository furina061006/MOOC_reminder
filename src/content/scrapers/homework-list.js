/**
 * Homework list page scraper for icourse163.org.
 *
 * Some course layouts have a dedicated homework list page
 * (e.g., #/learn/content?type=detail&id=xxx or #/learn/homework)
 * that lists all homework items more directly.
 */

import { BaseScraper } from './base.js';

export class HomeworkListScraper extends BaseScraper {
  constructor(selectorConfig) {
    super(selectorConfig);
  }

  /**
   * Scrape all homework items from a homework list page.
   * This is a flatter structure than the course page — all
   * homework items are in a single list.
   *
   * @returns {Array} Array of raw homework item objects
   */
  scrapeHomeworkItems() {
    const items = [];
    const hwConfig = this.config.homeworkDetection;

    // Try to find a dedicated homework list container
    const listContainer =
      document.querySelector('.j-homeworklist, .m-homeworklist, .homework-list') ||
      document.querySelector('[class*="homework"], [class*="test-list"]') ||
      document.body;

    // Find all homework rows
    const rows = this.querySelectorAll(hwConfig?.homeworkRow, listContainer);

    if (rows.length === 0) {
      // Fallback: look for any elements that contain homework-like text
      const allElements = listContainer.querySelectorAll('div, li, tr, a');
      for (const el of allElements) {
        const text = this.getText(el);
        if (text && /作业|测验|考试|讨论|homework|quiz|exam/i.test(text)) {
          rows.push(el);
        }
      }
    }

    for (const row of rows) {
      const item = this._scrapeSingleHomework(row);
      if (item) {
        items.push(item);
      }
    }

    return items;
  }

  /**
   * Scrape a single homework row element.
   */
  _scrapeSingleHomework(el) {
    const hwConfig = this.config.homeworkDetection;

    // Extract title
    const titleEl = this.querySelector(hwConfig?.homeworkTitle, el);
    const title = this.getText(titleEl) || this.getText(el);
    if (!title || title.length < 2) return null;
    if (/加载中|loading|请稍候/i.test(title)) return null;

    // Extract IDs
    const ids = this.extractIds(el);

    // Detect type
    const type = this.detectType(title + ' ' + this.getText(el));

    // Detect status
    const status = this._determineStatus(el);
    const autoCompleted = (status === 'completed');

    // Extract deadline
    const { deadlineRaw } = this.extractDeadline(el);

    // Extract score if present
    const scoreConfig = this.config.homeworkDetection?.score;
    let score = null, totalScore = null;
    if (scoreConfig) {
      const scoreEl = this.querySelector(scoreConfig, el);
      if (scoreEl) {
        const scoreText = this.getText(scoreEl);
        const match = scoreText.match(/(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)/);
        if (match) {
          score = parseFloat(match[1]);
          totalScore = parseFloat(match[2]);
        }
      }
    }

    // Try to extract chapter/lesson context from surrounding DOM
    const chapterId = ids.chapterId || this._findParentChapterId(el);
    const lessonId = ids.lessonId || this._findParentLessonId(el);

    return {
      chapterId,
      lessonId,
      homeworkId: ids.homeworkId || '',
      title,
      type,
      status,
      autoDetectedCompleted: autoCompleted,
      deadlineRaw,
      score,
      totalScore,
      pageUrl: window.location.href
    };
  }

  _determineStatus(el) {
    if (this.isCompleted(el)) return 'completed';
    if (this.isSubmitted(el)) return 'submitted';
    return 'unfinished';
  }

  /**
   * Try to find parent chapter ID by traversing up the DOM.
   */
  _findParentChapterId(el) {
    let current = el.parentElement;
    const maxDepth = 10;
    for (let i = 0; i < maxDepth && current; i++) {
      const ids = this.extractIds(current);
      if (ids.chapterId) return ids.chapterId;

      // Check for chapter-like class names
      const className = current.className || '';
      if (/chapter/i.test(className)) {
        const match = className.match(/chapter[_-]?(\d+)/i);
        if (match) return `chapter_${match[1]}`;
      }

      current = current.parentElement;
    }
    return '';
  }

  /**
   * Try to find parent lesson ID by traversing up the DOM.
   */
  _findParentLessonId(el) {
    let current = el.parentElement;
    const maxDepth = 10;
    for (let i = 0; i < maxDepth && current; i++) {
      const ids = this.extractIds(current);
      if (ids.lessonId) return ids.lessonId;

      const className = current.className || '';
      if (/lesson/i.test(className)) {
        const match = className.match(/lesson[_-]?(\d+)/i);
        if (match) return `lesson_${match[1]}`;
      }

      current = current.parentElement;
    }
    return '';
  }
}
