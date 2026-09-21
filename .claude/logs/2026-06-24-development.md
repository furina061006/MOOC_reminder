# 2026-06-24 开发记录

## 完成事项

### backlog.md 问题修复

| Issue | 修改内容 |
|-------|----------|
| 过期项过滤 | `applyFilter()` 排除过期测验/考试，过期作业勾选后隐藏 |
| 互评阶段检测 | service-worker 中保留 `hwPhase`，popup 同时显示 `[互评中]` + `[手动确认]` |
| 错误提示可关闭 | 诊断区 × 按钮 + 设置开关 `autoDismissErrors` + `CLEAR_ERRORS` 处理器 |
| 设置保存无反应 | 加载状态动画、重试机制、storage 兜底、空值安全 `populate()`/`collect()` |
| 弹窗UI开关 | 新增设置 `showSnoozeButton`/`showExternalLink`/`showCourseMute` |
| API 403 | 多 cookie 尝试、Referer 头、CSRF 状态诊断 |
| 上下文失效崩溃 | `sendMessageSafe()` 封装 + 全局 `unhandledrejection` 监听 |
| Popup 速度 | 加载占位 + `Date.now()` 缓存 |

### 新增设置项

- `autoDismissErrors` — 自动清除错误提示
- `showSnoozeButton` — 弹窗中显示稍后提醒按钮
- `showExternalLink` — 弹窗中显示跳转按钮
- `showCourseMute` — 弹窗中显示课程静音按钮

### 文件改动

- `src/popup/popup.js` — applyFilter、标签逻辑、renderDiagnostics、sendMessageSafe、全局拒绝处理
- `src/popup/options.js` — 空值安全 populate/collect、错误报告、重试保存
- `src/popup/options.html` — 错误报告区、弹窗UI开关、加载动画
- `src/background/service-worker.js` — hwPhase 保留、CLEAR_ERRORS、CSRF 改进
- `src/shared/settings.js` — 4 个新默认设置

### 提交历史

```
ea5fed2 优化：popup 加载速度 + 加载占位状态
12ce084 修复：上下文失效连锁崩溃 + 错误清除验证 + 全局拒绝处理
7e8bc3c 修复：backlog.md 所列问题修复
```

## 待办

- [ ] 测试清除错误后验证是否真正清空
- [ ] 确认 API 403 在新会话下是否恢复
