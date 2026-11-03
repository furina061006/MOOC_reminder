# 作业提取与完成判定

> 入口索引与工作约定在仓库根目录 [`AGENTS.md`](../../AGENTS.md)；本文件是 `.dsh/agents/` 知识库的一部分。

## 自动检测判定逻辑

### 判断流程

```
递归遍历所有节点（chapters → lessons/homeworks/quizs/exam → test）
  ├─ hasSignal?（有 deadline 或 score）
  │    └─ n
  │    └─ y → contentType 是 2/3/6？或名字含关键词（仅 contentType 空缺时）
  │         └─ n → 跳过
  │         └─ y → 提取为作业项
  │              └─ done？
  │                   ├─ userScore > 0 → 完成（① 有成绩）
  │                   ├─ usedTryCount > 0 && (type:3 || type:6)
  │                   │    └─ inPeerReview? → y → 等待互评（手动确认）
  │                   │    └─ no → 完成（② 已提交）
  │                   └─ 含已完成/已批阅文本 → 完成（③ 文本标记）
```

### 完成判定表

| 类型 | 条件 | 判定 |
|---|---|---|
| quiz (type:2) | `userScore > 0` | 完成 |
| exam (type:6) | `userScore > 0` | 完成（标签：手动确认） |
| exam (type:6) | `usedTryCount > 0` 且有成绩 | 完成 |
| 显式考试（`taskType`/`nodeType`/`examId`） | `parts[].usedTryCount > 0` | 完成（新版考试的尝试次数在子试卷上） |
| homework 无互评 | `usedTryCount > 0` | 完成 |
| homework 互评中 (窗口内) | `scorePubStatus:0` + `now < evaluateEnd` | **未完成** |
| homework 互评中 (窗口过期) | `scorePubStatus:0` + `now >= evaluateEnd` | 完成 |
| homework 窗口关闭但未到期 | `scorePubStatus:1` + `now < evaluateEnd` | 未完成（降级到时间判断） |
| homework 窗口关闭且到期 | `scorePubStatus:1` + `now >= evaluateEnd` | 完成 |
| homework 成绩已公布 | `scorePubStatus:2` | 完成 |

### 互评阶段 (apiDetectPhase)

```javascript
function apiDetectPhase(node) {
  var nt = node.test || {};
  var t = String(node.type || nt.type || node.contentType || '');
  if (t !== '3') return null;                           // 仅作业有互评
  var e = node.enableEvaluation != null ? node.enableEvaluation : nt.enableEvaluation;
  var es = node.evaluateStart != null ? node.evaluateStart : nt.evaluateStart;
  if (!e || es == null) return null;
  var pub = parseInt(node.scorePubStatus != null ? node.scorePubStatus : nt.scorePubStatus, 10) || 0;
  if (pub === 2) return 'results';
  if (pub === 1) {
    // 平台标记了窗口关闭，但实际 evaluateEnd 可能未到
    var end = parseInt((node.evaluateScoreReleaseTime || nt.evaluateScoreReleaseTime) || (node.evaluateEnd || nt.evaluateEnd), 10);
    if (end && Date.now() >= end) return 'results';
    if (start && Date.now() < start) return 'submit';
    return 'peerreview';                                 // 平台提前标1但时间未到
  }
  var now = Date.now();
  var start = parseInt(es, 10);
  var end = parseInt((node.evaluateScoreReleaseTime || nt.evaluateScoreReleaseTime) || (node.evaluateEnd || nt.evaluateEnd), 10);
  if (start && now < start) return 'submit';
  if (end && now >= end) return 'results';
  return 'peerreview';                                   // 互评进行中
}
```

`node.test` 后备：部分 SPOC 课程的互评字段（`scorePubStatus`/`evaluateStart`/`evaluateEnd`）不在顶层而在 `test` 子对象中。

### 互评检测的局限性

**平台 API 不暴露「用户是否完成了互评」的字段。** 

- `submitStatus` (getOpenHomeworkInfo) 只追作业提交，不追互评
- `scorePubStatus: 1` 表示「互评窗口已关闭」，不等于「用户完成了互评」
  - 已验证：SPOC 作业未做互评、窗口过期后 scorePubStatus 仍然是 1

**唯一盲区**：互评窗口内的作业 (scorePubStatus:0)。这个阶段不知道用户是否已提交互评，所以标记为「手动确认」。

