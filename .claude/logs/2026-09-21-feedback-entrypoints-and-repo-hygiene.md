# 2026-09-21 — 反馈入口（Issue 模板 / CONTRIBUTING）+ 仓库卫生

## 起因

「我想让别人能给我的仓库提意见」——现状是 README 只留了一个邮箱。邮箱的问题是**不沉淀**：
搜不到、看不到进度、别人也不知道某个问题是否有人提过；而且每份报告都要来回问好几轮才能定位
（「抓不到作业」这一句话背后可能是重载扩展、后台页被冻结、登录过期、某门课没登记……）。

顺带发现两个仓库卫生问题（见下），一并处理。

## 做了什么

### 1. 反馈入口 = Issues + 模板（Discussions 暂不开）

- `.github/ISSUE_TEMPLATE/bug_report.yml`（GitHub Issue Forms）：字段刻意精简，但**问在点子上**——
  插件版本、浏览器版本、现象、「有没有重新加载过扩展 + 刷新页面」、`[MOOC Reminder]` 日志、
  可选贴 `tools/diagnostics/dump-extension-state.js` 的输出。表单顶部直接写明两条操作性陷阱。
  **模板在这里的作用不是「规范格式」，而是把模糊抱怨变成可处理的信息**：使用者是学生，不是开发者，
  他们不会主动给日志。
- `.github/ISSUE_TEMPLATE/feature_request.yml`：先问「想解决什么问题」，并写明本项目「无后端、数据不外传」
  的前提（涉及云同步的建议基本不会采纳）。
- `.github/ISSUE_TEMPLATE/config.yml`：`blank_issues_enabled: false` + 两个 contact link（README 排查指引、邮件兜底）。
  标签只用 GitHub 默认的 `bug` / `enhancement`，**不需要手动建标签**。
- `.github/pull_request_template.md`：把「`npm run validate`」「不得提交抓取产物」「两份 extractor 副本要同步」
  变成勾选项。
- `CONTRIBUTING.md`：本地加载扩展（重载扩展 → 刷新页面）、`npm run validate`、隐私红线、PR 流程与安全红线。

**为什么不开 Discussions**：它适合不追求关闭的问答/投票。这个体量开了只会把同一件事分流到两个地方，
维护者还得两头看。等 Issue 里「怎么用」类问题多到淹没 bug 再开也不迟。

### 2. Actions：只加一件事

仓库本来就有 `ci.yml`（push+PR → lint+test）与 `release.yml`（tag → 校验 → 打包 → Release），
所以「什么时候需要 Actions」这个问题其实已经答过了：**这件事必须由机器、在特定事件上、可复现地做，
而你不想手动做**。真正缺的只有一件——**PR 要能产出可安装的 zip**：审查浏览器扩展的代码门槛很高，
装上试最快。于是在 `ci.yml` 里加 `npm run package` + `upload-artifact`。

顺手消除了一处必然漂移的副本：发布包的**文件清单原来只写在 `release.yml` 的 shell 里**。
如果 CI 再抄一份，就又是一对「必须手工同步的拷贝」（这个项目已经被这种漂移坑过，见 CLAUDE.md 不变量 12）。
现在清单只在 `tools/package-extension.mjs`，两个 workflow 都调 `npm run package`；
脚本把过程日志写 stderr、产物名写 stdout，所以 workflow 用 `--silent | tail -n 1` 取到一个干净的值。

## 仓库卫生：两个真问题

### A. `.gitignore` 的 `logs/` 把 `.claude/logs/` 整个吞了

`.gitignore` 里有一条通用的 `logs/`（本意是运行时输出），它匹配任意层级的 `logs/` 目录——于是
**`.claude/logs/` 里的每一篇新日志都进不了 git**。CLAUDE.md 一直在引用 `2026-06-27-development.md`、
`2026-06-26-development.md`、`2026-06-28-completion-logic.md`，而这三篇在公开仓库里**根本不存在**。
只有早期几篇（在规则加上之前）和少数被 `git add -f` 过的是被跟踪的，所以问题一直没暴露。

修法：显式放行 `.claude/logs/`（`!.claude/logs/` + `!.claude/logs/**`），并把 6 篇补进 git
（`2026-06-24`、`2026-06-26`、`2026-06-27`、`2026-06-28-completion-logic`、`2026-06-28-spoc-debugging-journey`、
`2026-08-16`）。文件末尾那些私密产物的规则在后面，仍然照旧生效。

### B. `.zcode/plans/*.md`（另一个 AI 工具的规划残留）被提交进了仓库

`.gitignore` 里的规则写成了 `zcode/`（少了开头的点），而真实目录是 `.zcode/`，所以挡不住。
已 `git rm` 该文件并修正规则。内容本身没有价值（同样的结论已经在开发日志里）。

### C. 删除本地的私密抓取产物

- `element.txt`（88KB 真实页面 DOM）、`network.har`（23MB 网络抓包）：含使用者自己的课程、userId、
  老师内容，仓库公开 → **直接删掉**。删除前确认过 `git log --all -- element.txt network.har` 为空，
  即它们从未进过 git，所以不需要改写历史、不需要强推。
- `.claude/logs/session-2026-06-17.md`、`session-2026-06-21.md`：早期会话记录，已被日期化开发日志取代。
- **保留** `INTRODUCTION.md`（用户要求保留）、`reference_projects/`（505MB 参考实现，已被 .gitignore 排除）。

### D. 新增守门测试 `tests/unit/repo-hygiene.test.mjs`

光靠「记得」不够，所以把两条不变量写成测试：

1. `element.txt` / `*.har` / `dto*.json` / `*-report.json` / `.claude/settings.local.json` / 本地打包 zip
   既被 `.gitignore` 忽略，也**不在 `git ls-files` 里**——`.gitignore` 挡不住 `git add -f`，索引检查才挡得住；
2. 社区入口文件与打包配方还在（issue 表单必需字段、`blank_issues_enabled: false`、两个 workflow 都调
   `npm run package`、`release.yml` 里不再有第二份文件清单）。

## 两个约定（顺手写进 CLAUDE.md）

- **README 会被打进发布 zip，而 zip 里没有 `.claude/` 和 `CONTRIBUTING.md`** → README 里指向它们的链接
  必须用绝对 GitHub URL（相对链接在用户解压后是死链）。这次把 changelog / architecture 两处也改了。
- 打包清单只有 `tools/package-extension.mjs` 一处，别在 workflow 里另抄。

## 验证

- `npm run validate`：133 个测试通过（新增 4 个），eslint 0 error / 18 warning（基线未变）。
- 三个 issue 模板与两个 workflow 的 YAML 都能被 PyYAML 解析；表单含 `name/description/body/labels`。
- 本地模拟发版取产物：`asset="$(npm run package --silent | tail -n 1)"; test -f "$asset"` 通过；
  包内 40 个条目，只有 `MOOC_reminder/{manifest.json,README.md,LICENSE,src/**}`，无 `.claude/`、`tests/`、
  `.github/`、`tools/`。

## 留给用户的两步（本机没有 gh、也不该替用户动远端）

1. 仓库 **Settings → Features** 确认 Issues 已开启（模板与 config 已经进仓库，开关不在代码里）。
   想加自定义标签（如「需要日志」）需先在 UI 建好，模板里的 `labels:` 才会生效。
2. `dsh` 目前没有远端跟踪，且本地 `main` 比 `origin/main` 领先 2 个提交；推哪些、怎么合并由用户决定。
