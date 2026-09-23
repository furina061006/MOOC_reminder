# 调度、临时代理页与通知

> 入口索引与工作约定在仓库根目录 [`AGENTS.md`](../../AGENTS.md)；本文件是 `.dsh/agents/` 知识库的一部分。

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

SW 唤醒从 ~336 次/天降到 ~102 次/天。每轮抓取先问**所有**已打开的 icourse163 页面（`REQUEST_COURSE_LINKS`，每个 1.5 秒上限）——既让课程列表自愈，又拿到「哪些页面还活着」：`BATCH_API_FETCH` 只发给**刚应答过**的学习页，按 `lastAccessed` 倒序逐个尝试（发给所有标签页 = N 倍重复抓取）。只有「对方没有 content script」这种确定性失败才会继续下一个，**已应答页面**上的真失败仍明确报错。一个应答的学习页都没有时，最多创建一个扩展拥有的非激活代理页兜底，任务成功、超时或关闭后清理。

「完全脱离浏览器」（外部 cron/后端）不可行：登录 cookie 绑定浏览器 profile，扩展无法在浏览器外取用（与「无后端」设计决策一致）。

### 数据新鲜度：刷新什么时候会发生（别当 bug 修）

- `PAGE_OPENED` **只在页面加载/重载时**由 `main.js` 的 `init()` 发出：SPA 内切换页签（课件/测验/考试）**不发**。
- 事件驱动刷新有 **30 分钟节流**（`EVENT_REFRESH_MIN_GAP_MS`）：距上次成功同步不足 30 分钟时，重新打开课程页也**不抓**。
- 周期 `periodic-scrape` alarm 默认 12h 兜底；`badge-refresh` 只重算徽章。
- **唯一无节流的通路是 popup 的刷新按钮**（`TRIGGER_SCRAPE`）。因此「停在页面上不动就不再更新、必须重新打开页面」是**预期行为**（2026-09-21 用户实测确认：popup 刷新必定能更新，课程页全挂后台也能抓到）。
- 若要让数据更及时，可选改动（**均未实现**）：① 打开 popup 时触发一次带短节流（如 2 分钟）的刷新；② SPA hash 变化时也发 `PAGE_OPENED`；③ 放宽 30 分钟节流。取舍：每次全量刷新 ≈ 课程数 × 200KB。**改节流前先问用户「多久算新鲜」。**

### Service Worker 生命周期与「怎么测冷启动」

MV3 的 SW **约 30 秒没有事件或扩展 API 调用**就被挂起（旧的「启动 5 分钟后回收」已在 Chrome 110 移除）。

**坑：开发者工具开着时 SW 永不挂起**（Chrome 官方博客：*"Never if the developer tools are open"*）。2026-09-23 实测确认——为了看 `[timing]` 日志而打开的 SW「检查」视图，让 SW 连续存活了 854 秒（`bootAge`），四次采样全是热路径，冷启动一次都没量到。**为了观察而打开 DevTools，恰好消掉了要观察的现象。**

要量冷启动：

1. **先关掉 SW 的检查视图**，静置 ≥1 分钟（不点图标、不开 popup）；
2. 从 **popup 侧**量第一条 `sendMessage`（`GET_POPUP_STATE`）的往返时间——`validateAndAutoRepair()` 是 popup 直读 `chrome.storage.local`、不唤醒 SW，所以冷启动只能落在第一条消息上，表现为 `loadUiState` 明显慢、而随后的 `loadData` 正常；
3. SW 内部**看不到**冷启动（模块求值发生在消息投递之前），只能用 popup 侧往返时间，或用模块顶部记的时间戳反推 `bootAge`（小 = 这次消息唤醒了它）。

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
