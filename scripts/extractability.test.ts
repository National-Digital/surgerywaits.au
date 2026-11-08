import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  choosePages,
  judge,
  mainRuns,
  measurePage,
  normalise,
  pageFields,
  unmatched,
} from './extract-checks.ts';
import type { Config, PageResult } from './extract-checks.ts';

const config: Config = {
  minWords: 3,
  samplePerTemplate: 2,
  chrome: ['nav', '[hidden]'],
  templates: [
    { name: 'home', floor: 95, pageFloor: 90, path: '/' },
    { name: 'pair', floor: 90, pageFloor: 80, path: '/hospital/*/*/', optional: true },
    { name: 'later', floor: 95, pageFloor: 90, path: '/later/', optional: true },
    { name: 'soon', floor: 95, pageFloor: 90, path: '/soon/', optional: true, pending: true },
  ],
  requiredFields: { home: ['h1'] },
  fieldExceptions: [],
};
const doc = (html: string): Document => new JSDOM(html).window.document;
const result = (over: Partial<PageResult>): PageResult => ({
  path: '/',
  template: 'home',
  words: 100,
  kept: { trafilatura: 100, readability: 100 },
  fields: ['h1'],
  drops: [],
  ...over,
});

describe('the extractability measure', () => {
  it('folds case, quotes and punctuation', () => {
    expect(normalise('Median 12.5 days,’ Māori-led')).toBe('median 12 5 days' + ' māori led');
  });

  it('takes runs of three words or more from main, outside the chrome selectors', () => {
    const { runs } = mainRuns(
      doc(
        '<nav>not counted here</nav><main><nav>crumbs are not counted</nav><p>one two three<b>four</b></p><p>two words</p><p hidden>hidden words are not counted</p><script>var a = 1 + 2 + 3</script></main><p>outside main text</p>',
      ),
      config.chrome,
      3,
    ) ?? { runs: [] };
    expect(runs.map((r) => r.norm)).toEqual(['one two three']);
  });

  it('reads the fields a page renders', () => {
    const fields = pageFields(
      doc(
        '<main><nav><p>crumbs</p></nav><h1>Title</h1><p>The lede.</p><figure><figcaption>Chart<small>2024, released 1 May 2026</small></figcaption></figure><table><tbody><tr><th scope="row">Row one</th></tr></tbody></table></main>',
      ),
      config.chrome,
    );
    expect(fields.map((f) => f.field)).toEqual([
      'h1',
      'lede',
      'release date',
      'chart caption',
      'table row',
    ]);
    expect(fields.find((f) => f.field === 'lede')?.text).toBe('The lede.');
  });

  it('counts the H1 as kept by Readability only when its text holds it', () => {
    const html = '<main><h1>Page not found</h1><p>This page is not here today.</p></main>';
    const at = (readability: string): PageResult['drops'] =>
      measurePage(
        html,
        '/',
        'home',
        { trafilatura: 'page not found this page is not here today', readability },
        config,
      ).drops;
    expect(at('page not found this page is not here today')).toEqual([]);
    expect(at('this page is not here today').map((d) => d.field)).toEqual(['h1']);
  });

  it('matches whole words, so a short field is not found inside a longer word', () => {
    const html = '<main><h1>Art</h1><p>one two three</p></main>';
    const drops = measurePage(
      html,
      '/',
      'home',
      { trafilatura: 'start one two three', readability: 'art one two three' },
      config,
    ).drops;
    expect(drops.map((d) => d.extractor)).toEqual(['trafilatura']);
  });

  it('keeps a word only where its run appears whole in the output', () => {
    const page = measurePage(
      '<main><h1>Waiting times</h1><p>one two three</p><p>four five six</p></main>',
      '/',
      'home',
      { trafilatura: 'waiting times one two three', readability: '' },
      config,
    );
    expect(page.words).toBe(6);
    expect(page.kept).toEqual({ trafilatura: 3, readability: 0 });
  });

  it('fails a template under its floor and a page missing a required field', () => {
    const low = judge([result({ kept: { trafilatura: 94, readability: 100 } })], config);
    expect(low.failures.join('\n')).toContain('trafilatura 2.3.1 keeps 94.0%');
    const bare = judge([result({ fields: [] })], config);
    expect(bare.failures).toEqual(['/: renders no h1']);
    expect(judge([result({ words: 0 })], config).failures[0]).toContain('no <main> text');
  });

  it('lets a template whose pages are not built yet pass, and holds it once they are', () => {
    expect(judge([result({})], config).rows.map((r) => r.name)).toEqual(['home']);
    const built = judge(
      [
        result({}),
        result({ template: 'later', path: '/later/', kept: { trafilatura: 50, readability: 50 } }),
      ],
      config,
    );
    expect(built.failures.length).toBe(4);
  });

  it('under strict, fails a stale exception and an optional template with no pages', () => {
    const stale: Config = {
      ...config,
      fieldExceptions: [
        { template: 'home', field: 'lede', extractor: 'readability', reason: 'Stale.' },
      ],
    };
    expect(judge([result({})], stale).failures).toEqual([]);
    const strict = judge([result({})], stale, true).failures;
    expect(strict).toHaveLength(3);
    expect(strict.join('\n')).toContain('delete the exception');
    expect(strict.join('\n')).toContain('pair: no pages built, and strict requires them');
    expect(strict.join('\n')).toContain('later: no pages built');
    expect(strict.join('\n')).not.toContain('soon');
  });

  it('under strict, ignores an exception that holds on the fixture build only', () => {
    const drop = { field: 'h1', extractor: 'readability' as const, text: 'Title' };
    const fixtureOnly: Config = {
      ...config,
      fieldExceptions: [
        { template: 'home', field: 'h1', extractor: 'readability', fixtureOnly: true, reason: 'x' },
      ],
    };
    expect(judge([result({ drops: [drop] })], fixtureOnly).failures).toEqual([]);
    const strict = judge([result({ drops: [drop] })], fixtureOnly, true).failures;
    expect(strict.filter((f) => f.includes('drops the h1'))).toHaveLength(1);
    expect(strict.join('\n')).not.toContain('delete the exception');
  });

  it('fails a sampled page with no measured words unless the template allows it', () => {
    const pages = [
      result({}),
      result({ path: '/empty', words: 0, kept: { trafilatura: 0, readability: 0 } }),
    ];
    expect(judge(pages, config).failures).toEqual(['/empty: no <main> text measured']);
    const allowed: Config = {
      ...config,
      templates: [{ name: 'home', floor: 95, pageFloor: 90, path: '/', emptyOk: true }],
    };
    expect(judge(pages, allowed).failures).toEqual([]);
  });

  it('fails an exception that covers more pages than its limit', () => {
    const drop = { field: 'h1', extractor: 'readability' as const, text: 'Title' };
    const limited: Config = {
      ...config,
      fieldExceptions: [
        { template: 'home', field: 'h1', extractor: 'readability', maxPages: 1, reason: 'Why.' },
      ],
    };
    const one = judge([result({ drops: [drop] })], limited);
    expect(one.failures).toEqual([]);
    expect(one.excepted[0]).toContain('1 of at most 1 sampled page(s), such as /');
    const two = judge([result({ drops: [drop] }), result({ path: '/b', drops: [drop] })], limited);
    expect(two.failures).toEqual([
      'home: the h1 exception for Readability 0.6.0 covers 2 pages, over its limit of 1',
    ]);
  });

  it('allows a named drop and reports an exception that no longer applies', () => {
    const drop = { field: 'h1', extractor: 'readability' as const, text: 'Title' };
    const withException: Config = {
      ...config,
      fieldExceptions: [
        { template: 'home', field: 'h1', extractor: 'readability', reason: 'Why.' },
        { template: 'home', field: 'lede', extractor: 'readability', reason: 'Stale.' },
      ],
    };
    const report = judge([result({ drops: [drop] })], withException);
    expect(report.failures).toEqual([]);
    expect(report.excepted).toHaveLength(1);
    expect(report.stale).toHaveLength(1);
    expect(judge([result({ drops: [drop] })], config).failures).toHaveLength(1);
  });

  it('fails a page under its template page floor even when the template passes', () => {
    const report = judge(
      [
        result({ path: '/a', words: 100, kept: { trafilatura: 100, readability: 100 } }),
        result({ path: '/b', words: 100, kept: { trafilatura: 100, readability: 89 } }),
        result({ path: '/c', words: 1000, kept: { trafilatura: 1000, readability: 1000 } }),
      ],
      config,
    );
    expect(report.failures).toEqual([
      '/b: Readability 0.6.0 keeps 89.0% of <main> words, under the 90% page floor',
    ]);
  });

  it('samples evenly, always including the first and last page, and fails a page that no template names', () => {
    const paths = [
      '/',
      '/hospital/a/b/',
      '/hospital/a/c/',
      '/hospital/a/d/',
      '/hospital/a/e/',
      '/new/',
    ];
    expect(choosePages(config, paths)).toEqual([
      { path: '/', template: 'home' },
      { path: '/hospital/a/b/', template: 'pair' },
      { path: '/hospital/a/d/', template: 'pair' },
      { path: '/hospital/a/e/', template: 'pair' },
    ]);
    expect(unmatched(config, paths)).toEqual(['/new/']);
  });
});

