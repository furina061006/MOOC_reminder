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
 * Two route families must both keep working (2026-10):
 *   - legacy: /learn/{id}?tid=… and /spoc/learn/{id}?tid=… carry their section in
 *     the `#/learn/…` hash, so the hash is rewritten to match the item type.
 *   - new: /mooc/learn/{id}/{section} — also served as /learn/{id}/{section} —
 *     carries the section in the PATH. There the path already says where to go,
 *     so the URL is used untouched and no hash is grafted on.
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

/**
 * Point a captured learn URL at `route` (#/learn/testlist or #/learn/examlist).
 * Path-routed URLs are returned untouched: their section is already in the path,
 * and a legacy hash on them means nothing.
 */
export function applyLearnHashRoute(pageUrl, route) {
  if (hasPathSection(pageUrl)) return pageUrl;
  const hashIdx = pageUrl.indexOf('#');
  if (hashIdx >= 0) return pageUrl.slice(0, hashIdx) + '#' + route;
  return pageUrl + '#' + route;
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
  const route = item.type === 'exam' ? '/learn/examlist' : '/learn/testlist';
  const pageUrl = item.pageUrl || coursePageUrl || '';
  if (pageUrl) return applyLearnHashRoute(pageUrl, route);
  if (base) return base + '#' + route;
  return null;
}
