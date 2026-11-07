import { ABOUT_PATH, DATA_PATH, METHODOLOGY_PATH } from '../lib/article-pages';
import { GP_PATH, GUIDES_PATH } from '../lib/guides';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { afterEach, describe, expect, it, vi } from 'vitest';

import StateHub from '../components/StateHub.astro';
import StateIndex from '../components/StateIndex.astro';
import SurgeryIndex from '../components/SurgeryIndex.astro';
import UrgencyCategory from '../components/UrgencyCategory.astro';
import UrgencyIndex from '../components/UrgencyIndex.astro';
import { getHospitalTemplate, getSite, getStateTemplate, getUrgencyTemplate } from '../lib/content';
import { DIST_ENV, distDirectory, readHospitalIndex } from '../lib/dist';
import type { Surgery } from '../lib/dist';
import { hospitalSlugs } from '../lib/hospital-page';
import { fill } from '../lib/slots';
import { stateFiles, statePath, stateRoutes } from '../lib/state-page';
import {
  hubRoutes,
  refOf,
  stateRoutes as surgeryStateRoutes,
  surgeryPath,
  statePath as surgeryStatePath,
} from '../lib/surgery-page';
import { elementsOf, render, text, textsOf, withoutJsonLd } from '../lib/test-render';
import {
  categories,
  categoryByNumber,
  categoryRoutes,
  categoryStateRoutes,
  categoryStatePath,
} from '../lib/urgency-page';

const st = getStateTemplate();
const ut = getUrgencyTemplate();
const site = getSite();
const names = getHospitalTemplate().states;

const copies: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const copy of copies.splice(0)) {
    rmSync(copy, { recursive: true, force: true });
  }
});

// The addresses the earlier site published, from its sitemap, so a renamed route cannot pass by being read back from the code.
const EARLIER = {
  state: [
    '/state/',
    ...['act', 'nsw', 'nt', 'qld', 'sa', 'tas', 'vic', 'wa'].map((s) => `/state/${s}/`),
  ],
  urgency: [
    '/urgency/',
    ...[1, 2, 3].flatMap((n) => [
      `/urgency/category-${String(n)}/`,
      ...['act', 'nsw', 'nt', 'qld', 'sa', 'tas', 'vic', 'wa'].map(
        (s) => `/urgency/category-${String(n)}/${s}/`,
      ),
    ]),
  ],
};

function builtAddresses(): string[] {
  return [
    '/state/',
    ...stateRoutes().map(({ props }) => statePath(props.state)),
    '/urgency/',
    ...categories().map((c) => c.path),
    ...categoryStateRoutes().map(({ props }) => {
      return categoryStatePath(categoryByNumber(props.number), props.state);
    }),
  ].sort();
}

function hrefs(html: string): string[] {
  const out: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ('tagName' in node && node.tagName === 'a') {
      out.push(node.attrs.find((a) => a.name === 'href')?.value ?? '');
    }
    if ('childNodes' in node) {
      node.childNodes.forEach(visit);
    }
  };
  visit(parseFragment(html));
  return out;
}

const main = (html: string): string => text(html.split('<main')[1] ?? html);

async function allPages(): Promise<{ path: string; html: string }[]> {
  const pages = [
    { path: '/state/', html: await render(StateIndex, {}) },
    { path: '/urgency/', html: await render(UrgencyIndex, {}) },
  ];
  for (const { props } of stateRoutes()) {
    pages.push({ path: statePath(props.state), html: await render(StateHub, props) });
  }
  for (const { props } of categoryRoutes()) {
    pages.push({
      path: categories().find((c) => c.number === props.number)?.path ?? '',
      html: await render(UrgencyCategory, props),
    });
  }
  for (const { props } of categoryStateRoutes()) {
    pages.push({
      path: categoryStatePath(categoryByNumber(props.number), props.state),
      html: await render(UrgencyCategory, props),
    });
  }
  return pages;
}

const pages = await allPages();
const page = (path: string): string => pages.find((p) => p.path === path)?.html ?? '';

