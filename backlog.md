注: 待追踪任务

- [ ] **「同一个课程页面只抓取一次，之后再也不抓，必须重新打开页面才行」**（用户 2026-09-20 实测）。
  **2026-09-21 已排除「刷新本身失败」这条支路**（用户浏览器实测：popup 刷新必定能更新，
  课程页全挂后台也能抓到），所以剩下的解释只有**设计行为**：
  - `PAGE_OPENED` **只在 `main.js` 的 `init()` 里发送** → 仅页面加载/重载时触发；SPA 内切换页签（课件/测验/考试）**不发**。
  - `PAGE_OPENED` 的处理有 **30 分钟节流**（`EVENT_REFRESH_MIN_GAP_MS`）→ 即使重新打开页面，距上次成功同步不足 30 分钟也**不抓**。
  - 兜底 alarm 默认 **12 小时**一次；`badge-refresh` 只重算徽章。
  - 只有 popup 的**刷新按钮**（`TRIGGER_SCRAPE`）无节流、必定执行。
  → 「停在页面上不动就再也不抓」是预期行为。**若用户仍觉得数据不够新鲜**，可选产品改动（尚未实现）：
  ① 打开 popup 时触发一次带短节流（如 2 分钟）的刷新；② SPA hash 变化时也发 `PAGE_OPENED`；
  ③ 放宽 30 分钟节流。取舍：每次全量刷新约 = 课程数 × 200KB。
  **⚠️ 改节流前先问用户「多久算新鲜」。**

- [ ] `course-discovery.js` 会把 SPOC 页面上的「源课程」链接也登记成课程（用户反馈：打开 SPOC 大学物理二后，没选过的「大学物理（力学、电磁学）」被自动抓取了）—— 需要区分「我的课程」链接与页面内的推荐/源课程链接
- [ ] `main.js` 的 `checkPageHookData` 仍丢弃路由 term 的页面钩子数据（`entryTid === urlTid` 时 `continue`）。批量抓取已覆盖两个 term，故只是首次打开页面的即时性问题；修它必须同时修 `sendTid`，否则会把路由 term 数据错误归属到 active term
- [ ] 若遇到「同一 courseId 的两个 term 镜像同一批作业」，并集抓取会产生重复条目；届需放宽 `isSameHomeworkCandidate` 的 `termId` 相等要求（改为 courseId + type + 名字 + 截止全等才合并）
- [ ] 合并 SW 内联的 `apiExtractHomework` 与 `src/shared/icourse163-api.js`（两份拷贝已多处漂移，是 2026-09-18 SPOC 修复空转的根因；需先逐字段核对行为差异）
- [ ] `src/popup/options.js` 里的 `DEFAULTS` 是 `src/shared/settings.js` 的第二份副本，易漂移；考虑改为从 SW 读或去掉副本
- [ ] `batchApiFetch` 里「始终补上当前页面课程」的兜底（`main.js`）构造的 course 项**不带 `courseType`**，也没有 SPOC 的 `activeTermId`：万一走到这条路（SW 传来的列表里没有本页课程），SPOC 页会用路由 tid 被当作 MOOC 抓一次。当前正常路径不会走到（SW 的 `buildApiCourseList` 覆盖 SPOC 两个 term），所以没动它；要修就得同时补 `courseType` 与真实 tid
- [ ] 用户 2026-09-20/21 那两份日志里，`Periodic scrape started` 之后**缺少** `Periodic scrape skipped` 那行 warn：要么当时加载的是旧构建，要么 Console 隐藏了 Warnings 等级。**不影响结论**（两种情况修的是同一条通路，且 2026-09-21 已在空课程分支补了 `console.log`）。仅剩诊断价值，不需要为此改代码

已修复或已论证放弃的历史问题不再保留在这里，记录位置：

- `.claude/logs/changelog.md` — 面向用户的版本变更记录
- `.claude/logs/` — 开发过程、根因分析和技术决策
- `.claude/CLAUDE.md` — 项目当前事实来源（架构、不变量、已知限制）
