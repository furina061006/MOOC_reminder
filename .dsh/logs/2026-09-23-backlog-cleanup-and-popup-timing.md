# 2026-09-23 backlog 复核清理 + popup 启动耗时埋点

用户要求：① 读 `AGENTS.md` 后核对 `backlog.md`，把「已完成但没显示完成」的条目删掉；
② 观察「点开扩展图标后 popup 启动慢」的原因。

## 一、backlog 逐条复核（对照 `dsh`，HEAD `5c60658`）

**结论：8 条里没有一条是「代码已经修好」的。** 但有 5 条属于「已论证为设计行为 / 不可达 /
无需改代码」，按 `backlog.md` 自己的约定（「已修复或已论证放弃的历史问题不再保留」）删掉：

| 原条目 | 代码现状（复核证据） | 处理 |
|---|---|---|
| 同一课程页只抓一次（30 分钟节流） | `main.js` 无 hashchange 监听；`popup.js` 仅「无数据」才 `TRIGGER_SCRAPE`；`EVENT_REFRESH_MIN_GAP_MS` 仍是 30 分钟 | **删**（现象 2026-09-21 已判定为设计行为） |
| `checkPageHookData` 丢弃路由 term 钩子 | `main.js:228-231` 仍 `continue`，`sendTid` 仍优先 `realTid`（`:240`） | **删**（功能已被批量抓取的两个 term 覆盖，只剩首次打开那一瞬的即时性） |
| 同 `courseId` 两 term 镜像同批作业会重复 | `isSameHomeworkCandidate` 仍要求 `termId` 相等（`service-worker.js:850`） | **删**（假想场景，至今未出现；规则本身已在不变量 14） |
| `batchApiFetch` 兜底 course 不带 `courseType`/`activeTermId` | `main.js:273` 原样 | **删**（正常路径不可达 —— SW 的 `buildApiCourseList` 覆盖 SPOC 两个 term） |
| 缺 `Periodic scrape skipped` 的 warn | 条目自己写「不需要为此改代码」 | **删**（无动作可做；结论已在 2026-09-21 日志） |

保留 3 条**真正未完成**的：

1. `course-discovery.js` 会把 SPOC 页上的「源课程」链接登记成课程（`harvest()` 仍无区域过滤，实测证据见 2026-09-20 日志）；
2. 合并 SW 内联 `apiExtractHomework` 与 `src/shared/icourse163-api.js`（不变量 12，两份仍在）；
3. `options.js` 的 `DEFAULTS` 兜底副本（顺手把描述改准：`loadSettings()` 已经优先走 `GET_SETTINGS`，剩下的是「SW 与 storage 都失败」时的副本）。

**删之前确认事实没有只存在于 backlog 里**（否则等于丢信息）：

- 「刷新新鲜度」这条用户可感知的规则本来只写在 backlog → 现在补进 [`.dsh/agents/scheduling.md`](../agents/scheduling.md)「数据新鲜度：刷新什么时候会发生（别当 bug 修）」；
- 「`checkPageHookData` 为什么刻意跳过假 tid 钩子、要改必须同时改 `sendTid`」在任何 agents 文档里都没有 → 补进 [`.dsh/agents/spoc.md`](../agents/spoc.md)「页面钩子数据里的假 tid（刻意跳过，别再「修」）」；
- 多 term 合并规则已在不变量 14；`batchApiFetch` 兜底那条经复核**正常路径确实不可达**，只在本日志留档；
- 缺失 warn 的结论已在 `2026-09-21-clear-data-course-recovery.md`。

## 二、popup 启动慢：静态追踪的结论

这台开发机没有 Chrome/Edge（`which google-chrome/chromium/msedge` 全空），跑不了真实 trace，
所以先把关键路径逐行读出来（每条都能对着行号复核）：

1. `DOMContentLoaded → init()`（`popup.js`）。
2. `await validateAndAutoRepair()`：**直接 `chrome.storage.local.get(['homework_items','courses'])`
   并把整份列表逐条校验**，而这份数据 `GET_HOMEWORK` 马上还要再读一次 —— 重复整读，且卡在
   「加载中…」消失之前。
3. `await loadUiState()`：发 `GET_POPUP_STATE`。**SW 若在休眠，这一次就吃满 MV3 冷启动**
   （要加载/编译 108 KB 的 `service-worker.js` + 5 个 shared 模块）。
