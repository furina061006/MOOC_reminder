import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Integration harness: import the REAL service worker module into Node with a
 * stubbed `chrome.*` surface, then drive its actual alarm handlers, message
 * handlers and notification-click listener. This covers the glue that pure
 * unit tests can't reach (badge tick → notify → storage write-back, snooze
 * interplay, PAGE_OPENED fan-out, digest retry).
 */

// ── chrome.* stub (must exist before the SW module is imported) ──────────

function makeChromeStub() {
  const storageData = new Map();
  const listeners = { onInstalled: [], onStartup: [], onMessage: [], onAlarm: [], onClicked: [] };
  const notificationsCreated = new Map();
  const tabsCreated = [];
  const tabMessages = [];
  const alarmsCreated = new Map();
  const badge = { text: null, color: null };
  let tabsQueryResult = [];

  const storage = {
    local: {
      async get(keys) {
        if (keys == null) {
          return Object.fromEntries(storageData);
        }
        if (typeof keys === 'string') {
          return storageData.has(keys) ? { [keys]: storageData.get(keys) } : {};
        }
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) if (storageData.has(k)) out[k] = storageData.get(k);
          return out;
        }
        const out = {};
        for (const k of Object.keys(keys)) out[k] = storageData.has(k) ? storageData.get(k) : keys[k];
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) storageData.set(k, v); },
      async clear() { storageData.clear(); }
    }
  };

  globalThis.chrome = {
    storage,
    runtime: {
      onInstalled: { addListener: fn => listeners.onInstalled.push(fn) },
      onStartup: { addListener: fn => listeners.onStartup.push(fn) },
      onMessage: { addListener: fn => listeners.onMessage.push(fn) },
      getURL(path) { return 'chrome-extension://test/' + path; }
    },
    alarms: {
      onAlarm: { addListener: fn => listeners.onAlarm.push(fn) },
      async get(name) { return alarmsCreated.get(name) || null; },
      async clear(name) { return alarmsCreated.delete(name); },
      async create(name, info) { alarmsCreated.set(name, info); }
    },
    notifications: {
      onClicked: { addListener: fn => listeners.onClicked.push(fn) },
      async getPermissionLevel() { return 'granted'; },
      async create(id, opts) { notificationsCreated.set(id, opts); return id; },
      async clear(id) { return notificationsCreated.delete(id); }
    },
    action: {
      async setBadgeText(o) { badge.text = o.text; },
      async setBadgeBackgroundColor(o) { badge.color = o.color; }
    },
    tabs: {
      async query() { return tabsQueryResult; },
      async create(o) { tabsCreated.push(o); return { id: tabsCreated.length }; },
      async sendMessage(tabId, msg) {
        tabMessages.push({ tabId, msg });
        // Simulate the content script reporting COURSE_API_DATA arrival so
        // performPeriodicScrape's last_sync wait loop exits quickly.
        if (msg && msg.type === 'BATCH_API_FETCH') {
          storageData.set('last_sync', new Date().toISOString());
        }
        return true;
      }
    },
    cookies: { async get() { return null; } }
  };

  return {
    storageData, listeners, notificationsCreated, tabsCreated, tabMessages,
    alarmsCreated, badge,
    setTabsQuery(tabs) { tabsQueryResult = tabs; }
  };
}

const h = makeChromeStub();
const fireAlarm = name => h.listeners.onAlarm[0]({ name });
const fireClick = id => h.listeners.onClicked[0](id);
function sendMessage(msg) {
  return new Promise(resolve => {
    h.listeners.onMessage[0](msg, {}, resolve);
  });
}
function seedItem(overrides) {
  const base = {
    uid: 'C1_tid1_ch_le_hw1',
    courseId: 'C1', termId: '1',
    title: '第三周作业', courseName: '大学物理', type: 'homework',
    checkedOff: false, manuallyCheckedOff: false,
    deadline: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(), // 12h away → due_24h
    pageUrl: ''
  };
  const items = [Object.assign(base, overrides)];
  h.storageData.set('homework_items', items);
  return items[0];
}
function storedItems() { return h.storageData.get('homework_items') || []; }