// The end-to-end gate needs uv and the pipeline's locked environment, so only the jobs that sync it
// run these, with EXTRACT_TEST=1. Each fixture is one home page held to a floor of 95.
const root = resolve(import.meta.dirname, '..');
const check = (
  dir: string,
  extra: NodeJS.ProcessEnv = {},
  flags: string[] = [],
): SpawnSyncReturns<string> =>
  spawnSync(
    process.execPath,
    ['scripts/extractability.ts', resolve(import.meta.dirname, 'extract-fixtures', dir), ...flags],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXTRACT_TEST: '1',
        EXTRACT_CONFIG: resolve(import.meta.dirname, 'extract-fixtures', 'config.json'),
        ...extra,
      },
    },
  );

describe.skipIf(process.env['EXTRACT_TEST'] !== '1')('the extractability gate', () => {
  it('passes a page whose main text both extractors recover', () => {
    const r = check('clean');
    expect(r.stdout).toContain('passed');
    expect(r.status).toBe(0);
  });

  it('passes the clean page under strict', () => {
    expect(check('clean', {}, ['--strict']).status).toBe(0);
  });

  it('exits 2 when the helper fails, and never reads that as a pass', () => {
    const r = check('clean', { EXTRACT_HELPER: 'false' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('could not run');
    expect(r.stdout).not.toContain('passed');
  });

  it('exits 2 when there is no built site', () => {
    expect(check('no-such-dir').status).toBe(2);
  });

  it('fails a page whose main text sits inside an aside, which trafilatura drops', () => {
    const r = check('fail-aside');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/home: (trafilatura|Readability)/);
  });

  it('fails a page whose main text is written by a script', () => {
    const r = check('fail-script-rendered');
    expect(r.status).toBe(1);
  });

  it('fails a page with no main element', () => {
    const r = check('fail-no-main');
    expect(r.status).not.toBe(0);
  });
});
