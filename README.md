# MOOC Reminder

追踪中国大学MOOC (icourse163.org) 未完成作业的 Chrome/Edge 浏览器扩展。

## 功能

- 🔍 **自动爬取**: 浏览 icourse163.org 课程页面时自动识别作业信息
- 🔔 **徽章提醒**: 扩展图标上显示未完成作业数量，颜色区分紧急程度
- ✅ **混合标记**: 自动检测完成状态 + 手动勾选，手动标记优先
- 📋 **分组展示**: 按课程分组，按截止日期排序
- 🌙 **深色模式**: 自动适配系统主题

## 徽章颜色说明

| 颜色 | 含义 |
|------|------|
| 🔴 红色 | 有过期未完成的作业 |
| 🟠 橙色 | 48小时内即将截止 |
| 🔵 蓝色 | 正常状态 |

## 安装

### 开发模式

1. 打开 Chrome/Edge，进入 `chrome://extensions/`
2. 启用「开发者模式」
3. 点击「加载已解压的扩展」
4. 选择 `MOOC_reminder` 目录

### 使用

1. 打开 [icourse163.org](https://www.icourse163.org/) 并登录
2. 进入任意课程页面 (`/learn/...`)
3. 扩展会自动爬取作业信息
4. 点击扩展图标查看未完成作业列表
5. 完成作业后，在弹出窗口中勾选标记

## 项目结构

```
MOOC_reminder/
├── manifest.json              # Manifest V3 配置
├── .claude/                   # Claude Code 项目配置
│   ├── CLAUDE.md              # 项目上下文文档
│   ├── settings.json          # 项目设置
│   └── logs/                  # 开发日志
├── src/
│   ├── background/
│   │   └── service-worker.js  # 后台 Service Worker
│   ├── content/
│   │   ├── main.js            # Content Script 入口
│   │   ├── scrapers/          # 页面爬虫
│   │   ├── observers/         # URL/DOM 监听器
│   │   └── selectors.json     # DOM 选择器配置
│   ├── popup/
│   │   ├── popup.html         # 弹出窗口
│   │   ├── popup.css          # 样式（含深色模式）
│   │   └── popup.js           # 交互逻辑
│   └── shared/
│       ├── storage.js         # 存储封装
│       ├── homework-model.js  # 作业数据模型
│       ├── course-model.js    # 课程数据模型
│       ├── date-utils.js      # 日期解析
│       └── messages.js        # 消息协议
└── README.md
```

## 技术栈

- Manifest V3 (Chrome Extension)
- 纯 JavaScript (无框架)
- chrome.storage.local 持久化
- MutationObserver + hash 路由监听（SPA 适配）
- selectors.json 可校准选择器配置

## 开发

```bash
# 代码检查
npx eslint src/

# 打包
zip -r mooc-reminder.zip . -x ".*" "node_modules/*" "logs/*"
```
