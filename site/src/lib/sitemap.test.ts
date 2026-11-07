import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  builtPages,
  familyOf,
  PAIRS_PER_FILE,
  releaseDate,
  sitemapFiles,
  sitemapIndex,
  urlset,
  writeSitemaps,
} from './sitemap';

const ORIGIN = 'https://example.test';
const page = (path: string, noindex = false): { path: string; noindex: boolean } => ({
  path,
  noindex,
});
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe('familyOf', () => {
  it('splits the site into the earlier files, and one more for specialties', () => {
    expect(
      [
        '/',
        '/hospitals/',
        '/hospital/a/',
        '/hospital/a/knee/',
        '/surgery/',
        '/surgery/knee/nsw/',
        '/surgery/knee/near/herston/',
        '/specialty/ent/',
        '/state/nsw/',
        '/urgency/1/',
        '/longest-waits/',
      ].map(familyOf),
    ).toEqual([
      'core',
      'hospitals',
      'hospitals',
      'pairs',
      'surgery',
      'surgery',
      'near',
      'specialty',
      'state',
      'core',
      'core',
    ]);
  });
});

describe('sitemapFiles', () => {
  it('leaves out a noindex page and an empty family', () => {
    const files = sitemapFiles(
      [page('/'), page('/hospital/a/k/', true), page('/state/nsw/')],
      ORIGIN,
    );
    expect(files.map((f) => f.name)).toEqual(['sitemap-core.xml', 'sitemap-state.xml']);
    expect(files.flatMap((f) => f.urls)).toEqual([`${ORIGIN}/`, `${ORIGIN}/state/nsw/`]);
  });

  it('cuts the pairs into numbered files', () => {
    const pages = Array.from({ length: PAIRS_PER_FILE + 1 }, (_, i) =>
      page(`/hospital/h/s${String(i).padStart(5, '0')}/`),
    );
    const files = sitemapFiles(pages, ORIGIN);
    expect(files.map((f) => [f.name, f.urls.length])).toEqual([
      ['sitemap-pairs-1.xml', PAIRS_PER_FILE],
      ['sitemap-pairs-2.xml', 1],
    ]);
  });
});

describe('documents', () => {
  it('escapes the address and adds the release date as lastmod', () => {
    expect(urlset([`${ORIGIN}/a&b/`], '2026-08-19')).toContain(
      '<loc>https://example.test/a&amp;b/</loc><lastmod>2026-08-19</lastmod>',
    );
    expect(urlset([`${ORIGIN}/`], undefined)).not.toContain('lastmod');
    expect(sitemapIndex([{ name: 'sitemap-core.xml', urls: [] }], ORIGIN, undefined)).toContain(
      '<loc>https://example.test/sitemap-core.xml</loc>',
    );
  });

  it('takes the newest release date among the tables', () => {
    const tables = [{ release: '2026-05-28' }, { release: '2026-08-19' }, { release: null }];
    expect(releaseDate({ tables })).toBe('2026-08-19');
    expect(releaseDate({ tables: [] })).toBeUndefined();
    expect(releaseDate(null)).toBeUndefined();
  });
});

describe('writeSitemaps', () => {
  it('lists the built indexable pages and nothing else', () => {
    const dist = mkdtempSync(join(tmpdir(), 'sitemap-'));
    folders.push(dist);
    const write = (path: string, head: string): void => {
      mkdirSync(join(dist, path), { recursive: true });
      writeFileSync(join(dist, path, 'index.html'), `<html><head>${head}</head></html>`);
    };
    write('.', '');
    write('state/nsw', '<meta name="robots" content="index">');
    write('hospital/a/knee', '<meta name="robots" content="noindex,follow">');
    writeFileSync(join(dist, '404.html'), '<html></html>');
    writeFileSync(
      join(dist, 'index.json'),
      JSON.stringify({ tables: [{ release: '2026-08-19' }] }),
    );
    expect(builtPages(dist).map((p) => [p.path, p.noindex])).toEqual([
      ['/', false],
      ['/hospital/a/knee/', true],
      ['/state/nsw/', false],
    ]);
    expect(writeSitemaps(dist, ORIGIN, dist)).toEqual([
      'sitemap-core.xml',
      'sitemap-state.xml',
      'sitemap.xml',
    ]);
    const text = readFileSync(join(dist, 'sitemap-state.xml'), 'utf8');
    expect(text).toContain('<loc>https://example.test/state/nsw/</loc>');
    expect(readFileSync(join(dist, 'sitemap.xml'), 'utf8')).toContain('sitemap-state.xml');
  });
});
