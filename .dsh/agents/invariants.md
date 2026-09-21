# 关键不变量（改代码前必读）

> 入口索引与工作约定在仓库根目录 [`AGENTS.md`](../../AGENTS.md)；本文件是 `.dsh/agents/` 知识库的一部分。

### 关键不变量（改代码前必读）

1. **`homework_items` 的所有读-改-写必须走 `mutateHomeworkItems`**（shared/items-mutex.js 的串行锁）。直接 `get→改→set` 会与并发的 reconcile/通知写回互相覆盖（症状：通知重复弹、已完成项被复活）。
2. **`courses` 的所有读-改-写必须走 `mutateCourses`**（同一串行锁工厂）。`COURSE_LINKS` 循环注册、`COURSE_UPDATE`（SPOC 真实 termId）和每个 `COURSE_API_DATA` 的 reconcile 都会并发写课程；裸读-改-写会丢课或把 `activeTermId` 回退。`upsertCourse()` 是唯一入口，`RESET_DATA` 也用 `mutateCourses(() => [])` 清空。
3. **SNOOZE 必须同时清 `lastNotificationLevel`**，否则 snooze 到期后同档位永不再提醒（对已过期条目致命）。
4. **digest 先 create 成功再写 `last_digest_date`**；免打扰命中时创建一次性 `daily-digest-retry` alarm 而不是静默丢弃。
5. 点击通知/popup 行用 `resolveItemUrl(item, courseType)`（shared/item-url.js）兜底重建 URL。**`item.pageUrl` 优先级最高**：它一旦存在（SPOC 条目从 `course.pageUrl` 继承真实路由 URL），路径前缀与 `?tid=` 都取自真实 URL，比任何 `courseType` 猜测都可靠。没有 pageUrl 时才按课程类型拼：SPOC 在 `/spoc/learn/`，普通课程在 `/learn/`。**必须传入课程类型**（或条目自带 `courseType`）。popup.js 保留一份必须同步的镜像实现（含 `courseTypeFor`）。
6. `notifyLeadHours: []`（显式空数组）= 用户关闭所有提前档位，normalizeSettings 不得回退默认值；仅字段缺失才用默认。
7. **临时代理任务只能写 `temporary_proxy_job`，不能借用 `scrape_status`**。先落盘再 `tabs.update()` 导航；只可清理由该持久化 job ID 认领的 tab，现有用户标签页永不关闭。
8. **「清理已完成」依赖 tombstone**：`CLEAR_COMPLETED` 删除条目的同时把 UID 记入 `dismissed_completed_uids`；reconcile 遇到同 UID 的**已完成**新条目时跳过，遇到**未完成**时删除 tombstone 并放行。没有这层过滤，下一次同步会把清理掉的作业重新写回。
9. **`activeTermId` 是 SPOC 的唯一可靠证据**：它只由 `COURSE_UPDATE` 写入，而 `main.js` 只在真实 `/spoc/learn/` 页面发送 `COURSE_UPDATE`。因此凡是要判断「这门课是不是 SPOC」，先看 `activeTermId`（`isProvenSpocCourse()`），再看 `courseType`；`buildApiCourseList`、`courseTypeFor`（popup）、通知点击、`getProxyRouteTermId` 都必须遵守这个优先级。反过来，`COURSE_LINKS` 的 `courseType` 只是「href 里有没有 `/spoc/`」，属弱信号。
10. **Course 的 `pageUrl` 和 `termId` 只由真实页面写入**：`pageUrl` 只能由 `COURSE_UPDATE` 冻结（`isIcCourseLearnUrl()` 校验 origin/路径/`tid`），`termId` 只能由 `COURSE_LINKS`/`COURSE_UPDATE` 写入。`reconcileHomeworkData` **必须排除这两个字段**：API payload 的 `termId` 是抓取用的 termId（SPOC 下等于 `activeTermId`，是 API id 而非路由壳 id），写进去会毁掉 `?tid=`；`pageUrl` 的空值会抹掉已冻结的 SPOC 路由 URL。
11. **`courses` 一门课只存一条记录（键 = `courseId`）**，而 SPOC 与同名 MOOC **共享 `courseId`**。因此已证明 SPOC 的课程必须整条拒绝弱 `'mooc'` patch（`upsertCourse` 内的 `isProvenSpocCourse` + `isWeakMoocPatch`），否则标题会变成 MOOC 名、点击目标会变成 `/learn/`。**已知代价**：同一 `courseId` 的 MOOC 与 SPOC 无法作为两条记录并存（SPOC 优先）。
12. **`src/shared/icourse163-api.js` 与 SW 内联的 `apiExtractHomework` 是两份拷贝**（SW 无 import，运行时用内联版）。改任何一侧都必须同步另一侧——2026-09 就是因为运行时副本漏了 `courseType` 才让 SPOC 条目无法自证路由类型。settings 已改为 import 消除了同类漂移，这两个 extractor 尚未合并。
13. **更新通知每个版本只弹一次，且只在真正 create 成功后记账**：`update_status.notifiedVersion` 仅在 `chrome.notifications.create` 成功返回 true 时才推进。免打扰时段内 `notifyUpdateAvailable` 返回 false，因此标志不推进、下一次 tick 会重试——反过来若先记标志再发通知，处于免打扰时段的用户将**永远收不到**更新提醒（与不变量 4「digest 先 create 成功再写日期」同源）。另外 `downloadUrl` 来自远端响应，**必须经 `isSafeReleaseUrl` 只允许 `https://github.com/`** 才交给 `chrome.tabs.create`。
14. **一门 SPOC 课程横跨两个 term，必须都抓**：`buildApiCourseList` 对 SPOC 课程输出**每个 term 一条** batch 条目。两者分工（2026-09 用**真实 DTO** 验证于 模拟电子技术基础 NEU-1486374162）：
    - **路由 term**（`course.termId`，即 URL 的 `?tid=` / `window.termDto.id`）= **老师自己加的内容**（term 1488279445 只有「线上学习任务」3 个测验 + 「二极管应用仿真设计（翻转课堂）」1 个作业）
    - **active/source term**（`course.activeTermId`，即 `window.moocTermDto.id`）= **源课程内容**（term 1488001444 = 10 章源课程）

    两者**内容不重叠**，页面也是并排显示（DOM 里有 `u-moocbl`「源课程内容」分隔符）。而 `isSameHomeworkCandidate` **要求 `termId` 相同**才会合并，所以只抓一个 term 会**静默丢掉一半课程** —— 这正是「线上学习任务抓不到」的根因。`course.pageUrl` 的 `?tid=` 也作为路由 term 候选，用来救回被旧版本覆盖过 `termId` 的历史记录。
