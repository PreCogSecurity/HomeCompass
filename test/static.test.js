import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEtag, CONTENT_TYPES, resolveRealAsset, resolveStaticAsset } from '../src/lib/static.js';

const ROOT = path.resolve('public');

/** @param {string} url */
function resolve(url) {
  return resolveStaticAsset(ROOT, url);
}

describe('resolveStaticAsset (happy paths)', () => {
  test('serves index.html for the root path', () => {
    const asset = resolve('/');
    assert.ok(asset);
    assert.equal(asset.filePath, path.join(ROOT, 'index.html'));
    assert.equal(asset.contentType, 'text/html; charset=utf-8');
  });

  test('serves known assets with correct content types', () => {
    const css = resolve('/assets/styles.css');
    assert.equal(css.contentType, 'text/css; charset=utf-8');
    const js = resolve('/assets/app.mjs');
    assert.equal(js.contentType, 'text/javascript; charset=utf-8');
    const icon = resolve('/assets/favicon.svg');
    assert.equal(icon.contentType, 'image/svg+xml');
  });

  test('ignores the query string', () => {
    const asset = resolve('/index.html?utm_source=x&cachebust=1');
    assert.ok(asset);
    assert.equal(asset.filePath, path.join(ROOT, 'index.html'));
  });

  test('nested paths work', () => {
    assert.ok(resolve('/assets/favicon.svg'));
  });
});

describe('resolveStaticAsset (traversal and injection)', () => {
  const attacks = [
    '/../package.json',
    '/../../package.json',
    '/assets/../../package.json',
    '/..%2fpackage.json',
    '/%2e%2e/package.json',
    '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/./../src/app.js',
    '/....//package.json',
    '/assets/..%2f..%2fpackage.json',
    '/..\\package.json',
    '/\\package.json',
    '/index.html%00.png',
    '/%00',
    '/C:%5CWindows%5Cwin.ini',
    '//evil.example.com/index.html',
    '/%2e%2e/',
  ];

  for (const attack of attacks) {
    test(`refuses ${attack}`, () => {
      assert.equal(resolve(attack), null);
    });
  }

  test('refuses malformed percent-encoding', () => {
    for (const url of ['/%zz', '/%', '/%e0%a4%a', '/assets/%2']) {
      assert.equal(resolve(url), null, url);
    }
  });

  test('refuses hidden files and dot segments', () => {
    for (const url of ['/.env', '/.git/config', '/.gitignore', '/./index.html', '/assets/.env']) {
      assert.equal(resolve(url), null, url);
    }
  });

  test('refuses extensions outside the allow-list', () => {
    for (const url of ['/package.json.bak', '/../../LICENSE', '/data/items.json', '/.env.local']) {
      assert.equal(resolve(url), null, url);
    }
  });

  test('refuses absurdly long or deep URLs', () => {
    assert.equal(resolve(`/${'a'.repeat(5000)}`), null);
    assert.equal(resolve(`/${Array.from({ length: 20 }, () => 'a').join('/')}`), null);
  });

  test('refuses non-string and empty targets', () => {
    assert.equal(resolveStaticAsset(ROOT, ''), null);
    assert.equal(resolveStaticAsset(ROOT, undefined), null);
    assert.equal(resolveStaticAsset(ROOT, 42), null);
  });

  test('refuses targets that do not start with a slash', () => {
    assert.equal(resolve('index.html'), null);
  });
});

describe('CONTENT_TYPES', () => {
  test('never maps an extension to a non-allow-listed type', () => {
    for (const [extension, type] of CONTENT_TYPES) {
      assert.match(extension, /^\.[a-z0-9]+$/);
      assert.equal(type.includes('/'), true);
      assert.equal(type.includes('javascript'), extension === '.js' || extension === '.mjs');
    }
  });

  test('does not offer an executable or source-leaking type', () => {
    assert.equal(CONTENT_TYPES.has('.php'), false);
    assert.equal(CONTENT_TYPES.has('.sh'), false);
    assert.equal(CONTENT_TYPES.has('.map'), false);
  });
});

describe('buildEtag', () => {
  test('is stable for the same inputs and changes when content changes', () => {
    assert.equal(buildEtag(100, 1000), buildEtag(100, 1000));
    assert.notEqual(buildEtag(100, 1000), buildEtag(101, 1000));
    assert.notEqual(buildEtag(100, 1000), buildEtag(100, 2000));
  });

  test('is a weak validator with no injectable characters', () => {
    const etag = buildEtag(10, 20);
    assert.match(etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  });
});

describe('resolveRealAsset', () => {
  /** Build a document root containing one real file plus an outside secret. */
  async function withRoots(run) {
    const base = await mkdtemp(join(tmpdir(), 'homecompass-static-'));
    const root = join(base, 'public');
    const outside = join(base, 'secret.txt');
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'assets', 'app.css'), 'body{}', 'utf8');
    await writeFile(outside, 'TOP-SECRET', 'utf8');
    try {
      await run({ base, root, outside });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  test('resolves a genuine asset to its real path', () =>
    withRoots(async ({ root }) => {
      const resolved = await resolveRealAsset(root, join(root, 'assets', 'app.css'));
      assert.ok(resolved !== null);
      assert.match(resolved, /app\.css$/);
    }));

  test('refuses a symlink that escapes the document root', async () => {
    await withRoots(async ({ root, outside }) => {
      // Lexical validation passes this path: it contains no `..` and ends in an
      // allowed extension. Only a real-path check can see where it lands.
      const link = join(root, 'assets', 'escape.txt');
      try {
        await symlink(outside, link, 'file');
      } catch {
        return; // Creating symlinks may require elevation on this platform.
      }
      assert.equal(await resolveRealAsset(root, link), null);
    });
  });

  test('allows a symlink that stays inside the document root', async () => {
    await withRoots(async ({ root }) => {
      const link = join(root, 'assets', 'alias.txt');
      try {
        await symlink(join(root, 'assets', 'app.css'), link, 'file');
      } catch {
        return;
      }
      const resolved = await resolveRealAsset(root, link);
      assert.ok(resolved !== null);
      assert.match(resolved, /app\.css$/);
    });
  });

  test('returns null for a missing file or missing root', async () =>
    withRoots(async ({ root, base }) => {
      assert.equal(await resolveRealAsset(root, join(root, 'assets', 'nope.css')), null);
      assert.equal(await resolveRealAsset(join(base, 'no-such-root'), join(root, 'app.css')), null);
    }));
});