### Popup 标签

| 条件 | 标签 |
|---|---|
| 互评窗口内 (scorePubStatus:0 + 窗口内) | `手动确认`(琥珀色) + `互评中`(黄色) |
| 考试 (所有) | `手动确认`(琥珀色) |
| 其他所有自动判定 | `自动检测`(绿色) |

### contentType 优先级

API 提供 `contentType` 字段作为类型标识，优先级高于名字正则：

| contentType | 含义 |
|---|---|
| 2 | quiz（测验） |
| 3 | homework（作业） |
| 6 | exam（考试） |

名字正则（`/测验|作业|考试|测试|quiz|exam|homework|test/i`）**仅当 contentType 空缺时**启用，防止"期末考试"因名字含"测试"被误提取。

### node.test 后备规则

所有信号和完成检测字段同时检查顶层和 `node.test` 子对象，`node.xxx || node.test?.xxx`——顶层优先：

| 用途 | 读 node.test？ | 原因 |
|------|:---:|------|
| hasSignal（提取门槛） | ✅ | deadline/score 可能在 test |
| apiDetectPhase（互评） | ✅ | scorePubStatus 等在 test |
| submitted（已提交） | ✅ | usedTryCount/type 在 test |
| classifyType（分类） | ✅ | contentType 优先，test.type 后备 |
| 名字正则提取 | ❌ 仅 contentType 空缺时 | 避免误匹配 |

**注意**：部分 SPOC 课程的数据是反过来的——**没有 `node.test`，所有字段平铺在节点顶层**（如大学物理使用 `node.type` 而非 `node.contentType`）。此时顶层优先规则自然生效，`apiDetectPhase` 也通过 `node.contentType` 后备来兼容这种结构。

详细实现见 `.dsh/logs/2026-06-28-completion-logic.md`。

## 新版学习页（2026-10）的考试

新版普通课程页（`/mooc/learn/…/exams`）的考试数据可能不在 `getLastLearnedMocTermDto` 的章节树里：章节里的
`{"name":"期末考试","nodeType":"legacy-exam","contentType":2}` 只是占位节点，**没有 deadline**；完整数据在页面
内联的 React Flight 数据 `outline.exams[]` 中（见 [platform.md](platform.md) 的「新版学习页的 Flight 数据」）。

提取器的两条补充规则（两份副本同步，不变量 12）：

| 规则 | 原因 |
|---|---|
| `taskType:'exam'` / `nodeType:'exam'|'legacy-exam'` / 有效 `examId` 视为显式考试，可绕过 contentType 门槛 | 平台已明确声明类型，不是名字猜测；`examId:'-1'` 是测验占位值，不算 |
| `parts[].deadline` 可作为 `hasSignal` 的截止时间；考试的 `parts` 子树不再递归 | 新版考试的截止时间可能只写在客观题/主观题子试卷里 |

名字正则仍只在 contentType 缺失时兜底；不要把这条改成「名字含考试就放行」。现有实现见
`isExplicitExam` / `firstPartNumber`（shared）与 `apiIsExplicitExam` / `apiFirstPartNumber`（SW 内联）。

## 同名条目的去重（只在同一章内生效）

提取的最后一步会合并「名字几乎相同且共前缀」的噪音项（如「期末测试题」vs「期末测试」，长度差 ≤2）。**合并只在同一个 `chapterId + lessonId` 容器内进行**，跨章节的同名条目必须保留；没有 `chapterId` 的节点不参与合并（宁可留重复，也不丢真实条目）。

2026-10-21 的真实案例：`NEU-1002123005`「高级语言程序设计」（智慧慕课，`/mooc/learn/…/assessments?tid=1488158441`）把八周的作业都命名为「本周作业」、测验都叫「本周测验」。DTO 里 16 个节点**全部带 deadline**，旧的纯名字去重把后七周整批删掉，界面只剩 3 条（每章第一次出现的那个名字）。改为按容器合并后 16 条全部提取。

两份拷贝同步：`src/shared/icourse163-api.js` 与 SW 内联的 `apiExtractHomework`（不变量 12）；`tests/unit/icourse163-api.test.mjs` 与 `tests/unit/service-worker.integration.test.mjs` 各有一条回归测试。
