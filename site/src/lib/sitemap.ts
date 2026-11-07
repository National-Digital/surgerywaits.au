import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hasNoindex } from './noindex';

// The sitemap protocol allows 50,000 URLs and 50 MB a file; pairs are cut well below that.
export const MAX_URLS = 50_000;
export const MAX_BYTES = 50 * 1024 * 1024;
export const PAIRS_PER_FILE = 5000;

export interface BuiltPage {
  path: string;
  noindex: boolean;
}

// Every directory page the build wrote; 404.html is not one, so an error page never lists.
export function builtPages(dist: string): BuiltPage[] {
  return readdirSync(dist, { recursive: true, encoding: 'utf8' })
    .filter((file) => file === 'index.html' || file.endsWith('/index.html'))
    .map((file) => ({
      path: `/${file.slice(0, -'index.html'.length)}`,
      noindex: hasNoindex(readFileSync(join(dist, file), 'utf8')),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

const segments = (path: string): string[] => path.split('/').filter((s) => s !== '');

// The families keep the earlier site's file names where there was one.
export function familyOf(path: string): string {
  const [first, , third] = segments(path);
  const depth = segments(path).length;
  switch (first) {
    case 'hospital':
      return depth >= 3 ? 'pairs' : 'hospitals';
    case 'hospitals':
      return 'hospitals';
    case 'surgery':
      return third === 'near' ? 'near' : 'surgery';
    case 'specialty':
    case 'state':
      return first;
    default:
      return 'core';
  }
}

export interface SitemapFile {
  name: string;
  urls: string[];
}

// The indexable pages grouped into files, in a fixed order so two builds match.
export function sitemapFiles(pages: readonly BuiltPage[], origin: string): SitemapFile[] {
  const groups = new Map<string, string[]>();
  for (const page of pages) {
    if (!page.noindex) {
      const family = familyOf(page.path);
      groups.set(family, [...(groups.get(family) ?? []), new URL(page.path, origin).href]);
    }
  }
  const files: SitemapFile[] = [];
  for (const family of [...groups.keys()].sort()) {
    const urls = groups.get(family) ?? [];
    if (family === 'pairs') {
      for (let i = 0; i * PAIRS_PER_FILE < urls.length; i += 1) {
        files.push({
          name: `sitemap-pairs-${String(i + 1)}.xml`,
          urls: urls.slice(i * PAIRS_PER_FILE, (i + 1) * PAIRS_PER_FILE),
        });
      }
    } else {
      files.push({ name: `sitemap-${family}.xml`, urls });
    }
  }
  return files;
}

const escapeXml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const lastmodOf = (lastmod: string | undefined): string =>
  lastmod === undefined ? '' : `<lastmod>${lastmod}</lastmod>`;

const NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';

export function urlset(urls: readonly string[], lastmod: string | undefined): string {
  const rows = urls.map((url) => `  <url><loc>${escapeXml(url)}</loc>${lastmodOf(lastmod)}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${NAMESPACE}">\n${rows.join('\n')}\n</urlset>\n`;
}

export function sitemapIndex(
  files: readonly SitemapFile[],
  origin: string,
  lastmod: string | undefined,
): string {
  const rows = files.map(
    (file) =>
      `  <sitemap><loc>${escapeXml(new URL(file.name, origin).href)}</loc>${lastmodOf(lastmod)}</sitemap>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="${NAMESPACE}">\n${rows.join('\n')}\n</sitemapindex>\n`;
}

// The newest release date among the data tables, or nothing when the dist names none.
export function releaseDate(index: unknown): string | undefined {
  const tables =
    typeof index === 'object' && index !== null && 'tables' in index ? index.tables : undefined;
  if (!Array.isArray(tables)) {
    return undefined;
  }
  const dates = tables
    .map((table: unknown) =>
      typeof table === 'object' && table !== null && 'release' in table ? table.release : undefined,
    )
    .filter(
      (date): date is string => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(date),
    );
  return dates.sort().at(-1);
}

// Writes the index and the family files beside the pages, listing only what the build wrote.
export function writeSitemaps(dist: string, origin: string, dataDist: string): string[] {
  const files = sitemapFiles(builtPages(dist), origin);
  const lastmod = releaseDate(JSON.parse(readFileSync(join(dataDist, 'index.json'), 'utf8')));
  const documents = [
    ...files.map((file) => ({
      name: file.name,
      text: urlset(file.urls, lastmod),
      count: file.urls.length,
    })),
    { name: 'sitemap.xml', text: sitemapIndex(files, origin, lastmod), count: files.length },
  ];
  for (const { name, text, count } of documents) {
    if (count > MAX_URLS || Buffer.byteLength(text) > MAX_BYTES) {
      throw new RangeError(`${name} is over the sitemap limits`);
    }
    writeFileSync(join(dist, name), text);
  }
  return documents.map((d) => d.name);
}
