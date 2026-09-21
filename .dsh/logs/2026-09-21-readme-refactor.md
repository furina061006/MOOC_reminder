# 2026-09-21 — README 精简：入口留使用，细节拆到 `docs/`

## 起因

用户：「README 精简一点，开头放下载步骤和使用方法，功能和其他东西拆到别的文档」。

## 分层结果

| 层 | 位置 | 面向谁 | 进发布 zip？ |
|---|---|---|---|
| 入口 | `README.md` | 使用者 | **进**（zip 里有它） |
| 使用者细节 | `docs/{features,faq,privacy,contributors}.md` | 使用者 | 不进 |
| 开发者事实 | `AGENTS.md`（索引）+ `.dsh/agents/`（分主题） | 开发者 / 智能体 | 不进 |
| 历史与变更 | `.dsh/logs/` | 开发者 | 不进 |
| 贡献流程 | `CONTRIBUTING.md` | 外部贡献者 | 不进 |

**README：227 行 / 12,579 字节 → 90 行 / 6,654 字节（约 −47%）**，顺序改成：
徽章 + 一句话 → 遇到问题怎么办 → **下载与安装** → **使用方法** → 常用功能（5 条摘要 + 链接）
→ 局限性 → 隐私说明 → 反馈建议 → 常见问题 → 给开发者 → 致谢 → 许可证。

## 两个必须守住的约束（都是真实的外部依赖）

1. **`## 局限性` 与 `## 反馈建议` 这两个标题不能改**：`.github/ISSUE_TEMPLATE/config.yml`
   用了 `README.md#反馈建议`，`CONTRIBUTING.md` 用了 `README.md#局限性`。改标题 = 外部死链。
   现在有测试断言这两个标题存在。
2. **README 里不能出现相对链接**：它会被打进发布 zip，而 zip 里只有
   `manifest.json / README.md / LICENSE / src/`——`docs/`、`.dsh/`、`CONTRIBUTING.md` 都不在包里。
   所以 README 指向它们的链接一律用绝对 GitHub URL（测试也会拦相对链接）。

## 信息不丢：每一段的去向

| 原 README 章节 | 去向 |
|---|---|
| 功能一览表、徽章颜色、筛选功能、使用技巧 | `docs/features.md`（原样搬运，另加一条「后台标签页会被回收」的说明） |
| 近期合并的 PR 表、贡献者列表 | `docs/contributors.md`（+「怎么参与」） |
| 隐私说明（3 行） | README 保留 3 行摘要；细节新写在 `docs/privacy.md`（逐项存储键、唯一对外请求、**逐条权限解释**、怎么自己核实） |
| 常见问题（原来没有） | 新写 `docs/faq.md`（9 条用户语言问答，把 `.dsh/agents/troubleshooting.md` 的结论翻译过来，不复制开发者细节） |
| 技术栈表 | `.dsh/agents/architecture.md`（新增 `### 技术栈`） |
| API 抓取流程（SW→CS 时序） | `.dsh/agents/architecture.md`（新增 `### 一次刷新的完整时序`，注明是从 README 搬来的） |
| 项目结构树 | `CONTRIBUTING.md`（新增「仓库结构」，并补上 `docs/`） |
| 「最近更新」列表 | **直接删**：它列的四条在 `.dsh/logs/changelog.md` 里都有，属于重复 |
| 「工作原理」图 | **直接删**：与 `.dsh/agents/architecture.md` 的「数据流」重复，没有独有信息 |

## 测试

`tests/unit/repo-hygiene.test.mjs` 新增一条（135 项全绿）：

- `README.md` < 9,000 字节（防止内容又倒回去）；
- README 里不得出现 `](docs/`、`](.dsh/`、`](CONTRIBUTING.md`、`](./`（zip 里会变死链）；
- README 必须保留 `## 局限性` 与 `## 反馈建议` 两个标题（外部锚点）；
- `docs/` 四个文件都存在，且 README 用绝对 URL 指到每一个（拆分后仍然可发现）；
- 每个 `docs/*.md` 都要有返回 `../README.md` 的链接。

## 顺带更新的引用

- `.github/ISSUE_TEMPLATE/bug_report.yml`：模板正文与勾选项里「README 的『使用技巧』」→ 指向 `docs/faq.md`
  （使用技巧已经移出 README）。
- `.github/ISSUE_TEMPLATE/config.yml`：第一个 contact link 从 `README#局限性` 改为 `docs/faq.md`。
- `.dsh/agents/operations.md`：仓库卫生那条补上 `docs/`（zip 里也不含它）。
- `AGENTS.md`：知识管理约定新增 `docs/` 一条（并注明不进 zip）、`README.md` 改述为「精简入口」；
  路由表加一行「改用户能看到的文档/文案 → `docs/`」。

## 判断与未做

- **不写 `changelog.md`**：本次是仓库文档整理，不是用户能感知的产品行为变化；changelog 记的是版本能力变化。
- **没加截图**：我拿不到浏览器截图。建议以后放一张 popup 截图到 `docs/images/popup.png`，
  README 顶部引用一行即可——对「面向学生」的 README 来说这是目前最大的缺口。
- **没动 `INTRODUCTION.md`**（用户此前明确要求保留）。它和新的 `docs/` 内容重叠且已过时，
  属于遗留项：以后要么合并进 `docs/`，要么删——留待用户决定。

## 验证

- `npm run validate`：135 项通过、eslint 0 error。
- 链接脚本：README + `docs/*.md` + `CONTRIBUTING.md` + `AGENTS.md` + `.dsh/agents/*.md` 的相对链接
  **全部落地**；README 的相对链接数为 **0**。
- 锚点：`grep '^## 局限性$\|^## 反馈建议$' README.md` 均命中。
- 打包：`npm run package` → 包内仍是 40 个条目、只有 `MOOC_reminder/{manifest.json,README.md,LICENSE,src/**}`，
  `docs/`、`.dsh/` 命中数为 **0**（产物已清理）。
