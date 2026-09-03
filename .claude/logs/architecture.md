# MOOC Reminder — 完整架构文档

> 最后更新: 2026-09-01
> 架构基线: API 优先抓取、事件驱动同步、Manifest V3
> 目标平台: 中国大学MOOC (icourse163.org)

---

## 一、项目概述

MOOC Reminder 是一个 Chrome/Edge Manifest V3 浏览器扩展，用于本地追踪中国大学 MOOC 的未完成测验、作业和考试。

核心原则：

- 无后端；所有用户数据保存在 `chrome.storage.local`
- API 优先；不再使用 DOM selector 抓取作业列表
- 内容脚本利用已登录页面发起同源请求，Service Worker 负责调度、合并、提醒和徽章
- 手动完成状态优先于平台的自动检测结果
- 支持普通 MOOC 与 SPOC 课程

## 二、运行组件

```text
src/
├── background/     Service Worker：alarm、消息路由、reconcile、badge、通知
├── content/        内容脚本：页面 API 代理、SPOC real termId bridge、XHR hook
├── popup/          弹出窗口：列表、筛选、手动操作、刷新
├── options/        设置页面：提醒、免打扰、摘要、静音课程等
└── shared/         共享逻辑：模型、API 解析、存储、提醒、URL、互斥锁
```

各组件的职责边界：

| 组件 | 责任 |
|---|---|
| Content Script | 在 `icourse163.org` 页面获取 CSRF，并以同源 XHR 抓取课程 API |
| Service Worker | 复用代理学习页或创建受管临时代理页、调度全量刷新、解析/合并数据、更新徽章、发送通知 |
| Shared | 提供可单测的解析、完成判断、提醒等级、存储互斥和跳转 URL 逻辑 |
| Popup / Options | 读取和修改本地状态；不直接调用 MOOC API |

## 三、完整数据流

```text
触发：用户打开学习页、浏览器启动、periodic-scrape 或 Popup 手动刷新
  -> Service Worker 读取已保存课程
  -> 有现有 /learn/ 或 /spoc/learn/ 标签页：选取 lastAccessed 最新的一个
  -> 无现有学习页：创建非激活 about:blank
       -> 写入 temporary_proxy_job + 一次性 timeout alarm
       -> tabs.update() 导航到一门已保存课程的学习页
       -> 仅匹配 tab ID 的 PAGE_OPENED 认领任务
  -> BATCH_API_FETCH { courses, proxyJobId? } 发送给代理标签页
  -> Content Script 为每门课程调用同源 MOOC API
  -> COURSE_API_DATA { course, rawData } 发送到 Service Worker
  -> apiExtractHomework(rawData) 生成 HomeworkItem[]
  -> reconcileHomeworkData() 按 UID 合并并持久化
  -> updateBadgeFromStorage() -> maybeNotifyDeadlines()
  -> 临时页：BATCH 响应或 TEMPORARY_PROXY_BATCH_COMPLETE 成功；完成、超时或关闭后只移除 owned tab
  -> Popup 从 chrome.storage.local 展示作业清单
```

打开任意课程路由都可以触发刷新；用户不必停留在测验、作业或考试列表页。首次登录并载入过课程后，即使没有现成学习页，后台也可短暂创建一个非激活代理页完成同源抓取。

## 四、平台 API 与认证

### 4.1 CSRF token

平台的 `NTESSTUDYSI` Cookie 是 CSRF token，须追加到 API URL 的 `csrfKey` 参数。

该 Cookie 是 `HttpOnly`，不能依赖 `document.cookie`。内容脚本通过扩展的 `cookies` 权限读取：

```javascript
const cookie = await chrome.cookies.get({
  name: 'NTESSTUDYSI',
  url: 'https://www.icourse163.org/'
});
const csrf = cookie?.value || '';
```

### 4.2 主接口

```text
POST https://www.icourse163.org/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey={csrf}
Content-Type: application/json;charset=UTF-8
Body: {"termId": 1476504498}
```

返回完整课程 DTO，通常超过 200KB。主要结构为：

```text
result.mocTermDto.chapters[]
  -> lessons / homeworks / quizs / exam
    -> test
```

节点及其 `test` 子对象包含作业类型、截止时间、提交次数、分数和互评状态等字段。该接口也是目前 SPOC 可用的主接口，但 SPOC 必须使用真实 termId。

### 4.3 辅助接口

普通 MOOC 课程可额外调用：

