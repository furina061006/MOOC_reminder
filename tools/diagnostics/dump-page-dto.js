/* global copy */
/**
 * 页面上下文诊断脚本 —— 在课程页面的 DevTools Console 里运行。
 *
 * 用途：当某门课的条目在 popup 里缺失时，需要区分两种情况：
 *   A. API 返回的数据里**根本没有**这些条目（抓取来源/termId 的问题）
 *   B. 数据里有，但被 `apiExtractHomework` 的类型门槛过滤了
 * 一次粘贴同时回答两者，且**不需要 HttpOnly 的 CSRF token**（只读页面已有数据）。
 *
 * 输出（同时 console.log + 复制到剪贴板 + 下载 mooc-dto-report.json）：
 *   - 页面暴露的各个 termId，以及 URL 的 ?tid=
 *   - 每个「像作业/测验的节点」及其 contentType / 是否有截止或分数 / 是否过门槛
 *   - DOM 里的分组名与条目名**是否出现在 DTO 原文里**（keywordInDto）
 *
 * 若页面只暴露 `{id}` 空壳（部分 SPOC 页如此，2026-09 已实测），
 * 它会改为列出所有匹配 /mooc|term|dto/ 的 window 变量及其体积，
 * 用于发现藏在未检查变量名下的完整 DTO。
 *
 * 与扩展的对应关系：扩展运行时用 src/background/service-worker.js 里内联的
 * apiExtractHomework，门槛逻辑与这里的 passesGate 一致（见 CLAUDE.md 不变量 12）。
 */
(() => {
  const CANDIDATE_RE = /mooc|term|dto/i;
  const DF = ['deadline', 'endTime', 'submitEndTime', 'evaluateEnd', 'evaluationEndTime',
    'examEndTime', 'testEndTime', 'homeworkEndTime', 'jobDeadline', 'closeTime'];
  const SF = ['userScore', 'mark', 'score', 'studentScore', 'finalMark'];
  const TF = ['totalMark', 'totalScore', 'fullMark', 'allMark'];
  const NAME_RE = /测验|作业|考试|测试|quiz|exam|homework|test/i;

  // 想验证「DOM 里看到的这些名字是否真的在 DTO 里」时改这里
  const PROBE_KEYWORDS = ['线上学习任务', 'Multisim', '图解分析法', '二极管应用仿真设计', '翻转', '源课程'];

  function firstNumber(obj, fields) {
    for (const f of fields) {
      const v = obj && obj[f];
      if (typeof v === 'number' && isFinite(v) && v > 0) return v;
      if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
    }
    return null;
  }

  function describe(value) {
    let size = 0;
    try { size = JSON.stringify(value).length; } catch { size = -1; }
    return {
      type: typeof value,
      sizeKB: size < 0 ? '[循环引用]' : Math.round(size / 1024),
      id: (value && typeof value === 'object' && value.id != null) ? value.id : null,
      keys: (value && typeof value === 'object') ? Object.keys(value).slice(0, 20) : null
    };
  }

  /** 同时打印、复制到剪贴板、并下载成文件，方便把结果交回来。 */
  function finish(payload) {
    const text = JSON.stringify(payload, null, 1);
    try { copy(text); } catch { /* 非 DevTools 环境没有 copy() */ }
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = 'mooc-dto-report.json';
      a.click();
    } catch { /* ignore */ }
    console.log(text);
  }

  const report = {
    href: location.href,
    locationTid: new URLSearchParams(location.search).get('tid'),
    termIdOnDomBridge: document.documentElement.getAttribute('data-mooc-real-termid')
  };

  // ── 1. 找出真正的 DTO（有 chapters 的那个）──────────────────────────
  const candidates = {};
  let dto = null;
  let dtoFrom = null;
  for (const k of Object.keys(window)) {
    if (!CANDIDATE_RE.test(k)) continue;
    let v; try { v = window[k]; } catch { candidates[k] = '[无法读取]'; continue; }
    if (v == null) { candidates[k] = null; continue; }
    candidates[k] = describe(v);
    if (!dto && v && typeof v === 'object' && Array.isArray(v.chapters)) { dto = v; dtoFrom = k; }
  }

  if (!dto) {
    report.foundDtoIn = null;
    report.windowCandidates = candidates;
    report.hint = '没有 window 变量装着 chapters。页面不暴露完整 DTO —— 请用 DevTools → Network → 筛 rpc → 刷新 → 找响应最大的请求 → 右键 Copy response 存成文件。';
    finish(report);
    return report.hint;
  }

  report.foundDtoIn = dtoFrom;
  report.dtoId = dto.id != null ? dto.id : null;

  // ── 2. 复刻运行时的门槛，逐个节点给判定 ─────────────────────────────
  const nodes = [];
  const chapterNames = [];
  const walk = (n, chapterId, lessonId) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x, chapterId, lessonId); return; }

    const name = n.name || n.title || n.unitName || '';
    const t = n.test || {};
    const deadline = firstNumber(n, DF) || firstNumber(t, DF);
    const score = firstNumber(n, SF) || firstNumber(t, SF);
    const total = firstNumber(n, TF) || firstNumber(t, TF);
    const ct = String(n.contentType || '');
    const signal = deadline != null || (score != null && total != null);

    if (name && (n.test || ct || n.type != null || signal)) {
      nodes.push({
        ch: chapterId,
        name: String(name).slice(0, 40),
        contentType: ct || '-',
        type: n.type != null ? n.type : '-',
        testType: t.type != null ? t.type : '-',
        hasTest: !!n.test,
        hasSignal: signal,
        deadline: deadline,
        score: (score != null && total != null) ? score + '/' + total : '-',
        usedTryCount: n.usedTryCount != null ? n.usedTryCount : (t.usedTryCount != null ? t.usedTryCount : '-'),
        passesGate: !!String(name).trim() && signal &&
          (ct === '2' || ct === '3' || ct === '6' || (!ct && NAME_RE.test(String(name))))
      });
    }

    const isChapter = Array.isArray(n.lessons) || /chapter/i.test(n.type || '');
    const isLesson = Array.isArray(n.units) || /lesson/i.test(n.type || '');
    if (isChapter && n.name) chapterNames.push(n.name);
    const nc = n.chapterId || (isChapter ? n.id : chapterId);
    const nl = n.lessonId || (isLesson ? n.id : lessonId);
    for (const k of Object.keys(n)) {
      if (n[k] && typeof n[k] === 'object') walk(n[k], nc, nl);
    }
  };
  walk(dto, '', '');

  const raw = JSON.stringify(dto);
  const keywordInDto = {};
  for (const p of PROBE_KEYWORDS) keywordInDto[p] = raw.indexOf(p) >= 0;

  report.dtoSizeKB = Math.round(raw.length / 1024);
  report.chapterCount = chapterNames.length;
  report.chapterNames = chapterNames;
  report.nodeCount = nodes.length;
  report.passCount = nodes.filter((r) => r.passesGate).length;
  report.keywordInDto = keywordInDto;
  report.nodes = nodes;
  // 只把「被门槛拦下但有信号」的挑出来，这是最可能的元凶
  report.gatedOutWithSignal = nodes.filter((r) => !r.passesGate && r.hasSignal);
  finish(report);
  return 'DTO 来自 window.' + dtoFrom + '；节点 ' + nodes.length + '，过门槛 ' + report.passCount +
    '，有信号却被拦下 ' + report.gatedOutWithSignal.length + '；关键词命中 ' + JSON.stringify(keywordInDto);
})();
