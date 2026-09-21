# 参与贡献

谢谢你有兴趣帮忙！这个项目是「无后端」的浏览器扩展：所有数据只存在用户自己的
`chrome.storage.local` 里，不上传任何服务器。参与方式有三种，按门槛从低到高：

| 方式 | 入口 |
| --- | --- |
| 报告问题 | [新建 Issue](https://github.com/furina061006/MOOC_reminder/issues/new/choose)（选模板；空白 issue 已关闭） |
| 提功能建议 | 同上，选「💡 功能建议」 |
| 改代码 | 本文件，下面的流程 |

## 报告问题前

1. 先看 README 的[局限性](README.md#局限性)与「使用技巧」；
2. **在 `chrome://extensions` 里重新加载扩展，并把已打开的 icourse163 页面刷新一次**。
   只重载扩展而不刷新页面时，页面里没有插件的代码，任何抓取都不会工作——这是最常见的「抓不到」原因。
3. 仍然有问题就提 Issue，模板会问你要日志和诊断输出：
   设置页有「错误报告」；`tools/diagnostics/` 里的脚本能一次性导出扩展存了什么、
   每门课的 `termId`，以及每个课程页面是否还活着。信息给够，通常一轮就能定位。

## 本地跑起来

前置：Node 22+、Chromium 内核浏览器。

```bash
npm ci                # 安装开发依赖
```

加载扩展（不需要构建步骤，仓库根目录就是扩展本体）：

1. 打开 `chrome://extensions/` → 打开右上角「开发者模式」；
2. 「加载已解压的扩展」→ 选择本仓库根目录。

改完代码后的固定动作：**在扩展卡片上点「重新加载」，然后刷新已打开的 icourse163 页面**。
改了 `src/content/**`（content script）一定要刷新页面，改了 `src/background/**` 重载扩展即可。

## 提交之前

```bash
npm run validate      # eslint + 全部单测，CI 跑的就是这个
npm run logs:index    # 只在你写了 .dsh/logs/ 开发日志时需要：重新生成日志索引
npm run package       # 可选：本地打一个「解压即可加载」的 zip，产物在仓库根目录
```

`.dsh/logs/README.md` 是**生成物**（索引的主题就是各日志的首行 `# 标题`），别手改：
`npm run validate` 会断言它和生成结果一致，漏跑 `logs:index` 会被 CI 打回。

CI 会在每个 PR 上跑 `npm run validate`，并产出一个可下载的 zip（在该 run 页面的
**Artifacts** 里，名字是 `mooc-reminder-build`）——审查浏览器扩展的代码门槛高，装上试最快。

## ⚠️ 不要提交抓取产物（重要）

本仓库是**公开**的。调试时抓下来的页面快照和网络抓包里有你自己的课程、账号 ID 和
老师的内容，属于隐私数据：

| 不要提交 | 说明 |
| --- | --- |
| `element.txt` | 页面 DOM 快照，含你的 userId 与课程内容 |
| `*.har` | DevTools 导出的网络抓包，含完整 API 响应 |
| `dto*.json`、`*-report.json` | DTO/诊断脚本的输出 |
| 各种 AI 工具的本机配置 | 例如 `.claude/settings*.json`；`.gitignore` 已整目录挡掉 |

它们已经在 `.gitignore` 里，**不要用 `git add -f` 绕过**——`tests/unit/repo-hygiene.test.mjs`
会检查 git 索引里没有这些文件，CI 会拦下来。需要把抓取内容给别人看时，先自己删掉
课程名、userId 和 cookie 相关字段。

## 仓库结构

```text
MOOC_reminder/
├── manifest.json           # 扩展清单
├── src/
│   ├── background/         # Service Worker（alarms、协调、badge、通知）
│   ├── content/            # 页面注入脚本（API 代理 + SPOC 支持）
│   ├── popup/              # 弹出窗口（HTML/CSS/JS）
│   └── shared/             # 共享模块（数据模型、存储、API 解析、设置）
├── tests/unit/             # 单测（含 SW 集成测试的 chrome.* stub）
├── tools/                  # diagnostics/（排查脚本）、package-extension.mjs（打包配方）、gen-log-index.mjs（日志索引生成器）
├── docs/                   # 面向使用者的文档（功能、FAQ、隐私、贡献者）——不进发布 zip
├── .dsh/agents/            # 面向开发者的分主题事实 / 不变量 / 排查流程
├── .dsh/logs/              # 更新日志与开发日志（README.md 是生成的索引，勿手改）
├── .github/                # Issue 模板、PR 模板、CI 与发布 workflow
├── AGENTS.md               # 索引：红线 + 路由表（指向 .dsh/agents/）
└── README.md               # 面向使用者的精简入口
```

## 提 PR

1. 从 `main` 切一个分支，PR 也指向 `main`；
2. 按 `.github/pull_request_template.md` 的清单填：改了什么、**怎么验证的**（抓取类改动需要说明在真实页面上的验证结果）、清单勾完；
3. CI 通过后维护者会复核；可以直接从 CI 的 Artifacts 里下载 zip 自己先试。

约定：

- **项目事实的入口是仓库根目录的 `AGENTS.md`**（红线 + 路由表），细节在 `.dsh/agents/`；动抓取/解析/SPOC 相关代码前按路由表先读对应文档；
- `src/shared/icourse163-api.js` 与 Service Worker 里内联的 `apiExtractHomework` 是**两份必须同步的拷贝**（见不变量 12），改一侧必须改另一侧；
- `.dsh/` 是**开发者文档目录**（`agents/` = 知识库，`logs/` = 更新日志与开发日志），不是临时输出目录；用户能感知的变化请写入 `.dsh/logs/changelog.md`；写了新日志跑一下 `npm run logs:index`（索引是生成的）；
- **面向使用者的文档在 `docs/`**（功能、FAQ、隐私），`README.md` 是它的精简入口：改了用户能看到的行为/文案，记得同步这两处。注意 `docs/` **不会被打进发布 zip**，所以 README 只能用绝对链接指过去。

## 安全

- 本扩展没有后端、没有账号体系，也不该往任何服务器发数据（唯一的对外请求是查 GitHub Release 版本）；
- 不要把 CI 改成 `pull_request_target` 再 checkout PR 的代码去跑——fork 的 PR 拿不到 secrets 是正确的安全边界，绕过它等于给供应链攻击开门。
