import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import type { z } from 'astro/zod';

import {
  areasSchema,
  compareTemplateSchema,
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
  procedureSynonymsSchema,
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
  contractSchemas,
  distDirectory,
  listDist,
  readHospital,
  readSurgery,
  readQueenslandFacility,
  validateDist,
  validateDocument,
} from '../lib/dist';
import { openApiDisagreements, openApiDocument } from '../lib/openapi';
import { getHospitalTemplate, getSurgeryTemplate } from '../lib/content';
import { formatDate, formatFigure, formatStamp } from '../lib/format';
import type { NotPublishedReason, Role } from '../lib/format';
import { nearRoutes, stateRoutes, surgeryRefs } from '../lib/surgery-page';
import { cleanUpCopies, withNearbyPair } from '../lib/test-dist';
import {
  fetchProblems,
  historyUses,
  pageProblems,
  policySources,
  policyProblems,
  sendingUses,
  storageUses,
} from '../lib/privacy';
import { render, text, textsOf, withoutJsonLd } from '../lib/test-render';
import { SECURITY_HEADERS } from '../../../worker/headers';

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

// SVG output sizes its text by the viewBox, so its unitless font-size attributes scale with the picture.
const SVG_ONLY = ['lib/state-chart.ts'];
const STYLE_ATTRIBUTE = /\sstyle=(?:\x22([^\x22]*)\x22|\x27([^\x27]*)\x27)/g;
const stripComments = (css: string): string =>
  css.replace(new RegExp('/\\*[\\s\\S]*?\\*/', 'g'), '');
// The CSS a reader's browser receives: stylesheets, component style blocks and style attributes,
// and the style strings that .ts files build.
function styleSources(): string[] {
  const src = fileURLToPath(new URL('../', import.meta.url));
  return readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter(
      (f) => /\.(?:css|astro|ts)$/.test(f) && !f.endsWith('.test.ts') && !SVG_ONLY.includes(f),
    )
    .flatMap((f) => {
      const text = readFileSync(join(src, f), 'utf8');
      if (f.endsWith('.css')) {
        return [stripComments(text)];
      }
      const blocks = f.endsWith('.astro')
        ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) =>
            stripComments(m[1] ?? ''),
          )
        : [];
      const attributes = [...text.matchAll(STYLE_ATTRIBUTE)].map((m) => m[1] ?? m[2] ?? '');
      return f.endsWith('.ts') ? [stripComments(text)] : [...blocks, ...attributes];
    });
}

const TYPE_PROPERTY =
  /^(?:font|font-size|line-height|letter-spacing|word-spacing|--(?:fs|lh|tracking)-.+)$/;
