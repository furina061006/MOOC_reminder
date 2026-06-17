/**
 * Course data model for tracking enrolled courses on icourse163.org.
 */

/**
 * Create a new Course object with defaults.
 *
 * @param {Object} params
 * @param {string} params.courseId - e.g., "BIT-268001"
 * @param {string} [params.schoolName]
 * @param {string} [params.courseName]
 * @param {string} [params.activeTermId]
 * @param {string} [params.courseUrl]
 * @param {string} [params.courseType] - "mooc" | "spoc"
 * @returns {Object} Course
 */
export function createCourse({
  courseId,
  schoolName = '',
  courseName = '',
  activeTermId = '',
  courseUrl = '',
  courseType = 'mooc'
}) {
  const now = new Date().toISOString();

  return {
    courseId,
    schoolName,
    courseName,
    activeTermId,
    terms: activeTermId ? [activeTermId] : [],
    courseUrl,
    courseType,
    firstSeen: now,
    lastSeen: now
  };
}

/**
 * Add a term to a course if not already present.
 */
export function addTerm(course, termId) {
  if (!course.terms.includes(termId)) {
    course.terms.push(termId);
  }
  return course;
}

/**
 * Merge course data from a scrape into an existing course record.
 * Preserves metadata not available from a single page scrape.
 */
export function mergeCourseData(existing, incoming) {
  return {
    ...existing,
    ...incoming,
    // Preserve these fields from existing
    firstSeen: existing.firstSeen || incoming.firstSeen,
    terms: [...new Set([...(existing.terms || []), ...(incoming.terms || [])])],
    // Always update
    lastSeen: new Date().toISOString()
  };
}
