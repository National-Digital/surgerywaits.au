import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { beforeAll, describe, expect, it } from 'vitest';

import { distSlug, readContent, replacedTerms } from '../lib/content-files';
import { termsSchema } from '../lib/content-schema';
import { licenceUrl, readCredits } from '../lib/credits';
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
  WebPage: ['url', 'name', 'description', 'inLanguage', 'about', 'isPartOf', 'publisher'],
  MedicalWebPage: ['url', 'name', 'description', 'inLanguage', 'about', 'isPartOf', 'publisher'],
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
    'dateModified',
    'temporalCoverage',
    'distribution',
  ],
  DataDownload: ['contentUrl', 'encodingFormat'],
};
// The only properties that hold a number.
// What every Dataset must say, wherever it sits; only a source dataset on /data/ quotes a citation.
const DATASET_REQUIRED = ['name', 'description', 'url', 'license'];
const NUMBERS = new Set(['position', 'latitude', 'longitude']);
const DATES = new Set(['dateModified', 'datePublished']);

type Json = Record<string, unknown>;
interface Page {
  path: string;
  html: string;
  nodes: Json[];
  scripts: number;
}
// What the cheap checks read from every built page, which the sampled pages share.
interface Seen {
  path: string;
  scripts: number;
  stray: string[];
  contexts: unknown[];
  ids: string[];
  types: Map<string, string>;
  replaced: string[];
}
const terms = termsSchema.parse(readContent().find(({ path }) => path === 'terms.yaml')?.data);

type Element = DefaultTreeAdapterTypes.Element;
// A parser reads script tags as a browser does, whatever their case or spacing.
const scriptsOf = (node: DefaultTreeAdapterTypes.ParentNode): Element[] =>
  node.childNodes.flatMap((child) => [
    ...('tagName' in child && child.tagName === 'script' ? [child] : []),
    ...('childNodes' in child ? scriptsOf(child) : []),
    ...('content' in child ? scriptsOf(child.content) : []),
  ]);
const attrOf = (el: Element, name: string): string | undefined =>
  el.attrs.find((a) => a.name === name)?.value;
const files = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.html'))
  .sort();
// The real dist holds thousands of pairs, so its per-page checks cover one pair in every STEP.
const STEP = files.length > 5000 ? 25 : 1;
const pages: Page[] = [];
const seen: Seen[] = [];

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

// An address is not prose, and a credited dataset's address spells the publisher's word.
const ADDRESS = /^https?:\/\/\S+$/u;

function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (!ADDRESS.test(value)) {
      out.push(value);
    }
  } else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach((item) => stringsOf(item, out));
  }
  return out;
}

// Parsing every page of the real build takes longer than the default hook limit.
beforeAll(() => {
  files.forEach((file, index) => {
    const html = readFileSync(new URL(file, dist), 'utf8');
    const path = `/${file.replace(/index\.html$/u, '')}`;
    const nodes: Json[] = [];
    const found: Seen = {
      path,
      scripts: 0,
      stray: [],
      contexts: [],
      ids: [],
      types: new Map(),
      replaced: [],
    };
    for (const script of scriptsOf(parse(html, { scriptingEnabled: false }))) {
      const type = attrOf(script, 'type');
      const src = attrOf(script, 'src');
      if (type === 'application/ld+json' && src === undefined && script.attrs.length === 1) {
        found.scripts += 1;
        const body = script.childNodes.map((c) => ('value' in c ? c.value : '')).join('');
        const document = JSON.parse(body) as Json;
        found.contexts.push(document['@context']);
        nodes.push(...(document['@graph'] as Json[]));
      } else if (!(type === 'module' && (src ?? '').startsWith('/_astro/'))) {
        // The compare tool's module is the one script that runs.
        found.stray.push(script.attrs.map((a) => `${a.name}=${a.value}`).join(' '));
      }
    }
    for (const node of nodes) {
      found.ids.push(String(node['@id']));
      found.types.set(String(node['@id']), String(node['@type']));
    }
    found.replaced = replacedTerms(distSlug(file), stringsOf(nodes), terms);
    seen.push(found);
    if (!(/^(hospital|surgery)\/[^/]+\/.+\/index\.html$/u.test(file) && index % STEP !== 0)) {
      pages.push({ path, html, nodes, scripts: found.scripts });
    }
  });
}, 300_000);

const MONTHS =
  'January|February|March|April|May|June|July|August|September|October|November|December';
// A visible stamp reads "2024–25, released 19 August 2026".
const STAMP = new RegExp(`>(\\d{4}–\\d{2}), released (\\d{1,2} (?:${MONTHS}) \\d{4})<`, 'gu');
const isoOf = (shown: string): string => new Date(`${shown} UTC`).toISOString().slice(0, 10);
const coverageOf = (period: string): string => {
  const start = Number(period.slice(0, 4));
  return `${String(start)}-07-01/${String(start + 1)}-06-30`;
};
const stampsOf = (html: string): { period: string; release: string }[] =>
  [...html.matchAll(STAMP)].map((m) => ({ period: m[1] ?? '', release: isoOf(m[2] ?? '') }));

const canonicalOf = (html: string): string | undefined =>
  /<link rel="canonical" href="(.+?)"/u.exec(html)?.[1];
const titleOf = (html: string): string => /<title>([^<]*)<\/title>/u.exec(html)?.[1] ?? '';
// Decoded last, so an escaped entity such as &amp;quot; stays as written.
const decode = (text: string): string =>
  text.replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');
