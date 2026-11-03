/**
 * Parse the data the 2026-10 learn shell (Next.js App Router) embeds in the
 * page as React Flight chunks:
 *
 *   <script>self.__next_f.push([1,"14:[\"$\",\"$L21\",null,{\"outline\":{…}}"])</script>
 *
 * The page's `outline.exams` is the only place the new shell exposes exam
 * deadlines; the old termDto RPC used by the extension does not reliably carry
 * them. This module is pure (no DOM/chrome.*) so it can be unit-tested. The
 * content script sends the raw script text; the service worker parses it.
 */

/** Decode all `self.__next_f.push([1,"…"])` string chunks in one script text. */
export function decodeNextFlight(scriptText) {
  if (typeof scriptText !== 'string' || !scriptText) return '';
  const chunks = [];
  const re = /self\.__next_f\.push\(\s*\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g;
  let m;
  while ((m = re.exec(scriptText))) {
    try { chunks.push(JSON.parse(m[1])); } catch { /* skip malformed chunk */ }
  }
  return chunks.join('');
}

/**
 * Read a JSON object/array that starts at or after `start`, without needing to
 * know where it ends. The Flight payload embeds JSON in a larger text stream,
 * so a plain JSON.parse over the whole thing is not possible.
 */
export function readJsonValueAt(text, start) {
  if (typeof text !== 'string') return null;
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{' && text[i] !== '[') return null;
  const open = text[i];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Find every learn-page `outline` in a decoded Flight payload. */
export function findLearnOutlines(flightText) {
  if (typeof flightText !== 'string' || !flightText) return [];
  const out = [];
  let idx = 0;
  while ((idx = flightText.indexOf('"outline":', idx)) !== -1) {
    const valueStart = idx + '"outline":'.length;
    const outline = readJsonValueAt(flightText, valueStart);
    idx = valueStart;
    if (!outline || typeof outline !== 'object') continue;
    if (!Array.isArray(outline.chapters)) continue;
    out.push(outline);
  }
  return out;
}

/**
 * Find the learn-page `outline` (chapters + exams) in a decoded Flight payload.
 * Prefer an outline that actually carries exams; an empty `exams` array on a
 * prefetched assessments payload is not useful on its own.
 */
export function findLearnOutline(flightText) {
  const outlines = findLearnOutlines(flightText);
  return outlines.find((outline) => Array.isArray(outline.exams) && outline.exams.length > 0)
    || outlines[0]
    || null;
}

/** Convenience: raw script text → all outlines (the shell may prefetch several courses). */
export function extractLearnOutlines(scriptText) {
  return findLearnOutlines(decodeNextFlight(scriptText));
}

/** Convenience: raw script text → first useful outline (null when not the new shell). */
export function extractLearnOutline(scriptText) {
  return findLearnOutline(decodeNextFlight(scriptText));
}

/** True when the outline contains at least one exam with a usable identity. */
export function hasUsableExam(outline) {
  return !!(outline && Array.isArray(outline.exams) && outline.exams.some(
    (exam) => exam && typeof exam === 'object' && (exam.name || exam.title)
  ));
}