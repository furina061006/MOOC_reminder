注: 有追评,都是未完成任务,需要继续修复
- 有的时候导入会发生错误,这个错误出现在界面上不久后建议可以叉掉,会影响观感, 这个可以在设置里面加个选项, 选择是否清除错误提示,还想在设置网页,专门有一页放错误报告
    追评: 加载出来,但是清除所有错误没用,有显示"错误已清除"但没有真正清除

- # MOOC Reminder v1.0.0 完整故障报告
记录时间：2026-06-23
插件同时出现两类连锁故障：浏览器扩展前端JS运行报错 + MOOC接口403鉴权失败

## 第一部分：浏览器控制台6条前端报错
完整报错清单：
1. [Options] loadSettings failed: Cannot set properties of null (setting 'checked')
2. [Options] init failed: Cannot set properties of null (setting 'checked')
3. [Options] loadSettings failed: Cannot set properties of null (setting 'checked')
4. [Options] init failed: Cannot set properties of null (setting 'checked')
5. Uncaught (in promise) Error: Uncaught TypeError: Cannot read properties of undefined (reading 'id')
6. [MOOC Reminder] Failed to send data to background: Error: Extension context invalidated.

### 报错连锁逻辑
1. 根源致命错误：Extension context invalidated（扩展上下文失效）
页面脚本调用chrome.runtime.sendMessage和后台通信时，浏览器销毁了插件运行环境，直接导致存储读取、跨脚本消息通道全部断开，衍生所有其他报错。
2. 4条重复的设置页报错
loadSettings、页面init初始化时，代码直接给DOM复选框赋值.checked，但获取元素得到null；诱因两点：①JS执行早于DOM渲染完成，未等待DOMContentLoaded；②上下文失效后读取存储配置为空，操作不存在的DOM元素。
3. Promise未捕获空数据报错
接口/存储返回undefined数据，代码直接读取.id属性，无空值保护、无全局Promise异常捕获。

### 前端修复需求
1. 封装通用chrome.runtime.sendMessage工具函数，捕获上下文失效异常，增加降级提示逻辑；
2. 重构设置页options初始化逻辑：所有DOM、存储操作包裹在DOMContentLoaded事件内，操作DOM前强制判空，读取storage时设置默认兜底配置；
3. 全局监听未捕获Promise拒绝，所有对象属性访问使用可选链?.，解决读取id空指针崩溃；
4. 增加防御判断，上下文失效后停止重复执行无效逻辑，避免批量重复刷屏报错。

## 第二部分：MOOC课程刷新接口403错误日志
完整接口报错记录：
2026/6/23 23:40:48
API refresh failed: [{"courseId":"NEU-1001956020","termId":"1476748448","message":"termDto: all endpoints failed","details":{"termId":"1476748448","errors":[{"endpoint":"web/j/courseBean.getMocTermDto.rpc","status":403,"body":" "},{"endpoint":"dwr/call/plaincall/CourseBean.getMocTermDto.dwr","status":403,"body":" "}]}},{"courseId":"NEU-1474956162","termId":"1476735472","message":"termDto: all endpoints failed","details":{"termId":"1476735472","errors":[{"endpoint":"web/j/courseBean.getMocTermDto.rpc","status":403,"body":" "},{"endpoint":"dwr/call/plaincall/CourseBean.getMocTermDto.dwr","status":403,"body":" "}]}}]
2026/6/23 23:35:36
API refresh failed: [{"courseId":"NEU-1001956020","termId":"1476748448","message":"termDto: all endpoints failed","details":{"termId":"1476748448","errors":[{"endpoint":"web/j/courseBean.getMocTermDto.rpc","status":403,"body":" "},{"endpoint":"dwr/call/plaincall/CourseBean.getMocTermDto.dwr","status":403,"body":" "}]}}]

### 接口错误分析
HTTP 403 禁止访问：MOOC服务端拒绝所有getMocTermDto接口请求，登录会话Cookie/Token过期失效；两套备用接口全部鉴权失败，无法拉取两门课程（NEU-1001956020、NEU-1474956162）的学期数据。
接口返回空/undefined原始数据，直接触发前端读取id的Promise崩溃。

### 接口层修复需求
1. 请求接口前先校验登录鉴权状态，Token失效时弹窗引导用户重新登录，而非静默崩溃；
2. 所有网络请求统一捕获403状态码，区分登录失效和普通网络错误；
3. 接口请求失败后返回兜底空数据，避免undefined流入下游业务代码；
4. 课程自动刷新增加指数退避重试，限制频繁重复刷新，减少大量403无效请求。

## 全部故障完整关联链路
1. 用户刷新MOOC页面/重载插件 → 扩展上下文失效
2. 插件运行环境损坏 + MOOC登录凭证过期 → 接口请求返回403空数据
3. 前端拿到undefined接口数据 → Promise读取.id抛出未捕获异常
4. 存储读取因上下文失效失败 → 设置页操作空复选框DOM，重复刷屏报错
5. 插件全部提醒、同步功能彻底失效

## 复现步骤
1. 在chrome://extensions/页面重载MOOC Reminder插件
2. 打开对应MOOC课程网页
3. 触发课程数据自动刷新
4. 控制台立刻出现6条前端报错，同时打印多条接口403失败日志

