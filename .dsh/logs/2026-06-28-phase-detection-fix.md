# 互评阶段检测修复 + SPOC 字段结构差异 — 2026-06-28

## 起因

SPOC 课程（大学物理）的互评作业在 popup 中不显示。打开诊断日志后发现该作业被标记为 `checkedOff=true`（已完成），而非预期的未完成互评状态。

## 诊断过程

### 日志采集

在 `apiExtractHomework` 中添加针对 "电磁感应" 作业的诊断日志，输出原始 API 字段和中间变量。关键发现：

```
name: 第十四周 电磁感应（II）单元作业
contentType: undefined                                  ← 无 contentType！
node.type: 3                                           ← 但 type 平铺在顶层
node.test: {}                                          ← 无 test 子对象
node keys: id,releaseTime,type,name,deadline,...,usedTryCount,scorePubStatus,...
test keys:                                             ← test 为空
scorePubStatus: 1                                      ← 平台标记窗口关闭
evaluateEnd: 1782660600000                             ← 今晚 23:30 截止
enableEvaluation: true
usedTryCount: 1
```

### SPOC 数据结构差异（与 MOOC 对比）

| 特征 | MOOC | SPOC（大学物理） |
|------|------|-----------------|
| 类型字段 | `contentType: 3` | `type: 3` |
| 状态子对象 | `node.test` 含全部字段 | 无 `test`，字段平铺在顶层 |
| `scorePubStatus` | 在 `node.test` 内 | 在 `node` 顶层 |
| `enableEvaluation` | 在 `node.test` 内 | 在 `node` 顶层 |

之前代码在 `apiDetectPhase` 只检查了 `node.type || node.test.type`，但 SPOC 既没有 `node.type` 也没有 `node.test`——它用 `contentType` 标识类型。所以相位检测直接返回 `null`。

**更关键的问题**：该作业 `scorePubStatus=1`（平台标记窗口关闭），但 `evaluateEnd`（今晚 23:30）还没到。之前代码看到 `scorePubStatus=1` 就直接返回 `'results'`，**跳过了时间检查**。

### 与高等数学（普通 MOOC）对比

通过高等数学课程日志确认了 `scorePubStatus` 的真实含义：

| scorePubStatus | 含义 |
|---|---|
| `0` | 互评窗口开放中（提交阶段或互评进行中） |
| `1` | 窗口关闭但成绩未出（等成绩） |
| `2` | 成绩已公布 |

大学物理的作业 `scorePubStatus=1` 是平台提前标记的，实际 `evaluateEnd` 未到。

## Bug 清单

### Bug 1：`apiDetectPhase` 缺少 `node.contentType` 后备

**位置**：`service-worker.js:1130`、`icourse163-api.js:135`

**问题**：类型检查只写 `node.type || nt.type`，没加 `node.contentType`。SPOC 数据用 `contentType` 标识类型，导致相位检测直接返回 `null`。

**修复**：加 `node.contentType` 后备 → `String(node.type || nt.type || node.contentType || '')`

### Bug 2：`scorePubStatus: 1` 跳过时间检查

**位置**：`service-worker.js:1137`、`icourse163-api.js:141`

**问题**：
```javascript
if (pub === 1) return 'results';  // 直接返回，不看 evaluateEnd！
```

**修复**：改为先检查 `evaluateEnd` 是否真正到期，没到期则降级到时间判断：
```javascript
if (pub === 1) {
    if (end && now >= end) return 'results';
    if (start && now < start) return 'submit';
    return 'peerreview';
}
```

### Bug 3：`inPeerReview` 和 `phaseDeadline` 的冗余 `scorePubStatus === 0` 门控

**位置**：`service-worker.js` 原第 1273 行、原第 1282 行；`icourse163-api.js` 原第 262 行、原第 271 行

**问题**：即使 `apiDetectPhase` 正确返回 `'peerreview'`，这两处还额外检查 `scorePubStatus === 0`，导致 `scorePubStatus=1` 但 `evaluateEnd` 未到的情况下：
- `inPeerReview` 仍为 `false` → `done = submitted && !false = true` → 打钩
- `phaseDeadline` 不更新为 `evaluateEnd` → 显示过去的提交截止日期 → popup 隐藏

**修复**：直接信任 `apiDetectPhase` 的返回值，移除冗余的 `scorePubStatus === 0` 条件。

## 涉及文件

| 文件 | 变更 |
|------|------|
| `src/background/service-worker.js` | Bug 1, 2, 3 全部修复（内联版本） |
| `src/shared/icourse163-api.js` | Bug 1, 2, 3 全部修复（共享模块版本） |

## `apiDetectPhase` 最终判定逻辑（修复后）

```
node.type 不是 3 且 contentType 不是 3？                → null（非作业）
enableEvaluation 没启用或 evaluateStart 缺失？            → null（无互评）
  ↓
scorePubStatus === 2                                     → 'results'（成绩公布）
  ↓
scorePubStatus === 1
  ├─ evaluateEnd 已过                                    → 'results'（窗口关闭）
  ├─ evaluateStart 未到                                   → 'submit'（还没开始）
  └─ 否则                                                → 'peerreview'（平台提前标1但时间未到）
  ↓
scorePubStatus === 0
  ├─ evaluateStart 未到                                   → 'submit'
  ├─ evaluateEnd 已过                                    → 'results'
  └─ 否则                                                → 'peerreview'
```

## 已知缓存问题

由于 `reconcileHomeworkData` 中的 `apiCompleted` 标记保护（`service-worker.js:589-594`），之前已被错误标记为 `checkedOff=true` 的作业在首次修复后仍会被保护住。需要**连续触发两次抓取**，或用户在 popup 中点击「清除已完成记录」后重试。
