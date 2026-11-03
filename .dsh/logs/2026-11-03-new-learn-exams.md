# 新版学习页的考试：从 React Flight 数据补抓（issue #15）

**日期**：2026-11-03  
**Issue**：[#15 特定课程的期末考试未能成功识别](https://github.com/furina061006/MOOC_reminder/issues/15)  
**课程**：`NEU-1001638003`「复变函数与积分变换」（`/mooc/learn/NEU-1001638003/exams?tid=1487856456`）  
> **验证状态**：✅ **真机确认**（2026-11-03，用户反馈「通过了」）：重载扩展 + 刷新课程页后，期末考试正常进入任务列表。

## 现象

作业/测验都能抓到，唯独「期末考试」不在列表里。用户同时提供了新版普通课程与老版 SPOC 的考试页 DOM（`common_examlist.txt` / `spoc_examlist.txt`）。SPOC 的考试正常，说明不是通用的考试解析逻辑坏了。

## 定位

- 扩展对考试的主数据源仍是 `getLastLearnedMocTermDto`。新版学习页（2026-10 起）把课程大纲放在服务端渲染的 **React Flight** 数据里：`<script>self.__next_f.push([1,"…"])` 中有一个 `outline` 对象，包含 `chapters` 与 `exams`。
- 用户提供的 `common_examlist.txt` 里，`outline.exams` 有完整的期末考试：`id=1233326285`、`deadline=1793973600000`、`totalScore=100`，并带 `taskType:"exam"`、`nodeType:"legacy-exam"`。**同一个页面上的章节伪节点** `{"id":"1252502343","name":"期末考试","nodeType":"legacy-exam","contentType":2}` 没有 deadline，所以只靠章节树抓不到。
- 由此把修复拆成两层：
  1. **提取器识别显式考试**：`taskType:'exam'` / `nodeType:'exam'|'legacy-exam'` / 有效 `examId` 是平台明确的类型声明，不应被 `contentType` 缺失或复用挡掉；截止时间可能只在 `parts[]` 里；
  2. **新版页面数据回退**：`main.js` 把页面内联的 Flight 脚本文本交给 SW，SW 用纯函数解析出 `outline.exams`，再作为一条 `COURSE_API_DATA` 走原有的 reconcile 流程。

## 为什么不是「放宽名字门槛」

`taskType` / `nodeType` / `examId` 是数据里的显式类型，不是靠「名字里有考试」猜。名字正则仍然只在 `contentType` 缺失时兜底；`examId:'-1'`（测验的常见值）不会被当成考试。

## 实现要点

- `src/shared/next-flight.js`（纯函数，可单测）：解码 Flight 字符串块、读取内联 JSON、找到 `outline`；页面可能预取多门课，所以返回全部 outline，由 SW 按 `courseId` + `termId` 选匹配的那条。
- `src/content/main.js`：只在新版课程页（非 SPOC）读取含 `self.__next_f.push` 的脚本，页面加载时上报一次；每次 SW 抓取询问课程时也重试一次（解决「扩展重载前页面已打开」）。成功后不再重复上报。若当前页（如 `/content`）的数据里没有考试，再同源拉一次该课程的 `/exams` HTML 解析，避免修复依赖用户恰好打开考试页；只尝试一次，不导航标签页。
- `src/background/service-worker.js`：新增 `PAGE_RSC_DATA` handler，只取 `outline.exams`，然后复用 `COURSE_API_DATA` 的提取 + reconcile。UID 与 API 数据同源（exam id），不会重复建条目。
- 两份提取器（shared + SW 内联）同时改，保持不变量 12。

## 验证

- `tests/unit/next-flight.test.mjs`：Flight 解码、跨 chunk、字符串里的花括号、多 outline 选择。
- `tests/unit/icourse163-api.test.mjs`：`taskType` / `nodeType` / `examId` 考试、`parts[].deadline`、`examId:'-1'` 不误判。
- `tests/unit/service-worker.integration.test.mjs`：真实 SW 走 `PAGE_RSC_DATA`，最终 `homework_items` 里出现未完成的「期末考试」，deadline 为 `2026-11-06T22:00:00+08:00`。
- 用用户提供的 `common_examlist.txt` 离线跑通解析与提取（不提交该文件）。**真机 API 响应未能直接抓取**（需要登录态），因此保留了「API 有考试就用 API、没有就用 Flight 数据」的双保险。
- **真机验证 ✅（2026-11-03，用户确认）**：重载扩展 + 刷新课程页后，「期末考试」出现在任务列表；用户回复「通过了」。

## 已知边界

- Flight 数据是页面实现细节，平台若改 Next.js 渲染方式可能再次失效；解析失败只是回退到原 API 行为，不会报错或丢已有条目。
- 只补 `outline.exams`（新版考试）；新版 `newExams` 目前为空，未纳入。若以后出现，需要按同样方式先拿真实页面数据再扩展。