4. `await loadData()`：发 `GET_HOMEWORK`，SW 侧（`service-worker.js` 的 handler）是
   **6 次串行的 `chrome.storage.local.get`**（items / courses / last_sync / settings /
   sync_errors / api_status），每次一次异步 IPC；返回体还包含 `allItems`（连已完成的一起
   序列化过消息通道）。
5. 第 3、4 步**互相独立却串行 `await`**。
6. `render()` **之后**才 `body.classList.add('loaded')` → 占位符才隐藏，渲染时间也算进启动时间。

最坏的是「无数据」那次（新装 / 刚点过「重置数据」/ 从没同步成功）：`popup.js` 里那段
「双重刷新」循环最多 3 轮 ×（触发抓取 → 等 1.5s → 再触发 → 最多 30 次「等 500ms +
`GET_HOMEWORK`」轮询），最坏 ~50s；每次轮询又是 6 次串行 storage 读，而且它会让 **popup
自己发起全量抓取**（课程数 × ~200KB），SW 单线程解析这些 JSON 时阻塞事件循环，那段时间
所有 popup 消息都会变慢。

按影响排序：① 两条串行 SW 往返（含 SW 冷启动）；② `GET_HOMEWORK` 6 次串行 storage 读；
③ 占位符等 `render()` 完才隐藏；④ 无数据时的长轮询循环；⑤ `validateAndAutoRepair` 重复整读。

## 三、临时计时埋点（拿到数字后要删）

既然本机不能实测，就加一组埋点让用户在自己机器上点一次：

- `popup.js` 顶部 `__t0` / `__sinceT0()` / `__since()`；`init()` 里分别量
  `validateAndAutoRepair` / `loadUiState` / `loadData` / `render` / 占位符隐藏时刻，
  输出一行 `[Popup][timing] {…}`；「双重刷新」循环额外输出
  `emptyRefreshLoop_ms / polls / pollLoadData_ms`；`handleRefresh()` 输出 `manualRefresh_ms`。
- `service-worker.js`：模块顶部 `SW_BOOT_MS`，`GET_HOMEWORK` 里逐个量 6 次读并输出
  `[MOOC Reminder][timing] GET_HOMEWORK reads(ms) … bootAge=…ms`。`bootAge` 很小 = 这次
  消息触发了 SW 冷启动（冷启动耗时体现在 popup 侧的往返里，SW 内部看不到）。

读法：popup 右键 →「检查」看 `[Popup][timing]`；`chrome://extensions` →「Service Worker / 检查」
看 `[MOOC Reminder][timing]`。**注意**：如果加载的是 `dist/MOOC_reminder` 而不是仓库根目录，
要先 `npm run package` 才会带上这些埋点。

**这些埋点是一次性的**：数字确认了瓶颈就要整块删掉（`popup.js` 顶部注释与所有 `__t*`/`__p*`、
`service-worker.js` 的 `SW_BOOT_MS` 与 `GET_HOMEWORK` 埋点）。

### 实测结果与结论：不改为好，埋点已删

用户在自己机器上跑了四次 `GET_HOMEWORK`：

| 采样 | 6 次 storage 读合计 | `bootAge` |
| --- | --- | --- |
| 1 | 5 ms | 16950 ms |
| 2 | 38 ms | 19072 ms |
| 3 | 14 ms | 854030 ms（≈14.2 min） |
| 4 | 28 ms | 868898 ms（≈14.5 min） |

两个结论：

1. **SW 侧被证伪**：15 条作业 / 5 门课，六次串行 `storage.local.get` 合计 5–38 ms，抖动与数据量无关。
   把 6 次合成 1 次最多省个位数毫秒 —— 属于代码整洁，**不是性能修复**，不值得为「启动慢」去做。
2. **`bootAge` 14 分钟是测量偏差**：MV3 的 SW 在 30 秒无事件后就挂起，而这个 SW 连续活了 854 秒。
   原因是**用户为看日志打开了 SW 的「检查」视图 —— DevTools 开着时 SW 永不挂起**（Chrome 官方
   博客原话："Never if the developer tools are open"；旧的「启动 5 分钟后回收」已在 Chrome 110 移除）。
   所以四次采样**全是热路径，冷启动一次都没量到**——为了观察而打开的 DevTools，恰好消掉了要观察的现象。

用户随后自述「感觉 popup 变快了」，与热路径一致：SW 被钉住 + 数据已回来（`allItems=15`，不再走
空数据那段最坏 ~50s 的循环）+ 连续打开（前一次把 SW 留活 ≥30s）。

