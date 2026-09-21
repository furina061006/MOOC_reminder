# MOOC Reminder — 项目索引（智能体入口）

Chrome / Edge（Chromium 内核）Manifest V3 扩展，自动追踪中国大学MOOC (icourse163.org) 的未完成作业与考试。
**无后端**：所有数据只存在于用户自己的 `chrome.storage.local`，不外传。

> [!IMPORTANT]
> 1. 所有代码开发在 **`dsh` 分支**进行，**经用户允许**才能合并到 `main`；
> 2. **本文件只是索引 + 红线 + 路由表**，分主题的项目事实在 `.dsh/agents/` 下——动手改代码前，按下面的路由表读对应文档，改完再回来更新它。

## 红线（不翻文档也必须记住）

1. **串行锁**：`homework_items` 的读-改-写必须走 `mutateHomeworkItems`；`courses` 必须走 `mutateCourses` / `upsertCourse`。裸 `get→改→set` 会吃掉并发写入（症状：通知重复弹、已完成项被复活、课程丢记录）。→ [不变量](.dsh/agents/invariants.md)
2. **两份拷贝**：`src/shared/icourse163-api.js` 与 SW 内联的 `apiExtractHomework` 必须同步改——运行时用的是内联那份，只改一侧等于没改。→ 不变量 12
3. **SPOC 两个 term 都要抓**：路由 term（老师新增内容）与 active/source term（源课程内容）**内容不重叠**，只抓一个会静默丢掉一半。→ [SPOC](.dsh/agents/spoc.md)
4. **`activeTermId` 是「这门课是 SPOC」的唯一可靠证据**：不能用 `data-mooc-real-termid` 推断（每个学习页都有）。→ 不变量 9
5. **绝不递归进 `node.test`**：它自带 `name` / `type` / `deadline`，会把同一份作业再提取一遍。→ 不变量 15
6. **私密数据不进 git**：`element.txt`、`*.har`、`dto*.json`、`*-report.json`、任何 AI/工具的本机配置。仓库是公开的，有测试守着（别用 `git add -f` 绕过）。
7. **别猜门槛**：某门课抓不到时先按排查流程拿证据，不要靠放宽类型门槛「修掉」症状。→ [排查](.dsh/agents/troubleshooting.md)

## 路由表：要做什么 → 先读什么

| 我要做的事 | 先读 |
| --- | --- |
| 改抓取、解析、完成判定、状态标签 | [`.dsh/agents/extraction.md`](.dsh/agents/extraction.md) |
| 排查「某门课抓不到 / 少几条 / 一条都没有」 | [`.dsh/agents/troubleshooting.md`](.dsh/agents/troubleshooting.md) |
| 动 SPOC、termId、作业跳转链接 | [`.dsh/agents/spoc.md`](.dsh/agents/spoc.md) |
| 动调度、临时代理页、通知、每日摘要 | [`.dsh/agents/scheduling.md`](.dsh/agents/scheduling.md) |
| 调 icourse163 API、查字段含义、加端点 | [`.dsh/agents/platform.md`](.dsh/agents/platform.md) |
| 动数据结构 / storage / 数据流 / 消息协议 | [`.dsh/agents/data-model.md`](.dsh/agents/data-model.md) + [`.dsh/agents/architecture.md`](.dsh/agents/architecture.md) |
| 改代码前逐条核对不变量 | [`.dsh/agents/invariants.md`](.dsh/agents/invariants.md) |
| 发版、打包、CI、Issue/PR 模板、已知限制 | [`.dsh/agents/operations.md`](.dsh/agents/operations.md) |
| 改用户能看到的文档 / 文案 | [`docs/`](docs/)（功能、FAQ、隐私、贡献者）+ 必要时 `.dsh/logs/changelog.md` |
| 想知道「为什么这么改」「踩过什么坑」 | [`.dsh/logs/README.md`](.dsh/logs/README.md)（日志索引；用户可感知的变化在 `changelog.md`） |

## 知识管理约定（每次会话遵守）

- **`AGENTS.md`（本文件）** — 索引 + 红线 + 路由表。**保持精简**：细节写进 `.dsh/agents/`，过程写进 `.dsh/logs/`
- **`.dsh/agents/`** — 分主题的项目事实、不变量、排查流程（本文件的展开）。改代码前按路由表读，**改完要回来更新**
- **`.dsh/logs/changelog.md`** — 面向用户的版本更新记录，按日期记录可感知的新增 / 变更 / 修复
- **`.dsh/logs/`** — 面向开发者的过程记录：为什么这么做、试过哪些死路、根因分析。其 `README.md` 是**生成的索引**（`npm run logs:index`，勿手改）
- **`README.md`** — 面向使用者的**精简入口**（安装 / 使用 / 限制 / 反馈）；细节拆到 `docs/`
- **`docs/`** — 面向使用者的细节文档：`features.md`（功能与技巧）、`faq.md`（常见问题）、`privacy.md`（隐私与权限）、`contributors.md`（致谢与参与）。**不进发布 zip**，所以 README 只能用绝对链接指过来
- **`CONTRIBUTING.md`** — 面向外部贡献者：本地加载扩展、`npm run validate`、隐私红线、仓库结构、PR 流程
- **`.github/ISSUE_TEMPLATE/`** — 外部反馈入口（Bug / 功能建议表单；空白 issue 已关闭）
- **每次重大技术变化后**：先更新 `.dsh/agents/` 对应文档 → 再写 `.dsh/logs/` 开发日志（写完跑 `npm run logs:index` 更新索引）→ 有用户可感知变化时同步 `.dsh/logs/changelog.md`

**为什么本文件必须在仓库根目录**：DSH 只自动加载 `AGENTS.md` / `CLAUDE.md` 这两个**文件名**，而**位置决定作用域**——根目录那份 = 项目级指令（每轮都在上下文里），放在任何子目录（例如 `.dsh/`）就只对那个目录生效。所以索引留在根目录，细节才敢放进 `.dsh/agents/`。

## 相关文档

- `.dsh/agents/` — 架构与消息协议、平台与 API、SPOC、提取判定、排查、调度、不变量、数据模型、工程与发版
- `.dsh/logs/README.md` — 开发日志索引（**生成物**：`npm run logs:index`；`validate` 会校验它没过期）
- `.dsh/logs/changelog.md` — 面向用户的完整更新记录
- `.dsh/logs/architecture.md` — 2026-09-01 的完整架构快照（**历史存档**；现行事实见 `.dsh/agents/`）
- `CONTRIBUTING.md` — 参与开发前先看
- `.github/ISSUE_TEMPLATE/` — Bug / 功能建议表单