// Import the real SW (module side effects register listeners on our stub)
await import('../../src/background/service-worker.js');

// ── tests ─────────────────────────────────────────────────────────────────

test('onInstalled registers alarms with the new low-frequency defaults', async () => {
  await h.listeners.onInstalled[0]({ reason: 'install' });
  assert.ok(h.alarmsCreated.has('periodic-scrape'));
  assert.ok(h.alarmsCreated.has('badge-refresh'));
  assert.equal(h.alarmsCreated.get('periodic-scrape').periodInMinutes, 240);
  assert.equal(h.alarmsCreated.get('badge-refresh').periodInMinutes, 15);
});

test('badge tick fires a due notification once, then dedups', async () => {
  h.notificationsCreated.clear();
  seedItem({});

  await fireAlarm('badge-refresh');

  assert.equal(h.notificationsCreated.size, 1);
  const [id, opts] = [...h.notificationsCreated][0];
  assert.match(id, /due_24h$/);
  assert.equal(opts.title, 'MOOC 作业即将截止');
  assert.match(opts.message, /大学物理 · 第三周作业/);
  // level persisted to storage
  assert.equal(storedItems()[0].lastNotificationLevel, 'due_24h');
  assert.equal(h.badge.text, '1');

  // second tick: same level already delivered → no duplicate
  await fireAlarm('badge-refresh');
  assert.equal(h.notificationsCreated.size, 1);
});

test('concurrent badge ticks do not double-notify (in-flight guard)', async () => {
  h.notificationsCreated.clear();
  seedItem({ uid: 'C1_tid1_ch_le_hw9', lastNotificationLevel: null });

  await Promise.all([fireAlarm('badge-refresh'), fireAlarm('badge-refresh')]);

  assert.equal(h.notificationsCreated.size, 1);
  assert.equal(storedItems()[0].lastNotificationLevel, 'due_24h');
});

test('SNOOZE_ITEM clears the remembered level so it re-fires after expiry', async () => {
  h.notificationsCreated.clear();
  const item = seedItem({ uid: 'C1_tid1_ch_le_hw2', snoozedUntil: null });

  // already notified at this level, then user snoozes
  item.lastNotificationLevel = 'due_24h';
  h.storageData.set('homework_items', [item]);
  const res = await sendMessage({ type: 'SNOOZE_ITEM', homeworkUid: item.uid, hours: 24 });
  assert.equal(res.success, true);
  assert.equal(storedItems()[0].snoozedUntil != null, true);
  assert.equal(storedItems()[0].lastNotificationLevel, null); // ← the B1 fix

  // while snoozed: no notification
  await fireAlarm('badge-refresh');
  assert.equal(h.notificationsCreated.size, 0);

  // snooze expired (backdate it) → same level must fire again
  const items = storedItems();
  items[0].snoozedUntil = new Date(Date.now() - 60 * 1000).toISOString();
  h.storageData.set('homework_items', items);
  await fireAlarm('badge-refresh');
  assert.equal(h.notificationsCreated.size, 1);
});

test('notification click opens the reconstructed course URL (no pageUrl)', async () => {
  h.notificationsCreated.clear();
  h.tabsCreated.length = 0;
  seedItem({ uid: 'NEU-1474956162_tid1476504498_ch1_le2_hw5', courseId: 'NEU-1474956162', termId: '1476504498' });

  const id = `mooc-reminder:${encodeURIComponent('NEU-1474956162_tid1476504498_ch1_le2_hw5')}:due_24h`;
  await fireClick(id);

  assert.equal(h.tabsCreated.length, 1);
  assert.equal(
    h.tabsCreated[0].url,
    'https://www.icourse163.org/learn/NEU-1474956162?tid=1476504498#/learn/testlist'
  );
  // notification dismissed
  assert.equal(h.notificationsCreated.size, 0);
});

