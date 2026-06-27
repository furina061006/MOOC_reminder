# MOOC Reminder — 开源开发文档

Chrome/Edge Manifest V3 浏览器扩展，自动追踪中国大学MOOC (icourse163.org) 未完成作业。

## 知识管理约定（每次会话遵守）

- **CLAUDE.md（本文件）** — 项目唯一事实来源。所有核心技术结论写在这里，任何开发者打开项目即能理解全貌
- **`.claude/logs/`** — 开发过程记录。写「踩过什么坑、试过哪些死路、为什么选方案 A 不选 B」，给想深挖的人追溯
- **Memory** — 仅用于快速回忆。不再重复存储 CLAUDE.md 已有的技术知识，只保留偏好、习惯等个人上下文
- **每次重大技术变化后**：先更新本文件，再写日志，最后更新 memory 索引

详细开发日志见 `.claude/logs/` 目录。

---

## 架构

```
src/
├── background/     Service Worker — alarms、消息路由、数据 reconcile、badge
├── content/        内容脚本 — API 代理抓取、DOM 爬取（可选）、SPOC 支持
├── popup/          弹出窗口 — 作业列表、筛选、手动操作
└── shared/         共享模块 — 数据模型、API 解析、存储、设置
```

### 数据流

```
用户打开课程页面
  → main.js 注入
    → chrome.cookies.get({name:'NTESSTUDYSI'}) 读取 CSRF（HttpOnly cookie）
    → XHR POST getLastLearnedMocTermDto.rpc → 200KB+ 完整课程 DTO
    → (可选) getOpenHomeworkInfo.rpc → submitStatus 等补充字段
    → SPOC: spoc-tid-bridge.js (WAR) 读 window.moocTermDto.id → DOM bridge
  → COURSE_API_DATA → Service Worker
    → apiExtractHomework() 解析 → HomeworkItem[]
    → reconcileHomeworkData() 合并（UID 匹配 dedup）
    → updateBadgeFromStorage()
```

### 消息协议

- `BATCH_API_FETCH {courses}` — SW → CS，触发批量 API 抓取
- `COURSE_API_DATA {course, rawData}` — CS → SW，API 原始响应
- `HOMEWORK_DATA {course, homeworkItems}` — CS → SW，DOM 抓取结果
- `SCRAPE_NOW` — SW → CS，触发即时 DOM 抓取
- `TRIGGER_SCRAPE` — Popup → SW，手动刷新

---

## icourse163.org 平台

### URL 模式
- MOOC 课程: `https://www.icourse163.org/learn/{school}-{courseId}?tid={termId}#/learn/content`
- SPOC 课程: `https://www.icourse163.org/spoc/learn/{school}-{courseId}?tid={termId}#/learn/content`
- Hash 路由: `#/learn/content`, `#/learn/quiz`, `#/learn/exam` 等

### SPA 特征
- Hash-based routing，无页面重载
- XHR/fetch 动态加载内容，异步渲染
- DOM 类名: `j-` (JS hooks), `m-` (modules), `u-` (utilities)

### CSRF 认证

`NTESSTUDYSI` cookie 用作 CSRF token，加到 API URL 的 `?csrfKey=` 参数。

**⚠️ 该 cookie 是 HttpOnly**，`document.cookie` 读不到。必须用：

```javascript
const cookie = await chrome.cookies.get({
  name: 'NTESSTUDYSI',
  url: 'https://www.icourse163.org/'
});
const csrf = cookie?.value || '';

// Fallback（非 HttpOnly 时还能用）
const m = document.cookie.match(/NTESSTUDYSI=([a-z0-9]+);?/i);
if (!csrf && m) csrf = m[1];
```

需要 manifest 权限: `"cookies"` + `"host_permissions": ["https://www.icourse163.org/*"]`

---

## API 端点

### 主端点: getLastLearnedMocTermDto.rpc

```
POST https://www.icourse163.org/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey={csrf}
Content-Type: application/json;charset=UTF-8
Body: {"termId": 1476504498}
```

返回 ~200KB JSON，结构为 `result.mocTermDto.chapters[]`，每个 chapter 含 `homeworks[]`、`quizs[]`、`exam`。

每个 homework/quiz 节点含 `test` 对象，包含分数、截止日期、互评状态等全部字段。

这是**唯一对 SPOC 可用的端点**（需要真实 termId）。

### 辅助端点: getOpenHomeworkInfo.rpc

