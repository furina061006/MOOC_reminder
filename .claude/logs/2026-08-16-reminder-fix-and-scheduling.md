# 截止提醒修复 + 事件驱动调度 — 2026-08-16

## 一、起因

backlog 两项：① 截止提醒功能无法正常工作；② 「作业按天更新，不需要高强度轮询，降低查询频率/脱离浏览器」。

## 二、截止提醒「不工作」的根因排查

入口结论先行：**不是单一 bug，是一组**。通知总开关/权限/图标/默认值全部正常（manifest 有 notifications 权限、notificationsEnabled 默认 true、34 个既有单测全过）。逐层排查后确认的硬 bug：

| # | Bug | 位置 | 症状 |
|---|-----|------|------|
| B1 | `SNOOZE_ITEM` 只设 `snoozedUntil`，不清 `lastNotificationLevel` | SW SNOOZE handler + maybeNotify 去重判断 | 「稍后提醒」24h 后同档位永不再提醒；对已过期条目（level 恒为 overdue）点一次 snooze 就永久静默——用户感知「提醒坏了」 |
| B2 | `maybeNotifyDeadlines` 把进入函数时的 `allItems` 快照整体写回；与并发 `reconcileHomeworkData` 交错 | maybeNotifyDeadlines 写回 vs COURSE_API_DATA 写回 | 双向灾难：reconcile 抹掉 lastNotificationLevel → 重复弹；或通知写回覆盖刚 reconcile 的完成状态 → 已完成项复活。performPeriodicScrape 里 busy-wait 等 COURSE_API_DATA 的存在证明二者天然并发 |
| B3 | 通知点击只认 `item.pageUrl`；API 条目 pageUrl 恒为空（课程记录从不存 pageUrl） | SW notifications.onClicked | 点击通知无任何动作。popup.js 有 `resolveItemUrl` 兜底但 SW 没有 |
| B4 | digest 先写 `last_digest_date` 再 create；免打扰命中直接 return（alarm 周期 24h 无重试） | sendDailyDigestNotification | create 失败也吞掉当天；免打扰命中丢整天摘要（补发 checkMissedDigest 同样被挡） |
| B5 | `normalizeSettings` 对空 `notifyLeadHours` 回退默认 [48,24] | shared/settings.js + SW 内联副本 | 设置页全部取消勾选档位是假象 |
| B6 | SW 整份内联复制 settings.js（manifest 明明是 type:module，零 import） | SW 头部 66 行 | 任何 settings 修复都要改两处，漂移温床 |

开发日志 2026-06-26 的结论「通知通道正常，没收到是因为截止阈值未触发」只对了通道那一半——阈值判定本身埋着 B1/B2。

### 修复

- B1：snooze 时 `lastNotificationLevel = null`（集成测试覆盖完整时序：snooze 中静默 → 到期重弹）
- B2：新建 `shared/items-mutex.js`（可注入 get/set 的 promise 链串行锁）→ SW 的 `mutateHomeworkItems`；**所有** homework_items 读-改-写点走锁（reconcile / MARK_COMPLETED / SNOOZE / ADD_MANUAL / CLEAR_COMPLETED / 通知补丁）；通知写回改为**锁内 fresh read + 按 uid 只补丁通知字段**，绝不整体写回。另加 `notifyInFlight` 在途守卫关掉「两个并发 tick 各自基于旧快照决定弹通知」的重复窗口
- B3：`shared/item-url.js` 导出 `resolveItemUrl`（以 popup 实现为源），SW 点击兜底重建 `learn/{courseId}?tid={termId}#/{testlist|examlist}`
- B4：日期改到 create 成功后写；「今天已发」检查移入函数开头；免打扰命中 → 一次性 `daily-digest-retry` alarm（`nextQuietEndWhen` 计算下一个 quietEnd 整点）
- B5：仅字段缺失/非法才回退默认；显式 `[]` 保留
- B6：SW 删除内联副本，import `shared/settings.js`（并导出 clampInt）

## 三、降频与事件驱动调度

### 排查发现

