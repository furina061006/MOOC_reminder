/**
 * Resolve where clicking a homework item (popup row, desktop notification)
 * should take you.
 *
 * API-discovered items often carry no pageUrl at all — course records never
 * store one — so we reconstruct the canonical learn URL from courseId+termId
 * and pick a hash route matching the item type. The route prefix must match the
 * course type: SPOC courses live under /spoc/learn/, not /learn/, otherwise the
 * link opens a non-SPOC page that cannot resolve the course.
 *
 * popup.js keeps its own classic (non-module) copy of this logic; this module
 * is the copy the service worker's notification click handler uses. Keep the
 * two aligned.
 */

const LEARN_BASE = 'https://www.icourse163.org/learn/';
const SPOC_LEARN_BASE = 'https://www.icourse163.org/spoc/learn/';

/**
 * @param {object} item                       HomeworkItem
 * @param {string} [courseType]               Course metadata ('mooc' | 'spoc');
 *   falls back to item.courseType for items that persist it. Callers that have
 *   the Course record should pass it explicitly so items stored before
 *   courseType was persisted still resolve correctly.
 */
export function resolveItemUrl(item, courseType) {
  if (!item) return null;
  const type = courseType || item.courseType || '';
  const base = item.courseId && item.termId
    ? (type === 'spoc' ? SPOC_LEARN_BASE : LEARN_BASE) + item.courseId + '?tid=' + item.termId
    : null;
  // pageUrl 可能带着错误的 hash（如 /learn/content），按条目类型修正
  const route = item.type === 'exam' ? '/learn/examlist' : '/learn/testlist';
  if (item.pageUrl) {
    const hashIdx = item.pageUrl.indexOf('#');
    if (hashIdx >= 0) return item.pageUrl.slice(0, hashIdx) + '#' + route;
    return item.pageUrl + '#' + route;
  }
  if (base) return base + '#' + route;
  return null;
}
