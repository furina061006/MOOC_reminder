import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isNewerVersion,
  parseReleaseInfo,
  evaluateRelease,
  reconcileStatus,
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

// ── reconcileStatus ──────────────────────────────────────────────────────
//
// 真机现象（2026-09-22）：已经重新加载到 v1.1.0，设置页仍显示
// 「当前版本 v1.0.0 / 发现新版本 v1.1.0」——因为整份 update_status 是对着
// 上一次检查时那个实例算出来的快照，而重新加载后 12h 的 tick 未必马上跑。

test('reconcileStatus 把「有更新」在装上之后收回，并保留客观事实', () => {
  const stale = {
    currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true,
    downloadUrl: 'https://github.com/o/r/releases/download/v1.1.0/x.zip',
    checkedAt: '2026-09-22T00:13:41.000Z', error: null
  };
  const aligned = reconcileStatus(stale, '1.1.0');
  assert.equal(aligned.currentVersion, '1.1.0');
  assert.equal(aligned.updateAvailable, false, '已经装上的版本不该继续被提示为「有更新」');
  assert.equal(aligned.latestVersion, '1.1.0', '最新版本仍是客观事实');
  assert.equal(aligned.checkedAt, '2026-09-22T00:13:41.000Z', '上次检查时间仍是客观事实');
  assert.equal(aligned.downloadUrl, stale.downloadUrl);
  assert.notEqual(aligned, stale, '对齐后应返回新对象，不改动入参');
  assert.equal(stale.updateAvailable, true, '入参不能被就地修改');
});

test('reconcileStatus 只在运行版本确实变了时才动手', () => {
  const same = { currentVersion: '1.0.0', latestVersion: '1.2.0', updateAvailable: true };
  assert.equal(reconcileStatus(same, '1.0.0'), same, '版本一致时原样返回（连对象都不换）');

  // 运行版本仍低于最新版本 → 提示必须保留
  const older = reconcileStatus({ currentVersion: '1.0.0', latestVersion: '1.2.0', updateAvailable: true }, '1.1.0');
  assert.equal(older.currentVersion, '1.1.0');
  assert.equal(older.updateAvailable, true, '只是对齐版本，不能把有效的更新提示一起清掉');
});

test('reconcileStatus 对无法判断的输入保守处理', () => {
  assert.equal(reconcileStatus(null, '1.1.0'), null);
  assert.equal(reconcileStatus(undefined, '1.1.0'), null);
  assert.equal(reconcileStatus('nonsense', '1.1.0'), null);

  const status = { currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true };
  assert.equal(reconcileStatus(status, ''), status, '拿不到运行版本时别猜，原样返回');
  assert.equal(reconcileStatus(status, null), status);

  // 快照里没有 latestVersion（上次检查失败且无历史）→ 不能误报有更新
  const noLatest = reconcileStatus({ currentVersion: '1.0.0', updateAvailable: true }, '1.1.0');
  assert.equal(noLatest.updateAvailable, false);
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
