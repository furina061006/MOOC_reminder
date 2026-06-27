# MOOC Reminder — 测试清单

## Phase 5: 测试与选择器校准

---

## 准备工作

- [ ] 确认 Chrome/Edge 浏览器已安装
- [ ] 打开 `chrome://extensions/`
- [ ] 启用「开发者模式」
- [ ] 点击「加载已解压的扩展」
- [ ] 选择 `MOOC_reminder/` 目录
- [ ] 确认扩展已出现在扩展列表中，无加载错误

---

## 第一步：扩展加载验证

### 1.1 基础检查
- [ ] `chrome://extensions/` 中扩展卡片无红色错误提示
- [ ] 扩展图标显示在浏览器工具栏
- [ ] 点击图标能打开 popup 窗口
- [ ] Service Worker 状态显示为 "Service Worker" (不是 "Inactive")

### 1.2 Console 检查
- [ ] 点击 "Service Worker" 链接打开 SW DevTools
- [ ] 控制台出现 `[MOOC Reminder] Extension installed/updated: install` 日志
- [ ] 控制台出现 `[MOOC Reminder] Alarms configured` 日志
- [ ] 无红色报错

---

## 第二步：模拟页面测试

### 2.1 加载模拟页面
- [ ] 在浏览器中打开 `tests/mock-icourse163.html`
- [ ] 注意：file:// 协议下 Content Script 不会注入
- [ ] 使用 `python3 -m http.server 8080` 启动本地服务器
- [ ] 访问 `http://localhost:8080/tests/mock-icourse163.html`

### 2.2 验证 Content Script（模拟页无法触发自动注入，需手动测试）
- [ ] 在模拟页面的 DevTools Console 中粘贴并运行 `tests/debug-helper.js`
- [ ] 确认输出中 Test 1-5 都有结果
- [ ] Test 3 (DOM Structure) 中 Homework Items 应有匹配
- [ ] Test 5 中应找到 2-3 个完成状态元素
- [ ] Test 6 尝试发送 SCRAPE_NOW 消息（如 SW 运行中会收到）

---

## 第三步：真实页面测试

### 3.1 登录并打开课程
- [ ] 登录 [icourse163.org](https://www.icourse163.org/)
- [ ] 打开任意已选课程页面
- [ ] URL 格式应为 `https://www.icourse163.org/learn/{school}-{courseId}?tid={tid}#/learn/content`

### 3.2 验证 Content Script 自动运行
- [ ] F12 打开 DevTools → Console
- [ ] 查找 `[MOOC Reminder]` 相关日志
- [ ] 应出现 `[MOOC Reminder] Content script initialized`
- [ ] 应出现 `[MOOC Reminder] Scraped X items from {课程名}`

### 3.3 验证徽章更新
- [ ] 查看扩展图标右上角的数字
- [ ] 数字应等于未完成作业数
- [ ] 如有过期作业，徽章背景应为红色
- [ ] 如有48h内截止，徽章背景应为橙色

### 3.4 验证 Popup
- [ ] 点击扩展图标
- [ ] Popup 应显示课程分组的作业列表
- [ ] 每项作业应有：标题、类型标签、截止日期
- [ ] 过期作业应有红色左边框
- [ ] 即将截止应有橙色左边框
- [ ] 底部应显示总计数量和同步时间

### 3.5 验证手动勾选
- [ ] 在 Popup 中勾选一项作业的 checkbox
- [ ] 该项应立即变灰并显示「手动标记」标签
- [ ] 徽章数字应减 1
- [ ] 关闭 Popup 再打开，勾选状态应保留

### 3.6 验证刷新
- [ ] 点击 Popup 中的刷新按钮 🔄
- [ ] 按钮应有旋转动画
- [ ] 数据刷新后列表更新

### 3.7 验证清理
- [ ] 点击「清理已完成」按钮
- [ ] 已勾选的作业应从存储中移除
- [ ] 徽章数字不变（仅移除已标记完成的）

---

## 第四步：SPA 导航测试

### 4.1 Hash 路由切换
- [ ] 在课程页面中，点击左侧导航切换不同章节
- [ ] URL hash 应变化但页面不刷新
- [ ] 切换回 `#/learn/content` 后，Content Script 应重新爬取
- [ ] Console 中应有新的 scrape 日志

### 4.2 跨页面操作
- [ ] 从一个课程页面切换到另一个课程页面
- [ ] 两个课程的作业都出现在 Popup 中

---

## 第五步：选择器校准

### 5.1 使用 Debug Helper
- [ ] 在真实 icourse163.org 页面的 Console 中运行 `tests/debug-helper.js`
- [ ] 检查 Test 3 的各项选择器匹配情况
- [ ] 记录所有 ❌ 的选择器


---

## 第六步：边界情况测试

### 6.1 无打开页面
- [ ] 关闭所有 icourse163 标签页
- [ ] 等待 5 分钟（badge-refresh alarm 触发）
- [ ] Popup 应显示空状态 🎉

### 6.2 未登录
- [ ] 在未登录状态打开 icourse163.org
- [ ] Content Script 应检测到登录墙并跳过爬取
- [ ] Console 应有 `Login wall detected, skipping scrape` 日志

### 6.3 空课程
- [ ] 打开一个没有作业的课程（如果存在）
- [ ] 不应有错误，Popup 中该课程无作业项

### 6.4 全部完成
- [ ] 手动勾选所有作业
- [ ] 徽章应消失（无数字）
- [ ] Popup 应显示空状态 🎉

### 6.5 SPOC 课程
- [ ] 如有 SPOC 课程 (`/spoc/learn/...`)，打开并验证
- [ ] 爬取应正常工作

---

## 第七步：回归验证

- [ ] 扩展加载无错误
- [ ] Service Worker 正常运行
- [ ] 徽章正确更新
- [ ] Popup 正确显示
- [ ] 手动勾选持久化
- [ ] 数据在浏览器重启后保留

---

## 问题报告模板

```
### 问题描述
[简短描述]

### 复现步骤
1.
2.
3.

### 预期结果
[应该发生什么]

### 实际结果
[实际发生了什么]

### Console 日志
[粘贴相关日志]

### 页面信息
- URL:
- 是否 SPOC:
- 选择器匹配情况 (debug-helper Test 3 结果):
```

---

## 测试完成标准

- [ ] 扩展在 Chrome 中无任何加载错误
- [ ] 在真实 icourse163.org 页面成功爬取作业数据
- [ ] 徽章显示正确数量和颜色
- [ ] Popup 显示正确列表，支持手动勾选
- [ ] 所有选择器均已校准，无 ❌ 项
- [ ] SPA 导航后数据正确更新
- [ ] 边界情况（无页面、未登录、全部完成）处理正常
