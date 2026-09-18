注: 待追踪任务
- [ ] 扩展作业抓取(这里不清晰,最后搞，到时候问我具体情况)
- [ ] 合并 SW 内联的 `apiExtractHomework` 与 `src/shared/icourse163-api.js`（两份拷贝已多处漂移，是 2026-09-18 SPOC 修复空转的根因；需先逐字段核对行为差异）
- [ ] `src/popup/options.js` 里的 `DEFAULTS` 是 `src/shared/settings.js` 的第二份副本，易漂移；考虑改为从 SW 读或去掉副本

已修复或已论证放弃的历史问题不再保留在这里，记录位置：

- `.claude/logs/changelog.md` — 面向用户的版本变更记录
- `.claude/logs/` — 开发过程、根因分析和技术决策
- `.claude/CLAUDE.md` — 项目当前事实来源（架构、不变量、已知限制）
