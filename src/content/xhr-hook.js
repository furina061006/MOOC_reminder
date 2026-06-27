/**
 * XHR/Fetch Hook — MOOC Reminder (document_start)
 *
 * Injects page-context hooks BEFORE the page's JavaScript runs.
 * Captures the REAL termId from window.moocTermDto and the
 * full API response, making them available to main.js via DOM bridge.
 */

(function() {
  'use strict';

  var SCRIPT = '(' + function() {
    'use strict';

    // ─── Read real termId from moocTermDto (server-rendered inline script) ───
    function captureRealTermId() {
      try {
        var realId = (window.moocTermDto && window.moocTermDto.id) || (window.termDto && window.termDto.id);
        if (realId) {
          document.documentElement.setAttribute('data-mooc-real-termid', String(realId));
          console.log('[MOOC] Real termId:', realId);
        }
      } catch(e) {}
    }

    // Try immediately and also after DOMContentLoaded
    captureRealTermId();
    document.addEventListener('DOMContentLoaded', captureRealTermId);

    // ─── Target endpoints ───
    var TARGET_PATTERNS = [
      'getLastLearnedMocTermDto.rpc',
      'getMocTermDto.rpc',
      'getOpenHomeworkInfo.rpc'
    ];

    function isTarget(url) {
      if (typeof url !== 'string') return false;
      for (var i = 0; i < TARGET_PATTERNS.length; i++) {
        if (url.indexOf(TARGET_PATTERNS[i]) >= 0) return true;
      }
      return false;
    }

    // ─── Hook XMLHttpRequest ───
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
      this.__mooc_url = url;
      this.__mooc_method = method;
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
      var self = this;
      var url = self.__mooc_url;
      if (isTarget(url)) {
        self.addEventListener('load', function() {
          try {
            var resp = self.responseText;
            if (resp && resp.length > 1000) {
              // Store full response on DOM for main.js to read
              var container = document.getElementById('mooc-hook-data');
              if (!container) {
                container = document.createElement('div');
                container.id = 'mooc-hook-data';
                container.style.display = 'none';
                document.body.appendChild(container);
              }
              // Store as JSON-encoded data-* on container
              var entry = { url: url, resp: resp, time: Date.now() };

              // Try multiple termId sources: URL param, request body, moocTermDto
              var realTid = document.documentElement.getAttribute('data-mooc-real-termid');
              var tidMatch = url.match(/[?&]tid=(\d+)/);
              if (!tidMatch && body && typeof body === 'string') tidMatch = body.match(/termId[=:]\s*"?(\d+)/);
              var tid = tidMatch ? tidMatch[1] : (realTid || 'unknown');

              entry.tid = tid;

              // Store in array on container
              var existing = container.getAttribute('data-items');
              var items = existing ? JSON.parse(existing) : [];
              // Cap at 10 items
              if (items.length < 10) {
                items.push(entry);
                container.setAttribute('data-items', JSON.stringify(items));
              }
            }
          } catch(e) {}
        });
      }
      return origSend.apply(this, arguments);
    };

    // ─── Hook fetch ───
    var origFetch = window.fetch;
    window.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url);
      if (isTarget(url)) {
        return origFetch.apply(this, arguments).then(function(response) {
          var clone = response.clone();
          clone.text().then(function(text) {
            if (text && text.length > 1000) {
              var container = document.getElementById('mooc-hook-data');
              if (!container) {
                container = document.createElement('div');
                container.id = 'mooc-hook-data';
                container.style.display = 'none';
                document.body.appendChild(container);
              }
              var realTid = document.documentElement.getAttribute('data-mooc-real-termid');
              var tidMatch = url.match(/[?&]tid=(\d+)/);
              var tid = tidMatch ? tidMatch[1] : (realTid || 'unknown');
              var entry = { url: url, resp: text, time: Date.now(), tid: tid };
              var existing = container.getAttribute('data-items');
              var items = existing ? JSON.parse(existing) : [];
              if (items.length < 10) {
                items.push(entry);
                container.setAttribute('data-items', JSON.stringify(items));
              }
            }
          }).catch(function(){});
          return response;
        });
      }
      return origFetch.apply(this, arguments);
    };
  }.toString() + ')();';

  // Inject into page context
  var script = document.createElement('script');
  script.textContent = SCRIPT;
  try {
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    console.log('[MOOC Reminder] XHR hook injected at document_start');
  } catch(e) {
    console.debug('[MOOC Reminder] XHR hook injection failed:', e.message);
  }
})();
