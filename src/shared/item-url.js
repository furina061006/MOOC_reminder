/**
 * Resolve where clicking a homework item (popup row, desktop notification)
 * should take you.
 *
 * API-discovered items often carry no pageUrl at all — course records never
 * store one — so we reconstruct the canonical learn URL from courseId+termId
 * and pick a hash route matching the item type. popup.js keeps its own classic
 * (non-module) copy of this logic; this module is the copy the service
 * worker's notification click handler uses. Keep the two aligned.
 */

const LEARN_BASE = 'https://www.icourse163.org/learn/';

export function resolveItemUrl(item) {
  if (!item) return null;
  const base = item.courseId && item.termId
    ? LEARN_BASE + item.courseId + '?tid=' + item.termId
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
