import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import type { z } from 'astro/zod';

import {
  areasSchema,
  homeTemplateSchema,
  aboutSchema,
  dataPageSchema,
  gpSchema,
  guideSchema,
  guidesIndexSchema,
  methodologySchema,
  hospitalTemplateSchema,
  hospitalsIndexSchema,
  labelsSchema,
  longestTemplateSchema,
  navigationSchema,
  pageSchema,
  pairTemplateSchema,
  siteSchema,
  stateTemplateSchema,
  surgeryNamesSchema,
  surgeryTemplateSchema,
  termsSchema,
  urgencyTemplateSchema,
  healthServiceTemplateSchema,
} from '../lib/content-schema';
import {
  contentSlug,
  decode,
  distSlug,
  entityPattern,
  pageStrings,
  readContent,
  replacedTerms,
  strings,
} from '../lib/content-files';
import DataTable from '../components/DataTable.astro';
import Figure from '../components/Figure.astro';
import primitives from '../dev/primitives.astro';
import SurgeryHub from '../components/SurgeryHub.astro';
import SurgeryIndex from '../components/SurgeryIndex.astro';
import SurgeryNear from '../components/SurgeryNear.astro';
import SurgeryState from '../components/SurgeryState.astro';
import hospitalPage from '../pages/hospital/[slug]/index.astro';
import home from '../pages/index.astro';
import { sampleCharts, surgeryTables } from '../dev/preview';
import { planChart } from '../lib/chart';
import {
  DistError,
  distDirectory,
  listDist,
  readHospital,
  readSurgery,
  readQueenslandFacility,
  validateDist,
  validateDocument,
} from '../lib/dist';
import { getHospitalTemplate, getSurgeryTemplate } from '../lib/content';
import { formatDate, formatFigure, formatStamp } from '../lib/format';
import type { NotPublishedReason, Role } from '../lib/format';
import { nearRoutes, stateRoutes, surgeryRefs } from '../lib/surgery-page';
import { cleanUpCopies, withNearbyPair } from '../lib/test-dist';
import { render, text, textsOf } from '../lib/test-render';

const contractDir = new URL('../../../contract/', import.meta.url);
const siteSrc = new URL('../', import.meta.url).pathname;

function propertyNames(node: unknown): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(propertyNames);
  }
  if (typeof node !== 'object' || node === null) {
    return [];
  }
  return Object.entries(node).flatMap(([key, value]) => [
    ...(key === 'properties' && typeof value === 'object' && value !== null
      ? Object.keys(value as object)
      : []),
    ...propertyNames(value),
  ]);
}

const roles: Role[] = ['median_wait', 'volume', 'long_wait', 'on_time'];
const reasons = (
  JSON.parse(
    readFileSync(new URL('../../../contract/common.schema.json', import.meta.url), 'utf8'),
  ) as {
    $defs: { not_published_figure: { properties: { reason: { enum: NotPublishedReason[] } } } };
  }
).$defs.not_published_figure.properties.reason.enum;

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

// The CSS a reader's browser receives: each stylesheet and the style block of each component.
function styleSources(): string[] {
  const src = fileURLToPath(new URL('../', import.meta.url));
  return readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(?:css|astro)$/.test(f))
    .map((f) => {
      const text = readFileSync(join(src, f), 'utf8');
      return f.endsWith('.css')
        ? text
        : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
    });
}

const TYPE_PROPERTY =
  /^(?:font|font-size|line-height|letter-spacing|word-spacing|--(?:fs|lh|tracking)-.+)$/;
const ABSOLUTE_UNIT = /\d(?:px|pt|pc|cm|mm|in|q)\b/i;
// A type size in an absolute unit would ignore the size a reader sets in the browser.
function absoluteTypeSizes(sources: string[]): string[] {
  return sources.flatMap((css) =>
    [...css.matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)]
      .filter(([, name = '', value = '']) => TYPE_PROPERTY.test(name) && ABSOLUTE_UNIT.test(value))
      .map(([, name = '', value = '']) => `${name}:${value.trim()}`),
  );
}

// Data comes from the pinned manifest and never sits in git; the pipeline's test inputs are the one exception.
const DATA_FILES = new Set([
  'data/manifest.json',
  'data/redirects.json',
  'data/redirects.schema.json',
]);
const DATA_EXTENSION =
  /\.(?:parquet|csv|tsv|ndjson|jsonl|feather|arrow|sqlite3?|db|xlsx?|zip|gz)$/i;
