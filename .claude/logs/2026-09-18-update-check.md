# 插件更新检查与「有更新」提醒

日期：2026-09-18
分支：`dsh`
backlog 条目：`实现插件更新, 客户端插件提醒有更新`

## 需求澄清

用户的原话是「实现插件更新, 客户端插件提醒有更新」，并补充「面向小白，需要 GitHub Release 直接下载」。
前者容易被读成「实现自动更新」，所以先把**能力边界**查清楚了。

## 结论一：这个扩展在 Chrome 里永远不会自动更新

| 事实 | 依据 |
|---|---|
| manifest 没有 `update_url`、没有 `key` | `manifest.json` |
| README 明说未上架网上应用店 | 「本插件未上架 Chrome 网上应用店，需通过开发者模式加载」 |
| Chrome 只对「商店安装」或「配置了 `update_url` 的签名 CRX」自动更新 | 平台规则 |

所以 `chrome.runtime.requestUpdateCheck()` 是空操作。真正的自动更新只有两条路：
上架商店，或自建 RSA 签名 CRX + 稳定 HTTPS 托管 `update.xml`（且已装用户还得重装一次才纳入通道）。
两者都远超本次范围，因此**把功能定位为「发现新版 → 通知 + 给出下载直链」**，用户手动重载。

## 结论二：版本号从未变过 —— 这个功能会「装好即失效」

```
$ git log --format='%h %ad %s' --date=short -- manifest.json   # 10 个提交都碰过它
$ git log -p -- manifest.json | grep '"version"'
+  "version": "1.0.0"      ← 只有初始那一次，从没有过 -/+ 改动
```

**任何「比较远端版本号」的实现都会永远显示「已是最新」，一次都不触发。** 这和第 1 条
backlog 的 bug 是同一类陷阱：机制齐全但永不触发。所以这个功能要真正有用，必须同时建立
「发版改版本号」的纪律。

## 结论三：仓库里已经有一个 Release，只是人工发的

排查中发现 `v1.0.0` Release 已存在（2026-09-03），附件是 `mooc-reminder-v1.0.0.zip`（595 KB，2 次下载），
Release 说明还是手写的中文。因此用户的分发流程已经在用 Release，只是没有自动化。

## 方案：A 与 B 不是二选一

用户最初没看懂「版本号放哪」的三个选项，解释后明确了需求。关键点是：

- **A**（读仓库的 `manifest.json`）= 插件知道自己是不是旧的，但不知道去哪儿下载
- **B**（读 GitHub Release）= 一次请求同时拿到版本号**和**下载地址

用户要「小白从 Release 直接下载」，那就必然有 Release；既然有，顺便从 Release 读版本号即可 —— 所以是 B，
而且下载链接不用写死。A 的那个「记得改版本号」的坑，用 CI 强制 `tag == manifest.version` 来兜住。

## 实现

**新增 `src/shared/update-check.js`（纯函数，21 个单测）**

| 函数 | 职责 |
|---|---|
| `isNewerVersion(candidate, current)` | 按数字分量逐位比较；`1.1` 与 `1.1.0` 相等；**无法解析的输入一律判为「不是更新」**（垃圾 tag 不能永久骚扰用户） |
| `parseReleaseInfo(payload)` | 解析 GitHub payload；**draft/prerelease 直接返回 null**；优先取 ZIP 附件（小白少点一次）；`body` 截断到 2000 字符 |
| `evaluateRelease(payload, current)` | 解析 + 比较 |
| `isSafeReleaseUrl(url)` | **只允许 `https://github.com/`** |
| `resolveDownloadTarget(status)` | 依次挑选安全的下载目标，全不安全则返回 null |

**SW 侧**（`service-worker.js`）

- `checkForUpdates({ manual })`：搭 12h `badge-refresh` 的便车，**不新增 alarm**（与「降频」决策一致）
- 网络失败时用 `...previous` 兜底：一次离线不应让「有新版本」的提示消失，也不应清空 UI
- `notifyUpdateAvailable()`：尊重免打扰时段；**返回布尔值**
- 通知点击分支：`mooc-reminder:update:` 前缀先于作业条目处理，打开 ZIP 直链
- 新增消息 `GET_UPDATE_STATUS`（读缓存，零请求）和 `CHECK_UPDATES`（manual，绕过开关）

