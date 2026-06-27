// SPOC 真实 termId 读取器 — 作为 web_accessible_resource 注入
// 在页面上下文中执行，读取 window.moocTermDto.id
// 结果存到 <html data-mooc-real-termid> 供 content script 读取
(function() {
  try {
    var tid = '';

    // 第一优先级：直接 window 属性
    if (window.moocTermDto && window.moocTermDto.id) {
      tid = String(window.moocTermDto.id);
    }

    // 第二优先级：解析内联 <script> 中的 moocTermDto 对象
    // 部分 SPOC 课程可能不直接暴露 window.moocTermDto
    if (!tid) {
      var scripts = document.querySelectorAll('script:not([src])');
      for (var i = 0; i < scripts.length; i++) {
        var text = scripts[i].textContent || '';
        // 匹配: moocTermDto = { ... id: 1234567890 ... }
        var m = text.match(/moocTermDto\s*(?:=\s*new\s+\w+\s*[({]\s*|=\s*[{]\s*id\s*:\s*)(\d+)/);
        if (!m) m = text.match(/"moocTermDto"\s*:\s*\{[^}]*?"id"\s*:\s*(\d+)/);
        if (m) { tid = m[1]; break; }
      }
    }

    if (tid) {
      document.documentElement.setAttribute('data-mooc-real-termid', tid);
      console.log('[MOOC Reminder] SPOC tid bridge: real termId =', tid);
    } else {
      console.debug('[MOOC Reminder] SPOC tid bridge: no termId found');
    }
  } catch(e) {}
})();
