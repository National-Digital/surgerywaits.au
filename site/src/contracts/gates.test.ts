import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import type { z } from 'astro/zod';

import { labelsSchema, pageSchema, siteSchema, termsSchema } from '../lib/content-schema';
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
import { surgeryTables } from '../dev/preview';
import {
  DistError,
  distDirectory,
  listDist,
  readHospital,
  readQueenslandFacility,
  validateDist,
  validateDocument,
} from '../lib/dist';
import { formatDate, formatFigure, formatStamp } from '../lib/format';
import type { NotPublishedReason, Role } from '../lib/format';
import { render, textsOf } from '../lib/test-render';

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
      NP: ['not_published_by_aihw', 'not published: AIHW did not publish a figure'],
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
  it.todo('private hospitals are excluded and the page states the exclusion');
});

describe('Determinism', () => {
  it.todo('building the site twice gives byte-identical output');
});

describe('Static pages', () => {
  it.todo('static pages ship zero JavaScript');
  it.todo("every hospital's figures are reachable without script");
});

describe('Privacy', () => {
  it.todo('the site sets no cookies and uses no localStorage or sessionStorage');
  it.todo('the compare tool puts no search state in the URL or history');
  it.todo('the page-view count sets no cookie and sends nothing a person enters');
  it.todo('the privacy check allows exactly the Web Analytics beacon and report hosts');
});

describe('Page weight', () => {
  it.todo('every page stays within the page-weight budget set when the site lands');
});

describe('HTML validity', () => {
  it.todo('the W3C Nu Html Checker passes with --Werror');
  it.todo('the Nu checker version is pinned and every filter line carries a reason');
});

describe('Accessibility', () => {
  it.todo('axe passes at WCAG 2.2 AAA in light mode');
  it.todo('axe passes at WCAG 2.2 AAA in dark mode');
  it.todo('text a person reads is at or above a set minimum size');
  it.todo('no paragraph averages more than 80 characters a line');
  it.todo('every link, button and field meets a minimum target size');
  it.todo('no link is named by a word that does not say where it goes');
  it.todo('no page scrolls sideways at 320 CSS pixels wide');
  it.todo('with the WCAG text-spacing settings forced, nothing is cut off');
  it.todo("every size is relative, so a reader's own browser text size applies");
  it.todo('colour is never the only carrier of meaning');
});

describe('Contrast', () => {
  it.todo('all text and meaningful graphics meet AAA contrast in light and dark');
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
    expect(quotes.every((q) => q.page === 'methodology')).toBe(true);
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
  it.todo("no 'best hospital' or practitioner-promotion language appears");
  it('copy lives in typed content files', () => {
    const schemas: Record<string, z.ZodType> = {
      'site.yaml': siteSchema,
      'labels.yaml': labelsSchema,
      'terms.yaml': termsSchema,
    };
    const files = readContent();
    expect(files.length).toBeGreaterThan(0);
    for (const { path, data } of files) {
      const schema = path.startsWith('pages/') ? pageSchema : schemas[path];
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
  it.todo('the credit line uses the citation publicdata.au publishes with each version');
});

describe('Repository', () => {
  it.todo('no data snapshot is committed to git');
  it.todo('the data licence stays in its own file, apart from the code licence');
});

describe('OpenAPI', () => {
  it.todo('a schema and the generated OpenAPI description never disagree');
});

describe('Delivery', () => {
  it.todo('CSP and security headers are set on every response');
  it.todo('every redirect reaches a 200');
  it.todo('every internal link resolves');
  it.todo('the sitemap lists every indexable page and only those');
});
