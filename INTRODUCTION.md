# MOOC Reminder — 项目介绍

> 中国大学MOOC 作业提醒助手，再也不会漏交作业。

---

## 一句话

一个浏览器扩展，自动追踪 [中国大学MOOC](https://www.icourse163.org/) 上所有课程的未完成作业，图标上显示数量，点开即看清单。

---

## 解决的问题

中国大学MOOC 的作业散落在不同课程的不同页面里，没有统一的"未完成作业"看板。每门课都要单独点进去翻，费时费力，还容易漏交。

这个扩展把所有课程的作业汇总到一个面板——打开浏览器就能看到还剩多少没做，点一下就知道哪些要交了。

---

## 核心功能

| 功能 | 说明 |
|------|------|
| **图标数字** | 浏览器图标上直接显示未完成数量 |
| **颜色提醒** | 红色=过期 · 橙色=48h内截止 · 蓝色=正常 |
| **自动检测** | 测验/作业/考试全部自动检测（互评中标记为手动确认） |
| **跨课程汇总** | 所有课程集中展示，按截止时间排序 |
| **SPOC 完整支持** | 大学物理等 SPOC 课程与其他课程同样支持 |
| **截止提醒** | 48h/24h/过期分档桌面通知 |
| **每日摘要** | 早上汇总推送（可选） |
| **静音课程** | 不感兴趣的课可以隐藏 |
| **导出日历** | ICS 格式导入手机 |
| **深色模式** | 自动适配系统主题 |

---

## 开发历程

### 第一阶段：纯 DOM 抓取

最初的思路很直觉——既然作业显示在网页上，那就从网页上"看"。

插件注入到课程页面，用 `querySelectorAll` 找作业列表项（`.u-quizHwListItem`、`.j-submitTime` 等），从元素文本中解析标题、截止日期、完成状态。完成判定靠正则匹配文本——看到「已完成」「测验得分」「已互评」等字样就算完成。

**问题**：
- 必须停在「测验与作业」页面，其他路由抓不到
- 页面改版选择器就挂
- SPOC 用 Ant Design 组件，选择器完全不一样
- 精度低——网页上只有文字，没有 `userScore`、`scorePubStatus`、`usedTryCount` 等精确字段

### 第二阶段：API + DOM 混合

参考开源项目 GinsMooc 的思路，发现 MOOC 有内部 API 接口。

关键发现：**Service Worker 直接调 API 永远 403**——SW 运行在 `chrome-extension://` 下，跟 `icourse163.org` 不同源，cookie 不自动带。但 **content script 运行在页面上下文，同源 XHR 自动带 cookie**，畅通无阻。

于是有了"跑腿员"模式：content script 在页面里替 SW 发 XHR，拿到的数据再传回 SW 处理。

这个阶段 API 和 DOM 两条路并存：
- API 为主——数据准、覆盖全、不挑路由
- DOM 为备——防 API 改版，紧急 fallback
- `domScrapingEnabled` 设置控制开关

**API 拿到的数据**（`getLastLearnedMocTermDto.rpc` 返回 ~200KB JSON）：
- 全部章节 + 全部作业/测验/考试
- 每条都有 `userScore`（得分）、`totalScore`（满分）、`usedTryCount`（提交次数）
- 互评字段：`scorePubStatus`（0=互评中/1=窗口关闭/2=已公布）、`evaluateStart/End`（时间窗口）

### 第三阶段：纯 API——普通课程全覆盖

DOM 抓取的问题越来越明显：
- SPOC 靠 DOM 精度极差——没 `userScore` 无法判断是否真的得分
- 代码冗余——main.js 近 1500 行，DOM 和 API 逻辑交错
- 互评判定全靠 API 字段，DOM 完全帮不上忙

于是花了整个下午做了一件事：**拿着 API 返回的完整 JSON，把三层字段全部 dump 出来**。

通过 content script 中 `chrome.cookies.get()` 读 HttpOnly 的 CSRF cookie，XHR 调两个端点，遍历所有 type:3 作业，把 NODE 层（17 字段）、TEST 层（19 字段）和 `getOpenHomeworkInfo.rpc` result 层（19 字段）全部统计并输出到控制台。

**结论**：
- `submitStatus` 只追作业提交（null=未打开/1=草稿/2=已提交），**不追互评完成**
- 互评完成**没有独立字段**——平台 API 不暴露这个状态
- `scorePubStatus: 1` 经实锤验证等于「窗口关闭」，不等于「完成了互评」

基于此确定了最终判定逻辑——当前阶段的能力边界就是：互评窗口内的作业标「手动确认」，其余全部自动。

随后一次性删除了全部 DOM 抓取代码（~3000 行），项目进入纯 API 时代。

### 第四阶段：SPOC 课程突破

SPOC（大学物理）是所有课程中最难啃的骨头。

**踩过的坑**：试了 10 个端点全部失败或返回空数据——`getMocTermDto.rpc` 各种参数变体全是 `code:-1/-1007`，`getSpocTermDto.rpc` 返回 `code:-1004`（方法不存在）。

**突破**：页面内联 script 中有 `window.moocTermDto = {id: 1476504498}`。但 MV3 的 CSP 阻止 content script 读取页面 `window` 变量，也阻止内联 script 注入。

**解决方案**：web_accessible_resource + DOM bridge
1. `spoc-tid-bridge.js` 注册为 WAR，通过 `<script src="chrome-extension://...">` 注入页面上下文
2. 读 `window.moocTermDto.id` → 写入 `<html data-mooc-real-termid>`
3. content script 读 DOM 属性获取真实 termId
4. 用真实 termId 调 API → 217KB 完整数据

发现 SPOC 有两个 termId：
- URL 的 `tid=1476735472` → 假壳（API 返回 89 字节空数据）
- `window.moocTermDto.id = 1476504498` → 真实 termId（16 章、12 作业 + 12 测验）

至此，**全部课程（普通 MOOC + SPOC）API 全覆盖**。

---

## 如何工作

### 三个角色

**跑腿员（Content Script）** — 站在 icourse163.org 页面里，发同源 XHR 调 MOOC 内部 API，拿完整的课程数据。SPOC 课程会先用 WAR 脚本找真实 termId。

**仓库管理员（Service Worker）** — 后台定时器 + 手动刷新 → 叫跑腿员拿数据 → 解析 JSON → 合并去重 → 存 `chrome.storage.local` → 更新徽章数字。

**看板（Popup）** — 点图标弹出，从仓库读数据，按课程分组展示，支持筛选/勾选/跳转。

### 为什么 SW 不能直接调 API

SW 运行在 `chrome-extension://` 世界，调 `icourse163.org` 的 API 时 cookie 不自动带。MOOC 后端检查 origin 和 CSRF → 403。Content script 运行在页面上下文，同源 XHR 自动带 cookie → 畅通无阻。

### 数据流

```
你打开 MOOC 页面
  → Content Script 注入
    → chrome.cookies.get('NTESSTUDYSI') 读 HttpOnly CSRF
    → XHR → getLastLearnedMocTermDto.rpc → ~200KB JSON
    → SPOC: WAR 脚本读 window.moocTermDto.id → 真实 termId
  → COURSE_API_DATA → Service Worker
    → apiExtractHomework() 解析
    → reconcileHomeworkData() 合并（UID 匹配去重）
    → updateBadgeFromStorage()
你点图标 → Popup 展示
```

### 完成判定

| 类型 | 条件 | 结果 |
|---|---|---|
| 测验/考试 | `usedTryCount > 0` | 完成 |
| 作业无互评 | `usedTryCount > 0` | 完成 |
| 作业互评中 (scorePubStatus:0 + 窗口内) | — | 未完成 · 手动确认 |
| 作业互评窗口关闭/过期 | `scorePubStatus >= 1` | 完成 |

**唯一盲区**：互评窗口内的作业——平台不暴露互评提交状态。这一项标记为「手动确认」。

---

## 技术栈

| 技术 | 用途 |
|------|------|
| Manifest V3 | 浏览器扩展标准 |
| 原生 JavaScript | 零框架，轻量 |
| chrome.storage.local | 本地存储 |
| chrome.alarms | 定时后台刷新 |
| chrome.notifications | 桌面通知 |
| XMLHttpRequest | 页面同源 API 调用 |
| chrome.cookies API | 读取 HttpOnly CSRF cookie |

---

## 安装

1. 打开 `chrome://extensions/`，开启「开发者模式」
2. 点击「加载已解压的扩展」，选择项目目录
3. 打开任意 icourse163 课程页面即可

---

## 局限性

- 需要 icourse163 页面打开才能刷新
- 仅支持中国大学MOOC，不支持其他平台
- 不跨设备同步（chrome.storage.local 是本地的）
- API 端点改版可能暂时失效
- 互评完成无法自动检测（平台 API 不暴露）

---

## 反馈

**zemei.huang@foxmail.com**
