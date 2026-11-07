import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

import { readCredits } from '../lib/credits';
import { readHospitalIndex } from '../lib/dist';
import { textsOf } from '../lib/test-render';

const dist = new URL('../../dist/', import.meta.url);
if (!existsSync(dist)) {
  throw new Error('site/dist is missing: run `npm run build` before BUILT_PAGES=1 npm test');
}

// The schema.org types the site uses, with the properties each may carry.
const COMMON = ['@type', '@id'];
const VOCAB: Readonly<Record<string, readonly string[]>> = {
  Organization: ['name', 'url', 'contactPoint'],
  ContactPoint: ['contactType', 'url'],
  WebSite: ['name', 'url', 'inLanguage', 'publisher'],
  WebPage: [
    'url',
    'name',
    'description',
    'inLanguage',
    'dateModified',
    'about',
    'isPartOf',
    'publisher',
  ],
  MedicalWebPage: [
    'url',
    'name',
    'description',
    'inLanguage',
    'dateModified',
    'about',
    'isPartOf',
    'publisher',
  ],
  BreadcrumbList: ['itemListElement'],
  ListItem: ['position', 'name', 'item'],
  Hospital: ['name', 'address', 'geo'],
  PostalAddress: ['addressRegion', 'addressCountry'],
  GeoCoordinates: ['latitude', 'longitude'],
  Dataset: [
    'name',
    'description',
    'url',
    'version',
    'creator',
    'publisher',
    'license',
    'citation',
    'isBasedOn',
    'isAccessibleForFree',
    'inLanguage',
    'datePublished',
    'temporalCoverage',
    'distribution',
  ],
  DataDownload: ['contentUrl', 'encodingFormat'],
};
// The only properties that hold a number.
const NUMBERS = new Set(['position', 'latitude', 'longitude']);
const DATES = new Set(['dateModified', 'datePublished']);

type Json = Record<string, unknown>;
interface Page {
  path: string;
  html: string;
  nodes: Json[];
  scripts: number;
}

const BLOCK = /<script([^>]*)>(.*?)<\/script>/gsu;
const files = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.html'))
  .sort();
// The real dist holds thousands of pairs, so its per-page checks cover one pair in every STEP.
const STEP = files.length > 5000 ? 25 : 1;
const pages: Page[] = [];

function walk(
  value: unknown,
  visit: (node: Json, key: string | undefined) => void,
  key?: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => {
      walk(item, visit, key);
    });
  } else if (typeof value === 'object' && value !== null) {
    visit(value as Json, key);
    for (const [name, item] of Object.entries(value)) {
      walk(item, visit, name);
    }
  }
}

beforeAll(() => {
  files.forEach((file, index) => {
    if (/^(hospital|surgery)\/[^/]+\/.+\/index\.html$/u.test(file) && index % STEP !== 0) {
      return;
    }
    const html = readFileSync(new URL(file, dist), 'utf8');
    const nodes: Json[] = [];
    let scripts = 0;
    for (const [, attrs = '', body = ''] of html.matchAll(BLOCK)) {
      if (attrs === ' type="application/ld+json"') {
        scripts += 1;
        const { '@graph': graph } = JSON.parse(body) as { '@graph': Json[] };
        nodes.push(...graph);
      }
    }
    pages.push({ path: `/${file.replace(/index\.html$/u, '')}`, html, nodes, scripts });
  });
});

const canonicalOf = (html: string): string | undefined =>
  /<link rel="canonical" href="([^"]+)"/u.exec(html)?.[1];
const titleOf = (html: string): string => /<title>([^<]*)<\/title>/u.exec(html)?.[1] ?? '';
const decode = (text: string): string =>
  text.replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&quot;', '"');
const ofType = (page: Page, type: string): Json[] => page.nodes.filter((n) => n['@type'] === type);

