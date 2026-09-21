import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isNewerVersion,
  parseReleaseInfo,
  evaluateRelease,
  isSafeReleaseUrl,
  resolveDownloadTarget
} from '../../src/shared/update-check.js';

// ── isNewerVersion ───────────────────────────────────────────────────────

test('isNewerVersion compares numeric components, not strings', () => {
  assert.equal(isNewerVersion('1.0.1', '1.0.0'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.1'), false);
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  // "10" > "9" numerically even though it sorts first as a string
  assert.equal(isNewerVersion('1.10.0', '1.9.0'), true);
  assert.equal(isNewerVersion('2.0.0', '1.99.99'), true);
});

test('isNewerVersion tolerates a v prefix and missing trailing components', () => {
  assert.equal(isNewerVersion('v1.2.0', '1.1.0'), true);
  assert.equal(isNewerVersion('V1.2.0', '1.1.0'), true);
  assert.equal(isNewerVersion('1.1', '1.1.0'), false);
  assert.equal(isNewerVersion('1.1.0', '1.1'), false);
  assert.equal(isNewerVersion('1.1.1', '1.1'), true);
});

test('isNewerVersion never claims an update from unparseable input', () => {
  // A junk tag must not nag the user forever — "not newer" is the safe answer.
  for (const bad of ['', 'latest', 'v', '1.0.0-beta', '1.0.0.0.0.0.0', '${VERSION}', null, undefined]) {
    assert.equal(isNewerVersion(bad, '1.0.0'), false, `candidate=${bad}`);
  }
  assert.equal(isNewerVersion('1.2.0', 'not-a-version'), false);
  assert.equal(isNewerVersion('1.2.0', ''), false);
});

// ── parseReleaseInfo ─────────────────────────────────────────────────────

const baseRelease = (overrides = {}) => ({
  tag_name: 'v1.2.0',
  html_url: 'https://github.com/o/r/releases/tag/v1.2.0',
  body: 'what changed',
  published_at: '2026-09-18T00:00:00Z',
  assets: [{
    name: 'mooc-reminder-v1.2.0.zip',
    browser_download_url: 'https://github.com/o/r/releases/download/v1.2.0/mooc-reminder-v1.2.0.zip'
  }],
  ...overrides
});

test('parseReleaseInfo prefers the packaged ZIP asset over the release page', () => {
  const info = parseReleaseInfo(baseRelease());
  assert.equal(info.version, '1.2.0');
  assert.equal(info.tag, 'v1.2.0');
  assert.match(info.downloadUrl, /\.zip$/);
  assert.equal(info.releaseUrl, 'https://github.com/o/r/releases/tag/v1.2.0');
  assert.equal(info.notes, 'what changed');
});

test('parseReleaseInfo falls back to the release page when no ZIP asset exists', () => {
  const info = parseReleaseInfo(baseRelease({ assets: [] }));
  assert.equal(info.downloadUrl, 'https://github.com/o/r/releases/tag/v1.2.0');
});

test('parseReleaseInfo ignores drafts and prereleases', () => {
  assert.equal(parseReleaseInfo(baseRelease({ draft: true })), null);
  assert.equal(parseReleaseInfo(baseRelease({ prerelease: true })), null);
});

test('parseReleaseInfo returns null for unusable payloads', () => {
  assert.equal(parseReleaseInfo(null), null);
  assert.equal(parseReleaseInfo('nope'), null);
  assert.equal(parseReleaseInfo({}), null);
  assert.equal(parseReleaseInfo({ tag_name: 'no-version-here' }), null);
  assert.equal(parseReleaseInfo({ tag_name: '' }), null);
});

test('parseReleaseInfo tolerates a missing body and assets field', () => {
  const info = parseReleaseInfo({ tag_name: 'v2.0.0', html_url: 'https://github.com/o/r/releases/tag/v2.0.0' });
  assert.equal(info.version, '2.0.0');
  assert.equal(info.notes, '');
  assert.equal(info.publishedAt, '');
});

// ── evaluateRelease ──────────────────────────────────────────────────────

test('evaluateRelease pairs the parsed release with the running version', () => {
  const newer = evaluateRelease(baseRelease(), '1.0.0');
  assert.equal(newer.updateAvailable, true);
  assert.equal(newer.currentVersion, '1.0.0');
  assert.equal(newer.version, '1.2.0');

  const same = evaluateRelease(baseRelease({ tag_name: 'v1.0.0' }), '1.0.0');
  assert.equal(same.updateAvailable, false);

  assert.equal(evaluateRelease({ tag_name: 'garbage' }, '1.0.0'), null);
});

// ── URL safety ───────────────────────────────────────────────────────────

test('only github.com release URLs are considered openable', () => {
  assert.equal(isSafeReleaseUrl('https://github.com/o/r/releases/tag/v1'), true);
  assert.equal(isSafeReleaseUrl('https://evil.example.com/x.zip'), false);
  assert.equal(isSafeReleaseUrl('http://github.com/o/r'), false);
  assert.equal(isSafeReleaseUrl('https://github.com.evil.example.com/'), false);
  assert.equal(isSafeReleaseUrl('javascript:alert(1)'), false);
  assert.equal(isSafeReleaseUrl(''), false);
  assert.equal(isSafeReleaseUrl(null), false);
});

test('resolveDownloadTarget picks the first safe URL and never a foreign one', () => {
  assert.equal(
    resolveDownloadTarget({ downloadUrl: 'https://github.com/a/b/releases/download/v1/x.zip' }),
    'https://github.com/a/b/releases/download/v1/x.zip'
  );
  // an untrusted downloadUrl falls through to a safe releaseUrl
  assert.equal(
    resolveDownloadTarget({ downloadUrl: 'https://evil.example.com/x.zip', releaseUrl: 'https://github.com/a/b/releases' }),
    'https://github.com/a/b/releases'
  );
  assert.equal(resolveDownloadTarget({ downloadUrl: 'https://evil.example.com/x.zip' }), null);
  assert.equal(resolveDownloadTarget(null), null);
});
