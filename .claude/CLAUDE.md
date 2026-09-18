# MOOC Reminder — 开源开发文档

Chrome/Edge Manifest V3 浏览器扩展，自动追踪中国大学MOOC (icourse163.org) 未完成作业。

## 知识管理约定（每次会话遵守）

- **CLAUDE.md（本文件）** — 项目唯一事实来源。所有核心技术结论写在这里，任何开发者打开项目即能理解全貌
- **README.md** — 面向用户的项目说明：安装、使用、功能、限制和当前能力；保持精简，不放完整更新日志
- **`.claude/logs/changelog.md`** — 面向用户的完整版本更新记录，按日期记录可感知的新增、变更和修复
- **`.claude/logs/`** — 面向开发者的过程记录。写「踩过什么坑、试过哪些死路、为什么选方案 A 不选 B」以及实现细节，供想深挖的人追溯
- **Memory** — 仅用于快速回忆。不再重复存储 CLAUDE.md 已有的技术知识，只保留偏好、习惯等个人上下文
- **每次重大技术变化后**：先更新本文件，再写开发日志；涉及用户可感知变化时同步更新 `.claude/logs/changelog.md`，最后更新 memory 索引

文档职责保持清晰：README 面向使用者，`.claude/logs/changelog.md` 面向版本回顾，其余 `.claude/logs/` 文件面向技术追溯。更新日志并入 `.claude/logs/` 是为了避免同一类信息分散在两个目录、产生职权冲突。

---

## 架构

```
src/
├── background/     Service Worker — alarms、消息路由、数据 reconcile、badge
├── content/        内容脚本 — API 代理抓取、SPOC 支持
├── popup/          弹出窗口 — 作业列表、筛选、手动操作
└── shared/         共享模块 — 数据模型、API 解析、存储、设置
```

### 数据流

```
已有 MOOC / SPOC 学习页
  → main.js 注入并发送 PAGE_OPENED
  → Service Worker 复用最近活跃的学习页

没有学习页，但已有载入过的课程
  → Service Worker 从已保存的 courseId + route termId 创建非激活临时学习页
  → 仅该 tab 的 PAGE_OPENED 认领临时任务，避免重复全量抓取

代理页面 main.js
  → chrome.cookies.get({name:'NTESSTUDYSI'}) 读取 CSRF（HttpOnly cookie）
  → XHR POST getLastLearnedMocTermDto.rpc → 200KB+ 完整课程 DTO
  → (可选) getOpenHomeworkInfo.rpc → submitStatus 等补充字段
  → SPOC: spoc-tid-bridge.js (WAR) 读 window.moocTermDto.id → DOM bridge
  → COURSE_API_DATA → Service Worker
    → apiExtractHomework() 解析 → HomeworkItem[]
    → reconcileHomeworkData() 合并（UID 匹配 dedup）
    → updateBadgeFromStorage()
  → 批量响应完成、超时或 tab 被关闭后，只清理扩展自己创建的临时页
```

### 消息协议

- `BATCH_API_FETCH {courses, proxyJobId?}` — SW → CS，触发批量 API 抓取；正常路径发给最近活跃学习页，临时路径附带持久化任务 ID
- `COURSE_API_DATA {course, rawData}` — CS → SW，API 原始响应
- `TEMPORARY_PROXY_BATCH_COMPLETE {proxyJobId, resultCount}` — CS → SW，临时批量中的所有 `COURSE_API_DATA` 已发出；支持 Service Worker 被回收后恢复清理
- `PAGE_OPENED` — CS(main.js init) → SW；匹配临时 tab ID 时立即开始该任务，否则按 30 分钟节流触发常规全课程刷新
- `TRIGGER_SCRAPE` — Popup → SW，手动刷新

---

## icourse163.org 平台

### URL 模式
- MOOC 课程: `https://www.icourse163.org/learn/{school}-{courseId}?tid={termId}#/learn/content`
- SPOC 课程: `https://www.icourse163.org/spoc/learn/{school}-{courseId}?tid={termId}#/learn/content`
- Hash 路由: `#/learn/content`, `#/learn/quiz`, `#/learn/exam` 等

### SPA 特征
- Hash-based routing，无页面重载
- XHR/fetch 动态加载内容，异步渲染
- DOM 类名: `j-` (JS hooks), `m-` (modules), `u-` (utilities)

### CSRF 认证

`NTESSTUDYSI` cookie 用作 CSRF token，加到 API URL 的 `?csrfKey=` 参数。

