import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));

test('manifest is MV3 and has required runtime entries', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'src/background/service-worker.js');
  assert.equal(manifest.action.default_popup, 'src/popup/popup.html');
  assert.equal(manifest.options_ui.page, 'src/popup/options.html');
  assert.equal(manifest.options_ui.open_in_tab, true);
});

test('manifest grants site-wide icourse163 host access for API + discovery', () => {
  assert.deepEqual(manifest.host_permissions, [
    'https://www.icourse163.org/*',
    // Update checks read the repo's newest GitHub Release (see shared/update-check.js).
    // Pinned exactly on purpose: any new host access must be a deliberate edit here.
    'https://api.github.com/*'
  ]);
});

test('manifest requests cookies permission for the background API csrf token', () => {
  assert.ok(manifest.permissions.includes('cookies'));
});

test('manifest registers the course-discovery content script site-wide', () => {
  const scripts = manifest.content_scripts || [];
  const discovery = scripts.find(s => (s.js || []).includes('src/content/course-discovery.js'));
  assert.ok(discovery, 'course-discovery.js content script is registered');
  assert.ok(discovery.matches.includes('https://www.icourse163.org/*'));
  const resources = manifest.web_accessible_resources || [];
  const pageHook = resources.find(r => (r.resources || []).includes('src/content/xhr-hook-page.js'));
  assert.ok(pageHook, 'page hook is exposed as an external resource');
  assert.ok(pageHook.matches.includes('https://www.icourse163.org/*'));
  // main.js handles BATCH_API_FETCH on learn pages (SPOC termId + API proxy).
  const main = scripts.find(s => (s.js || []).includes('src/content/main.js'));
  assert.ok(main);
  assert.deepEqual(main.matches, [
    'https://www.icourse163.org/learn/*',
    'https://www.icourse163.org/spoc/learn/*'
  ]);
});

test('every learn tab the SW messages is a page main.js actually runs on', async () => {
  // Coupling guard: the SW sends BATCH_API_FETCH / REQUEST_COURSE_LINKS to tabs
  // matching LEARN_TAB_URLS. If a pattern is added there without extending the
  // manifest, those tabs answer nothing and the scrape reports "no content
  // script" for pages that should have worked.
  const sw = await readFile(new URL('../../src/background/service-worker.js', import.meta.url), 'utf8');
  const block = /const LEARN_TAB_URLS = \[([\s\S]*?)\]/.exec(sw);
  assert.ok(block, 'LEARN_TAB_URLS is declared in the service worker');
  const patterns = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.ok(patterns.length > 0);

  const main = manifest.content_scripts.find(s => (s.js || []).includes('src/content/main.js'));
  for (const pattern of patterns) {
    assert.ok(main.matches.includes(pattern), pattern + ' is messaged by the SW but main.js does not run there');
  }

  // main.js is the only script that can answer "who am I" on a course page
  // (course-discovery deliberately stays out of learn pages: source-course /
  // chapter links there would register courses the user never enrolled in, and
  // its synchronous reply would steal main.js's sendResponse).
  const mainSource = await readFile(new URL('../../src/content/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /REQUEST_COURSE_LINKS/, 'main.js must answer the rediscovery request');
  assert.match(mainSource, /COURSE_UPDATE/, 'and must re-send the SPOC active term');
});
