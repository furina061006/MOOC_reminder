# 2026-09-21 — 「清除数据后再刷新一条都抓不到」的根因与修复

## 用户报告与证据

用户在 popup 里点「重置数据」（`RESET_DATA`：清空 `homework_items` / `courses` / `sync_errors` / `last_sync`），
再点刷新，**一条作业都恢复不了**。Service Worker Console 只有两行：

```
[MOOC Reminder] Manual scrape triggered
service-worker.js:1717 [MOOC Reminder] Periodic scrape started
```

之后没有任何输出。用户当时开着多个 icourse163 课程页。

### 这日志能/不能证明什么

`Periodic scrape started` 在 2026-09-20 的修复前后都正好是第 1717 行（`git show` 逐提交核对），
所以**行号无法区分新旧构建**。而在当前构建里，`apiCourses.length === 0` 分支之后的
`console.warn('Periodic scrape skipped: …')` 是**唯一**可能被「警告等级过滤」吞掉的一行；
其余路径（`Sending BATCH_API_FETCH` / 代理页创建 / 异常）都是 log 或 error。

于是只剩三种解释，且**它们指向同一个修法**：

1. 加载的扩展是 `79530b6`（补上跳过日志）之前的旧构建 → 静默 `return`；
2. 构建是新的，只是 Console 隐藏了 Warnings 等级；
3. `chrome.tabs.sendMessage` 对某个标签页**永不 settle**（冻结的后台渲染进程），
   整个 `performPeriodicScrape` 挂在那里，日志自然停在起点。

## 决定性证据（不需要浏览器）

磁盘上留着一份 2026-09-18 抓的**真实 SPOC 学习页 DOM**（`element.txt`，gitignored）。统计它：

```
<a> 总数：35
href 含 /learn/ 的：0
substring /learn/ 出现：8   ← 全是 data-menu-id="rc-menu-uuid-…-/learn/announce" 之类的 SPA 菜单 ID
substring tid= 出现：0
```

**学习页上一个 `/learn/` 锚点都没有。** SPA 的左侧菜单（课件/测验与作业/考试…）用的是
`data-menu-id`，不是链接。

而 `course-discovery.js` 的全部采集逻辑就是
`document.querySelectorAll('a[href*="/learn/"]')`。也就是说：

> `REQUEST_COURSE_LINKS` 问学习页「你有哪些课程」时，它**永远无法回答**——
> 页面上根本没有可采集的链接。能回答的只有「我的课程」页 / 课程介绍页这类有锚点的页面。

这解释了用户观察到的每一件事：

- 清除数据后刷新抓不到 → `courses` 被清空，重新发现的唯一通路（锚点）在学习页上无货；
- 「重新打开页面才行」→ 页面加载会跑 `main.js` 的 `init()`，那里有另一条注册通路
  （SPOC 的 `COURSE_UPDATE`、xhr hook 的 `COURSE_API_DATA`），与锚点无关；
- 「删掉课程它就不回来了」→ 同上（这条是删除语义的已知代价，见 CLAUDE.md 的 NOTE）。

## 修复

### 1. 让课程页自报家门（核心）

`main.js` 现在应答 `REQUEST_COURSE_LINKS`（`reportOwnCourseIdentity()`），复用它在别处已经发过的两条消息：

| 消息 | 内容 | 作用 |
|---|---|---|
| `COURSE_LINKS` | `courseId` / 路由 `?tid=` / `courseName` / `courseType` | 注册课程（`termId` = 路由 term） |
| `COURSE_UPDATE`（仅 SPOC 且 bridge 有真实 tid） | `activeTermId` + `routeUrl` | 冻结 active term 与 `pageUrl`（不变量 5/6/14 的并集靠它） |

**SPOC 判定只看 URL 前缀**，刻意**不看** `data-mooc-real-termid` 是否存在：那个 bridge 属性
在每个学习页都会被注入，MOOC 页同样暴露 `window.moocTermDto`。若拿它当 SPOC 证据，
MOOC 课程会被登记成 SPOC，点击目标就会跳到 `/spoc/learn/` —— 正是 2026-09 修过的那类 bug。

