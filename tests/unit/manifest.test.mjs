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

test('manifest has icourse163 learn host permissions only', () => {
  assert.deepEqual(manifest.host_permissions, [
    'https://www.icourse163.org/learn/*',
    'https://www.icourse163.org/spoc/learn/*'
  ]);
});