const ofType = (page: Page, type: string): Json[] => page.nodes.filter((n) => n['@type'] === type);

describe('JSON-LD on every page', () => {
  it('sits in script elements of the ld+json type apart from the compare tool, each holding one JSON document in the schema.org context', () => {
    expect(seen.length).toBe(files.length);
    for (const { path, stray, contexts } of seen) {
      expect([path, stray]).toEqual([path, []]);
      expect([path, contexts]).toEqual([path, ['https://schema.org']]);
    }
  });

  it('holds exactly one JSON-LD block on every page', () => {
    for (const { path, scripts } of seen) {
      expect([path, scripts]).toEqual([path, 1]);
    }
  });

  it('holds none of the terms the terms file replaces in any string of any page, apart from its quote pages', () => {
    expect(seen.flatMap((page) => page.replaced)).toEqual([]);
  });

  it('catches a replaced term in a graph, and excuses it only on a quote page', () => {
    const graph = [
      { '@type': 'Dataset', name: 'Elective surgery waiting times', note: ['elective'] },
    ];
    expect(replacedTerms('surgery/knee/', stringsOf(graph), terms)).not.toEqual([]);
    expect(replacedTerms('data', stringsOf(graph), terms)).toEqual([]);
    expect(replacedTerms('data', stringsOf([{ name: 'n/a' }]), terms)).not.toEqual([]);
    const address = [{ url: 'https://publicdata.au/d/au-elective-surgery/v/1/' }];
    expect(replacedTerms('surgery/knee/', stringsOf(address), terms)).toEqual([]);
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
    for (const { path, ids, types: own } of seen) {
      expect([path, ids.length - new Set(ids).size]).toEqual([path, 0]);
      for (const [id, type] of own) {
        types.set(id, (types.get(id) ?? new Set()).add(type));
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

  it('says no date for a page, and gives a dataset only the date its data was published or last changed', () => {
    for (const page of pages) {
      for (const node of page.nodes) {
        expect([page.path, node['@type'], 'dateModified' in node]).toEqual([
          page.path,
          node['@type'],
          node['@type'] === 'Dataset' && page.path !== '/data/',
        ]);
        // Only the data page's sources state a publication date, and that is the publisher's.
        expect([
          page.path,
          node['@type'],
          'datePublished' in node && page.path !== '/data/',
        ]).toEqual([page.path, node['@type'], false]);
      }
    }
  });

  it('gives every Dataset a name, a description, a licence and an address, and a citation only on the data page', () => {
    for (const page of pages) {
      for (const node of ofType(page, 'Dataset')) {
        for (const key of DATASET_REQUIRED) {
          expect([page.path, node['@id'], key, node[key] === undefined]).toEqual([
            page.path,
            node['@id'],
            key,
            false,
          ]);
        }
        expect([page.path, node['@id'], 'citation' in node]).toEqual([
          page.path,
          node['@id'],
          page.path === '/data/',
        ]);
        expect([page.path, typeof node['name'], typeof node['description']]).toEqual([
          page.path,
          'string',
          'string',
        ]);
        const licences = ([] as unknown[]).concat(node['license']);
        expect([page.path, licences.length > 0]).toEqual([page.path, true]);
        for (const licence of licences) {
          expect([page.path, licence]).toEqual([
            page.path,
            expect.stringMatching(/^https:\/\/creativecommons\.org\/licenses\/by\//u),
          ]);
        }
      }
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
      expect([credit.slug, node?.['license']]).toEqual([credit.slug, licenceUrl(credit.licence)]);
      expect(String(node?.['description'])).toContain(credit.publisher.name);
      expect(String(node?.['description'])).toContain(credit.version);
      expect([credit.slug, node?.['datePublished']]).toEqual([
        credit.slug,
        credit.as_at ?? undefined,
      ]);
    }
  });

  it('points each surgery and state dataset at a data file the site serves, based only on credited sources', () => {
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
      const used = sources.map((s) => credits.find((c) => c.dataset_url === s));
      expect([page.path, node?.['license']]).toEqual([
        page.path,
        [...new Set(used.map((c) => licenceUrl(c?.licence ?? '')))].sort().length === 1
          ? licenceUrl(used[0]?.licence ?? '')
          : [...new Set(used.map((c) => licenceUrl(c?.licence ?? '')))].sort(),
      ]);
      expect([page.path, node?.['isBasedOn']]).toEqual([
        page.path,
        used.map((c) => ({
          '@type': 'Dataset',
          '@id': c?.dataset_url,
          url: c?.dataset_url,
        })),
      ]);
      // The visible stamp gives the period and release the dataset repeats.
      const stamps = stampsOf(page.html);
      expect(stamps.length).toBeGreaterThan(0);
      const coverage = String(node?.['temporalCoverage']);
      expect([page.path, stamps.map((st) => coverageOf(st.period)).includes(coverage)]).toEqual([
        page.path,
        true,
      ]);
      const current = stamps.filter((st) => coverageOf(st.period) === coverage);
      expect([
        page.path,
        current.map((st) => st.release).includes(String(node?.['dateModified'])),
      ]).toEqual([page.path, true]);
      expect(String(node?.['description'])).toContain(current[0]?.period ?? '');
      const title = decode(titleOf(page.html));
      const suffix = String(node?.['name']).replace(
        /^Planned surgery waiting times at public hospitals: /u,
        '',
      );
      expect([page.path, suffix !== node?.['name'], title.startsWith(suffix)]).toEqual([
        page.path,
        true,
        true,
      ]);
    }
  });
});
