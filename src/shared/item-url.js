/**
 * Resolve where clicking a homework item (popup row, desktop notification)
 * should take you.
 *
 * Priority:
 *   1. `item.pageUrl`   — the route captured when the item was scraped
 *   2. `coursePageUrl`  — the Course record's frozen route (items stored before
 *                         the route was captured have no pageUrl of their own)
 *   3. courseId+termId  — reconstructed route, prefixed by course type
 *
 * Two route families must both keep working (2026-10), and both must land on the
 * section that matches the item type:
 *   - legacy: /learn/{id}?tid=… and /spoc/learn/{id}?tid=… keep the section in the
 *     `#/learn/…` hash → the hash is rewritten (…/testlist for 测验/作业,
 *     …/examlist for 考试).
 *   - new: /mooc/learn/{id}/{section} — also served as /learn/{id}/{section} —
 *     keeps the section in the PATH → the path segment is replaced
 *     (…/assessments for 测验/作业, …/exams for 考试). The frozen URL is often
 *     …/content, which is the wrong section for an assessment item.
 *
 * Whether a course is on the new route is not guessed: it comes from the route the
 * user's browser actually loaded (main.js self-report → COURSE_LINKS → pageUrl), so
 * old courses keep opening old URLs and new ones open new URLs.
 *
 * popup.js keeps its own classic (non-module) copy of this logic; this module is
 * the copy the service worker's notification click handler uses. Keep the two
 * aligned.
 */

const LEARN_BASE = 'https://www.icourse163.org/learn/';
const SPOC_LEARN_BASE = 'https://www.icourse163.org/spoc/learn/';

/**
 * Does this learn URL address a section through its PATH instead of a hash?
 * True only for the new-route shape — e.g. /mooc/learn/BIT-1/assessments (and its
 * /learn/BIT-1/assessments mirror). Legacy course URLs have no trailing segment.
 */
export function hasPathSection(pageUrl) {
  try {
    const match = new URL(String(pageUrl)).pathname.match(/^\/(?:(?:mooc|spoc)\/)?learn\/[^/?#]+(\/.+)?$/);
    return !!(match && match[1]);
  } catch {
    return false;
  }
}

/** New-route path segment for an item type. 测验/作业 live under assessments. */
export function sectionForType(itemType) {
  return itemType === 'exam' ? 'exams' : 'assessments';
}

/** Legacy-route hash for an item type. */
export function hashRouteForType(itemType) {
  return itemType === 'exam' ? '/learn/examlist' : '/learn/testlist';
}

/**
 * Point a captured learn URL at the section that matches `itemType`.
 * Path-routed URLs get their section segment replaced; hash-routed URLs get their
 * hash rewritten. Both end up on 测验/作业 (assessments / testlist) or 考试
 * (exams / examlist) — never on the `content` page the URL happened to be frozen on.
 */
export function applyLearnRoute(pageUrl, itemType) {
  if (hasPathSection(pageUrl)) {
    const url = new URL(String(pageUrl));
    // Collapse everything after the course key into the one section we want: a
    // frozen URL can be deeper than one segment (…/content-unit/{id}), and only the
    // section matters here.
    url.pathname = url.pathname.replace(
      /^(\/(?:(?:mooc|spoc)\/)?learn\/[^/?#]+)\/.*$/,
      '$1/' + sectionForType(itemType)
    );
    url.hash = '';
    return url.toString();
  }
  const hash = '#' + hashRouteForType(itemType);
  const hashIdx = pageUrl.indexOf('#');
  if (hashIdx >= 0) return pageUrl.slice(0, hashIdx) + hash;
  return pageUrl + hash;
}

/**
 * @param {object} item                       HomeworkItem
 * @param {string} [courseType]               Course metadata ('mooc' | 'spoc');
 *   falls back to item.courseType for items that persist it. Callers that have
 *   the Course record should pass it explicitly so items stored before
 *   courseType was persisted still resolve correctly.
 * @param {string} [coursePageUrl]            Course route frozen from the page the
 *   user actually opened (fallback for items that carry no pageUrl themselves).
 */
export function resolveItemUrl(item, courseType, coursePageUrl) {
  if (!item) return null;
  const type = courseType || item.courseType || '';
  const base = item.courseId && item.termId
    ? (type === 'spoc' ? SPOC_LEARN_BASE : LEARN_BASE) + item.courseId + '?tid=' + item.termId
    : null;
  const pageUrl = item.pageUrl || coursePageUrl || '';
  if (pageUrl) return applyLearnRoute(pageUrl, item.type);
  if (base) return base + '#' + hashRouteForType(item.type);
  return null;
}
