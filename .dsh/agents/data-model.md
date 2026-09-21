# 数据模型与设计决策

> 入口索引与工作约定在仓库根目录 [`AGENTS.md`](../../AGENTS.md)；本文件是 `.dsh/agents/` 知识库的一部分。

## 数据模型

### HomeworkItem UID
```
{courseId}_tid{termId}_ch{chapterId}_le{lessonId}_hw{homeworkId}
```
例: `BIT-268001_tid1460270441_ch3_l2_hw5`

### Storage Keys (chrome.storage.local)
- `homework_items` — HomeworkItem[]
- `courses` — Course[]
- `last_sync` — ISO timestamp
- `sync_errors` — 最近错误的环形缓冲
- `user_settings` — 用户偏好
- `scrape_status` — 通用抓取状态（不属于临时代理）
- `temporary_proxy_job` — 扩展拥有的临时代理页任务；含 tab ID、phase、deadline 和预期课程
- `dismissed_completed_uids` — 「清理已完成」的 tombstone 列表；reconcile 据此不再复活已清理的已完成作业
- `update_status` — 最近一次更新检查的结果缓存（当前/最新版本、下载链接、检查时间、错误、已提醒过的版本）；设置页只读它，不额外发请求
- `popup_ui_state` — popup UI 状态

### HomeworkItem 关键字段
```
{ uid, identityKey, courseId, termId, courseType, title, type, status,
  checkedOff, manuallyCheckedOff, autoDetectedCompleted, completionReason,
  hwPhase, deadline, score, totalScore, source, pageUrl }
```
- `courseType`: 'mooc' | 'spoc' | 'manual'；由 `apiExtractHomework` 写入（两份拷贝必须一致，见不变量 12），用于点击跳转时选择 `/learn/` 或 `/spoc/learn/`。旧条目可能没有该字段，因此 `resolveItemUrl(item, courseType)` 支持调用方显式传入课程类型兜底。
- `pageUrl`: API 条目由 `resolveCourseForExtraction()` 从 `course.pageUrl` 继承——即 SPOC 的真实路由 URL。**它一旦存在，`resolveItemUrl` 完全不看 `courseType`**（不变量 5）。

### Course 结构
```
{ courseId, termId, activeTermId, courseName, schoolName, courseType, pageUrl }
```
- `courseType`: 'mooc' | 'spoc' | 'manual'（弱信号，可能被链接采集降级）
- `courseId`: `{school}-{numericId}` 格式；**一门课只有一条记录（唯一键）**，SPOC 与同名 MOOC 会碰撞，SPOC 优先（不变量 11）
- `termId`: **路由 termId**（learn URL 的 `?tid=`），来自链接采集/真实页面。**绝不能被 API 抓取用的 termId 覆盖**（不变量 10）
- `activeTermId`: SPOC 真实 termId（API id）。只由真实 SPOC 页写入，是「这门课是 SPOC」的唯一可靠证据（不变量 9）
- `pageUrl`: 真实 SPOC 路由 URL，由 `COURSE_UPDATE` 冻结；点击跳转的首选来源

---

## 关键设计决策

1. **无后端**: 纯浏览器扩展，所有数据在 chrome.storage.local
2. **API 优先**: 主要完成检测基于 API 字段 (userScore, usedTryCount, scorePubStatus)
4. **手动覆盖自动**: 用户手动勾选永远优先于自动检测
5. **SPA 感知**: URL hash 监控 + DOM MutationObserver
6. **SPOC 支持**: WAR 脚本注入 + DOM bridge 读真实 termId
7. **Reconcile 策略**: UID 匹配 → secondary dedup → 保留手动标记 → API 完成状态不回流

---
