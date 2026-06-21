import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));

test('manifest is MV3 and has required runtime entries', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'src/background/service-worker.js');
  assert.equal(manifest.action.default_popup, 'src/popup/popup.html');
});

test('manifest exposes selectors.json for content script fetch', () => {
  const resources = manifest.web_accessible_resources.flatMap(entry => entry.resources);
  assert.ok(resources.includes('src/content/selectors.json'));
});

test('manifest grants site-wide icourse163 host access for API + discovery', () => {
  assert.deepEqual(manifest.host_permissions, [
    'https://www.icourse163.org/*'
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
  // The homework scraper still only runs on learn pages.
  const main = scripts.find(s => (s.js || []).includes('src/content/main.js'));
  assert.ok(main);
  assert.deepEqual(main.matches, [
    'https://www.icourse163.org/learn/*',
    'https://www.icourse163.org/spoc/learn/*'
  ]);
});
