import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  distSlug,
  entityPattern,
  pageStrings,
  readContent,
  replacedTerms,
} from '../lib/content-files';
import {
  healthServiceTemplateSchema,
  hospitalTemplateSchema,
  longestTemplateSchema,
  pairTemplateSchema,
  stateTemplateSchema,
  surgeryTemplateSchema,
  termsSchema,
  urgencyTemplateSchema,
} from '../lib/content-schema';
import { getHomeTemplate, getHospitalTemplate } from '../lib/content';
import { readCredits } from '../lib/credits';
import { readHealthService, readHospitalIndex } from '../lib/dist';
import { healthServicePath, healthServiceSlugs } from '../lib/health-service-page';
import { formatCount, formatDate, formatPeriod } from '../lib/format';
import { COMMON_COUNT } from '../lib/home-page';
import { hospitalGroups, reportingCounts } from '../lib/index-pages';
import {
  BORDER_PATH,
  BY_SURGERY_PATH,
  CHANGES_PATH,
  LONGEST_PATH,
  borderPairs,
} from '../lib/longest-page';
import { indexablePairPaths, pairRoutes, thinPairPaths } from '../lib/pair-page';
import { stateFiles } from '../lib/state-page';
import { categories } from '../lib/urgency-page';
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
import { fetchProblems, historyUses, pageProblems, sendingUses, storageUses } from '../lib/privacy';
import { fill } from '../lib/slots';
import { elementsOf, plain, textsOf } from '../lib/test-render';
import type { Found } from '../lib/test-render';

const dist = new URL('../../dist/', import.meta.url);
if (!existsSync(dist)) {
  throw new Error('site/dist is missing: run `npm run build` before BUILT_PAGES=1 npm test');
}
const isPair = (path: string): boolean => /^hospital\/[^/]+\/[^/]+\/index\.html$/.test(path);
const paths = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.html'))
  .sort();
const read = (path: string): string => readFileSync(new URL(path, dist), 'utf8');
const address = (path: string): string => `/${path.replace(/index\.html$/, '')}`;

// The real dist holds thousands of pairs, so its per-page checks cover one pair in every STEP.
const onRealDist = pairRoutes().length > 1000;
const STEP = onRealDist ? 25 : 1;

const SKIPPED = '<meta name="robots" content="noindex,follow">';
const terms = termsSchema.parse(readContent().find(({ path }) => path === 'terms.yaml')?.data);
const OPERATOR = 'Built and operated by National Digital, Burleigh Heads, Queensland';

// Everything the checks need from one page, taken from a single parse so no test parses again.
interface Basic {
  path: string;
  bytes: number;
  skipped: boolean;
  anyNoindex: boolean;
}
interface Page extends Basic {
  hospitalTable: boolean;
  entity: boolean;
  replaced: string[];
  passports: number;
  operator: boolean;
  header: number;
  main: number;
  footer: number;
  navLabels: (string | undefined)[];
  scripts: number;
  scriptTags: { type?: string; src?: string }[];
  handlers: number;
  javascriptHref: boolean;
  footerText: string | undefined;
  footerHrefs: string[];
  breadcrumbHrefs: string[];
  mainHrefs: string[];
  compareBar: boolean;
  canonical: boolean;
  description: boolean;
  h1: number;
  mainText: string;
  stamps: number;
  figures: number;
  tableStamps: number;
  tables: number;
  tiles: Found[];
  rows: Found[];
  cells: Found[];
}

let pages: Basic[] = [];
let full: Page[] = [];
const pageAt = (path: string): Page => {
  const found = full.find((p) => p.path === path);
  if (found === undefined) {
    throw new Error(`no built page at ${path}`);
  }
  return found;
};
const analysed = (): Page[] => full;

function analyse(path: string, html: string, bytes: number, skipped: boolean): Page {
  const root = parse(html);
  const tags = elements(root);
  const count = (name: string): number => tags.filter((t) => t.tagName === name).length;
  const footer = tags.find((t) => t.tagName === 'footer');
  const main = tags.find((t) => t.tagName === 'main');
  const breadcrumb = tags.find(
    (t) => t.tagName === 'nav' && t.attrs.some((a) => a.value === 'Breadcrumb'),
  );
  const own = pageStrings(root, true);
  return {
    path,
    bytes,
    skipped,
    anyNoindex: html.includes('noindex'),
    hospitalTable: html.includes('id="hospitals-caption"'),
    entity: pageStrings(root).some((t) => entityPattern.test(t)),
    replaced: replacedTerms(distSlug(path), own, terms),
    passports: (html.match(/class="c-passport"/g) ?? []).length,
    operator: pageStrings(root).join('').includes(OPERATOR),
    header: count('header'),
    main: count('main'),
    footer: count('footer'),
    navLabels: tags
      .filter((t) => t.tagName === 'nav')
      .map((t) => t.attrs.find((a) => a.name === 'aria-label')?.value),
    scripts: count('script'),
    scriptTags: tags
      .filter((t) => t.tagName === 'script')
      .map(
        (t) =>
          Object.fromEntries(t.attrs.map((a) => [a.name, a.value])) as {
            type?: string;
            src?: string;
          },
      ),
    handlers: tags.flatMap((t) => t.attrs).filter((a) => /^on/i.test(a.name)).length,
    javascriptHref: /href="javascript:/i.test(html),
    footerText: footer && textOf(footer),
    footerHrefs: footer ? anchors(footer) : [],
    breadcrumbHrefs: breadcrumb ? anchors(breadcrumb) : [],
    mainHrefs: main && /^(?:(?:hospitals|surgery)\/)?index\.html$/.test(path) ? anchors(main) : [],
    compareBar: html.includes('c-compare-bar'),
    canonical: html.includes(
      `<link rel="canonical" href="https://surgerywaits.au${address(path)}">`,
    ),
    description: html.includes('<meta name="description" content="'),
    h1: html.match(/<h1[ >]/g)?.length ?? 0,
    mainText: main ? plain(main).replace(/\s+/g, ' ').trim() : '',
    stamps: textsOf(root, 'c-stamp').length,
    figures: textsOf(root, 'c-figure').length,
    tableStamps: textsOf(root, 'c-table__stamp').length,
    tables: html.match(/<table[ >]/g)?.length ?? 0,
    tiles: elementsOf(root, 'c-tiles__tile'),
    rows: elementsOf(root, 'tr'),
    cells: elementsOf(root, 'td'),
  };
}

