import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it } from 'vitest';

import {
  distSlug,
  entityPattern,
  pageStrings,
  readContent,
  replacedTerms,
} from '../lib/content-files';
import { hospitalTemplateSchema, surgeryTemplateSchema, termsSchema } from '../lib/content-schema';
import { readHospitalIndex } from '../lib/dist';
import {
  hubRoutes,
  nearRoutes,
  stateRoutes,
  surgeryRefs,
  surgeryPath,
  statePath,
  nearPath,
  refOf,
} from '../lib/surgery-page';
import { fill } from '../lib/slots';
import { elementsOf, text, textsOf } from '../lib/test-render';

const dist = new URL('../../dist/', import.meta.url);
if (!existsSync(dist)) {
  throw new Error('site/dist is missing: run `npm run build` before BUILT_PAGES=1 npm test');
}
const pages = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.html'))
  .sort()
  .map((path) => ({ path, html: readFileSync(new URL(path, dist), 'utf8') }));

// Needs `npm run build` first, so only the build job runs it, with BUILT_PAGES=1.
describe('Built pages', () => {
  it('print no ACN, ABN or company suffix', () => {
    expect(pages.length).toBeGreaterThan(0);
    expect(
      pages
        .filter(({ html }) => pageStrings(html).some((t) => entityPattern.test(t)))
        .map(({ path }) => path),
    ).toEqual([]);
  });

  // The passport quotes dataset titles as the publisher gives them, so only it is left out.
  const scan = (path: string, html: string): string[] =>
    replacedTerms(distSlug(path), pageStrings(html, true), terms);
  const terms = termsSchema.parse(readContent().find(({ path }) => path === 'terms.yaml')?.data);

  it('use no term the terms file replaces', () => {
    expect(pages.flatMap(({ path, html }) => scan(path, html))).toEqual([]);
  });

  it('catch hand-written "elective" on a hospital page, and excuse only the passport', () => {
    const page = pages.find(({ path }) => path.startsWith('hospital/'));
    expect(page).toBeDefined();
    const { path = '', html = '' } = page ?? {};
    expect(scan(path, html.replace('</main>', '<p>elective</p></main>'))).not.toEqual([]);
    expect(html).toContain('c-passport');
    expect(pageStrings(html).some((t) => /elective/i.test(t))).toBe(true);
    expect(pageStrings(html, true).some((t) => /elective/i.test(t))).toBe(false);
    const fake = html.replace('</main>', '<p class="c-passport">elective</p></main>');
    expect(scan(path, fake)).not.toEqual([]);
    const sections = html.replace(
      '</main>',
      '<section class="c-passport">elective</section></main>',
    );
    expect(scan(path, sections)).not.toEqual([]);
  });

  it('carry the data passport at most once', () => {
    for (const { path, html } of pages) {
      expect([path, (html.match(/class="c-passport"/g) ?? []).length <= 1]).toEqual([path, true]);
    }
  });

  it('keep every page under 300 KB of raw HTML', () => {
    for (const { path, html } of pages) {
      expect([path, Buffer.byteLength(html) <= 300_000]).toEqual([path, true]);
    }
  });

  it('hold no development preview route', () => {
    expect(pages.filter(({ path }) => path.startsWith('dev/')).map(({ path }) => path)).toEqual([]);
    expect(pages.filter(({ html }) => html.includes('noindex')).map(({ path }) => path)).toEqual(
      [],
    );
  });

  it('carry the operator line in the footer', () => {
    for (const { html } of pages) {
      expect(pageStrings(html).join('')).toContain(
        'Built and operated by National Digital, Burleigh Heads, Queensland',
      );
    }
  });

  it('hold a banner, a labelled site navigation, one main landmark and a footer', () => {
    for (const { path, html } of pages) {
      const tags = elements(html);
      const count = (name: string): number => tags.filter((t) => t.tagName === name).length;
      expect([path, count('header'), count('main'), count('footer')]).toEqual([path, 1, 1, 1]);
      const labels = tags
        .filter((t) => t.tagName === 'nav')
        .map((t) => t.attrs.find((a) => a.name === 'aria-label')?.value);
      expect(labels).toContain('Site');
      expect(labels.every((l) => l !== undefined && l !== '')).toBe(true);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('print no ACN, ABN or company suffix in the footer', () => {
    for (const { html } of pages) {
      const footer = elements(html).find((t) => t.tagName === 'footer');
      expect(footer && textOf(footer)).toMatch(/Built and operated by\s+National Digital/);
      expect(entityPattern.test(footer ? textOf(footer) : '')).toBe(false);
    }
  });

  it('link every footer entry to a page that is built', () => {
    const built = new Set(pages.map(({ path }) => path));
    for (const { path, html } of pages) {
      const footer = elements(html).find((t) => t.tagName === 'footer');
      const hrefs = footer ? anchors(footer) : [];
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs.filter((h) => h.startsWith('/'))) {
        expect([path, href, built.has(`${href.slice(1)}index.html`)]).toEqual([path, href, true]);
      }
    }
  });

  it('show the compare bar only when its page is built', () => {
    const target = pages.some(({ path }) => path === 'compare/index.html');
    for (const { html } of pages) {
      expect(html.includes('c-compare-bar')).toBe(target);
    }
  });

  it('ship zero JavaScript on every static page', () => {
    for (const { path, html } of pages) {
      const tags = elements(html);
      expect([path, tags.filter((t) => t.tagName === 'script').length]).toEqual([path, 0]);
      const handlers = tags.flatMap((t) => t.attrs).filter((a) => /^on/i.test(a.name));
      expect([path, handlers.length]).toEqual([path, 0]);
      expect(html).not.toMatch(/href="javascript:/i);
    }
  });
});

describe('Built hospital pages', () => {
  const index = readHospitalIndex();
  const template = hospitalTemplateSchema.parse(
    readContent().find(({ path }) => path === 'templates/hospital.yaml')?.data,
  );
  const hospitalPages = pages.filter(({ path }) => path.startsWith('hospital/'));

  it('hold one page at /hospital/<slug>/ for every hospital in the index', () => {
    expect(index.length).toBeGreaterThan(0);
    expect(hospitalPages.map(({ path }) => path).sort()).toEqual(
      index.map(({ slug }) => `hospital/${slug}/index.html`).sort(),
    );
  });

  it('carry a canonical address, a description and one h1', () => {
    for (const { path, html } of hospitalPages) {
      const slug = path.split('/')[1] ?? '';
      expect(html, path).toContain(
        `<link rel="canonical" href="https://surgerywaits.au/hospital/${slug}/">`,
      );
      expect(html, path).toContain('<meta name="description" content="');
      expect(html.match(/<h1[ >]/g), path).toHaveLength(1);
    }
  });

  it('state the private hospital exclusion in the page and say a closed hospital has closed', () => {
    for (const row of index) {
      const html =
        hospitalPages.find(({ path }) => path === `hospital/${row.slug}/index.html`)?.html ?? '';
      const main = text(html.split('<main')[1] ?? '');
      expect(main, row.slug).toContain(template.exclusion);
      expect(main.includes(fill(template.closed_notice, { hospital: row.name })), row.slug).toBe(
        row.closed,
      );
    }
    expect(index.some(({ closed }) => closed)).toBe(true);
  });

  it('give every figure a stamp and every table a stated period', () => {
    for (const { path, html } of hospitalPages) {
      expect(textsOf(html, 'c-stamp'), path).toHaveLength(textsOf(html, 'c-figure').length);
      expect(textsOf(html, 'c-table__stamp'), path).toHaveLength(
        html.match(/<table[ >]/g)?.length ?? 0,
      );
    }
  });

  it('rank no stale, withheld or closed figure', () => {
    let ranks = 0;
    for (const { path, html } of hospitalPages) {
      const closed = index.some(
        ({ slug, closed: c }) => c && path === `hospital/${slug}/index.html`,
      );
      const found = [
        ...elementsOf(html, 'c-tiles__tile').map((tile) => ({
          withheld: tile.classes.has('c-tiles__earlier') || tile.inside.has('is-not-published'),
          ranked: tile.inside.has('c-tiles__line'),
          text: tile.text,
        })),
        ...elementsOf(html, 'tr').map((row) => ({
          withheld: row.classes.has('c-table__row--earlier'),
          ranked: row.inside.has('c-table__rank'),
          text: row.text,
        })),
        ...elementsOf(html, 'td').map((cell) => ({
          withheld: cell.classes.has('is-not-published'),
          ranked: cell.inside.has('c-table__rank'),
          text: cell.text,
        })),
      ];
      for (const item of found) {
        expect([path, item.text, item.withheld && item.ranked]).toEqual([path, item.text, false]);
        expect([path, item.text, closed && item.ranked]).toEqual([path, item.text, false]);
        ranks += item.ranked ? 1 : 0;
      }
    }
    expect(ranks).toBeGreaterThan(0);
  });
});

describe('Built surgery pages', () => {
  const template = surgeryTemplateSchema.parse(
    readContent().find(({ path }) => path === 'templates/surgery.yaml')?.data,
  );
  const surgeryPages = pages.filter(
    ({ path }) => path.startsWith('surgery/') || path.startsWith('specialty/'),
  );
  const expected = [
    '/surgery/',
    '/specialty/',
    ...(['procedure', 'specialty'] as const).flatMap((kind) => [
      ...hubRoutes(kind).map(({ props }) => surgeryPath(refOf(kind, props.slug))),
      ...stateRoutes(kind).map(({ props }) => statePath(refOf(kind, props.slug), props.state)),
    ]),
    ...nearRoutes().map(({ props }) => nearPath(refOf('procedure', props.slug), props.area)),
  ];

  it('hold one page at every address the earlier site used, and the specialty addresses', () => {
    expect(surgeryRefs().length).toBeGreaterThan(0);
    expect(surgeryPages.map(({ path }) => `/${path.replace(/index\.html$/, '')}`).sort()).toEqual(
      expected.sort(),
    );
    for (const address of [
      '/surgery/',
      '/surgery/hip-replacement/',
      '/surgery/hip-replacement/nsw/',
    ]) {
      expect(expected).toContain(address);
    }
  });

  it('carry a canonical address, a description and one h1', () => {
    for (const { path, html } of surgeryPages) {
      expect(html, path).toContain(
        `<link rel="canonical" href="https://surgerywaits.au/${path.replace(/index\.html$/, '')}">`,
      );
      expect(html, path).toContain('<meta name="description" content="');
      expect(html.match(/<h1[ >]/g), path).toHaveLength(1);
    }
  });

  it('state the private hospital exclusion on every page', () => {
    for (const { path, html } of surgeryPages) {
      expect(text(html.split('<main')[1] ?? ''), path).toContain(template.exclusion);
    }
  });

  it('give every figure a stamp and every table a stated period', () => {
    for (const { path, html } of surgeryPages) {
      expect(textsOf(html, 'c-stamp'), path).toHaveLength(textsOf(html, 'c-figure').length);
      expect(textsOf(html, 'c-table__stamp'), path).toHaveLength(
        html.match(/<table[ >]/g)?.length ?? 0,
      );
    }
  });

  it('rank a figure only when it is current and published, and never a benchmark', () => {
    let ranks = 0;
    for (const { path, html } of surgeryPages) {
      for (const cell of elementsOf(html, 'td')) {
        expect([
          path,
          cell.text,
          cell.classes.has('is-not-published') && cell.inside.has('c-table__rank'),
        ]).toEqual([path, cell.text, false]);
        ranks += cell.inside.has('c-table__rank') ? 1 : 0;
      }
      for (const row of elementsOf(html, 'tr')) {
        expect([
          path,
          row.classes.has('c-table__row--earlier') && row.inside.has('c-table__rank'),
        ]).toEqual([path, false]);
      }
      expect([path, html.includes('c-tiles__line')]).toEqual([path, false]);
    }
    expect(ranks).toBeGreaterThan(0);
  });

  it('say the ranking basis once on every page that has a hospital table', () => {
    for (const { path, html } of surgeryPages.filter(({ html: h }) =>
      h.includes('id="hospitals-caption"'),
    )) {
      expect(text(html.split('<main')[1] ?? ''), path).toContain(template.ranking);
    }
  });
});

describe('Built index pages', () => {
  const index = readHospitalIndex();
  const page = (path: string): string => pages.find((p) => p.path === path)?.html ?? '';
  const mainLinks = (html: string): string[] => {
    const main = elements(html).find((t) => t.tagName === 'main');
    return main ? anchors(main) : [];
  };

  it('list every hospital once on /hospitals/ and link only to built hospital pages', () => {
    const links = mainLinks(page('hospitals/index.html')).filter((h) => h.startsWith('/hospital/'));
    expect(links.sort()).toEqual(index.map(({ slug }) => `/hospital/${slug}/`).sort());
    const built = new Set(pages.map(({ path }) => path));
    for (const href of links) {
      expect(built.has(`${href.slice(1)}index.html`), href).toBe(true);
    }
  });

  it('link /surgery/ to a built page at each surgery address, and to nothing else', () => {
    const built = new Set(pages.map(({ path }) => path));
    const expected = surgeryRefs().map((ref) => surgeryPath(ref));
    const links = mainLinks(page('surgery/index.html')).filter((h) =>
      /^\/(surgery|specialty)\/.+/.test(h),
    );
    expect(links.sort()).toEqual(expected.sort());
    for (const href of links) {
      expect(built.has(`${href.slice(1)}index.html`), href).toBe(true);
    }
  });

  it('add the Hospitals crumb to every hospital page', () => {
    const hospitalPages = pages.filter(({ path }) => path.startsWith('hospital/'));
    expect(hospitalPages.length).toBeGreaterThan(0);
    for (const { path, html } of hospitalPages) {
      const nav = elements(html).find(
        (t) => t.tagName === 'nav' && t.attrs.some((a) => a.value === 'Breadcrumb'),
      );
      expect([path, nav ? anchors(nav) : []]).toEqual([path, ['/', '/hospitals/']]);
    }
  });

  it('state the private hospital exclusion on both index pages', () => {
    for (const path of ['hospitals/index.html', 'surgery/index.html']) {
      expect([
        path,
        text(page(path).split('<main')[1] ?? '').includes('Private hospitals are excluded'),
      ]).toEqual([path, true]);
    }
  });
});

function elements(html: string): DefaultTreeAdapterTypes.Element[] {
  const out: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ('tagName' in node) {
      out.push(node);
    }
    if ('childNodes' in node) {
      node.childNodes.forEach(visit);
    }
  };
  visit(parse(html));
  return out;
}

function textOf(node: DefaultTreeAdapterTypes.Node): string {
  if ('value' in node) {
    return node.value;
  }
  return 'childNodes' in node ? node.childNodes.map(textOf).join(' ') : '';
}

function anchors(root: DefaultTreeAdapterTypes.Element): string[] {
  const out: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ('tagName' in node && node.tagName === 'a') {
      out.push(node.attrs.find((a) => a.name === 'href')?.value ?? '');
    }
    if ('childNodes' in node) {
      node.childNodes.forEach(visit);
    }
  };
  visit(root);
  return out;
}
