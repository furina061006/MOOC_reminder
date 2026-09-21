# SPOC 课程支持

> 入口索引与工作约定在仓库根目录 [`AGENTS.md`](../../AGENTS.md)；本文件是 `.dsh/agents/` 知识库的一部分。

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

### SPOC 变量名差异

不同 SPOC 课程将真实 termId 暴露在不同 window 变量上：

| 变量名 | 示例课程 |
|---|---|
| `window.moocTermDto.id` | 大学物理 NEU-1474956162 |
| `window.termDto.id` | 军事理论 NEU-1002713003 |

`spoc-tid-bridge.js` 和 `xhr-hook.js` 的 `captureRealTermId()` 均按优先级检查两者。

### SPOC 排查思路（新课程抓不到时）

当某个 SPOC 课程在 bridge 中没有输出 `real termId` 时：

1. **在 SPOC 学习页面 Console 检查**：
   ```js
   window.moocTermDto           // 是否存在？
   window.termDto               // 是否存在？
   Object.keys(window).filter(k => /mooc|term|TermDto/i.test(k))  // 找其他候选
   ```

2. **找含 termId 的页面变量**：遍历上一步输出的列表，看哪个对象有 `.id` 属性且值是数字
3. **确认真实 termId**：打开 Network 标签过滤 `rpc`，刷新页面看页面自身 API 请求中的 `termId` 参数值
4. **更新 bridge**：在 `spoc-tid-bridge.js` 和 `xhr-hook.js` 中加入新变量名

### 点击跳转目标（SPOC 路由 URL）

**症状**：popup 里点 SPOC 作业，打开的是同名普通 MOOC 课程页；过一会儿课程标题也从 SPOC 名变成 MOOC 名。

**根因（三层叠加，2026-09 修复）**：

1. `course.pageUrl` 曾有读取点（`buildTemporaryProxyUrl`、extractor）却**零写入点**，所以 `resolveItemUrl` 的 pageUrl 分支是死的，永远退回按 `courseType` 拼 URL
2. SW 内联的 `apiExtractHomework` 漏了 `courseType` 字段（shared 副本有），条目无法自证路由类型，只能依赖课程记录
3. `upsertCourse` 只按 `courseId` 建索引，而 **SPOC 与同名 MOOC 共享同一个 `courseId`**；`course-discovery.js` 把任何不含 `/spoc/` 的 href 判为 `'mooc'`，于是普通 `/learn/` 链接会把 SPOC 记录浅合并覆盖掉

**修复规则**：

| 规则 | 位置 |
|---|---|
| SPOC 页把 `window.location.href` 作为 `routeUrl` 上报 → 冻结为 `course.pageUrl` | `main.js` → `COURSE_UPDATE` |
| `activeTermId` 存在即证明是 SPOC（只由真实 SPOC 页写入） | `isProvenSpocCourse()` |
| 已证明 SPOC 的课程**整条拒绝**弱 `'mooc'` patch（含 termId/name） | `upsertCourse` |
| 抓取时用存储记录补 `pageUrl` 与有效 `courseType` | `resolveCourseForExtraction()` |
| 条目继承 `pageUrl`，`resolveItemUrl` 优先用它（前缀与 `tid` 都来自真实 URL） | `apiExtractHomework` / `item-url.js` |
| reconcile **不写** `pageUrl` 和 `termId`（见不变量 10） | `reconcileHomeworkData` |

**为什么必须用真实 URL 而不是拼**：SPOC 的 `item.termId` 是 **API id**（如 1476504498），而路由 `?tid=` 需要 **路由壳 id**（如 1476735472）。前缀与 `tid` 只有用户浏览器真实打开过的那个 URL 能同时给对，所以 `resolveItemUrl` 的 pageUrl 优先级最高。**旧数据恢复**：升级后打开一次 SPOC 课程页即可冻结正确的 `pageUrl`。

### 涉及文件

- `src/content/spoc-tid-bridge.js` — WAR 脚本，页面上下文读 window.moocTermDto.id
- `src/content/xhr-hook.js` — document_start 注入外部页面 hook
- `src/content/xhr-hook-page.js` — 页面上下文捕获 API 响应和真实 termId
- `src/content/main.js` — init() 注入 bridge → 读 DOM → batchApiFetch 使用真实 termId
- `manifest.json` — bridge 和 xhr-hook-page.js 在 web_accessible_resources

---
