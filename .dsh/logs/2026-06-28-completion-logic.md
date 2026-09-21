# 作业类型判定 + 完成检测逻辑（最终定型）— 2026-06-28

## 一、作业类型判定（提取哪些节点）

递归遍历整个 API JSON（～200KB），对每个节点判断两个条件：

### 条件1：有信号（hasSignal）

```javascript
const deadlineMs = apiFirstNumber(node, API_DEADLINE_FIELDS)
                || (node.test ? apiFirstNumber(node.test, API_DEADLINE_FIELDS) : null);
const score = apiFirstNumber(node, API_SCORE_FIELDS)
           || (node.test ? apiFirstNumber(node.test, API_SCORE_FIELDS) : null);
const totalScore = apiFirstNumber(node, API_TOTAL_FIELDS)
                || (node.test ? apiFirstNumber(node.test, API_TOTAL_FIELDS) : null);
const hasSignal = deadlineMs != null || (score != null && totalScore != null);
```

`firstNumber` 在目标字段列表中找第一个 `> 0` 的数值。

### 条件2：类型匹配

```javascript
var ct = String(node.contentType || '');
var ctIsAssessed = ct === '2' || ct === '3' || ct === '6';
if (typeof name === 'string' && name.trim() && hasSignal &&
    (ctIsAssessed || (!ct && /测验|作业|考试|测试|quiz|exam|homework|test/i.test(name)))) {
```

**`contentType` 是权威字段：**
- `2` → 测验（quiz）
- `3` → 作业（homework）
- `6` → 考试（exam）

名字正则**仅当 `contentType` 空缺时**才启用，防止"期末考试"因名字含"测试"被额外提取。

### 提取后分类

```javascript
type: apiClassifyType(name, node.contentType || nt2.type || null)
```

`contentType` 优先，`node.test.type` 后备，名字正则最终兜底。

---

## 二、完成判定（done）

三个独立路径，任一满足即完成：

```javascript
var done = (score != null && totalScore != null && score > 0)  // ① 有成绩
        || (submitted && !inPeerReview)                         // ② 已提交且互评没卡住
        || apiHasCompletedText(node, 0);                        // ③ API 文本标记
```

### 路径①：有成绩

直接依赖条件1中的 `score`（已含 `node.test` 后备）。API 不给没做的考评分数，有成绩就是做完了。

### 路径②：已提交

```javascript
var nType = parseInt(node.type || nt2.type || node.contentType, 10);
var submitted = parseInt(node.usedTryCount || nt2.usedTryCount, 10) > 0
            && (nType === 3 || nType === 6);
```

`usedTryCount` 从顶层和 `node.test` 读取，作业(type:3)和考试(type:6)的提交被认可。测验(type:2)不走此路径（由路径①覆盖）。

### 路径③：文本标记

递归检查节点或其子节点是否含`已完成/已成功提交/已提交/已批阅/已通过/已互评/查看成绩/查看分数`。

### 互评拦截

```javascript
var inPeerReview = apiDetectPhase(node) === 'peerreview'
                && (parseInt(node.scorePubStatus || nt2.scorePubStatus, 10) || 0) === 0;
```

当互评进行中时，路径②的 `submitted` 被 `inPeerReview` 阻止，等待手动确认。

---

## 三、互评阶段检测（apiDetectPhase）

```javascript
function apiDetectPhase(node) {
  var nt = node.test || {};
  var t = String(node.type || nt.type || '');
  if (t !== '3') return null;                           // 仅作业有互评
  var e = node.enableEvaluation != null ? node.enableEvaluation : nt.enableEvaluation;
  var es = node.evaluateStart != null ? node.evaluateStart : nt.evaluateStart;
  if (!e || es == null) return null;                     // 没启用互评或没开始时间
  var pub = parseInt(node.scorePubStatus != null ? node.scorePubStatus : nt.scorePubStatus, 10) || 0;
  if (pub === 2) return 'results';
  if (pub === 1) return 'results';                       // 窗口关闭→过期当完成
  var now = Date.now();
  var start = parseInt(es, 10);
  var end = parseInt((node.evaluateScoreReleaseTime || nt.evaluateScoreReleaseTime)
          || (node.evaluateEnd || nt.evaluateEnd), 10);
  if (start && now < start) return 'submit';
  if (end && now >= end) return 'results';
  return 'peerreview';
}
```

所有字段查 `node.test` 后备（部分 SPOC 课程字段在 test 子对象中）。`scorePubStatus` 的三种状态：
- `0` → 互评窗口开放中
- `1` → 窗口已关闭（过期当完成）
- `2` → 成绩已公布

### 完成判定表

| 类型 | 条件 | 判定 |
|---|---|---|
| 测验 (type:2) | `userScore > 0` | 完成 |
| 考试 (type:6) | `userScore > 0` | 完成（标签显示"手动确认"） |
| 考试 (type:6) | `usedTryCount > 0` 且有成绩 | 完成 |
| 作业 (type:3) 无互评 | `usedTryCount > 0` | 完成 |
| 作业 (type:3) 互评中 | `scorePubStatus:0 + now < evaluateEnd` | **未完成**（手动确认） |
| 作业 (type:3) 互评窗口过期 | `scorePubStatus:1` | 完成 |
| 作业 (type:3) 成绩已公布 | `scorePubStatus:2` | 完成 |

---

## 四、node.test 后备规则

| 用途 | 读 node.test？ | 原因 |
|------|:---:|------|
| `hasSignal`（判断是否提取） | ✅ | 部分课程 deadline/score 在 test 里 |
| `apiDetectPhase`（互评阶段） | ✅ | `scorePubStatus`/`evaluateStart` 可能在 test |
| `submitted`（已提交） | ✅ | `usedTryCount`/`type` 可能在 test |
| `classifyType`（类型分类） | ✅ `node.contentType` 优先 | `test.type` 作为后备 |
| `doneScore`（完成用成绩） | ✅ | 考试/测验成绩可能在 test |
| 名字正则提取 | ❌ 仅 `contentType` 空缺时 | 防止"期末考试"被名字正则误匹配 |

所有的后备都走 `node.xxx || node.test?.xxx`——顶层有就用顶层，没有才用 test，原值不受影响。

---

## 五、考试手动确认

考试标签在 popup 中显示「手动确认」（琥珀色），与互评作业同款样式：

```javascript
if ((item.type === 'homework' && item.hwPhase === 'peerreview') || item.type === 'exam')
```

完成逻辑不变（成绩/提交仍自动检测），仅标签区分。

---

## 六、关键文件

```
src/background/service-worker.js  — apiExtractHomework + apiDetectPhase + completion 逻辑
src/shared/icourse163-api.js       — extractHomeworkFromTermDto（同步维护）
src/popup/popup.js                 — 标签渲染（手动确认 vs 自动检测）
```
