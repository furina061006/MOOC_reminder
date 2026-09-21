# SPOC 抓取排查全记录 — 2026-06-28

## 初始症状

第二个 SPOC 课程（军事理论 NEU-1002713003）抓不到作业。大学物理能工作。

## 排查路线

### 1. 代码审计 → 发现 4 个 bug

逐文件追踪 SPOC 数据流，发现：

| # | Bug | 文件 |
|---|-----|------|
| 1 | `apiRefreshCourse` 只用 `course.termId`，忽略 `course.activeTermId` | service-worker.js |
| 2 | BATCH_API_FETCH 映射未带 `courseType`，CS 无法识别 SPOC 课程 | service-worker.js |
| 3 | `checkPageHookData` 用假 termId 写 SW，产生重复 UID | main.js |
| 4 | `reconcileHomeworkData` 调用 `upsertCourse` 时用空 name 覆盖已有名称 | service-worker.js |

**修复** → 扩展能跑了，但军事理论依然 `itemCount:0`。

### 2. EP 日志 → 确认 API 有数据，但解析不出

加日志看每个端点的响应长度：

```
大学物理: termId=1476504498 len=217966 ✅  → 26 条作业
军事理论: termId=1476008448 len=72646  ✅  → 0 条作业
```

72KB 数据但解析出 0 条 → 数据结构问题。

### 3. 逐层打日志 → 发现 contentType 决定一切

SPOC data struct 日志输出：

```
topKeys: [code, result, message, traceId, sampled]
resultKeys: [lastLearnUnitId, mocTermDto]
mocKeys: [..., chapters]
chapters: 15
totals: hw=0 qz=15 ex=0 le=56
```

数据完整。查第一个测验结构：

```
quiz0 keys: [id, name, contentType, test, ...]
quiz0.name: "第一节 国防概述"
quiz0.test keys: [deadline, userScore, totalScore, usedTryCount, ...]
```

**根因**：`apiExtractHomework` 的 `name` 正则 `/测验|作业|考试|测试|quiz|exam|homework|test/i` **不匹配** "第一节 国防概述" → 跳过。

`deadline` / `userScore` 不在顶层而在 `node.test` 子对象中 → `hasSignal` 也为 false。

**修复**：`contentType`（2=测验, 3=作业, 6=考试）优先于名字匹配 + 信号字段同时查 `node.test`。

### 4. 串数据（跨课程污染）

修复后军事理论出现在 popup 但作业内容等于大学物理的。

**根因**：`courseIsSpoc` 用了 `isSpocPage || c.courseType === 'spoc'`。当在大学物理页面上处理军事理论时：
- `c.courseType === 'spoc'` → true
- `data-mooc-real-termid` 来自大学物理页面 → 拿到大学物理的 termId
- 军事理论的 termId 被错误替换为大学物理的 → API 返回大学物理的数据

**修复**：仅当 `isSpocPage && c.courseId === pageMeta.courseId`（当前页面就是本课程）时才用 DOM 属性替换。

### 5. 变量名差异（bridge未找到真实termId）

大学物理用 `window.moocTermDto.id`，军事理论用 `window.termDto.id`。

spoc-tid-bridge 和 xhr-hook 只查了前者，所以 bridge 永远抓不到军事理论的真实 termId。

**修复**：增加 `window.termDto` 第二优先级 + 内联脚本正则后备。

## 方法论总结（下次遇到新 SPOC 课程时）

### 新课程抓不到 → 排查链路

```
ItemCount=0?
  ├─ EP 日志看 API 有无数据
  │   ├─ len=0 → termId 不对（bridge没抓到）
  │   │   └─ Console: Object.keys(window).filter(k => /term|Dto/i.test(k))
  │   └─ len>0 → 数据结构问题
  │       └─ SPOC struct 日志看：
  │           ├─ chapters/hw/qz 统计为 0 → 数据格式不同
  │           └─ quiz0.name 不含关键词 → 加 contentType 匹配
  └─ 串数据？
      └─ 检查 courseIsSpoc + DOM termId 替换逻辑
```

### 关键 Console 命令（在 SPOC 学习页面执行）

```js
// 找真实 termId 的变量名
Object.keys(window).filter(k => /mooc|term|TermDto/i.test(k))

// 检查各变量值
moocTermDto  // → {id: ...}
termDto      // → {id: ...}
```

### 扩展自带诊断日志

所有诊断日志以 `[MOOC Reminder]` 开头，关键标记：

| 日志前缀 | 含义 |
|----------|------|
| `SPOC tid bridge:` | bridge 是否抓到真实 termId |
| `SPOC real termId persisted` | COURSE_UPDATE 已持久化 |
| `SPOC: using real termId` | batchApiFetch 替换成功 |
| `SPOC: cross-page handling` | 跨页面处理 SPOC（依赖 SW 的 termId） |
| `SPOC: 跳过钩子数据假 tid` | 新的 SPOC 假 termId 过滤生效 |
| `SPOC struct for` | 顶层/result/mocTermDto/chapters 层级 |
| `SPOC totals:` | 全部章节的 hw/quiz/exam/lesson 统计 |
| `apiExtractHomework:` | 解析到了若干 candidate items |

## 涉及的文件

```
src/content/spoc-tid-bridge.js     — WAR 读真实 termId + 后备正则
src/content/xhr-hook.js            — document_start 拦截 + 读 termId
src/content/main.js                — batchApiFetch + checkPageHookData + init
src/background/service-worker.js   — apiRefreshCourse + apiExtractHomework
src/shared/icourse163-api.js       — extractHomeworkFromTermDto（同步维护）
```