describe('JSON-LD on every page', () => {
  it('sits in script elements of the ld+json type apart from the compare tool, each holding one JSON document in the schema.org context', () => {
    expect(pages.length).toBeGreaterThan(0);
    for (const { path, html } of pages) {
      for (const [, attrs = '', body = ''] of html.matchAll(BLOCK)) {
        // The compare tool's module is the one script that runs.
        if (attrs.startsWith(' type="module" src="/_astro/')) {
          continue;
        }
        expect([path, attrs]).toEqual([path, ' type="application/ld+json"']);
        expect([path, (JSON.parse(body) as Json)['@context']]).toEqual([
          path,
          'https://schema.org',
        ]);
      }
    }
  });

  it('uses only the schema.org types and properties the site has pinned', () => {
    for (const { path, nodes } of pages) {
      for (const root of nodes) {
        walk(root, (node, key) => {
          const type = node['@type'];
          if (typeof type !== 'string') {
            expect([path, key, 'is a bare reference']).toEqual([
              path,
              key,
              Object.keys(node).join() === '@id' ? 'is a bare reference' : 'has a type',
            ]);
            return;
          }
          const allowed = VOCAB[type];
          expect([path, type, allowed !== undefined]).toEqual([path, type, true]);
          for (const name of Object.keys(node)) {
            expect([path, type, name, [...COMMON, ...(allowed ?? [])].includes(name)]).toEqual([
              path,
              type,
              name,
              true,
            ]);
          }
        });
      }
    }
  });

  it('gives each @id one type across the site, and no page two nodes of one id', () => {
    const types = new Map<string, Set<string>>();
    for (const { path, nodes } of pages) {
      const own = new Set<string>();
      for (const node of nodes) {
        const id = node['@id'] as string;
        expect([path, id, own.has(id)]).toEqual([path, id, false]);
        own.add(id);
        types.set(id, (types.get(id) ?? new Set()).add(node['@type'] as string));
      }
    }
    for (const [id, set] of types) {
      expect([id, [...set]]).toEqual([id, [[...set][0]]]);
    }
  });

  it('holds a number only for a position or a coordinate, and an ISO date for each date', () => {
    for (const { path, nodes } of pages) {
      walk(nodes, (node) => {
        for (const [name, value] of Object.entries(node)) {
          expect([path, name, typeof value === 'number' ? NUMBERS.has(name) : true]).toEqual([
            path,
            name,
            true,
          ]);
          if (DATES.has(name)) {
            expect([path, name, /^\d{4}-\d{2}-\d{2}$/u.test(String(value))]).toEqual([
              path,
              name,
              true,
            ]);
          }
        }
      });
    }
  });

  it('names the publisher and the site once, as the same nodes everywhere', () => {
    const first = pages[0];
    const organization = ofType(first ?? ({ nodes: [] } as unknown as Page), 'Organization')[0];
    const website = ofType(first ?? ({ nodes: [] } as unknown as Page), 'WebSite')[0];
    expect(organization?.['@id']).toBe('https://nationaldigital.com.au/#organization');
    expect(organization?.['name']).toBe('National Digital');
    expect(website?.['@id']).toBe('https://surgerywaits.au/#website');
    for (const page of pages) {
      expect([page.path, ofType(page, 'Organization')]).toEqual([page.path, [organization]]);
      expect([page.path, ofType(page, 'WebSite')]).toEqual([page.path, [website]]);
    }
  });

  it('says what the page says: its address and its title', () => {
    for (const page of pages.filter(({ html }) => canonicalOf(html) !== undefined)) {
      const canonical = canonicalOf(page.html) ?? '';
      const [node, ...rest] = page.nodes.filter((n) => String(n['@type']).endsWith('WebPage'));
      expect([page.path, rest.length]).toEqual([page.path, 0]);
      expect([page.path, node?.['@id'], node?.['url']]).toEqual([
        page.path,
        `${canonical}#webpage`,
        canonical,
      ]);
      expect([page.path, node?.['name']]).toEqual([page.path, decode(titleOf(page.html))]);
      expect([page.path, node?.['@type']]).toEqual([
        page.path,
        /^\/guides\/[^/]+\/$/u.test(page.path) ? 'MedicalWebPage' : 'WebPage',
      ]);
    }
  });

  it('lists the breadcrumbs the page shows, ending on the page itself, and no others', () => {
    for (const page of pages) {
      const shown = textsOf(page.html, 'c-breadcrumbs__item');
      const hrefs = [...page.html.matchAll(/class="c-breadcrumbs__link" href="([^"]+)"/gu)].map(
        (m) => m[1],
      );
      const lists = ofType(page, 'BreadcrumbList');
      if (shown.length === 0) {
        expect([page.path, lists.length]).toEqual([page.path, 0]);
        continue;
      }
      const canonical = canonicalOf(page.html);
      const items = (lists[0]?.['itemListElement'] ?? []) as Json[];
      expect([page.path, lists.length]).toEqual([page.path, 1]);
      expect([page.path, items.map((i) => i['name'])]).toEqual([page.path, shown.map(decode)]);
      expect([page.path, items.slice(0, -1).map((i) => i['item'])]).toEqual([
        page.path,
        hrefs.map((href) => `https://surgerywaits.au${href ?? ''}`),
      ]);
      expect([page.path, items.at(-1)?.['item']]).toEqual([page.path, canonical]);
      expect([page.path, lists[0]?.['@id']]).toEqual([page.path, `${canonical ?? ''}#breadcrumb`]);
    }
  });
});