describe('Earlier addresses', () => {
  it('keep the state and urgency addresses of the earlier site', () => {
    const built = new Set(builtAddresses());
    for (const address of [...EARLIER.state, ...EARLIER.urgency]) {
      // A state absent from the fixtures has no page, so only those present are pinned.
      const state = /\/(act|nsw|nt|qld|sa|tas|vic|wa)\/$/.exec(address)?.[1];
      if (state !== undefined && !stateFiles().some((f) => f.state.toLowerCase() === state)) {
        continue;
      }
      expect([address, built.has(address)]).toEqual([address, true]);
    }
  });

  it('build nothing outside the earlier scheme', () => {
    const earlier = new Set([...EARLIER.state, ...EARLIER.urgency]);
    for (const address of builtAddresses()) {
      expect([address, earlier.has(address)]).toEqual([address, true]);
    }
  });

  it('give a state page to every state file and a category page to each of the three categories', () => {
    expect(stateRoutes().map((r) => r.params.state)).toEqual(
      stateFiles().map((f) => f.state.toLowerCase()),
    );
    expect(categories().map((c) => c.path)).toEqual([
      '/urgency/category-1/',
      '/urgency/category-2/',
      '/urgency/category-3/',
    ]);
  });

  it('give a category state page to exactly the states with an open hospital row', () => {
    for (const category of categories()) {
      const rows = readHospitalIndex().filter((h) => !h.closed);
      const wanted = rows.map((h) => h.state.toLowerCase());
      const got = categoryStateRoutes()
        .filter((r) => r.props.number === category.number)
        .map((r) => r.params.state);
      expect([...new Set(got)].sort()).toEqual([...new Set(wanted)].sort());
      expect(got.length).toBeGreaterThan(0);
    }
  });
});

describe('Every page', () => {
  it('states the private hospital exclusion, the safety block once and the passport once', () => {
    for (const { path, html } of pages) {
      expect(main(html), path).toContain(path.startsWith('/state') ? st.exclusion : ut.exclusion);
      expect((html.match(/class="c-passport"/g) ?? []).length, path).toBe(1);
      expect(html.match(/id="[a-z]+-safety-heading"/g) ?? [], path).toHaveLength(1);
    }
  });

  it('ships no script and no event handler', () => {
    for (const { path, html } of pages) {
      expect([path, /<script|\son[a-z]+=|javascript:/i.test(withoutJsonLd(html))]).toEqual([
        path,
        false,
      ]);
    }
  });

  it('carries one h1, a canonical address from content and breadcrumbs that end at the page', () => {
    for (const { path, html } of pages) {
      expect(html.match(/<h1[ >]/g), path).toHaveLength(1);
      expect(html, path).toContain(`<link rel="canonical" href="${site.url}${path.slice(1)}">`);
      const crumbs = textsOf(html, 'c-breadcrumbs__item');
      expect(crumbs[0], path).toBe(st.crumb_home);
      expect(crumbs.length, path).toBeGreaterThanOrEqual(2);
    }
  });

  it('gives every figure a stamp and every table a stated period', () => {
    for (const { path, html } of pages) {
      expect(textsOf(html, 'c-stamp'), path).toHaveLength(textsOf(html, 'c-figure').length);
      expect(
        textsOf(html, 'c-table__stamp').length + textsOf(html, 'c-plain-table__stamp').length,
        path,
      ).toBe(html.match(/<table[ >]/g)?.length ?? 0);
    }
    expect(pages.some(({ html }) => html.includes('c-figure'))).toBe(true);
  });

  it('resolves every link to a page that is built', () => {
    const built = new Set<string>([...builtAddresses(), '/compare/']);
    for (const ref of hospitalSlugs()) {
      built.add(`/hospital/${ref}/`);
    }
    built.add('/');
    built.add('/hospitals/');
    built.add('/surgery/');
    [METHODOLOGY_PATH, DATA_PATH, ABOUT_PATH, GUIDES_PATH, GP_PATH].forEach((path) =>
      built.add(path),
    );
    for (const kind of ['procedure', 'specialty'] as const) {
      for (const { props } of hubRoutes(kind)) {
        built.add(surgeryPath(refOf(kind, props.slug)));
      }
      for (const { props } of surgeryStateRoutes(kind)) {
        built.add(surgeryStatePath(refOf(kind, props.slug), props.state));
      }
    }
    for (const { path, html } of pages) {
      for (const href of hrefs(html).filter((h) => h.startsWith('/'))) {
        expect([path, href, built.has(href) || href.startsWith('/#') || href === '/#main']).toEqual(
          [path, href, true],
        );
      }
      const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
      for (const href of hrefs(html).filter((h) => h.startsWith('#'))) {
        expect([path, href, href === '#top' || ids.has(href.slice(1))]).toEqual([path, href, true]);
      }
    }
  });
});

