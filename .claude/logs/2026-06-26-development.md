# 2026-06-26 开发记录

## 总结

核心突破：发现 Service Worker 直接调 API 会 403 是因为 **origin 不对**（`chrome-extension://xxx`），而不是端点或参数问题。参考 GinsMooc 项目，content script 在页面上下文中用同源 XHR 可以绕过。成功实现了 content script 代理 API + SW 存储的架构，只需打开任意 MOOC 页面即可刷新全部课程。另外大幅简化了类型检测、完成检测、reconcile 保护层，并增加了 popup 自动刷新、反馈邮箱等细节。

---

## 成果

### 核心：Content Script 代理 API 抓取
- 参考 GinsMooc 逆向分析：SW 调 API 会 403，页面上下文同源 XHR 不受影响
- `batchApiFetch()` 在 content script 中读 `document.cookie` 取 NTESSTUDYSI，用 XHR 调 `getLastLearnedMocTermDto.rpc`
- 支持 `BATCH_API_FETCH` 消息：SW → content script 发送课程列表 → content script 逐个抓取 → `COURSE_API_DATA` 返回 SW
- 自动从页面 URL 提取当前课程 ID，首次使用无需 storage 有数据
- 效果：打开任意 MOOC 页面即可刷新所有已知课程的作业数据

### 完成检测完善
- `userScore` 字段名修复（之前写 `score` 永远匹配不到）
- `usedTryCount > 0` → 作业已提交待批改也算完成
- `apiHasCompletedText()` 文本模式检测（已完成/已成功提交/已提交…）
- `apiCompleted` 标记保护：API 确认完成的条目不会被 DOM 回退

### 互评阶段检测（API）
- `apiDetectPhase()` 基于 `evaluateStart/End`、`scorePubStatus`、`enableEvaluation` 判定 submit/peerreview/results
- 仅对作业(type:3)生效

### 类型检测修复
- API：优先用 `node.type` 字段（2=测验, 3=作业, 6=考试），名字正则 fallback
- "期末" → exam（"期末测试"是考试不是测验）
- 名字去重：同名子节点（如"期末测试题"vs"期末测试"）自动过滤

### Popup 首次自动刷新
- storage 为空时自动触发刷新 + 轮询等待（最多 15s）
- 刷新时按钮旋转，数据到达立即显示

### UI 优化
- 作业/考试/测验统一显示 `[自动检测]` 标签
- 删除「跳转页面」按钮（标题点击已足够）
- 页面跳转按类型路由（exam → examlist, quiz/homework → testlist）
- 反馈邮箱：popup 和设置页底部 `zemei.huang@foxmail.com`
- 设置页顶部保存提醒
- 每日摘要设置 UI 补全（之前代码有但 HTML 漏了）

### 每日摘要补发
- `checkMissedDigest()` — 开机时如果今日摘要时间已过且没发过，立即补发
- 记录 `last_digest_date` 防止重复

### Reconcile 简化
- 移除三层 ad-hoc 保护 → 统一用 `apiCompleted` 标记
- UID guard + secondary dedup guard + fuzzy title merge → 全删，单行检查

### Popup 刷新算法优化
- BATCH_API_FETCH 加入 course-discovery.js，覆盖所有 icourse163 页面
- HAS_TABS 冷启动重试一次（SW 冷启时首次可能超时）
- handleRefresh 防重入锁（_refreshing 标志）
- 刷新算法改为重试循环：最多 3 轮，每轮双刷 + 轮询 15s
- 修复冷启动问题：第一轮来不及，第二轮 SW 已热就能拿到数据
- 轮询条件从 `allItems.length > 0` 改为 `lastSync` 变化（避免缓存的干扰）

### 互评截止日期修复
- 互评中作业用 `evaluateEnd` 替代提交 `deadline` 作为截止日期
- `evaluateEnd` 加入 `API_DEADLINE_FIELDS` 搜索列表
- `scorePubStatus=1`（互评完待公布）视为完成，不再显示
- 只有 `scorePubStatus=0` 且处于互评期的作业，才留在未完成视图

---

## 发现

### GinsMooc 逆向分析
- 纯 content script，无 Service Worker
- 同源 XHR 自动带 cookie + 读 `document.cookie` 拼 `csrfKey` query 参数
- 端点：`mm-tiku/web/j/mocExamBean.getPaper.rpc`（考试详情，非作业列表）
- 不解决课程结构抓取问题，但验证了「页面上下文是唯一可行路径」

### `getMocTermDto` 端点演变
- 旧端点 `courseBean.getMocTermDto` → 403 / 空
- 新端点 `courseBean.getLastLearnedMocTermDto` → XHR 返回 200KB+ 课程 DTO
- SW 调新端点仍是 403（origin 问题，非端点问题）

### 通知
- `chrome.notifications.create` iconUrl 需要 `src/assets/icons/` 路径
- 通知通道正常，没收到是因为截止阈值未触发
