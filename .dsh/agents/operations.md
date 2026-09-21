# 工程、发版与已知限制

> 入口索引与工作约定在仓库根目录 [`AGENTS.md`](../../AGENTS.md)；本文件是 `.dsh/agents/` 知识库的一部分。

### 测试结构

- `tests/unit/*.test.mjs` — shared 纯函数（settings/reminder/item-url/items-mutex/calendar/date-utils/homework-model/icourse163-api/update-check/manifest）
- `tests/unit/service-worker.integration.test.mjs` — **stub chrome.* 后 import 真实 SW 模块**，驱动真实 alarm/消息/通知点击路径（通知去重、snooze 重弹、PAGE_OPENED 单标签页分发、digest 重试、更新检查与去重等）。**该文件的 `globalThis.fetch` 默认抛错**（模拟离线），因为 SW 每个 badge-refresh tick 都会查更新 —— 测试绝不能真的联网
- `npm run validate` = eslint + 全部 node --test

---

## 更新检查（2026-09）

**能力边界**：本扩展以「开发者模式」侧载，manifest 没有 `update_url`/`key`，**Chrome 永远不会自动更新它**，`chrome.runtime.requestUpdateCheck()` 也是空操作。所以这里只能做到「发现新版 → 通知 + 给出下载直链」，真正的更新由用户重新下载解压完成。若将来要真正的自动更新，只有两条路：上架 Chrome 网上应用店，或自建签名 CRX + `update.xml` 托管。

**版本来源**：仓库最新 GitHub Release（`api.github.com/.../releases/latest`）。Release 由 `.github/workflows/release.yml` 从 `v*` tag 生成，且该 workflow **强制 tag 与 `manifest.json` 的 version 一致**，所以 tag 可以放心当作「用户能下载到的版本」。tag 里非数字的内容（如 `1.0.0-beta`）一律判为「不是更新」，避免一直骚扰用户。

**数据流**：

```
badge-refresh alarm（12h）→ checkForUpdates()
  ├─ settings.autoCheckUpdates === false → 直接返回缓存，不发请求
  ├─ fetch RELEASES_API_URL → evaluateRelease(payload, 本机 version)
  │    （纯函数在 shared/update-check.js：版本比较 / 解析 / URL 白名单）
  ├─ 写入 update_status（失败时保留上次的「最新版本」，但「是否有更新」按当前版本重算，见不变量 16）
  └─ 更新可用且该版本没提醒过 → notifyUpdateAvailable()
       └─ create 成功才记 notifiedVersion（见不变量 13）

设置页「更新」区块 → GET_UPDATE_STATUS（读缓存，零请求）渲染
  「检查更新」按钮 → CHECK_UPDATES（manual，绕过开关）→ 同上
  「前往下载」按钮 / 点击系统通知 → 打开 Release 的 ZIP 直链
```

**设计取舍**

- **搭 12h `badge-refresh` 的便车**，不新增 alarm：更新检查不值得多唤醒 SW（与「降频」决策一致）。
- **网络失败保留上次成功结果**，只把 `error` 写上：一次离线不应让「有新版本」的提示消失，也不应把 UI 清空。但保留的是**「最新版本」这个客观事实**，「是否有更新」必须按当前运行版本重算（`isNewerVersion`）——照抄上次的布尔值会让已升级的用户继续被提示更新（不变量 16）。
- **缓存必须对齐到「正在运行的版本」再显示**（2026-09-22 真机发现）：`update_status` 是上次检查那一刻的快照，`currentVersion` 与 `updateAvailable` 都是**对着当时那个已加载实例**算的；而侧载扩展换版本只有「重新加载」一条路，`onInstalled` / `onStartup` **都不跑更新检查**（唯一自动调用点是 12h 的 `badge-refresh`，且重载会清掉并重建 alarm，所以重载后首次自动检查最长要等 12h）。于是刚装好 1.1.0 的用户会在设置页看到「当前版本 v1.0.0」——明明已经装上了。现在 `GET_UPDATE_STATUS` 先经 `reconcileStatus()`：保留「最新版本 / 上次检查时间」，把 `currentVersion` 换成运行版本并按它**重算** `updateAvailable`（装上了就不再是「有新版」）；拿不到运行版本时原样返回，不猜。只在读取时对齐、**不回写 storage**——真正的检查会自己刷新快照。设置页渲染也优先用响应里的实时 `currentVersion`，缓存值只作兜底（第二道保险）。
- **「本次检查失败」与「有新版本」必须各自呈现**：设置页里两者曾是 `if / else if`，于是只要上次的结论是「有更新」，失败原因就被吞掉，页面呈现为「当前版本 = 最新版本，却让你点『前往下载』」且不给任何解释（2026-09-22 真机第二次截图）。现在两者可同时出现，失败原因照实显示。
- **优先 ZIP 直链而非 Release 页面**：面向小白，少一次点击。
- **设置开关 `autoCheckUpdates` 默认开、可关**：关掉后后台完全不发请求；但「检查更新」按钮仍可用（用户主动点击不受开关限制）。
- 通知文案与设置页都写明「只发这一个请求，不含任何作业或账号数据」。