**决定：不为性能改代码。** 埋点已按用户要求整块删除，`src/` 与 HEAD 逐字节一致。仍然值得做、
但属于**健壮性而非速度**的只有一条：空数据时 popup 自己连发抓取并睡眠轮询最多 ~50s ——
那是唯一能让 popup 明显卡住的路径，改成「只触发一次带短节流的抓取、不阻塞 UI」即可（尚未做）。

「如何正确测冷启动」已写进 [`.dsh/agents/scheduling.md`](../agents/scheduling.md)，避免下次再踩同一个坑。

## 验证

`npm run validate`：eslint **0 error / 18 warning（与基线一致）**，142 tests pass。
埋点本身不改任何行为，`popup.js` / `service-worker.js` 通过 `node --check`。

## 四、顺手修掉的 Markdown 加粗写法（`**「x」**`）

用户指出 `**「x」**` 在自己的预览里不加粗、`「**x**」` 才加粗。按 CommonMark 的 flanking
规则核对，可复现的成因是：**`**` 紧贴前面的文字、右边紧跟 `「`（标点）时属于
right-flanking，开不了强调**。`点一下**「重新加载」**` 正是这种（`下` = 文字、`「` = 标点，
两个条件都不满足）；`「**x**」` 前有标点、后有文字，开闭都成立，所以能加粗。

为此写了个逐段配对检查脚本（列表项 / 表格行 / 标题各自成块，行内代码按「文字」占位，
再按 flanking 规则配对 `**`），扫全仓库后**真正不生效的只有 1 处**：

- `.dsh/agents/operations.md`：`但保留的是**「最新版本」这个客观事实**`
  → 改为 `「**最新版本**」这个客观事实`。

用户已在 `docs/faq.md` 自己修掉同类 2 处（`**「重新加载」**` → `「**重新加载**」`）。
其余 `**「…」**` 因为 `**` 落在行首 / 空格 / 标点之后，或加粗范围本来就跨出括号
（`**整句**`），**都能正常渲染**，所以没动；历史日志按「不改写存档」的约定也不动。

规则放哪：一开始写进了 `AGENTS.md` 的「知识管理约定」，用户随即指出**那是每轮都在上下文里的索引**，
把这种「写法技巧」长期放在里面是浪费上下文与 token。于是新建 [`.dsh/agents/writing.md`](../agents/writing.md)
（文档写法：加粗与「」、历史日志不改写、行内代码 / README 绝对链接），`AGENTS.md` 只留一行路由
（路由表新增「写 / 改 Markdown 文档」一行），`repo-hygiene.test.mjs` 的 `agentDocs` 名单同步加 `writing`，
防止路由指着一个不存在的文件。**以后同类技巧一律进 `writing.md`，不要再写回索引。**

---

# 五、幽灵课程：`NEU-1474956162 · 普通 · 牛顿第二定律`

## 用户报告

设置页「已追踪课程」里出现一门**没选过的课**：`NEU-1474956162 · 普通 · 0 项未完成 / 共 0 项`，
名字是「牛顿第二定律」。而 `NEU-1474956162` 是 **SPOC 大学物理**的 courseId，「牛顿第二定律」是**物理章节名**。

## 这条记录本身就自证了机制

- `courseType` 不是 `'spoc'`（设置页显示「普通」）→ 登记它的**不是** `/spoc/learn/` 页面；
- 名字是章节名 → 名字的来源**不是**课程标题，而是**某个锚点的文本**或某个非课程标题元素；
- 0 条作业 → 它对应的 termId 抓不到任何东西（也跟着说明 termId 很可能来自同一个可疑锚点）。

对得上 [backlog](../agents/troubleshooting.md) 里那条老问题（2026-09-20 用户报「打开 SPOC 大学物理二后，
没选过的『大学物理（力学、电磁学）』被自动抓取」）：**`course-discovery` 的锚点采集是弱信号**——
`/learn/{id}?tid=` 锚点不一定是「我的课程」条目，也可能是**源课程**链接或**正文里的章节链接**，
后者的锚点文本就是章节名，href 又不含 `/spoc/`，于是被登记成一门「普通课程」。SPOC 页把源课程内容
并排渲染，所以它最容易中招。

## 改了什么

