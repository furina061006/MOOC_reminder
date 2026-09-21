# 2026-09-21 — 智能体文档从 `.claude/` 迁到 `AGENTS.md` + `.dsh/logs/`

## 起因与一个意外发现

用户说「把 `.claude/` 这类 Claude 文件/目录都改成 dsh 类」。改名本身不复杂，但查 DSH 的加载实现时
发现现状其实**缺了一块**：

`packages/context/agent-instructions/src/{config,files}.ts` 里写得很清楚：

- 默认候选文件名只有 **`AGENTS.md`** 和 **`CLAUDE.md`**（外加 `*.local.md` 覆盖层）；
- 加载位置是「**项目根 → cwd 的祖先链**」+「**被访问文件所在的子目录**」（`descendantDirsBetween`）。

也就是说：**根目录的那份 = 项目级指令**（每轮都在上下文里），**子目录里的那份 = 只对该子目录生效**。
而本项目的根目录既没有 `AGENTS.md` 也没有 `CLAUDE.md`，主文档躺在 `.claude/CLAUDE.md`——所以它一直是
「`.claude/` 这个子目录的规则」，只在访问 `.claude/**` 时被加载（本次会话开头的提示正是
「Additional instructions from: .claude/CLAUDE.md … apply to work under `.claude`」）。

所以这次不只是改名，是**把项目事实来源放回它该在的位置**。

## 做了什么

| 之前 | 之后 |
|---|---|
| `.claude/CLAUDE.md` | **`AGENTS.md`（仓库根目录）** |
| `.claude/logs/`（19 篇） | **`.dsh/logs/`**（`git mv`，保留历史） |
| `.claude/settings.json`、`settings.local.json`、`scheduled_tasks.json` | 原地不动（本机、已 gitignore；DSH 不读，Claude Code 若还用得到） |

配套改动：

- `.gitignore`：否定规则 `.claude/logs/` → **`.dsh/logs/`**。这一步不能漏——顶部通用的 `logs/` 规则
  同样会吞掉 `.dsh/logs/`，正是 2026-09-21 早些时候刚踩过的坑（当时整个 `.claude/logs/` 的日志都
  进不了 git，`git status` 还看不出异常）。
- `eslint.config.js`：忽略列表加 `.dsh/**`（保留 `.claude/**`，那是本机目录）。
- `AGENTS.md`：13 处路径引用更新；「知识管理约定」新增一条说明**为什么本文件必须留在根目录**
  （文件名 + 位置决定作用域），避免以后有人顺手把它挪进 `.dsh/`。
- 活文档引用：`README.md`（3 处，含两侧绝对链接）、`CONTRIBUTING.md`（2 处）、`backlog.md`（3 处）、
  `.github/pull_request_template.md`（2 处）、`.dsh/logs/changelog.md`（2 处）、`tools/package-extension.mjs`（注释）。
- 新增测试断言（`tests/unit/repo-hygiene.test.mjs`）：`AGENTS.md` 必须在根目录、`.dsh/logs/changelog.md`
  必须存在**且不被忽略**、旧路径不得复活。
- 历史日志正文里的旧 `.claude/logs/...` 路径**不改写**（存档改写只会制造无意义 diff）；最新那篇
  加了「后记」说明改名。

## 「文件里的 claude 要不要改」——三类分开处理

用户中途问了这个问题，结论是分三类，而不是一刀切：

1. **指路**（`.claude/CLAUDE.md`、`.claude/logs/xxx.md`）→ **必须改**，否则是死链；
2. **陈述事实**（README 的「Vibe Coding（Claude Code / deepseek harness + DeepSeek API）」、
   `.gitignore` 里「Claude Code 的本机脚手架」、禁提交清单里的 `.claude/settings.local.json`）
   → **保留**：它们描述的是真实存在的东西与真实的历史，改了反而是造假；
3. **历史日志正文** → **不改**（存档）。

## 代价与边界

- `AGENTS.md` 约 48KB，现在作为项目级指令**每轮都会进上下文**（DSH 默认 `maxSourceBytes` 1 MiB，
  不会截断）。这是「事实来源随时可见」的预期代价；若将来嫌重，再拆成根 `AGENTS.md`（索引）+
  `.dsh/` 子文档。
- `.claude/` 目录**没有**从磁盘消失，只是从仓库消失（里面三个文件仍被忽略）。用户以后完全不用
  Claude Code 时可以直接删本地目录，对仓库零影响。
- 这次改名**不碰扩展运行时代码**（已核对：`src/` 里没有任何 `.claude` 引用）、manifest、消息协议、存储结构。

## 顺带处理的一个问题

用户发现「贡献者有 claude」：贡献者的提交带 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
（puresky271 10 个、puresky 12 个；用户自己的提交有 117 个）。这些提交**早已公开**，清除只有
「改写历史 + 强推」一条路（SHA 全变、贡献者分支分叉、旧对象仍可能可达），而 README 本来就写着
本项目「99.99% 靠 Vibe Coding」。**用户选择不做任何处理**——所以本文件不记录任何相关改动，
只是说明「为什么仓库里还留着这些 trailer」。

## 验证

- `npm run validate`：lint + 全部单测通过（含新断言）。
- `git check-ignore -v .dsh/logs/changelog.md` 命中 `!.dsh/logs/**`（**这一步必须显式查**：
  被 `logs/` 吞掉时 `git status` 看起来一样干净）。
- `git status` 里 19 篇日志显示为 `R`（rename），不是 `D`+`A`；`git ls-files` 里 `.claude/` 只剩 0 个条目，
  `.dsh/logs/` 19 个 + 根 `AGENTS.md` 1 个。
