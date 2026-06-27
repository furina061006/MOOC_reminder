# MOOC Reminder

> 中国大学MOOC 作业提醒助手 — 再也不会漏交作业啦！！！
> hiahiahia b(￣▽￣)d　

> <span style="color:red">注:</span>
> 本插件 99.99% 的 代码贡献 依靠 Vibe Coding ~(Claude~ ~Code~ ~+~ ~DeepSeek~ ~API)~

打开 [中国大学MOOC](https://www.icourse163.org/) 完成线上作业时，插件自动爬取「测验与作业」和「考试」板块的未完成作业，在扩展图标上显示数量，点击即可查看清单。

---

## 功能一览

| 功能 | 说明 |
|------|------|
| 🔔 **徽章提醒** | 扩展图标上直接显示未完成作业数量 |
| 🔴🟠🔵 **紧急程度** | 红色=已过期 橙 色=48h内截止 蓝色=正常 |
| 📋 **课程分组** | 按课程分组展示，一目了然 |
| ✅ **自动检测** | 所有类型（测验/作业/考试）均自动检测完成状态 |
| 🏷️ **状态标签** | `自动检测` `互评中` `手动确认` (含考试) |
| 🏫 **SPOC 支持** | 完整支持 SPOC 课程（大学物理等） |
| 🔄 **后台 API 抓取** | 打开任意 MOOC 页面即可刷新全部已知课程的作业数据 |
| 🌙 **深色模式** | 自动适配系统主题 |
| ⚙️ **设置面板** | 检查间隔、提醒阈值、自动检测、免打扰时段、每日汇总、错误报告 |
| 📅 **日历导出** | 一键导出未完成作业为 `.ics` 日历文件 |
| 📝 **手动添加** | 手动添加爬虫漏掉或线下作业提醒 |
| ⏰ **稍后提醒** | 24h 内不再弹通知（徽章仍计数） |
| 🔕 **课程静音** | 静音课程不显示在列表、不计入 badge（数据保留） |
| 🧹 **清理已完成** | 一键移除已完成的作业记录 |
| 🔄 **刷新爬取** | popup 按钮手动刷新，不丢失手动标记 |
| 🗑️ **重置数据** | popup 底部一键清除全部缓存 |
| 🛡️ **崩溃自愈** | 数据损坏时自动恢复界面，一键清除缓存 |
| 💬 **反馈渠道** | popup 和设置页底部点击可直接发邮件 |
| ⏰ **截止提醒** | 48h/24h/过期等多档提醒（可自定义阈值） |
| 📊 **每日摘要** | 每天早上汇总未完成作业推送一条通知 |
| 🕐 **错过补发** | 错过摘要时间后开机自动补发 |

## 徽章颜色说明

| 颜色 | 含义 |
|------|------|
| 🔴 红色 | 存在已过期的未完成作业 |
| 🟠 橙色 | 有作业在 48 小时内截止 |
| 🔵 蓝色 | 正常状态，无紧急项 |

## 安装方法

### 前提
- Chrome / Edge / 夸克等 **Chromium** 内核浏览器

### 步骤

1. 下载项目代码（`git clone` 或下载 ZIP 解压）
2. 打开浏览器扩展管理页 `chrome://extensions/`
3. 开启右上角「开发者模式」
4. 点击左上角「加载已解压的扩展」
5. 选择 `MOOC_reminder` 文件夹

> ⚠️ 本插件未上架 Chrome 网上应用店，需通过「开发者模式」加载。

## 使用方法

```
1. 登录 icourse163.org
2. 打开任意课程页面，插件自动后台抓取全部已知课程
3. 扩展图标显示未完成数量，点击查看详细清单
4. 完成状态自动检测（互评中作业需手动确认）
5. 无需手动操作，打开页面即可
```

### 使用技巧

- **任意路由即可**：不再需要停在「测验与作业」页面，公告页、课件页都能触发全课程刷新
- **API 优先**：后台通过页面代理调 API 获取完整课程结构 + 分数 + 完成状态，覆盖所有类型
- **跳转到作业页**：点击作业标题直接跳转到对应的 testlist / examlist 页面
- **静音不感兴趣的课**：popup 课程标题旁铃铛按钮静音，静音后不显示不计数（设置页可管理）
- **过期项自动隐藏**：未完成的测验/考试/作业截止后自动从未完成中隐藏，仅在「已过期」筛选下可见,
> **已过期且完成**的作业会只留在「全部(含过期)」里

### 筛选功能

popup 左上角可筛选：
- **未完成** — 默认视图
- **已过期** — 只看已过期但仍未完成的作业
- **已完成** — 已自动检测完成的作业
- **全部（含过期）** — 所有作业

> 列表按截止时间从近到远排序，最紧急的课程分组排在最前。点击任意条目可直接打开对应的作业/课程页面。

## 局限性

- ❌ **需要打开课程页面才能抓取** — 插件通过注入到浏览器页面的脚本运行，关掉页面就无新数据。打开任意 MOOC 课程标签页即可触发全课程刷新
- ❌ **仅支持 中国大学MOOC** — 不支持学堂在线、超星等其他平台
- ❌ **不跨设备同步** — 数据存在浏览器本地 `chrome.storage.local`
- ❌ **API 端点改版可能失效** — 如果 中国大学MOOC 更新 API 端点或参数，抓取可能暂时失效
- ❌ **互评完成无法自动检测** — 平台 API 不暴露用户是否实际完成互评的字段，互评中的作业标记为「手动确认」
- ❌ **考试完成无法可靠自动检测** — 考试自动标记为「手动确认」（成绩/提交状态仍正常检测），用户需手动勾选确认    
## 隐私说明

- 所有数据仅存储在**浏览器本地**
- **不会上传**到任何服务器
- **不收集**任何个人信息
- 仅在 中国大学MOOC 页面运行

---

## 反馈建议

如有问题或建议，请发送邮件至 **[zemei.huang@foxmail.com](mailto:zemei.huang@foxmail.com)**

---

## 近期合并的 Pull Request

| PR | 贡献者 | 内容 |
|----|--------|------|
| #9 | puresky271 | 列表可点击跳转，按截止时间排序 |
| #10 | puresky271 | 后台 API 刷新全课程作业追踪 |
| #11 | puresky271 | 设置页面：检查间隔、提醒阈值、免打扰、每日汇总 |
| calendar-digest | puresky271 | 日历导出 `.ics`、手动添加作业、稍后提醒、课程静音、清除已完成 |
| refactor/design-system-icons | puresky271 | 内联 SVG 图标系统，CSS 设计令牌重构 |

## 更新日志

### 2026-06-28

- **contentType 优先于名字正则**：提取匹配条件改为以 API `contentType`（2=quiz, 3=homework, 6=exam）为主，名字正则仅当 `contentType` 空缺时启用，防止"期末考试"因名字含"测试"被误提取
- **node.test 统一后备**：所有信号/完成判定字段同时查顶层和 `node.test` 子对象（部分 SPOC 课程字段在 test 内），顶层优先，原值不受影响
- **完成判定定型**：`score > 0`（有成绩） || `submitted && !inPeerReview`（已提交且互评未卡住）|| `hasCompletedText`（文本标记）；`submitted` 同时认 type:3 和 type:6
- **考试标签改为手动确认**：考试在 popup 中显示琥珀色「手动确认」标签，完成逻辑不变
- **SPOC bridge 支持 termDto**：部分 SPOC 课程（如军事理论）使用 `window.termDto.id` 而非 `moocTermDto.id`
- **SPOC 跨课程污染修复**：`data-mooc-real-termid` 仅在本课程页面时才用于替换 termId
- **后台刷新用 activeTermId**：`apiRefreshCourse` 使用 `course.activeTermId || course.termId`
- **Course_UPDATE 携带 courseName**：SPOC 课程名称持久化，修复「未知课程」问题

### 2026-06-27

- **互评完成字段完整分析**：dump `getLastLearnedMocTermDto.rpc` (NODE 17 + TEST 19 字段) 和 `getOpenHomeworkInfo.rpc` (19 字段)，确认 `submitStatus` 仅追作业提交不追互评完成，平台 API 不存在互评完成独立字段
- **互评判定逻辑定案**：`scorePubStatus:0`+窗口内→未完成+手动确认；`scorePubStatus:1`→窗口关闭→按完成（与平台行为一致）；验证 `scorePubStatus:1` ≠ 用户完成互评（SPOC 未互评但 scorePubStatus=1 的实锤）
- **互评标签变更**：互评中作业从 `自动检测` 改为琥珀色 `手动确认` + `互评中`
- **HttpOnly CSRF 适配**：`NTESSTUDYSI` cookie 变为 HttpOnly，改用 `chrome.cookies.get()` 读取
- **SPOC 作业重复 Bug 修复**：`isSpocPage` 导致所有课程 termId 被替换成 SPOC 真实 termId，修复 courseIsSpoc 判定为仅匹配当前 SPOC 课程
- **checkPageHookData 修复**：hook 数据仅处理 tid 匹配当前页面的响应，避免跨课程归属
- **popup 打开自动刷新 toast**：首次初始化自动刷新后也弹「刷新成功·建议再按一次」
- **删除全部 DOM 抓取代码**：API 已覆盖全部场景，移除 selectors.json、scrapers/、observers/、HOMEWORK_DATA/SCRAPE_NOW 消息、domScrapingEnabled 设置，代码减少 ~3000 行

### 2026-06-26

- **后台 API 代理抓取**：基于 GinsMooc 逆向分析，content script 代理 API 请求绕过 CSRF 认证，打开任意 MOOC 页面即可刷新全部已知课程
- **完成检测重写**：API 用 `userScore` + `usedTryCount` + 文本模式检测完成，所有类型统一 `自动检测`
- **互评阶段 API 检测**：基于 `evaluateStart/End` + `scorePubStatus` 判定 submit/peerreview/results
- **类型判断修复**：API type 字段优先 + "期末"→exam + 名字去重
- **popup 自动刷新**：首次打开无数据时自动触发刷新 + 轮询等待
- **课程静音完善**：静音课程不显示、不计 badge、不计摘要，设置页可管理
- **摘要错过补发**：开机时检测今日摘要是否错过，自动补发
- **UI 优化**：删跳转按钮、统一标签、页面跳转按类型路由、反馈邮箱、保存提醒
- **每日摘要 UI**：补全设置入口（之前代码有但 HTML 漏了）

### 2026-06-24

- **过期项自动隐藏**：截止后的测验/考试从未完成中消失；过期作业勾选后从界面隐藏
- **互评阶段优化**：同时显示 `[互评中]` + `[手动确认]` 标签，阶段切换不再丢失
- **设置页面修复**：保存按钮有加载反馈、失败自动重试、storage 兜底
- **错误管理**：错误提示可点击 × 关闭 + 设置页底部错误报告区 + 自动清除选项
- **弹窗自定义**：设置页可独立开关稍后提醒按钮、跳转按钮、课程静音按钮
- **上下文失效保护**：扩展重载时不再批量刷屏报错
- **性能优化**：增加加载占位，渲染缓存 Date.now()，popup 打开更快

## 贡献者

- [@furina061006](https://github.com/furina061006) — 项目发起人，核心开发
- [@puresky271](https://github.com/puresky271) — 桌面通知、设置页面、日历导出、SVG 图标、全课程追踪、CI/CD、测试

---

## 原理 & 技术栈（给开发者）

### 工作原理

```
用户打开中国大学MOOC课程页面
  → Content Script 注入
    → chrome.cookies.get() 读取 NTESSTUDYSI (HttpOnly cookie)
    → 同源 XHR 调 getLastLearnedMocTermDto.rpc
    → 拿到完整课程 DTO（全部章节+作业+考试+分数+截止日期+互评状态）
    → getOpenHomeworkInfo.rpc 获取 submitStatus 等补充字段
  → SPOC: 读 window.moocTermDto.id / window.termDto.id 获取真实 termId（URL tid 是假壳）
  → 数据发送到 SW → reconcile → storage
  → Badge 更新 + 截止提醒检查
→ 点击图标 → Popup 展示
```


> 📖 详细架构 → [architecture.md](.claude/logs/architecture.md)

### 技术栈

| 技术 | 用途 |
|------|------|
| Manifest V3 | Chrome 扩展最新标准 |
| 原生 JavaScript | 零框架，轻量高效 |
| chrome.storage.local | 本地持久化存储 |
| chrome.notifications | 桌面通知 |
| XMLHttpRequest | 同源 API 调用（绕过 CSRF） |
| content script proxy | 页面上下文代理 API 请求 |

### 项目结构

```
MOOC_reminder/
├── manifest.json           # 扩展清单
├── src/
│   ├── background/         # Service Worker（alarms、协调、badge、通知）
│   ├── content/            # 页面注入脚本（API 代理 + SPOC 支持）
│   ├── popup/              # 弹出窗口（HTML/CSS/JS）
│   └── shared/             # 共享模块（数据模型、存储、API 解析、设置）
├── .claude/logs/           # 开发日志
└── README.md
```

### API 抓取流程

```
SW alarm / 手动刷新
  ↓ 发送 BATCH_API_FETCH {courses: [...]}
Content Script（icourse163.org 同源）
  ↓ chrome.cookies.get({name:'NTESSTUDYSI'}) → HttpOnly CSRF
  ↓ XHR → getLastLearnedMocTermDto.rpc?csrfKey=xxx
  ↓ 浏览器自动附带 icourse163.org cookies
  ↓ 返回 200KB+ 完整课程 DTO（作业+考试+分数+互评阶段）
  ↓ 辅助: getOpenHomeworkInfo.rpc → submitStatus 等补充字段
  ↓ SPOC: window.moocTermDto.id → 真实 termId（替换 URL 假 tid）
  ↓ COURSE_API_DATA → SW
SW
  ↓ apiExtractHomework() 解析 → 基于 scorePubStatus + usedTryCount + userScore
  ↓ reconcileHomeworkData() 合并（UID 匹配 dedup）
  ↓ updateBadgeFromStorage()
```
