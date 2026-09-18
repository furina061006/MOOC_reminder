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
  const listeners = { onInstalled: [], onStartup: [], onMessage: [], onAlarm: [], onClicked: [], onRemoved: [] };
  const notificationsCreated = new Map();
  const tabCreateRequests = [];
  const tabsCreated = [];
  const tabsUpdated = [];
  const tabsRemoved = [];
  const tabMessages = [];
  const alarmsCreated = new Map();
  const badge = { text: null, color: null };
  let tabsQueryResult = [];
  let tabMessageResponder = null;
  let tabUpdateResponder = null;

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
      getURL(path) { return 'chrome-extension://test/' + path; },
      getManifest() { return { version: '1.0.0' }; }
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
      onRemoved: { addListener: fn => listeners.onRemoved.push(fn) },
      async query() { return tabsQueryResult; },
      async create(o) {
        tabCreateRequests.push({ ...o });
        const tab = { id: 100 + tabsCreated.length, ...o };
        tabsCreated.push(tab);
        return tab;
      },
      async update(tabId, changes) {
        const tab = tabsCreated.find(entry => entry.id === tabId);
        if (tab) Object.assign(tab, changes);
        tabsUpdated.push({ tabId, changes });
        if (tabUpdateResponder) return await tabUpdateResponder(tabId, changes);
        return tab || { id: tabId, ...changes };
      },
      async remove(tabId) { tabsRemoved.push(tabId); },
      async sendMessage(tabId, msg) {
        tabMessages.push({ tabId, msg });
        if (tabMessageResponder) return await tabMessageResponder(tabId, msg);
        if (msg && msg.type === 'BATCH_API_FETCH') {
          storageData.set('last_sync', new Date().toISOString());
          return [{ courseId: 'stub-course' }];
        }
        return true;
      }
    },
    cookies: { async get() { return null; } }
  };

  return {
    storageData, listeners, notificationsCreated, tabCreateRequests, tabsCreated, tabsUpdated, tabsRemoved, tabMessages,
    alarmsCreated, badge,
    setTabsQuery(tabs) { tabsQueryResult = tabs; },
    setTabMessageResponder(fn) { tabMessageResponder = fn; },
    setTabUpdateResponder(fn) { tabUpdateResponder = fn; }
  };
}

const h = makeChromeStub();
const fireAlarm = name => h.listeners.onAlarm[0]({ name });
const fireClick = id => h.listeners.onClicked[0](id);

