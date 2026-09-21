# 隐私说明

> ← 返回 [README](../README.md)

**一句话**：插件没有服务器，不收集任何个人信息，你看到的所有数据都只存在你自己的浏览器里。

## 它把数据存在哪

`chrome.storage.local`——浏览器给扩展的本地存储，只在本机、只属于这个扩展：

| 存的东西 | 具体内容 |
| --- | --- |
| `homework_items` | 抓到的作业/测验/考试条目（标题、截止时间、分数、完成状态、来源 URL） |
| `courses` | 你载入过的课程（课程名、路由 termId、SPOC 的 active termId、真实 URL） |
| `user_settings` | 设置页里的偏好（提醒阈值、免打扰、静音/忽略的课程、更新检查开关…） |
| `last_sync`、`sync_errors` | 上次同步时间，以及最近几次失败原因（用于设置页的「错误报告」） |
| `dismissed_completed_uids` | 你点过「清理已完成」的记录，防止下次同步把它们又加回来 |
| `temporary_proxy_job`、`scrape_status` | 一次刷新的临时状态（哪个标签页是插件自己开的、进行到哪一步） |
| `update_status` | 上次检查到的版本号与下载链接（**只存结果**，不存任何作业数据） |
| `popup_ui_state` | 弹窗的界面状态（比如展开/收起） |

这些数据**不会**离开你的浏览器，也**不会**同步到别的设备。

## 它什么时候联网

1. **抓作业**：向 `www.icourse163.org` 发请求——和你在网页上点开「测验与作业」时的请求完全一样，
   用的是你自己浏览器的登录态。请求内容只有课程/学期 ID，没有任何个人信息。
2. **检查更新**（默认每 12 小时一次，可关闭）：向 GitHub 的 `api.github.com` 请求本项目的最新 Release 版本号。
   这个请求**不含任何作业、课程或账号数据**——插件只是读一下版本号，然后把结果存在本地。
   在设置页关掉「自动检查更新」后，插件不会再发出这个请求。

除此之外没有任何网络请求。没有埋点、没有统计、没有第三方 SDK。

## 它要了哪些权限，各自干什么

这些都是 `manifest.json` 里声明的，你可以在 `chrome://extensions/` 的详情页看到同一份清单：

| 权限 | 用途 |
| --- | --- |
| `storage` | 把上面那些数据存在本机 |
| `alarms` | 定时器：后台按 12 小时检查新作业、重算徽章 |
| `notifications` | 发截止提醒与每日摘要（走系统通知） |
| `cookies` | 读取 `NTESSTUDYSI`（**HttpOnly**，网页脚本自己也读不到）作为 CSRF token，才能调通平台的 API |
| `tabs` | 找到已打开的课程页、在需要时开一个临时后台页去抓数据、把点击的作业在正确标签页打开 |
| `scripting` | 在 icourse163 页面上注入脚本（抓取必须借页面本身的登录态完成） |
| `host: icourse163.org/*` | 只在这个站点上读写 |
| `host: api.github.com/*` | **只用于**检查新版本 |

## 怎么自己核实

不必相信上面的话，可以自己看：

- **看源码**：整个扩展只有 `src/` 下几十个文件，没有任何压缩/混淆；搜 `fetch(`、`XMLHttpRequest`、`chrome.storage` 就能看到全部数据进出。
- **断网测试**：拔网线或用 DevTools 的 Offline 模式，插件的大部分功能照常（只是抓不到新数据、也检查不了更新）。
- **看网络**：在本项目的 Service Worker 控制台或网页 DevTools 的 Network 面板里观察，只会看到发往 `icourse163.org` 与 `api.github.com` 的请求。
- **看存储**：DevTools → Application → Storage → Extension Storage，里面就是上表那些键。

发现任何与上面描述不符的行为，欢迎[提 Issue](https://github.com/furina061006/MOOC_reminder/issues/new?template=bug_report.yml)——
隐私问题是最高优先级。