15. **绝不递归进 `node.test`**：`test` 是节点自身的元数据，但它**自带 `name` / `type` / `deadline`**。访问它会以 `test.id` 当 homeworkId **再生成一条重复条目**（真实 DTO 实测：「第一章 测验」和三条 Multisim 测验全部中招），只因为末尾的「同名去重」才没露出来 —— 而那个去重是按名字模糊匹配的，不可依赖。所需字段一律通过 `node.test` 显式读取。
16. **`update_status` 是快照，不是实时状态**：里面的 `currentVersion` / `updateAvailable` 都是**上一次检查那一刻、对着当时那个已加载实例**算出来的。而侧载扩展换版本只有「重新加载」一条路，`onInstalled`/`onStartup` **都不跑更新检查**（唯一自动调用点是 12h 的 `badge-refresh`），所以快照随时可能落后于运行版本。**任何展示或判断之前都必须按当前运行版本重算**：读取路径用 `reconcileStatus(status, runningVersion)`，失败兜底路径用 `isNewerVersion(previous.latestVersion, currentVersion)`——**绝不能照抄 `previous.updateAvailable`**。2026-09-22 真机两次踩中：装好 1.1.0 后设置页仍显示「当前版本 v1.0.0」，以及一次请求失败后又显示「当前版本 v1.1.0 / 最新版本 v1.1.0 / 发现新版本 v1.1.0」。同理，设置页渲染「当前版本」优先用响应里的实时值，缓存值只作兜底；「本次检查失败」与「有新版本」必须**各自呈现**（写成 `else if` 会让失败提示被吞掉，页面变成不解释的自相矛盾）。
