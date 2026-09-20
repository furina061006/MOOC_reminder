注: 待追踪任务
- [ ] `course-discovery.js` 会把 SPOC 页面上的「源课程」链接也登记成课程（用户反馈：打开 SPOC 大学物理二后，没选过的「大学物理（力学、电磁学）」被自动抓取了）—— 需要区分「我的课程」链接与页面内的推荐/源课程链接
- [ ] `main.js` 的 `checkPageHookData` 仍丢弃路由 term 的页面钩子数据（`entryTid === urlTid` 时 `continue`）。批量抓取已覆盖两个 term，故只是首次打开页面的即时性问题；修它必须同时修 `sendTid`，否则会把路由 term 数据错误归属到 active term
- [ ] 若遇到「同一 courseId 的两个 term 镜像同一批作业」，并集抓取会产生重复条目；届需放宽 `isSameHomeworkCandidate` 的 `termId` 相等要求（改为 courseId + type + 名字 + 截止全等才合并）
- [ ] 合并 SW 内联的 `apiExtractHomework` 与 `src/shared/icourse163-api.js`（两份拷贝已多处漂移，是 2026-09-18 SPOC 修复空转的根因；需先逐字段核对行为差异）
- [ ] `src/popup/options.js` 里的 `DEFAULTS` 是 `src/shared/settings.js` 的第二份副本，易漂移；考虑改为从 SW 读或去掉副本
- [ ] 多一个可以在设置界面看到自己追踪的课程列表，可以选择忽略或者删除
- [ ] 课程抓取似乎有问题，我现在浏览器开多个不同课程界面，但popup抓取不到

已修复或已论证放弃的历史问题不再保留在这里，记录位置：

- `.claude/logs/changelog.md` — 面向用户的版本变更记录
- `.claude/logs/` — 开发过程、根因分析和技术决策
- `.claude/CLAUDE.md` — 项目当前事实来源（架构、不变量、已知限制）
