/**
 * URL Observer — detects hash route changes on icourse163.org SPA.
 *
 * icourse163.org uses hash-based routing for course pages:
 *   #/learn/content  → course content (chapters & homework)
 *   #/learn/announce → course announcements
 *   #/learn/score    → grades page
 *   #/learn/quiz/*   → quiz pages
 *
 * Because the SPA doesn't reload the page, we need to detect
 * navigation by monitoring hash changes and history API calls.
 */

export class HashUrlObserver {
  /**
   * @param {Object} options
   * @param {Function} options.onRouteChange - called with new route string on change
   * @param {number} [options.pollIntervalMs=500] - fallback polling interval
   */
  constructor({ onRouteChange, pollIntervalMs = 500 }) {
    this.onRouteChange = onRouteChange;
    this.pollIntervalMs = pollIntervalMs;
    this.currentRoute = this._getRoute();
    this._pollTimer = null;
    this._started = false;
  }

  /**
   * Start observing URL changes.
   */
  start() {
    if (this._started) return;
    this._started = true;

    // Layer 1: hashchange event (catches most navigations)
    window.addEventListener('hashchange', this._onHashChange.bind(this));

    // Layer 2: Intercept history.pushState and replaceState
    this._patchHistoryAPI();

    // Layer 3: Periodic polling as fallback
    this._pollTimer = setInterval(() => {
      this._checkRoute();
    }, this.pollIntervalMs);

    // Initial check
    this._checkRoute();
  }

  /**
   * Stop observing.
   */
  stop() {
    if (!this._started) return;
    this._started = false;

    window.removeEventListener('hashchange', this._onHashChange.bind(this));
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._restoreHistoryAPI();
  }

  /**
   * Get current route immediately.
   * @returns {string}
   */
  getCurrentRoute() {
    return this._getRoute();
  }

  // ─── Private Methods ──────────────────────────────────

  _getRoute() {
    const hash = window.location.hash;
    if (!hash || hash === '#') return '';
    // Remove leading '#'
    return hash.startsWith('#/') ? hash.slice(1) : hash.slice(1);
  }

  _onHashChange() {
    this._checkRoute();
  }

  _checkRoute() {
    const newRoute = this._getRoute();
    if (newRoute !== this.currentRoute) {
      const oldRoute = this.currentRoute;
      this.currentRoute = newRoute;
      if (this.onRouteChange) {
        this.onRouteChange(newRoute, oldRoute);
      }
    }
  }

  _patchHistoryAPI() {
    const self = this;
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const result = origPushState.apply(this, args);
      self._checkRoute();
      return result;
    };

    history.replaceState = function (...args) {
      const result = origReplaceState.apply(this, args);
      self._checkRoute();
      return result;
    };

    // Store originals for cleanup
    this._origPushState = origPushState;
    this._origReplaceState = origReplaceState;
  }

  _restoreHistoryAPI() {
    if (this._origPushState) {
      history.pushState = this._origPushState;
      this._origPushState = null;
    }
    if (this._origReplaceState) {
      history.replaceState = this._origReplaceState;
      this._origReplaceState = null;
    }
  }
}
