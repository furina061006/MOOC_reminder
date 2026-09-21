# 开发日志索引

> **本文件由 `npm run logs:index` 生成，请勿手改。** 索引里的主题就是各日志的首行 `# 标题`，日期与文件名取自文件本身；`npm run validate` 里有一条测试断言本文件与生成结果逐字节一致，所以忘了跑生成器会被 CI 打回，索引不会悄悄过期。

面向**使用者**的更新记录在 [`changelog.md`](changelog.md)。这里是面向**开发者**的过程记录：为什么这么改、试过哪些死路、根因是什么，以及当时被否决的方案。现行技术事实在 [`.dsh/agents/`](../agents/)（入口见仓库根目录 [`AGENTS.md`](../../AGENTS.md)）——日志是**历史快照**，与现行文档冲突时以 `.dsh/agents/` 为准。

## 常设文档

| 文档 | 说明 |
| --- | --- |
| [`changelog.md`](changelog.md) | 面向用户的版本更新记录（可感知的新增 / 变更 / 修复） |
| [`architecture.md`](architecture.md) | 2026-09-01 的完整架构快照 —— **历史存档**，现行事实见 [`../agents/`](../agents/) |

## 按日期（共 21 篇）

### 2026-09（14 篇）

| 日期 | 主题 |
| --- | --- |
| 2026-09-21 | [「清除数据后再刷新一条都抓不到」的根因与修复](2026-09-21-clear-data-course-recovery.md) |
| 2026-09-21 | [一天回顾：抓取可靠性收尾 → 仓库工程化 → 文档重构 → 发布 1.1.0](2026-09-21-day-summary.md) |
| 2026-09-21 | [反馈入口（Issue 模板 / CONTRIBUTING）+ 仓库卫生](2026-09-21-feedback-entrypoints-and-repo-hygiene.md) |
| 2026-09-21 | [开发日志索引：生成式 + CI 校验](2026-09-21-log-index-generator.md) |
| 2026-09-21 | [README 精简：入口留使用，细节拆到 `docs/`](2026-09-21-readme-refactor.md) |
| 2026-09-21 | [智能体文档从 `.claude/` 迁到 `AGENTS.md` + `.dsh/logs/`](2026-09-21-rename-agent-docs-to-dsh.md) |
| 2026-09-20 | [已追踪课程管理 + 多标签页抓取失败](2026-09-20-course-list-and-tab-fallback.md) |
| 2026-09-20 | [SPOC「老师新增内容」抓不到 — 根因与修复](2026-09-20-spoc-two-term-split.md) |
| 2026-09-18 | [SPOC 作业点击跳转到普通 MOOC 页 — 排查与修复](2026-09-18-spoc-click-target.md) |
| 2026-09-18 | [插件更新检查与「有更新」提醒](2026-09-18-update-check.md) |
| 2026-09-04 | [backlog 2026-09-01 审查问题的修复](2026-09-04-backlog-fixes.md) |
| 2026-09-04 | [文档职责拆分与 README 精简](2026-09-04-documentation-reorganization.md) |
| 2026-09-03 | [无现成课程页的自动代理刷新](2026-09-03-temporary-proxy-refresh.md) |
| 2026-09-01 | [通知链路与页面 CSP 修复](2026-09-01-development.md) |

### 2026-08（1 篇）

| 日期 | 主题 |
| --- | --- |
| 2026-08-16 | [截止提醒修复 + 事件驱动调度](2026-08-16-reminder-fix-and-scheduling.md) |

### 2026-06（6 篇）

| 日期 | 主题 |
| --- | --- |
| 2026-06-28 | [作业类型判定 + 完成检测逻辑（最终定型）](2026-06-28-completion-logic.md) |
| 2026-06-28 | [互评阶段检测修复 + SPOC 字段结构差异](2026-06-28-phase-detection-fix.md) |
| 2026-06-28 | [SPOC 抓取排查全记录](2026-06-28-spoc-debugging-journey.md) |
| 2026-06-27 | [Development Log](2026-06-27-development.md) |
| 2026-06-26 | [开发记录](2026-06-26-development.md) |
| 2026-06-24 | [开发记录](2026-06-24-development.md) |
