# 已追踪课程管理 + 多标签页抓取失败

日期：2026-09-20
分支：`dsh`
backlog 条目：「多一个可以在设置界面看到自己追踪的课程列表，可以选择忽略或者删除」、
「课程抓取似乎有问题，我现在浏览器开多个不同课程界面，但popup抓取不到」

## 一、多标签页时抓取不到（bug）

### 根因

`performPeriodicScrape` 只挑 **一个** 标签页（`lastAccessed` 最新的那个）发 `BATCH_API_FETCH`，
失败就 throw，只记一条 `sync_error` —— **没有备用标签页，也没有降级路径**。

而 **重载扩展不会给已经打开的页面补注入 content script**。所以只要那个「最近访问」的页面
是在扩展重载之前打开的，`chrome.tabs.sendMessage` 就会以
`Could not establish connection. Receiving end does not exist` 失败，**整次抓取作废** ——
即使用户还开着别的（能响应的）课程页面。

popup 侧的放大效应：无数据时它会连发 3 轮 `TRIGGER_SCRAPE` 并等 `last_sync` 变化
（`popup.js` init），`last_sync` 永远不变 → 弹出 **「请先登录 MOOC 并至少打开过一门课程后重试」**，
而用户明明开着课程页面。这条提示把排查方向带偏了。

### 修复

| 改动 | 说明 |
|---|---|
| 按 `lastAccessed` 倒序**逐个**尝试学习页 | 只有「对方没有 content script」这种**确定性**失败才继续下一个 |
| 真错误（如超时、返回空）不再 fan out | 否则慢页面会被静默重试掩盖，且总耗时不可控 |
| 全部都是「没人接收」时降级到**临时代理页** | 代理页是新建的，必定有 content script —— 复用已测试的机制 |
| popup 照实显示 `sync_errors` 里的最近一条 | 不再无条件怪「没登录」 |

`isContentScriptMissingError()` 只匹配 `Receiving end does not exist` / `Could not establish connection`。

### 顺带修掉一个自己引入的回归

`main.js` 的 `batchApiFetch` 会把本课程页面的「DOM 真实 termId」写回 `c.termId`。在
**不变量 14** 落地后（SW 对 SPOC 每个 term 各发一条），这个覆盖会把**路由 term**（老师内容）
换回 active term（源课程）—— 也就是说：**只要用户正坐在该 SPOC 页面上刷新，老师那半就被丢掉了**，
而走代理页时却是好的。这种「看你在哪一页」的不一致最难查，已直接删除该覆盖：
term 列表的**唯一所有者是 SW**，DOM 属性只剩 `init()` 里持久化 `activeTermId` 的职责。

## 二、设置页「已追踪课程」（feature）

### 语义边界（关键设计决定）

现有 `mutedCourseIds`（静音）只影响提醒与徽章，**课程仍会被抓取**。用户要的「忽略」是
**停止追踪**，因此新增独立的 `ignoredCourseIds`：

| 动作 | 效果 | 存哪 |
|---|---|---|
| **忽略** | 不进 `buildApiCourseList` → **零 API 调用**；不计入徽章/提醒；可随时恢复 | `user_settings.ignoredCourseIds` |
| **删除** | 删课程记录 + 它的作业条目 + 它的 tombstone；**不影响**忽略列表 | — |

两个刻意的选择：

1. **忽略状态存 settings，不存 Course 记录的 flag**。`course-discovery` 会反复重新登记课程
   （`COURSE_LINKS` → `upsertCourse` 浅合并），存成 flag 虽然也能survive 合并，但把「用户意图」
   和「平台采集到的元数据」混在一条记录里；settings 是用户意图的家。
2. **删除不自动加入忽略列表**。删除是「清数据」，忽略是「不再追踪」，各自单一职责；
   否则「删除」会隐含「永久忽略」，用户无法只清数据。代价是删除后课程可能被页面采集重新加回来 ——
   这一点已写进设置页的提示文字，并明确建议「想彻底不再出现请用忽略」。**这一条最可能需要按用户
   反馈调整**（例如改成删除时一并忽略）。

### 实现

- `settings.js`：`ignoredCourseIds` 默认 `[]`，normalizeSettings 过滤为字符串数组
- `buildApiCourseList(courses, ignoredCourseIds)` 与 `pickTemporaryProxyCourse(courses, ignoredCourseIds)`
  都接收忽略集合；四个调用点（`expectedCourseIds`、`runTemporaryProxyBatch`、`performPeriodicScrape`、
  `createTemporaryProxyJob`）传入
- `updateBadgeFromStorage` 同时排除 `mutedCourseIds` 与 `ignoredCourseIds`
- 新消息：`GET_COURSE_LIST`（含每门课 total/unfinished 计数）、`TOGGLE_COURSE_IGNORE`、`DELETE_COURSE`
- 设置页新「已追踪课程」区块：忽略/恢复 + 删除（删除有 confirm 确认），并写明两者差别

## 验证

`npm run validate`：eslint 0 error，**121/121 通过**（新增 7 条测试）。

新增测试覆盖：

- `GET_COURSE_LIST` 的计数、SPOC 判定（`activeTermId` 优先）、排除 manual 伪课程
- 被忽略的课程**既不进 batch 也不计徽章**
- 忽略可逆
- `DELETE_COURSE` 只清该课的课程/条目/tombstone，不动其它课
- **陈旧标签页被跳过、改用能响应的那个**（`sendMessage` 抛 no-receiver）
- **全部陈旧时降级到临时代理页**
- **真错误不会 fan out**（只试第一个标签页，也不建代理页）

过程中两处测试自身的问题也已修：临时代理任务会留在 SW 内存里抢走后续 `PAGE_OPENED`（测试间状态泄漏），
以及 `onRemoved` 清理是异步的、断言需要 `waitFor`。

## 遗留

- **删除的语义可能需按用户反馈调整**（见上）。
- `main.js` 的 `checkPageHookData` 仍丢弃路由 term 的钩子数据；本次只删了 termId 覆盖，未动
  `sendTid`。批量抓取已覆盖两个 term，所以只是「首次打开页面时的即时性」问题。已在 backlog。