```text
POST https://www.icourse163.org/web/j/mocQuizRpcBean.getOpenHomeworkInfo.rpc?csrfKey={csrf}
```

它补充 `submitStatus` 等字段。SPOC 上该接口通常返回 `code:-1007`，因此不能作为 SPOC 的前提。

### 4.4 为什么由内容脚本发请求

Service Worker 的 `fetch()` 不处于 MOOC 页面 origin，无法通过平台 CSRF 认证。内容脚本在已登录的 `icourse163.org` 页内使用同源 `XMLHttpRequest`，浏览器会自动附带登录 Cookie，因此是当前无后端设计下可行的请求路径。

## 五、SPOC real termId 处理

SPOC 课程可能同时存在：

| 来源 | termId 的意义 |
|---|---|
| URL `?tid=` | 常为壳 ID，主接口可能仅返回空数据 |
| `window.moocTermDto.id` 或 `window.termDto.id` | 真实课程 ID，可获取完整 DTO |

处理步骤：

1. `spoc-tid-bridge.js` 以 web accessible resource 注入页面上下文。
2. 页面脚本读取 `window.moocTermDto.id`，并后备读取 `window.termDto.id`。
3. 页面脚本把真实 ID 写入 `<html data-mooc-real-termid="...">`。
4. `content/main.js` 读取该属性，并在批量请求时只替换当前 SPOC 课程自身的 termId。

不能把一个 SPOC 页面的真实 termId 套用到所有课程；那会把 SPOC 数据错误归属到普通课程，造成重复作业。

页面 hook 通过外部 `xhr-hook-page.js` 注入。不得使用 `script.textContent` 注入内联代码，因为 icourse163.org 的 CSP 会阻止其执行。

## 六、作业提取与完成检测

### 6.1 类型和字段兼容

`apiExtractHomework()` 递归遍历课程 DTO，只提取存在有效作业信号的节点。类型优先使用 API 的 `contentType`：

| contentType | 类型 |
|---:|---|
| 2 | quiz |
| 3 | homework |
| 6 | exam |

只有 `contentType` 缺失时，才以标题关键词作兜底。读取字段时优先顶层节点，同时后备读取 `node.test`，以兼容不同 SPOC 的数据形态。

### 6.2 自动完成规则

```text
有 userScore > 0
  -> 已完成
否则，作业或考试的 usedTryCount > 0
  -> 若在互评中，保持未完成并标记手动确认
  -> 否则已完成
否则，含“已完成”或“已批阅”等文本信号
  -> 已完成
否则
  -> 未完成
```

互评作业依据 `enableEvaluation`、`evaluateStart`、`evaluateEnd`、`evaluateScoreReleaseTime` 和 `scorePubStatus` 判断阶段：

- 互评窗口内：未完成，Popup 显示“互评中”和“手动确认”
- 互评窗口结束或成绩已公布：可视为完成
- 平台提前给出 `scorePubStatus:1` 时，仍优先核对实际结束时间，避免过早完成

平台不暴露“用户是否已完成互评”的可靠字段；`submitStatus` 只描述作业提交，不描述互评完成。因此互评窗口内只能要求用户手动确认。

### 6.3 UID

每个项目以稳定 UID 合并：

```text
{courseId}_tid{termId}_ch{chapterId}_le{lessonId}_hw{homeworkId}
```

手动创建的项目同样进入统一数据模型，但标记为手动来源。

## 七、数据合并与并发安全

API 数据到达后，Service Worker 调用 `reconcileHomeworkData()`：

1. 以 UID 匹配历史记录。
2. 更新标题、截止时间、自动完成状态和 API 字段。
3. 保留 `manuallyCheckedOff`、稍后提醒、通知等级等用户和本地状态。
4. 对重复项做二次去重。
5. 写入 `homework_items` 并更新徽章。

完成状态的优先级是：

```text
手动标记 > 自动检测 > 默认未完成
```

`homework_items` 的一切读-改-写必须通过 `shared/items-mutex.js` 的 `mutateHomeworkItems` 串行锁。通知写回、reconcile、手动完成、snooze、清理等并发操作若直接整体写回陈旧快照，会导致重复提醒或已完成项目复活。

主要 storage key：

```text
homework_items
courses
last_sync
sync_errors
user_settings
scrape_status
popup_ui_state
```

## 八、调度、徽章与通知

### 8.1 调度策略