- 加载机制现场验证：`git mv` 完成后，DSH 立刻提示
  `Instructions from: AGENTS.md` 且 `Instructions removed: .claude/CLAUDE.md`——根目录确实成了项目级指令。

---

## 第三轮（同日）：拆成「根索引 + `.dsh/agents/`」，并把 `.claude/` 整个删掉

用户三个要求：① 把 48KB 的 `AGENTS.md` 拆成根索引 + `.dsh/` 子文档；② 把 `.claude/` 里有用的拿出来、
没用的删掉、**目录不要留**；③ 检查各处路径交接是否完备（点名 `.gitignore`）。

### 拆分

`AGENTS.md`（713 行 / 48,232 字节）按原有章节切成 **9 个子文档**，根文件重写成索引：

| 子文档 | 内容 |
|---|---|
| `.dsh/agents/architecture.md` | 架构、数据流、消息协议 |
| `.dsh/agents/platform.md` | icourse163 平台、API 端点、字段参考 |
| `.dsh/agents/spoc.md` | SPOC 双 termId、路由 URL、排查思路 |
| `.dsh/agents/extraction.md` | 提取门槛、完成判定表、互评阶段 |
| `.dsh/agents/troubleshooting.md` | 「抓不到 / 抓不全」排查流程 + 两个操作性陷阱 |
| `.dsh/agents/scheduling.md` | 调度、临时代理页、通知、CSP、截止提醒数据流 |
| `.dsh/agents/invariants.md` | 15 条关键不变量 |
| `.dsh/agents/data-model.md` | UID/字段/Storage/Course 结构 + 关键设计决策 |
| `.dsh/agents/operations.md` | 测试结构、更新检查、已知限制、开发命令、仓库卫生、发版流程 |

切分用脚本按行区间搬运，并**逐段校验**：原文 28–705 行共 ≈45,336 字节，抽取正文合计 ≈45,325 字节
（差 11 字节来自行尾换行/空行处理），且每个区间都验证过「逐字出现在对应文件里」。索引本身约 6KB。

**关键设计：索引必须带路由表。** DSH 不会自动加载子文档（只认根目录的 `AGENTS.md`/`CLAUDE.md`），
所以新根文件里放三样东西：**红线**（串行锁、两份拷贝、SPOC 双 term、`activeTermId`、`node.test`、
隐私不进 git、别猜门槛——都是不翻文档也不能错的）、**路由表**（要做什么 → 先读哪个文件）、
**知识管理约定**。以后每轮上下文从 48KB 降到约 6KB。

### `.claude/` 里抢救出来的东西

只有一个：`settings.json` 里的 `testCommand: web-ext run --source-dir . --target chromium`，
已写进 `.dsh/agents/operations.md`（并注明 `web-ext` 未列入 devDependencies、要联网 npx）。
其余全部无用并删除：`permissions.allow`（Claude Code 本机权限，含 76 条本机绝对路径）、
`projectConfig.root`（本机路径）、`scheduled_tasks.json`（`{"tasks": []}`）。
`settings.local.json` 通篇是本机路径与命令白名单，无项目信息。**目录已整个删除。**

> 第二轮里写的「`.claude/` 里只留下本机、已忽略的设置文件」被本轮推翻——目录不保留了。

### `.gitignore` 重整（这次是主动设计，不是补丁）

```gitignore
logs/                # 运行时输出；会匹配任意层级的 logs/，所以下面必须否定放行
.dsh/*               # .dsh/ 只跟踪两个子目录，其余（工具本机配置）一律不进仓库
!.dsh/logs/
!.dsh/logs/**
!.dsh/agents/
!.dsh/agents/**
.claude/             # 目录已删；这条只是安全带：以后谁再跑 Claude Code 不会误提交 settings
```

验证方式仍是 `git check-ignore -q --no-index`（`-q` 退出码 0 = 已忽略、1 = 未忽略；
注意**别用 `-v` 判断**：命中否定规则时 `-v` 也会打印并返回 0，容易看反）：

| 路径 | 期望 | 实测 |
|---|---|---|
| `.dsh/logs/changelog.md` | 不忽略 | 未忽略（`!.dsh/logs/**`） |
| `.dsh/agents/platform.md` | 不忽略 | 未忽略（`!.dsh/agents/**`） |
| `.dsh/settings.json` | 忽略 | 已忽略（`.dsh/*`） |
| `.claude/settings.json` | 忽略 | 已忽略（`.claude/`） |
| `logs/x.log`、`element.txt`、`network.har`、`mooc-reminder-v1.0.0.zip` | 忽略 | 均已忽略 |

### 测试与文档同步

- `tests/unit/repo-hygiene.test.mjs`：新增断言——9 个 `.dsh/agents/*.md` 必须存在**且不被忽略**、
  **根 `AGENTS.md` 必须小于 16KB**（防止有人把内容又倒回索引）、`.claude/` 不得复活。
- 活文档引用：`CONTRIBUTING.md`（约定段 + 禁提交表）、`.github/pull_request_template.md`（勾选项）、
  `README.md`（项目结构树 + 「详细架构」链接改为知识库 + 存档说明）、`.dsh/agents/operations.md`（仓库卫生段）。
- `.dsh/logs/architecture.md` 顶部加**历史存档**警示并指向 `.dsh/agents/`——它和新的
  `agents/architecture.md` 会重名，必须让人一眼看出哪个是现行的。
- 历史日志正文照旧不改写。
