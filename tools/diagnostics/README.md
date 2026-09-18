# 诊断脚本（开发者用）

这两段脚本用于排查「某门课的条目抓不到 / 抓不全」。它们**不参与扩展运行**，
也不会被发布包收录（`release.yml` 只打包 `manifest.json`、`src/`、`README.md`、`LICENSE`）。

先读 CLAUDE.md 的「抓不到 / 抓不全条目」排查流程，再按需运行下面的脚本。

| 脚本 | 在哪里运行 | 回答什么问题 |
|---|---|---|
| `dump-extension-state.js` | **扩展的** Service Worker Console（`chrome://extensions` → MOOC Reminder → 「Service Worker」） | 扩展现在到底存了什么？那些条目在不在？用的是哪个 `termId`？ |
| `dump-page-dto.js` | 课程页面的 Console（F12） | API 数据里到底有没有那些条目？有的话为什么被门槛拦下？ |

## 典型顺序

1. 先跑 `dump-extension-state.js` 确认**症状**：如果条目根本不在 `homework_items` 里，
   那就是抓取/提取的问题；如果条目在，那问题在展示层，不要往抓取方向查。
2. 再看**扩展的 Service Worker Console** 有没有这行：
   ```
   [MOOC Reminder] apiExtractHomework: N 个节点有名字+截止/分数但被类型门槛拦下…
   ```
   有 → 提取门槛过滤掉了它们，日志里直接给出 `contentType`。
3. 都没有 → 跑 `dump-page-dto.js`。若它报告 `foundDtoIn: null`（页面不暴露 DTO），
   改用 DevTools → Network → 筛 `rpc` → 刷新页面 → 找响应最大的请求 → 右键
   → Copy → **Copy response**，把响应存成文件交回来分析。

## 注意

- `dump-page-dto.js` 只读页面已有的数据，**不需要** HttpOnly 的 `NTESSTUDYSI` cookie。
- 部分 SPOC 页面只把 `{id}` 空壳挂到 `window.moocTermDto`（2026-09 实测），
  此时脚本会列出所有候选 window 变量及其体积，而不是报错。