describe('State pages', () => {
  it('put the state figure beside the national figure, each stamped', () => {
    for (const file of stateFiles()) {
      const html = page(statePath(file.state));
      const name = names[file.state];
      expect(html).toContain(`<title>${fill(st.title, { state: name, site: site.name })}</title>`);
      expect(textsOf(html, 'c-tiles__label').some((l) => l.endsWith(`, ${name}`))).toBe(true);
      expect(textsOf(html, 'c-tiles__label').some((l) => l.endsWith(', Australia'))).toBe(true);
      expect(main(html)).toMatch(/\d+ days\s+\d{4}–\d{2}, released \d{1,2} \w+ \d{4}/);
    }
  });

  it('list the state hospitals in a table ranked nationally, with withheld and stale rows unranked', () => {
    let ranked = 0;
    let withheld = 0;
    for (const file of stateFiles()) {
      const html = page(statePath(file.state));
      for (const cell of elementsOf(html, 'td')) {
        expect([
          cell.text,
          cell.classes.has('is-not-published') && cell.inside.has('c-table__rank'),
        ]).toEqual([cell.text, false]);
        ranked += cell.inside.has('c-table__rank') ? 1 : 0;
        withheld += cell.classes.has('is-not-published') ? 1 : 0;
      }
      for (const row of elementsOf(html, 'tr')) {
        expect(row.classes.has('c-table__row--earlier') && row.inside.has('c-table__rank')).toBe(
          false,
        );
      }
      for (const rank of textsOf(html, 'c-table__rank')) {
        expect(rank).toMatch(/^Rank \d[\d,]*(?:st|nd|rd|th) of [\d,]+ nationally$/);
      }
      expect(html.includes('c-tiles__line')).toBe(false);
    }
    expect(ranked).toBeGreaterThan(0);
    expect(withheld).toBeGreaterThan(0);
  });

  it('leave a closed hospital out of the table and mark it in the list', () => {
    const closed = readHospitalIndex().filter((h) => h.closed);
    expect(closed.length).toBeGreaterThan(0);
    for (const h of closed) {
      const html = page(statePath(h.state));
      const inTable = (html.split('id="hospitals-caption"')[1] ?? '').split('</table>')[0] ?? '';
      expect(inTable).not.toContain(`/hospital/${h.slug}/`);
      expect(html).toContain(`/hospital/${h.slug}/`);
    }
    expect(textsOf(page('/state/qld/'), 'c-index-list__tag')).toEqual([st.closed_tag]);
  });

  it('link each surgery to its page for the state, and every hospital to its page', () => {
    const html = page('/state/nsw/');
    expect(hrefs(html)).toContain('/surgery/hip-replacement/nsw/');
    for (const h of readHospitalIndex().filter((x) => x.state === 'NSW')) {
      expect(hrefs(html)).toContain(`/hospital/${h.slug}/`);
    }
    expect(hrefs(html)).toContain('/urgency/category-1/nsw/');
  });

  it('keep the Queensland overlay on the Queensland page, apart from the national tables and never ranked', () => {
    for (const { path, html } of pages) {
      const here = path === '/state/qld/';
      expect([path, html.includes('id="qld-heading"')]).toEqual([path, here]);
      expect([path, html.includes('id="qld-caption"')]).toEqual([path, here]);
    }
    const html = page('/state/qld/');
    expect(main(html)).toContain(st.qld_intro);
    const overlay = html.split('id="qld-heading"')[1]?.split('</section>')[0] ?? '';
    expect(overlay).not.toContain('c-table__rank');
    expect(overlay).not.toMatch(/Rank \d|nationally/);
    expect(overlay).toMatch(/July to September 2025, released \d{1,2} \w+ \d{4}/);
    // The national tables sit before it, and none of them holds a Queensland Health figure.
    const national = html.split('id="qld-heading"')[0] ?? '';
    expect(national).not.toContain('id="qld-caption"');
  });

  it('lists every state on the index with its counts and links it', () => {
    const html = page('/state/');
    for (const file of stateFiles()) {
      expect(hrefs(html)).toContain(statePath(file.state));
      expect(main(html)).toContain(names[file.state]);
    }
    expect(main(html)).toMatch(
      /The figures are for \d{4}–\d{2}\. The data was released on \d{1,2} \w+ \d{4}\./,
    );
  });
});

