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

---

## 后记（同日晚）

用户改主意了：**`INTRODUCTION.md` 已删除**（`git rm`）。

理由（也是它该走的理由）：它是一份过时的「README 重复版」——内容与 `docs/` 重叠，
却停留在没有更新提醒、没有 FAQ、反馈只留邮箱的年代；而上一节说的「本次没动它」写在这里后
就被这条推翻了。删除前确认过：仓库里**没有任何活文档引用它**（只有几篇历史日志提到过它，
那属于存档，不改写）。

面向使用者的文档现在只有两处：`README.md`（入口）与 `docs/`（细节）；面向开发者的在
`AGENTS.md` + `.dsh/agents/`，历史在 `.dsh/logs/`——再没有第五个地方。

---

## 第五轮（同日晚）：用户自己加了截图 + 反馈入口改「Issues 主 / 邮件兜底」

用户自己改了 README（加两张截图、重排「使用方法」与「常用功能」），并问：popup 底部的反馈建议
该写 Issue 还是继续写邮箱。顺带发现他这版 README 会让 CI 变红。

### README 的三处修正（保留他的意图，只修结构性错误）

1. **相对图片链接会砸两件事**：README 会被打进发布 zip，而 zip 里没有 `docs/` → 用户解压后图片是断的；
   同时 `tests/unit/repo-hygiene.test.mjs` 那条「README 不得出现相对链接」直接报错（实测 `not ok`）。
   改成绝对 raw URL：`https://raw.githubusercontent.com/furina061006/MOOC_reminder/main/docs/images/…`。
2. **图片文件名改成 ASCII**（`课程页面.png` → `course-page.png`、`popup页面.png` → `popup.png`）：
   中文文件名在 URL 里要百分号编码，写在 markdown 里难看，别的渲染器也容易坏。
3. **Markdown 结构**：`> [!tip]` 改成 `> [!IMPORTANT]`（GitHub 的 admonition 只认大写，小写会当成普通引用）；
   块引用原来被一行没带 `>` 的正文截成两半；列表项里的图片只缩进 2 空格（`3. ` 的内容缩进需要 3+），
   改成 4 空格并补空行，图才真正落在列表项里。

### 隐私核对（公开前查过）

- `course-page.png`：问候语里的名字用户自己已打码；我把右上角「个人中心」头像与右下角浮动头像
  裁出来放大看过——**分别是画笔 emoji 头像和插画客服形象，不是本人照片**，没有 PII。
  剩下可见的信息只有课程名（概率论与数理统计）与作业日期。
- `popup.png`：显示了他实际在追的 4 门课程名 + 邮箱（邮箱本来就在 README 里）。课程名属于个人偏好，
  用户自己判断即可。
- 图片不进发布 zip，只随仓库公开。

### 反馈入口：Issues 主 + 邮件兜底

判断依据：使用者主要是学生，**很多没有 GitHub 账号** → 只留 Issues 会直接把一部分反馈挡在门外；
但只留邮箱的代价是反馈不沉淀（搜不到、看不到进度、维护者还得反复要日志）。
所以两个都给，主次分明：

- `src/popup/popup.html` 页脚：原来是最差的组合——邮箱是**纯文本，根本点不了**；
  现在是 `反馈：GitHub Issues · 邮件` 两个链接（Issues 在前，title 里写明「推荐：别人能搜到、
  模板会引导你附日志」）。
- `src/popup/popup.css`：给页脚链接加了 `color: inherit` + 下划线，小字里也看得出可点。
- `src/popup/popup.js`：复用已有的 `openUrl()`（`chrome.tabs.create` 优先）打开 Issues 选择器；
  用 `preventDefault` 阻止 `href="#"` 跳转。
- `src/popup/options.html` + `options.js`：设置页空间大，写成两行说明——第一行推荐 Issues 并解释为什么，
  第二行给「没有 GitHub 账号 / 涉及账号信息」的人留邮箱。
- `docs/features.md`：功能表里「反馈渠道」那行同步成「可一键提 Issue（推荐）或发邮件」。

验证：`npm run validate` 135 项通过、eslint 0 error（README 那条断言已转绿）；
HTML 里的 `id="feedback-issues"` 与两个 JS 的接线都对得上。
