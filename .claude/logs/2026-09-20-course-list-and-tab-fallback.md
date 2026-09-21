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

## 三、后续：用户报「还是抓取不到一点」

用户给的 Service Worker 日志是关键证据：

```
[MOOC Reminder] Manual scrape triggered
[MOOC Reminder] Periodic scrape started      ← 之后什么都没有
```

`Periodic scrape started` 之后**再无任何输出**。把 `performPeriodicScrape` 的每条出口逐一对照后，
只有一条路是**完全静默**的：

```js
const apiCourses = buildApiCourseList(courses, ignoredCourseIds);
if (apiCourses.length === 0) {
  return { success: false, error: '没有可抓取的已载入课程', tabsScanned: 0 };  // 无日志、无 sync_error
}
```

即**课程列表为空**，抓取在第一步就退出 —— 与「一点都抓不到」完全吻合。`periodicScrapeInFlight`
每次都是 null（否则不会打印 "started"），所以不是卡住。

**这行静默 return 本身就是缺陷**：它让「popup 空白」既不在 Console 留痕、也不进 `sync_errors`，
于是用户只看到「请先登录 MOOC」这类误导提示。已改为按三种情况分别报告（无课程 / 只有手动条目 /
全部被忽略或跳过滤），并写入 `sync_errors` 让设置页与 popup 都能显示。

**教训（与近失日志同源）**：**任何提前 return 都必须留下可被用户看到的痕迹**，
否则排查只能靠读代码猜出口。

## 四、用户复现「清空后再刷新就抓不到」

真实症状（登录恢复后）：**刷新后第一次能抓到，清空数据后再刷新就抓不到**。

根因是 `course-discovery` 的**每页只上报一次**（`reported` 去重）：「清空数据 / 删除课程」把 `courses`
清掉后，那些**已经打开着**的课程页不会再上报，于是课程列表恒为空、抓取在第一步退出。用户唯一的出路是
手动 F5 —— 这不该由用户承担。

**修复**：SW 在 `apiCourses.length === 0` 时向已打开的学习页发 `REQUEST_COURSE_LINKS`；
`course-discovery` 收到后清空 `reported` 并立即重新采集（`harvest(true)`），随后 SW 重新读取课程并继续本次刷新。
没有标签页可问时才走「报告原因」那条路（上一节的修复）。

**同时确认的一条排除项**：用户早先那次「一点都抓不到」是**登录态失效**导致的 ——
所以排查抓取问题的第一步永远是**确认登录有效**（设置页「系统反馈」里的 csrf/登录状态正是为此存在的）。

## 五、仍未解决：同一页面只抓取一次（2026-09-20 收工时的状态）

用户实测复现：**对同一个课程页面只抓取一次成功，之后再也不抓，必须重新打开页面才行。**

**已确认/已排除**
- 内容脚本的消息监听器是**一次性注册、可重复响应**的（`main.js:43-67`：`BATCH_API_FETCH` 分支
  每次都会调用 `batchApiFetch` 并 `return true`），所以不是内容脚本侧的「只处理一次」。
- SW 侧 `performPeriodicScrape` 的 `periodicScrapeInFlight` 在 `finally` 里正常清理。

**候选根因（均未证实，禁止据此改代码）**
1. `periodicScrapeInFlight` 被某个**未 settle 的 await 长期占用**（例如内容脚本返回 `true` 却永不
   `sendResponse`），于是后续 `TRIGGER_SCRAPE` 全部返回同一个 pending promise。
2. 遗留的 `temporary_proxy_job`（内存里的 `activeTemporaryProxyJob`）让
   `createTemporaryProxyJob` 直接返回 `pending: true` 的失败，从此再也不抓。
3. 某门课的响应为空 → 内容脚本返回 `[]` → SW 抛 `MOOC proxy returned no course data`；
   该错误**不属于**「没有 content script」，所以既不 fan-out 也不降级到代理页。

**下一步（唯一动作）**：要用户在「第二次失败」那一刻提供 Service Worker Console 的
`[MOOC Reminder]` 日志，看断点落在哪一步（`Periodic scrape started` → 有无 `Sending BATCH_API_FETCH`
→ 有无 `Periodic scrape failed:` / 代理相关的行）。同时确认用户的实际操作是「点刷新按钮」还是
「打开 popup 看」——popup 只在列表为空时自动抓取（`popup.js:150`）。

## 六、本次会话的诚实状态盘点

| 事项 | 代码+单测 | 真实数据/浏览器验证 |
|---|---|---|
| SPOC 点击跳转（`/spoc/learn/` + 正确 tid） | ✅ | ❌ 用户未确认 |
| 插件更新提醒 | ✅ | ⚠️ 仅对真实 GitHub API 验证过解析，浏览器未确认 |
| SPOC 两 term 并集抓取（老师新增内容） | ✅ | ✅ 用真实 DTO 验证 1 条→5 条；浏览器未确认 |
| 设置页「已追踪课程」忽略/删除 | ✅ | ⚠️ 用户实测过「删除」确实清空了数据；「忽略」未确认 |
| 陈旧标签页降级到临时代理页 | ✅ | ❌ 未确认 |
| 空课程列表不再静默（日志 + sync_errors） | ✅ | ⚠️ 用户日志证实了「静默」这一现象存在；修复后的表现未确认 |
| 清空数据后主动要求页面重新上报课程 | ✅ | ❌ **未确认，且用户随后报告的「只抓取一次」说明刷新链路仍有问题** |

**结论**：以上全部**只到「代码完成 + 单测通过」为止**，不能当作「已解决」。其中
「同一页面只抓取一次」是**未解决的活动缺陷**，已列入 backlog 首位。
