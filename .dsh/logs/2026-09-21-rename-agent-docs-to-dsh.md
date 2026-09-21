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
