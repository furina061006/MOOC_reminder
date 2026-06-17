/**
 * SPOC (Small Private Online Course) page scraper.
 *
 * SPOC courses on icourse163.org/spoc/learn/* have a slightly
 * different DOM structure from standard MOOC courses, but the
 * overall pattern is similar. This scraper extends the base
 * and applies SPOC-specific selector overrides.
 */

import { CoursePageScraper } from './course-page.js';

export class SpocPageScraper extends CoursePageScraper {
  constructor(selectorConfig) {
    super(selectorConfig);

    // Apply SPOC-specific selector overrides
    const spocOverrides = selectorConfig.spocOverrides;
    if (spocOverrides?.coursePage) {
      // Deep merge SPOC overrides into course page config
      this._applyOverrides(spocOverrides.coursePage);
    }
  }

  /**
   * Deep merge SPOC-specific selector overrides into the course page config.
   * SPOC overrides take precedence over the base MOOC selectors.
   */
  _applyOverrides(spocConfig) {
    const coursePage = this.config.coursePage;

    for (const [key, override] of Object.entries(spocConfig)) {
      if (coursePage[key]) {
        // Replace primary but keep base fallbacks as additional fallbacks
        const baseFallbacks = coursePage[key].fallback || [];
        const overrideFallbacks = override.fallback || [];

        coursePage[key] = {
          primary: override.primary || coursePage[key].primary,
          fallback: [
            ...overrideFallbacks,
            ...baseFallbacks.filter(f => !overrideFallbacks.includes(f))
          ]
        };
      }
    }
  }

  /**
   * SPOC course metadata may be in different elements.
   */
  scrapeCourseMeta() {
    const meta = super.scrapeCourseMeta();

    // SPOC pages sometimes have course name in a different location
    if (!meta.courseName || meta.courseName === '未知课程') {
      const spocTitle = document.querySelector('.spoc-title, .spoc-course-title, .j-spoc-title');
      if (spocTitle) {
        meta.courseName = this.getText(spocTitle);
      }
    }

    if (!meta.schoolName) {
      const spocSchool = document.querySelector('.spoc-school, .spoc-org');
      if (spocSchool) {
        meta.schoolName = this.getText(spocSchool);
      }
    }

    return meta;
  }

  /**
   * SPOC pages may organize chapters differently.
   * Try SPOC-specific containers first, then fall back to base behavior.
   */
  scrapeHomeworkItems() {
    // Try SPOC-specific chapter container first
    const spocChapterContainer = document.querySelector('.spoc-chapterlist, .j-spocChapterlist, .spoc-chapter');

    if (spocChapterContainer) {
      // Use base class logic but with SPOC container
      return super.scrapeHomeworkItems();
    }

    // If no SPOC container found, the base class will try general selectors
    return super.scrapeHomeworkItems();
  }
}
