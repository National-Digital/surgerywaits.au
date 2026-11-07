import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

import { readDist } from '../lib/dist';
import { hasNoindex } from '../lib/noindex';
import { indexablePairPaths, pairRoutes } from '../lib/pair-page';
import { MAX_BYTES, MAX_URLS, releaseDate } from '../lib/sitemap';

const dist = new URL('../../dist/', import.meta.url);
if (!existsSync(dist)) {
  throw new Error('site/dist is missing: run `npm run build` before BUILT_PAGES=1 npm test');
}
const ORIGIN = 'https://surgerywaits.au';
const onRealDist = pairRoutes().length > 1000;
const text = (file: string): string => readFileSync(new URL(file, dist), 'utf8');

const built = new Map<string, boolean>();
const URL_ROW = /^ {2}<url><loc>([^<>]+)<\/loc>(<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>)?<\/url>$/u;
const HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

// Each file is held to the exact shape the generator writes, which is well-formed XML.
function rows(file: string, root: 'urlset' | 'sitemapindex', child: 'url' | 'sitemap'): string[] {
  const lines = text(file).split('\n');
  const open = `<${root} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
  expect(lines[0]).toBe(HEADER);
  expect(lines[1]).toBe(open);
  expect(lines.at(-2)).toBe(`</${root}>`);
  expect(lines.at(-1)).toBe('');
  return lines.slice(2, -2).map((line) => {
    const row = line.replace(`<${child}>`, '<url>').replace(`</${child}>`, '</url>');
    const found = URL_ROW.exec(row);
    expect(found, line).not.toBeNull();
    const loc = found?.[1] ?? '';
    expect(loc.replace(/&(amp|lt|gt|quot|apos);/gu, '')).not.toContain('&');
    return loc;
  });
}

const sitemapFiles = (): string[] =>
  readdirSync(dist)
    .filter((f) => /^sitemap-.+\.xml$/u.test(f))
    .sort();

beforeAll(() => {
  for (const file of readdirSync(dist, { recursive: true, encoding: 'utf8' })) {
    if (file === 'index.html' || file.endsWith('/index.html')) {
      built.set(`/${file.slice(0, -'index.html'.length)}`, hasNoindex(text(file)));
    }
  }
}, 120_000);

describe('the sitemaps', () => {
  it('has an index that lists every family file once and no other', () => {
    const listed = rows('sitemap.xml', 'sitemapindex', 'sitemap');
    expect(listed).toEqual(sitemapFiles().map((f) => `${ORIGIN}/${f}`));
    expect(listed.length).toBeGreaterThan(0);
  });

  it('keeps every file inside the count and size limits and valid', () => {
    for (const file of sitemapFiles()) {
      const urls = rows(file, 'urlset', 'url');
      expect(urls.length, file).toBeGreaterThan(0);
      expect(urls.length, file).toBeLessThanOrEqual(MAX_URLS);
      expect(Buffer.byteLength(text(file)), file).toBeLessThanOrEqual(MAX_BYTES);
    }
  });

  it('lists exactly the indexable pages that were built, each once', () => {
    const urls = sitemapFiles().flatMap((f) => rows(f, 'urlset', 'url'));
    expect(new Set(urls).size).toBe(urls.length);
    const expected = [...built]
      .filter(([, noindex]) => !noindex)
      .map(([path]) => `${ORIGIN}${path}`)
      .sort();
    expect([...urls].sort()).toEqual(expected);
  });

  it('lists no page that is marked noindex and no page that was not built', () => {
    for (const url of sitemapFiles().flatMap((f) => rows(f, 'urlset', 'url'))) {
      const parsed = new URL(url);
      expect(parsed.origin, url).toBe(ORIGIN);
      expect(`${parsed.origin}${parsed.pathname}`, url).toBe(url);
      expect(built.get(parsed.pathname), url).toBe(false);
    }
  });

  it('lists the pairs that the page rules call indexable, and no thin one', () => {
    const listed = sitemapFiles()
      .filter((f) => f.startsWith('sitemap-pairs-'))
      .flatMap((f) => rows(f, 'urlset', 'url'))
      .map((url) => url.slice(ORIGIN.length))
      .sort();
    expect(listed).toEqual([...indexablePairPaths()].sort());
  });

  it('dates each entry with the data release', () => {
    const release = releaseDate(readDist('index.json'));
    expect(release).toBeDefined();
    for (const file of ['sitemap.xml', ...sitemapFiles()]) {
      const dates = [...text(file).matchAll(/<lastmod>([^<]+)<\/lastmod>/gu)].map((m) => m[1]);
      expect(new Set(dates), file).toEqual(new Set([release]));
    }
  });
});

describe('robots.txt', () => {
  it('points at the sitemap index and blocks nothing', () => {
    const robots = text('robots.txt');
    expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    expect(robots).not.toMatch(/^Disallow:\s*\S/mu);
  });
});

describe('the redirects, against the pages built', () => {
  const { redirects } = JSON.parse(
    readFileSync(new URL('../../../data/redirects.json', import.meta.url), 'utf8'),
  ) as { redirects: { from: string; to: string }[] };

  it('takes no source from a page that is built', () => {
    expect(redirects.filter((r) => built.has(r.from))).toEqual([]);
  });

  // The Tweed targets exist only in the real data, so the fixture dist cannot hold them.
  it.runIf(onRealDist)('ends every redirect at a page that is built', () => {
    expect(redirects.filter((r) => !built.has(r.to.split('#')[0] ?? ''))).toEqual([]);
  });
});