```
POST https://www.icourse163.org/web/j/mocQuizRpcBean.getOpenHomeworkInfo.rpc?csrfKey={csrf}
Content-Type: application/json;charset=UTF-8
Body: {"tid": 1247802197, "aid": null, "isDraft": false}
```

返回单个作业的详细信息，含 `submitStatus`（作业提交状态）等补充字段。

### 端点可用性矩阵

| 端点 | MOOC | SPOC |
|---|---|---|
| `getLastLearnedMocTermDto.rpc` | ✅ | ✅ (仅真实 termId) |
| `getMocTermDto.rpc` (+gatewayType=3) | ✅ | ❌ code:-1007 |
| `getMocTermDto.rpc` DWR | ❌ | ❌ |
| `getSpocTermDto.rpc` | — | ❌ code:-1004 |
| `getOpenHomeworkInfo.rpc` | ✅ | ❌ code:-1007 |

---

## API 字段参考

### NODE 层 (getLastLearnedMocTermDto — chapter.homeworks[n])

```
id, gmtCreate, gmtModified, name, position, termId, chapterId,
contentType, contentId, isTestChecked, units, releaseTime,
viewStatus, testDraftStatus, test, isModify, visible
```

- `contentType`: 2=quiz, 3=homework, 6=exam
- `contentId`: 用作 `getOpenHomeworkInfo` 的 `tid` 参数
- `test`: 包含所有状态字段，见 TEST 层

### TEST 层 (node.test)

```
id, releaseTime, type, name, deadline, testTime, trytime,
usedTryCount, evaluateJudgeType, evaluateNeedTrain,
evaluateStart, evaluateEnd, evaluateScoreReleaseTime,
scorePubStatus, enableEvaluation, userScore, totalScore,
bonusScore, examId
```

- `type`: 2=quiz, 3=homework, 6=exam
- `usedTryCount`: >0 = 已提交
- `scorePubStatus`: 0=互评中, 1=窗口关闭, 2=已公布
- `evaluateStart/End`: 互评时间窗口 (ms)
- `evaluateScoreReleaseTime`: 成绩公布时间
- `enableEvaluation`: 是否启用互评
- `evaluateJudgeType`: 1=学生互评, 其他=教师评阅

### getOpenHomeworkInfo.result 层

```
tid, aid, deadline, evaluateStart, evaluateEnd, evaluateJudgeType,
evaluateScoreReleaseTime, name, description, releaseTime,
submitStatus, evaluateNeedTrain, scorePubStatus, duration,
startTime, questionCount, totalScore, allowSwitchPageCount,
switchPageCount
```

- `submitStatus`: null=未打开, 1=草稿, 2=已提交 — **只追作业提交，不追互评完成**
- `aid`: attempt/answer ID
- `startTime`: 用户开始作答时间

---

## SPOC 课程支持

### 问题

SPOC 课程（如大学物理 NEU-1474956162）有**两个 termId**：

| termId | 来源 | 数据量 |
|---|---|---|
| 1476735472 | URL `?tid=` | 89B 空壳 |
| 1476504498 | `window.moocTermDto.id` | 217KB 完整数据 |

### 解决方案

1. `spoc-tid-bridge.js` — web_accessible_resource，通过 `<script src="chrome-extension://...">` 注入页面上下文（MV3 CSP 只允许 chrome-extension:// origin）
2. 页面上下文执行：读 `window.moocTermDto.id` → 写入 `<html data-mooc-real-termid="...">`
3. `main.js` content script 读 DOM 属性 → 获取真实 termId
4. `batchApiFetch` 用真实 termId 调 API

### ⚠️ 关键约束

```javascript
// ✅ 正确：仅 SPOC 课程自身替换 termId
var courseIsSpoc = (c.courseType === 'spoc')
  || (isSpocPage && c.courseId === pageMeta.courseId);

// ❌ 错误：isSpocPage=true 时所有课程都被替换成 SPOC termId
var courseIsSpoc = isSpocPage || (c.courseType === 'spoc');
```

错误写法会导致普通课程的 API 请求用 SPOC 真实 termId，拿到 SPOC 数据但归属到普通课程名下，造成作业重复。

### 涉及文件

- `src/content/spoc-tid-bridge.js` — WAR 脚本，页面上下文读 window.moocTermDto.id
- `src/content/main.js` — init() 注入 bridge → 读 DOM → batchApiFetch 使用真实 termId
- `manifest.json` — spoc-tid-bridge.js 在 web_accessible_resources

