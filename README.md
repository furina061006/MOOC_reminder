# MOOC Reminder

> 中国大学MOOC 作业提醒助手 —— 再也不会漏交作业啦！

[![CI](https://github.com/furina061006/MOOC_reminder/actions/workflows/ci.yml/badge.svg)](https://github.com/furina061006/MOOC_reminder/actions/workflows/ci.yml)

打开[中国大学MOOC](https://www.icourse163.org/)做线上作业时，插件自动抓取「测验与作业」和「考试」板块的未完成项，在扩展图标上显示数量，点开就是清单。**无后端**：所有数据只存在你自己的浏览器里。适用于 Chrome、Edge、夸克等 Chromium 内核浏览器。

> [!TIP]
> 遇到问题或想提建议？→ **[新建 Issue](https://github.com/furina061006/MOOC_reminder/issues/new/choose)**（有模板，会问你要日志）。
> 在此之前请先做一次「在 `chrome://extensions` 重新加载扩展 **+** 刷新已打开的课程页面」——大部分「抓不到」都是漏了这一步，详见[常见问题](https://github.com/furina061006/MOOC_reminder/blob/main/docs/faq.md)。

## 下载与安装

1. 打开 [Releases 页面](https://github.com/furina061006/MOOC_reminder/releases/latest)，下载最新版的 `mooc-reminder-v*.zip` 并解压。
2. 打开浏览器扩展管理页 `chrome://extensions/`，开启右上角「开发者模式」。
3. 点击左上角「加载已解压的扩展」。
4. 选择解压出来的 `MOOC_reminder` 文件夹。

> [!WARNING]
> 本插件未上架 Chrome 网上应用店，需通过「开发者模式」加载；也正因为如此，**Chrome 不会自动更新它**。
> 插件会在后台检查新版本并弹通知（默认每 12 小时一次，可在设置页关闭）；升级时按上面步骤重新下载解压、再到扩展管理页点一下「刷新」即可，作业数据不会丢失。
> 细节见[常见问题 · 怎么更新插件](https://github.com/furina061006/MOOC_reminder/blob/main/docs/faq.md#怎么更新插件)。

## 使用方法

1. 登录[中国大学MOOC](https://www.icourse163.org/)。
2. **第一次必须打开一次课程学习页**（或「我的课程」页）——插件要靠它保存你的课程路由，光装好扩展是抓不到东西的。
3. 扩展图标上显示未完成数量，点击查看详细清单。
4. 之后点 popup 里的刷新按钮可手动刷新；打开任意课程页也会自动刷新（30 分钟内不重复，另有 12 小时周期兜底）。
5. 完成状态自动检测；互评中的作业与考试需要你手动确认。

## 常用功能

- 🔔 图标直接显示未完成数量：🔴 已过期 / 🟠 48 小时内 / 🔵 正常
- 📋 按课程分组，可按「未完成 / 已过期 / 已完成 / 全部」筛选，点条目直接跳到作业页
- ✅ 测验、作业、考试都自动检测完成状态；平台数据不足时明确标「手动确认」
- ⏰ 多档截止提醒、📊 每日摘要、📅 日历导出（`.ics`）、📝 手动添加、🔕 课程静音、🧹 清理已完成
- ⚙️ 设置页可调检查间隔、提醒阈值、免打扰时段，并查看「错误报告」

完整清单与使用技巧 → [`docs/features.md`](https://github.com/furina061006/MOOC_reminder/blob/main/docs/features.md)

## 局限性

- **首次仍需载入课程页面**：插件依赖你已登录的页面保存课程路由；之后没有课程标签页时，会临时开一个非激活代理页去抓取。
- **仅支持中国大学MOOC**：不支持学堂在线、超星等其他平台。
- **不跨设备同步**：数据存在浏览器本地。
- **平台接口改版可能暂时失效**：抓取依赖 icourse163 的 API。
- **互评完成无法自动检测**：平台不公开该字段，这类作业记为「手动确认」。
- **考试完成无法可靠自动检测**：同样标「手动确认」（成绩/提交状态仍正常检测）。

## 隐私说明

**所有数据仅存储在浏览器本地**，不上传任何服务器，也不收集任何个人信息；插件只在中国大学MOOC 页面运行。
唯一的对外请求是向 GitHub 查一次新版版本号（可在设置页关闭），不含任何作业或账号数据。

存了什么、要了哪些权限、怎么自己核实 → [`docs/privacy.md`](https://github.com/furina061006/MOOC_reminder/blob/main/docs/privacy.md)

## 反馈建议

**优先用 Issues**——可以搜到别人提过的问题，也能看到处理进度。模板会引导你附上插件版本、浏览器版本、`[MOOC Reminder]` 日志和诊断输出；信息给够通常一轮就能定位。

- 🐞 [Bug 报告](https://github.com/furina061006/MOOC_reminder/issues/new?template=bug_report.yml)
- 💡 [功能建议](https://github.com/furina061006/MOOC_reminder/issues/new?template=feature_request.yml)
- ✉️ 涉及个人账号信息、不方便公开讨论时：发邮件至 **[zemei.huang@foxmail.com](mailto:zemei.huang@foxmail.com)**
- 🛠 想改代码：[CONTRIBUTING.md](https://github.com/furina061006/MOOC_reminder/blob/main/CONTRIBUTING.md)

## 常见问题

- **作业一条都抓不到** → 多半漏了「重载扩展 **+** 刷新页面」这两步，或从没打开过课程页。
- **只有某一门课缺** → 那门课的页面被浏览器回收了：把它切到前台一次，再点刷新。
- **提醒没弹** → 检查系统通知权限、提醒阈值、免打扰时段，以及这门课是否被静音。

更多（怎么更新、换设备、数据在哪、支持哪些浏览器）→ [`docs/faq.md`](https://github.com/furina061006/MOOC_reminder/blob/main/docs/faq.md)

## 给开发者

- 项目事实的入口是 [`AGENTS.md`](https://github.com/furina061006/MOOC_reminder/blob/main/AGENTS.md)（红线 + 路由表），分主题的架构 / 平台 / SPOC / 不变量在 [`.dsh/agents/`](https://github.com/furina061006/MOOC_reminder/tree/main/.dsh/agents)。
- 动手前读 [`CONTRIBUTING.md`](https://github.com/furina061006/MOOC_reminder/blob/main/CONTRIBUTING.md)：本地怎么加载扩展、`npm run validate`、以及**不要把抓取产物提交上来**这条红线。
- 技术栈：Manifest V3 + 原生 JavaScript（零框架）；数据存 `chrome.storage.local`；内容脚本借页面登录态发起同源 XHR。
- 小注：本插件 99.99% 的代码贡献依靠 Vibe Coding（Claude Code / deepseek harness + DeepSeek API）。

## 致谢

感谢 [@puresky271](https://github.com/puresky271) 贡献桌面通知、设置页、日历导出、SVG 图标系统与测试体系。
完整名单与合并记录 → [`docs/contributors.md`](https://github.com/furina061006/MOOC_reminder/blob/main/docs/contributors.md)

## 许可证

[MIT](https://github.com/furina061006/MOOC_reminder/blob/main/LICENSE)
