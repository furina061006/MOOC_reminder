# 更新日志

> 面向用户的版本更新记录，按日期记录可感知的新增、变更和修复。
>
> 本文件位于 `.claude/logs/`，但定位与同目录开发日志不同：开发日志记录「为什么这么做」的实现过程与技术决策，本文件只做版本变更回顾。两者不要互相替代。

## 未发布

- **修复 SPOC 条目跳转错误路由（这一次真正生效）**：点击 SPOC 作业会打开正确的 `/spoc/learn/` 页面，并带上正确的 `?tid=` 路由 ID（此前可能用的是 API ID）。2026-09-18 曾记录过一次「已修复」，但那次只改了运行时并不执行的代码副本，实际点击仍会跳到同名普通 MOOC 课程页。
- **修复 SPOC 课程标题被改成 MOOC 名称**：同名普通 MOOC 的课程链接不再覆盖 SPOC 课程的标题与类型，已确认是 SPOC 的课程不再被降级。
- **升级后请打开一次 SPOC 学习页**：旧作业条目需要借这次访问记录真实课程地址，之后点击即可正确跳转。
- **修复「清理已完成」不持久**：清理后的已完成作业会被记住，后续 API 同步不会再把它们重新写回列表；如果该作业确实重新变为未完成（例如新一轮作答），仍会正常显示。
- **修复手动提醒在同名课程下互相冲突**：手动提醒的唯一 ID 现在包含课程，两门课程即使显示名相同、标题和截止时间也相同，也能各自独立管理。
- **修复课程元数据并发丢失**：课程列表的读写改为串行化，课程发现、SPOC 真实 termId 更新和 API 同步同时发生时不再互相覆盖，避免漏课或 termId 回退。

## 2026-09-04

- **无标签页自动刷新**：已载入普通 MOOC 或 SPOC 课程后，没有现成学习标签页时会创建一个非激活临时代理页，复用 Content Script 批量抓取；完成、超时、关闭或重启后仅清理该临时页。
- **低频后台检查**：后台检查和徽章刷新设置改为小时单位，默认均为 12 小时；打开课程页和浏览器启动仍会触发事件驱动同步。
- **每日摘要补发**：当天首次启动浏览器时，若尚未发送摘要，会立即尝试推送 48 小时内截止或已过期的作业摘要；免打扰时段则在结束后补发。
- **摘要文案调整**：设置页说明改为“每天定时”，不再限定早上。

## 2026-09-01

- **通知资源加载修复**：通知图标统一使用 `chrome.runtime.getURL()` 生成扩展绝对资源 URL，修复 Windows/Chrome 报告 `Unable to download all specified images` 导致通知创建失败的问题。
- **摘要按截止时间排序**：每日摘要始终优先展示最早截止的 3 项，其余以「另有 N 项」汇总；完整作业仍可在 popup 查看。
- **通知诊断完善**：设置页系统反馈显示 Chrome 通知权限、插件开关、免打扰状态、可提醒数量和下次本地检查时间；通知实际由 Chrome 转交 Windows 11 通知中心，系统通知设置仍由用户管理。
- **页面 API hook CSP 修复**：移除 `script.textContent` 内联注入，改用 `web_accessible_resources` 中的外部 `xhr-hook-page.js`，避免 icourse163.org 页面 CSP 阻止 hook 执行。
- **清理临时测试入口**：删除设置页测试通知按钮和 Service Worker 测试通知处理，仅保留生产通知路径与自动化测试。

## 2026-08-16

- **修复「稍后提醒」失效**：snooze 现在会同时清除已通知档位记忆，24h 后同档位会正常再次提醒（此前对已过期条目点一次稍后提醒就永远不再提醒）。
- **修复通知相关一组 bug**：并发写 homework_items 互相覆盖（重复弹/完成状态复活）、点击通知无法跳转（API 条目无 pageUrl，现按课程+类型重建 URL）、每日摘要在免打扰时段命中时当天丢失（改为免打扰结束时自动补发）、设置页关闭全部提醒档位被静默忽略。
- **调度改为事件驱动**：打开任意课程页/启动浏览器即触发全课程刷新（30 分钟节流），周期抓取从 30 分钟放宽到 4 小时兜底，徽章/提醒检查从 5 分钟放宽到 15 分钟——后台唤醒量降至约 1/3，作业数据反而更及时。
- **多标签页去重**：后台抓取只发给最近活跃的一个 MOOC 标签页（此前开 N 个标签页会完整重复抓取 N 遍）。
- **SW 改为 import shared 模块**：删除手工同步的内联副本，通知/调度逻辑提取为可单测的纯函数；新增 25 个单元/集成测试（含直接驱动真实 Service Worker 的集成测试），`npm run validate` 首次全绿。

## 2026-06-28

