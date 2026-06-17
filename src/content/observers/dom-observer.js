/**
 * DOM Observer — waits for specific DOM elements to appear before scraping.
 *
 * icourse163.org loads content asynchronously after hash navigation.
 * This observer uses MutationObserver to detect when the target content
 * has rendered, and optionally waits for loading spinners to disappear.
 */

export class ContentReadyObserver {
  /**
   * @param {Object} options
   * @param {Object} options.selectors - Primary + fallback selectors to watch for
   * @param {string[]} [options.loadingSelectors] - Loading indicators to wait for disappearance
   * @param {number} [options.stableTimeMs=500] - Wait for DOM to stabilize (no mutations for this duration)
   */
  constructor({ selectors, loadingSelectors = [], stableTimeMs = 500 }) {
    this.selectors = selectors;
    this.loadingSelectors = loadingSelectors;
    this.stableTimeMs = stableTimeMs;
    this._observer = null;
    this._stableTimer = null;
  }

  /**
   * Wait for content to appear. Resolves when the target selector matches
   * an element, or rejects after timeoutMs.
   *
   * @param {number} [timeoutMs=10000] - Maximum time to wait
   * @returns {Promise<Element>} The found element
   */
  waitForContent(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      // Check if content is already present
      const existing = this._findElement();
      if (existing) {
        resolve(existing);
        return;
      }

      const timeout = setTimeout(() => {
        this._cleanup();
        reject(new Error(`Timeout waiting for content after ${timeoutMs}ms. Selectors: ${JSON.stringify(this.selectors)}`));
      }, timeoutMs);

      // Watch for DOM changes
      this._observer = new MutationObserver(() => {
        const el = this._findElement();
        if (el && !this._isLoading()) {
          // Wait for DOM to stabilize before resolving
          clearTimeout(this._stableTimer);
          this._stableTimer = setTimeout(() => {
            clearTimeout(timeout);
            this._cleanup();
            resolve(el);
          }, this.stableTimeMs);
        }
      });

      this._observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: false,
        characterData: false
      });
    });
  }

  /**
   * Check if the target element currently exists in the DOM.
   * @returns {Element|null}
   */
  isContentReady() {
    return !!this._findElement();
  }

  /**
   * Check if loading indicators are still visible.
   * @returns {boolean}
   */
  isLoading() {
    return this._isLoading();
  }

  /**
   * Disconnect the observer.
   */
  disconnect() {
    this._cleanup();
  }

  // ─── Private Methods ──────────────────────────────────

  _findElement() {
    // Try primary selector first
    if (this.selectors.primary) {
      const el = document.querySelector(this.selectors.primary);
      if (el) return el;
    }
    // Try fallback selectors
    if (this.selectors.fallback) {
      for (const sel of this.selectors.fallback) {
        try {
          const el = document.querySelector(sel);
          if (el) return el;
        } catch {
          // Invalid selector, skip
        }
      }
    }
    return null;
  }

  _isLoading() {
    if (!this.loadingSelectors || this.loadingSelectors.length === 0) return false;
    return this.loadingSelectors.some(sel => {
      try {
        const el = document.querySelector(sel);
        return el && el.offsetParent !== null; // visible
      } catch {
        return false;
      }
    });
  }

  _cleanup() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
      this._stableTimer = null;
    }
  }
}
