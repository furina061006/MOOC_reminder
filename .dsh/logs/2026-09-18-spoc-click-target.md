# SPOC 作业点击跳转到普通 MOOC 页 — 排查与修复

日期：2026-09-18
分支：`dsh`
backlog 条目：`点击popup界面的spoc作业title，跳转到的课程页面是普通课程的`

## 症状

popup 里点 SPOC 作业（大学物理 NEU-1474956162），打开的是**同名普通 MOOC 课程页**。
用户补充的关键观察：*「原本抓取的是大学物理 spoc，但是过一会看标题就变成普通大学物理 mooc」* ——
标题会自己翻转，说明不是单纯的 URL 拼接问题，而是**课程记录被改写了**。

## 为什么 2026-09-18 的「修复」没生效

`c5293fe`（"fix: resolve open backlog issues", 2026-09-18）的 commit message 声称：

> SPOC item clicks now use /spoc/learn/: resolveItemUrl takes the course type,
> **API items persist courseType**, and the popup/SW look up the Course record…

但实际上：

```
$ git show c5293fe -- src/shared/icourse163-api.js | grep courseType
+          courseType: course.courseType || '',        ← 加到了 shared 副本

$ git show c5293fe -- src/background/service-worker.js | grep courseType
（只有 resolveItemUrl 那几行，extractor 完全没碰）      ← 运行时副本没改
```

**`src/shared/icourse163-api.js` 是有单测、但运行时根本不执行的副本。** 真正处理
`COURSE_API_DATA` 的是 SW 里内联的 `apiExtractHomework`。往 shared 副本加字段，
运行时行为零变化 —— 那次修复是**空转的**。这是本次排查最有价值的结论：
**「改了 shared 副本」不等于「改了行为」**，见 CLAUDE.md 不变量 12。

## 根因：三层缺陷叠加

### 第 1 层：`course.pageUrl` 有读取点、零写入点

`resolveItemUrl` 的策略是「有 `item.pageUrl` 就用它，只修 hash；没有才按 `courseType` 拼」。
而 API 条目的 `pageUrl` 来自 `course.pageUrl`：

```
src/shared/icourse163-api.js:299          pageUrl: course.pageUrl || ''
src/background/service-worker.js:1711     pageUrl: course.pageUrl || ''
```

但 grep 全部 `src/`，`course.pageUrl` **只有读取点**（`buildTemporaryProxyUrl`、extractor），
**没有任何写入点**。`COURSE_LINKS`、`COURSE_UPDATE`、reconcile 的 `upsertCourse(courseMeta)`
都不带 pageUrl。于是 `item.pageUrl` 恒为 `''` → **pageUrl 分支是死代码** → 永远退回
按 `courseType` 拼 URL。

> 也就是说：**管线从头到尾是通的，只缺一个写入点。** 这种缺陷最难发现，因为每一段代码
> 单独看都「正确」。

### 第 2 层：运行时 extractor 漏了 `courseType`

两份拷贝漂移：

| 位置 | `courseType` |
|---|---|
| `src/shared/icourse163-api.js:287`（有单测，**不运行**） | ✅ |
| `src/background/service-worker.js:1701`（**实际运行**） | ❌ 没有 |

所以 `resolveItemUrl(item, courseType)` 里 `item.courseType` 的兜底
（`popup.js:532`、`item-url.js:28`）对 API 条目**永远失效**，条目无法自证路由类型，
只能完全依赖课程记录。

### 第 3 层：课程记录只按 `courseId` 建索引，SPOC 身份会被降级

```
service-worker.js:1496   const idx = courses.findIndex(c => c.courseId === course.courseId);
service-worker.js:1499   courses[idx] = { ...courses[idx], ...course, lastSeen };
```

`courses` 是 **一门课一条记录（键 = `courseId`）**。而 SPOC 课程与同名普通课程
**共享同一个 `courseId`**（`NEU-1474956162`）。同时 `course-discovery.js:56`：

```js
courseType: meta.isSpoc ? 'spoc' : 'mooc'      // 任何不含 /spoc/ 的 href → 'mooc'
```

