/**
 * Self-hosted update check.
 *
 * The extension is side-loaded (开发者模式) and NOT published on the Chrome Web
 * Store, so Chrome never updates it: there is no `update_url`/`key` in the
 * manifest and `chrome.runtime.requestUpdateCheck()` would be a no-op. The most
 * we can do is tell the user a newer build exists and hand them the download
 * link — which is what this module supports.
 *
 * "Latest version" comes from this repo's newest GitHub Release. Releases are
 * created by `.github/workflows/release.yml` from a `v*` tag, and that workflow
 * refuses to publish unless the tag matches `manifest.json`'s version — so the
 * tag is a trustworthy stand-in for "the version users can download".
 *
 * Pure functions only (no chrome.*, no network) so they can be unit-tested; the
 * service worker owns the fetch and the storage write.
 */

export const RELEASES_API_URL =
  'https://api.github.com/repos/furina061006/MOOC_reminder/releases/latest';

/** Always-valid fallback target, so the download button is never a dead end. */
export const RELEASES_PAGE_URL =
  'https://github.com/furina061006/MOOC_reminder/releases';

/** Extension versions are dot-separated integers, optionally tagged `v`. */
function toVersionParts(value) {
  const raw = String(value == null ? '' : value).trim().replace(/^v/i, '');
  if (!/^\d+(\.\d+)*$/.test(raw)) return null;
  return raw.split('.').map((n) => parseInt(n, 10));
}

/**
 * Is `candidate` strictly newer than `current`?
 *
 * Missing trailing components count as 0, so "1.1" and "1.1.0" compare equal.
 * Unparseable input is never "newer": a junk tag must not nag the user forever.
 */
export function isNewerVersion(candidate, current) {
  const a = toVersionParts(candidate);
  const b = toVersionParts(current);
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/**
 * Extract what we need from a GitHub "latest release" payload.
 *
 * Returns null for drafts, prereleases, and anything without a usable numeric
 * version — a prerelease must never be advertised to ordinary users, and an
 * unexpected shape must be treated as "no news" rather than an update.
 */
export function parseReleaseInfo(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.draft === true || payload.prerelease === true) return null;

  const tag = typeof payload.tag_name === 'string' ? payload.tag_name.trim() : '';
  const version = tag.replace(/^v/i, '');
  if (!toVersionParts(version)) return null;

  const releaseUrl = typeof payload.html_url === 'string' ? payload.html_url : '';
  // Prefer the packaged ZIP asset: one click downloads it, instead of a page the
  // user has to read. Falls back to the release page when no asset is attached.
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const zip = assets.find((a) => a && typeof a.browser_download_url === 'string' &&
    /\.zip$/i.test(String(a.name || a.browser_download_url)));

  return {
    version,
    tag,
    downloadUrl: (zip && zip.browser_download_url) || releaseUrl,
    releaseUrl,
    notes: typeof payload.body === 'string' ? payload.body.slice(0, 2000) : '',
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : ''
  };
}

/** Parse a release payload and compare it against the running version. */
export function evaluateRelease(payload, currentVersion) {
  const info = parseReleaseInfo(payload);
  if (!info) return null;
  const current = String(currentVersion == null ? '' : currentVersion);
  return {
    ...info,
    currentVersion: current,
    updateAvailable: isNewerVersion(info.version, current)
  };
}

/**
 * Only github.com links may be opened. The payload is served by api.github.com
 * over HTTPS, but a release field is still remote input — never hand an
 * arbitrary URL to chrome.tabs.create.
 */
export function isSafeReleaseUrl(url) {
  return typeof url === 'string' && /^https:\/\/github\.com\//.test(url);
}

/** The URL the "download" action should open, or null when nothing is usable. */
export function resolveDownloadTarget(status) {
  if (!status || typeof status !== 'object') return null;
  for (const candidate of [status.downloadUrl, status.releaseUrl]) {
    if (isSafeReleaseUrl(candidate)) return candidate;
  }
  return null;
}