**⚠️ 该 cookie 是 HttpOnly**，`document.cookie` 读不到。必须用：

```javascript
const cookie = await chrome.cookies.get({
  name: 'NTESSTUDYSI',
  url: 'https://www.icourse163.org/'
});
const csrf = cookie?.value || '';

// Fallback（非 HttpOnly 时还能用）
const m = document.cookie.match(/NTESSTUDYSI=([a-z0-9]+);?/i);
if (!csrf && m) csrf = m[1];
```

需要 manifest 权限: `"cookies"` + `"host_permissions": ["https://www.icourse163.org/*"]`

---

## API 端点

### 主端点: getLastLearnedMocTermDto.rpc

```
POST https://www.icourse163.org/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey={csrf}
Content-Type: application/json;charset=UTF-8
Body: {"termId": 1476504498}
```

返回 ~200KB JSON，结构为 `result.mocTermDto.chapters[]`，每个 chapter 含 `homeworks[]`、`quizs[]`、`exam`。

每个 homework/quiz 节点含 `test` 对象，包含分数、截止日期、互评状态等全部字段。

这是**唯一对 SPOC 可用的端点**（需要真实 termId）。

### 辅助端点: getOpenHomeworkInfo.rpc

```
POST https://www.icourse163.org/web/j/mocQuizRpcBean.getOpenHomeworkInfo.rpc?csrfKey={csrf}
Content-Type: application/json;charset=UTF-8
Body: {"tid": 1247802197, "aid": null, "isDraft": false}
```

返回单个作业的详细信息，含 `submitStatus`（作业提交状态）等补充字段。

### 端点可用性矩阵

| 端点 | MOOC | SPOC |
|---|---|---|
| `getLastLearnedMocTermDto.rpc` | ✅ | ✅ (仅真实 termId) |
| `getMocTermDto.rpc` (+gatewayType=3) | ✅ | ❌ code:-1007 |
| `getMocTermDto.rpc` DWR | ❌ | ❌ |
| `getSpocTermDto.rpc` | — | ❌ code:-1004 |
| `getOpenHomeworkInfo.rpc` | ✅ | ❌ code:-1007 |

---

## API 字段参考

### NODE 层 (getLastLearnedMocTermDto — chapter.homeworks[n])

```
id, gmtCreate, gmtModified, name, position, termId, chapterId,
contentType, contentId, isTestChecked, units, releaseTime,
viewStatus, testDraftStatus, test, isModify, visible
```

- `contentType`: 2=quiz, 3=homework, 6=exam
- `contentId`: 用作 `getOpenHomeworkInfo` 的 `tid` 参数
- `test`: 包含所有状态字段，见 TEST 层

### TEST 层 (node.test)

```
id, releaseTime, type, name, deadline, testTime, trytime,
usedTryCount, evaluateJudgeType, evaluateNeedTrain,
evaluateStart, evaluateEnd, evaluateScoreReleaseTime,
scorePubStatus, enableEvaluation, userScore, totalScore,
bonusScore, examId
```

- `type`: 2=quiz, 3=homework, 6=exam
- `usedTryCount`: >0 = 已提交
- `scorePubStatus`: 0=互评中, 1=窗口关闭, 2=已公布
- `evaluateStart/End`: 互评时间窗口 (ms)
- `evaluateScoreReleaseTime`: 成绩公布时间
- `enableEvaluation`: 是否启用互评
- `evaluateJudgeType`: 1=学生互评, 其他=教师评阅

### getOpenHomeworkInfo.result 层

```
tid, aid, deadline, evaluateStart, evaluateEnd, evaluateJudgeType,
evaluateScoreReleaseTime, name, description, releaseTime,
submitStatus, evaluateNeedTrain, scorePubStatus, duration,
startTime, questionCount, totalScore, allowSwitchPageCount,
switchPageCount
```

- `submitStatus`: null=未打开, 1=草稿, 2=已提交 — **只追作业提交，不追互评完成**
- `aid`: attempt/answer ID
- `startTime`: 用户开始作答时间

---

## SPOC 课程支持

### 问题

SPOC 课程（如大学物理 NEU-1474956162）有**两个 termId**：

| termId | 来源 | 数据量 |
|---|---|---|
| 1476735472 | URL `?tid=` | 89B 空壳 |
| 1476504498 | `window.moocTermDto.id` | 217KB 完整数据 |

### 解决方案

