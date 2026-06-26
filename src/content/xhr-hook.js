/**
 * XHR/Fetch Hook — MOOC Reminder (document_start)
 *
 * Injects page-context hooks BEFORE the page's JavaScript runs.
 * Intercepts getLastLearnedMocTermDto responses to capture the full
 * course data while it's still fresh (before it gets truncated to
 * lastLearnUnitId-based filtering).
 *
 * Data is saved to window.__moocFullTermData for main.js to read.
 */

(function() {
  'use strict';

  var SCRIPT = '(' + function() {
    'use strict';

    // Target endpoints we want to capture
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

    // Storage for captured responses
    window.__moocFullTermData = window.__moocFullTermData || {};
    window.__moocHookLog = window.__moocHookLog || [];

    // ─── Hook XMLHttpRequest ───
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    var origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    var origOverrideMimeType = XMLHttpRequest.prototype.overrideMimeType;

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
              // 提取 termId 作为 key
              var termMatch = url.match(/[?&]tid=(\d+)/) || (body && typeof body === 'string' ? body.match(/termId[=:]\s*"?(\d+)/) : null);
              var tid = termMatch ? termMatch[1] : 'unknown';
              window.__moocFullTermData[tid] = { url: url, body: body ? String(body).substring(0, 200) : '', response: resp, time: Date.now() };
              window.__moocHookLog.push({ url: url, len: resp.length, tid: tid, time: Date.now() });
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
              var termMatch = url.match(/[?&]tid=(\d+)/);
              var tid = termMatch ? termMatch[1] : 'unknown';
              window.__moocFullTermData[tid] = { url: url, body: init && init.body ? String(init.body).substring(0, 200) : '', response: text, time: Date.now() };
              window.__moocHookLog.push({ url: url, len: text.length, tid: tid, time: Date.now() });
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