describe('JSON-LD for a hospital', () => {
  const mine = (): Page[] => pages.filter(({ path }) => /^\/hospital\/[^/]+\/$/u.test(path));

  it('describes the hospital the page names, at the coordinates the register holds', () => {
    const register = new Map(readHospitalIndex().map((row) => [row.slug, row]));
    expect(mine().length).toBeGreaterThan(0);
    for (const page of mine()) {
      const [node] = ofType(page, 'Hospital');
      const row = register.get(page.path.split('/')[2] ?? '');
      expect([page.path, node?.['name']]).toEqual([
        page.path,
        decode(textsOf(page.html, 'h1')[0] ?? ''),
      ]);
      expect([page.path, node?.['@id']]).toEqual([
        page.path,
        `https://surgerywaits.au${page.path}#hospital`,
      ]);
      expect([page.path, ofType(page, 'WebPage')[0]?.['about']]).toEqual([
        page.path,
        { '@id': node?.['@id'] },
      ]);
      const geo = node?.['geo'] as Json | undefined;
      expect([page.path, geo?.['latitude'] ?? null, geo?.['longitude'] ?? null]).toEqual([
        page.path,
        row?.latitude ?? null,
        row?.longitude ?? null,
      ]);
    }
  });
});

describe('JSON-LD for data', () => {
  const credits = readCredits();
  const dataset = (path: string): Page | undefined => pages.find((page) => page.path === path);

  it('lists each credited dataset on the data page with its licence and publicdata.au citation', () => {
    const nodes = ofType(dataset('/data/') ?? ({ nodes: [] } as unknown as Page), 'Dataset');
    expect(nodes.map((n) => n['@id'])).toEqual(credits.map((c) => c.dataset_url));
    for (const credit of credits) {
      const node = nodes.find((n) => n['@id'] === credit.dataset_url);
      expect([credit.slug, node?.['citation']]).toEqual([credit.slug, credit.citation]);
      expect([credit.slug, node?.['name']]).toEqual([credit.slug, credit.title]);
      expect(String(node?.['license'])).toMatch(/^https:\/\/creativecommons\.org\/licenses\/by\//u);
      expect([credit.slug, node?.['datePublished']]).toEqual([
        credit.slug,
        credit.as_at ?? undefined,
      ]);
    }
  });

  it('points each surgery and state dataset at a data file the site serves, citing only credited sources', () => {
    const own = pages.filter(({ path }) => /^\/(surgery|specialty|state)\/[^/]+\/$/u.test(path));
    const known = new Set(credits.map((c) => c.dataset_url));
    expect(own.length).toBeGreaterThan(0);
    for (const page of own) {
      const [node] = ofType(page, 'Dataset');
      const file = new URL(String((node?.['distribution'] as Json | undefined)?.['contentUrl']))
        .pathname;
      expect([page.path, existsSync(new URL(`.${file}`, dist))]).toEqual([page.path, true]);
      const sources = (node?.['isBasedOn'] as { '@id': string }[]).map((s) => s['@id']);
      expect([page.path, sources.length > 0, sources.every((s) => known.has(s))]).toEqual([
        page.path,
        true,
        true,
      ]);
      expect([page.path, node?.['citation']]).toEqual([
        page.path,
        sources.map((s) => credits.find((c) => c.dataset_url === s)?.citation),
      ]);
      expect(String(node?.['temporalCoverage'])).toMatch(/^\d{4}-07-01\/\d{4}-06-30$/u);
    }
  });
});
