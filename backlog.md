注: 待追踪任务
  - **2026-09-20 新观察（用户实测，两条独立现象）**：
    (a) **SPOC 作业「开窗口即可抓」，普通 MOOC 作业「必须位于当前页面才能抓」**。
        线索：`chrome.tabs.query` 后按 `lastAccessed` 排序，而只有**激活标签页**的
        `lastAccessed` 会被刷新；更关键的是 Chrome 会**冻结/节流后台标签页**——被冻结页面的
        内容脚本不执行，`chrome.tabs.sendMessage` 会一直不返回（直到 90 秒超时）。这可以解释
        「只有当前页面能抓」。**待验证**：抓取时看 SW Console 有没有 `Sending BATCH_API_FETCH … to tab X`
        却没有后续（= 后台页没响应），以及被选中的 tab 是否就是激活页。
    (b) **多个窗口全开时「重置数据」后再点刷新 → 一条都抓不到**（用户 2026-09-21 确认用的是
        popup 的「重置数据」）。**根因已确认并修复（2026-09-21）**：
        - `course-discovery` 的全部采集逻辑就是 `a[href*="/learn/"]`，而**学习页上一个这种锚点都没有**
          （真实 SPOC 学习页 DOM 统计：35 个 `<a>`、0 个含 `/learn/`；侧边菜单是 `data-menu-id="/learn/xxx"`）。
          所以「问已打开页面重新上报」在学习页上**永远拿不到东西**，只能靠重新打开页面走 `init()`。
        - `requestCourseRediscovery` 的 `chrome.tabs.sendMessage` 没有超时。冻结的后台渲染进程
          **永不 settle**，整次抓取会静默挂死（日志正好停在 `Periodic scrape started`，与用户日志吻合）。
        **修法**：① `main.js` 应答 `REQUEST_COURSE_LINKS`，自报本页身份（`COURSE_LINKS` + SPOC `COURSE_UPDATE`）；
        ② 重发现改为询问**所有** icourse163 页面（「我的课程」页锚点最全）并给每个应答 1.5 秒上限。
        细节见 `.claude/logs/2026-09-21-clear-data-course-recovery.md`。
        **仍未解决的部分**：只打开着的课程页能被恢复，没打开的课程仍需要打开一次「我的课程」页。

- [ ] **【待确认·最高优先】同一个课程页面只抓取一次，之后再也不抓，必须重新打开页面才行**（用户 2026-09-20 实测）。
  **当前最强解释：这是设计行为，不是 bug。** 证据（2026-09-20 核查）：
  - `PAGE_OPENED` **只在 `main.js:115`（`init()` 内）发送** → 仅页面加载/重载时触发；SPA 内切换页签（课件/测验/考试）**不发**。
  - `PAGE_OPENED` 的处理有 **30 分钟节流**（`service-worker.js:1285`，`EVENT_REFRESH_MIN_GAP_MS`）→ 即使重新打开页面，距上次成功同步不足 30 分钟也**不抓**。
  - 兜底 alarm 默认 **12 小时**一次；`badge-refresh` 只重算徽章。
  - 只有 popup 的**刷新按钮**（`TRIGGER_SCRAPE` → `performPeriodicScrape('manual')`）无节流、必定执行。
  → 因此「停在页面上不动就再也不抓」是预期的；「必须重新打开页面」也是预期的。
  **待确认（一次就能区分）**：点 popup 刷新按钮 —— 能更新 = 设计行为；也不能更新 = 真 bug，需 SW Console 的 `[MOOC Reminder]` 日志定位（候选：`periodicScrapeInFlight` 被未 settle 的 await 占住 / 遗留 `temporary_proxy_job` 让代理创建直接失败 / 某课返回空触发错误却不 fan-out）。
  **若确认为设计行为，可选的产品改动**（尚未实现）：① 打开 popup 时触发一次带短节流（如 2 分钟）的刷新；② SPA hash 变化时也发 `PAGE_OPENED`；③ 放宽 30 分钟节流。需先明确「多久算新鲜」的取舍——每次全量刷新约 = 课程数 × 200KB。
  **⚠️ 拿到日志前不要改代码猜。**

- [ ] `course-discovery.js` 会把 SPOC 页面上的「源课程」链接也登记成课程（用户反馈：打开 SPOC 大学物理二后，没选过的「大学物理（力学、电磁学）」被自动抓取了）—— 需要区分「我的课程」链接与页面内的推荐/源课程链接
- [ ] `main.js` 的 `checkPageHookData` 仍丢弃路由 term 的页面钩子数据（`entryTid === urlTid` 时 `continue`）。批量抓取已覆盖两个 term，故只是首次打开页面的即时性问题；修它必须同时修 `sendTid`，否则会把路由 term 数据错误归属到 active term
- [ ] 若遇到「同一 courseId 的两个 term 镜像同一批作业」，并集抓取会产生重复条目；届需放宽 `isSameHomeworkCandidate` 的 `termId` 相等要求（改为 courseId + type + 名字 + 截止全等才合并）
- [ ] 合并 SW 内联的 `apiExtractHomework` 与 `src/shared/icourse163-api.js`（两份拷贝已多处漂移，是 2026-09-18 SPOC 修复空转的根因；需先逐字段核对行为差异）
- [ ] `src/popup/options.js` 里的 `DEFAULTS` 是 `src/shared/settings.js` 的第二份副本，易漂移；考虑改为从 SW 读或去掉副本
- [ ] `batchApiFetch` 里「始终补上当前页面课程」的兜底（`main.js`）构造的 course 项**不带 `courseType`**，也没有 SPOC 的 `activeTermId`：万一走到这条路（SW 传来的列表里没有本页课程），SPOC 页会用路由 tid 被当作 MOOC 抓一次。当前正常路径不会走到（SW 的 `buildApiCourseList` 覆盖 SPOC 两个 term），所以没动它；要修就得同时补 `courseType` 与真实 tid
- [ ] 用户 2026-09-20/21 那两份日志里，`Periodic scrape started` 之后**缺少** `Periodic scrape skipped` 那行 warn：要么当时加载的是旧构建，要么 Console 隐藏了 Warnings 等级。2026-09-21 已在空课程分支加了两行 `console.log`（询问 N 个页面 / 恢复了 N 门课），下次实测即可区分——**不需要为此改代码**

已修复或已论证放弃的历史问题不再保留在这里，记录位置：

- `.claude/logs/changelog.md` — 面向用户的版本变更记录
- `.claude/logs/` — 开发过程、根因分析和技术决策
- `.claude/CLAUDE.md` — 项目当前事实来源（架构、不变量、已知限制）