```text
PAGE_OPENED             主同步入口；30 分钟节流
onStartup               浏览器启动时的同步检查，并在当天首次启动时尝试发送临期摘要
periodic-scrape         默认每 12 小时兜底
badge-refresh           默认每 12 小时重算徽章并检查提醒
daily-digest            用户开启后每天按所选时间发送摘要
```

批量抓取优先发往 `lastAccessed` 最新的一个匹配标签页，避免多标签页重复下载完整课程 DTO。不存在匹配学习页时，Service Worker 从已有课程记录创建一个非激活临时页；它先以 `about:blank` 取得 tab ID 并落盘任务，再导航到 MOOC/SPOC URL，避免快速 `PAGE_OPENED` 竞态。90 秒的一次性 alarm 在成功、失败、重启或用户关闭后兜底清理该 owned tab。

### 8.2 Badge

未完成项目按紧急程度显示：

- 无未完成项：不显示 badge
- 存在过期未完成项：红色
- 存在 48 小时内截止项：橙色
- 其余未完成项：蓝色

静音课程不出现在 Popup 默认视图、不计入 badge，也不会进入通知和摘要。

### 8.3 截止提醒

`maybeNotifyDeadlines()` 使用 `shared/reminder.js`：

1. 过滤已完成、已静音、snooze 未到期和免打扰时段内的项目。
2. 按用户配置的阈值计算提醒等级，例如 48h、24h、已过期。
3. 仅在项目首次跨入新等级时创建通知。
4. 通知成功后，以 UID 为单位写入 `lastNotificationLevel`。

`notifyInFlight` 防止并发检查重复弹窗。执行 snooze 时必须清空 `lastNotificationLevel`，否则 snooze 到期后同等级项目不会再次提醒。

通知图标必须使用 `chrome.runtime.getURL()` 生成绝对扩展资源 URL。点击通知时若项目没有 `pageUrl`，用 `shared/item-url.js` 根据课程、termId 和类型重建跳转地址。

### 8.4 每日摘要

每日摘要按截止时间升序选择最早的 3 项，其余以“另有 N 项”汇总。到用户设置的摘要时间会发送一次；若当天尚未发送，浏览器首次启动时也会立即尝试发送临期摘要。只有 `chrome.notifications.create()` 成功后才写入当天已发送记录；若命中免打扰，创建一次性 retry alarm，在免打扰结束后补发。

## 九、消息协议

| 消息 | 方向 | 作用 |
|---|---|---|
| `PAGE_OPENED` | Content Script -> SW | 当前课程页打开；匹配 temporary_proxy_job 的 tab ID 时启动任务，否则触发节流后的全量同步 |
| `BATCH_API_FETCH { courses, proxyJobId? }` | SW -> Content Script | 让一个选定或临时代理标签页批量请求已知课程 API |
| `COURSE_API_DATA { course, rawData }` | Content Script -> SW | 交付课程 API 原始响应 |
| `TEMPORARY_PROXY_BATCH_COMPLETE { proxyJobId, resultCount }` | Content Script -> SW | 交付临时批量完成信号，使 MV3 Worker 重启后仍能关闭 owned tab |
| `TRIGGER_SCRAPE` | Popup -> SW | 用户要求立即刷新 |
| `GET_HOMEWORK` | Popup -> SW | 读取作业及课程数据 |
| `MARK_COMPLETED` | Popup -> SW | 手动标记或取消完成 |
| `SNOOZE_ITEM` | Popup -> SW | 暂停特定项目的提醒 |
| `CLEAR_COMPLETED` | Popup -> SW | 清理已完成记录 |

## 十、测试与已知限制

测试分两层：

- `tests/unit/*.test.mjs`：测试 shared 中的纯逻辑，例如提醒、设置、日期、模型、API 解析、日历和 URL。
- `tests/unit/service-worker.integration.test.mjs`：stub `chrome.*` 后直接加载真实 Service Worker，覆盖 alarm、消息、通知去重、snooze、摘要重试和通知点击等路径。

`npm run validate` 执行 ESLint 与全部 `node --test` 测试。

已知限制：

- 首次必须登录并打开过一个 MOOC/SPOC 学习页以保存课程路由；后续刷新可使用短暂的非激活临时代理页，但登录失效或页面无法加载会在 90 秒后失败并清理。
- 平台 API 或字段改版可能导致抓取失效。
- 数据仅存在当前浏览器本地，不跨设备同步。
- 互评窗口内无法可靠自动判断用户是否已完成互评。
- SPOC 的辅助接口不可用，且新课程可能需要增加真实 termId 页面变量的兼容。