1. `spoc-tid-bridge.js` — web_accessible_resource，通过 `<script src="chrome-extension://...">` 注入页面上下文（MV3 CSP 只允许 chrome-extension:// origin）
2. 页面上下文执行：读 `window.moocTermDto.id` → 写入 `<html data-mooc-real-termid="...">`
3. `main.js` content script 读 DOM 属性 → 获取真实 termId
4. `batchApiFetch` 用真实 termId 调 API

### ⚠️ 关键约束

```javascript
// ✅ 正确：仅 SPOC 课程自身替换 termId
var courseIsSpoc = (c.courseType === 'spoc')
  || (isSpocPage && c.courseId === pageMeta.courseId);

// ❌ 错误：isSpocPage=true 时所有课程都被替换成 SPOC termId
var courseIsSpoc = isSpocPage || (c.courseType === 'spoc');
```

错误写法会导致普通课程的 API 请求用 SPOC 真实 termId，拿到 SPOC 数据但归属到普通课程名下，造成作业重复。

### SPOC 变量名差异

不同 SPOC 课程将真实 termId 暴露在不同 window 变量上：

| 变量名 | 示例课程 |
|---|---|
| `window.moocTermDto.id` | 大学物理 NEU-1474956162 |
| `window.termDto.id` | 军事理论 NEU-1002713003 |

`spoc-tid-bridge.js` 和 `xhr-hook.js` 的 `captureRealTermId()` 均按优先级检查两者。

### SPOC 排查思路（新课程抓不到时）

当某个 SPOC 课程在 bridge 中没有输出 `real termId` 时：

1. **在 SPOC 学习页面 Console 检查**：
   ```js
   window.moocTermDto           // 是否存在？
   window.termDto               // 是否存在？
   Object.keys(window).filter(k => /mooc|term|TermDto/i.test(k))  // 找其他候选
   ```

2. **找含 termId 的页面变量**：遍历上一步输出的列表，看哪个对象有 `.id` 属性且值是数字
3. **确认真实 termId**：打开 Network 标签过滤 `rpc`，刷新页面看页面自身 API 请求中的 `termId` 参数值
4. **更新 bridge**：在 `spoc-tid-bridge.js` 和 `xhr-hook.js` 中加入新变量名

### 涉及文件

- `src/content/spoc-tid-bridge.js` — WAR 脚本，页面上下文读 window.moocTermDto.id
- `src/content/xhr-hook.js` — document_start 注入外部页面 hook
- `src/content/xhr-hook-page.js` — 页面上下文捕获 API 响应和真实 termId
- `src/content/main.js` — init() 注入 bridge → 读 DOM → batchApiFetch 使用真实 termId
- `manifest.json` — bridge 和 xhr-hook-page.js 在 web_accessible_resources

---

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

详细实现见 `.claude/logs/2026-06-28-completion-logic.md`。

---

## 调度与截止提醒（2026-08 定型）

### 调度策略：事件驱动为主，周期 alarm 兜底

MOOC 作业按天更新、提醒阈值是 24h/48h 级，不需要高频轮询：

| 触发源 | 时机 | 说明 |
|---|---|---|
| `PAGE_OPENED`（main.js init） | 用户打开任意 learn/spoc 页 | **主通道**。SW 节流：距上次全量同步 <30min 跳过 |
| `onStartup` | 浏览器启动 | 同上节流，每日新鲜度锚点 |
| `periodic-scrape` alarm | 默认每 12h | 兜底；无学习页时从已保存课程创建非激活临时代理页，由 Content Script 发同源 XHR |
| `badge-refresh` alarm | 默认每 12h | 纯本地重算徽章 + 截止提醒检查 |
| `daily-digest` alarm | 默认关 | 启用后每天定时摘要；当天首次启动浏览器时补发临期摘要 |

SW 唤醒从 ~336 次/天降到 ~102 次/天。`BATCH_API_FETCH` 只发给 `lastAccessed` 最新的一个现有学习页（发给所有标签页 = N 倍重复抓取）；没有现有学习页时最多创建一个扩展拥有的非激活代理页，任务成功、超时或关闭后清理。

「完全脱离浏览器」（外部 cron/后端）不可行：登录 cookie 绑定浏览器 profile，扩展无法在浏览器外取用（与「无后端」设计决策一致）。

### 临时代理页生命周期