---

## 已知限制

- 首次仍需登录 icourse163.org 并至少载入过一门课程以保存课程路由；之后无现成课程标签页时会短暂创建非激活代理页，登录失效或页面无法加载时会在 90 秒后失败并清理
- 网页 DOM/API 改版可能导致选择器/端点失效
- 不支持跨设备同步 (chrome.storage.local 是设备本地)
- 互评窗口内的作业无法自动判断互评是否完成
- `NTESSTUDYSI` 是 HttpOnly cookie，需 chrome.cookies API 读取
- SW 的 `fetch()` 无法通过 icourse163.org CSRF 认证（origin 不匹配），必须由 content script 发起同源 XHR
- SPOC 页面 `getOpenHomeworkInfo.rpc` 不可用，缺少 submitStatus 补充字段
- **同一 `courseId` 的 SPOC 与普通 MOOC 无法并存**：`courses` 以 `courseId` 为唯一键，两者会碰撞，目前规则是 SPOC 优先（不变量 11）。若用户同时选修同名 MOOC 与 SPOC，只能看到一个课程分组
- **SPOC 课程需要至少打开过一次学习页**，才能把真实路由 URL 冻结进 `course.pageUrl`；否则旧的 SPOC 条目只能退回用 `courseType` + 抓取 termId 拼 URL（前缀对，`?tid=` 是 API id）。从旧版本升级后请打开一次 SPOC 课程页
- **「清除数据 / 删除课程」后只能靠当时打开着的页面恢复课程列表**：SW 每轮抓取都会问所有已打开的 icourse163 页面（学习页自报身份、其他页面报锚点，见「两个操作性陷阱 2」），所以**没打开的课程不会自动回来**——要完整恢复就打开一次「我的课程」页（`home.htm#/home/course`），或逐门重新打开课程页
- **被浏览器冻结/卸载（Memory Saver）的后台课程页无法参与任何环节**：它既不能上报课程，也不能接手抓取。此时插件会退到临时代理页，所以「刷新不出东西」不会再发生；但那门课若从未被登记过，仍需要它的页面被打开一次（切换回去即会自动重载并登记）
- **无法自动更新**：开发者模式侧载的扩展 Chrome 不会更新，只能提醒用户去 Release 下载（见「更新检查」）。且更新检查依赖仓库里存在 Release —— 只打 tag 不发 Release 会让检查一直失败
- **更新检查需要 `https://api.github.com/*` 的 host 权限**，用户在扩展详情页能看到这一条；未认证请求有 60 次/小时限流（12h 一次检查远够）。关闭 `autoCheckUpdates` 后后台不再发任何请求
- **`api.github.com` 在部分网络下会偶发不通**（国内直连尤其常见），此时检查失败、设置页显示「本次检查失败：…」并保留上次成功的结果。这类失败**不会**被当成「已是最新」，也不会重复弹通知；失败原因同时写进 `update_status.error`，SW 控制台有 `[MOOC Reminder] Update check failed:` 一行可查

---

## 开发命令

```bash
# 加载扩展
# chrome://extensions/ → 开发者模式 → 加载已解压的扩展 → 选择项目目录

# Lint
npx eslint src/

# 校验（lint + 全部单测）
npm run validate

# 更新开发日志索引（.dsh/logs/README.md 是生成物，新写日志后跑一次；validate 会校验）
npm run logs:index

# 本地打一个「解压即可加载」的 zip（与 CI/发版共用同一份配方）
npm run package
```

### 想让浏览器真的跑起来

手工加载（首选，零依赖）：`chrome://extensions/` → 开发者模式 → 「加载已解压的扩展」→ 选仓库根目录。
改完 `src/content/**` 要**刷新页面**，改完 `src/background/**` 在扩展卡片上点「重新加载」。

也有 `web-ext` 这条路（**未列入 devDependencies**，要临时联网拉取；已经在跑扩展时不必用）：

```bash
npx web-ext run --source-dir . --target chromium
```

> 这条命令是从已删除的 `.claude/settings.json` 里抢救出来的唯一有用信息（其余是本机权限与本机路径）。
> 它同时写着的 `targetPlatforms: chrome, edge` 与 manifestVersion 3，README 和 `manifest.json` 里本来就有。

### 仓库卫生（2026-09-21）

