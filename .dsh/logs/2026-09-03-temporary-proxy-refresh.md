# 2026-09-03: 无现成课程页的自动代理刷新

## 目标

用户已经登录并且曾经载入过普通 MOOC 或 SPOC 课程后，后台周期刷新和 Popup 手动刷新不应再要求保留一个课程标签页。抓取仍必须从 `icourse163.org` 页面中的 Content Script 发出同源 XHR，不能迁移到外部服务或 Service Worker `fetch()`。

## 最终方案

Service Worker 先寻找现有的 `/learn/` 或 `/spoc/learn/` 标签页，存在时继续复用最近使用的一个，绝不关闭它。不存在时：

1. 从已保存的课程中挑选一门有效普通 MOOC 或 SPOC 课程。
2. 创建一个非激活 `about:blank` 标签页。
3. 将扩展拥有的任务写入独立的 `temporary_proxy_job`：任务 ID、tab ID、目标 URL、阶段、90 秒 deadline 和预期课程列表。
4. 创建持久化的一次性 timeout alarm。
5. 只有上述步骤完成后，调用 `tabs.update()` 导航到课程学习页。
6. 该 tab 发出的 `PAGE_OPENED` 启动 `BATCH_API_FETCH`；批量响应、超时、用户关闭 tab、浏览器/扩展重启或重置数据都会只清理该任务的 tab。

SPOC 临时页 URL 使用保存的路由 `termId`，而批量 API 请求使用 `activeTermId || termId`。不能把 SPOC 的真实 API term ID 直接放入 URL，否则可能进入错误课程壳页。

## 为什么不用直接 `tabs.create({ url: courseUrl })`

最初实现直接创建课程 URL，再持久化任务。代码审查指出真实竞态：快速加载的页面可能在 `tabs.create()` 返回后、任务写入 storage 前发送 `PAGE_OPENED`。Service Worker 无法认领该页面，任务只能等到 90 秒超时。

`about:blank` 不匹配 Content Script，因此先创建它不会产生 `PAGE_OPENED`。任务和 alarm 落盘后再导航，才能保证任意课程页的 `PAGE_OPENED` 都有可匹配的持久化所有权。

## MV3 生命周期处理

内存中的 `Promise` 不是可靠完成信号：MV3 可以在逐课程请求期间回收 Service Worker。临时 `BATCH_API_FETCH` 带上 `proxyJobId`；Content Script 在顺序发送完所有 `COURSE_API_DATA` 后追加 `TEMPORARY_PROXY_BATCH_COMPLETE`。如果 Worker 已重启，该消息仍可从 `temporary_proxy_job` 认领并完成清理。

timeout alarm 是唯一跨 Worker 生命周期的 deadline。它与晚到的批量响应竞争时，`finishTemporaryProxyJob()` 先验证 storage 中的任务 ID；第一个终结者清除任务、alarm 和 owned tab，后续终结者不会重写结果或再次关闭 tab。

`temporary_proxy_job` 特意独立于历史 `scrape_status`，避免将来普通抓取状态或 UI 状态覆盖 tab 所有权并造成临时标签页泄漏。

## 验证

`tests/unit/service-worker.integration.test.mjs` 扩展 Chrome stub，并覆盖：

- 无学习页时只创建一个非激活临时页并在结束后关闭。
- 创建请求先为 `about:blank`，随后才导航到课程 URL。
- 导航过程中同步到达的 `PAGE_OPENED` 能认领已持久化任务。
- 仅 SPOC 课程时 URL 使用 `/spoc/learn/` 加 route term ID，payload 使用 `activeTermId`。
- 已有用户课程页被复用且永不关闭。
- `temporary_proxy_job` 不覆盖无关 `scrape_status`。
- 持久化 `fetching` 任务可由完成消息收尾，模拟 Worker 重启后的场景。
- timeout 与晚到成功响应竞争时，timeout 结果和清理只发生一次。
- 超时、用户手动关闭临时页、仅手动课程等边界。
