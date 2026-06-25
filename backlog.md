注: 有追评,都是未完成任务,需要继续修复

- [] 报错: 后台抓取失败：CSRF 令牌被拒，可能需要重新登录,这个没被设置界面里的错误报告抓取
  修复: setApiStatus(status='api_unavailable'/'api_no_session') 自动写入 sync_errors，设置页错误报告可见
    追评:还是没有

- [ ] 浏览器登录 icourse163.org，然后重新打开 popup 看一下, 但是 API  没有恢复
  此外疑似没有抓到getMocTermDto
  → 需要实际测试。在 MOOC 页面上打开 DevTools → Network，筛选 XHR，刷新页面，找到包含 termId 或 getMocTermDto 的请求，检查 URL 和响应
  追评:https://www.icourse163.org/mm-course/web/j/mocTermCertifiedBean.getMocCertifiedPopDto.rpc?csrfKey=44f823597ddd49fdb5c9baad7974016d是这条吗