describe('Urgency pages', () => {
  it('say the recommended time in the words of the content', () => {
    for (const category of categories()) {
      const html = page(category.path);
      expect(main(html)).toContain(
        fill(ut.lede, {
          number: String(category.number),
          short: category.short,
          within: category.within,
          meaning: category.meaning,
        }),
      );
    }
    expect(categories().map((c) => c.within)).toEqual(['30 days', '90 days', '365 days']);
  });

  it('order the hospitals by the share treated on time, highest first, and rank only measured shares', () => {
    for (const category of categories()) {
      const html = page(category.path);
      const rows = `<table><caption ${html.split('id="hospitals-caption"')[1]?.split('</table>')[0] ?? ''}</table>`;
      const measured = elementsOf(rows, 'tr')
        .map((row) => /(\d+)%/.exec(row.text)?.[1])
        .filter((v): v is string => v !== undefined)
        .map(Number);
      expect(measured.length).toBeGreaterThan(0);
      expect(measured).toEqual([...measured].sort((a, b) => b - a));
      for (const cell of elementsOf(rows, 'td')) {
        expect(cell.classes.has('is-not-published') && cell.inside.has('c-table__rank')).toBe(
          false,
        );
      }
      expect(textsOf(rows, 'c-table__rank').length).toBeGreaterThan(0);
    }
  });

  it('say what the source does not publish instead of inventing a national figure or trend', () => {
    const html = page('/urgency/category-1/');
    expect(main(html)).toContain(ut.national_none);
    expect(main(html)).toContain(ut.trends_none);
    expect(html.includes('c-chart')).toBe(false);
  });

  it('show the national and state figures and the trend when the dist carries them', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'dist-'));
    copies.push(copy);
    cpSync(distDirectory(), copy, { recursive: true });
    const file = join(copy, 'surgeries/urgency/urgent-elective-surgery.json');
    const surgery = JSON.parse(readFileSync(file, 'utf8')) as Surgery;
    const figure = (
      value: number,
    ): Surgery['hospitals'][number]['measures']['on_time'] extends infer M
      ? M extends { figure: infer F }
        ? F
        : never
      : never =>
      ({ state: 'published', value, period: surgery.period, release: surgery.release }) as never;
    surgery.benchmarks.national = { on_time: figure(0.9), median_wait: figure(12) };
    surgery.benchmarks.states = [{ state: 'NSW', measures: { on_time: figure(0.95) } }];
    const periods = ['2022–23', surgery.period];
    const points = (a: number, b: number): never =>
      [
        [2022, a, null],
        [2024, b, 0.01],
      ] as never;
    surgery.benchmarks.trends = [
      {
        scope: 'NAT',
        role: 'on_time',
        release: surgery.release,
        periods,
        points: points(0.88, 0.9),
      },
      {
        scope: 'NSW',
        role: 'on_time',
        release: surgery.release,
        periods,
        points: points(0.9, 0.95),
      },
    ];
    writeFileSync(file, JSON.stringify(surgery));
    vi.stubEnv(DIST_ENV, copy);
    const hub = await render(UrgencyCategory, { number: 1 });
    expect(textsOf(hub, 'c-tiles__label')).toContain(
      'Treated within the recommended time, Australia',
    );
    expect(hub).toContain('c-chart');
    expect(main(hub)).not.toContain(ut.national_none);
    expect(hub.includes('c-tiles__line')).toBe(false);
    const state = await render(UrgencyCategory, { number: 1, state: 'NSW' });
    expect(textsOf(state, 'c-tiles__label')).toContain(
      'Treated within the recommended time, New South Wales',
    );
    expect(state.includes('c-tiles__line')).toBe(false);
  });

  it('never rank a stale or withheld row, and list a stale one with its period', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'dist-'));
    copies.push(copy);
    cpSync(distDirectory(), copy, { recursive: true });
    const file = join(copy, 'surgeries/urgency/urgent-elective-surgery.json');
    const surgery = JSON.parse(readFileSync(file, 'utf8')) as Surgery;
    const target = surgery.hospitals.find((h) => h.code === 'H0047');
    expect(target).toBeDefined();
    for (const measure of Object.values(target?.measures ?? {})) {
      measure.figure.period = '2017–18';
    }
    writeFileSync(file, JSON.stringify(surgery));
    vi.stubEnv(DIST_ENV, copy);
    const html = await render(UrgencyCategory, { number: 1 });
    const row = elementsOf(html, 'tr').find((r) => r.text.startsWith('Wollongong Hospital'));
    expect(row?.classes.has('c-table__row--earlier')).toBe(true);
    expect(row?.inside.has('c-table__rank')).toBe(false);
    expect(row?.text).toContain('2017');
  });

  it('lists the categories on the index, and /surgery/ links each to its page', async () => {
    const index = page('/urgency/');
    const surgeries = await render(SurgeryIndex, {});
    for (const category of categories()) {
      expect(hrefs(index)).toContain(category.path);
      expect(hrefs(surgeries)).toContain(category.path);
      expect(textsOf(surgeries, 'a')).toContain(
        Object.values(getHospitalTemplate().urgency)[category.number - 1],
      );
    }
    expect(main(index)).toContain(ut.index_intro);
  });
});