---

## 自动检测判定逻辑

### 完成判定表

| 类型 | 条件 | 判定 |
|---|---|---|
| quiz (type:2) | `usedTryCount > 0` | 完成 |
| exam (type:6) | `usedTryCount > 0` | 完成 |
| homework 无互评 | `usedTryCount > 0` | 完成 |
| homework 互评中 (窗口内) | `scorePubStatus:0` + `now < evaluateEnd` | **未完成** |
| homework 互评中 (窗口过期) | `scorePubStatus:0` + `now >= evaluateEnd` | 完成 |
| homework 窗口关闭 | `scorePubStatus:1` | 完成 |
| homework 成绩已公布 | `scorePubStatus:2` | 完成 |

### 互评阶段 (hwPhase)

```javascript
function apiDetectPhase(node) {
  if (node.type !== '3') return null;
  if (!node.enableEvaluation || node.evaluateStart == null) return null;
  const pub = parseInt(node.scorePubStatus, 10) || 0;
  if (pub === 2) return 'results';   // 成绩已公布
  if (pub === 1) return 'results';   // 窗口关闭 → 过期当完成
  const now = Date.now();
  if (now < evaluateStart) return 'submit';
  if (now >= evaluateEnd) return 'results';
  return 'peerreview';               // 互评进行中
}
```

### 互评检测的局限性

**平台 API 不暴露「用户是否完成了互评」的字段。** 

- `submitStatus` (getOpenHomeworkInfo) 只追作业提交，不追互评
- `scorePubStatus: 1` 表示「互评窗口已关闭」，不等于「用户完成了互评」
  - 已验证：SPOC 作业未做互评、窗口过期后 scorePubStatus 仍然是 1

**唯一盲区**：互评窗口内的作业 (scorePubStatus:0)。这个阶段不知道用户是否已提交互评，所以标记为「手动确认」。

### Popup 标签

| 条件 | 标签 |
|---|---|
| 互评窗口内 (scorePubStatus:0 + 窗口内) | `手动确认`(琥珀色) + `互评中`(黄色) |
| 其他所有自动判定 | `自动检测`(绿色) |

---

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
- `scrape_status` — 抓取状态
- `popup_ui_state` — popup UI 状态

### Course 结构
```
{ courseId, termId, activeTermId, courseName, schoolName, courseType, pageUrl }
```
- `courseType`: 'mooc' | 'spoc' | 'manual'
- `courseId`: `{school}-{numericId}` 格式

---

## 关键设计决策

1. **无后端**: 纯浏览器扩展，所有数据在 chrome.storage.local
2. **API 优先**: 主要完成检测基于 API 字段 (userScore, usedTryCount, scorePubStatus)
3. **DOM 爬取**: 可选 fallback，默认关闭 (`domScrapingEnabled: false`)
4. **手动覆盖自动**: 用户手动勾选永远优先于自动检测
5. **SPA 感知**: URL hash 监控 + DOM MutationObserver
6. **SPOC 支持**: WAR 脚本注入 + DOM bridge 读真实 termId
7. **Reconcile 策略**: UID 匹配 → secondary dedup → 保留手动标记 → API 完成状态不回流

---

## 已知限制

- 需要 icourse163.org 标签页打开才能抓取
- 网页 DOM/API 改版可能导致选择器/端点失效
- 不支持跨设备同步 (chrome.storage.local 是设备本地)
- 互评窗口内的作业无法自动判断互评是否完成
- `NTESSTUDYSI` 是 HttpOnly cookie，需 chrome.cookies API 读取
- SW 的 `fetch()` 无法通过 icourse163.org CSRF 认证（origin 不匹配），必须由 content script 发起同源 XHR
- SPOC 页面 `getOpenHomeworkInfo.rpc` 不可用，缺少 submitStatus 补充字段

---

## 开发命令

```bash
# 加载扩展
# chrome://extensions/ → 开发者模式 → 加载已解压的扩展 → 选择项目目录

# Lint
npx eslint src/

# 打包
zip -r mooc-reminder.zip . -x ".*" "node_modules/*" "tests/*" "logs/*"
```

## 相关文档

- `.claude/logs/architecture.md` — 完整架构文档
- `.claude/logs/2026-06-27-development.md` — 最近开发日志（API 字段分析、互评判定、SPOC 支持）
- `.claude/logs/2026-06-26-development.md` — 背景 API 代理、完成检测重写
- `src/content/selectors.json` — DOM 选择器配置
