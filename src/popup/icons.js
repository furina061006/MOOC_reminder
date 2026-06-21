/**
 * Inline SVG icon system — MOOC Reminder
 *
 * A tiny, dependency-free, CSP-safe icon set shared by the popup and the
 * options page. No build step, no font, no emoji. Each icon is a stroked
 * 24×24 glyph that inherits the surrounding text color via `currentColor`,
 * so it themes automatically (including dark mode).
 *
 * Usage:
 *   element.innerHTML = window.MOOC_ICON('refresh', { size: 16 });
 *   // or declaratively in HTML:  <span data-icon="refresh" data-icon-size="18"></span>
 *   //   then call window.MOOC_HYDRATE_ICONS(root) once.
 *
 * This file is a plain script (not a module) and attaches its API to
 * `window` so script-mode consumers reference it without tripping no-undef.
 */
(function () {
  'use strict';

  // Inner SVG body for each glyph (paths use stroke = currentColor).
  var GLYPHS = {
    refresh:
      '<path d="M21.5 2v6h-6"/><path d="M2.5 22v-6h6"/>' +
      '<path d="M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    'check-circle':
      '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>' +
      '<polyline points="22 4 12 14.01 9 11.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
    'alert-triangle':
      '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
      '<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    'alert-circle':
      '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/>' +
      '<line x1="12" y1="16" x2="12.01" y2="16"/>',
    info:
      '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/>' +
      '<line x1="12" y1="8" x2="12.01" y2="8"/>',
    lock:
      '<rect x="4" y="11" width="16" height="10" rx="2"/>' +
      '<path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    sparkles:
      '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/>' +
      '<path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"/>',
    trash:
      '<polyline points="3 6 5 6 21 6"/>' +
      '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
      '<path d="M10 11v6M14 11v6"/>' +
      '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
    'chevron-right': '<polyline points="9 6 15 12 9 18"/>',
    'external-link':
      '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
      '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    calendar:
      '<rect x="3" y="4" width="18" height="18" rx="2"/>' +
      '<line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>' +
      '<line x1="3" y1="10" x2="21" y2="10"/>',
    bell:
      '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>' +
      '<path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    'bell-off':
      '<path d="M13.73 21a2 2 0 0 1-3.46 0"/>' +
      '<path d="M18.63 13A17.89 17.89 0 0 1 18 8"/>' +
      '<path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/>' +
      '<path d="M18 8a6 6 0 0 0-9.33-5"/>' +
      '<line x1="1" y1="1" x2="23" y2="23"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 9 0 0 0 21 12.79z"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    book:
      '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>' +
      '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    edit:
      '<path d="M12 20h9"/>' +
      '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>'
  };

  /**
   * Build an inline SVG string for a named icon.
   * @param {string} name  glyph key (falls back to a dot if unknown)
   * @param {{size?:number, strokeWidth?:number, className?:string}} [opts]
   * @returns {string} SVG markup safe to drop into innerHTML
   */
  function icon(name, opts) {
    opts = opts || {};
    var size = opts.size || 16;
    var stroke = opts.strokeWidth || 2;
    var extra = opts.className ? ' ' + opts.className : '';
    var body = GLYPHS[name] || GLYPHS.dot;
    return (
      '<svg class="icon icon-' + name + extra + '" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + stroke +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      body + '</svg>'
    );
  }

  /**
   * Replace every <… data-icon="name"> placeholder under `root` with its SVG.
   * `data-icon-size` overrides the pixel size. Idempotent (skips hydrated nodes).
   * @param {ParentNode} [root=document]
   */
  function hydrateIcons(root) {
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-icon]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.getAttribute('data-icon-hydrated') === '1') continue;
      var name = el.getAttribute('data-icon');
      var size = parseInt(el.getAttribute('data-icon-size'), 10);
      el.innerHTML = icon(name, { size: isNaN(size) ? undefined : size });
      el.setAttribute('data-icon-hydrated', '1');
    }
  }

  window.MOOC_ICON = icon;
  window.MOOC_HYDRATE_ICONS = hydrateIcons;
})();
