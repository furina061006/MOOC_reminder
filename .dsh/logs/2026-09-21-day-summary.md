# 2026-09-21 一天回顾：抓取可靠性收尾 → 仓库工程化 → 文档重构 → 发布 1.1.0

这一天的 22 个开发提交**全部在 `dsh` 上做**，分 9 次合并进 `main`，最后在 `main` 上打了 tag **`v1.1.0`**。
（`main` 自己没有直接提交，只有合并。）

分六个部分，每部分给出「做了什么 + 关键提交 + 详细日志」；细节不在这里重复。

---

## A. 抓取可靠性：用户报的两个现象，其实是三个真 bug

| 现象 | 根因 | 修法 | 提交 |
| --- | --- | --- | --- |
| 「清空数据 / 删除课程后刷新，一条都抓不到」 | 学习页上**没有任何 `/learn/` 锚点**（侧边菜单是 `data-menu-id`），而「重新发现」只会采集锚点；且它**只在课程列表整体为空时**才跑 | `main.js` 自报本页身份；**每轮抓取**都问一遍所有已打开的 icourse163 页面（每页 1.5 秒上限） | `f86b8bb` `433c2c7` |
| 「某门课不切到它的页面就抓不到」 | 后台标签页被浏览器冻结/卸载；旧流程按 `lastAccessed` 挑一个页面就发批量，挑中冻结页要白等 90 秒并把**整轮**判失败（所以「过一会儿又好了」） | 先用探针问出「谁还活着」，批量**只发给刚应答过的页面**；一个都没有就退到临时代理页 | `b8a4a09` `766c658` |
| 刷新失败但 popup 只显示空白 | 空课程列表的出口**完全静默**，既不打日志也不写 `sync_errors` | 按「无课程 / 只有手动条目 / 全被忽略」三种原因分别打日志 + 写错误报告 | `79530b6` |

配套：诊断脚本 `tools/diagnostics/dump-extension-state.js` 现在会列出每个 icourse163 页面的
`discarded`（是否已被浏览器卸载）与 `answered`（此刻是否应答），能一眼回答「这门课为什么缺」（`293c3f5`）。

**结论：用户在真实浏览器中确认修好**（清空数据后能恢复、后台页面也能抓到、作业跳转目标正确）。

详细日志：[2026-09-21-clear-data-course-recovery.md](2026-09-21-clear-data-course-recovery.md)

## B. 设置页「已追踪课程」管理

设置页能看到追踪中的课程（含「未完成 / 共几条」），并可以**忽略**（停止追踪，不消耗 API，随时恢复）
或**删除**（清掉课程 + 作业 + 它的 tombstone）。忽略状态存在 `user_settings` 而不是课程记录上，
所以「课程发现」反复重新登记也不会把忽略冲掉。`86da79b`

详细日志：[2026-09-20-course-list-and-tab-fallback.md](2026-09-20-course-list-and-tab-fallback.md)

## C. 仓库工程化：让外部人能提意见

- Issue 表单（🐞 Bug / 💡 功能建议）+ `config.yml`（关掉空白 issue，把两条操作性陷阱写进表单）
  + PR 模板 + `CONTRIBUTING.md`（隐私红线、本地加载、PR 流程、**别用 `git add -f`**）。
- CI 每个 PR 产出一个**可安装 zip**；顺带把打包配方**收敛到 `tools/package-extension.mjs` 一处**
  （原来只写在 `release.yml` 的 shell 里，再抄一份进 CI 就又是一对必然漂移的副本）。
- 卫生：删除本机私密抓取产物 `element.txt` / `network.har`；`git rm` 误提交的 `.zcode/plans/*`；
  新增 `tests/unit/repo-hygiene.test.mjs` 守门（`.gitignore` 挡不住 `git add -f`，索引检查才挡得住）。

`57e0902` `3cd3ada` `84ae201`
详细日志：[2026-09-21-feedback-entrypoints-and-repo-hygiene.md](2026-09-21-feedback-entrypoints-and-repo-hygiene.md)

## D. 文档体系：`.claude/` → `AGENTS.md` + `.dsh/`

- 读 DSH 的指令加载实现（`packages/context/agent-instructions/src/{config,files}.ts`）发现关键事实：
  只自动加载 **`AGENTS.md` / `CLAUDE.md`** 这两个**文件名**，而**位置决定作用域**——根目录那份是
  项目级指令，放在子目录就只对那个目录生效。
  于是原来的 `.claude/CLAUDE.md` 其实只是「`.claude/` 的规则」，**项目级指令一直是缺的**。