- **contentType 优先于名字正则**：提取匹配条件改为以 API `contentType`（2=quiz, 3=homework, 6=exam）为主，名字正则仅当 `contentType` 空缺时启用，防止“期末考试”因名字含“测试”被误提取。
- **node.test 统一后备**：所有信号/完成判定字段同时查顶层和 `node.test` 子对象（部分 SPOC 课程字段在 test 内），顶层优先，原值不受影响。
- **完成判定定型**：`score > 0`（有成绩） || `submitted && !inPeerReview`（已提交且互评未卡住）|| `hasCompletedText`（文本标记）；`submitted` 同时认 type:3 和 type:6。
- **考试标签改为手动确认**：考试在 popup 中显示琥珀色「手动确认」标签，完成逻辑不变。
- **SPOC bridge 支持 termDto**：部分 SPOC 课程（如军事理论）使用 `window.termDto.id` 而非 `moocTermDto.id`。
- **SPOC 跨课程污染修复**：`data-mooc-real-termid` 仅在本课程页面时才用于替换 termId。
- **后台刷新用 activeTermId**：`apiRefreshCourse` 使用 `course.activeTermId || course.termId`。
- **Course_UPDATE 携带 courseName**：SPOC 课程名称持久化，修复「未知课程」问题。
- **SPOC 互评作业修复**：`apiDetectPhase` 添加 `node.contentType` 后备（SPOC 数据无 `node.type` 和 `node.test`，类型标识在 `contentType`）。
- **`scorePubStatus:1` 时间检查**：不再看到 1 就直接判定完成，改为先验证 `evaluateEnd` 是否真正到期；到期才判完成，未到期按时间正常判断互评阶段。
- **移除冗余 `scorePubStatus===0` 门控**：`inPeerReview` 和 `phaseDeadline` 中额外检查 `scorePubStatus===0` 导致 `apiDetectPhase` 正确返回 `peerreview` 后被否决，现已移除，直接信任相位检测。
- **`.claude/logs/` 纳入版本管理**：开发日志解除 gitignore，供其他开发者追踪技术决策。

## 2026-06-27

- **互评完成字段完整分析**：dump `getLastLearnedMocTermDto.rpc`（NODE 17 + TEST 19 字段）和 `getOpenHomeworkInfo.rpc`（19 字段），确认 `submitStatus` 仅追作业提交不追互评完成，平台 API 不存在互评完成独立字段。
- **互评判定逻辑定案**：`scorePubStatus:0`+窗口内→未完成+手动确认；`scorePubStatus:1`→窗口关闭→按完成（与平台行为一致）；验证 `scorePubStatus:1` ≠ 用户完成互评（SPOC 未互评但 scorePubStatus=1 的实锤）。
- **互评标签变更**：互评中作业从 `自动检测` 改为琥珀色 `手动确认` + `互评中`。
- **HttpOnly CSRF 适配**：`NTESSTUDYSI` cookie 变为 HttpOnly，改用 `chrome.cookies.get()` 读取。
- **SPOC 作业重复 Bug 修复**：`isSpocPage` 导致所有课程 termId 被替换成 SPOC 真实 termId，修复 courseIsSpoc 判定为仅匹配当前 SPOC 课程。
- **checkPageHookData 修复**：hook 数据仅处理 tid 匹配当前页面的响应，避免跨课程归属。
- **popup 打开自动刷新 toast**：首次初始化自动刷新后也弹「刷新成功·建议再按一次」。
- **删除全部 DOM 抓取代码**：API 已覆盖全部场景，移除 selectors.json、scrapers/、observers/、HOMEWORK_DATA/SCRAPE_NOW 消息、domScrapingEnabled 设置，代码减少 ~3000 行。

## 2026-06-26

- **后台 API 代理抓取**：基于 GinsMooc 逆向分析，content script 代理 API 请求绕过 CSRF 认证，打开任意 MOOC 页面即可刷新全部已知课程。
- **完成检测重写**：API 用 `userScore` + `usedTryCount` + 文本模式检测完成，所有类型统一 `自动检测`。
- **互评阶段 API 检测**：基于 `evaluateStart/End` + `scorePubStatus` 判定 submit/peerreview/results。
- **类型判断修复**：API type 字段优先 + “期末”→exam + 名字去重。
- **popup 自动刷新**：首次打开无数据时自动触发刷新 + 轮询等待。
- **课程静音完善**：静音课程不显示、不计 badge、不计摘要，设置页可管理。
- **摘要错过补发**：开机时检测今日摘要是否错过，自动补发。
- **UI 优化**：删跳转按钮、统一标签、页面跳转按类型路由、反馈邮箱、保存提醒。
- **每日摘要 UI**：补全设置入口（之前代码有但 HTML 漏了）。

## 2026-06-24

- **过期项自动隐藏**：截止后的测验/考试从未完成中消失；过期作业勾选后从界面隐藏。
- **互评阶段优化**：同时显示 `[互评中]` + `[手动确认]` 标签，阶段切换不再丢失。
- **设置页面修复**：保存按钮有加载反馈、失败自动重试、storage 兜底。
- **错误管理**：错误提示可点击 × 关闭 + 设置页底部错误报告区 + 自动清除选项。
- **弹窗自定义**：设置页可独立开关稍后提醒按钮、跳转按钮、课程静音按钮。
- **上下文失效保护**：扩展重载时不再批量刷屏报错。
- **性能优化**：增加加载占位，渲染缓存 Date.now()，popup 打开更快。
