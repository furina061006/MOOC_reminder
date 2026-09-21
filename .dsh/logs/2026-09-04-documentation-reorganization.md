# 文档职责拆分与 README 精简

日期：2026-09-04

## 背景

README 原本同时承担项目介绍、安装使用说明和完整更新日志。随着功能累积，更新日志占据了较大篇幅，普通用户需要滚动很久才能看到开发者相关内容，阅读负担较重。

## 处理方案

将文档按读者和用途拆分：

- `README.md` 面向用户，保留项目功能、安装、使用、限制、隐私和当前能力；只展示几条最近更新摘要。
- `.claude/logs/changelog.md` 面向用户，集中保存完整的日期更新记录，作为版本回顾入口。
- `.claude/CLAUDE.md` 作为项目事实来源，记录核心架构和文档维护规则。
- 其余 `.claude/logs/` 文件面向开发者，记录实现过程、技术决策和排查过程。

README 使用 GitHub Alerts（`[!NOTE]`、`[!IMPORTANT]`、`[!WARNING]`、`[!TIP]`）承载注意事项，避免警告信息和正文混在一起。

### 修订：更新日志并入 `.claude/logs/`

最初把更新日志拆成仓库根目录的 `CHANGELOG.md`，随后发现它与 `.claude/logs/` 职责重叠：两者都按时间记录变更，容易在同一件事上写两遍或彼此不一致，形成职权冲突。

最终决定：更新日志并入 `.claude/logs/changelog.md`，不再保留根目录 `CHANGELOG.md`。保留的区分是「记录什么」而不是「放在哪」：

- `.claude/logs/changelog.md` 只做面向用户的版本变更回顾（新增、变更、修复）。
- 其余 `.claude/logs/*.md` 记录「为什么这么做」的实现过程、踩坑和取舍。

`README.md`、`.claude/CLAUDE.md`、`backlog.md` 中指向 `CHANGELOG.md` 的引用已同步改为 `.claude/logs/changelog.md`。

## 同步修正

文档迁移期间同步修正了几处已过期内容：

- `INTRODUCTION.md` 不再描述每日摘要仅在早上发送。
- `INTRODUCTION.md` 更新为当前的临时非激活代理页数据流和完成判定，修正考试与互评阶段的旧规则。
- `INTRODUCTION.md` 不再要求用户必须保持 icourse163 学习页打开；首次载入课程后，无现成学习页时可使用临时代理页。
- `backlog.md` 标明 2026-09-01 审查是历史快照，并标记临时代理、默认设置和架构文档等已解决条目。
- `backlog.md` 中指向不存在开发日志的链接改为指向更新日志。
- `.claude/CLAUDE.md` 的发布打包命令补充排除 `reference_projects/`，避免将逆向参考工程放进发布包。

## backlog 逐条复核（2026-09-04）

对 `backlog.md` 的 2026-09-01 审查记录逐条对照当前代码复核，避免只凭标题判断「已解决」：

- 已解决 3 条：无课程标签页时的后台抓取、popup/options 旧默认值、旧架构文档失配。
- 触发路径已失效 1 条：`course-discovery.js` 非 learn 页的 `BATCH_API_FETCH` 分支仍用 `document.cookie` 读 HttpOnly cookie，但新调度只向 learn/spoc 学习页或临时代理页发送该消息，该分支已不会被触发。属死代码 + 错误实现，建议清理。
- 仍存在 4 条：
  1. `resolveItemUrl()` 两处实现硬编码 `/learn/`，且 HomeworkItem 无 `courseType`，SPOC 条目点击会跳到错误路由。
  2. `upsertCourse()` 仍是裸读-改-写，`courses` 没有 `homework_items` 那样的串行锁。
  3. `makeManualHomeworkUid()` 哈希未包含 `courseId`，同名课程可生成相同 UID。
  4. `CLEAR_COMPLETED` 物理删除已完成项，无 tombstone，下一次同步会重新写回。

复核结论已写回 `backlog.md`。同一轮随后完成了这 4 条 + 1 条死代码的修复，详见 `.claude/logs/2026-09-04-backlog-fixes.md`；`backlog.md` 中的已解决条目已按约定删除。

## 结果

用户从 README 可以快速完成安装和使用，完整历史可通过 `.claude/logs/changelog.md` 查看；开发者仍可通过 `.claude/CLAUDE.md` 和其余 `.claude/logs/` 文件追溯架构与实现背景。