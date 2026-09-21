# 2026-06-27 Development Log

## Part 1: API-only 模式修复及 SPOC 课程支持 (上午)

### DOM 关闭后 API 无法工作 — 5 个修复

1. **`triggerManualScrape` 不等待 API 响应** — `BATCH_API_FETCH` 发送后立即返回，DOM 关掉后无同步数据源。修复：DOM 关闭时轮询等待 `lastSync` 更新
2. **`performPeriodicScrape` 只查 learn 标签页** — 无 learn 页时跳过。修复：fallback 到所有 icourse163.org 标签页
3. **`main.js` 消息监听器注册太晚** — 修复：提到 `init()` 最开头
4. **初始抓取不受 `domScrapingDisabled` 控制** — 修复：加 `!domScrapingDisabled` 条件
5. **`COURSE_API_DATA` 重复发送** — 修复：移除重复路径

### SPOC 课程 API 探索

大学物理 (NEU-1474956162) 是 SPOC 课程。测试了 10 个端点全部失败或返回空数据。**关键发现**：

- SPOC 页面的 URL `tid=1476735472` 是**假 termId**：`getLastLearnedMocTermDto.rpc` 只返回 89 字节空壳
- 页面内联 script 中 `window.moocTermDto = {id: 1476504498}` 才是**真实 termId**：返回 217KB 完整课程数据（16 章节、12 作业 + 12 测验，含 userScore/scorePubStatus/usedTryCount 等全部字段）
- 所有 MOOC RPC 端点 (`getMocTermDto`, `getSpocTermDto`, DWR) 对 SPOC 均不可用；唯一可用的 `getLastLearnedMocTermDto.rpc` 在 `lastLearnUnitId:null` 时后端不填充数据

### SPOC 解决方案：WAR 脚本注入 + DOM Bridge

因为 MV3 CSP 阻止内联 script 注入，采用 web_accessible_resource 绕过：

1. `spoc-tid-bridge.js` (WAR) 注入页面上下文 → 读 `window.moocTermDto.id` → 写入 `<html data-mooc-real-termid>`
2. `main.js` (content script) 读 DOM 属性获取真实 termId
3. `batchApiFetch` 用真实 termId 调 `getLastLearnedMocTermDto.rpc` → 拿到完整数据

### domooc 逆向结论

domooc 是 MV2 + webRequestBlocking，在页面初始化前拦截 `mc.stu.126.net` 核心 JS 注入钩子读内部状态树。MV3 不支持此机制——window 扫描和 React Fiber 扫描均无法获取 SPOC 页面内部状态（模块闭包不可达）。**当前方案（真实 termId + API）是 MV3 下的最优解。**

---

## Part 2: 互评完成字段分析及 HttpOnly CSRF 适配 (下午)

### 问题

SPOC 作业「提交了但没做互评、窗口过期」后显示已完成。用户质疑：能否检测用户是否实际完成了互评？

### 诊断方法

在 `main.js` 的 `batchApiFetch` 中插入一次性诊断代码，利用 `chrome.cookies.get()` 读取 HttpOnly CSRF cookie，依次调用两个端点并遍历所有 type:3 作业。

### 完整字段清单

**getLastLearnedMocTermDto.rpc — NODE 层 (17 字段)**
`id, gmtCreate, gmtModified, name, position, termId, chapterId, contentType, contentId, isTestChecked, units, releaseTime, viewStatus, testDraftStatus, test, isModify, visible`

**getLastLearnedMocTermDto.rpc — TEST 层 (19 字段)**
`id, releaseTime, type, name, deadline, testTime, trytime, usedTryCount, evaluateJudgeType, evaluateNeedTrain, evaluateStart, evaluateEnd, evaluateScoreReleaseTime, scorePubStatus, enableEvaluation, userScore, totalScore, bonusScore, examId`

**getOpenHomeworkInfo.rpc — result 层 (19 字段)**
`tid, aid, deadline, evaluateStart, evaluateEnd, evaluateJudgeType, evaluateScoreReleaseTime, name, description, releaseTime, submitStatus, evaluateNeedTrain, scorePubStatus, duration, startTime, questionCount, totalScore, allowSwitchPageCount, switchPageCount`

### 关键发现

| 字段 | 来源 | 含义 |
|---|---|---|
| `submitStatus` | OHInfo | null=未打开, 1=草稿, 2=已提交 — **只追作业提交，不追互评完成** |
| `scorePubStatus` | TEST, OHInfo | 0=互评中, 1=窗口关闭, 2=已公布 |
| `usedTryCount` | TEST | >0 = 已提交 |
| `evaluateStart/End` | TEST, OHInfo | 互评时间窗口 |

### scorePubStatus 含义验证

用户提供实锤证据——SPOC 作业「第六周 静电场I 单元作业」：提交了但**确认没做互评**，窗口已过期。但 `scorePubStatus` = **1**，不是 0。

**结论：`scorePubStatus: 1` = 「互评窗口已关闭」，不等于「用户完成了互评」。** 平台在窗口到期后自动将值从 0 推到 1，不检查用户是否实际提交互评。

### 最终互评判定逻辑

| scorePubStatus | 窗口状态 | Phase | 判定 | 标签 |
|---|---|---|---|---|
| 0 | 窗口内 (now < evaluateEnd) | peerreview | 未完成 | `手动确认` + `互评中` |
| 0 | 窗口过期 (now >= evaluateEnd) | results | 完成 | `自动检测` |
| 1 | — | results | 完成 | `自动检测` |
| 2 | — | results | 完成 | `自动检测` |

- 测验/考试 (type:2/6): `usedTryCount > 0` → 完成
- 作业无互评: `usedTryCount > 0` → 完成
- 作业有互评: 按上表
- **唯一盲区**: 互评窗口内的作业，平台不暴露互评提交状态，标记为「手动确认」

### 同步的代码位置

- `service-worker.js` → `apiDetectPhase`: `scorePubStatus:1` → `'results'`
- `shared/icourse163-api.js` → `detectPhase`: 同上（两文件保持一致）
- `popup.js` → `createHomeworkItem`: 互评中 → 琥珀色 `手动确认` + 黄色 `互评中`

### HttpOnly CSRF Cookie

`NTESSTUDYSI` 变为 HttpOnly → `document.cookie` 读不到。解决方案：

```javascript
// Content script 中:
var cookie = await chrome.cookies.get({
  name: 'NTESSTUDYSI',
  url: 'https://www.icourse163.org/'
});
// fallback: document.cookie.match(...)
```

### Bug 修复

1. **SPOC termId 泄漏到普通课程** — `isSpocPage` 导致所有课程 termId 都被替换成 SPOC 真实 termId。修复：`courseIsSpoc` 仅匹配 SPOC 课程类型或当前页面课程
2. **checkPageHookData 跨课程归属** — 所有 hook 响应都用当前页面 courseId。修复：仅处理 tid 匹配的响应
3. **popup 自动刷新不弹 toast** — 修复：`init()` 中自动刷新成功后也弹 toast

### 涉及文件

| 文件 | 变更 |
|---|---|
| `src/content/main.js` | chrome.cookies CSRF、SPOC termId scope 修复、checkPageHookData 修复 |
| `src/content/xhr-hook.js` | DOM bridge 存储 (data-items on #mooc-hook-data) |
| `src/background/service-worker.js` | apiDetectPhase scorePubStatus:1→results |
| `src/popup/popup.js` | 初始化 toast、手动确认标签 |
| `src/shared/icourse163-api.js` | detectPhase 同步 |