**设置**：`autoCheckUpdates` 加入 `DEFAULT_SETTINGS` 与 `normalizeSettings`（`!== false`，默认开），
options 页新增「更新」区块与开关。`manifest.json` 增加 `host_permissions: ["https://api.github.com/*"]`。

**发版**：`.github/workflows/release.yml` —— 推 `v*` tag → `npm run validate` → 校验 tag 与 manifest 版本一致
→ 显式清单打包（解压即得 `MOOC_reminder/` 目录）→ `gh release create`。用 runner 自带的 `gh`，不引第三方 action。

## 差点踩的坑：通知标志的记账顺序

`notifiedVersion` 必须**只在 `chrome.notifications.create` 真正成功后**推进。若先记标志再发通知，
恰好处于免打扰时段的用户会**永远收不到**更新提醒（标志已消费，下次 tick 不再尝试）。
`notifyUpdateAvailable` 因此返回布尔值，调用方据此决定是否推进标志。
这与不变量 4「digest 先 create 成功再写 `last_digest_date`」是同一条教训。已用单测钉住：
免打扰时 `notifiedVersion` 保持 `null`，退出免打扰后下一次 tick 立刻投递。

## 其它设计取舍

| 决策 | 理由 |
|---|---|
| 搭 12h badge-refresh，不新增 alarm | 更新检查不值得多唤醒 SW |
| 失败保留上次成功结果 | 离线不该让「有新版本」消失，也不该把 UI 清空 |
| 优先 ZIP 直链而非 Release 页面 | 面向小白，少一次点击 |
| 开关默认开、可关；但手动按钮不受开关限制 | 开关管的是「后台是否联网」，不是「用户能不能主动查」 |
| `downloadUrl` 只允许 `https://github.com/` | 远端响应属外部输入，绝不直接交给 `chrome.tabs.create` |
| 设置页渲染只读缓存（`GET_UPDATE_STATUS`） | 打开设置页不应产生网络请求 |
| 测试里 `globalThis.fetch` 默认抛错 | SW 每个 badge-refresh tick 都会查更新，**测试绝不能真的联网** |

## 验证

- `npm run validate`：eslint 0 error，**106/106 通过**（原 85 + 新增 21）
- 新增测试：
  - `tests/unit/update-check.test.mjs` — 21 例纯函数（含 `1.10 > 1.9` 的数字比较、`v` 前缀、缺省分量、垃圾输入、draft/prerelease、URL 白名单）
  - 集成测试 — 发现新版并只提醒一次、同版本不重复、更新后重新提醒、已是最新、网络失败保留旧结果、HTTP 非 2xx、开关关闭时**零请求**、prerelease 不提示、**免打扰延后且不消费标志**、`CHECK_UPDATES` 绕过开关、通知点击打开 ZIP、恶意 URL 回落到仓库页
- **真实 API 验证**（这是最有价值的一步）：直接对真实仓库跑解析器，返回
  `version 1.0.0 / tag v1.0.0 / ZIP 直链 / 手写中文更新说明`，`updateAvailable: false` 判定正确 —— 说明解析器对
  GitHub 的真实 payload 形状成立，而不只是对我编的 fixture 成立。
- workflow：`js-yaml` 解析通过；tag/manifest 校验逻辑实测（`v1.0.0` 放行、`v1.0.1` 拒绝）；
  打包逻辑本地干跑 → 39 个文件 / 593 KB，内层 `MOOC_reminder/manifest.json`，无 `tests/`、`.claude/`、`.github/`
  （与已发布的 595 KB 包结构一致）。

## 遗留

- **无法自动更新是平台限制**，不是实现缺陷；若将来要真正的自动更新，需上架商店或自建签名 CRX 托管。
- `--generate-notes` 生成的是基于 commit 的英文说明，与手工 Release 说明风格不同；发版后可在 GitHub 上编辑。
- 更新检查依赖仓库里存在 Release：**只打 tag 不建 Release 会让检查一直失败**（workflow 会自动建，手工发版时要注意）。
- `options.js` 里仍有一份 `DEFAULTS` 副本（与 `shared/settings.js` 重复），本次只是同步加了 `autoCheckUpdates`；
  这是与「两份 extractor 拷贝」同类的漂移风险，值得单独排期清理。