- README 宣称「打开任意 MOOC 页面即可刷新全部已知课程」**实际不存在**：main.js init 只刷新当前课程（xhr-hook 搭车），全量刷新只由 30min alarm / 手动按钮 / 新课程发现触发。直接降频会伤及时性。
- `performPeriodicScrape` 把整批课程发给**每个**匹配标签页——开 2 个标签页 = 全套抓取（每课 ~200KB × 端点重试）跑两遍。
- badge-refresh 5min 的唯一网络无关开销就是唤醒 SW 本身；通知投递粒度寄生在它身上。

### 方案（事件驱动为主，周期兜底）

| 触发 | 频率 | 作用 |
|---|---|---|
| `PAGE_OPENED`（main.js init → SW） | 每次打开 learn/spoc 页 | 全量刷新主通道，SW 侧 30min 节流 |
| `onStartup` | 浏览器启动 | 同节流；每日新鲜度锚点 |
| periodic-scrape | **240min**（原 30） | 兜底 |
| badge-refresh | **15min**（原 5） | 本地徽章重算 + 通知检查 |

- SW 唤醒 ~336/天 → ~102/天
- `pickApiProxyTab`：按 `lastAccessed` 挑一个标签页发 BATCH_API_FETCH
- 「完全脱离浏览器」论证后放弃：登录 cookie（NTESSTUDYSI）绑定浏览器 profile，浏览器外取不到；且与「无后端」设计决策冲突。降频已达成「不吃性能」的实际目标

## 四、测试策略（本次最大方法论收获）

根因全部藏在 SW 内联、不可 import 的零覆盖区——**这就是 bug 藏身之处**。修复顺势改变测试结构：

1. 纯逻辑下沉 shared/（reminder.js 的 collectDueNotifications/nextQuietEndWhen、item-url、items-mutex），正常单测
2. **`tests/unit/service-worker.integration.test.mjs`：stub chrome.*（storage Map/监听器数组/通知记录器）后直接 `import` 真实 SW 模块**，驱动真实 alarm handler / message handler / onClicked。8 个场景全绿：新默认 alarm 注册、档位跨越弹一次+去重、并发 tick 不重复（在途守卫）、snooze 清记忆后到期重弹、点击重建 URL、PAGE_OPENED 单标签页分发+节流、digest 免打扰重试、digest 日期后写
3. 测试暴露的真 bug：写并发 tick 用例时发现「决策基于陈旧快照」窗口 → 补 notifyInFlight 守卫。**先写测试设计再实现，逼出了实现缺陷**

## 五、过程中的坑

- **eslint 从未真正跑过**：node_modules 不存在，`npm run validate` 里的 lint 步骤历史性失败。本次装依赖后暴露 58 个存量错误（xhr-hook/spoc-tid-bridge 从未被任何 globals 组覆盖、hasOwnProperty、var 重声明等），全部机械修复 + 配置补齐，validate 首次全绿（59/59 测试，0 error）
- eslint 配置里 `src/background` 原来是 `sourceType: 'script'`，SW 加 import 后须移入 module 组
- 集成测试 5 初版失败是**测试自身**数据问题（只覆盖 uid 没覆盖 courseId/termId，URL 兜底当然用旧值）——失败信息先怀疑测试再怀疑实现
- 浏览器验证：本环境无浏览器后端（browser-use 列表为空、WSL 无 chromium），改为上述 Node 集成测试方案，覆盖反而比手工冒烟更全、可回归

## 六、涉及文件

- `src/background/service-worker.js` — 全部 B/C 修复 + import 化 + 在途守卫
- `src/shared/settings.js` — 空档位 + 新默认 + 导出 clampInt
- `src/shared/reminder.js` / `item-url.js` / `items-mutex.js` — 新建
- `src/content/main.js` — PAGE_OPENED + 存量 lint 修复
- `eslint.config.js` — module 组调整 + globals 补齐
- `tests/unit/` — reminder/item-url/items-mutex 新测试、settings 更新、service-worker.integration 新增
- `CLAUDE.md`（调度与截止提醒章节）、`README.md`、`backlog.md`
