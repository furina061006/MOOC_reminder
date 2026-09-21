# MOOC Reminder

> 中国大学MOOC 作业提醒助手
>
> 再也不会漏交作业啦！
>
> hiahiahia b(￣▽￣)d

> [!NOTE]
> 本插件 99.99% 的代码贡献依靠 Vibe Coding（Claude Code / deepseek harness + DeepSeek API）。

打开 [中国大学MOOC](https://www.icourse163.org/) 完成线上作业时，插件自动爬取「测验与作业」和「考试」板块的未完成作业，在扩展图标上显示数量，点击即可查看清单。

> [!TIP]
> 遇到问题或想提建议？→ **[新建 Issue](https://github.com/furina061006/MOOC_reminder/issues/new/choose)**（有模板，会问你要日志）。
> 提交之前请先做一次「在 `chrome://extensions` 重新加载扩展 **+** 刷新已打开的课程页面」——大部分「抓不到」都是漏了这一步。

## 功能一览

| 功能 | 说明 |
| --- | --- |
| 🔔 **徽章提醒** | 扩展图标上直接显示未完成作业数量 |
| 🔴🟠🔵 **紧急程度** | 红色=已过期，橙色=48h内截止，蓝色=正常 |
| 📋 **课程分组** | 按课程分组展示，一目了然 |
| ✅ **自动检测** | 所有类型（测验/作业/考试）均自动检测完成状态 |
| 🏷️ **状态标签** | `自动检测`、`互评中`、`手动确认`（含考试） |
| 🏫 **SPOC 支持** | 完整支持 SPOC 课程（大学物理等） |
| 🔄 **后台 API 抓取** | 已载入课程可通过现有学习页或临时非激活代理页刷新全部已知课程数据 |
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
| 📊 **每日摘要** | 每天定时汇总未完成作业推送一条通知；当天首次启动浏览器时补发临期摘要 |
| 🕐 **错过补发** | 错过摘要时间后开机自动补发 |

## 徽章颜色说明

| 颜色 | 含义 |
| --- | --- |
| 🔴 红色 | 存在已过期的未完成作业 |
| 🟠 橙色 | 有作业在 48 小时内截止 |
| 🔵 蓝色 | 正常状态，无紧急项 |

## 安装方法

### 前提

> [!IMPORTANT]
> 本插件适用于 Chrome、Edge、夸克等 **Chromium** 内核浏览器。

### 步骤

1. 打开 [Releases 页面](https://github.com/furina061006/MOOC_reminder/releases/latest)，下载最新版的 `mooc-reminder-v*.zip` 并解压。
2. 打开浏览器扩展管理页：`chrome://extensions/`。
3. 开启右上角「开发者模式」。
4. 点击左上角「加载已解压的扩展」。
5. 选择解压出来的 `MOOC_reminder` 文件夹。

> [!WARNING]
> 本插件未上架 Chrome 网上应用店，需通过「开发者模式」加载。
>
> 也正因为是「开发者模式」加载，**Chrome 不会自动更新本插件**。插件会在后台检查新版本（默认每 12 小时一次），发现新版本时弹出通知，你也可以在设置页的「更新」区块手动检查并一键前往下载。升级时按上面的步骤重新下载解压、并在扩展管理页点一下「刷新」即可，作业数据不会丢失。
>
> 如果不想让插件联网检查更新，可在设置页关闭「自动检查更新」——关闭后插件不会发出任何外部请求。

## 使用方法

1. 登录[中国大学MOOC](https://www.icourse163.org/)。
2. 打开想要追踪的课程学习页，让插件保存课程路由。
3. 扩展图标显示未完成数量，点击查看详细清单。
4. 后续刷新会复用现有课程页；没有课程页时会短暂创建非激活代理页后自动关闭。
5. 完成状态自动检测（互评中作业需手动确认）。

### 使用技巧

- **任意路由即可**：不再需要停在「测验与作业」页面，任意 mooc 页面**都**能触发全课程刷新（打开页面即刷新，30 分钟内不重复；另有 12 小时周期兜底）。
- **无需常驻课程标签页**：首次载入过课程后，周期或手动刷新会在没有学习页时短暂创建一个非激活代理页，完成或超时后自动关闭。
- **API 优先**：后台通过页面代理调 API 获取完整课程结构 + 分数 + 完成状态，覆盖所有类型。
- **跳转到作业页**：点击作业标题直接跳转到对应的 testlist / examlist 页面。
- **静音不感兴趣的课**：popup 课程标题旁铃铛按钮静音，静音后不显示不计数（设置页可管理）。
- **过期项自动隐藏**：未完成的测验/考试/作业截止后自动从未完成中隐藏，仅在「已过期」筛选下可见。

  > **已过期且完成**的作业会只留在「全部(含过期)」里。

### 筛选功能

popup 左上角可筛选：

- **未完成** — 默认视图
- **已过期** — 只看已过期但仍未完成的作业
- **已完成** — 已自动检测完成的作业
- **全部（含过期）** — 所有作业

> [!TIP]
> 列表按截止时间从近到远排序，最紧急的课程分组排在最前。点击任意条目可直接打开对应的作业/课程页面。

## 局限性

- **首次仍需载入课程页面**：插件需要已登录的同源页面和已保存课程路由。首次打开任意 MOOC/SPOC 学习页后，后续刷新可自动创建临时非激活代理页；登录失效或页面无法加载时会超时失败。
- **仅支持中国大学MOOC**：不支持学堂在线、超星等其他平台。
- **不跨设备同步**：数据存在浏览器本地 `chrome.storage.local`。
- **API 端点改版可能失效**：如果中国大学MOOC 更新 API 端点或参数，抓取可能暂时失效。
- **互评完成无法自动检测**：平台 API 不暴露用户是否实际完成互评的字段，互评中的作业标记为「手动确认」。
- **考试完成无法可靠自动检测**：考试自动标记为「手动确认」（成绩/提交状态仍正常检测），用户需手动勾选确认。

## 隐私说明

> [!NOTE]
> 所有数据仅存储在**浏览器本地**，不会上传到任何服务器，也不收集任何个人信息。

- 仅在中国大学MOOC 页面运行

## 反馈建议

**优先用 Issues**——可以搜到别人提过的问题，也能看到处理进度。模板会引导你附上插件版本、浏览器版本、`[MOOC Reminder]` 日志和诊断输出；信息给够通常一轮就能定位。

- 🐞 [Bug 报告](https://github.com/furina061006/MOOC_reminder/issues/new?template=bug_report.yml)
- 💡 [功能建议](https://github.com/furina061006/MOOC_reminder/issues/new?template=feature_request.yml)
- ✉️ 涉及个人账号信息、不方便公开讨论时：发邮件至 **[zemei.huang@foxmail.com](mailto:zemei.huang@foxmail.com)**
- 🛠 想改代码：[CONTRIBUTING.md](https://github.com/furina061006/MOOC_reminder/blob/main/CONTRIBUTING.md)

## 近期合并的 Pull Request

| PR | 贡献者 | 内容 |
| --- | --- | --- |
| #9 | puresky271 | 列表可点击跳转，按截止时间排序 |
| #10 | puresky271 | 后台 API 刷新全课程作业追踪 |
| #11 | puresky271 | 设置页面：检查间隔、提醒阈值、免打扰、每日汇总 |
| calendar-digest | puresky271 | 日历导出 `.ics`、手动添加作业、稍后提醒、课程静音、清除已完成 |
| refactor/design-system-icons | puresky271 | 内联 SVG 图标系统，CSS 设计令牌重构 |

## 最近更新

- **更新提醒**：后台默认每 12 小时检查一次 GitHub 上的新版本，发现后弹出系统通知，设置页「更新」区块可查看当前/最新版本并一键前往下载（可关闭自动检查）。
- **无标签页自动刷新**：没有现成学习标签页时，使用临时非激活代理页刷新已载入课程。
- **低频后台检查**：后台检查和徽章刷新默认间隔均为 12 小时。
- **每日摘要补发**：每天定时发送摘要，并在当天首次启动浏览器时补发临期摘要。

完整更新记录请参阅 [.dsh/logs/changelog.md](https://github.com/furina061006/MOOC_reminder/blob/main/.dsh/logs/changelog.md)。

## 贡献者

- [@furina061006](https://github.com/furina061006) — 项目发起人，核心开发
- [@puresky271](https://github.com/puresky271) — 桌面通知、设置页面、日历导出、SVG 图标、全课程追踪、CI/CD、测试

## 原理 & 技术栈（给开发者）

> 想改代码？先读 [CONTRIBUTING.md](https://github.com/furina061006/MOOC_reminder/blob/main/CONTRIBUTING.md)：本地怎么加载扩展、`npm run validate`、以及**不要把抓取产物提交上来**这条红线。

### 工作原理

```text
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

> [!TIP]
> 详细架构请参阅 [architecture.md](https://github.com/furina061006/MOOC_reminder/blob/main/.dsh/logs/architecture.md)。

### 技术栈

| 技术 | 用途 |
| --- | --- |
| Manifest V3 | Chrome 扩展最新标准 |
| 原生 JavaScript | 零框架，轻量高效 |
| chrome.storage.local | 本地持久化存储 |
| chrome.notifications | 桌面通知 |
| XMLHttpRequest | 同源 API 调用（绕过 CSRF） |
| content script proxy | 页面上下文代理 API 请求 |

### 项目结构

```text
MOOC_reminder/
├── manifest.json           # 扩展清单
├── src/
│   ├── background/         # Service Worker（alarms、协调、badge、通知）
│   ├── content/            # 页面注入脚本（API 代理 + SPOC 支持）
│   ├── popup/              # 弹出窗口（HTML/CSS/JS）
│   └── shared/             # 共享模块（数据模型、存储、API 解析、设置）
├── tests/unit/             # 单测（含 SW 集成测试的 chrome.* stub）
├── tools/diagnostics/      # 排查「某门课抓不到」用的诊断脚本
├── .github/                # Issue 模板、PR 模板、CI 与发布 workflow
├── .dsh/logs/              # 更新日志与开发日志
├── AGENTS.md               # 项目事实来源（架构 / 不变量 / 已知限制）
├── CONTRIBUTING.md         # 参与开发前先看这个
└── README.md
```

### API 抓取流程

```text
SW alarm / 手动刷新
  ↓ 优先复用现有 learn/spoc 标签页；没有时先创建 about:blank，持久化临时任务后导航到已保存课程 URL
  ↓ 发送 BATCH_API_FETCH {courses: [...], proxyJobId?}
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
  ↓ 临时代理：BATCH 完成、超时或关闭后仅关闭该扩展创建的 tab
```