// The SW asks GitHub for a newer release on every badge-refresh tick, so tests
// must never reach the network. fetch fails by default — which the SW treats as
// "keep the last known answer" — and individual tests install a responder.
const fetchCalls = [];
let fetchResponder = async () => { throw new Error('offline (test stub)'); };
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url: String(url), options });
  return await fetchResponder(String(url), options);
};
function setFetchResponder(fn) { fetchResponder = fn; }
async function fireTabRemoved(tabId) {
  for (const listener of h.listeners.onRemoved) await listener(tabId, { isWindowClosing: false });
}
function sendMessage(msg, sender) {
  return new Promise(resolve => {
    h.listeners.onMessage[0](msg, sender || {}, resolve);
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
function seedCourses(courses) { h.storageData.set('courses', courses); }
async function waitFor(predicate, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for expected test state');
}

// Import the real SW (module side effects register listeners on our stub)
await import('../../src/background/service-worker.js');

// ── tests ─────────────────────────────────────────────────────────────────

test('onInstalled registers alarms with the 12-hour defaults', async () => {
  await h.listeners.onInstalled[0]({ reason: 'install' });
  assert.ok(h.alarmsCreated.has('periodic-scrape'));
  assert.ok(h.alarmsCreated.has('badge-refresh'));
  assert.equal(h.alarmsCreated.get('periodic-scrape').periodInMinutes, 12 * 60);
  assert.equal(h.alarmsCreated.get('badge-refresh').periodInMinutes, 12 * 60);
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
  seedCourses([{ courseId: 'C1', termId: '1', courseName: '大学物理', courseType: 'mooc' }]);
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

test('manual refresh creates one temporary proxy, waits for its PAGE_OPENED, then cleans it up', async () => {
  h.tabCreateRequests.length = 0;
  h.tabsCreated.length = 0;
  h.tabsUpdated.length = 0;
  h.tabsRemoved.length = 0;
  h.tabMessages.length = 0;
  h.alarmsCreated.delete('temporary-proxy-timeout');
  h.storageData.delete('temporary_proxy_job');
  h.storageData.set('scrape_status', { phase: 'unrelated-scrape-state' });
  h.storageData.set('last_sync', null);
  h.setTabsQuery([]);
  h.setTabMessageResponder(null);
  h.setTabUpdateResponder(null);
  seedCourses([
    { courseId: 'BIT-100', termId: '101', courseName: '普通课程', courseType: 'mooc', lastSeen: '2026-09-01T10:00:00.000Z' },
    { courseId: 'NEU-200', termId: '202', activeTermId: '303', courseName: 'SPOC 课程', courseType: 'spoc', lastSeen: '2026-09-01T09:00:00.000Z' }
  ]);

  const refresh = sendMessage({ type: 'TRIGGER_SCRAPE' });
  await waitFor(() => h.tabsCreated.length === 1 && !!h.storageData.get('temporary_proxy_job'));

  const temporaryTab = h.tabsCreated[0];
  const job = h.storageData.get('temporary_proxy_job');
  assert.equal(h.tabCreateRequests[0].url, 'about:blank');
  assert.equal(h.tabsUpdated[0].changes.url, 'https://www.icourse163.org/learn/BIT-100?tid=101#/learn/testlist');
  assert.equal(temporaryTab.active, false);
  assert.equal(temporaryTab.url, 'https://www.icourse163.org/learn/BIT-100?tid=101#/learn/testlist');
  assert.equal(job.tabId, temporaryTab.id);
  assert.equal(job.phase, 'waiting_ready');
  assert.ok(h.alarmsCreated.has('temporary-proxy-timeout'));

  // A user page must not claim the extension-created temporary job.
  await sendMessage({ type: 'PAGE_OPENED' }, { tab: { id: 999 } });
  assert.equal(h.tabMessages.filter(entry => entry.msg.type === 'BATCH_API_FETCH').length, 0);

  const pageOpened = await sendMessage({ type: 'PAGE_OPENED' }, { tab: { id: temporaryTab.id } });
  const result = await refresh;
  const batches = h.tabMessages.filter(entry => entry.msg.type === 'BATCH_API_FETCH');

  assert.equal(pageOpened.temporaryProxy, true);
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0].msg.courses.map(course => [course.courseId, course.termId]),
    [['BIT-100', '101'], ['NEU-200', '303']]
  );
  assert.equal(result.success, true);
  assert.equal(result.temporaryProxy, true);
  assert.deepEqual(h.tabsRemoved, [temporaryTab.id]);
  assert.equal(h.storageData.get('temporary_proxy_job'), null);
  assert.deepEqual(h.storageData.get('scrape_status'), { phase: 'unrelated-scrape-state' });
  assert.equal(h.alarmsCreated.has('temporary-proxy-timeout'), false);
});

test('a PAGE_OPENED emitted during proxy navigation sees the persisted job', async () => {
  h.tabCreateRequests.length = 0;
  h.tabsCreated.length = 0;
  h.tabsUpdated.length = 0;
  h.tabsRemoved.length = 0;
  h.tabMessages.length = 0;
  h.alarmsCreated.delete('temporary-proxy-timeout');
  h.storageData.delete('temporary_proxy_job');
  h.setTabsQuery([]);
  h.setTabMessageResponder(null);
  seedCourses([{ courseId: 'BIT-FAST', termId: '707', courseName: '快速加载课程', courseType: 'mooc' }]);

  let earlyPageOpened;
  h.setTabUpdateResponder((tabId, changes) => {
    earlyPageOpened = sendMessage({ type: 'PAGE_OPENED' }, { tab: { id: tabId } });
    return { id: tabId, ...changes };
  });

  const refresh = sendMessage({ type: 'TRIGGER_SCRAPE' });
  await waitFor(() => !!earlyPageOpened);
  const pageResult = await earlyPageOpened;
  const result = await refresh;
  h.setTabUpdateResponder(null);

  assert.equal(h.tabCreateRequests[0].url, 'about:blank');
  assert.equal(pageResult.temporaryProxy, true);
  assert.equal(result.success, true);
  assert.equal(h.tabMessages.filter(entry => entry.msg.type === 'BATCH_API_FETCH').length, 1);
  assert.equal(h.alarmsCreated.has('temporary-proxy-timeout'), false);
});

test('a SPOC-only temporary proxy uses its route term ID and batches with activeTermId', async () => {
  h.tabCreateRequests.length = 0;
  h.tabsCreated.length = 0;
  h.tabsUpdated.length = 0;
  h.tabsRemoved.length = 0;
  h.tabMessages.length = 0;
  h.alarmsCreated.delete('temporary-proxy-timeout');
  h.storageData.delete('temporary_proxy_job');
  h.setTabsQuery([]);
  h.setTabMessageResponder(null);
  h.setTabUpdateResponder(null);
  seedCourses([{
    courseId: 'NEU-400',
    termId: '505',
    activeTermId: '606',
    courseName: '仅 SPOC 课程',
    courseType: 'spoc'
  }]);

  const refresh = sendMessage({ type: 'TRIGGER_SCRAPE' });
  await waitFor(() => h.tabsCreated.length === 1 && !!h.storageData.get('temporary_proxy_job'));
  const temporaryTab = h.tabsCreated[0];
  assert.equal(temporaryTab.url, 'https://www.icourse163.org/spoc/learn/NEU-400?tid=505#/learn/testlist');

  await sendMessage({ type: 'PAGE_OPENED' }, { tab: { id: temporaryTab.id } });
  await refresh;

  const batch = h.tabMessages.find(entry => entry.msg.type === 'BATCH_API_FETCH');
  assert.equal(batch.msg.courses[0].termId, '606');
  assert.deepEqual(h.tabsRemoved, [temporaryTab.id]);
});

test('manual refresh reuses an existing MOOC page without closing it', async () => {
  h.tabsCreated.length = 0;
  h.tabsRemoved.length = 0;
  h.tabMessages.length = 0;
  h.storageData.delete('temporary_proxy_job');
  h.setTabMessageResponder(null);
  seedCourses([{ courseId: 'BIT-300', termId: '404', courseName: '已有页面课程', courseType: 'mooc' }]);
  h.setTabsQuery([{ id: 55, lastAccessed: 9999 }]);

  const result = await sendMessage({ type: 'TRIGGER_SCRAPE' });

  assert.equal(result.success, true);
  assert.equal(result.temporaryProxy, false);
  assert.equal(h.tabsCreated.length, 0);
  assert.equal(h.tabsRemoved.length, 0);
  assert.equal(h.tabMessages.filter(entry => entry.msg.type === 'BATCH_API_FETCH').length, 1);
  assert.equal(h.tabMessages[0].tabId, 55);
});

test('a completion message finalizes a persisted fetching proxy job after worker revival', async () => {
  h.tabsRemoved.length = 0;
  h.alarmsCreated.set('temporary-proxy-timeout', { when: Date.now() + 60_000 });
  h.storageData.set('temporary_proxy_job', {
    kind: 'temporary-proxy',
    id: 'temporary-proxy-resume-test',
    tabId: 776,
    temporary: true,
    phase: 'fetching',
    source: 'periodic',
    courseId: 'BIT-776',
    proxyUrl: 'https://www.icourse163.org/learn/BIT-776?tid=776#/learn/testlist',
    createdAt: Date.now(),
    deadlineAt: Date.now() + 60_000,
    expectedCourseIds: ['BIT-776']
  });

  const result = await sendMessage(
    { type: 'TEMPORARY_PROXY_BATCH_COMPLETE', proxyJobId: 'temporary-proxy-resume-test', resultCount: 2 },
    { tab: { id: 776 } }
  );

  assert.equal(result.success, true);
  assert.deepEqual(h.tabsRemoved, [776]);
  assert.equal(h.storageData.get('temporary_proxy_job'), null);
  assert.equal(h.alarmsCreated.has('temporary-proxy-timeout'), false);
});

test('a completion message with no course data fails and cleans the persisted job', async () => {
  h.tabsRemoved.length = 0;
  h.alarmsCreated.set('temporary-proxy-timeout', { when: Date.now() + 60_000 });
  h.storageData.set('temporary_proxy_job', {
    kind: 'temporary-proxy',
    id: 'temporary-proxy-empty-result-test',
    tabId: 775,
    temporary: true,
    phase: 'fetching',
    source: 'manual',
    courseId: 'BIT-775',
    proxyUrl: 'https://www.icourse163.org/learn/BIT-775?tid=775#/learn/testlist',
    createdAt: Date.now(),
    deadlineAt: Date.now() + 60_000,
    expectedCourseIds: ['BIT-775']
  });

  const result = await sendMessage(
    { type: 'TEMPORARY_PROXY_BATCH_COMPLETE', proxyJobId: 'temporary-proxy-empty-result-test', resultCount: 0 },
    { tab: { id: 775 } }
  );

  assert.equal(result.success, false);
  assert.match(result.error, /no course data/);
  assert.deepEqual(h.tabsRemoved, [775]);
  assert.equal(h.storageData.get('temporary_proxy_job'), null);
});

test('temporary proxy timeout closes only the owned tab and clears its job', async () => {
  h.tabsRemoved.length = 0;
  h.alarmsCreated.set('temporary-proxy-timeout', { when: Date.now() + 60_000 });
  h.storageData.set('temporary_proxy_job', {
    kind: 'temporary-proxy',
    id: 'temporary-proxy-timeout-test',
    tabId: 777,
    temporary: true,
    phase: 'waiting_ready',
    source: 'periodic',
    courseId: 'BIT-777',
    createdAt: Date.now(),
    deadlineAt: Date.now() + 60_000,
    expectedCourseIds: ['BIT-777']
  });

  await fireAlarm('temporary-proxy-timeout');

  assert.deepEqual(h.tabsRemoved, [777]);
  assert.equal(h.storageData.get('temporary_proxy_job'), null);
  assert.equal(h.alarmsCreated.has('temporary-proxy-timeout'), false);
});

test('timeout wins deterministically over a late successful temporary batch response', async () => {
  h.tabsCreated.length = 0;
  h.tabsRemoved.length = 0;
  h.tabMessages.length = 0;
  h.alarmsCreated.delete('temporary-proxy-timeout');
  h.storageData.delete('temporary_proxy_job');
  h.setTabsQuery([]);
  h.setTabUpdateResponder(null);
  seedCourses([{ courseId: 'BIT-LATE', termId: '808', courseName: '延迟响应课程', courseType: 'mooc' }]);

  let resolveBatch;
  h.setTabMessageResponder((_tabId, _msg) => new Promise(resolve => { resolveBatch = resolve; }));
  const refresh = sendMessage({ type: 'TRIGGER_SCRAPE' });
  await waitFor(() => h.tabsCreated.length === 1 && !!h.storageData.get('temporary_proxy_job'));
  const tabId = h.tabsCreated[0].id;
  const pageOpened = sendMessage({ type: 'PAGE_OPENED' }, { tab: { id: tabId } });
  await waitFor(() => typeof resolveBatch === 'function');

  await fireAlarm('temporary-proxy-timeout');
  const refreshResult = await refresh;
  resolveBatch([]);
  await pageOpened;
  h.setTabMessageResponder(null);

  assert.equal(refreshResult.success, false);
  assert.match(refreshResult.error, /timed out/);
  assert.deepEqual(h.tabsRemoved, [tabId]);
  assert.equal(h.storageData.get('temporary_proxy_job'), null);
});

test('manual closure of a temporary proxy clears its job without closing another tab', async () => {
  h.tabsRemoved.length = 0;
  h.alarmsCreated.set('temporary-proxy-timeout', { when: Date.now() + 60_000 });
  h.storageData.set('temporary_proxy_job', {
    kind: 'temporary-proxy',
    id: 'temporary-proxy-user-close-test',
    tabId: 778,
    temporary: true,
    phase: 'waiting_ready',
    source: 'manual',
    courseId: 'BIT-778',
    createdAt: Date.now(),
    deadlineAt: Date.now() + 60_000,
    expectedCourseIds: ['BIT-778']
  });

  await fireTabRemoved(778);
  await waitFor(() => h.storageData.get('temporary_proxy_job') === null);

  assert.equal(h.tabsRemoved.length, 0);
  assert.equal(h.storageData.get('temporary_proxy_job'), null);
  assert.equal(h.alarmsCreated.has('temporary-proxy-timeout'), false);
});

test('manual refresh reports no proxy when only manual courses are known', async () => {
  h.tabsCreated.length = 0;
  h.tabsRemoved.length = 0;
  h.tabMessages.length = 0;
  h.storageData.delete('temporary_proxy_job');
  h.setTabsQuery([]);
  seedCourses([{ courseId: 'manual', termId: 'manual', courseName: '线下作业', courseType: 'manual' }]);

  const result = await sendMessage({ type: 'TRIGGER_SCRAPE' });

  assert.equal(result.success, false);
  assert.match(result.error, /没有可抓取/);
  assert.equal(h.tabsCreated.length, 0);
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

test('browser startup sends the first pending daily digest before its configured time', async () => {
  h.notificationsCreated.clear();
  h.storageData.delete('last_digest_date');
  h.storageData.set('user_settings', { dailyDigestEnabled: true, notificationsEnabled: true, quietHoursEnabled: false, dailyDigestHour: 23 });
  seedItem({ uid: 'C1_tid1_ch_le_hw_startup_digest' });

  await h.listeners.onStartup[0]();

  assert.ok(h.notificationsCreated.has('mooc-reminder:daily-digest'));
  assert.equal(typeof h.storageData.get('last_digest_date'), 'string');
});

test('daily digest inside quiet hours defers via retry alarm and keeps the date unset', async () => {
  h.notificationsCreated.clear();
  h.alarmsCreated.clear();
  h.storageData.delete('last_digest_date');
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

// ── backlog regressions (2026-09-04 fixes) ───────────────────────────────

test('notification click opens the SPOC route for a SPOC course item', async () => {
  h.tabsCreated.length = 0;
  seedItem({ uid: 'NEU-2_tid22_ch_le_hw7', courseId: 'NEU-2', termId: '22', pageUrl: '' });
  seedCourses([{ courseId: 'NEU-2', termId: '22', courseName: '大学物理', courseType: 'spoc' }]);

  await fireClick(`mooc-reminder:${encodeURIComponent('NEU-2_tid22_ch_le_hw7')}:due_24h`);

  assert.equal(h.tabsCreated.length, 1);
  assert.equal(
    h.tabsCreated[0].url,
    'https://www.icourse163.org/spoc/learn/NEU-2?tid=22#/learn/testlist'
  );
});

test('concurrent course writes do not drop each other (serialized courses store)', async () => {
  // Both handlers read-modify-write `courses`. Without the serialized store the
  // later write wins and one course disappears.
  h.storageData.set('courses', [
    { courseId: 'BIT-1', termId: '11', courseName: '数据结构', courseType: 'mooc' }
  ]);

  const [links, update] = await Promise.all([
    sendMessage({
      type: 'COURSE_LINKS',
      courses: [{ courseId: 'BIT-1', termId: '11', courseName: '数据结构', courseType: 'mooc' }]
    }),
    sendMessage({
      type: 'COURSE_UPDATE',
      courseId: 'NEU-2', activeTermId: '22', courseName: '大学物理', courseType: 'spoc'
    })
  ]);

  assert.equal(links.success, true);
  assert.equal(update.success, true);
  const byId = new Map((h.storageData.get('courses') || []).map(c => [c.courseId, c]));
  assert.deepEqual([...byId.keys()].sort(), ['BIT-1', 'NEU-2']);
  assert.equal(byId.get('NEU-2').activeTermId, '22');
});

test('ADD_MANUAL_ITEM keeps same-named courses distinct (UID includes courseId)', async () => {
  h.storageData.set('homework_items', []);
  const deadline = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

  const first = await sendMessage({
    type: 'ADD_MANUAL_ITEM', title: '读书报告', deadline, courseName: '大学物理', courseId: 'C-A'
  });
  const second = await sendMessage({
    type: 'ADD_MANUAL_ITEM', title: '读书报告', deadline, courseName: '大学物理', courseId: 'C-B'
  });

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.notEqual(first.item.uid, second.item.uid);
  assert.equal(storedItems().length, 2);
});

test('cleared completed items stay cleared across the next API sync', async () => {
  const deadlineMs = new Date('2026-06-30T23:59:00').getTime();
  const course = { courseId: 'BIT-268001', termId: '1460270441', courseName: '数据结构', courseType: 'mooc' };
  const donePayload = {
    result: {
      mocTermDto: {
        chapters: [{
          id: 3, name: '第3章', type: 'chapter',
          lessons: [{
            id: 21, name: '3.1 树', type: 'lesson',
            units: [{ id: 101, name: '单元测验：树', endTime: deadlineMs, mark: 18, totalMark: 20 }]
          }]
        }]
      }
    }
  };
  const unfinishedPayload = {
    result: {
      mocTermDto: {
        chapters: [{
          id: 3, name: '第3章', type: 'chapter',
          lessons: [{
            id: 21, name: '3.1 树', type: 'lesson',
            units: [{ id: 101, name: '单元测验：树', endTime: deadlineMs }]
          }]
        }]
      }
    }
  };

  h.storageData.set('homework_items', []);
  h.storageData.delete('dismissed_completed_uids');
  seedCourses([course]);

  await sendMessage({ type: 'COURSE_API_DATA', course, rawData: donePayload });
  assert.equal(storedItems().length, 1);
  assert.equal(storedItems()[0].checkedOff, true);

  const cleared = await sendMessage({ type: 'CLEAR_COMPLETED' });
  assert.equal(cleared.remaining, 0);
  assert.deepEqual(storedItems(), []);
  assert.equal((h.storageData.get('dismissed_completed_uids') || []).length, 1);

  // Same completed payload again → must NOT resurrect the cleared item.
  await sendMessage({ type: 'COURSE_API_DATA', course, rawData: donePayload });
  assert.deepEqual(storedItems(), []);

  // If the item genuinely becomes unfinished again (e.g. a new attempt), the
  // tombstone is dropped and the item is allowed back.
  await sendMessage({ type: 'COURSE_API_DATA', course, rawData: unfinishedPayload });
  assert.equal(storedItems().length, 1);
  assert.equal(storedItems()[0].checkedOff, false);
  assert.deepEqual(h.storageData.get('dismissed_completed_uids') || [], []);
});

test('RESET_DATA clears the dismissed tombstone list', async () => {
  h.storageData.set('dismissed_completed_uids', ['X_tid1_ch_le_hw1']);
  h.storageData.set('courses', [{ courseId: 'BIT-9', termId: '9', courseType: 'mooc' }]);

  const result = await sendMessage({ type: 'RESET_DATA' });

  assert.equal(result.success, true);
  assert.deepEqual(h.storageData.get('dismissed_completed_uids'), []);
  assert.deepEqual(h.storageData.get('courses'), []);
});

// ── SPOC click-target regression (backlog: popup opens the plain MOOC page) ──
//
// A SPOC course shares its courseId with the plain MOOC course of the same name,
// and `courses` holds one record per courseId — so a /learn/ link harvest of the
// same courseId used to demote the record's courseType to 'mooc', which sent the
// popup click to /learn/. These tests pin the three defences: the frozen route
// URL, the sticky SPOC classification, and the extractor's courseType.

const SPOC_ROUTE_URL = 'https://www.icourse163.org/spoc/learn/NEU-1474956162?tid=1476735472#/learn/content';
const SPOC_API_TERM_ID = '1476504498';
const spocCourseRecord = () => (h.storageData.get('courses') || []).find(c => c && c.courseId === 'NEU-1474956162');

test('SPOC route URL survives a MOOC link harvest and drives the click target', async () => {
  h.storageData.set('homework_items', []);
  h.storageData.delete('dismissed_completed_uids');
  seedCourses([{
    courseId: 'NEU-1474956162', termId: '1476735472', courseName: '大学物理（SPOC）', courseType: 'spoc'
  }]);

  // 1) The SPOC page reports the real API termId plus the route URL it loaded.
  const upd = await sendMessage({
    type: 'COURSE_UPDATE',
    courseId: 'NEU-1474956162',
    activeTermId: SPOC_API_TERM_ID,
    courseName: '大学物理（SPOC）',
    courseType: 'spoc',
    routeUrl: SPOC_ROUTE_URL
  });
  assert.equal(upd.success, true);
  assert.equal(spocCourseRecord().pageUrl, SPOC_ROUTE_URL);
  assert.equal(spocCourseRecord().activeTermId, SPOC_API_TERM_ID);

  // 2) A plain /learn/ harvest of the SAME courseId must not demote the record:
  //    not its courseType, name, route termId, or frozen route URL.
  await sendMessage({
    type: 'COURSE_LINKS',
    courses: [{ courseId: 'NEU-1474956162', termId: '999999', courseName: '大学物理', courseType: 'mooc' }]
  });
  assert.equal(spocCourseRecord().courseType, 'spoc');
  assert.equal(spocCourseRecord().courseName, '大学物理（SPOC）');
  assert.equal(spocCourseRecord().termId, '1476735472');
  assert.equal(spocCourseRecord().pageUrl, SPOC_ROUTE_URL);

  // 3) A full API sync: items self-describe their type and inherit the route URL.
  const payload = {
    result: {
      mocTermDto: {
        chapters: [{
          id: 1, name: '第1章', type: 'chapter',
          lessons: [{
            id: 2, name: '1.1', type: 'lesson',
            units: [{
              id: 77, name: '第一章作业', contentType: 3,
              test: { deadline: Date.now() + 86400000, usedTryCount: 0 }
            }]
          }]
        }]
      }
    }
  };
  const sync = await sendMessage({
    type: 'COURSE_API_DATA',
    course: {
      courseId: 'NEU-1474956162', termId: SPOC_API_TERM_ID,
      courseName: '大学物理（SPOC）', schoolName: '', courseType: 'spoc'
    },
    rawData: payload
  });
  assert.equal(sync.success, true);
  assert.equal(storedItems().length, 1);
  const item = storedItems()[0];
  assert.equal(item.courseType, 'spoc');   // runtime extractor no longer drops courseType
  assert.equal(item.pageUrl, SPOC_ROUTE_URL);
  assert.equal(item.termId, SPOC_API_TERM_ID); // uid stays keyed on the API termId
  // The API payload's termId is the API id, not a route id — it must NOT clobber
  // the route termId harvested from the learn link, otherwise the /spoc/learn/
  // URL would be rebuilt with the wrong `tid`.
  assert.equal(spocCourseRecord().termId, '1476735472');

  // 4) Clicking opens the SPOC route with the ROUTE termId, not the API one.
  h.tabsCreated.length = 0;
  await fireClick(`mooc-reminder:${encodeURIComponent(item.uid)}:due_24h`);
  assert.equal(h.tabsCreated.length, 1);
  assert.equal(
    h.tabsCreated[0].url,
    'https://www.icourse163.org/spoc/learn/NEU-1474956162?tid=1476735472#/learn/testlist'
  );
});

test('BATCH_API_FETCH derives SPOC from activeTermId when courseType was demoted', async () => {
  h.tabMessages.length = 0;
  h.setTabMessageResponder(null);
  h.setTabUpdateResponder(null);
  h.storageData.delete('temporary_proxy_job');
  h.setTabsQuery([{ id: 33, lastAccessed: 5000 }]);
  // activeTermId is only ever written from a real SPOC page, so it must outrank
  // the courseType that a weak /learn/ harvest has already demoted to 'mooc'.
  seedCourses([{
    courseId: 'NEU-1474956162', termId: '1476735472', activeTermId: SPOC_API_TERM_ID,
    courseName: '大学物理', courseType: 'mooc'
  }]);
  h.storageData.set('last_sync', new Date(Date.now() - 60 * 60 * 1000).toISOString());

  const res = await sendMessage({ type: 'PAGE_OPENED' });
  assert.equal(res.refreshTriggered, true);
  await new Promise(r => setTimeout(r, 1500));

  const batch = h.tabMessages.find(t => t.msg && t.msg.type === 'BATCH_API_FETCH');
  assert.ok(batch, 'expected a BATCH_API_FETCH to be dispatched');
  const course = batch.msg.courses.find(c => c.courseId === 'NEU-1474956162');
  assert.equal(course.courseType, 'spoc');
  assert.equal(course.termId, SPOC_API_TERM_ID);
});

test('COURSE_UPDATE rejects a non-learn routeUrl instead of storing it', async () => {
  seedCourses([]);
  await sendMessage({
    type: 'COURSE_UPDATE',
    courseId: 'NEU-1474956162',
    activeTermId: SPOC_API_TERM_ID,
    courseName: '大学物理（SPOC）',
    courseType: 'spoc',
    routeUrl: 'https://evil.example.com/spoc/learn/NEU-1474956162?tid=1'
  });
  // The record is still created (courseType/activeTermId are valid), but no
  // untrusted URL is persisted: isIcCourseLearnUrl gates the origin.
  assert.equal(spocCourseRecord().courseType, 'spoc');
  assert.equal(spocCourseRecord().pageUrl, undefined);
});

// ── near-miss diagnostics in the RUNTIME copy ────────────────────────────
// The SPOC bug happened because the inlined runtime extractor had drifted from
// the tested shared copy. This pins the near-miss reporting on the copy that
// actually runs, so the two cannot silently diverge again on this behaviour.

test('the runtime extractor reports content-type near misses (copies stay in sync)', async () => {
  h.storageData.set('homework_items', []);
  h.storageData.delete('dismissed_completed_uids');
  seedCourses([{ courseId: 'NEU-1', termId: '1', courseName: '模拟电子技术', courseType: 'mooc' }]);

  const deadline = Date.now() + 86400000;
  const payload = {
    result: {
      mocTermDto: {
        chapters: [{
          id: 1, name: '第1章', type: 'chapter',
          lessons: [{
            id: 11, name: '1.1', type: 'lesson',
            units: [
              { id: 101, name: '第一章 测验', contentType: 2, test: { deadline } },
              { id: 102, name: '“Multisim” 对应的测试', contentType: 9, test: { deadline } }
            ]
          }]
        }]
      }
    }
  };

  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  let res;
  try {
    res = await sendMessage({
      type: 'COURSE_API_DATA',
      course: { courseId: 'NEU-1', termId: '1', courseName: '模拟电子技术', schoolName: '', courseType: 'mooc' },
      rawData: payload
    });
  } finally {
    console.log = original;
  }

  assert.equal(res.success, true);
  assert.equal(res.itemCount, 1, 'only the recognised contentType is extracted');
  const line = logs.find((l) => l.includes('被类型门槛拦下'));
  assert.ok(line, 'the inlined runtime copy must report near misses like the shared one');
  assert.match(line, /"contentType":"9"/);
});

// ── update check (backlog: 客户端插件提醒有更新) ──────────────────────────
//
// The running version in the harness stub is 1.0.0 (chrome.runtime.getManifest).

function releasePayload(version, extra) {
  return {
    tag_name: 'v' + version,
    html_url: 'https://github.com/furina061006/MOOC_reminder/releases/tag/v' + version,
    body: 'notes for ' + version,
    published_at: '2026-09-18T00:00:00Z',
    assets: [{
      name: 'mooc-reminder-v' + version + '.zip',
      browser_download_url: 'https://github.com/furina061006/MOOC_reminder/releases/download/v' +
        version + '/mooc-reminder-v' + version + '.zip'
    }],
    ...(extra || {})
  };
}
const jsonResponder = payload => async () => ({ ok: true, status: 200, json: async () => payload });

/** Reset everything the update check touches, with no homework in the way. */
function arrangeUpdateCheck(settings) {
  h.notificationsCreated.clear();
  h.storageData.set('homework_items', []);
  h.storageData.delete('update_status');
  h.storageData.set('user_settings', Object.assign(
    { notificationsEnabled: true, quietHoursEnabled: false }, settings || {}
  ));
  fetchCalls.length = 0;
}

test('badge-refresh notices a newer release and notifies once per version', async () => {
  arrangeUpdateCheck({ autoCheckUpdates: true });
  setFetchResponder(jsonResponder(releasePayload('1.2.0')));

  await fireAlarm('badge-refresh');

  const status = h.storageData.get('update_status');
  assert.equal(status.currentVersion, '1.0.0');
  assert.equal(status.latestVersion, '1.2.0');
  assert.equal(status.updateAvailable, true);
  assert.equal(status.notifiedVersion, '1.2.0');
  assert.equal(status.error, null);
  assert.equal(h.notificationsCreated.size, 1);
  assert.ok(h.notificationsCreated.has('mooc-reminder:update:1.2.0'));
  assert.match(h.notificationsCreated.get('mooc-reminder:update:1.2.0').message, /1\.0\.0 → v1\.2\.0/);

  // The same version on the next tick must not nag again.
  h.notificationsCreated.clear();
  await fireAlarm('badge-refresh');
  assert.equal(h.notificationsCreated.size, 0);
  assert.equal(h.storageData.get('update_status').notifiedVersion, '1.2.0');

  // A genuinely newer release re-arms the announcement.
  setFetchResponder(jsonResponder(releasePayload('1.3.0')));
  await fireAlarm('badge-refresh');
  assert.ok(h.notificationsCreated.has('mooc-reminder:update:1.3.0'));
});

test('an up-to-date release reports no update and notifies nobody', async () => {
  arrangeUpdateCheck({ autoCheckUpdates: true });
  setFetchResponder(jsonResponder(releasePayload('1.0.0')));

  await fireAlarm('badge-refresh');

  const status = h.storageData.get('update_status');
  assert.equal(status.updateAvailable, false);
  assert.equal(status.notifiedVersion, null);
  assert.equal(h.notificationsCreated.size, 0);
});

test('a failed check keeps the last known answer instead of clearing it', async () => {
  arrangeUpdateCheck({ autoCheckUpdates: true });
  setFetchResponder(jsonResponder(releasePayload('1.2.0')));
  await fireAlarm('badge-refresh');

  h.notificationsCreated.clear();
  setFetchResponder(async () => { throw new Error('offline'); });
  await fireAlarm('badge-refresh');

  const status = h.storageData.get('update_status');
  assert.equal(status.latestVersion, '1.2.0', 'a network hiccup must not blank the version');
  assert.equal(status.updateAvailable, true, 'the indicator must stay truthful');
  assert.match(status.error, /offline/);
  assert.equal(h.notificationsCreated.size, 0, 'a failed check re-announces nothing');
});

test('a non-OK HTTP response is treated as a failed check', async () => {
  arrangeUpdateCheck({ autoCheckUpdates: true });
  setFetchResponder(async () => ({ ok: false, status: 403, json: async () => ({}) }));

  await fireAlarm('badge-refresh');

  const status = h.storageData.get('update_status');
  assert.match(status.error, /403/);
  assert.equal(status.updateAvailable, false);
});

test('autoCheckUpdates=false skips the automatic check entirely', async () => {
  arrangeUpdateCheck({ autoCheckUpdates: false });
  setFetchResponder(jsonResponder(releasePayload('9.9.9')));

  await fireAlarm('badge-refresh');

  assert.equal(fetchCalls.length, 0, 'turning the switch off must stop all network traffic');
  assert.equal(h.storageData.get('update_status'), undefined);
});

test('a prerelease is never advertised', async () => {
  arrangeUpdateCheck({ autoCheckUpdates: true });
  setFetchResponder(jsonResponder(releasePayload('2.0.0', { prerelease: true })));

  await fireAlarm('badge-refresh');

  assert.equal(h.storageData.get('update_status').updateAvailable, false);
  assert.equal(h.notificationsCreated.size, 0);
});

test('quiet hours defer the update notification without burning the once-per-version flag', async () => {
  const hour = new Date().getHours();
  // Build a quiet window that contains the current hour.
  arrangeUpdateCheck({ autoCheckUpdates: true, quietHoursEnabled: true, quietStart: hour, quietEnd: (hour + 1) % 24 });
  setFetchResponder(jsonResponder(releasePayload('1.2.0')));

  await fireAlarm('badge-refresh');

  const status = h.storageData.get('update_status');
  assert.equal(status.updateAvailable, true);
  assert.equal(h.notificationsCreated.size, 0, 'quiet hours must suppress it');
  assert.equal(status.notifiedVersion, null, 'and must not consume the one-shot flag');

  // Outside quiet hours the very next tick delivers it.
  h.storageData.set('user_settings', { autoCheckUpdates: true, quietHoursEnabled: false });
  await fireAlarm('badge-refresh');
  assert.ok(h.notificationsCreated.has('mooc-reminder:update:1.2.0'));
});

test('CHECK_UPDATES bypasses the toggle, and the notification click opens the ZIP', async () => {
  arrangeUpdateCheck({ autoCheckUpdates: false });
  setFetchResponder(jsonResponder(releasePayload('1.2.0')));

  const resp = await sendMessage({ type: 'CHECK_UPDATES' });
  assert.equal(resp.success, true);
  assert.equal(resp.status.updateAvailable, true);
  assert.equal(fetchCalls.length, 1);

  h.tabsCreated.length = 0;
  await fireClick('mooc-reminder:update:1.2.0');
  assert.equal(h.tabsCreated.length, 1);
  assert.equal(
    h.tabsCreated[0].url,
    'https://github.com/furina061006/MOOC_reminder/releases/download/v1.2.0/mooc-reminder-v1.2.0.zip'
  );
});

test('the update notification click never opens a non-github URL', async () => {
  arrangeUpdateCheck({});
  h.storageData.set('update_status', {
    currentVersion: '1.0.0', latestVersion: '1.2.0', updateAvailable: true,
    downloadUrl: 'https://evil.example.com/payload.zip', releaseUrl: 'https://evil.example.com/'
  });

  h.tabsCreated.length = 0;
  await fireClick('mooc-reminder:update:1.2.0');

  assert.equal(h.tabsCreated.length, 1);
  assert.equal(h.tabsCreated[0].url, 'https://github.com/furina061006/MOOC_reminder/releases');
});

test('GET_UPDATE_STATUS reports the running version without a network call', async () => {
  arrangeUpdateCheck({});
  const resp = await sendMessage({ type: 'GET_UPDATE_STATUS' });
  assert.equal(resp.success, true);
  assert.equal(resp.currentVersion, '1.0.0');
  assert.equal(fetchCalls.length, 0, 'rendering the options page must not hit the network');
});