顺带把三处重复的「读课程名」代码合并成 `readCourseName()`。

### 2. 重发现改为「问所有 icourse163 页面」+ 每个应答都限时

- 查询从 `LEARN_TAB_URLS` 放宽到 `ICOURSE_TAB_URLS`（`https://www.icourse163.org/*`）：
  「我的课程」页是锚点最全的来源，学习页自报身份，两者互补。
- `requestCourseRediscovery` 改为**并行**发问（串行等一个冻结页会白等一个超时窗口），
  每次 `chrome.tabs.sendMessage` 用 `withTimeout(..., 1500ms)` 包住，超时/失败逐页打 warn，
  最后打一行 `asked N page(s), M answered`。
- 空课程列表分支新增两行 log（询问了几个页面 / 恢复了几门课），让这条路径在 Console 里**不再静默**。
- 跳过原因文案补上「刚重新加载过扩展的话，还需要刷新已打开的页面」——这正是操作性陷阱 1。

### 3. 测试

- 新增：询问「所有 icourse163 页面」而不只是学习页；
- 新增：一个**永不 settle** 的页面不能拖死整次抓取（断言仍成功、有 warn、耗时 < 8s，旧代码会永久挂住）；
- 新增：所有页面都拒绝（扩展重载后的陈旧页面）时，跳过原因要给出可操作提示且不创建代理页；
- `manifest.test.mjs` 增加耦合守卫：SW 里 `LEARN_TAB_URLS` 的每个 pattern 都必须在
  `main.js` 的 `matches` 里（否则消息发到没有内容脚本的页面上），且 `main.js` 必须保留
  `REQUEST_COURSE_LINKS` / `COURSE_UPDATE` 应答（防止有人删掉这条通路后测试全绿）。

`npm run validate`：128 tests pass，eslint 0 error / 18 warning（与基线一致）。

## 验证结果（用户实测，2026-09-21）

- ✅ **已确认修好**：按上面的步骤验证（重载扩展 → 刷新页面 → popup「重置数据」→ 刷新），
  课程列表恢复、抓取正常。用户原话：「现在大问题解决了」。
- ✅ 顺带确认：MOOC 与 SPOC 的**作业跳转目标完全正确**（2026-09-18 那次 SPOC 路由修复在真实
  浏览器里终于成立，此前只有单测与静态核对）。
- ❓ **仍未解释**：用户那份日志里缺失的 warn 行究竟是「旧构建」还是「Console 隐藏警告」。
  这已经不影响结论（无论哪种，修的都是一样的通路）；下次再遇到「刷新没反应」时，
  按新日志（`Open icourse163 pages: N — answered: M`）直接看即可。
- ⚠️ **仍未解决**：「同一页面只抓取一次」的主体是 30 分钟节流 + 12h alarm，见 `backlog.md` 首项；
  本次只清掉了「重发现永远拿不到数据」与「后台页导致整轮失败」这两环。
- `batchApiFetch` 里那条「始终补上当前页面课程」的兜底（`main.js` 自加 course 项）**不带 `courseType`**，
  SPOC 页会以路由 tid + 空类型被抓一次。本次刻意没动它（不在本次证据范围内），已记入 `backlog.md`。

---

# 第二轮：「某门课不切到前台就抓不到」（同日）

## 用户报告

「复变函数与积分变换」这门普通课程，**不把它切到当前标签页就抓不到**；其他同样挂在后台的课程
没有被回收（用户自述），而且**过一会儿又自己好了**——即间歇性失败。

间歇性是关键线索：如果是「课程从没被登记过」，那它会一直缺失到页面重新加载为止，不会自愈。
能自愈的只有一种解释：**这一轮的抓取整个失败了**，下一轮（换了另一个能应答的页面）才成功。