- **私密抓取产物一律不进 git**：`element.txt`、`*.har`、`dto*.json`、`*-report.json`，
  以及任何 AI/工具的本机配置（如 `.claude/` 下的 settings）
  （它们含用户自己的课程/账号数据，而仓库是公开的）。`.gitignore` 挡一层，`tests/unit/repo-hygiene.test.mjs`
  再检查 git 索引里没有这些文件——**不要用 `git add -f` 绕过**。
- **反馈走 `.github/ISSUE_TEMPLATE/`**（空白 issue 已关闭）。改模板时记得它同时是排查分流器：
  「重载扩展 + 刷新页面」和「后台页会被冻结」这两条陷阱写在表单里，能挡掉大半重复的「抓不到」。
- **README 会被打进发布 zip，而 zip 里只有 `manifest.json`、`README.md`、`LICENSE`、`src/`**（不含
  `.dsh/`、`docs/`、`CONTRIBUTING.md`），所以 README 里指向这些文件的链接必须用绝对 GitHub URL，
  相对链接在用户解压后是死链。面向使用者的细节文档在 `docs/`，但它**不进包**。
- 打包清单只有一处：`tools/package-extension.mjs`（CI 的 PR 产物与发版都调它），别在 workflow 里另抄一份。
- **日志索引是生成的，不是手写的**：`.dsh/logs/README.md` 由 `tools/gen-log-index.mjs` 从各日志首行的
  `# 标题` 生成（主题 = 标题，日期/文件名/月份分组取自文件本身），新增日志后跑 `npm run logs:index`。
  `tests/unit/repo-hygiene.test.mjs` 断言它与生成结果**逐字节一致**，所以手改或漏跑都会被
  `npm run validate` 打回——「索引过期」这件事因此不靠自觉。非日期文件要进索引，得在生成器的
  `STANDING_DOCS` 里登记一行（没登记会直接报错，避免某篇日志悄悄从索引里消失）。

### 发版流程（.github/workflows/release.yml）

推一个 `v*` tag 即自动完成「校验 → 打包 → 建 Release」，产物 `mooc-reminder-v{version}.zip`
解压后是 `MOOC_reminder/` 文件夹，小白可直接「加载已解压的扩展」。

```bash
# 0. 确认在 dsh 且工作区干净：git branch --show-current / git status --short
# 1. 改版本号：manifest.json 与 package.json **两处**（没有测试守着这两者的同步，见下）
#    同时把 changelog 的「## 未发布」改成「## {version}（{date}）」
# 2. 在 dsh 上提交 release: {version}，然后合并 dsh → main（需用户许可，见文首约定）
# 3. 在 main 上打同版本 tag 并推送 —— 推 tag 这一步才触发发版
git tag -a v1.0.1 -m "MOOC Reminder 1.0.1" && git push origin v1.0.1
```

**tag 版本必须与 `manifest.json` 的 version 严格一致**，否则 workflow 会直接失败。
用户在浏览器里看到的版本来自 `manifest.json`，而插件检查更新读的是 Release tag，两者一旦
漂移，用户装了新包却会被反复提示「有新版本」。workflow 里那道校验就是为此存在的。

**版本号要改两处，而且没有自动化守着它们**：`manifest.json`（用户在浏览器里看到的、也是 workflow
校验的那一处）与 `package.json`（对齐用）。`tests/unit/manifest.test.mjs` 只断言 `manifest_version: 3`，
workflow 也只比对 tag 与 manifest —— 漏改 `package.json` 不会报错，所以靠人记得。发版前可以先本地模拟
一遍 workflow 的那道校验：`tag_version=v1.1.1; [ "${tag_version#v}" = "$(node -p "require('./manifest.json').version")" ]`。

**tag 用 annotated（`git tag -a`）**，与既有的 `v1.1.0` 保持一致（`git cat-file -t v1.1.0` → `tag`）。
tag 必须打在 **main 上那个含该版本号的提交**上，所以顺序只能是「改版本 → 合 main → 在 main 上打 tag」；
打完之后这一版就不要再往 main 加提交（要改就删 tag 重打，见下）。

发版 workflow 失败时（tag 已推上去）：修好 → 提交 → 合 main → **删掉旧 tag 再重打**，同一个版本号不要发第二次：

```bash
git tag -d v1.1.1 && git push origin :refs/tags/v1.1.1
```

**发版打成包用显式文件清单而不是 `zip -x` 通配**（`.dsh/logs/` 也会被 `logs/*` 之类的
通配误伤或漏掉）。清单只写在 `tools/package-extension.mjs` 里，本地与 CI 共用：

```bash
npm run package          # 产出 mooc-reminder-v{version}.zip（内层 MOOC_reminder/）
```

本地包的字节数与 CI 的 Release 附件**逐字节同源**（`tools/package-extension.mjs` 一份配方），
所以「本地打出来的包」可以当作发布产物的预览：1.1.1 两边都是 623398 字节。
