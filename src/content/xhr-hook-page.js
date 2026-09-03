/* Page-context API hook. Loaded as an external extension resource so the
 * host page's CSP does not reject an inline script element. */
(function () {
  'use strict';

  function captureRealTermId() {
    try {
      var realId = (window.moocTermDto && window.moocTermDto.id) || (window.termDto && window.termDto.id);
      if (realId) document.documentElement.setAttribute('data-mooc-real-termid', String(realId));
    } catch {}
  }

  captureRealTermId();
  document.addEventListener('DOMContentLoaded', captureRealTermId);

  var TARGET_PATTERNS = [
    'getLastLearnedMocTermDto.rpc',
    'getMocTermDto.rpc',
    'getOpenHomeworkInfo.rpc'
  ];

  function isTarget(url) {
    if (typeof url !== 'string') return false;
    return TARGET_PATTERNS.some(function (pattern) { return url.indexOf(pattern) >= 0; });
  }

  function getContainer() {
    var container = document.getElementById('mooc-hook-data');
    if (!container) {
      container = document.createElement('div');
      container.id = 'mooc-hook-data';
      container.style.display = 'none';
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  function storeEntry(entry) {
    try {
      var container = getContainer();
      var existing = container.getAttribute('data-items');
      var items = existing ? JSON.parse(existing) : [];
      if (items.length < 10) {
        items.push(entry);
        container.setAttribute('data-items', JSON.stringify(items));
      }
    } catch {}
  }

  function extractTid(url, body) {
    var realTid = document.documentElement.getAttribute('data-mooc-real-termid');
    var tidMatch = typeof url === 'string' && url.match(/[?&]tid=(\d+)/);
    if (!tidMatch && body && typeof body === 'string') tidMatch = body.match(/termId[=:]\s*"?(\d+)/);
    return tidMatch ? tidMatch[1] : (realTid || 'unknown');
  }

  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__mooc_url = url;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var self = this;
    if (isTarget(self.__mooc_url)) {
      self.addEventListener('load', function () {
        try {
          var response = self.responseText;
          if (response && response.length > 1000) {
            storeEntry({ url: self.__mooc_url, resp: response, time: Date.now(), tid: extractTid(self.__mooc_url, body) });
          }
        } catch {}
      });
    }
    return originalSend.apply(this, arguments);
  };

  var originalFetch = window.fetch;
  window.fetch = function (input) {
    var url = typeof input === 'string' ? input : (input && input.url);
    if (!isTarget(url)) return originalFetch.apply(this, arguments);
    return originalFetch.apply(this, arguments).then(function (response) {
      response.clone().text().then(function (text) {
        if (text && text.length > 1000) {
          storeEntry({ url: url, resp: text, time: Date.now(), tid: extractTid(url) });
        }
      }).catch(function () {});
      return response;
    });
  };
})();