// One pass over the dist: every page is read once, and a pair outside the sample is only counted.
beforeAll(() => {
  const seen = { thin: 0, indexable: 0 };
  pages = [];
  full = [];
  for (const path of paths) {
    const html = read(path);
    const skipped = html.includes(SKIPPED);
    const bytes = Buffer.byteLength(html);
    pages.push({ path, bytes, skipped, anyNoindex: html.includes('noindex') });
    let sampled = true;
    if (isPair(path)) {
      const group = skipped ? 'thin' : 'indexable';
      sampled = seen[group] % STEP === 0;
      seen[group] += 1;
    }
    if (sampled) {
      full.push(analyse(path, html, bytes, skipped));
    }
  }
}, 900_000);

const TOOL_PAGE = 'compare/index.html';

// Needs `npm run build` first, so only the build job runs it, with BUILT_PAGES=1.
describe('Built pages', () => {
  it('print no ACN, ABN or company suffix', () => {
    expect(paths.length).toBeGreaterThan(0);
    expect(
      analysed()
        .filter((p) => p.entity)
        .map((p) => p.path),
    ).toEqual([]);
  });

  it('use no term the terms file replaces', () => {
    expect(analysed().flatMap((p) => p.replaced)).toEqual([]);
  });

  it('catch hand-written "elective" on a hospital page, and excuse only the passport', () => {
    const path = paths.find((p) => /^hospital\/[^/]+\/index\.html$/.test(p));
    expect(path).toBeDefined();
    const html = read(path ?? '');
    const scan = (page: string): string[] =>
      replacedTerms(distSlug(path ?? ''), pageStrings(parse(page), true), terms);
    expect(scan(html.replace('</main>', '<p>elective</p></main>'))).not.toEqual([]);
    expect(html).toContain('c-passport');
    expect(pageStrings(html).some((t) => /elective/i.test(t))).toBe(true);
    expect(pageStrings(html, true).some((t) => /elective/i.test(t))).toBe(false);
    const fake = html.replace('</main>', '<p class="c-passport">elective</p></main>');
    expect(scan(fake)).not.toEqual([]);
    const sections = html.replace(
      '</main>',
      '<section class="c-passport">elective</section></main>',
    );
    expect(scan(sections)).not.toEqual([]);
  });

  it('carry the data passport at most once', () => {
    expect(
      analysed()
        .filter((p) => p.passports > 1)
        .map((p) => p.path),
    ).toEqual([]);
  });

  it('keep every page under 300 KB of raw HTML', () => {
    expect(pages.filter((p) => p.bytes > 300_000).map((p) => p.path)).toEqual([]);
  });

  it('hold no development preview route', () => {
    expect(paths.filter((path) => path.startsWith('dev/'))).toEqual([]);
    expect(pages.filter((p) => p.anyNoindex && !isPair(p.path)).map((p) => p.path)).toEqual([]);
  });

  it('carry the operator line in the footer', () => {
    expect(
      analysed()
        .filter((p) => !p.operator)
        .map((p) => p.path),
    ).toEqual([]);
  });

  it('hold a banner, a labelled site navigation, one main landmark and a footer', () => {
    for (const p of analysed()) {
      expect([p.path, p.header, p.main, p.footer]).toEqual([p.path, 1, 1, 1]);
      expect(p.navLabels).toContain('Site');
      expect(p.navLabels.every((l) => l !== undefined && l !== '')).toBe(true);
      expect(new Set(p.navLabels).size).toBe(p.navLabels.length);
    }
  });

  it('print no ACN, ABN or company suffix in the footer', () => {
    for (const p of analysed()) {
      expect(p.footerText).toMatch(/Built and operated by\s+National Digital/);
      expect(entityPattern.test(p.footerText ?? '')).toBe(false);
    }
  });

  it('link every footer entry to a page that is built', () => {
    const built = new Set(paths);
    for (const p of analysed()) {
      expect(p.footerHrefs.length).toBeGreaterThan(0);
      for (const href of p.footerHrefs.filter((h) => h.startsWith('/'))) {
        expect([p.path, href, built.has(`${href.slice(1)}index.html`)]).toEqual([
          p.path,
          href,
          true,
        ]);
      }
    }
  });

  it('show the compare bar only when its page is built, and never on that page', () => {
    const target = paths.includes('compare/index.html');
    for (const p of analysed()) {
      expect([p.path, p.compareBar]).toEqual([p.path, target && p.path !== TOOL_PAGE]);
    }
  });

  it('ship zero JavaScript on every static page', () => {
    for (const p of analysed().filter(({ path }) => path !== TOOL_PAGE)) {
      expect([p.path, p.scripts, p.handlers, p.javascriptHref]).toEqual([p.path, 0, 0, false]);
    }
  });

  it('load the compare tool as one module script from the site, with no inline script or handler', () => {
    const page = analysed().find(({ path }) => path === TOOL_PAGE);
    expect(page, 'the compare page is built').toBeDefined();
    expect(page?.scriptTags).toHaveLength(1);
    expect(page?.scriptTags[0]?.type).toBe('module');
    expect(page?.scriptTags[0]?.src).toMatch(/^\/_astro\/[\w.-]+\.js$/);
    expect([page?.handlers, page?.javascriptHref]).toEqual([0, false]);
  });
});

