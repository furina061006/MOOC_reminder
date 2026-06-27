// SPOC 真实 termId 读取器 — 作为 web_accessible_resource 注入
// 在页面上下文中执行，读取 window.moocTermDto.id
// 结果存到 <html data-mooc-real-termid> 供 content script 读取
(function() {
  try {
    var tid = window.moocTermDto ? String(window.moocTermDto.id) : '';
    if (tid) {
      document.documentElement.setAttribute('data-mooc-real-termid', tid);
    }
  } catch(e) {}
})();
