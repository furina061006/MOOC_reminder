# 架构与消息协议

> 入口索引与工作约定在仓库根目录 [`AGENTS.md`](../../AGENTS.md)；本文件是 `.dsh/agents/` 知识库的一部分。

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

- `BATCH_API_FETCH {courses, proxyJobId?}` — SW → CS，触发批量 API 抓取；正常路径发给最近活跃学习页，临时路径附带持久化任务 ID。`courses[]` 的 `termId` 是抓取用的 termId（SPOC 下为 `activeTermId`）、`courseType` 由 `activeTermId` 推导（见关键不变量 9），**不含路由 URL**
- `COURSE_API_DATA {course, rawData}` — CS → SW，API 原始响应。`course` 只声明「抓到了什么」（courseId / 抓取 termId / courseType / 来源页 URL）；点击目标与 SPOC 证据由 SW 从存储的 Course 记录解析（`resolveCourseForExtraction`）
- `COURSE_UPDATE {courseId, activeTermId, courseName, courseType, routeUrl}` — CS(main.js，**仅在真实 SPOC 页发起**) → SW；持久化 SPOC 真实 termId，并把 `routeUrl`（`window.location.href`）冻结为 `course.pageUrl`
- `COURSE_LINKS {courses[]}` — CS(course-discovery) → SW；上报从 icourse163 各页采集到的课程链接，`courseType` 仅按 href 是否含 `/spoc/` 判定，属**弱信号**
- `REQUEST_COURSE_LINKS` — SW → CS，**每轮抓取开始时**发给所有已打开的 icourse163 页面（1.5 秒上限，见 `askOpenPagesToReport`），一次往返干两件事：**重新上报课程**（课程列表自愈）与**探测哪些页面还活着**（只有刚应答过的页面才会被选中去跑 `BATCH_API_FETCH`）。**两个内容脚本都会应答，两者互补**：
  - `course-discovery.js`：重扫页面里的 `/learn/{id}?tid=` 锚点（「我的课程」这类页面只有它有货）
  - `main.js`：上报**本页自己的身份**（`parseCourseUrl(location.href)` + bridge 的 SPOC active term）。**学习页上一个 `/learn/` 锚点都没有**（SPA 菜单是 `data-menu-id="/learn/xxx"`，不是链接，2026-09-21 用真实页面 DOM 验证：35 个 `<a>`，`href` 含 `/learn/` 的 0 个），所以「课程页自报家门」是清除数据后唯一能救回课程的通路
- `TEMPORARY_PROXY_BATCH_COMPLETE {proxyJobId, resultCount}` — CS → SW，临时批量中的所有 `COURSE_API_DATA` 已发出；支持 Service Worker 被回收后恢复清理
- `PAGE_OPENED` — CS(main.js init) → SW；匹配临时 tab ID 时立即开始该任务，否则按 30 分钟节流触发常规全课程刷新
- `TRIGGER_SCRAPE` — Popup → SW，手动刷新
- `GET_UPDATE_STATUS` — Options → SW，读取缓存的更新状态（**不发网络请求**，渲染设置页用）
- `CHECK_UPDATES` — Options → SW，手动「检查更新」；**故意绕过 `autoCheckUpdates` 开关**（该开关管的是后台 tick，不是用户点击）
- `GET_COURSE_LIST` — Options → SW，已追踪课程列表（含每门课的条目数 / 未完成数）+ 已忽略的 courseId 列表
- `TOGGLE_COURSE_IGNORE {courseId, ignored?}` — Options → SW，忽略/恢复追踪；写 `user_settings.ignoredCourseIds`
- `DELETE_COURSE {courseId}` — Options → SW，删除课程记录 + 它的作业条目 + 它的 tombstone（**不清** ignoredCourseIds，两者语义独立）

> [!NOTE]
> **「静音」与「忽略」是两件事**：静音只影响提醒与徽章，课程仍会被抓取（`mutedCourseIds`）；
> 忽略是**停止追踪**，课程不再进入 `buildApiCourseList`，因此**不消耗任何 API 调用**（`ignoredCourseIds`）。
> 忽略状态存在 settings 而不是 Course 记录上，这样 `course-discovery` 反复重新登记该课程也不会把忽略状态冲掉。
> 删除则只清数据：若页面里仍有该课链接，它会被重新自动添加（用户想彻底不再见到它时应当用「忽略」）。

---