describe('Built pages and privacy', () => {
  const bundles = (): string[] =>
    readdirSync(new URL('_astro/', dist), { encoding: 'utf8' }).filter((f) => f.endsWith('.js'));

  it('hold no cookie, storage or history code in any page or script', () => {
    expect(bundles().length, 'the tool script is built').toBeGreaterThan(0);
    const files = [...paths.map(read), ...bundles().map((f) => read(`_astro/${f}`))];
    expect(files.flatMap((text) => [...storageUses(text), ...historyUses(text)])).toEqual([]);
    expect(storageUses('x.localStorage.getItem("a")')).toEqual(['localstorage']);
  });

  it('carry no beacon and no script from another host, and the tool script reaches no other host', () => {
    expect(paths.flatMap((p) => pageProblems(read(p)).map((x) => `${p}: ${x}`))).toEqual([]);
    for (const file of bundles()) {
      const text = read(`_astro/${file}`);
      expect(
        text.match(/https?:\/\/[^\s)]+/gu)?.filter((u) => !u.startsWith('http://www.w3.org/')) ??
          [],
      ).toEqual([]);
      expect(sendingUses(text)).toEqual([]);
      expect(fetchProblems(text)).toEqual([]);
    }
    const all = bundles().map((f) => read(`_astro/${f}`));
    expect(all.some((text) => /fetch\(.\/tool\//u.test(text))).toBe(true);
  });
});

describe('Built hospital pages', () => {
  const index = readHospitalIndex();
  const template = hospitalTemplateSchema.parse(
    readContent().find(({ path }) => path === 'templates/hospital.yaml')?.data,
  );
  const hospitalPages = (): Page[] =>
    full.filter(({ path }) => /^hospital\/[^/]+\/index\.html$/.test(path));

  it('hold one page at /hospital/<slug>/ for every hospital in the index', () => {
    expect(index.length).toBeGreaterThan(0);
    expect(
      hospitalPages()
        .map(({ path }) => path)
        .sort(),
    ).toEqual(index.map(({ slug }) => `hospital/${slug}/index.html`).sort());
  });

  it('carry a canonical address, a description and one h1', () => {
    for (const p of hospitalPages()) {
      expect([p.path, p.canonical, p.description, p.h1]).toEqual([p.path, true, true, 1]);
    }
  });

  it('state the private hospital exclusion in the page and say a closed hospital has closed', () => {
    for (const row of index) {
      const page = pageAt(`hospital/${row.slug}/index.html`);
      expect(page.mainText, row.slug).toContain(template.exclusion);
      expect(
        page.mainText.includes(fill(template.closed_notice, { hospital: row.name })),
        row.slug,
      ).toBe(row.closed);
    }
    expect(index.some(({ closed }) => closed)).toBe(true);
  });

  it('give every figure a stamp and every table a stated period', () => {
    for (const p of hospitalPages()) {
      expect([p.path, p.stamps, p.tableStamps]).toEqual([p.path, p.figures, p.tables]);
    }
  });

  it('rank no stale, withheld or closed figure', () => {
    let ranks = 0;
    for (const page of hospitalPages()) {
      const closed = index.some(
        ({ slug, closed: c }) => c && page.path === `hospital/${slug}/index.html`,
      );
      const found = [
        ...page.tiles.map((tile) => ({
          withheld: tile.classes.has('c-tiles__earlier') || tile.inside.has('is-not-published'),
          ranked: tile.inside.has('c-tiles__line'),
          text: tile.text,
        })),
        ...page.rows.map((row) => ({
          withheld: row.classes.has('c-table__row--earlier'),
          ranked: row.inside.has('c-table__rank'),
          text: row.text,
        })),
        ...page.cells.map((cell) => ({
          withheld: cell.classes.has('is-not-published'),
          ranked: cell.inside.has('c-table__rank'),
          text: cell.text,
        })),
      ];
      for (const item of found) {
        expect([page.path, item.text, item.withheld && item.ranked]).toEqual([
          page.path,
          item.text,
          false,
        ]);
        expect([page.path, item.text, closed && item.ranked]).toEqual([
          page.path,
          item.text,
          false,
        ]);
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
  const surgeryPages = (): Page[] =>
    full.filter(({ path }) => path.startsWith('surgery/') || path.startsWith('specialty/'));
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
    expect(
      surgeryPages()
        .map(({ path }) => address(path))
        .sort(),
    ).toEqual(expected.sort());
    for (const a of ['/surgery/', '/surgery/hip-replacement/', '/surgery/hip-replacement/nsw/']) {
      expect(expected).toContain(a);
    }
  });

  it('carry a canonical address, a description and one h1', () => {
    for (const p of surgeryPages()) {
      expect([p.path, p.canonical, p.description, p.h1]).toEqual([p.path, true, true, 1]);
    }
  });

  it('state the private hospital exclusion on every page', () => {
    for (const p of surgeryPages()) {
      expect(p.mainText, p.path).toContain(template.exclusion);
    }
  });

  it('give every figure a stamp and every table a stated period', () => {
    for (const p of surgeryPages()) {
      expect([p.path, p.stamps, p.tableStamps]).toEqual([p.path, p.figures, p.tables]);
    }
  });

  it('rank a figure only when it is current and published, and never a benchmark', () => {
    let ranks = 0;
    for (const p of surgeryPages()) {
      for (const cell of p.cells) {
        expect([
          p.path,
          cell.text,
          cell.classes.has('is-not-published') && cell.inside.has('c-table__rank'),
        ]).toEqual([p.path, cell.text, false]);
        ranks += cell.inside.has('c-table__rank') ? 1 : 0;
      }
      for (const row of p.rows) {
        expect([
          p.path,
          row.classes.has('c-table__row--earlier') && row.inside.has('c-table__rank'),
        ]).toEqual([p.path, false]);
      }
      expect([p.path, p.tiles.some((t) => t.inside.has('c-tiles__line'))]).toEqual([p.path, false]);
    }
    expect(ranks).toBeGreaterThan(0);
  });

  it('say the ranking basis once on every page that has a hospital table', () => {
    for (const p of surgeryPages().filter((q) => q.hospitalTable)) {
      expect(p.mainText, p.path).toContain(template.ranking);
    }
  });
});

describe('Built pair pages', () => {
  const template = pairTemplateSchema.parse(
    readContent().find(({ path }) => path === 'templates/pair.yaml')?.data,
  );
  const pairPages = (): Basic[] => pages.filter(({ path }) => isPair(path));

  it('hold one page at every pair address, and no other under a hospital', () => {
    expect(
      pairPages()
        .map(({ path }) => address(path))
        .sort(),
    ).toEqual(
      pairRoutes()
        .map(({ params }) => `/hospital/${params.slug}/${params.surgery}/`)
        .sort(),
    );
  });

  // Counted from the dist's own rows, with no use of the build's rule, so a drift in either shows.
  it('mark as noindex exactly the pairs the rule makes thin, and list the rest as indexable', () => {
    const thin = pairPages()
      .filter((p) => p.skipped)
      .map((p) => address(p.path));
    expect(thin.sort()).toEqual(thinPairPaths().sort());
    expect(thin).toHaveLength(expectedThinCount());
    const indexable = pairPages()
      .filter((p) => !p.skipped)
      .map((p) => address(p.path));
    expect(indexable.sort()).toEqual(indexablePairPaths().sort());
    expect(indexable.length + thin.length).toBe(pairPages().length);
    if (onRealDist) {
      // The counts for the pinned source versions, so a change to the rule or the data shows here.
      expect(thin).toHaveLength(6662);
      expect(indexable).toHaveLength(6264);
    }
  });

  it('carry a canonical address, a description, one h1 and the exclusion', () => {
    for (const p of analysed().filter((q) => isPair(q.path))) {
      expect([p.path, p.canonical, p.description, p.h1]).toEqual([p.path, true, true, 1]);
      expect(p.mainText, p.path).toContain(template.exclusion);
    }
  });

  it('sample the pairs of both kinds on the real dist', () => {
    const sampled = analysed().filter((p) => isPair(p.path));
    expect(sampled.some((p) => p.skipped)).toBe(true);
    expect(sampled.some((p) => !p.skipped)).toBe(true);
  });

  it('give every figure a stamp and rank no withheld figure', () => {
    for (const p of analysed().filter((q) => isPair(q.path))) {
      expect([p.path, p.stamps]).toEqual([p.path, p.figures]);
      for (const tile of p.tiles) {
        expect([
          p.path,
          tile.inside.has('is-not-published') && tile.inside.has('c-tiles__line'),
        ]).toEqual([p.path, false]);
      }
    }
  });
});

describe('Built index pages', () => {
  const index = readHospitalIndex();
  const mainLinks = (path: string): string[] => pageAt(path).mainHrefs;

  it('list every hospital once on /hospitals/ and link only to built hospital pages', () => {
    const links = mainLinks('hospitals/index.html').filter((h) => h.startsWith('/hospital/'));
    expect(links.sort()).toEqual(index.map(({ slug }) => `/hospital/${slug}/`).sort());
    const built = new Set(paths);
    for (const href of links) {
      expect(built.has(`${href.slice(1)}index.html`), href).toBe(true);
    }
  });

  it('link /surgery/ to a built page at each surgery address, and to nothing else', () => {
    const built = new Set(paths);
    const expected = surgeryRefs().map((ref) => surgeryPath(ref));
    const links = mainLinks('surgery/index.html').filter((h) =>
      /^\/(surgery|specialty)\/.+/.test(h),
    );
    expect(links.sort()).toEqual(expected.sort());
    for (const href of links) {
      expect(built.has(`${href.slice(1)}index.html`), href).toBe(true);
    }
  });

  it('add the Hospitals crumb to every hospital page', () => {
    const hospitalPages = full.filter(({ path }) => /^hospital\/[^/]+\/index\.html$/.test(path));
    expect(hospitalPages.length).toBeGreaterThan(0);
    for (const p of hospitalPages) {
      expect([p.path, p.breadcrumbHrefs]).toEqual([p.path, ['/', '/hospitals/']]);
    }
  });

  it('state the private hospital exclusion on both index pages', () => {
    for (const path of ['hospitals/index.html', 'surgery/index.html']) {
      expect([path, pageAt(path).mainText.includes('Private hospitals are excluded')]).toEqual([
        path,
        true,
      ]);
    }
  });
});

describe('Built state and urgency pages', () => {
  const state = stateTemplateSchema.parse(
    readContent().find(({ path }) => path === 'templates/state.yaml')?.data,
  );
  const urgency = urgencyTemplateSchema.parse(
    readContent().find(({ path }) => path === 'templates/urgency.yaml')?.data,
  );
  // Read after beforeAll has listed the built pages.
  const mine = (): { path: string; html: string }[] =>
    pages
      .filter(({ path }) => path.startsWith('state/') || path.startsWith('urgency/'))
      .map(({ path }) => ({ path, html: read(path) }));
  const address = (path: string): string => `/${path.replace(/index\.html$/, '')}`;
  const codes = ['act', 'nsw', 'nt', 'qld', 'sa', 'tas', 'vic', 'wa'];
  // The addresses the earlier site published, from its sitemap.
  const earlier = [
    '/state/',
    ...codes.map((c) => `/state/${c}/`),
    '/urgency/',
    ...[1, 2, 3].flatMap((n) => [
      `/urgency/category-${String(n)}/`,
      ...codes.map((c) => `/urgency/category-${String(n)}/${c}/`),
    ]),
  ];

  it('hold only addresses the earlier site used, and every one it used for a state with figures', () => {
    const built = mine()
      .map(({ path }) => address(path))
      .sort();
    expect(built.length).toBeGreaterThan(0);
    for (const path of built) {
      expect([path, earlier.includes(path)]).toEqual([path, true]);
    }
    const present = new Set(stateFiles().map((f) => f.state.toLowerCase()));
    expect(
      earlier.filter((path) => {
        const code = /\/([a-z]+)\/$/.exec(path)?.[1] ?? '';
        return !codes.includes(code) || present.has(code);
      }),
    ).toEqual(
      built
        .filter((path) => earlier.includes(path))
        .sort((a, b) => earlier.indexOf(a) - earlier.indexOf(b)),
    );
    expect(categories().map((c) => c.path)).toEqual(
      [1, 2, 3].map((n) => `/urgency/category-${String(n)}/`),
    );
  });

  it('state the private hospital exclusion, the safety block and the data passport on every page', () => {
    for (const { path, html } of mine()) {
      const body = plain(parseFragment(html.split('<main')[1] ?? ''))
        .replace(/\s+/g, ' ')
        .trim();
      expect(body, path).toContain(path.startsWith('state/') ? state.exclusion : urgency.exclusion);
      expect(html.match(/id="[a-z]+-safety-heading"/g) ?? [], path).toHaveLength(1);
      expect((html.match(/class="c-passport"/g) ?? []).length, path).toBe(1);
    }
  });

  it('give every figure a stamp and every table a stated period', () => {
    for (const { path, html } of mine()) {
      expect(textsOf(html, 'c-stamp'), path).toHaveLength(textsOf(html, 'c-figure').length);
      expect(
        textsOf(html, 'c-table__stamp').length + textsOf(html, 'c-plain-table__stamp').length,
        path,
      ).toBe(html.match(/<table[ >]/g)?.length ?? 0);
    }
  });

  it('rank no stale or withheld figure, and no benchmark', () => {
    let ranks = 0;
    for (const { path, html } of mine()) {
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

  it('keep the Queensland overlay on the Queensland page and rank nothing in it', () => {
    for (const { path, html } of mine()) {
      expect([path, html.includes('id="qld-caption"')]).toEqual([
        path,
        path === 'state/qld/index.html',
      ]);
    }
    const html = mine().find(({ path }) => path === 'state/qld/index.html')?.html ?? '';
    const overlay = html.split('id="qld-heading"')[1]?.split('</section>')[0] ?? '';
    expect(overlay).toContain('id="qld-caption"');
    expect(overlay).not.toMatch(/c-table__rank|nationally/);
  });

  it('link only to pages that are built', () => {
    const built = new Set(pages.map(({ path }) => `/${path.replace(/index\.html$/, '')}`));
    for (const { path, html } of mine()) {
      const main = elements(parse(html)).find((t) => t.tagName === 'main');
      for (const href of (main ? anchors(main) : []).filter((h) => h.startsWith('/'))) {
        expect([path, href, built.has(href)]).toEqual([path, href, true]);
      }
    }
  });
});

describe('Built longest-waits pages', () => {
  const longest = longestTemplateSchema.parse(
    readContent().find(({ path }) => path === 'templates/longest.yaml')?.data,
  );
  const mine = (): { path: string; html: string }[] =>
    pages
      .filter(({ path }) => path.startsWith('longest-waits/'))
      .map(({ path }) => ({ path, html: read(path) }));
  // The addresses the earlier site published, from its sitemap.
  const earlier = [
    '/longest-waits/',
    '/longest-waits/by-surgery/',
    '/longest-waits/border/',
    '/longest-waits/changes/',
  ];

  it('build exactly the addresses the earlier site used', () => {
    expect(
      mine()
        .map(({ path }) => address(path))
        .sort(),
    ).toEqual([...earlier].sort());
    expect([LONGEST_PATH, BY_SURGERY_PATH, BORDER_PATH, CHANGES_PATH].sort()).toEqual(
      [...earlier].sort(),
    );
  });

  it('state the exclusion, the safety block and the data passport on every page', () => {
    for (const { path, html } of mine()) {
      const body = plain(parseFragment(html.split('<main')[1] ?? ''))
        .replace(/\s+/g, ' ')
        .trim();
      expect(body, path).toContain(longest.exclusion);
      expect(html.match(/id="[a-z]+-safety-heading"/g) ?? [], path).toHaveLength(1);
      expect((html.match(/class="c-passport"/g) ?? []).length, path).toBe(1);
    }
  });

  it('give every table a stated period and rank only inside the list', () => {
    for (const { path, html } of mine()) {
      expect(textsOf(html, 'c-table__stamp').length, path).toBe(
        html.match(/<table[ >]/g)?.length ?? 0,
      );
      expect([path, html.includes('c-table__rank')]).toEqual([path, false]);
      expect([path, /<script|\son[a-z]+=/i.test(html)]).toEqual([path, false]);
    }
    // A page with no rows says so; the sample data has no cross-border pair.
    const nones = [
      longest.index_none,
      longest.by_surgery_none,
      longest.border_none,
      longest.changes_none,
    ].map((t) => t.split('{')[0] ?? t);
    for (const { path, html } of mine().filter(({ html }) => !html.includes('<table'))) {
      expect([path, nones.some((t) => html.includes(t))]).toEqual([path, true]);
    }
    expect(mine().some(({ html }) => html.includes('<table'))).toBe(true);
  });

  // The fixture has no cross-border pair, so this bites only on the real dist.
  it('rank at least one border row when the dist has a border pair', () => {
    const html = read('longest-waits/border/index.html');
    const rows = (html.split('<tbody>')[1]?.split('</tbody>')[0] ?? '').match(/<tr[ >]/g) ?? [];
    expect(rows.length > 0).toBe(borderPairs().length > 0);
    expect(html.includes('<table')).toBe(borderPairs().length > 0);
  });

  it('link only to pages that are built', () => {
    const built = new Set(pages.map(({ path }) => address(path)));
    for (const { path, html } of mine()) {
      const main = elements(parse(html)).find((t) => t.tagName === 'main');
      for (const href of (main ? anchors(main) : []).filter((h) => h.startsWith('/'))) {
        expect([path, href, built.has(href)]).toEqual([path, href, true]);
      }
    }
  });
});

function elements(root: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.Element[] {
  const out: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ('tagName' in node) {
      out.push(node);
    }
    if ('childNodes' in node) {
      node.childNodes.forEach(visit);
    }
  };
  visit(root);
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

interface RawRow {
  code: string;
  slug: string;
  closed: boolean;
  measures: Record<string, { figure: { state: string; period: string; release: string } }>;
}
interface RawSurgery {
  slug: string;
  period: string;
  release: string;
  hospitals: RawRow[];
  benchmarks: { national: { long_wait?: { state: string } } | null };
}
interface RawTrend {
  series: { kind: string; slug: string; role: string; periods: string[]; points: unknown[][] }[];
}
interface Place {
  lat: number;
  lon: number;
  state: string;
}

// The thin count worked out again from the raw files: pairs with no published median, or a
// median with no earlier year, no published neighbour in the hospital's own mesh, no long-wait
// share and no area.
function expectedThinCount(): number {
  const root = process.env['SURGERYWAITS_DIST'] ?? '';
  const readJson = (path: string): unknown => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const located = new Map<string, Place>();
  for (const h of (
    readJson('hospitals.json') as {
      hospitals: {
        slug: string;
        state: string;
        latitude: number | null;
        longitude: number | null;
      }[];
    }
  ).hospitals) {
    if (h.latitude !== null && h.longitude !== null) {
      located.set(h.slug, { lat: h.latitude, lon: h.longitude, state: h.state });
    }
  }
  const meshes = new Map<string, string[] | null>();
  const meshOf = (slug: string): string[] | null => {
    if (!meshes.has(slug)) {
      const { nearby } = readJson(`hospitals/${slug}.json`) as {
        nearby: { hospitals: { code: string }[] } | null;
      };
      meshes.set(slug, nearby === null ? null : nearby.hospitals.map((n) => n.code));
    }
    return meshes.get(slug) ?? null;
  };
  const states = new Set(
    (readJson('suburbs.json') as { suburbs: string[][] }).suburbs.map((s) => s[2] ?? ''),
  );
  const trends = new Set(readdirSync(join(root, 'trends')).map((f) => f.replace(/\.json$/, '')));
  let thin = 0;
  for (const file of readdirSync(join(root, 'surgeries/procedure'))) {
    const surgery = readJson(`surgeries/procedure/${file}`) as RawSurgery;
    const current = surgery.hospitals.filter((row) =>
      Object.values(row.measures).every(
        (m) => m.figure.period === surgery.period && m.figure.release === surgery.release,
      ),
    );
    const median = (row: RawRow): boolean =>
      row.measures['median_wait']?.figure.state === 'published';
    for (const row of current) {
      if (!median(row)) {
        thin += 1;
        continue;
      }
      const series = trends.has(row.slug)
        ? (readJson(`trends/${row.slug}.json`) as RawTrend).series.find(
            (s) => s.kind === 'procedure' && s.slug === surgery.slug && s.role === 'median_wait',
          )
        : undefined;
      const history =
        series?.points.some((p, i) => p[1] !== null && series.periods[i] !== surgery.period) ??
        false;
      const at = located.get(row.slug);
      const mesh = row.closed ? null : meshOf(row.slug);
      const neighbour =
        mesh !== null &&
        current.some((o) => o.code !== row.code && !o.closed && median(o) && mesh.includes(o.code));
      const longWait =
        row.measures['long_wait']?.figure.state === 'published' &&
        surgery.benchmarks.national?.long_wait?.state === 'published';
      const area = at !== undefined && states.has(at.state);
      if (!history && !neighbour && !longWait && !area) {
        thin += 1;
      }
    }
  }
  return thin;
}

describe('Built home page', () => {
  it('links only to built pages and carries the exclusion and one passport', () => {
    const built = new Set(paths);
    const home = pageAt('index.html');
    const links = home.mainHrefs.filter((h) => h.startsWith('/'));
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) {
      expect(built.has(`${href.slice(1)}index.html`), href).toBe(true);
    }
    expect(home.mainText).toContain('Private hospitals are excluded');
    expect(home.passports).toBe(1);
  });

  it('holds the surgery table and the state table, with the counts of the data', () => {
    const home = pageAt('index.html');
    const states = stateFiles().length;
    expect(home.tables).toBe(2);
    expect(home.rows).toHaveLength(2 + COMMON_COUNT + states);
    expect(home.cells).toHaveLength(COMMON_COUNT * 3 + states * 4);
    const hospitals = home.cells
      .slice(0, COMMON_COUNT * 3)
      .filter((_, i) => i % 3 === 2)
      .map((cell) => Number(cell.text.replaceAll(',', '')));
    expect(hospitals).toEqual([...hospitals].sort((a, b) => b - a));
    const t = getHomeTemplate();
    const counts = [
      fill(t.surgery_note_many, { count: formatCount(surgeryRefs().length) }),
      fill(t.hospitals_note_many, { count: formatCount(readHospitalIndex().length) }),
      fill(t.states_note_many, { count: formatCount(states) }),
      fill(t.urgency_note_many, { count: formatCount(categories().length) }),
    ];
    for (const count of counts) {
      expect(home.mainText).toContain(count);
    }
    const reporting = home.cells
      .slice(COMMON_COUNT * 3)
      .filter((_, i) => i % 4 === 0)
      .map((cell) => Number(cell.text.replaceAll(',', '')));
    const groups = hospitalGroups(Object.keys(getHospitalTemplate().states));
    expect(reporting.reduce((a, b) => a + b, 0)).toBe(reportingCounts(groups).reporting);
  });
});

describe('Built health service pages', () => {
  const service = healthServiceTemplateSchema.parse(
    readContent().find(({ path }) => path === 'templates/health-service.yaml')?.data,
  );
  const mine = (): { path: string; html: string }[] =>
    pages
      .filter(({ path }) => path.startsWith('health-service/'))
      .map(({ path }) => ({ path, html: read(path) }));
  // The addresses the earlier site published, from its sitemap.
  const earlier = [
    'albury-wodonga-health',
    'alfred-health',
    'austin-health',
    'australian-capital-territory',
    'barossa-hills-fleurieu',
    'barwon-health',
    'bass-coast-regional-health',
    'bendigo-health-care-group',
    'cairns-and-hinterland',
    'central-adelaide',
    'central-coast',
    'central-queensland',
    'central-west',
    'child-adolescent-health-service',
    'childrens-health-queensland',
    'darling-downs',
    'east-metropolitan-health-service',
    'eastern-health',
    'eyre-and-far-north',
    'far-west',
    'flinders-and-upper-north',
    'gold-coast',
    'goulburn-valley-health',
    'grampians-health',
    'hunter-new-england',
    'illawarra-shoalhaven',
    'latrobe-regional-hospital',
    'limestone-coast',
    'mackay',
    'melbourne-health',
    'mercy-public-hospital-inc',
    'metro-north',
    'metro-south',
    'mid-north-coast',
    'monash-health',
    'murrumbidgee',
    'nepean-blue-mountains',
    'north-metropolitan-health-service',
    'north-west',
    'northeast-health-wangaratta',
    'northern-adelaide',
    'northern-health',
    'northern-nsw',
    'northern-sydney',
    'nt-regional-health-services',
    'peninsula-health',
    'peter-maccallum-cancer-institute',
    'riverland-mallee-coorong',
    'royal-childrens-hospital',
    'royal-victorian-eye-and-ear-hospital',
    'royal-womens-hospital',
    'south-eastern-sydney',
    'south-metropolitan-health-service',
    'south-west-healthcare',
    'south-west',
    'south-western-sydney',
    'southern-adelaide',
    'southern-nsw',
    'st-vincents-health-network',
    'st-vincents-hospital-melbourne-limited',
    'sunshine-coast',
    'sydney-childrens-hospitals-network',
    'sydney',
    'tasmanian-health-service',
    'torres-and-cape',
    'townsville',
    'wa-country-health-service',
    'west-gippsland-healthcare-group',
    'west-moreton',
    'western-health',
    'western-nsw',
    'western-sydney',
    'wide-bay',
    'womens-and-childrens-health-network',
    'yorke-and-northern',
  ];

  it('build the index and a page for each network file, and on the real data exactly the earlier addresses', () => {
    const built = mine().map(({ path }) => address(path));
    expect(built).toContain('/health-service/');
    expect(built.filter((path) => path !== '/health-service/').sort()).toEqual(
      healthServiceSlugs().map(healthServicePath).sort(),
    );
    if (onRealDist) {
      expect(built.sort()).toEqual(
        ['/health-service/', ...earlier.map((slug) => `/health-service/${slug}/`)].sort(),
      );
    }
  });

  it('state the exclusion, the safety block and the data passport on every page', () => {
    for (const { path, html } of mine()) {
      const body = plain(parseFragment(html.split('<main')[1] ?? ''))
        .replace(/\s+/g, ' ')
        .trim();
      expect(body, path).toContain(service.exclusion);
      expect(html.match(/id="[a-z-]+-safety-heading"/g) ?? [], path).toHaveLength(1);
      expect((html.match(/class="c-passport"/g) ?? []).length, path).toBe(1);
    }
  });

  it('state a period and release for each table, rank nothing and ship no script', () => {
    for (const { path, html } of mine()) {
      expect(textsOf(html, 'c-plain-table__stamp').length, path).toBe(
        html.match(/<table[ >]/g)?.length ?? 0,
      );
      expect([path, /c-table__rank|<script|\son[a-z]+=/i.test(html)]).toEqual([path, false]);
    }
  });

  it('show a stale member without a value and with its own period', () => {
    let stale = 0;
    for (const slug of healthServiceSlugs()) {
      const html = read(`health-service/${slug}/index.html`);
      for (const member of readHealthService(slug).hospitals) {
        const u = member.urgent_on_time;
        if (u.status !== 'stale' || u.period === null || u.release === null) {
          continue;
        }
        stale += 1;
        const own = fill(service.stale_cell, {
          stamp: `${formatPeriod(u.period)}, released ${formatDate(u.release)}`,
        });
        expect([slug, member.slug, plain(parseFragment(html)).replace(/\s+/g, ' ')]).toEqual([
          slug,
          member.slug,
          expect.stringContaining(own),
        ]);
      }
    }
    expect(stale).toBeGreaterThan(0);
  });

  it('link each hospital page to its network page', () => {
    for (const slug of healthServiceSlugs()) {
      for (const member of readHealthService(slug).hospitals.slice(0, onRealDist ? 3 : 1)) {
        expect([member.slug, read(`hospital/${member.slug}/index.html`)]).toEqual([
          member.slug,
          expect.stringContaining(`href="${healthServicePath(slug)}"`),
        ]);
      }
    }
  });
});

describe('Built content pages', () => {
  it('hold the methodology, data and about pages at the earlier addresses', () => {
    for (const path of ['methodology', 'data', 'about']) {
      expect(paths).toContain(`${path}/index.html`);
      expect(pageAt(`${path}/index.html`).h1).toBe(1);
    }
  });

  it('hold the guides and the page for general practitioners at the earlier addresses', () => {
    for (const path of [
      'guides',
      'guides/check-your-place-on-the-waiting-list',
      'guides/emergency-department-waiting-times',
      'guides/if-your-surgery-is-cancelled',
      'guides/public-and-private-waiting',
      'guides/referral-to-another-hospital',
      'gp',
    ]) {
      expect(paths).toContain(`${path}/index.html`);
      expect(pageAt(`${path}/index.html`).h1).toBe(1);
    }
  });

  it('credit every dataset pinned in the manifest on the data page', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../data/manifest.json', import.meta.url), 'utf8'),
    ) as { datasets: { slug: string; title: string; version: string; citation: string }[] };
    const html = read('data/index.html');
    const found = pageStrings(html).join(' ');
    expect(html.match(/c-passport__source/g)).toHaveLength(readCredits().length);
    if (onRealDist) {
      expect(readCredits().map((c) => c.slug)).toEqual(manifest.datasets.map((d) => d.slug));
      for (const dataset of manifest.datasets) {
        expect(found, dataset.slug).toContain(dataset.title);
        expect(found, dataset.slug).toContain(dataset.citation);
        expect(html, dataset.slug).toContain(`/d/${dataset.slug}/v/${dataset.version}/`);
      }
    }
  });
});
