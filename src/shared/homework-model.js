/**
 * HomeworkItem data model and UID generation.
 *
 * UID format: {courseId}_tid{termId}_ch{chapterId}_le{lessonId}_hw{homeworkId}
 * Example: BIT-268001_tid1460270441_ch3_l2_hw5
 */

/**
 * Generate a unique identifier for a homework item.
 * Uses structural IDs from the DOM/URL — not titles, so changes to title
 * text won't create duplicate entries.
 */
export function generateHomeworkUid(courseId, termId, chapterId, lessonId, homeworkId) {
  const parts = [
    courseId,
    `tid${termId}`,
    `ch${chapterId}`,
    `le${lessonId}`,
    `hw${homeworkId}`
  ];
  return parts.join('_');
}

/**
 * Fallback UID: hash of courseId + title + deadline + position.
 * Used when structural IDs are unavailable from the DOM.
 */
export function generateFallbackUid(courseId, title, deadline, domPosition) {
  const str = `${courseId}_${title}_${deadline}_${domPosition}`;
  return hashString(str);
}

/**
 * Simple string hash (djb2) returning a hex string.
 */
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return 'fb_' + (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Create a new HomeworkItem object with defaults.
 *
 * @param {Object} params
 * @param {string} params.uid - Unique identifier
 * @param {string} params.courseId
 * @param {string} params.termId
 * @param {string} params.chapterId
 * @param {string} params.lessonId
 * @param {string} params.homeworkId
 * @param {string} params.title - Homework title
 * @param {string} params.type - "homework" | "quiz" | "exam" | "discussion"
 * @param {string} params.courseName
 * @param {string} params.schoolName
 * @param {string} [params.status] - "unfinished" | "submitted" | "graded"
 * @param {string} [params.deadline] - ISO 8601 deadline
 * @param {string} [params.deadlineRaw] - Original Chinese deadline text
 * @param {string} [params.pageUrl] - URL where this item was found
 * @param {number} [params.score]
 * @param {number} [params.totalScore]
 * @returns {Object} HomeworkItem
 */
export function createHomeworkItem({
  uid,
  courseId,
  termId,
  chapterId,
  lessonId,
  homeworkId,
  title,
  type = 'homework',
  courseName = '',
  schoolName = '',
  status = 'unfinished',
  deadline = null,
  deadlineRaw = null,
  pageUrl = '',
  score = null,
  totalScore = null
}) {
  const now = new Date().toISOString();

  return {
    // Unique identity
    uid,
    courseId,
    termId,
    chapterId,
    lessonId,
    homeworkId,

    // Display
    title,
    type,
    courseName,
    schoolName,

    // Status
    status,
    checkedOff: false,
    manuallyCheckedOff: false,
    autoDetectedCompleted: false,
    completionReason: null,  // "auto" | "manual" | null

    // Timing
    deadline,
    deadlineRaw,
    firstSeen: now,
    lastUpdated: now,

    // Reference
    pageUrl,

    // Score
    score,
    totalScore
  };
}

/**
 * Determine if a homework item is overdue.
 */
export function isOverdue(item) {
  if (!item.deadline) return false;
  return new Date(item.deadline) < new Date();
}

/**
 * Determine if a homework item is due within the given hours.
 */
export function isDueWithin(item, hours) {
  if (!item.deadline) return false;
  const now = new Date();
  const deadline = new Date(item.deadline);
  if (deadline < now) return false; // already overdue
  const diffMs = deadline - now;
  return diffMs <= hours * 60 * 60 * 1000;
}

/**
 * Get urgency level for UI coloring.
 * @returns {'overdue' | 'soon' | 'normal'}
 */
export function getUrgency(item) {
  if (isOverdue(item)) return 'overdue';
  if (isDueWithin(item, 48)) return 'soon';
  return 'normal';
}

/**
 * Check if item should be considered "done" for badge counting.
 */
export function isEffectivelyDone(item) {
  return item.checkedOff === true;
}

/**
 * Parse course metadata from icourse163.org URL.
 *
 * URL format:
 *   https://www.icourse163.org/learn/{school}-{courseId}?tid={termId}#/learn/content
 *   https://www.icourse163.org/spoc/learn/{school}-{courseId}?tid={termId}#/learn/content
 */
export function parseCourseUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);

    // Determine SPOC vs MOOC
    const isSpoc = pathParts.includes('spoc');

    // Extract school-courseId from path (last segment before query)
    // e.g., /learn/BIT-268001 → BIT-268001
    const learnIndex = pathParts.indexOf('learn');
    const schoolCourseId = learnIndex >= 0 ? pathParts[learnIndex + 1] : '';

    // Extract termId from query string
    const termId = urlObj.searchParams.get('tid') || '';

    // Extract courseId (part after the first '-')
    const dashIndex = schoolCourseId.indexOf('-');
    const school = dashIndex >= 0 ? schoolCourseId.substring(0, dashIndex) : '';
    const courseId = schoolCourseId;

    return {
      schoolCourseId,
      school,
      courseId,
      termId,
      isSpoc,
      baseUrl: `${urlObj.origin}${urlObj.pathname}?tid=${termId}`
    };
  } catch (e) {
    return {
      schoolCourseId: '',
      school: '',
      courseId: '',
      termId: '',
      isSpoc: false,
      baseUrl: ''
    };
  }
}

/**
 * Parse the hash route from the URL.
 * Returns the route path without the leading #.
 */
export function parseHashRoute(url) {
  try {
    const hash = new URL(url).hash;
    if (!hash) return '';
    return hash.startsWith('#') ? hash.slice(1) : hash;
  } catch {
    return '';
  }
}

/**
 * Check if the current hash route is relevant for homework scraping.
 */
export function isHomeworkRelevantRoute(route) {
  if (!route) return false;
  const relevant = [
    '/learn/content',
    '/learn/content?type=detail',
    '/learn/quiz',
    '/learn/exam',
    '/learn/homework'
  ];
  return relevant.some(r => route.startsWith(r));
}