function dataSnapshots(tracked: string[]): string[] {
  return tracked.filter((f) => {
    if (f.startsWith('pipeline/tests/fixtures/') || DATA_FILES.has(f)) {
      return false;
    }
    return (
      f.startsWith('data/') ||
      DATA_EXTENSION.test(f) ||
      f.split('/').some((part) => part === 'dist' || part === '.downloads')
    );
  });
}

function licenceMixing(code: string, data: string): string[] {
  return [
    ...(code.includes('GNU AFFERO GENERAL PUBLIC LICENSE') ? [] : ['LICENSE is not the AGPL']),
    ...(/CC BY|Creative Commons/i.test(code) ? ['LICENSE names a data licence'] : []),
    ...(data.includes('CC BY 4.0') ? [] : ['LICENSE-DATA.md does not name CC BY 4.0']),
    ...(data.includes('GNU AFFERO GENERAL PUBLIC LICENSE')
      ? ['LICENSE-DATA.md holds the code licence text']
      : []),
  ];
}

describe('Contract: dist files', () => {
  it('validate against their JSON Schemas in contract/', () => {
    const listed = readFileSync(join(distDirectory(), 'SHA256SUMS'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('  ')[1])
      .sort();
    expect(listed.length).toBeGreaterThan(0);
    expect(validateDist()).toEqual(listed);
    // A file built to fail the gate.
    expect(() => {
      validateDocument('hospital', { code: 'H1' });
    }).toThrow(DistError);
  });
  it("the site reads only the pipeline's dist output", () => {
    const sources = readdirSync(siteSrc, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(ts|astro)$/.test(f) && !f.endsWith('.test.ts'))
      .map((f) => ({ f, text: readFileSync(join(siteSrc, f), 'utf8') }));
    expect(sources.length).toBeGreaterThan(0);
    const reachesIn = sources.filter(({ text }) => text.includes('pipeline/')).map(({ f }) => f);
    const readsTheVariable = sources
      .filter(({ text }) => text.includes('SURGERYWAITS_DIST'))
      .map(({ f }) => f);
    expect(reachesIn).toEqual([]);
    expect(readsTheVariable).toEqual(['lib/dist.ts']);
  });
});

describe('Suppressed values', () => {
  const stamp = { period: '2024–25', release: '2026-08-19' };
  it("render 'not published' with the reason taken from the publisher's marker (<5, -, NP); an unknown marker fails the build", async () => {
    const byMarker = {
      '<5': ['too_few_patients', 'not published: too few patients'],
      '-': ['no_patients_reported', 'not published: no patients reported'],
      NP: [
        'not_published_by_aihw',
        'not published: the Australian Institute of Health and Welfare did not publish a figure',
      ],
    };
    for (const [reason, words] of Object.values(byMarker)) {
      const html = await render(Figure, {
        role: 'median_wait',
        figure: { state: 'not_published', reason, ...stamp },
      });
      expect(textsOf(html, 'c-figure__value')).toEqual([words]);
    }
    await expect(
      render(Figure, {
        role: 'median_wait',
        figure: { state: 'not_published', reason: '??', ...stamp },
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe('Suppressed cells', () => {
  it('a suppressed cell is never rendered blank or as 0', () => {
    const stamp = { period: '2024–25', release: '2026-08-19' };
    for (const role of roles) {
      for (const reason of reasons) {
        const text = formatFigure(role, { state: 'not_published', reason, ...stamp });
        expect(text).toMatch(/^not published: \D+$/);
      }
      const reported = formatFigure(role, {
        state: 'not_reported',
        reason: 'not_reported_by_source',
        ...stamp,
      });
      expect(reported).toBe('not reported');
    }
  });
  it("'not peered' shows as 'not published: no peer group comparison' and only in place of the peer-group columns", () => {
    const stamp = { period: '2024–25', release: '2026-08-19' };
    expect(
      formatFigure('median_wait', {
        state: 'not_published',
        reason: 'no_peer_group_comparison',
        ...stamp,
      }),
    ).toBe('not published: no peer group comparison');
    // The dist has no peer-group column, so no figure in it has a place to carry this reason.
    const properties = readdirSync(contractDir).flatMap((file) =>
      propertyNames(JSON.parse(readFileSync(new URL(file, contractDir), 'utf8'))),
    );
    expect(properties.length).toBeGreaterThan(0);
    expect(properties.filter((name) => /peer/i.test(name))).toEqual([]);
  });
});

describe('Reference period and release date', () => {
  it('every rendered figure shows its reference period and the data release date', async () => {
    let shown = 0;
    for (const slug of listDist('hospitals')) {
      for (const surgery of readHospital(slug).surgeries) {
        for (const [role, measure] of Object.entries(surgery.measures)) {
          const html = await render(Figure, { role, figure: measure.figure });
          expect(textsOf(html, 'c-stamp')).toEqual([formatStamp(measure.figure)]);
          shown++;
        }
      }
    }
    for (const code of listDist('queensland')) {
      for (const quarter of readQueenslandFacility(code).quarters) {
        for (const [column, figure] of Object.entries(quarter.total)) {
          const html = await render(Figure, { column, figure });
          expect(textsOf(html, 'c-stamp')).toEqual([
            `${figure.period}, released ${formatDate(figure.release)}`,
          ]);
          shown++;
        }
      }
    }
    expect(shown).toBeGreaterThan(1000);
    // A figure built to fail the gate: it cannot say both, so it does not render.
    for (const figure of [
      { state: 'published', value: 5, release: '2026-08-19' },
      { state: 'published', value: 5, period: '2024–25' },
    ]) {
      await expect(render(Figure, { role: 'median_wait', figure })).rejects.toThrow();
    }
  }, 60_000);
});

describe('Ranking', () => {
  it('a hospital with suppressed, closed or stale figures (latest period older than the newest in the table) is never ranked', async () => {
    let ranked = 0;
    for (const table of surgeryTables()) {
      for (const row of table.rows) {
        for (const cell of row.cells) {
          if (cell.rank !== undefined) {
            ranked++;
            expect(cell.figure.state).toBe('published');
            expect(row.stale).not.toBe(true);
          }
        }
      }
      const html = await render(DataTable, {
        id: 'gate',
        caption: 'Gate',
        rowHeading: 'Hospital',
        columns: table.roles.map((role) => ({ heading: role, role })),
        rows: table.rows,
      });
      expect(textsOf(html, 'c-table__rank')).toHaveLength(
        table.rows.flatMap((r) => r.cells).filter((c) => c.rank !== undefined).length,
      );
    }
    expect(ranked).toBeGreaterThan(0);
    // A rank on a stale row, built to fail the gate, does not render.
    const current = { state: 'published', value: 9, period: '2024–25', release: '2026-08-19' };
    const stale = { ...current, period: '2017–18' };
    const rows = [
      { code: 'y', name: 'Y', cells: [{ figure: current }] },
      {
        code: 'x',
        name: 'X',
        stale: true,
        cells: [{ figure: stale, rank: { position: 1, of: 2 } }],
      },
    ];
    const columns = [{ heading: 'Wait', role: 'median_wait' }];
    await expect(
      render(DataTable, { id: 'bad', caption: 'Bad', rowHeading: 'Hospital', columns, rows }),
    ).rejects.toThrow();
  }, 60_000);
});

describe('Private hospitals', () => {
  it('private hospitals are excluded and the page states the exclusion', async () => {
    const { exclusion_heading, exclusion } = getHospitalTemplate();
    const slugs = listDist('hospitals');
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      expect(readHospital(slug).scope.sector).toBe('public');
      const main = text((await render(hospitalPage, { slug })).split('<main')[1] ?? '');
      expect(main, slug).toContain(exclusion_heading);
      expect(main, slug).toContain(exclusion);
    }
  }, 60_000);
  it('every surgery page covers public hospitals only and states the exclusion', async () => {
    const { exclusion_heading, exclusion } = getSurgeryTemplate();
    const pages = [await render(SurgeryIndex, {})];
    for (const ref of surgeryRefs()) {
      expect(readSurgery(ref.kind, ref.slug).scope.sector).toBe('public');
      pages.push(await render(SurgeryHub, { kind: ref.kind, urlSlug: ref.urlSlug }));
    }
    for (const html of pages) {
      const main = text(html.split('<main')[1] ?? '');
      expect(main).toContain(exclusion_heading);
      expect(main).toContain(exclusion);
    }
  }, 120_000);
});

describe('Static pages', () => {
  it("every hospital's figures are reachable without script", async () => {
    for (const slug of listDist('hospitals')) {
      const html = await render(hospitalPage, { slug });
      expect(html).not.toContain('<script');
      const words = text(html);
      for (const surgery of readHospital(slug).surgeries) {
        if (surgery.kind === 'urgency') {
          continue;
        }
        expect(words, `${slug} ${surgery.slug}`).toContain(surgery.name);
        for (const [role, { figure }] of Object.entries(surgery.measures)) {
          expect(words, `${slug} ${surgery.slug} ${role}`).toContain(
            formatFigure(role as Role, figure),
          );
        }
      }
    }
  }, 60_000);
  it("every surgery's hospital figures are reachable without script", async () => {
    for (const ref of surgeryRefs()) {
      const html = await render(SurgeryHub, { kind: ref.kind, urlSlug: ref.urlSlug });
      expect(html).not.toContain('<script');
      const words = text(html);
      for (const row of readSurgery(ref.kind, ref.slug).hospitals.filter((h) => !h.closed)) {
        expect(words, `${ref.urlSlug} ${row.slug}`).toContain(row.name);
        for (const [role, { figure }] of Object.entries(row.measures)) {
          expect(words, `${ref.urlSlug} ${row.slug} ${role}`).toContain(
            formatFigure(role as Role, figure),
          );
        }
      }
    }
  }, 120_000);
});

describe('Privacy', () => {
  it.todo('the site sets no cookies and uses no localStorage or sessionStorage');
  it.todo('the compare tool puts no search state in the URL or history');
  it.todo('the page-view count sets no cookie and sends nothing a person enters');
  it.todo('the privacy check allows exactly the Web Analytics beacon and report hosts');
});

describe('Accessibility', () => {
  it("every size is relative, so a reader's own browser text size applies", () => {
    expect(absoluteTypeSizes(styleSources())).toEqual([]);
    expect(
      absoluteTypeSizes([
        'a{font-size:14px}',
        'b{line-height:20px;letter-spacing:1pt}',
        ':root{--fs-x:12px;--fs-ok:0.75rem}',
        'c{font:italic 13px/1.5 serif}',
        'd{font-size:clamp(1rem,2vw,16px)}',
        'e{font-size:1rem;line-height:1.5;border-width:1px}',
      ]),
    ).toEqual([
      'font-size:14px',
      'line-height:20px',
      'letter-spacing:1pt',
      '--fs-x:12px',
      'font:italic 13px/1.5 serif',
      'font-size:clamp(1rem,2vw,16px)',
    ]);
  });
  // The charts and bars are the only marks that carry data in colour, so the gate covers them.
  it('colour is never the only carrier of meaning', async () => {
    const { plain, gaps } = sampleCharts({ hospital: 'This hospital', national: 'Australia' });
    for (const { series } of [plain, gaps]) {
      const plan = planChart('median_wait', series);
      const marks = plan.series.map((s) => `${s.shape}|${s.dash ?? ''}`);
      expect(new Set(marks).size).toBe(marks.length);
      expect(plan.series.every((s) => s.name !== '')).toBe(true);
    }
    const html = await render(primitives, {});
    const items = textsOf(html, 'c-waits__label').length;
    expect(items).toBeGreaterThan(0);
    expect(textsOf(html, 'c-waits__value')).toHaveLength(items);
    expect(textsOf(html, 'c-waits__value').every((t) => t !== '')).toBe(true);
    expect(html.match(/<details/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Copy', () => {
  it("'elective' appears only where the methodology quotes a source", () => {
    const { terms, quotes } = termsSchema.parse(
      readContent().find(({ path }) => path === 'terms.yaml')?.data,
    );
    const found = readContent()
      .filter(({ path }) => path !== 'terms.yaml')
      .flatMap(({ path, data }) =>
        replacedTerms(contentSlug(path), strings(data), { terms, quotes }),
      );
    expect(found).toEqual([]);
    expect(terms.some((t) => t.replaces.includes('elective'))).toBe(true);
    expect(quotes.every((q) => ['methodology', 'data'].includes(q.page))).toBe(true);
  });
  it('the terminology check catches a replaced term and honours a quote listed for its page', () => {
    const terms = [{ preferred: 'planned surgery', replaces: ['elective surgery', 'elective'] }];
    const text = ['Waits for elective surgery', 'a selective list'];
    expect(replacedTerms('guide', text, { terms, quotes: [] })).toEqual([
      'guide: "elective surgery" should be "planned surgery"',
      'guide: "elective" should be "planned surgery"',
    ]);
    const quotes = [
      { page: 'methodology', term: 'elective surgery' },
      { page: 'methodology', term: 'elective' },
    ];
    expect(replacedTerms('methodology', text, { terms, quotes })).toEqual([]);
    expect(replacedTerms('guide', text, { terms, quotes })).toHaveLength(2);
    expect(replacedTerms('guide', ['elective&nbsp;surgery'], { terms, quotes: [] })).toHaveLength(
      2,
    );
  });
  it('a page and its dist file share one slug', () => {
    expect(contentSlug('pages/not-found.yaml')).toBe('not-found');
    expect([
      distSlug('index.html'),
      distSlug('404.html'),
      distSlug('methodology/index.html'),
    ]).toEqual(['home', '404', 'methodology']);
  });
  it('the page scan reads attributes and decodes every entity', () => {
    const html =
      '<html><head><meta name="description" content="Elective &amp; more"></head><body>' +
      '<img alt="elective&#32;surgery" src="/a.png"><p>ABN&nbsp;12 345&ensp;678</p>' +
      '<p>Pty&thinsp;Ltd</p><script>var elective = 1</script></body></html>';
    const text = pageStrings(html);
    expect(text).toContain('Elective & more');
    expect(text).toContain('elective surgery');
    expect(text.filter((t) => entityPattern.test(t))).toHaveLength(2);
    expect(text.join(' ')).not.toContain('var elective');
    expect(entityPattern.test(decode('Pty&nbsp;Ltd'))).toBe(true);
  });
  it("no 'best hospital' or practitioner-promotion language appears", async () => {
    const promotion = new RegExp(
      [
        String.raw`\b(?:best|worst|top|leading|finest)\s+(?:\w+\s+)?(?:hospitals?|surgeons?|doctors?|specialists?|clinics?)\b`,
        String.raw`\b(?:find|choose|book)\s+(?:a|an|the)\s+(?:surgeon|doctor|specialist|consultation|appointment)\b`,
        String.raw`\bour\s+(?:surgeons?|doctors?|specialists?|clinics?)\b`,
      ].join('|'),
      'i',
    );
    expect('The best hospital for hips').toMatch(promotion);
    expect('Book an appointment with our surgeons').toMatch(promotion);
    expect('Surgery in category 1 is recommended within 30 days').not.toMatch(promotion);
    const copy = readContent().flatMap(({ data }) => strings(data));
    const pages = [await render(home, {})];
    for (const slug of listDist('hospitals')) {
      pages.push(await render(hospitalPage, { slug }));
    }
    pages.push(await render(SurgeryIndex, {}));
    for (const ref of surgeryRefs()) {
      pages.push(await render(SurgeryHub, { kind: ref.kind, urlSlug: ref.urlSlug }));
    }
    for (const { props } of stateRoutes('procedure').slice(0, 20)) {
      pages.push(
        await render(SurgeryState, { kind: 'procedure', urlSlug: props.slug, state: props.state }),
      );
    }
    withNearbyPair();
    for (const { props } of nearRoutes()) {
      pages.push(await render(SurgeryNear, { urlSlug: props.slug, area: props.area }));
    }
    cleanUpCopies();
    for (const found of [...copy, ...pages.flatMap((html) => pageStrings(html))]) {
      expect(found).not.toMatch(promotion);
    }
  }, 180_000);
  it('copy lives in typed content files', () => {
    const schemas: Record<string, z.ZodType> = {
      'site.yaml': siteSchema,
      'labels.yaml': labelsSchema,
      'navigation.yaml': navigationSchema,
      'templates/hospital.yaml': hospitalTemplateSchema,
      'templates/pair.yaml': pairTemplateSchema,
      'templates/surgery.yaml': surgeryTemplateSchema,
      'areas.yaml': areasSchema,
      'surgery-names.yaml': surgeryNamesSchema,
      'templates/hospitals.yaml': hospitalsIndexSchema,
      'templates/state.yaml': stateTemplateSchema,
      'templates/urgency.yaml': urgencyTemplateSchema,
      'templates/home.yaml': homeTemplateSchema,
      'templates/health-service.yaml': healthServiceTemplateSchema,
      'templates/longest.yaml': longestTemplateSchema,
      'terms.yaml': termsSchema,
      'pages/not-found.yaml': pageSchema,
      'pages/methodology.yaml': methodologySchema,
      'pages/data.yaml': dataPageSchema,
      'pages/about.yaml': aboutSchema,
      'pages/gp.yaml': gpSchema,
      'pages/guides.yaml': guidesIndexSchema,
    };
    const files = readContent();
    expect(files.length).toBeGreaterThan(0);
    for (const { path, data } of files) {
      const schema = path.startsWith('pages/guides/') ? guideSchema : schemas[path];
      expect(schema, path + ' has no schema').toBeDefined();
      expect(schema?.safeParse(data).success, path).toBe(true);
    }
  });
  it('a missing or unknown content slot fails the build', () => {
    const labels = readContent().find(({ path }) => path === 'labels.yaml')?.data as Record<
      string,
      string
    >;
    const missing = { ...labels };
    delete missing['skip_link'];
    expect(labelsSchema.safeParse(missing).success).toBe(false);
    expect(labelsSchema.safeParse({ ...labels, stray: 'Text' }).success).toBe(false);
    const site = readContent().find(({ path }) => path === 'site.yaml')?.data as {
      operator: { line: string };
    };
    const noSlot = { ...site, operator: { ...site.operator, line: 'Built and operated by us' } };
    expect(siteSchema.safeParse(noSlot).success).toBe(false);
    const twice = { ...site, operator: { ...site.operator, line: '{operator} {operator}' } };
    expect(siteSchema.safeParse(twice).success).toBe(false);
  });
  it('no literal user-visible text appears in components; copy lives in YAML under content/', async () => {
    const eslint = new ESLint({ cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
    const results = await eslint.lintFiles(['site/src/**/*.astro']);
    const found = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === 'site/no-literal-text')
        .map((m) => r.filePath + ':' + String(m.line)),
    );
    expect(found).toEqual([]);
  }, 60_000);
  it('the site entity names the publisher without an ACN, an ABN or a company suffix', () => {
    const files = readContent();
    expect(files.length).toBeGreaterThan(0);
    expect(
      files
        .filter(({ raw, data }) =>
          [raw, ...strings(data).map(decode)].some((t) => entityPattern.test(t)),
        )
        .map(({ path }) => path),
    ).toEqual([]);
    for (const bad of [
      'ACN 123 456 789',
      'ABN 12 345 678 901',
      'National Digital Pty Ltd',
      'pty. ltd',
    ]) {
      expect(entityPattern.test(bad), bad).toBe(true);
    }
    const site = siteSchema.parse(files.find(({ path }) => path === 'site.yaml')?.data);
    expect(site.operator.line).toBe('Built and operated by {operator}, Burleigh Heads, Queensland');
    expect(site.operator.url).toBe('https://nationaldigital.com.au/');
  });
});

describe('Repository', () => {
  it('no data snapshot is committed to git', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\0')
      .filter((f) => f !== '');
    expect(tracked.length).toBeGreaterThan(0);
    expect(dataSnapshots(tracked)).toEqual([]);
    expect(
      dataSnapshots([
        'data/manifest.json',
        'pipeline/tests/fixtures/slug/data.parquet',
        'site/src/lib/dist.ts',
        'data/hospitals.json',
        'pipeline/dist/index.json',
        'pipeline/.downloads/0a1b2c',
        'site/public/waits.csv',
        'archive/waits.parquet',
      ]),
    ).toEqual([
      'data/hospitals.json',
      'pipeline/dist/index.json',
      'pipeline/.downloads/0a1b2c',
      'site/public/waits.csv',
      'archive/waits.parquet',
    ]);
  });
  it('the data licence stays in its own file, apart from the code licence', () => {
    const code = readFileSync(join(repoRoot, 'LICENSE'), 'utf8');
    const data = readFileSync(join(repoRoot, 'LICENSE-DATA.md'), 'utf8');
    expect(licenceMixing(code, data)).toEqual([]);
    expect(
      licenceMixing(
        'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3\nThe data is under CC BY 4.0.',
        'The text is under CC BY 4.0.\nGNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007',
      ),
    ).toEqual(['LICENSE names a data licence', 'LICENSE-DATA.md holds the code licence text']);
    expect(licenceMixing('MIT', 'Other')).toEqual([
      'LICENSE is not the AGPL',
      'LICENSE-DATA.md does not name CC BY 4.0',
    ]);
  });
});

describe('OpenAPI', () => {
  it.todo('a schema and the generated OpenAPI description never disagree');
});
