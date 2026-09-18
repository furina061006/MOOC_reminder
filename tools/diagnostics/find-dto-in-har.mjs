/**
 * 在 DevTools 导出的 HAR 里定位「课程 DTO 到底在哪个请求里」。
 *
 * 用法:
 *   node tools/diagnostics/find-dto-in-har.mjs network.har [关键词...]
 *
 * 为什么需要它：当某门课条目抓不全时，必须先确定 API 数据里**有没有**那些条目、
 * 以及它们挂在**哪个 termId** 下。HAR 能一次性给出页面上所有请求的响应体，
 * 比手工逐个 Copy response 可靠得多。
 *
 * 导出方式：DevTools → Network → 刷新页面 → 右键任意请求 →
 *   「Export HAR (sanitized)」（或工具栏的下载图标）。sanitized 会去掉 Cookie。
 *
 * 输出重点：
 *   - 只列出「响应体里出现关键词」或「响应体像课程 DTO」的请求
 *   - 每个这样的请求的 termId（从 postData 与 URL 里提取）——决定假设 H1 的关键
 *   - 该 DTO 里识别到的作业型节点（name / contentType / 是否有 test）
 *
 * HAR 含个人学习数据，不要提交（已在 .gitignore）。
 */
import { readFile } from 'node:fs/promises';

const DEFAULT_KEYWORDS = ['线上学习任务', '翻转课堂', 'Multisim', '图解分析法', '二极管应用仿真设计'];

function decodeBody(content) {
  if (!content || typeof content.text !== 'string') return '';
  if (content.encoding === 'base64') {
    try { return Buffer.from(content.text, 'base64').toString('utf8'); } catch { return ''; }
  }
  return content.text;
}

function termIdsIn(text) {
  const ids = new Set();
  for (const m of String(text || '').matchAll(/termId["'\s:=]+(\d+)/g)) ids.add(m[1]);
  for (const m of String(text || '').matchAll(/[?&]tid=(\d+)/g)) ids.add(m[1]);
  return [...ids];
}

/** 汇总一个响应体里所有「像作业/测验」的节点；非 JSON 返回 null。 */
function summarizeAssessmentNodes(text, limit = 12) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const out = [];
  const walk = (n, chapterId) => {
    if (!n || typeof n !== 'object' || out.length >= limit) return;
    if (Array.isArray(n)) { for (const x of n) walk(x, chapterId); return; }
    const name = n.name || n.title || n.unitName;
    const t = n.test || {};
    const isChapter = Array.isArray(n.lessons) || /chapter/i.test(n.type || '');
    const nextChapter = n.chapterId || (isChapter ? n.id : chapterId);
    if (name && (n.test || n.contentType != null)) {
      out.push({
        ch: chapterId,
        name: String(name).slice(0, 36),
        contentType: n.contentType != null ? n.contentType : '-',
        type: n.type != null ? n.type : '-',
        hasTest: !!n.test,
        deadline: n.deadline || t.deadline || n.endTime || t.endTime || null
      });
    }
    for (const k of Object.keys(n)) {
      if (n[k] && typeof n[k] === 'object') walk(n[k], nextChapter);
    }
  };
  walk(data, '');
  return out;
}

const [harPath, ...rest] = process.argv.slice(2);
if (!harPath) {
  console.error('用法: node tools/diagnostics/find-dto-in-har.mjs <network.har> [关键词...]');
  process.exit(1);
}
const keywords = rest.length ? rest : DEFAULT_KEYWORDS;

let har;
try {
  har = JSON.parse(await readFile(harPath, 'utf8'));
} catch (e) {
  console.error('读不了 HAR：' + e.message);
  process.exit(1);
}

const entries = (har && har.log && har.log.entries) || [];
console.log('HAR 条目 ' + entries.length + ' 个；关键词：' + keywords.join(' / '));

let hits = 0;
let bodyless = 0;
for (const entry of entries) {
  const text = decodeBody(entry.response && entry.response.content);
  if (!text) { bodyless++; continue; }
  const matched = keywords.filter((k) => text.includes(k));
  const looksLikeDto = text.includes('mocTermDto') || text.includes('"chapters"');
  if (matched.length === 0 && !looksLikeDto) continue;
  hits++;

  const url = String((entry.request && entry.request.url) || '').replace(/csrfKey=[^&]*/, 'csrfKey=…');
  const post = (entry.request && entry.request.postData && entry.request.postData.text) || '';
  const ids = [...new Set([...termIdsIn(post), ...termIdsIn(url)])];

  console.log('\n─────────────────────────────────────────');
  console.log('URL        : ' + url.slice(0, 160));
  console.log('termId     : ' + (ids.join(', ') || '(未找到)'));
  console.log('postData   : ' + post.replace(/\s+/g, ' ').slice(0, 140));
  console.log('响应体积   : ' + Math.round(text.length / 1024) + ' KB');
  console.log('命中关键词 : ' + (matched.length ? matched.join(' / ') : '（无）'));

  const nodes = summarizeAssessmentNodes(text);
  if (nodes) {
    console.log('作业型节点 : ' + nodes.length + ' 个（最多列 12）');
    for (const n of nodes) {
      console.log('   ct=' + String(n.contentType).padEnd(3) +
        ' type=' + String(n.type).padEnd(3) +
        ' ch=' + String(n.ch).padEnd(4) +
        (n.hasTest ? 'test ' : '     ') + n.name);
    }
  }
}

if (hits === 0) {
  console.log('\n没有响应包含关键词或 DTO 结构。');
  if (bodyless > 0) {
    console.log('注意：' + bodyless + ' 个条目没有响应体 —— 导出 HAR 时需包含响应内容。');
  }
}
