<!-- 一两句话就够，重点是「为什么」。 -->

## 这次改了什么

## 怎么验证的

<!-- 单测覆盖了什么；在真实浏览器里怎么试的（哪门课、什么现象）。涉及抓取或 SPOC 的改动必须有这一项。 -->

## 检查清单

- [ ] `npm run validate` 通过（lint + 全部单测）
- [ ] **没有提交任何抓取产物或隐私数据**（`element.txt`、`*.har`、`*-report.json`、`dto*.json`、`.claude/settings.local.json`），也没有用 `git add -f` 绕过 `.gitignore`
- [ ] 改了抓取/解析的，`src/shared/icourse163-api.js` 与 SW 内联的 `apiExtractHomework` 两份拷贝已同步（AGENTS.md 不变量 12）
- [ ] 改了平台行为或不变量的，已同步更新 `AGENTS.md`
- [ ] 用户能感知到的变化，已写入 `.dsh/logs/changelog.md`