1. 只在没有 `/learn/` 或 `/spoc/learn/` 现有标签页且 `courses` 中有已载入的非手动课程时使用。
2. 先创建非激活 `about:blank` 标签页，再把 `{ id, tabId, proxyUrl, phase, deadlineAt, expectedCourseIds }` 写入 `temporary_proxy_job` 并创建一次性 alarm，最后才导航到课程 URL，避免快速 `PAGE_OPENED` 抢在落盘前到达。
3. 仅 `sender.tab.id === job.tabId` 的 `PAGE_OPENED` 可以将 `waiting_ready` 转为 `fetching`；普通用户页绝不被关闭。
4. 临时页的 SPOC 路由使用保存的 URL `termId`，批量 API payload 使用 `activeTermId || termId`，两者不可混用。
5. `BATCH_API_FETCH` 的响应和 `TEMPORARY_PROXY_BATCH_COMPLETE` 都可完成任务；后者覆盖 Service Worker 在批量请求中被 MV3 回收的情况。
6. 90 秒 deadline 覆盖整个临时任务。成功、超时、用户关闭临时 tab、浏览器/扩展重启与重置数据都只清理该 job 记录的 tab ID；并行终结者以持久化 job ID 先到者为准。

### 通知与摘要

- 通知通过 `chrome.notifications` 创建，再由 Chrome 交给 Windows 11；通知中心是否保留记录取决于 Chrome 和 Windows 的通知设置
- 截止提醒按设置阈值逐档通知并去重，免打扰时段内延后
- 每日摘要按截止时间升序排列，最多展示最早的 3 项，其余显示「另有 N 项」；完整列表在 popup 中查看
- 设置页的「系统反馈」只展示通知权限、提醒开关、免打扰状态、可提醒数量和下次检查时间，不修改作业数据

### 页面脚本与 CSP

- `xhr-hook.js` 在 `document_start` 注入外部 `xhr-hook-page.js`
- `xhr-hook-page.js` 通过 `web_accessible_resources` 暴露给 icourse163.org 页面上下文
- 禁止使用 `script.textContent` 注入内联代码，否则会被 icourse163.org 的 CSP 拦截

### 截止提醒数据流

```
badge-refresh tick（或任何 updateBadgeFromStorage 调用）
  → maybeNotifyDeadlines(unfinished)
      ├─ 在途守卫 notifyInFlight（并发 tick 不重复弹）
      ├─ collectDueNotifications()  ← shared/reminder.js 纯函数（可单测）
      │    过滤: checkedOff / 静音 / snooze / 免打扰
      │    判级: getNotificationLevel（每个档位跨越时弹一次）
      ├─ chrome.notifications.create(...)
      └─ mutateHomeworkItems 锁内按 uid 补丁 lastNotificationLevel（绝不整体写回陈旧快照）
```

### 关键不变量（改代码前必读）

1. **`homework_items` 的所有读-改-写必须走 `mutateHomeworkItems`**（shared/items-mutex.js 的串行锁）。直接 `get→改→set` 会与并发的 reconcile/通知写回互相覆盖（症状：通知重复弹、已完成项被复活）。
2. **`courses` 的所有读-改-写必须走 `mutateCourses`**（同一串行锁工厂）。`COURSE_LINKS` 循环注册、`COURSE_UPDATE`（SPOC 真实 termId）和每个 `COURSE_API_DATA` 的 reconcile 都会并发写课程；裸读-改-写会丢课或把 `activeTermId` 回退。`upsertCourse()` 是唯一入口，`RESET_DATA` 也用 `mutateCourses(() => [])` 清空。
3. **SNOOZE 必须同时清 `lastNotificationLevel`**，否则 snooze 到期后同档位永不再提醒（对已过期条目致命）。
4. **digest 先 create 成功再写 `last_digest_date`**；免打扰命中时创建一次性 `daily-digest-retry` alarm 而不是静默丢弃。
5. 点击通知用 `resolveItemUrl(item, courseType)`（shared/item-url.js）兜底重建 URL——API 条目没有 pageUrl。**必须传入课程类型**（或条目自带 `courseType`）：SPOC 在 `/spoc/learn/`，普通课程在 `/learn/`。popup.js 保留一份必须同步的镜像实现。
6. `notifyLeadHours: []`（显式空数组）= 用户关闭所有提前档位，normalizeSettings 不得回退默认值；仅字段缺失才用默认。
7. **临时代理任务只能写 `temporary_proxy_job`，不能借用 `scrape_status`**。先落盘再 `tabs.update()` 导航；只可清理由该持久化 job ID 认领的 tab，现有用户标签页永不关闭。
8. **「清理已完成」依赖 tombstone**：`CLEAR_COMPLETED` 删除条目的同时把 UID 记入 `dismissed_completed_uids`；reconcile 遇到同 UID 的**已完成**新条目时跳过，遇到**未完成**时删除 tombstone 并放行。没有这层过滤，下一次同步会把清理掉的作业重新写回。

