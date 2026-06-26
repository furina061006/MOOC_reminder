/**
 * icourse163.org web JSON-RPC helpers — request builders + tolerant parsers.
 *
 * These are PURE functions (no network, no chrome.*) so they are unit-tested
 * and reused. The background service worker inlines an equivalent copy — see
 * [[runtime-vs-shared-duplication]]; edit BOTH when changing behavior.
 *
 * Endpoint pattern (confirmed from public MOOC tooling):
 *   POST https://www.icourse163.org/web/j/{bean}.{method}.rpc?csrfKey={csrfKey}
 *   Content-Type: application/x-www-form-urlencoded;charset=UTF-8
 *   Session travels in cookies (fetch credentials:'include'); csrfKey === cookie NTESSTUDYSI.
 *
 * IMPORTANT: live field names can drift and cannot be verified offline. Every
 * parser here is defensive and the CALLER must treat any failure as "fall back
 * to DOM scraping" — never fatal. We use termId (taken from the canonical
 * /learn/{school-courseId}?tid={termId} URL) as the bridge key, and attach our
 * own canonical courseId to results, so API output dedups cleanly with the
 * DOM scraper regardless of icourse163's internal id scheme.
 */

export const ICOURSE_ORIGIN = 'https://www.icourse163.org';
export const CSRF_COOKIE_NAME = 'NTESSTUDYSI';

export const RPC_ENDPOINTS = {
  // Course outline for a term (chapters → lessons → units incl. quiz/homework/exam).
  termDto: 'web/j/courseBean.getMocTermDto.rpc'
};

export function rpcUrl(endpoint, csrfKey) {
  return `${ICOURSE_ORIGIN}/${endpoint}?csrfKey=${encodeURIComponent(csrfKey || '')}`;
}

