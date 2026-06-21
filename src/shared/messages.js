/**
 * Message protocol definitions for communication between
 * Content Script, Background Service Worker, and Popup.
 */

// Message types — use these constants everywhere to avoid typos
export const MSG_TYPES = {
  // Content script → Background: scraped homework data
  HOMEWORK_DATA: 'HOMEWORK_DATA',

  // Popup → Background: mark an item as completed/uncompleted
  MARK_COMPLETED: 'MARK_COMPLETED',

  // Popup → Background: request current homework list
  GET_HOMEWORK: 'GET_HOMEWORK',

  // Popup → Background: trigger immediate scrape
  TRIGGER_SCRAPE: 'TRIGGER_SCRAPE',

  // Popup → Background: remove all completed items from storage
  CLEAR_COMPLETED: 'CLEAR_COMPLETED',

  // Background → Content script: request immediate DOM scrape
  SCRAPE_NOW: 'SCRAPE_NOW',

  // Background → Popup: badge needs refresh
  REFRESH_BADGE: 'REFRESH_BADGE',

  // Options page ↔ Background: read / persist user settings
  GET_SETTINGS: 'GET_SETTINGS',
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',

  ADD_MANUAL_ITEM: 'ADD_MANUAL_ITEM',
  SNOOZE_ITEM: 'SNOOZE_ITEM',
  TOGGLE_COURSE_MUTE: 'TOGGLE_COURSE_MUTE',
  GET_POPUP_STATE: 'GET_POPUP_STATE',
  SET_POPUP_STATE: 'SET_POPUP_STATE'
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

    case MSG_TYPES.ADD_MANUAL_ITEM:
      if (!payload || typeof payload.title !== 'string' || typeof payload.deadline !== 'string') {
        return { valid: false, error: 'ADD_MANUAL_ITEM requires {title, deadline}' };
      }
      break;

    case MSG_TYPES.SNOOZE_ITEM:
      if (!payload || typeof payload.homeworkUid !== 'string') {
        return { valid: false, error: 'SNOOZE_ITEM requires {homeworkUid}' };
      }
      break;

    case MSG_TYPES.TOGGLE_COURSE_MUTE:
      if (!payload || typeof payload.courseId !== 'string') {
        return { valid: false, error: 'TOGGLE_COURSE_MUTE requires {courseId}' };
      }
      break;

    case MSG_TYPES.SET_POPUP_STATE:
      if (!payload || typeof payload.uiState !== 'object') {
        return { valid: false, error: 'SET_POPUP_STATE requires {uiState}' };
      }
      break;

    case MSG_TYPES.CLEAR_COMPLETED:
    case MSG_TYPES.SCRAPE_NOW:
    case MSG_TYPES.REFRESH_BADGE:
    case MSG_TYPES.GET_SETTINGS:
    case MSG_TYPES.GET_POPUP_STATE:
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
