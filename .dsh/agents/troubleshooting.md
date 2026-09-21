# 排查：抓不到 / 抓不全

> 入口索引与工作约定在仓库根目录 [`AGENTS.md`](../../AGENTS.md)；本文件是 `.dsh/agents/` 知识库的一部分。

### 抓不到 / 抓不全条目（排查流程）

平台改版、或老师新增内容类型（如「线上学习任务」「翻转课堂」）时，某门课会「少几条」甚至「一条都没有」。
**按顺序定位，不要凭猜直接改门槛。**

**当前类型门槛**（两份 extractor 副本都是这个规则）：

```
hasSignal（有 deadline 或 分数）
  且（contentType ∈ {2,3,6}
      或 contentType 空缺 且 名字命中 /测验|作业|考试|测试|quiz|exam|homework|test/i）
```

名字正则**只在 contentType 缺失时**启用——否则「期末考试」这类名字会被误判。

排查步骤：

1. **确认症状**：在**扩展的** Service Worker Console（`chrome://extensions` → MOOC Reminder → 「Service Worker」，
   不是网页 Console）跑 `tools/diagnostics/dump-extension-state.js`。
   条目不在 `homework_items` 里 → 抓取/提取问题；在 → 问题在展示层，别往抓取方向查。
2. **看近失日志**：在同一个 Console 搜
   `apiExtractHomework: N 个节点有名字+截止/分数但被类型门槛拦下`。
   这条日志（2026-09 新增，见 `tests/unit/icourse163-api.test.mjs`）会直接列出被拦下的节点名与 `contentType`。
   有 → 就是门槛过滤的，且已经告诉你 contentType 是什么。
3. **看数据里到底有没有**：在课程页面 Console 跑 `tools/diagnostics/dump-page-dto.js`。
   它复刻运行时门槛逐节点给判定，并给出 `gatedOutWithSignal`（有信号却被拦下）与
   `keywordInDto`（DOM 里看到的名字是否出现在 DTO 原文里）。
   - `keywordInDto` 全 `false` → API 数据里**根本没有**这些条目 → 查抓取来源（termId / 哪个 term 装了它）
   - 有节点但 `passesGate: false` → 门槛问题，报告里有它的 contentType
4. **页面不暴露 DTO 时**：脚本返回 `foundDtoIn: null`（部分 SPOC 页只把 `{id}` 空壳挂到
   `window.moocTermDto`，2026-09 实测）。改为 DevTools → Network → 筛 `rpc` → 刷新页面 →
   找响应最大的请求 → Copy response，拿原始响应离线分析。

### 两个操作性陷阱（先确认，再怀疑代码）

1. **重载扩展不会给已打开的页面补注入 content script。** 在 `chrome://extensions` 点刷新后，
   所有已打开的学习页都会失去内容脚本：`PAGE_OPENED` 不再发出、`course-discovery` 不再上报课程、
   SW 发去的消息也没有接收方。**完整恢复步骤是「重载扩展 → 再刷新页面」**，只做前者会出现
   「扩展看着是活的，但一点都抓不到」。SW 侧对这种情况会退到临时代理页兜底（见 `performPeriodicScrape`
   的逐个标签页尝试），但**内容脚本侧只能靠页面刷新恢复**。
2. **`course-discovery` 对同一个页面只上报一次**（`reported` 去重），`main.js` 也只在**页面加载时**登记自己的课程。所以「清除数据 / 删除课程」之后，已经打开的课程页不会再上报。为此 SW **每轮抓取开始时**都会问所有已打开的 icourse163 页面一次（`REQUEST_COURSE_LINKS` → `askOpenPagesToReport`），用户不必手动刷新页面。三个要点：
   - **问的是所有 icourse163 页面**，不只是学习页：「我的课程」页是锚点最全的来源；
   - **学习页上没有任何 `/learn/` 锚点**，所以它靠 `main.js` 自报本页身份（见「消息协议」）。
     2026-09-21 之前只问锚点，于是「清除数据 → 刷新」永远抓不到东西（页面上根本没有可采集的链接，
     只有重新打开页面才会走 `init()` 的注册路径）；
   - **每个页面的应答都设了 1.5 秒上限**（`PAGE_ANSWER_TIMEOUT_MS`）。`chrome.tabs.sendMessage`
     对冻结/已卸载的后台页面**永远不会 settle**，无上限的 await 会让整次抓取无声消失（日志停在
     `Periodic scrape started`），所以这里刻意并行发问 + 逐一限时 + 每个不应答的页面都打日志。
3. **长期挂在后台的课程页会被浏览器冻结或卸载（Memory Saver），这类页面帮不上任何忙**：它没有内容脚本，既不能上报课程，也不能接手 `BATCH_API_FETCH`——「不切到那个页面就抓不到」正是这么来的。所以：
   - 课程登记不能只靠页面加载：**每轮抓取都问一遍**（同上），把「谁能回答」这件事变成常态；
   - `BATCH_API_FETCH` **只发给刚应答过探针的页面**。以前按 `lastAccessed` 挑一个就发，挑中冻结页会白等 90 秒超时并把整轮抓取判失败（尽管下面几行就有代理页兜底）；
   - 一个应答的页面都没有时用临时代理页（新建的页面不会被冻结）。
   排查时跑 `tools/diagnostics/dump-extension-state.js`：它列出每个页面的 `discarded`（是否已被卸载）与 `answered`（此刻是否应答），并顺手让能应答的页面重新登记课程。

另外：**任何提前 return 都必须留下用户可见的痕迹。** `performPeriodicScrape` 曾有一条完全静默的
`apiCourses.length === 0` 出口，导致 popup 空白却查不到任何原因；现已按「无课程 / 只有手动条目 /
全部被忽略」三种情况分别写日志与 `sync_errors`。

> [!IMPORTANT]
> **不要靠猜放宽门槛。** 让「有名字 + 有截止/分数」却被拒的节点静默消失，正是 2026-09
> 「线上学习任务抓不到」排查困难的根因——contentType 成了不可诊断的黑盒。近失日志就是为此加的；
> 任何放宽门槛的改动都必须先由上面第 2、3 步拿到证据。

---