于是「我的课程」页面上那个普通 `/learn/NEU-1474956162?tid=...` 链接会把 SPOC 记录
**浅合并覆盖**掉 `courseType`、`courseName` 和 `termId`。这正好解释了「过一会标题
变成普通大学物理 mooc」：popup 课程分组标题取自 `course.courseName`（`popup.js:588`），
分组键是 `courseId`（`popup.js:501`），两者都被这次覆盖命中。

### 完整因果链

```
普通 /learn/ 链接被 course-discovery 采集（弱信号 courseType:'mooc'）
  → upsertCourse 按 courseId 浅合并 → SPOC 记录的 courseType/courseName 被降级
  → resolveItemUrl 拿到 courseType='mooc'
  → 且 item.pageUrl 恒为 ''（pageUrl 从没人写）
  → 只能拼 https://www.icourse163.org/learn/... → 打开普通 MOOC 页 ✗
```

## 支点：为什么 `activeTermId` 是可靠证据

排查中发现一个**碰撞免疫**的事实：

- `activeTermId` **只由 `COURSE_UPDATE` 写入**（`service-worker.js:319`）
- `COURSE_UPDATE` 只在 `main.js` 检测到真实 SPOC 页时发送
  （`main.js:86` `if (spocMeta.isSpoc && spocMeta.courseId)`）

所以 **`activeTermId` 存在 ⟺ 用户真的打开过这门课的 SPOC 页面**。无论弱采集怎么覆盖
`courseType`，这个字段都不会被写坏。整个修复都建立在这个不变量上。

## 修复

| # | 改动 | 位置 |
|---|---|---|
| F1 | SPOC 页上报 `routeUrl` = `window.location.href`，SW 校验后冻结为 `course.pageUrl` | `main.js`、`COURSE_UPDATE`、新增 `isIcCourseLearnUrl()` |
| F2 | 运行时 extractor 补 `courseType`（与 shared 副本对齐）；`buildApiCourseList` 用 `activeTermId ? 'spoc' : courseType` 推导有效类型 | `apiExtractHomework`、`buildApiCourseList` |
| F3 | SPOC 粘性：已证明 SPOC 的课程**整条拒绝**弱 `'mooc'` patch | `upsertCourse` + `isProvenSpocCourse()` / `isWeakMoocPatch()` |
| F4 | SPOC 证据优先级统一到 `activeTermId`：popup `courseTypeFor`、通知点击、`getProxyRouteTermId` | `popup.js`、`service-worker.js` |
| F5 | SW 侧权威解析点击目标：`resolveCourseForExtraction()` 用存储记录补 `pageUrl` 与有效 `courseType` | `COURSE_API_DATA` |
| F6 | reconcile **不写** `pageUrl` 和 `termId` | `reconcileHomeworkData` |

### 为什么 F1 用真实 URL 而不是拼

SPOC 有**两个 termId**（见 CLAUDE.md）：路由壳 `1476735472`（URL `?tid=`）与
API id `1476504498`（`window.moocTermDto.id`）。而 `item.termId` 是**抓取用的 API id**
（`buildApiCourseList` 用 `activeTermId`）。

所以即使把 `courseType` 修对，拼出来的也是
`/spoc/learn/NEU-1474956162?tid=1476504498` —— **前缀对、`tid` 是 API id**。
CLAUDE.md 明确写着路由与 API payload 的 termId「两者不可混用」。

**前缀与 `tid` 只有「用户浏览器真实打开过的那个 URL」能同时给对**，所以让它以最高
优先级参与解析，两个未知数一次性消灭，不需要猜哪个 id 才是路由壳。

### F6 为什么必要（一个差点被漏掉的连带缺陷）

`reconcileHomeworkData` 会把 `msg.course` 的字段浅合并进课程记录，而 `msg.course.termId`
是**抓取用的 termId**（SPOC 下 = `activeTermId` = API id）。它会把 `COURSE_LINKS` 采集到的
**路由 termId 覆盖成 API id**，从而毁掉 `?tid=`。

