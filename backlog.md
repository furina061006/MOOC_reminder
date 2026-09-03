注: 待追踪任务

- ~~截止提醒功能无法正常工作~~ ✅ 2026-08-16 修复：snooze 不清档位记忆、并发写互相覆盖、通知点击无跳转、摘要免打扰丢失、空档位设置被忽略（详见 [CHANGELOG.md](CHANGELOG.md) 的 2026-08-16 记录）

- ~~慕课大部分作业应该是以天为单位更新的吧。如果是单纯的日志提醒，应该不需要高强度轮询。除非是突然新增事项，但是这个一般截止日期也不短。我觉得可以基于这个假设，降低查询频率，想点别的办法把它脱离浏览器去做，也不吃性能，或许也挺好~~ ✅ 2026-08-16 落地为事件驱动调度：打开课程页/浏览器启动即刷新（30min 节流）+ 4h 周期兜底 + 15min 本地提醒检查，SW 唤醒降至约 1/3。「脱离浏览器」部分不可行（登录 cookie 绑定浏览器 profile），已论证并放弃。后续于 2026-09-04 增加临时非激活代理页，使无现成学习页时也能刷新已载入课程，详见 [CHANGELOG.md](CHANGELOG.md)。

> 以下代码审查记录保留为 2026-09-01 的历史快照。后续已解决的问题会在对应条目标注；未标注的条目仍需重新核查当前实现。

---

## 2026-09-01 代码审查

以下项目基于当前实现与现有测试的静态审查；未修改业务代码。

### P1: 通知点击会把 SPOC 条目跳转到错误路由

- 位置: `src/shared/item-url.js:12-26`、`src/popup/popup.js:529-543`、`src/background/service-worker.js:866-884`
- 现象: API 条目通常没有 `pageUrl`，点击通知或 popup 条目时会通过 `resolveItemUrl()` 回退构造 URL。该函数固定使用 `/learn/`，忽略课程的 `courseType: 'spoc'`。
- 影响: SPOC 课程的通知和列表点击会跳到 `https://www.icourse163.org/learn/...`，而不是 `https://www.icourse163.org/spoc/learn/...`；可能打开错误页面或无法进入课程。
- 建议: 将 `courseType` 持久化到 HomeworkItem，或在解析 URL 时查询 Course 元数据；回退 URL 根据课程类型选择 `/spoc/learn/` 或 `/learn/`。同时消除 popup 内的重复实现，并补充 SPOC URL 的单测和 SW 集成测试。

### P1: 无课程标签页时的后台抓取与已验证的平台认证约束相冲突（已解决）

- 位置: 历史实现位于 `src/background/service-worker.js`，现由临时代理任务处理
- 现象: 2026-09-01 审查时，无学习页会走 Service Worker 直连 API；项目文档明确说明该模式因 origin/CSRF 校验无法可靠认证，必须由 content script 发起同源 XHR。
- 影响: 用户关闭所有 MOOC 标签页后，周期抓取大概率失败，且容易造成“后台可刷新”的错误预期。
- 处理: 2026-09-04 改为先创建非激活临时代理页，再由 Content Script 发起同源 XHR；任务完成、超时、关闭或重启后清理扩展自己创建的 tab，详见 [CHANGELOG.md](CHANGELOG.md) 和 `.claude/logs/2026-09-03-temporary-proxy-refresh.md`。

### P1: 并发课程写入会丢失 `courses` 元数据

- 位置: `src/background/service-worker.js:281-304`、`src/background/service-worker.js:638-649`、`src/background/service-worker.js:1059-1070`
- 现象: `homework_items` 使用 `mutateHomeworkItems` 串行化，但 `upsertCourse()` 仍是裸 `get -> 修改 -> set`。`COURSE_LINKS` 循环注册课程、多个 `COURSE_API_DATA` 消息各自 reconcile 后更新课程、以及 `COURSE_UPDATE` 都可能并发执行。
- 影响: 两个写入者读到同一旧课程数组后分别写回，后一次会覆盖前一次，造成新发现课程丢失、SPOC 的 `activeTermId` 回退或课程名称被意外覆盖。后续全量刷新会漏课程或用错误 termId。
- 建议: 为 `courses` 建立与 `homework_items` 同等的串行 RMW 存储层，或将课程更新合并到一个单一事务协调器；增加并发 `COURSE_LINKS` / `COURSE_UPDATE` / `COURSE_API_DATA` 的集成测试。

