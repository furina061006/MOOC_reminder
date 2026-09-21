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