- `.claude/CLAUDE.md` → 根目录 `AGENTS.md`；随后把 48KB 的文档**拆成索引 + `.dsh/agents/` 九篇**
  （架构、平台/API、SPOC、提取判定、排查、调度、不变量、数据模型、工程与发版）。
  拆分用行区间搬运 + 逐段「原文逐字出现在对应文件里」校验，45,336 → 45,325 字节（差 11 字节来自行尾处理）。
- `.claude/` **整个删除**（只抢救出 `web-ext run` 一条命令，折进 operations 文档）；
  旧日志目录同时从 `.claude/logs/` 改名为 `.dsh/logs/`。

`363bd87` `26f0642` `84ae201`
详细日志：[2026-09-21-rename-agent-docs-to-dsh.md](2026-09-21-rename-agent-docs-to-dsh.md)

## E. README、用户文档与 UI

- README **227 行 / 12.6KB → 90 行 / 6.6KB**：下载安装与使用方法放最前；功能表、徽章颜色、筛选、
  使用技巧、贡献者与 PR 记录等拆到 `docs/`（`features` / `faq` / `privacy` / `contributors`）。
- 两张截图进 `docs/images/`；因为 README 会进发布 zip 而 `docs/` 不进，图片链接必须用**绝对 URL**
  （用户最初写成相对路径，会让 zip 里断图、也会让卫生测试变红）。
- 删掉过时的 `INTRODUCTION.md`。
- **反馈入口改成 Issues 主 + 邮件兜底**：popup 页脚原来是纯文本邮箱（根本点不了），现在是
  「反馈：GitHub Issues / 开发者邮件」两行；设置页写成两行说明（第一行推荐 Issues 并解释为什么，
  第二行给没有 GitHub 账号或涉及账号信息的人）。随后修掉页脚在窄宽度下从中间挤断的问题
  （`.footer-info` 从横向 flex 改为纵向三行）。

`6fd97e1` `df51e82` `066c877` `d282e9b`
详细日志：[2026-09-21-readme-refactor.md](2026-09-21-readme-refactor.md)

## F. 发布 1.1.0

`manifest.json` 1.0.0 → **1.1.0**（`package.json` 对齐），changelog 的「未发布」段定版为
`## 1.1.0（2026-09-21）`，`main` 上打附注 tag **`v1.1.0`**。
本地模拟过发版三件事：tag 与 manifest 版本一致、`npm run package` 产出 `mooc-reminder-v1.1.0.zip`（608K）、
`npm run validate` 全绿。`6189b46`

记录：[changelog.md](changelog.md)

---

## 走过的死路与被否决的方案（留给以后）

1. **`.gitignore` 里用 `logs/` 忽略「运行时日志」**：它会匹配**任意层级**叫 `logs` 的目录，而本仓库里
   唯一叫 `logs` 的目录恰恰是要共享的 `.dsh/logs/`——已经害一批日志没进仓库，还得靠否定规则救场。
   现在改成**按文件类型**挡（`*.log` / `npm-debug.log*`），并加了反向断言（任何 `logs` 目录都必须能跟踪）。
2. **给 `.dsh/logs/` 加一个 README 索引**：我先写了一版「日志目录（索引）」，用户明确否掉——
   他要的是**把当天的事写进日志本身**，不是再套一层目录。这条偏好记住：日志目录里只放日志，
   不要额外造索引文件。
3. **代码里曾有「两份 `apiExtractHomework` 拷贝」的历史坑**（不变量 12）：这一天没有合并它们，
   但每次改抓取都要记得两侧同步。

## 当天留下的待办（用户侧）

- 推送 `main`（已完成：`origin/main` 已跟到 `51fb3f9`）与 tag **`v1.1.0`**；tag 推上去后
  Release workflow 会自动打包并发版。
- 仓库 **Settings → General → Features 勾上 Issues**——否则 popup / 设置页里那个
  「GitHub Issues」链接会打不开。
- 用真机验证一次「更新提醒」（这是唯一还没在浏览器里验证过的新功能）：装 1.0.0 应提示 1.1.0，
  装 1.1.0 后不再提示。

---

## 后记（同日晚）：日志索引回来了，但换成生成式

上面「走过的死路」第 2 条否掉的是**手写散文式**索引——要人重新读日志、提炼、归类，漏一次就过期。
用户随后问「索引其实可以有，就是后期维护会不会太麻烦」，于是同一个需求换了形态：索引**完全由日志派生**
（主题 = 各日志首行的 `# 标题`，日期 / 文件名 / 月份分组取自文件本身），写日志时本来就要写标题，
所以不增加任何写作成本；`repo-hygiene.test.mjs` 断言索引与生成结果**逐字节一致**，手改或漏跑都会被
`npm run validate` 打回。

结论修正为：**「日志目录里不要额外造索引文件」的偏好，针对的是需要人工维护的索引**；生成 + CI 校验的
索引是零维护的，可以要。细节见 `2026-09-21-log-index-generator.md`。