## 两个叠加的缺陷

1. **课程登记只有「页面加载」和「整个列表为空」两个入口**。`course-discovery` 每页只上报一次，
   `main.js` 只在 `init()` 登记自己。而重发现（`REQUEST_COURSE_LINKS`）**只在 `apiCourses` 为空时才跑**——
   只要列表里还有别的课，一门刚被浏览器卸载、或加载时没抓到 hook 数据的课就永远补不上。
2. **批量抓取会把冻结页面当成可用页面**。旧流程按 `lastAccessed` 排序后直接挑第一个发
   `BATCH_API_FETCH`；若那是个被冻结/卸载的后台页，`chrome.tabs.sendMessage` 永不 settle，
   要等满 90 秒超时并把**整轮**判失败——尽管再往下几行就有临时代理页兜底、别的标签页也可能能干活。
   这条同时解释了「间歇」：下一次挑中的页面恰好还活着，就成了。

（后台标签页会先被冻结、长时间后可能被 Memory Saver 卸载；两者都等于「这个页面的 JS 不在了」。
用户需要「切到前台」正是因为切回去会解冻/重载页面，而重载恰好又会重新登记课程。）

## 修复

把「问一遍所有已打开页面」从一个**只救空列表的特例**升级为**每轮抓取的第一步**：

```
每轮抓取：
  1. 问所有已打开的 icourse163 页面 REQUEST_COURSE_LINKS
     （并行，每页 1.5 秒上限；应答者进 responders 集合）
       - 顺带让每个能应答的页面重新登记自己的课程 → 列表自愈
  2. 读课程列表 → 构建待抓 term（空则照旧大声跳过）
  3. 候选服务页 = 学习页 ∩ responders，按 lastAccessed 倒序
       - 一个都没有 → 临时代理页（新建页面不会被冻结）
  4. 只把 BATCH_API_FETCH 发给候选页；「对方没有 content script」才换下一个
```

代价：每轮抓取多一次消息往返（应答页 ~即时，冻结页最多 1.5 秒）+ 800ms 落盘等待。
换来的是：抓取结果**不再取决于哪个标签页恰好被冻结**，而且课程列表每轮都会自我补全。

另外 `COURSE_LINKS` 在检测到新课程时会跳过 `apiRefreshAllKnownCourses()`（若此刻正在抓取），
避免探测带来的登记又触发一次并行的 SW 侧全量刷新。

## 测试

新增/更新（`tests/unit/service-worker.integration.test.mjs`）：

- **「探针期间上报的课程会在同一轮被抓」**——正是用户这次的场景（列表里已有别的课）；
- 「永不 settle 的页面不能拖死抓取」补上断言：**重型批量绝不发给不应答的页面**；
- 「已应答页面上的真失败不被掩盖」改为用 `TRIGGER_SCRAPE` 完整等待（旧写法只等 300ms，
  在新增的 800ms 落盘窗口下会误判）；
- `waitFor` 改为真实轮询（25ms × 80 ≈ 2 秒预算），不再靠几十个微任务碰运气。

## 验证结果（用户实测，2026-09-21）

- ✅ **已确认修好**：多个课程页全挂在后台时刷新也能抓到，用户原话「这回非常好，连课程作业跳转都完全正确」。
  即 §缺陷 2 那条 90 秒超时导致整轮失败、以及「课程列表非空就再不去问」的两个环节都消除了；
  同时确认了作业跳转目标（`resolveItemUrl` / `course.pageUrl` 那条链路）在真实浏览器里是对的。
- 尚未在浏览器里单独验证的只剩「M=0 时改走临时代理页」这条分支（用户当时的页面能应答，
  所以走的是 M>0 的正常路径）。它由单测与既有的代理页测试覆盖，风险低。
- 下次排查同类问题仍然用 `tools/diagnostics/dump-extension-state.js`：它的 `icourseTabs` 表
  （`discarded` / `answered`）能直接看出有多少后台页「睡着了」。

