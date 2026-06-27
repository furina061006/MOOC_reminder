/**
 * Message protocol definitions for communication between
 * Content Script, Background Service Worker, and Popup.
 */

// Message types — use these constants everywhere to avoid typos
export const MSG_TYPES = {
  // Popup → Background: mark an item as completed/uncompleted
  MARK_COMPLETED: 'MARK_COMPLETED',

  // Popup → Background: request current homework list
  GET_HOMEWORK: 'GET_HOMEWORK',

  // Popup → Background: trigger immediate scrape
  TRIGGER_SCRAPE: 'TRIGGER_SCRAPE',

  // Popup → Background: remove all completed items from storage
  CLEAR_COMPLETED: 'CLEAR_COMPLETED',

  // Background → Popup: badge needs refresh
  REFRESH_BADGE: 'REFRESH_BADGE',

  // Options page ↔ Background: read / persist user settings
  GET_SETTINGS: 'GET_SETTINGS',
  SETTINGS_UPDATED: 'SETTINGS_UPDATED'
};

/**
 * Validate a message payload against expected shape.
 * Returns { valid: boolean, error: string | null }
 */
export function validateMessage(type, payload) {
  switch (type) {
    case MSG_TYPES.HOMEWORK_DATA:
      if (!payload || !payload.course || !Array.isArray(payload.homeworkItems)) {
        return { valid: false, error: 'HOMEWORK_DATA requires {course, homeworkItems[]}' };
      }
      break;

    case MSG_TYPES.MARK_COMPLETED:
      if (!payload || typeof payload.homeworkUid !== 'string' || typeof payload.checkedOff !== 'boolean') {
        return { valid: false, error: 'MARK_COMPLETED requires {homeworkUid: string, checkedOff: boolean}' };
      }
      break;

    case MSG_TYPES.GET_HOMEWORK:
    case MSG_TYPES.TRIGGER_SCRAPE:
    case MSG_TYPES.SETTINGS_UPDATED:
      if (!payload || typeof payload.settings !== 'object') {
        return { valid: false, error: 'SETTINGS_UPDATED requires {settings: object}' };
      }
      break;

    case MSG_TYPES.CLEAR_COMPLETED:
    case MSG_TYPES.SCRAPE_NOW:
    case MSG_TYPES.REFRESH_BADGE:
    case MSG_TYPES.GET_SETTINGS:
      // No payload required
      break;

    default:
      return { valid: false, error: `Unknown message type: ${type}` };
  }

  return { valid: true, error: null };
}

/**
 * Send a message to the background service worker.
 * Returns a Promise that resolves with the response.
 */
export function sendToBackground(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

/**
 * Send a message to a specific tab's content script.
 */
export async function sendToTab(tabId, type, payload = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type, ...payload });
  } catch (e) {
    // Tab may not have content script ready
    return null;
  }
}