修掉它还有额外收益：即使 `pageUrl` 还没冻结，`courseType` + 路由 `termId` 也能拼出**正确**的
SPOC URL，恢复路径不必依赖重新抓取。

安全性依据：`buildApiCourseList` 与 `apiRefreshAllKnownCourses` 都**从已存储课程派生**，
所以 reconcile 永远不会凭空创建课程 —— 不同步 `termId`/`pageUrl` 不会丢数据。

## 考虑过但否决的方案

| 方案 | 否决原因 |
|---|---|
| 只改 `resolveItemUrl` 的优先级（让 `item.courseType` 压过传入的 courseType） | 治标。`item.courseType` 也是从被降级的记录带出来的；且会推翻既有测试 `explicit courseType wins over a stale item.courseType` 的设计意图 |
| 把 `courses` 改成按 `courseId + courseType` 建索引，让 SPOC 与 MOOC 并存 | 改动面大（popup 分组、按 courseId 静音、UID、文档全都要动），且用户预期是「这就是那门 SPOC 课」，SPOC 优先即可。已记入已知限制 |
| 让 `course-discovery` 自己判断 href 的 SPOC 归属 | 它只能看到 href，`/learn/` 链接本身没撒谎；缺的是「这个 courseId 另有 SPOC 版本」的信息，而那属于 Course 记录 |
| 把 SW 的 extractor 改成 import shared 模块（彻底消灭漂移） | **方向正确但本次不做**：两份拷贝已多处漂移（`DEADLINE_FIELDS` 含不含 `evaluateEnd`、SCORE_FIELDS 优先级不同），直接切换会改变完成判定行为，需要单独一轮验证。本次只对齐 `courseType` 一个字段 |

## 验证

- `npm run validate`：eslint 0 error，**85/85 测试通过**（基线 81 + 新增 4）
- 新增回归测试：
  - `item-url.test.mjs` — 已存 SPOC 路由 URL 压过被降级的 `courseType`（`pageUrl` 契约）
  - `service-worker.integration.test.mjs` — 端到端：`COURSE_UPDATE` 冻结 URL → 弱 MOOC 采集**不能**降级记录 → API 同步后条目带对 `courseType`/`pageUrl` 且路由 `termId` 未被覆盖 → 点击落到 `/spoc/learn/...?tid=<路由壳>`
  - `service-worker.integration.test.mjs` — `BATCH_API_FETCH` 在被降级的 `courseType` 下仍从 `activeTermId` 推导出 `spoc`
  - `service-worker.integration.test.mjs` — 非法 `routeUrl`（外域）不被写入

**未能完成**：浏览器 E2E 实测。本机没有浏览器二进制、没有 playwright/browser-use/selenium、
没有 Chrome profile 与调试端口，自动化实测无法进行。真实点击路径由上述集成测试覆盖
（stub `chrome.*` 后 import 真实 SW 模块，驱动真实消息与通知点击处理器），但**仍需用户在
真实浏览器里确认一次**。

## 升级后的恢复步骤（重要）

旧条目（`pageUrl: ''`）需要一次同步才会带上 `pageUrl`：

1. 重载扩展
2. **打开一次 SPOC 课程学习页** —— 这一步冻结真实路由 URL
3. popup 点任意 SPOC 作业，确认落到 `/spoc/learn/...`

## 遗留 / 后续

- **两份 extractor 拷贝仍未合并**（不变量 12）。这是本次 bug 的温床，建议单独排期改成
  `import`（settings 已有成功先例），但必须先逐字段核对行为差异并补测试。
- **`courses` 仍是 `courseId` 单键**：同一 `courseId` 的 MOOC 与 SPOC 无法并存（不变量 11）。
  若将来真需要并存，得引入复合键并同步改 popup 分组与静音逻辑。
- `course-discovery` 的弱 `courseType` 仍是唯一信息来源之一；粘性规则已经兜住了「降级」，
  但「首次就把 SPOC 课认成 mooc」仍只能等用户打开一次 SPOC 页来纠正。