### P2: 课程发现脚本在任意站内页面处理批量抓取时无法读取 HttpOnly CSRF cookie

- 位置: `src/content/course-discovery.js:94-213`
- 现象: 在非 learn 页面，`course-discovery.js` 自己处理 `BATCH_API_FETCH`，仅通过 `document.cookie` 读取 `NTESSTUDYSI`（第 111-113 行）。该 cookie 已被项目确认是 HttpOnly，`document.cookie` 无法访问；脚本也没有调用可用的 `chrome.cookies.get()`。
- 影响: `performPeriodicScrape()` 的“任意 icourse163 页面”fallback 选中首页或个人中心标签页时，批量 API 抓取会无声返回空数组，无法刷新已知课程。
- 建议: 复用 `main.js` 的 cookie 获取逻辑，优先 `chrome.cookies.get()`，并只在非 HttpOnly 环境使用 `document.cookie` 后备；修复前后分别为非 learn 页 BATCH_API_FETCH 建立测试。

### P2: popup / options 的默认设置仍是旧的高频调度值（已解决）

- 位置: 历史实现位于 `src/popup/popup.js`、`src/popup/options.js` 和 `src/shared/settings.js`
- 现象: 2026-09-01 审查时，Service Worker 和 shared 默认值已变化，但 popup 存储修复路径与 options fallback 仍写入旧的高频配置。
- 影响: 存储修复或 Service Worker 不可用时，用户可能被写入不一致的 alarm 配置。
- 处理: 2026-09-04 已统一为后台检查和徽章刷新默认 12 小时，设置页以小时展示并转换为内部分钟值。

### P2: 手动添加提醒的 UID 忽略 `courseId`，不同课程可互相冲突

- 位置: `src/background/service-worker.js:210-215`、`src/background/service-worker.js:339-377`
- 现象: `makeManualHomeworkUid()` 的哈希输入为 `title | deadline | courseName`，不含 `courseId`。但 `identityKey` 包含 `courseId`，显示出课程归属本应属于身份的一部分。
- 影响: 两门课程使用相同课程显示名，且创建同标题、同截止时间的手动提醒时，会生成同一 UID。随后的 `MARK_COMPLETED`、SNOOZE 和通知点击将作用于数组中的第一个匹配项，用户无法独立管理另一项。
- 建议: 将规范化后的 `courseId` 纳入 UID 哈希输入，或改用随机 UUID；添加同名课程的重复场景测试。

### P3: 已完成条目被清除后，下一次 API 同步会重新出现

- 位置: `src/background/service-worker.js:428-438`、`src/background/service-worker.js:517-659`
- 现象: `CLEAR_COMPLETED` 从 `homework_items` 物理删除已完成记录。后续 API 同步仍会返回同一作业且其自动完成状态保留，reconcile 将其视为全新条目并再次加入存储。
- 影响: “清理已完成”不是持久效果。用户完成清理后，只要刷新数据，已完成项再次出现在“已完成”或“全部”视图中。
- 建议: 明确产品语义：若需要永久隐藏，应保存 tombstone / `dismissedCompletedUids` 并在 reconcile 时过滤；若只应清理本地历史，则调整 UI 文案并补充回归测试。

### P3: 旧架构文档与当前代码明显失配，增加维护和排障成本（已解决）

- 位置: `.claude/logs/architecture.md`
- 现象: 2026-09-01 审查时，文档仍描述已删除的 DOM 抓取、`selectors.json`、`HOMEWORK_DATA` / `SCRAPE_NOW` 消息和旧 alarm 配置。
- 影响: 新维护者按该文档修改会针对不存在的模块或错误协议，且会与 `.claude/CLAUDE.md` 的当前事实来源产生冲突。
- 处理: 已更新为当前 API 代理、SPOC bridge、临时代理页和 12 小时调度架构；历史开发过程保留在带日期的 `.claude/logs/` 文件中。
