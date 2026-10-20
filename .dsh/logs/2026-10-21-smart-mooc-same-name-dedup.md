# 2026-10-21 智慧慕课「只抓到几条」：同名去重跨章误删

用户报：某门课（智慧慕课「高级语言程序设计」，`NEU-1002123005`）只抓到几条作业，
其他课正常。一开始怀疑「网页元素变了 / 出现了新的作业类型」。

结论：**不是解析、不是类型门槛、也不是新接口**。DTO 里 16 个作业/测验全都在、全部带
deadline，是插件末尾的**同名去重**把后七周整批删掉了。

---

## 1. 症状与第一轮排除

- 页面：`/mooc/learn/NEU-1002123005/assessments?tid=1488158441`（新版外壳）
- 抓到的 3 条：`本周作业`(ch1252615054) / `本周测验`(ch1252615054) / `本周测试`(ch1252615057)
- `dump-page-dto.js` 报 `foundDtoIn: null` —— 新外壳不再把完整 DTO 挂到 window 上，
  只剩 `courseDto` / `courseCardDto` 和知识图谱的 `__MOOC_BUSINESS_API_PROXY_PATHS__`。
  这很容易被误判成"数据源没了"。

排除项：

- `courseCardDto.efficientTermId` 为 `null`、`efficientCourse: false` → 不是 SPOC 式的双 term；
- `proxy paths` 全是 `mocKgBean.*`（知识图谱），与作业无关；
- 页面的钩子容器 `#mooc-hook-data` 为空 → 那 3 条来自 SW 自己的 fetch，不在页面钩子覆盖范围内。

## 2. 决定性证据：DTO 是完整的

在课程页 Console 直接复现 `getLastLearnedMocTermDto`（`{termId:1488158441}`）：

```
chapters = 8（第1周…第8周），每章 hw=1 quiz=1
节点总数 = 16，有信号 = 16，不同名字 = 3
不同名字 = ['本周作业','本周测验','本周测试']
```

16 个节点全部有 `deadline`、`contentType` 分别是 3 / 2，**类型门槛一个都没拦**。
而界面条数正好等于"不同名字"的数量 —— 这说明是**按名字去重**吃掉的。

## 3. 根因

`extractHomeworkFromTermDto` 末尾的去重（两份拷贝都有）：

```js
if (nameB && nameA.indexOf(nameB) === 0 && nameA.length - nameB.length <= 2) out.splice(i, 1);
```

它比较的是 `title`，**完全不看 chapterId/lessonId**。这段逻辑本来是给
「期末测试题」vs「期末测试」这种噪音准备的，默认"同名 = 重复"。

平台这次把八周的作业都命名为「本周作业」（测验同理），于是第 2~8 周的同名条目
全部被当成重复删除，只留下每章第一次出现的那一条 —— 也就是用户看到的"只抓到前几条"。
留下的 `ch1252615054` / `ch1252615057` 不是"前两章"，只是**第一个叫这个名字的章**。

## 4. 修复

去重改成**只在同一个 `chapterId + lessonId` 容器内**合并：

- 跨章同名一律保留；
- 没有 `chapterId` 的节点不参与合并（宁可留重复，也不丢真实条目）；
- 容器内仍按"长名字是短名字的扩大版且差 ≤2 字"丢掉长的，保持原意图。

两份拷贝同步修改（不变量 12）：`src/shared/icourse163-api.js` 与 SW 内联的
`apiExtractHomework`，两处代码文本保持一致，便于以后 diff。

## 5. 测试

- `tests/unit/icourse163-api.test.mjs`：
  - 8 章同名「本周作业/本周测验」→ 16 条，8 个不同 chapterId；
  - 同章「期末测试」vs「期末测试题」→ 仍然只留 1 条。
- `tests/unit/service-worker.integration.test.mjs`：走 `COURSE_API_DATA` 验证**运行时内联副本**
  同样保留 16 条（防止两份再次漂移）。
- `npm run validate` 全绿（158 tests）。

## 6. 没改什么

没有放宽 contentType 门槛，也没有改 termId / 路由。`chapterCount=8`、16 个节点全都
`contentType ∈ {2,3}` —— 这次和"新类型"无关。以后再遇到"某门课少几条"，先看
**留下的名字是不是高度重复**，再决定查去重还是查门槛。
