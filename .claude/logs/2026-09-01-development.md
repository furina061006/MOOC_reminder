# 通知链路与页面 CSP 修复 — 2026-09-01

## 一、起因

Windows 11 上验证截止提醒时，设置页的系统测试通知报错：

```text
Unable to download all specified images.
```

同时，icourse163.org 页面控制台报告 `xhr-hook.js` 的内联脚本违反页面 CSP。排查目标是区分扩展逻辑、Chrome 通知 API 和 Windows 通知设置各自的责任边界。

## 二、通知图标问题

### 根因

Service Worker 传给 `chrome.notifications.create()` 的 `iconUrl` 是相对路径：

```javascript
iconUrl: 'src/assets/icons/icon128.png'
```

在通知 API 上下文中该路径不能稳定解析为扩展资源，Chrome 因无法下载图标而拒绝创建整个通知。

### 修复

新增 `getNotificationIconUrl()`，统一使用：

```javascript
chrome.runtime.getURL('src/assets/icons/icon128.png')
```

应用范围包括每日摘要和截止提醒。这样扩展交给 Chrome 的是完整的 `chrome-extension://...` URL，而不是相对路径。

## 三、通知测试与清理

曾临时加入系统测试、截止提醒、过期提醒和每日摘要按钮，用于验证 Windows 通知链路及多作业摘要显示。测试确认后，按生产代码边界删除了设置页测试按钮和 Service Worker 的 `TEST_NOTIFICATION` handler，避免把调试入口长期暴露给用户。

正式功能保留：

- 设置页系统反馈：通知权限、总开关、免打扰状态、可提醒数量、下次检查时间
- 每日摘要真实发送逻辑
- 截止提醒真实发送逻辑
- 自动化测试中的通知与摘要覆盖

## 四、多作业摘要规则

每日摘要通过 `formatDigestMessage()` 生成：

1. 过滤未完成且 48 小时内（含已过期）的项目
2. 按 `deadline` 升序排序
3. 展示最早截止的 3 项
4. 其余显示为「另有 N 项」

3 项限制是为了适配 Windows/Chrome 通知正文长度，不代表数据被删除；完整作业仍在 popup 中展示。新增乱序输入测试，确保存储顺序变化不会影响最早三项选择。

## 五、CSP 内联 hook 问题

### 根因

旧 `xhr-hook.js` 使用 `script.textContent` 拼接页面上下文代码。icourse163.org 的 CSP 不允许该内联脚本执行，导致 XHR/fetch hook 可能静默失效。主流程当时仍可能依赖批量 API，因此问题表现为隐性降级而非立即崩溃。

### 修复

- `xhr-hook.js` 只创建 `<script>` 并设置外部 `src`
- 新增 `xhr-hook-page.js`，承载页面上下文中的 XHR/fetch hook
- 在 `manifest.json` 的 `web_accessible_resources` 中公开 `xhr-hook-page.js`
- 在 ESLint 配置和 manifest 测试中加入该页面脚本

页面 CSP 允许扩展 origin 的资源时，外部扩展脚本可以执行；后续不得恢复 `script.textContent` 内联注入。

## 六、验证

- `npm run validate` 通过
- 最终通知/摘要/CSP 改动后 63 个测试通过，0 失败
- ESLint 无 error，剩余 warning 为项目既有未使用变量警告
- 生产代码中已删除临时测试通知入口

## 七、相关提交

- `1385227` — 通知图标改用绝对扩展资源 URL
- `7684f22` — 多作业摘要测试通知预览
- `f4971a5` — 最早截止三项摘要回归测试
- `2b851b8` — 页面 API hook 改为外部脚本，修复 CSP

> 注意：上述提交中部分临时测试预览已在后续提交中从生产入口移除；自动化测试仍保留必要的通知和摘要覆盖。
