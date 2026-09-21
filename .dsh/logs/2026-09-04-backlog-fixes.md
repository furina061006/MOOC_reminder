# backlog 2026-09-01 审查问题的修复

日期：2026-09-04
分支：dsh

## 背景

`backlog.md` 中 2026-09-01 的代码审查有 4 条「仍存在」和 1 条「触发路径已失效」。本轮逐条修复，并把已解决的条目从 backlog 删除（历史结论保留在更新日志和本文件）。

## 1. SPOC 条目跳转到错误路由

**根因**：`resolveItemUrl()` 在 `src/shared/item-url.js` 和 `src/popup/popup.js` 各有一份，都硬编码 `https://www.icourse163.org/learn/`。而 `COURSE_LINKS` 与 `COURSE_UPDATE` 注册课程时不写 `pageUrl`，`HomeworkItem` 也不带 `courseType`，所以 SPOC 的 API 条目必然走无 `pageUrl` 的回退分支，构造出普通课程 URL。

**修复**：

- `resolveItemUrl(item, courseType)` 增加课程类型参数，`spoc` 用 `/spoc/learn/`，其余用 `/learn/`；条目自带的 `courseType` 作为后备。
- `apiExtractHomework()` 在生成条目时写入 `courseType`（来自 `buildApiCourseList()` 已携带的字段）。
- Service Worker 通知点击时查 `courses` 拿课程类型传入；popup 用 `courseTypeFor(courseId)` 查 `state.courses` 后传入。这样即使条目是旧数据、没有 `courseType`，也能正确解析。

**为什么不让 `resolveItemUrl` 自己查存储**：它是纯函数、被单测覆盖，popup 与 SW 共享镜像实现；把课程类型作为参数传入保持纯函数，同时让调用方选择数据来源。

## 2. `upsertCourse()` 并发写覆盖 `courses`

**根因**：`homework_items` 有 `mutateHomeworkItems` 串行锁，但 `courses` 是裸 `getCourses() -> 修改 -> set`。`COURSE_LINKS` 循环注册、`COURSE_UPDATE`、每个 `COURSE_API_DATA` 的 reconcile 都会并发写，两个写入者读到同一旧数组后后写覆盖前写。

**修复**：

- 用同一个 `createSerializedStore` 工厂建立 `mutateCourses`（`get`/`set` 接到 `getCourses`/`setCourses`）。
- `upsertCourse()` 改为在 `mutateCourses` 内完成读-改-写，是课程写入的唯一入口。
- `RESET_DATA` 用 `mutateCourses(() => [])` 清空，避免重置与在途 upsert 竞争导致课程复活。
- 启动修复路径同步校验 `courses` 仍为数组（保持原有行为）。

未给 `courses` 引入额外的双缓冲或事务层：串行锁与 `homework_items` 语义一致，成本最低且已被集成测试覆盖。

## 3. 手动提醒 UID 忽略 `courseId`

**根因**：`makeManualHomeworkUid()` 哈希输入是 `title | deadline | courseName`，不含 `courseId`；而调用处写入的 `identityKey` 包含 `courseId`，两者语义不一致。

**修复**：哈希输入加入 `courseId`，`uid` 与 `homeworkId` 复用同一个 `manualUid` 变量，避免重复计算和潜在不一致。

**兼容性**：旧的手动提醒 UID 会变化，等于同一提醒重新生成一个 UID；旧条目仍在存储中，不会删除，但不会与新条目合并。手动提醒数量少，且此前同名课程本来就会互相冲突，因此接受这个一次性影响。

## 4. `CLEAR_COMPLETED` 不持久

**根因**：`CLEAR_COMPLETED` 物理删除 `checkedOff` 条目；下一次同步 API 仍返回同一作业，reconcile 按 UID 视为新条目重新写入并再次标记完成。

**修复**：引入 tombstone 列表 `dismissed_completed_uids`。

- `CLEAR_COMPLETED` 在删除条目的同时把 UID 记入该列表。
- reconcile 遇到「同 UID 的新条目」时：如果它是**已完成**状态，跳过不写入；如果它是**未完成**状态（例如新一轮作答），删除该 UID 的 tombstone 并正常写入，避免把重新出现的作业永久隐藏。
- `RESET_DATA` 清空该列表；`validateAndRepairStorage` 校验其类型并提供默认空数组。

**为什么不复用 `identityKey` 或加 `dismissed` 布尔字段**：tombstone 必须独立于条目存在，因为条目已被物理删除；放在条目上无法阻止重建。

## 5. `course-discovery.js` 的非 learn 页 `BATCH_API_FETCH` 分支

**根因**：该分支用 `document.cookie` 读 `NTESSTUDYSI`，而它是 HttpOnly，永远读不到，只能返回空数组。同时当前调度已不再向非 learn 页面发送 `BATCH_API_FETCH`（只发给 `/learn/*`、`/spoc/learn/*` 标签页或导航到 learn URL 的临时代理页），所以这段代码既错误又不可达。

**修复**：直接删除该分支，`course-discovery.js` 只保留课程链接采集职责，并在原位置留注释说明为什么不要再加回来。没有改成 `chrome.cookies.get()`：保留一条不会被调用的路径只会增加维护面。

## 测试

新增/扩展的自动化测试（`npm run validate`，81 项通过，ESLint 0 error）：

- `tests/unit/item-url.test.mjs`：SPOC 前缀、`item.courseType` 后备、显式参数优先、SPOC `pageUrl` 只修 hash。
- `tests/unit/service-worker.integration.test.mjs`：
  - 通知点击对 SPOC 课程使用 `/spoc/learn/`
  - 并发 `COURSE_LINKS` + `COURSE_UPDATE` 不丢课程
  - 同名课程的手动提醒生成不同 UID
  - 清理已完成 → 再次同步不复活；变为未完成时允许回来
  - `RESET_DATA` 清空 tombstone

**回归验证**：临时 `git stash` 掉 `src/` 改动、只保留测试后运行，8 个新增行为测试全部失败；恢复修复后全部通过。这确认测试确实覆盖缺陷而不是恒真。

## 结果

`backlog.md` 中已无未解决条目。所有修复都限制在既有架构内，没有引入新的依赖或后端。
