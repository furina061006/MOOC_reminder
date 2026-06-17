/**
 * Course page scraper for standard MOOC courses on icourse163.org.
 *
 * This scraper runs on the course content page (#/learn/content)
 * and extracts:
 * - Course metadata (name, school)
 * - Chapter and lesson structure
 * - Homework items embedded within lessons
 */

import { BaseScraper } from './base.js';

export class CoursePageScraper extends BaseScraper {
  constructor(selectorConfig) {
    super(selectorConfig);
  }

  /**
   * Scrape course metadata from the page.
   * @returns {{ courseName: string, schoolName: string }}
   */
  scrapeCourseMeta() {
    const courseConfig = this.config.coursePage;

    const courseNameEl = this.querySelector(courseConfig?.courseName);
    const courseName = this.getText(courseNameEl) || document.title || '未知课程';

    const schoolNameEl = this.querySelector(courseConfig?.schoolName);
    const schoolName = this.getText(schoolNameEl) || '';

    return { courseName, schoolName };
  }

  /**
   * Scrape all homework items from the course content page.
   * Walks through chapter → lesson hierarchy and finds homework entries.
   *
   * @returns {Array} Array of raw homework item objects (no UID yet)
   */
  scrapeHomeworkItems() {
    const items = [];
    const courseConfig = this.config.coursePage;
    const hwConfig = this.config.homeworkDetection;

    // Find chapter container
    const chapterContainer = this.querySelector(courseConfig?.chapterContainer);

    if (!chapterContainer) {
      // Try to find homework items directly (some page layouts)
      const directItems = this._findHomeworkItems(document);
      items.push(...directItems);
      return items;
    }

    // Find chapter items
    const chapterItems = this.querySelectorAll(courseConfig?.chapterItems, chapterContainer);
    let chapterIndex = 0;

    for (const chapterEl of chapterItems) {
      chapterIndex++;
      const chapterIds = this.extractIds(chapterEl);
      const chapterId = chapterIds.chapterId || `chapter_${chapterIndex}`;

      // Find lesson items within this chapter
      const lessonItems = this.querySelectorAll(courseConfig?.lessonItems, chapterEl);
      let lessonIndex = 0;

      for (const lessonEl of lessonItems) {
        lessonIndex++;
        const lessonIds = this.extractIds(lessonEl);
        const lessonId = lessonIds.lessonId || `lesson_${chapterIndex}_${lessonIndex}`;

        // Find homework items within this lesson
        const homeworkEls = this._findHomeworkItems(lessonEl);

        for (const hwEl of homeworkEls) {
          const hwIds = this.extractIds(hwEl);
          const homeworkId = hwIds.homeworkId || '';

          const titleEl = this.querySelector(hwConfig?.homeworkTitle, hwEl);
          const title = this.getText(titleEl) || '未命名作业';

          const type = this.detectType(title + ' ' + this.getText(hwEl));

          const { deadlineRaw } = this.extractDeadline(hwEl);
          const status = this._determineStatus(hwEl);
          const autoCompleted = status === 'completed';

          items.push({
            chapterId,
            lessonId,
            homeworkId,
            title,
            type,
            status,
            autoDetectedCompleted: autoCompleted,
            deadlineRaw,
            pageUrl: window.location.href
          });
        }
      }
    }

    return items;
  }

  // ─── Private Methods ──────────────────────────────────

  /**
   * Find homework-related elements within a container.
   */
  _findHomeworkItems(container) {
    const hwConfig = this.config.homeworkDetection;
    if (!hwConfig?.homeworkRow) return [];

    const items = this.querySelectorAll(hwConfig.homeworkRow, container);

    // If no dedicated homework rows found, try finding links that look like homework
    if (items.length === 0) {
      const links = container.querySelectorAll('a[href*="test"], a[href*="homework"], a[href*="exam"], a[href*="quiz"], a[href*="content"]');
      return Array.from(links);
    }

    return items;
  }

  /**
   * Determine the completion status of a homework item element.
   */
  _determineStatus(el) {
    const text = this.getText(el);
    const className = el.className || '';

    // Check all descendants for status
    const allText = this.getText(el);

    if (this.isCompleted(el)) return 'completed';
    if (this.isSubmitted(el)) return 'submitted';

    // Check for score presence (indicates graded/completed)
    const scoreConfig = this.config.homeworkDetection?.score;
    if (scoreConfig) {
      const scoreEl = this.querySelector(scoreConfig, el);
      if (scoreEl) {
        const scoreText = this.getText(scoreEl);
        if (/\d+/.test(scoreText)) return 'completed';
      }
    }

    return 'unfinished';
  }
}