test('PAGE_OPENED fans BATCH_API_FETCH out to exactly one tab (most recent)', async () => {
  h.notificationsCreated.clear();
  seedItem({ uid: 'C1_tid1_ch_le_hw3', deadline: new Date(Date.now() + 100 * 3600 * 1000).toISOString() });
  h.tabMessages.length = 0;
  h.setTabsQuery([
    { id: 11, lastAccessed: 1000 },
    { id: 22, lastAccessed: 9000 } // more recently used
  ]);
  // stale last_sync so the event refresh is not throttled
  h.storageData.set('last_sync', new Date(Date.now() - 60 * 60 * 1000).toISOString());

  const res = await sendMessage({ type: 'PAGE_OPENED' });
  assert.equal(res.refreshTriggered, true);

  // wait for performPeriodicScrape (runs in background) to send the batch
  await new Promise(r => setTimeout(r, 1500));
  const batches = h.tabMessages.filter(t => t.msg.type === 'BATCH_API_FETCH');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].tabId, 22); // the most recently accessed tab

  // fresh last_sync → throttled, no re-send
  h.tabMessages.length = 0;
  const res2 = await sendMessage({ type: 'PAGE_OPENED' });
  assert.equal(res2.refreshTriggered, false);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(h.tabMessages.filter(t => t.msg.type === 'BATCH_API_FETCH').length, 0);
});

test('notification diagnostics exposes permission, next alarm, and due count', async () => {
  h.notificationsCreated.clear();
  h.alarmsCreated.set('badge-refresh', { scheduledTime: Date.now() + 60_000 });
  h.storageData.set('user_settings', { notificationsEnabled: true, quietHoursEnabled: false });
  seedItem({ uid: 'C1_tid1_ch_le_hw_diagnostics', lastNotificationLevel: null });

  const response = await sendMessage({ type: 'GET_NOTIFICATION_DIAGNOSTICS' });

  assert.equal(response.success, true);
  assert.equal(response.permissionLevel, 'granted');
  assert.equal(response.notificationsApiAvailable, true);
  assert.equal(response.unfinishedCount, 1);
  assert.equal(response.dueNowCount, 1);
  assert.ok(response.alarms.badgeRefresh);
});

test('daily digest inside quiet hours defers via retry alarm and keeps the date unset', async () => {
  h.notificationsCreated.clear();
  h.alarmsCreated.clear();
  const now = new Date();
  // a quiet window that definitely contains the current hour
  const quietStart = now.getHours();
  const quietEnd = (now.getHours() + 1) % 24;
  h.storageData.set('user_settings', { dailyDigestEnabled: true, notificationsEnabled: true, quietHoursEnabled: true, quietStart, quietEnd });
  seedItem({ uid: 'C1_tid1_ch_le_hw4' });

  await fireAlarm('daily-digest');

  // suppressed now…
  assert.equal(h.notificationsCreated.size, 0);
  // …but a one-shot retry is scheduled at the quiet end, and the day is NOT
  // marked as sent (create-failure / deferral keeps retry chances open)
  assert.ok(h.alarmsCreated.has('daily-digest-retry'), 'retry alarm should be scheduled');
  assert.equal(h.storageData.has('last_digest_date'), false);
});

test('daily digest outside quiet hours sends once and records the date only after create', async () => {
  h.notificationsCreated.clear();
  h.storageData.delete('last_digest_date');
  h.storageData.set('user_settings', { dailyDigestEnabled: true, notificationsEnabled: true, quietHoursEnabled: false });
  seedItem({ uid: 'C1_tid1_ch_le_hw5' });

  await fireAlarm('daily-digest');

  assert.equal(h.notificationsCreated.size, 1);
  assert.ok(h.notificationsCreated.has('mooc-reminder:daily-digest'));
  assert.equal(typeof h.storageData.get('last_digest_date'), 'string');

  // second trigger same day → already sent, no duplicate
  h.notificationsCreated.clear();
  await fireAlarm('daily-digest');
  assert.equal(h.notificationsCreated.size, 0);
});
