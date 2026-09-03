/* Inject the page-context hook as an external extension resource. Inline
 * script elements are blocked by icourse163.org's Content Security Policy. */
(function () {
  'use strict';
  var script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/content/xhr-hook-page.js');
  script.onload = function () { script.remove(); };
  script.onerror = function () { script.remove(); };
  (document.head || document.documentElement).appendChild(script);
})();
