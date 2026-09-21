# icourse163 平台与 API

> 入口索引与工作约定在仓库根目录 [`AGENTS.md`](../../AGENTS.md)；本文件是 `.dsh/agents/` 知识库的一部分。

## icourse163.org 平台

### URL 模式
- MOOC 课程: `https://www.icourse163.org/learn/{school}-{courseId}?tid={termId}#/learn/content`
- SPOC 课程: `https://www.icourse163.org/spoc/learn/{school}-{courseId}?tid={termId}#/learn/content`
- Hash 路由: `#/learn/content`, `#/learn/quiz`, `#/learn/exam` 等

### SPA 特征
- Hash-based routing，无页面重载
- XHR/fetch 动态加载内容，异步渲染
- DOM 类名: `j-` (JS hooks), `m-` (modules), `u-` (utilities)

### CSRF 认证

`NTESSTUDYSI` cookie 用作 CSRF token，加到 API URL 的 `?csrfKey=` 参数。

**⚠️ 该 cookie 是 HttpOnly**，`document.cookie` 读不到。必须用：

```javascript
const cookie = await chrome.cookies.get({
  name: 'NTESSTUDYSI',
  url: 'https://www.icourse163.org/'
});
const csrf = cookie?.value || '';

// Fallback（非 HttpOnly 时还能用）
const m = document.cookie.match(/NTESSTUDYSI=([a-z0-9]+);?/i);
if (!csrf && m) csrf = m[1];
```

需要 manifest 权限: `"cookies"` + `"host_permissions": ["https://www.icourse163.org/*"]`

---

## API 端点

### 主端点: getLastLearnedMocTermDto.rpc

```
POST https://www.icourse163.org/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey={csrf}
Content-Type: application/json;charset=UTF-8
Body: {"termId": 1476504498}
```

返回 ~200KB JSON，结构为 `result.mocTermDto.chapters[]`，每个 chapter 含 `homeworks[]`、`quizs[]`、`exam`。

每个 homework/quiz 节点含 `test` 对象，包含分数、截止日期、互评状态等全部字段。

这是**唯一对 SPOC 可用的端点**（需要真实 termId）。

### 辅助端点: getOpenHomeworkInfo.rpc

```
POST https://www.icourse163.org/web/j/mocQuizRpcBean.getOpenHomeworkInfo.rpc?csrfKey={csrf}
Content-Type: application/json;charset=UTF-8
Body: {"tid": 1247802197, "aid": null, "isDraft": false}
```

返回单个作业的详细信息，含 `submitStatus`（作业提交状态）等补充字段。

### 端点可用性矩阵

| 端点 | MOOC | SPOC |
|---|---|---|
| `getLastLearnedMocTermDto.rpc` | ✅ | ✅ (仅真实 termId) |
| `getMocTermDto.rpc` (+gatewayType=3) | ✅ | ❌ code:-1007 |
| `getMocTermDto.rpc` DWR | ❌ | ❌ |
| `getSpocTermDto.rpc` | — | ❌ code:-1004 |
| `getOpenHomeworkInfo.rpc` | ✅ | ❌ code:-1007 |

---

## API 字段参考

### NODE 层 (getLastLearnedMocTermDto — chapter.homeworks[n])

```
id, gmtCreate, gmtModified, name, position, termId, chapterId,
contentType, contentId, isTestChecked, units, releaseTime,
viewStatus, testDraftStatus, test, isModify, visible
```

- `contentType`: 2=quiz, 3=homework, 6=exam
- `contentId`: 用作 `getOpenHomeworkInfo` 的 `tid` 参数
- `test`: 包含所有状态字段，见 TEST 层

### TEST 层 (node.test)

```
id, releaseTime, type, name, deadline, testTime, trytime,
usedTryCount, evaluateJudgeType, evaluateNeedTrain,
evaluateStart, evaluateEnd, evaluateScoreReleaseTime,
scorePubStatus, enableEvaluation, userScore, totalScore,
bonusScore, examId
```

- `type`: 2=quiz, 3=homework, 6=exam
- `usedTryCount`: >0 = 已提交
- `scorePubStatus`: 0=互评中, 1=窗口关闭, 2=已公布
- `evaluateStart/End`: 互评时间窗口 (ms)
- `evaluateScoreReleaseTime`: 成绩公布时间
- `enableEvaluation`: 是否启用互评
- `evaluateJudgeType`: 1=学生互评, 其他=教师评阅

### getOpenHomeworkInfo.result 层

```
tid, aid, deadline, evaluateStart, evaluateEnd, evaluateJudgeType,
evaluateScoreReleaseTime, name, description, releaseTime,
submitStatus, evaluateNeedTrain, scorePubStatus, duration,
startTime, questionCount, totalScore, allowSwitchPageCount,
switchPageCount
```

- `submitStatus`: null=未打开, 1=草稿, 2=已提交 — **只追作业提交，不追互评完成**
- `aid`: attempt/answer ID
- `startTime`: 用户开始作答时间

---
