注: 待追踪任务

- [ ] **课程名只有「页面 DOM」这一个来源** —— 注意这**不是**已修的「幽灵课程」（那条修的是「哪些链接算课程」，这条是「课程名本身从哪来」）。现状两条路都不可靠：`main.js` 的 `readCourseName()` 是宽松选择器（`h1, .course-name, [class*="courseTitle"], .m-coursename`）+ `document.title` 兜底；`course-discovery` 取「锚点 `title` 或整段文本」。而抽取器只**复制** `course.courseName`，从不从 API 里取名，所以没有权威来源。附带一个已确认的小缺陷：`COURSE_LINKS` 会拿**空名字**覆盖已有课程名（`upsertCourse` 是浅合并），而 `main.js` 的注释声称「SW 不会用空名字覆盖非空名字」。修法：① 空名字绝不覆盖非空名字（小改、可单测）；② 再给课程名找权威来源 —— 先真机确认 `getMocTermDto` 响应里到底有没有课程级名字，再决定用它还是收紧 `readCourseName()` 的选择器（**取证后再动，别猜**）
- [ ] 合并 SW 内联的 `apiExtractHomework` 与 `src/shared/icourse163-api.js`（两份拷贝已多处漂移，是 2026-09-18 SPOC 修复空转的根因；需先逐字段核对行为差异）
- [ ] `src/popup/options.js` 里的 `DEFAULTS` 是 `src/shared/settings.js` 的第二份副本，易漂移。`loadSettings()` 已改为优先走 `GET_SETTINGS`，剩下的是「SW 与 storage 都失败」时的那份兜底副本 —— 要么删掉（失败就显示空表单），要么让它只在缺字段时回落到 SW 返回值

- [ ] 部分图标太丑了，比如`issue`提交模板那块的, 我有空找找

已修复或已论证放弃的历史问题不再保留在这里，记录位置：

- `.dsh/logs/changelog.md` — 面向用户的版本变更记录
- `.dsh/logs/` — 开发过程、根因分析和技术决策
- `AGENTS.md` — 项目当前事实来源（架构、不变量、已知限制）