| 改动 | 位置 | 效果 |
| --- | --- | --- |
| **学习页不采集、也不应答探测** | `src/content/course-discovery.js` | 学习页的课程由 `main.js` 自报；顺带修掉「它同步应答会抢走 main.js 的 `sendResponse`」，还省掉每个学习页 8 秒的 MutationObserver |
| **弱信号不得改名** | `service-worker.js` 的 `COURSE_LINKS` | 只有**学习页自报**（`sender.tab.url` 是 learn URL）或**记录本来没名字**时才接受这次的名字；锚点只能更新 termId |
| 注册日志带名字 | 同上 | `COURSE_LINKS: registered … fromCoursePage: false → NEU-1474956162="牛顿第二定律"(mooc)`，以后一眼看出是谁登记的 |
| 诊断字段 | `tools/diagnostics/dump-extension-state.js` | `courses` 每行加上 `discovered` / `firstSeen` / `lastSeen` / `schoolName`，可判断「新冒出来」还是「早被改过名」 |

**没做的**：首次创建仍挡不住——非学习页（如课程介绍页）上的章节锚点照样能新建一条幽灵记录。
已把这条更精确的问题写回 `backlog.md`（弱信号改名只是不覆盖，**不是不创建**）。

## 验证

- 新测试 `锚点采集（弱信号）不能给已有课程改名，课程页自报可以`：三段断言 —— 锚点改名被拒（termId 仍更新）、
  学习页自报可改名、新课程仍能从锚点拿到名字；**负向验证**：把守卫改回「无条件写 courseName」后该测试立刻失败。
- 全量 `npm run validate`：eslint 0 error / 18 warning（基线），**143 tests pass**。
- 诊断：用户侧的 `courses` 记录与页面锚点清单**尚未回传**（已给出取证步骤），所以「这条幽灵到底来自哪个页面」
  目前仍是推断 —— 但两个修复都独立成立（前者是 backlog 老问题，后者是可证伪的改名缺陷）。

## 定案：是「最近发表」的论坛帖链接（用户回传真实 DOM）

用户给出复现线索「刷新 `/home.htm?userId=…#/home/spocCourse` 才有」，并回传了该页面的完整 DOM
（`element.txt`，gitignored）。这份 DOM 一次把机制钉死了 —— 也说明我上面的推断**猜错了方向**：

- 页面里 `href` 含 `/learn/` 的锚点共 9 个：4 个 SPOC 课程卡片的「分数」链接（`/spoc/learn/NEU-xxx#/learn/score`，
  **不带 `?tid=`**，一直被正确拒绝），以及 **5 个「最近发表」论坛帖链接**；
- 那 5 个论坛帖链接长这样：

```html
<!-- 右侧「最近发表」侧栏 -->
<div class="ro-posts-f"><div class="c-ro-posts_div47" data-label="//www.icourse163.org/learn/NEU-1474956162?tid=1476735472#/learn/forumdetail?pid=1353455440">
  <a href="https://www.icourse163.org/learn/NEU-1474956162?tid=1476735472#/learn/forumdetail?pid=1353455440" class="c-ro-posts_a48">
    <span class="f-thide c-ro-posts_span49">牛顿第二定律</span>
  </a>
</div></div>
```

**它们带 `?tid=`、指向 `/learn/NEU-1474956162`，锚点文本是帖子标题** —— 于是：

| 现象 | 机制 |
| --- | --- |
| 名字 =「牛顿第二定律」 | 锚点文本是**帖子标题**；采集按 `courseId\|termId` 去重，5 条帖子合并成一条，名字取了 DOM 第一条 |
| 类型 =「普通」 | href 不含 `/spoc/`（真实课程是 SPOC 大学物理），`courseType` 只看 href |
| 0 条作业 | `?tid=1476735472` 正是 SPOC 的**路由壳** term（空壳，89B） |
| 刷新那个页面才出现 | 那 5 个锚点只存在于该页面的「最近发表」侧栏 |

**新增修复**：`parseLearnHref` 拒绝**内容详情链接** —— fragment 含 `forum` / `detail`（`#/learn/forumdetail?pid=`、
`#/learn/forum?cid=` 等）。两份拷贝同步改（`src/content/course-discovery.js` 运行时、`src/shared/icourse163-api.js` 有单测），
单测 `parseLearnHref rejects links into a course's content, not the course` 直接用真实帖链接断言，
**负向验证**：去掉守卫该测试立刻失败。用 `element.txt` 里的真实锚点复跑：5 条帖子链接全部被拒（此前全部通过）。

验证：`npm run validate` → eslint 0 error / 18 warning（基线），**144 tests pass**。