### 测试结构

- `tests/unit/*.test.mjs` — shared 纯函数（settings/reminder/item-url/items-mutex/calendar/date-utils/homework-model/icourse163-api/manifest）
- `tests/unit/service-worker.integration.test.mjs` — **stub chrome.* 后 import 真实 SW 模块**，驱动真实 alarm/消息/通知点击路径（通知去重、snooze 重弹、PAGE_OPENED 单标签页分发、digest 重试等）
- `npm run validate` = eslint + 全部 node --test

## 数据模型

### HomeworkItem UID
```
{courseId}_tid{termId}_ch{chapterId}_le{lessonId}_hw{homeworkId}
```
例: `BIT-268001_tid1460270441_ch3_l2_hw5`

### Storage Keys (chrome.storage.local)
- `homework_items` — HomeworkItem[]
- `courses` — Course[]
- `last_sync` — ISO timestamp
- `sync_errors` — 最近错误的环形缓冲
- `user_settings` — 用户偏好
- `scrape_status` — 通用抓取状态（不属于临时代理）
- `temporary_proxy_job` — 扩展拥有的临时代理页任务；含 tab ID、phase、deadline 和预期课程
- `dismissed_completed_uids` — 「清理已完成」的 tombstone 列表；reconcile 据此不再复活已清理的已完成作业
- `popup_ui_state` — popup UI 状态

### HomeworkItem 关键字段
```
{ uid, identityKey, courseId, termId, courseType, title, type, status,
  checkedOff, manuallyCheckedOff, autoDetectedCompleted, completionReason,
  hwPhase, deadline, score, totalScore, source, pageUrl }
```
- `courseType`: 'mooc' | 'spoc' | 'manual'；API 条目从 course 记录带出，用于点击跳转时选择 `/learn/` 或 `/spoc/learn/`。旧条目可能没有该字段，因此 `resolveItemUrl(item, courseType)` 支持调用方显式传入课程类型兜底。

### Course 结构
```
{ courseId, termId, activeTermId, courseName, schoolName, courseType, pageUrl }
```
- `courseType`: 'mooc' | 'spoc' | 'manual'
- `courseId`: `{school}-{numericId}` 格式

---

## 关键设计决策

1. **无后端**: 纯浏览器扩展，所有数据在 chrome.storage.local
2. **API 优先**: 主要完成检测基于 API 字段 (userScore, usedTryCount, scorePubStatus)
4. **手动覆盖自动**: 用户手动勾选永远优先于自动检测
5. **SPA 感知**: URL hash 监控 + DOM MutationObserver
6. **SPOC 支持**: WAR 脚本注入 + DOM bridge 读真实 termId
7. **Reconcile 策略**: UID 匹配 → secondary dedup → 保留手动标记 → API 完成状态不回流

---

## 已知限制

- 首次仍需登录 icourse163.org 并至少载入过一门课程以保存课程路由；之后无现成课程标签页时会短暂创建非激活代理页，登录失效或页面无法加载时会在 90 秒后失败并清理
- 网页 DOM/API 改版可能导致选择器/端点失效
- 不支持跨设备同步 (chrome.storage.local 是设备本地)
- 互评窗口内的作业无法自动判断互评是否完成
- `NTESSTUDYSI` 是 HttpOnly cookie，需 chrome.cookies API 读取
- SW 的 `fetch()` 无法通过 icourse163.org CSRF 认证（origin 不匹配），必须由 content script 发起同源 XHR
- SPOC 页面 `getOpenHomeworkInfo.rpc` 不可用，缺少 submitStatus 补充字段

---

## 开发命令

```bash
# 加载扩展
# chrome://extensions/ → 开发者模式 → 加载已解压的扩展 → 选择项目目录

# Lint
npx eslint src/

# 打包（发布包应排除开发资料、测试和参考工程）
zip -r mooc-reminder.zip . -x ".*" "node_modules/*" "tests/*" "logs/*" "reference_projects/*"
```

## 相关文档

- `.claude/logs/changelog.md` — 面向用户的完整更新记录
- `.claude/logs/architecture.md` — 完整架构文档
- `.claude/logs/2026-06-27-development.md` — 最近开发日志（API 字段分析、互评判定、SPOC 支持）
- `.claude/logs/2026-06-26-development.md` — 背景 API 代理、完成检测重写
