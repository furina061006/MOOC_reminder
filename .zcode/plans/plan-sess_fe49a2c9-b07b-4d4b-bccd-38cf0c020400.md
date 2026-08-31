# 实现两个 backlog 待办：修复截止提醒 + 降频智能调度

## 背景结论（已核实的根因）

「截止提醒不工作」不是一个 bug 而是一组：通知总开关默认是开的（已排除），真正的硬伤在——

| # | Bug | 位置 | 后果 |
|---|-----|------|------|
| B1 | SNOOZE 只设 `snoozedUntil`，不清 `lastNotificationLevel` | service-worker.js:416-427 + 863 | 「稍后提醒」24h 后同档位永不再提醒 |
| B2 | `maybeNotifyDeadlines` 用陈旧快照整体写回 `homework_items`，与并发 reconcile 互相覆盖 | SW:858-888 vs 675 | 通知状态被抹掉→重复弹；或已完成项被复活 |
| B3 | 点击通知只认 `item.pageUrl`，API 抓取项该字段为空 | SW:891-907 | 点通知无任何动作（popup 有 `resolveItemUrl` 兜底，SW 没有） |
| B4 | 每日摘要：免打扰时段命中→当天直接丢失；且先写日期后发通知 | SW:788-809 | create 失败也吞掉当天摘要 |
| B5 | 设置页取消全部提醒档位→保存后被静默回退为默认 [48,24] | settings.js:48 + SW 内联副本 | 「关闭所有档位」是假象 |
| B6 | SW 把 settings.js 整份内联复制（无任何 import，虽是 module SW） | SW:28-93 | 双份漂移，B5 这类修复必须改两处 |

「降频」侧：当前 periodic-scrape 30min + badge-refresh 5min；**README 宣称的「打开任意 MOOC 页面即刷新全部课程」实际不存在**（main.js init 只刷新当前课程），所以直接降频会伤及时性，需要事件驱动补抓配套。

## 改动方案

### 第一部分：修复截止提醒

1. **B1**：`SNOOZE_ITEM` 里同时清 `item.lastNotificationLevel = null`
2. **B2**：SW 新增串行化写锁 `mutateHomeworkItems(mutator)`（promise 链；读-改-写），`maybeNotifyDeadlines` 改为锁内按 uid 只补丁通知字段（fresh read），其余 RMW 写点（COURSE_API_DATA/reconcile、SNOOZE_ITEM、MARK_COMPLETED、ADD_MANUAL_ITEM、CLEAR_COMPLETED）全部走锁
3. **B3**：新建 `src/shared/item-url.js` 导出 `resolveItemUrl`（以 popup.js:529 实现为源），SW `onClicked` 引入兜底跳转；popup 保持不动（非模块脚本）
4. **B4**：`LAST_DIGEST_DATE` 改为 create 成功后写入；「今天是否已发」检查移入 `sendDailyDigestNotification` 开头；命中免打扰时创建一次性 `daily-digest-retry` alarm（下一个 quietEnd 整点），onAlarm 加对应 case
5. **B5**：`normalizeSettings` 尊重显式空数组（仅字段缺失时才用默认档位）
6. **B6**：SW 删除内联 settings 副本，改为 `import` 自 `../shared/settings.js`（manifest 已是 `type: module`，当前零 import，验证过可行）——消除双份漂移

### 第二部分：降频 + 事件驱动调度

7. **默认值**：`checkIntervalMinutes` 30→240（4h）、`badgeRefreshMinutes` 5→15。clamp 与 UI 上限(1-1440)已存在，无需改；已有自定义设置的用户不受影响
8. **事件驱动补抓**（降频的安全底座）：
   - `main.js` init 末尾发新消息 `PAGE_OPENED`；SW 侧节流（距上次全量同步 <30min 跳过）后触发 `performPeriodicScrape` —— 让 README 宣称的行为真正成立
   - SW `onStartup` 追加一次节流全量刷新（浏览器启动 = 每日新鲜度锚点）
9. **多标签页去重**：`performPeriodicScrape` 目前把整批课程发给**每个**匹配标签页（SW:940-944，开 2 个 tab = 全套抓取跑两遍）→ 改为只发给 `lastAccessed` 最新的一个 learn 标签页
10. **「完全脱离浏览器」不做**：与「无后端」设计决策冲突，且登录 cookie 绑定浏览器 profile，扩展无法在浏览器外取用。降频后 SW 唤醒从 ~336 次/天 降到 ~102 次/天 + 事件驱动，已达成「不吃性能」目标。计划中向用户说明此取舍

效果：作业按天更新的假设下——打开页面/启动浏览器即刷新（事件驱动），4h 周期兜底，通知检测粒度 15min（阈值都是 24h/48h 级，绰绰有余）。

### 文档（项目约定：先 CLAUDE.md 后日志）

11. 更新 `CLAUDE.md`（提醒机制与调度策略段落）、`README.md`（默认间隔文案）、`backlog.md`（划掉两项）、新增 `.claude/logs/2026-08-16-reminder-fix-and-scheduling.md`

## 验证方案

- **单元测试（主要手段）**：新增 `tests/unit/reminder.test.mjs`、`item-url.test.mjs`；更新 `settings.test.mjs`（新默认值、空档位）。新增可注入 storage 的锁模块并测试并发写不丢更新。跑 `npm run validate`（eslint + 全部 node --test）
- **浏览器实测（尽力而为）**：优先尝试 browser-use 的 `extension` backend 连你的 Chrome——若桥接扩展和 MOOC_reminder 开发版都在，做真实 E2E：popup 渲染截图 → 通过 options 页真实点击把提醒阈值调大（如 720h）+ badge 间隔调到 1min → 等待真实通知弹出 → 点击通知验证跳转。若 extension backend 不可用，退化为：用内建浏览器验证 README/文档渲染 + 交付一份 2 分钟手工冒烟清单（含伪造 deadline 数据的步骤）
- snooze 的 24h 时序无法真实等待，其修复正确性由提取到 shared 层的纯函数单测保证

## 涉及文件

`src/background/service-worker.js`（主要）、`src/shared/settings.js`、`src/shared/item-url.js`（新）、`src/shared/items-mutex.js`（新）、`src/content/main.js`（PAGE_OPENED）、`tests/unit/*`、`CLAUDE.md`、`README.md`、`backlog.md`、`.claude/logs/`（新日志）