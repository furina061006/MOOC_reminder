# 2026-09-22 — 「设置页说我还是 v1.0.0」：三个 bug 与一条不变量

## 起因

用户发来设置页「更新」区块的截图：

```
自动检查更新  [开]
当前版本    v1.0.0
最新版本    v1.1.0
上次检查    2026/9/22 00:13:41
发现新版本 v1.1.0，点击「前往下载」获取。   [检查更新] [前往下载]
```

问题是「我，开发者，为什么这里显示我还是 v1.0.0」。

我第一版回答是「你的浏览器还在跑旧实例，点一下扩展卡片上的重新加载」——**用户当场否掉了这个解释**：
他更新插件后 `chrome://extensions` 上确实是 v1.1.0。这个纠正很关键，它把问题从「用户没重载」逼到了
代码里，而且顺带把另外两个 bug 一起炸了出来。

## 三个 bug（都真机可复现）

### A. 「当前版本」渲染的是缓存快照，而不是正在跑的实例

`update_status.currentVersion` 由 `checkForUpdates()` 在**检查那一刻**写入，来源是
`getRunningVersion()`（= `chrome.runtime.getManifest().version`）。而侧载扩展换版本只有「重新加载」一条路，
**`onInstalled` / `onStartup` 都不跑更新检查**（唯一自动调用点是 12h 的 `badge-refresh`，且重载会清掉并
重建 alarm，所以重载后首次自动检查最长要等 12h）。于是「重载 → 实例变 1.1.0」与「设置页显示 v1.0.0」
可以同时成立。

最扎心的一点：`GET_UPDATE_STATUS` 早就把**实时的**版本回给了页面
（`currentVersion: chrome.runtime.getManifest().version` = 1.1.0），但 `renderUpdateStatus` 的取值顺序是
`status.currentVersion || payload.currentVersion` —— **把已经拿到手的正确值丢掉了**。

### B. 检查失败时，照抄了上次的「有更新」结论

用户在 00:15:09 点了「检查更新」，截图 2 显示：当前版本 v1.1.0、最新版本 v1.1.0、
**却仍然写着「发现新版本 v1.1.0」**。

从纯函数看这是不可能的：`isNewerVersion('1.1.0','1.1.0') === false`。所以那次检查**一定失败了**，
走了 catch 兜底路径，而旧代码是：

```js
updateAvailable: !!(previous.latestVersion && previous.updateAvailable)
```

`previous.updateAvailable` 是上一次（当时运行 1.0.0）算出来的结论，被原样搬到了运行 1.1.0 的这次。
**「最新版本」是客观事实，「是否有更新」是它与当前版本的函数**——照抄布尔值就是把前者当成了后者。

顺带确认了 GitHub 侧没有问题（从本机直接查 API）：`v1.1.0` Release 存在、`draft: false`、
`prerelease: false`、ZIP 附件在（`mooc-reminder-v1.1.0.zip`，622093 字节，发布于 2026-09-21T15:21:16Z）。
所以失败原因是**运行环境的网络**（`api.github.com` 在国内直连下偶发不通），不是发版流程。

### C. 「本次检查失败」被 `else if` 吞掉

设置页原来是：

```js
if (status.updateAvailable) { ...发现新版本... }
else if (status.error)       { ...本次检查失败... }
else if (status)             { ...已是最新版本... }
```

于是「上次说有更新」+「这次失败」= 只显示那句旧的「发现新版本」，失败原因完全不显示。
用户看到的自相矛盾状态**连一句解释都没有**——这比单个显示错误更糟：它把 B 的真实原因藏了起来
（如果失败提示可见，B 一开始就会被发现）。

## 修复

1. `shared/update-check.js` 新增纯函数 **`reconcileStatus(status, runningVersion)`**：运行版本与快照不一致时，
   保留「最新版本 / 上次检查时间」等客观事实，把 `currentVersion` 换成运行版本并**重算** `updateAvailable`；
   拿不到运行版本就原样返回（宁可不显示，也不误判）。
2. `GET_UPDATE_STATUS` 读取时对齐（纯计算、零请求、**不回写 storage**——真正的检查会自己刷新快照）；
   响应里的 `currentVersion` 改用 `getRunningVersion()`（它包了 try/catch，读 manifest 不该成为拖垮 tick 的动作）。
3. catch 兜底路径改成 `isNewerVersion(previous.latestVersion, currentVersion)`。
4. 设置页：取值顺序改为 **实时值优先**；「本次检查失败」与「有新版本」改为两个独立分支，可以并存。

## 验证

- 新增单测（`tests/unit/update-check.test.mjs`）：`reconcileStatus` 的收回 / 保留 / 保守三组；
  含「入参不能被就地修改」「版本一致时连对象都不换」。
- 新增集成测试（`service-worker.integration.test.mjs`）：
  - 失败兜底 + 已升级到 1.1.0 → `updateAvailable: false`、`error` 有值、不弹通知、写回 storage 的也是重算结论；
  - 失败兜底 + 运行版本仍旧 → 仍然保留「有更新」提示（不变量 4/13 的本意不能被这次修复推翻）；
  - 读取对齐：缓存说 1.0.0、实际运行 1.1.0 → 响应 `currentVersion` 与 `status` 都是 1.1.0、零请求、
    且**不**写 storage。
- **负向验证**：把 catch 路径改回 `previous.updateAvailable` 的旧写法 → 新测试立刻 `not ok`；改回即绿。
- `npm run validate`：0 error / 18 warning（基线），142 tests（当天基线 136 + 新增 6 条）。

## 已知取舍与遗留

- **不**在 `onInstalled` 里补一次检查：显示正确性不该依赖一次网络请求，而且那会违背「不为更新检查额外唤醒 SW」
  的既定取舍（搭 12h `badge-refresh` 的便车）。读取时对齐已经让页面自洽，快照仍由下一次真实检查刷新。
- 设置页的渲染分支（bug C）没有自动化测试：`options.js` 是经典脚本、仓库里没有 DOM 测试脚手架。
  这次靠「独立分支 + 人工核对」保证；若以后要给 popup/options 加测试，这是第一个值得覆盖的函数。
- 用户那次「检查失败」的根因在网络上。现在失败原因会同时出现在设置页与 `update_status.error`，
  下次再出现时可以一眼看到，而不是像这次一样要靠「当前=最新却提示有更新」反推出「其实失败了」。
