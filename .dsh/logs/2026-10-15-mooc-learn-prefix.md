# 2026-10-15 支持普通 MOOC 的新路径 `/mooc/learn/`

用户报：普通 MOOC 的课程页路径从 `https://www.icourse163.org/learn/{课程号}?tid=…` 变成
`https://www.icourse163.org/mooc/learn/{课程号}…` 之后，这些课程抓不到。

**范围（与用户确认后）**：先让普通 MOOC 的抓取多认一条 `mooc/learn` 路径。SPOC 的
`/spoc/learn/…` 没有变化。抓取恢复后，同一天又补上了"点击也按课程自己的路径走"（见第 4 节）。

---

## 1. 断在哪两处

平台更新架构、换了课程页路径之后，插件里有两处"路径清单"没跟上，缺一处都抓不到：

1. `manifest.json` 的两个 content script（`main.js`、`xhr-hook.js`）只匹配 `/learn/*` 与
   `/spoc/learn/*` —— 新路径不匹配，页面里**根本没有插件代码**；
2. SW 的 `LEARN_TAB_URLS` 同样没有新路径 —— 就算页面能应答，它也**永远不会被选去抓取**，
   每轮刷新都会退化成"新建临时代理页 + 旧地址"。

另外一处"看起来像 bug、其实不是"的地方值得记下来：`course-discovery.js` 的 `isLearnPage()`
正则不带锚点，所以新路径**本来就被判成学习页**，于是它按设计完全退出（不采集锚点、也不应答探测）；
而 main.js 又没被注入 —— 这个页面于是成了"装作有人负责、实际没人负责"的真空，排查时最容易被
误判成"API 挂了"。

好消息：`parseCourseUrl` / `parseLearnHref` / `isIcCourseLearnUrl` 三处解析都取
**`learn/` 之后那一段**当课程 key，所以新路径**天然解析正确**，一行解析逻辑都不用改。

## 2. 改动清单（抓取）

| 文件 | 改动 |
| --- | --- |
| `manifest.json` | 两个 learn content script 的 matches 加 `https://www.icourse163.org/mooc/learn/*` |
| `src/background/service-worker.js` | `LEARN_TAB_URLS` 加同一模式（并把与 manifest 的耦合关系写在旁边） |
| `src/content/main.js` | 头注释、`parseCourseUrl` 与「SPOC 只由 `/spoc/` 前缀证明」的说明 |
| `src/content/course-discovery.js` | `isLearnPage()` 把三条学习路径显式写出来（行为与旧写法等价） |
| `src/shared/icourse163-api.js` | `parseLearnHref` 文档说明覆盖三种路径 |
| `tests/unit/manifest.test.mjs` | main.js matches 期望值 + xhr-hook 与 main 同集合 + `LEARN_TAB_URLS` 反方向守卫 |
| `tests/unit/homework-model.test.mjs` | `parseCourseUrl` 的新路径用例 |
| `tests/unit/icourse163-api.test.mjs` | `parseLearnHref` 的新路径用例 |
| `tests/unit/service-worker.integration.test.mjs` | 新路径标签页被视为"课程页自报"（名字权威），而不是弱锚点采集 |

**为什么 `LEARN_TAB_URLS` 也算"抓取路径"**：它决定哪些标签页可以被 SW 选中执行抓取。
只改 manifest 的话，页面能应答探测、却凑不进候选，刷新永远走临时代理页 ——
所以两处必须一起改，`tests/unit/manifest.test.mjs` 现在双向锁住这个耦合。

## 3. 刻意**没有**动的东西

- **SPOC 判定**：`isSpoc` 仍只看 `/spoc/` 前缀（不变量 9）。SPOC 路径未变，所以不允许用
  "真实 term 与路由 term 不同"之类推理去升级 SPOC 证据 —— 那会让普通 MOOC 被误判成 SPOC。
- **数据源**：仍在页面上发同源 XHR 抓取，抓取逻辑一行未改。
- **`isIcCourseLearnUrl` 的正则**：它一直不锚定，因此本来就接受新路径；收紧它是另一次改动
  （有自己的风险面），本次只补注释说明。

## 4. 后续：点击也按课程自己的路径走

抓取恢复后补上了原本缓办的那半件事。做法不是"猜哪门课属于新路径"，而是**记住用户真实打开过的那条**：

- **课程页自报它此刻所在的地址**：`main.js` 的 `COURSE_LINKS` 带上 `routeUrl`，SW 校验后冻结成
  `course.pageUrl`。于是点击这门课回到同一族路由 —— 旧路径的课跳旧地址，新路径的课跳新地址。
  **临时代理页的自报被排除**：它的地址是插件自己拼的旧路由，允许它写会把用户真实打开过的新地址
  覆盖回去。
- **老条目也能享受**：`resolveItemUrl(item, courseType, coursePageUrl)` 增加第三个参数，
  popup 与通知点击都传课程记录里冻结的那条路由；没有它，升级前存下的条目只会回到旧地址。
- **栏目位置分两族**：旧路由的栏目在 `#/learn/…` hash 里（按条目类型重写 hash）；新路由的栏目在
  **path** 里（`/mooc/learn/{id}/assessments` = 测验/作业、`/mooc/learn/{id}/exams` = 考试）→
  把课程 key 之后的路径**替换**成对应栏目。**不能"原样打开"**：冻结下来的地址常常是
  `content`（课程内容页），那会让作业/考试都点到内容页上。
- **防重**：课程身份仍只按 `courseId`（不变量 11），作业 uid 只含 `courseId`+`termId`，都与路由
  无关。同一门课在新旧路径下各上报一次仍然只有一条记录（只是 `pageUrl` 更新为最近打开的那条），
  抓取条目也只按 termId 生成一份，不会新旧各抓一遍、也不会重复计数。
- 涉及文件：`src/content/main.js`、`src/background/service-worker.js`（COURSE_LINKS /
  通知点击 / `buildTemporaryProxyUrl`）、`src/shared/item-url.js`、`src/popup/popup.js`（镜像）、
  `tests/unit/item-url.test.mjs`、`tests/unit/service-worker.integration.test.mjs`。

## 5. 验证

- `npm run validate`：lint 0 error（未新增 warning），154 个单测全绿（含本次新增断言）。
- **真机**：用户确认"完全可用"——重载扩展并刷新课程页后，新路径下的作业照常抓取。
  （点击跳转的真机确认：待用户按新路径打开一次课程页后再点条目复核。）

## 6. 遗留

- 新架构把栏目放进网址路径后，幽灵课程守卫（`isContentDetailHref`）只查 `#` 后面的部分：
  `backlog.md`（无证据前不动）。