const ABSOLUTE_UNIT = /\d(?:px|pt|pc|cm|mm|in|q)\b/i;
const RELATIVE_UNIT = /\d(?:rem|em|ex|ch|lh|rlh|vw|vh|vi|vb|vmin|vmax|%)/i;
// A px term inside a calc() that also holds a relative unit still follows the reader's size.
function withoutRelativeCalc(value: string): string {
  let next = value;
  for (let prev = ''; prev !== next;) {
    prev = next;
    next = next.replace(/calc\(([^()]*)\)/g, (m, inner: string) =>
      RELATIVE_UNIT.test(inner) ? '0' : m,
    );
  }
  return next;
}
// A type size in an absolute unit would ignore the size a reader sets in the browser.
function absoluteTypeSizes(sources: string[]): string[] {
  return sources.flatMap((css) =>
    [...stripComments(css).matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)]
      .filter(
        ([, name = '', value = '']) =>
          TYPE_PROPERTY.test(name) && ABSOLUTE_UNIT.test(withoutRelativeCalc(value)),
      )
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
  /\.(?:parquet|csv|tsv|ndjson|jsonl|feather|arrow|sqlite3?|db|xlsx?|xlsb|zip|gz|zst|tar|7z)$/i;
const SIZE_CAP = 1_000_000;
const FIXTURE_SIZE_CAP = 400_000; // the largest fixture is 162 KB
// A snapshot can hide under any name, so a big file fails wherever it sits.
function oversized(sizes: Record<string, number>): string[] {
  return Object.entries(sizes)
    .filter(
      ([f, bytes]) =>
        bytes > (f.startsWith('pipeline/tests/fixtures/') ? FIXTURE_SIZE_CAP : SIZE_CAP),
    )
    .map(([f]) => f);
}
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
      expect(withoutJsonLd(html)).not.toContain('<script');
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
      expect(withoutJsonLd(html)).not.toContain('<script');
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

// The code a reader's browser or the Worker runs: every non-test source under these folders.
function shippedSources(folders: string[]): { file: string; text: string }[] {
  return folders.flatMap((folder) =>
    readdirSync(folder, { recursive: true, encoding: 'utf8' })
      .filter(
        (f) => /\.(?:ts|astro|js)$/.test(f) && !f.endsWith('.test.ts') && !f.startsWith('dev/'),
      )
      .map((f) => ({ file: f, text: readFileSync(join(folder, f), 'utf8') })),
  );
}
const toolSources = (): { file: string; text: string }[] => shippedSources([`${siteSrc}tool`]);
const siteSources = (): { file: string; text: string }[] =>
  shippedSources([siteSrc]).filter(
    ({ file }) => !file.startsWith('contracts/') && file !== 'lib/privacy.ts',
  );
const workerSources = (): { file: string; text: string }[] =>
  shippedSources([join(repoRoot, 'worker')]).filter(({ file }) => !file.endsWith('.d.ts'));
const policy = SECURITY_HEADERS['Content-Security-Policy'] ?? '';

describe('Privacy', () => {
  it('the site sets no cookies and uses no localStorage or sessionStorage', () => {
    const sources = [...siteSources(), ...workerSources()];
    expect(sources.length, 'the scan reads files').toBeGreaterThan(20);
    expect(
      sources.flatMap(({ file, text }) => storageUses(text).map((u) => `${file}: ${u}`)),
    ).toEqual([]);
    for (const fixture of [
      'document.cookie = "a=1";',
      "localStorage.setItem('a', '1');",
      "window['sessionStorage'].clear(); sessionStorage.length;",
      "indexedDB.open('a');",
      "headers.set('Set-Cookie', 'a=1');",
      "document['cookie'] = 'a=1';",
      "await caches.open('a');",
      "caches['default'].put(r, s);",
      "navigator.serviceWorker.register('/sw.js');",
      'cookieStore.set("a", "1");',
    ]) {
      expect(storageUses(fixture), fixture).not.toEqual([]);
    }
    expect(storageUses("headers.delete('Set-Cookie');")).toEqual([]);
  });

  it('the compare tool puts no search state in the URL or history', () => {
    const sources = toolSources();
    expect(sources.length, 'the scan reads the tool').toBeGreaterThan(4);
    expect(
      sources.flatMap(({ file, text }) => historyUses(text).map((u) => `${file}: ${u}`)),
    ).toEqual([]);
    for (const fixture of [
      "history.pushState({}, '', '?q=1');",
      "history.replaceState(null, '', '#a');",
      "location.hash = 'a';",
      "location.href = '/compare/?q=1';",
      "location.assign('/x');",
      "addEventListener('hashchange', f);",
      "const h = history; h.pushState({}, '', '?q=1');",
      "const r = window.history; r.replaceState(null, '', '#a');",
      "window['history'].go(1);",
      'x.pushState(1);',
    ]) {
      expect(historyUses(fixture), fixture).not.toEqual([]);
    }
    expect(historyUses('const history = chart(row); const x = location.origin;')).toEqual([]);
  });

  it('the compare tool fetches only its own /tool/ files', () => {
    const sources = toolSources();
    expect(
      sources.some(({ text }) => text.includes('fetch(')),
      'the scan finds the tool fetch',
    ).toBe(true);
    expect(
      sources.flatMap(({ file, text }) => fetchProblems(text).map((u) => `${file}: ${u}`)),
    ).toEqual([]);
    expect(fetchProblems("fetch('/tool/index.json'); fetch(`/tool/a-b.json`, { x: 1 });")).toEqual(
      [],
    );
    for (const fixture of [
      'fetch(address);',
      "fetch('https://stats.example/a.json');",
      "fetch('//stats.example/tool/a.json');",
      "fetch('/tool/a.json?q=' + name);",
      "fetch('/other/a.json');",
      "const f = fetch; f('/tool/a.json');",
      "window.fetch('/x');",
    ]) {
      expect(fetchProblems(fixture), fixture).not.toEqual([]);
    }
  });

  it('the page-view count sets no cookie and sends nothing a person enters', () => {
    expect(policyProblems(policy)).toEqual([]);
    expect(policySources(policy)).toEqual([
      'connect-src https://cloudflareinsights.com',
      'img-src data:',
      'script-src https://static.cloudflareinsights.com',
    ]);
    expect(policy).toContain("form-action 'none'");
    expect(
      toolSources().flatMap(({ file, text }) => sendingUses(text).map((u) => `${file}: ${u}`)),
    ).toEqual([]);
    expect(
      workerSources().flatMap(({ file, text }) => storageUses(text).map((u) => `${file}: ${u}`)),
    ).toEqual([]);
    expect(sendingUses('navigator.sendBeacon("/x", name)')).not.toEqual([]);
    expect(pageProblems('<script>track()</script>')).toEqual(['script: inline']);
    expect(
      pageProblems(
        '<script src="https://static.cloudflareinsights.com/beacon.min.js" defer></script>',
      ),
    ).toEqual(['script: https://static.cloudflareinsights.com/beacon.min.js', 'beacon']);
    expect(pageProblems('<script type="module" src="/_astro/a.js"></script><p>hi</p>')).toEqual([]);
    expect(pageProblems('<script src="//x.example/a.js"></script>')).toEqual([
      'script: //x.example/a.js',
    ]);
    expect(pageProblems('<SCRIPT>track()</script >')).toEqual(['script: inline']);
    expect(
      pageProblems('<template><script src="https://x.example/a.js"></script></template>'),
    ).toEqual(['script: https://x.example/a.js']);
    expect(pageProblems('<head><noscript><script>x()</script></noscript></head>')).toEqual([
      'script: inline',
    ]);
    expect(pageProblems('<p>hi</p><script\nsrc=https://x.example/a.js></script\t>')).toEqual([
      'script: https://x.example/a.js',
    ]);
  });

  it('the privacy check exempts only a JSON-LD data block, by type', () => {
    const ld = '{"@context":"https://schema.org"}';
    expect(pageProblems(`<script type="application/ld+json">${ld}</script>`)).toEqual([]);
    expect(pageProblems(`<script type=" Application/LD+JSON ">${ld}</script>`)).toEqual([]);
    expect(pageProblems('<script type="text/javascript">track()</script>')).toEqual([
      'script: inline',
    ]);
    expect(pageProblems('<script type="application/ld+json" src="/data.json"></script>')).toEqual([
      'script: /data.json',
    ]);
  });

  it('the privacy check allows exactly the Web Analytics beacon and report hosts', () => {
    expect(policyProblems(policy)).toEqual([]);
    const third = policy.replace(
      "img-src 'self' data:",
      "img-src 'self' data: https://pixel.example",
    );
    const script = policy.replace(
      'https://static.cloudflareinsights.com',
      'https://static.cloudflareinsights.com https://cdn.example',
    );
    const report = policy.replace(
      'https://cloudflareinsights.com',
      'https://cloudflareinsights.com https://stats.example',
    );
    const swapped = policy.replace(
      'connect-src',
      'connect-src https://static.cloudflareinsights.com',
    );
    const wild = policy.replace("font-src 'self'", "font-src 'self' *");
    const missing = policy.replace(' https://cloudflareinsights.com', '');
    const loosened = policy.replace("default-src 'none'", "default-src 'self'");
    const repeated = `${policy}; script-src 'self'`;
    const scheme = (directive: string, source: string): string =>
      policy.replace(`${directive} 'self'`, `${directive} 'self' ${source}`);
    for (const [name, fixture, expected] of [
      ['default-src loosened', loosened, "default-src: 'self'"],
      ['a repeated directive', repeated, 'duplicate: script-src'],
      ['https: alone', scheme('style-src', 'https:'), 'extra: style-src https:'],
      ['http: alone', scheme('style-src', 'http:'), 'extra: style-src http:'],
      ['ws: alone', scheme('connect-src', 'ws:'), 'extra: connect-src ws:'],
      ['wss: alone', scheme('connect-src', 'wss:'), 'extra: connect-src wss:'],
      ['blob:', scheme('img-src', 'blob:'), 'extra: img-src blob:'],
      ['data: in a script', scheme('script-src', 'data:'), 'extra: script-src data:'],
      ['a bare host', scheme('font-src', 'cdn.example'), 'extra: font-src cdn.example'],
      [
        'a bare host with a port',
        scheme('font-src', 'cdn.example:443'),
        'extra: font-src cdn.example:443',
      ],
      ['a host wildcard', scheme('font-src', '*.example.com'), 'extra: font-src *.example.com'],
      ['a lone wildcard', scheme('font-src', '*'), 'extra: font-src *'],
      [
        'an inline allowance',
        scheme('style-src', "'unsafe-inline'"),
        "keyword: style-src 'unsafe-inline'",
      ],
      ['an image host', third, 'extra: img-src https://pixel.example'],
      ['a script host', script, 'extra: script-src https://cdn.example'],
      ['a report host', report, 'extra: connect-src https://stats.example'],
      [
        'the beacon host in the wrong directive',
        swapped,
        'extra: connect-src https://static.cloudflareinsights.com',
      ],
      ['a wildcard', wild, 'wildcard or unsafe'],
      ['a missing report host', missing, 'missing: connect-src https://cloudflareinsights.com'],
    ] as const) {
      expect(policyProblems(fixture), name).toContain(expected);
    }
  });
});

describe('Accessibility', () => {
  it("every size is relative, so a reader's own browser text size applies", () => {
    const sources = styleSources();
    // An empty scan would pass on nothing.
    expect(sources.length).toBeGreaterThan(10);
    expect(absoluteTypeSizes(sources)).toEqual([]);
    expect(
      absoluteTypeSizes([
        'a{font-size:14px}',
        'b{line-height:20px;letter-spacing:1pt}',
        ':root{--fs-x:12px;--fs-ok:0.75rem}',
        'c{font:italic 13px/1.5 serif}',
        'd{font-size:clamp(1rem,2vw,16px)}',
        'e{font-size:1rem;line-height:1.5;border-width:1px}',
        '/* font-size:9px */f{font-size:1rem}',
        'g{font-size:calc(1rem + 2px);line-height:calc(1.5 * 12px)}',
        'h{font-size:clamp(1rem,calc(0.5rem + 1vw),calc(2rem + 1px))}',
      ]),
    ).toEqual([
      'font-size:14px',
      'line-height:20px',
      'letter-spacing:1pt',
      '--fs-x:12px',
      'font:italic 13px/1.5 serif',
      'font-size:clamp(1rem,2vw,16px)',
      'line-height:calc(1.5 * 12px)',
    ]);
    expect(
      absoluteTypeSizes(
        ['<p style="font-size:14px">'].flatMap((h) =>
          [...h.matchAll(STYLE_ATTRIBUTE)].map((m) => m[1] ?? ''),
        ),
      ),
    ).toEqual(['font-size:14px']);
  });
  it('exempts only SVG output from the relative-size check, where text is sized by the viewBox', () => {
    const src = fileURLToPath(new URL('../', import.meta.url));
    expect(SVG_ONLY.length).toBeGreaterThan(0);
    for (const f of SVG_ONLY) {
      const text = readFileSync(join(src, f), 'utf8');
      expect(text, f).toContain('<svg');
      expect(text, f).not.toMatch(STYLE_ATTRIBUTE);
      expect(text, f).not.toContain('<style');
      const sizes = text.match(/font-size[^,;]{0,12}/g) ?? [];
      expect(sizes.length, f).toBeGreaterThan(0);
      expect(
        sizes.every((v) => /^font-size=\x22\d+(?:\.\d+)?\x22/.test(v)),
        f,
      ).toBe(true);
    }
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
      'procedure-synonyms.yaml': procedureSynonymsSchema,
      'templates/compare.yaml': compareTemplateSchema,
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
    const results = await eslint.lintFiles(['site/src/**/*.astro', 'site/src/tool/*.ts']);
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
      oversized(
        Object.fromEntries(
          tracked
            .filter((f) => existsSync(join(repoRoot, f)))
            .map((f) => [f, statSync(join(repoRoot, f)).size]),
        ),
      ),
    ).toEqual([]);
    expect(
      oversized({
        'docs/big.bin': 1_000_001,
        'docs/ok.bin': 1_000_000,
        'pipeline/tests/fixtures/a/data.parquet': 399_999,
        'pipeline/tests/fixtures/b/data.parquet': 400_001,
        'site/public/one.json': 2_000_000,
      }),
    ).toEqual(['docs/big.bin', 'pipeline/tests/fixtures/b/data.parquet', 'site/public/one.json']);
    expect(
      dataSnapshots(['a/x.zst', 'a/x.tar', 'a/x.7z', 'a/x.xlsb', 'a/x.xlsx', 'a/x.txt']),
    ).toEqual(['a/x.zst', 'a/x.tar', 'a/x.7z', 'a/x.xlsb', 'a/x.xlsx']);
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
  // Read at collection, before another test stubs the variable to a copy it later deletes.
  const dist = distDirectory();
  const schemaCatalogue = (): Ajv2020 => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    for (const [, schema] of contractSchemas()) {
      ajv.addSchema(schema as object);
    }
    return ajv;
  };
  const distFiles = (): { path: string; body: unknown }[] =>
    readdirSync(dist, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((path) => ({
        path: `/data-api/${path}`,
        body: JSON.parse(readFileSync(join(dist, path), 'utf8')) as unknown,
      }));

  it('a schema and the generated OpenAPI description never disagree', () => {
    const files = distFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(openApiDisagreements(openApiDocument(), files, schemaCatalogue())).toEqual([]);
  });

  it('reports a path that names the wrong schema, a path with no file and a file with no path', () => {
    const document = structuredClone(openApiDocument()) as {
      paths: Record<string, unknown>;
    };
    const hospital = document.paths['/data-api/hospitals/{slug}.json'] as {
      get: {
        responses: { '200': { content: { 'application/json': { schema: { $ref: string } } } } };
      };
    };
    hospital.get.responses['200'].content['application/json'].schema.$ref =
      'https://surgerywaits.au/contract/trend.schema.json';
    document.paths['/data-api/ghosts.json'] = document.paths['/data-api/rules.json'];
    delete document.paths['/data-api/credits.json'];
    const problems = openApiDisagreements(document, distFiles(), schemaCatalogue());
    expect(problems.some((p) => /^\/data-api\/hospitals\/.+ breaks .*trend/u.test(p))).toBe(true);
    expect(problems).toContain('/data-api/ghosts.json matches no file');
    expect(problems).toContain('/data-api/credits.json has no path in the description');
  });

  it('is a valid OpenAPI 3.1 document', async () => {
    const validator = new Validator();
    // The validator resolves internal references only; the disagreement test proves the external ones.
    const document = JSON.parse(
      JSON.stringify(openApiDocument()).replaceAll(/\{"\$ref":"https:[^"]*"\}/gu, '{}'),
    ) as Record<string, unknown>;
    const result = await validator.validate(document);
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(validator.version).toBe('3.1');
  });

  it('gives each path a GET and a HEAD with a 200 and a 404', () => {
    const { paths } = openApiDocument() as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(Object.keys(paths).length).toBe(14);
    for (const [path, item] of Object.entries(paths)) {
      expect(Object.keys(item).sort(), path).toEqual(['get', 'head']);
      for (const operation of Object.values(item)) {
        expect(Object.keys(operation.responses).sort(), path).toEqual(['200', '404']);
      }
    }
  });
});