function formBody(params) {
  return Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

export function buildTermDtoRequest(csrfKey, termId) {
  return {
    url: rpcUrl(RPC_ENDPOINTS.termDto, csrfKey),
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: formBody({ termId: String(termId || ''), gatewayType: 3 })
  };
}

/**
 * Parse a /learn/ or /spoc/learn/ href into the canonical identity used
 * everywhere else: { schoolCourseId: "BIT-268001", termId: "1460270441" }.
 * Returns null if the href isn't a learn link with a tid.
 */
export function parseLearnHref(href) {
  if (!href || typeof href !== 'string') return null;
  // Accept absolute or relative; only learn pages carry homework.
  const m = href.match(/\/(?:spoc\/)?learn\/([^/?#]+)/i);
  if (!m) return null;
  const schoolCourseId = decodeURIComponent(m[1]);
  // Must look like {school}-{id}; bare segments are nav noise.
  if (!/^[^-\s]+-[^-\s]+/.test(schoolCourseId)) return null;
  const tidMatch = href.match(/[?&]tid=(\d+)/);
  const termId = tidMatch ? tidMatch[1] : '';
  if (!termId) return null;
  const isSpoc = /\/spoc\/learn\//i.test(href);
  return { schoolCourseId, termId, isSpoc };
}

/** Coerce a fetch body (string or object) into JSON, tolerating junk prefixes. */
export function coerceJson(input) {
  if (input == null) return null;
  if (typeof input === 'object') return input;
  if (typeof input !== 'string') return null;
  try {
    return JSON.parse(input);
  } catch {
    /* fall through to prefix-stripping */
  }
  const i = input.search(/[{[]/);
  if (i > 0) {
    try {
      return JSON.parse(input.slice(i));
    } catch {
      return null;
    }
  }
  return null;
}

const DEADLINE_FIELDS = [
  'deadline', 'endTime', 'submitEndTime', 'evaluationEndTime',
  'examEndTime', 'testEndTime', 'homeworkEndTime', 'jobDeadline', 'closeTime'
];
const SCORE_FIELDS = ['mark', 'score', 'studentScore', 'finalMark', 'userScore'];
const TOTAL_FIELDS = ['totalMark', 'totalScore', 'fullMark', 'allMark'];

function firstNumber(obj, fields) {
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === 'number' && isFinite(v) && v > 0) return v;
    if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  }
  return null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Convert epoch milliseconds to a LOCAL-offset ISO string, matching exactly the
 * format the DOM scraper's formatISO produces (e.g. 2026-06-30T23:59:00+08:00),
 * so deadline strings line up and reconcile dedups API ↔ DOM items.
 */
export function msToLocalIso(ms) {
  const n = typeof ms === 'string' ? parseInt(ms, 10) : ms;
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  if (isNaN(d.getTime())) return null;
  const tzOffset = -d.getTimezoneOffset();
  const sign = tzOffset >= 0 ? '+' : '-';
  const tzH = pad(Math.floor(Math.abs(tzOffset) / 60));
  const tzM = pad(Math.abs(tzOffset) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${tzH}:${tzM}`;
}

// ─── Phase Detection ───────────────────────────────────

/**
 * Detect homework evaluation phase (submit / peerreview / results).
 * 测验 (type:2) has no peer review; 作业 (type:3) does.
 */
export function detectPhase(node) {
  if (String(node.type || '') !== '3') return null;
  if (!node.enableEvaluation || node.evaluateStart == null) return null;
  const pub = parseInt(node.scorePubStatus, 10) || 0;
  if (pub === 2) return 'results';
  if (pub === 1) return 'results';  // score published → 互评结束
  const now = Date.now();
  const start = parseInt(node.evaluateStart, 10);
  const end = parseInt(node.evaluateScoreReleaseTime || node.evaluateEnd, 10);
  if (start && now < start) return 'submit';
  if (end && now >= end) return 'results';
  return 'peerreview';
}

// ─── Completion Detection ──────────────────────────────

/**
 * Deep-check if a node or its nested children contain completion indicator text.
 */
export function hasCompletedText(node, depth) {
  if (!node || typeof node !== 'object' || (depth || 0) > 6) return false;
  const d = depth || 0;
  const pat = /已完成|已成功提交|已提交|已批阅|已通过|已互评|查看成绩|查看分数/i;
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (typeof v === 'string' && pat.test(v)) return true;
    if (Array.isArray(v)) {
      for (const e of v) {
        if (e && typeof e === 'object' && hasCompletedText(e, d + 1)) return true;
      }
    } else if (v && typeof v === 'object' && hasCompletedText(v, d + 1)) {
      return true;
    }
  }
  return false;
}

// ─── Type Classification ───────────────────────────────

/**
 * Classify assessment type from API fields.
 * API type field: 2=测验, 3=作业, 6=考试
 * Name regex serves as fallback.
 */
export function classifyType(name, rawType) {
  const rt = rawType !== undefined ? String(rawType) : '';
  if (rt === '6' || rt === '2' || rt === '3') {
    if (rt === '6') return 'exam';
    if (rt === '2') return 'quiz';
    if (rt === '3') return 'homework';
  }
  const t = String(name || '');
  // "期末" prefixed test/exam are exams, not quizzes
  if (rt === '6' || /期末|考试|exam/i.test(t)) return 'exam';
  if (rt === '2' || /测验|quiz|测试/i.test(t)) return 'quiz';
  if (/讨论|discussion/i.test(t)) return 'discussion';
  return 'homework';
}

// ─── Main Extraction ───────────────────────────────────

/**
 * Walk a getMocTermDto response and extract assessable items (quiz/homework/exam)
 * that carry a real signal — a deadline or a score — mirroring the DOM scraper's
 * "filter by signal" rule so we never mint deadline-less noise.
 *
 * @param {object|string} input  raw RPC response
 * @param {object} course        canonical course record { courseId, termId, courseName, schoolName, pageUrl }
 * @returns {Array<object>} homework-item-shaped objects ready for reconcile
 */
export function extractHomeworkFromTermDto(input, course) {
  const data = coerceJson(input);
  if (!data || !course) return [];
  const out = [];
  const seen = new Set();
  let visited = 0;

  function looksLikeChapter(node) {
    return Array.isArray(node.lessons) || /chapter/i.test(node.type || '');
  }
  function looksLikeLesson(node) {
    return Array.isArray(node.units) || /lesson/i.test(node.type || '');
  }

  function visit(node, chapterId, lessonId) {
    if (!node || typeof node !== 'object' || visited > 5000) return;
    visited++;

    if (Array.isArray(node)) {
      for (const child of node) visit(child, chapterId, lessonId);
      return;
    }

    const name = node.name || node.title || node.unitName || '';
    const deadlineMs = firstNumber(node, DEADLINE_FIELDS);
    const score = firstNumber(node, SCORE_FIELDS);
    const totalScore = firstNumber(node, TOTAL_FIELDS);
    const hasSignal = deadlineMs != null || (score != null && totalScore != null);

    if (typeof name === 'string' && name.trim() && hasSignal &&
        /测验|作业|考试|测试|quiz|exam|homework|test/i.test(name)) {

      const homeworkId = String(
        node.id || node.jobId || node.quizId || node.testId || node.homeworkId || ''
      ) || ('h' + (out.length + 1));
      const uid = `${course.courseId}_tid${course.termId}_ch${chapterId || ''}_le${lessonId || ''}_hw${homeworkId}`;

      if (!seen.has(uid)) {
        seen.add(uid);

        // 互评中：用 evaluateEnd 代替原来的提交截止日期
        const phase = detectPhase(node);
        let phaseDeadline = deadlineMs;
        if (phase === 'peerreview' && (parseInt(node.scorePubStatus, 10) || 0) === 0) {
          const pe = parseInt(node.evaluateEnd, 10);
          if (pe > 0) phaseDeadline = pe;
        }
        const deadline = phaseDeadline != null ? msToLocalIso(phaseDeadline) : null;

        // 完成判定：有分数 OR 已提交（非互评中）OR 节点含完成文本
        const submitted = parseInt(node.usedTryCount, 10) > 0 && (parseInt(node.type, 10) === 3);
        const inPeerReview = phase === 'peerreview' && (parseInt(node.scorePubStatus, 10) || 0) === 0;
        const done = (score != null && totalScore != null && score > 0)
          || (submitted && !inPeerReview)
          || hasCompletedText(node, 0);

        out.push({
          uid,
          courseId: course.courseId,
          termId: course.termId,
          chapterId: chapterId || '',
          lessonId: lessonId || '',
          homeworkId,
          title: name.trim(),
          type: classifyType(name, node.type !== undefined ? node.type : null),
          courseName: course.courseName || '',
          schoolName: course.schoolName || '',
          status: done ? 'completed' : 'unfinished',
          checkedOff: done,
          manuallyCheckedOff: false,
          autoDetectedCompleted: done,
          completionReason: done ? 'auto' : null,
          hwPhase: phase,
          deadline,
          deadlineRaw: deadline ? '(API)' : null,
          score,
          totalScore,
          source: 'api',
          pageUrl: course.pageUrl || '',
          apiCompleted: done
        });
      }
    }

    // Recurse, threading the nearest chapter/lesson id for UID structure.
    const nextChapter = node.chapterId || (looksLikeChapter(node) ? node.id : chapterId);
    const nextLesson = node.lessonId || (looksLikeLesson(node) ? node.id : lessonId);
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === 'object') visit(v, nextChapter, nextLesson);
    }
  }

  visit(data, '', '');

  // 去重：名字几乎相同且共前缀的噪音项（如 "期末测试题" vs "期末测试"）
  for (let i = out.length - 1; i >= 0; i--) {
    const nameA = out[i].title || '';
    for (let j = 0; j < i; j++) {
      const nameB = out[j].title || '';
      if (nameB.length > 0 && nameA.indexOf(nameB) === 0 && nameA.length - nameB.length <= 2) {
        out.splice(i, 1);
        break;
      }
      if (nameA.length > 0 && nameB.indexOf(nameA) === 0 && nameB.length - nameA.length <= 2) {
        out.splice(j, 1);
        j--;
      }
    }
  }

  return out;
}
