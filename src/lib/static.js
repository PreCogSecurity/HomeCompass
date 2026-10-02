/**
 * Path-safe resolution of static assets.
 *
 * Static serving is the classic traversal sink (`/../../etc/passwd`,
 * `/%2e%2e%2f...`, null bytes, backslash quirks on Windows, symlink escapes).
 * This module resolves a request URL to an absolute path and refuses anything
 * that is not provably inside the document root, using an extension allow-list so
 * only files we actually ship can ever be served.
 */
import path from 'node:path';
import { realpath } from 'node:fs/promises';

/** Only these extensions are ever served, mapped to their content type. */
export const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

/** Deny-by-default: never serve these even with a permitted extension. */
const DENIED_EXTENSIONS = new Set(['.env', '.map']);

/**
 * @typedef {{filePath: string, contentType: string, etagSeed: string}} ResolvedAsset
 */

/**
 * Resolve a request URL to a servable file inside `rootDir`.
 *
 * @param {string} rootDir Absolute document root.
 * @param {string} requestUrl Raw request target (may include a query string).
 * @returns {ResolvedAsset|null} `null` when the request must not be served.
 */
export function resolveStaticAsset(rootDir, requestUrl) {
  if (typeof requestUrl !== 'string' || requestUrl.length === 0 || requestUrl.length > 2048) {
    return null;
  }

  // Strip query/fragment; only the path is meaningful for file resolution.
  let pathname = requestUrl.split('#')[0].split('?')[0];
  if (pathname === '') return null;

  if (pathname.includes('%')) {
    try {
      // Decoding may legitimately produce a slash (%2f) or dot (%2e), which is
      // exactly why this happens *before* the segment checks below.
      pathname = decodeURIComponent(pathname);
    } catch {
      // Malformed percent-encoding (%zz, truncated escapes) is never legitimate.
      return null;
    }
  }

  if (!pathname.startsWith('/')) return null;
  // A protocol-relative target (`//host/path`) is never a legitimate asset URL.
  if (pathname.startsWith('//')) return null;
  // Null bytes truncate paths in some native layers; backslashes are directory
  // separators on Windows. Neither can appear in a legitimate asset URL.
  if (pathname.includes('\0') || pathname.includes('\\')) return null;

  const rawSegments = pathname.split('/').filter((segment) => segment !== '');
  if (rawSegments.length > 12) return null;

  const segments = [];
  for (const segment of rawSegments) {
    // Hidden files (.env, .git) and dot/current-dir segments are never served.
    if (segment.startsWith('.')) return null;
    if (segment === '..') return null;
    segments.push(segment);
  }

  if (segments.length === 0) segments.push('index.html');

  const extension = path.extname(segments[segments.length - 1]).toLowerCase();
  if (DENIED_EXTENSIONS.has(extension)) return null;
  const contentType = CONTENT_TYPES.get(extension);
  if (contentType === undefined) return null;

  const root = path.resolve(rootDir);
  const filePath = path.resolve(root, ...segments);
  // Belt and braces: even after segment filtering, prove containment. Works for
  // same-root paths, `..` escapes and Windows drive/UNC quirks alike.
  const relative = path.relative(root, filePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;

  return { filePath, contentType, etagSeed: relative.split(path.sep).join('/') };
}

/**
 * Weak ETag from file size and mtime: cheap, and revalidation-only so the client
 * always re-checks with the server (no stale asset after a deploy).
 *
 * @param {number} size
 * @param {number} mtimeMs
 * @returns {string}
 */
export function buildEtag(size, mtimeMs) {
  return `W/"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;
}

/**
 * Second containment check that survives symlinks.
 *
 * `resolveStaticAsset` works on the *lexical* path, which is blind to symbolic
 * links: a link inside the document root pointing at `/etc/shadow` resolves to a
 * perfectly innocent-looking path. Once real symlinks are followed, the only
 * reliable containment test is to compare the real path of the target against
 * the real path of the root.
 *
 * @param {string} rootDir Absolute document root.
 * @param {string} filePath Lexically validated candidate path.
 * @returns {Promise<string|null>} The real path to serve, or `null` to refuse.
 */
export async function resolveRealAsset(rootDir, filePath) {
  let rootReal;
  let targetReal;
  try {
    [rootReal, targetReal] = await Promise.all([realpath(rootDir), realpath(filePath)]);
  } catch {
    // Missing file, broken link, or unreadable path: nothing to serve.
    return null;
  }
  const relative = path.relative(rootReal, targetReal);
  // Same containment test as above, but against fully resolved real paths.
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return targetReal;
}
