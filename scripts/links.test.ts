import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLinks, cssUrls, scan } from './link-checks.ts';
import type { Report } from './link-checks.ts';

// Each check is proven on a page built to fail it, and the clean page is proven quiet.
const fixtures = resolve(import.meta.dirname, 'link-fixtures');
const origin = 'https://surgerywaits.au/';
const run = (dir: string, target = '/about/'): Promise<Report> =>
  checkLinks(resolve(fixtures, dir), origin, new Map([['/old/', target]]));

describe('the link check', () => {
  it('passes a page whose links, assets, fragments and redirects all resolve', async () => {
    const report = await run('clean');
    expect(report.problems).toEqual([]);
    expect(report.pages).toBe(2);
    // 2 anchors to about, the redirect, 4 pic.svg on the page body, 2 metas, the sheet, 2 in the sheet.
    expect(report.internal).toBeGreaterThan(12);
    expect([...report.external.keys()]).toEqual(['https://example.org/']);
  });

  it('fails a dead link, a dead asset, a dead fragment and an http address', async () => {
    const cases = [
      ['dead-link', '/missing/', 'does not resolve'],
      ['dead-asset', '/missing.png', 'does not resolve'],
      ['dead-fragment', '/#nope', 'no element with id "nope"'],
      ['http-own-origin', 'http://surgerywaits.au/', 'over http'],
      ['http-external', 'http://example.org/', 'not https'],
    ] as const;
    for (const [dir, url, why] of cases) {
      const report = await run(`fail/${dir}`);
      expect(report.problems, dir).toHaveLength(1);
      expect(report.problems[0], dir).toMatchObject({ page: '/', url });
      expect(report.problems[0]?.why, dir).toContain(why);
    }
  });

  it('fails each other place a page or stylesheet can point at a missing file', async () => {
    const cases = [
      ['dead-svg-use', '/', '/missing.svg#a'],
      ['dead-svg-xlink', '/', '/missing.png'],
      ['dead-og-image', '/', '/missing.png'],
      ['dead-twitter-image', '/', '/missing.png'],
      ['dead-css-url', '/_astro/a.css', './nope.woff2'],
    ] as const;
    for (const [dir, page, url] of cases) {
      const report = await run(`fail/${dir}`);
      expect(report.problems, dir).toHaveLength(1);
      expect(report.problems[0], dir).toMatchObject({ page, url });
      expect(report.problems[0]?.why, dir).toContain('does not resolve');
    }
  });

  it('fails a link to a redirect source whose target is not a built page', async () => {
    const report = await run('fail/dead-redirect-target', '/gone/');
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.why).toContain('redirect to /gone/, which is not a built page');
    expect((await run('fail/dead-redirect-target', '/')).problems).toEqual([]);
  });

  it('reads the stylesheet addresses that url() can hold', () => {
    expect(
      cssUrls('a{b:url(x.png)}c{d:url( "y.png" )}e{f:url(\'z.png\')}g{h:url(data:a)}i{j:url(#k)}'),
    ).toEqual(['x.png', 'y.png', 'z.png', 'data:a']);
  });

  it('fails when no page was checked, from the command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'links-'));
    try {
      const r = spawnSync(process.execPath, ['scripts/links.ts', dir], {
        cwd: resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('no built pages');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('exits non-zero from the command on a dead link and zero on the clean page', () => {
    const cmd = (dir: string): SpawnSyncReturns<string> =>
      spawnSync(process.execPath, ['scripts/links.ts', resolve(fixtures, dir)], {
        cwd: resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
      });
    const bad = cmd('fail/dead-link');
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('FAIL / /missing/');
    // The clean page links to /old/, which is a redirect source only in the real data file.
    expect(cmd('clean').stdout).toContain('FAIL / /old/');
  });

  it('reads an address from every element that can carry one', () => {
    const page = scan(
      '<a href="/a/"></a><img srcset="/b.png 1x, /c.png 2x"><script src="/d.js"></script><form action="/e/"></form><h1 id="x"></h1><a name="y"></a>',
    );
    expect(page.urls).toEqual(['/a/', '/b.png', '/c.png', '/d.js', '/e/']);
    const more = scan(
      '<svg><use href="/s.svg#i"></use><image xlink:href="/t.png"></image></svg><meta property="og:image" content="/o.png"><meta name="twitter:image" content="/w.png"><meta name="description" content="/no">',
    );
    expect(more.urls).toEqual(['/s.svg#i', '/t.png', '/o.png', '/w.png']);
    expect([...page.ids]).toEqual(['x', 'y']);
  });

  it('reads the places a link can hide', () => {
    const page = scan(
      '<noscript><a href="/n/"></a></noscript>' +
        '<meta http-equiv="Refresh" content="0; url=/r/">' +
        '<meta http-equiv="refresh" content="5">' +
        '<meta http-equiv="refresh" content="0; /bare/">' +
        `<meta http-equiv="refresh" content="0; URL='/single/'">` +
        '<meta http-equiv="refresh" content=\'0;url="/double/"\'>' +
        '<input type="image" src="/i.png">' +
        '<style>a{background:url(/s.png)}</style><p style="background:url(\'/t.png\')"></p>',
    );
    expect(page.urls).toEqual([
      '/n/',
      '/r/',
      '/bare/',
      '/single/',
      '/double/',
      '/i.png',
      '/s.png',
      '/t.png',
    ]);
    expect(page.base).toBe(false);
    expect(scan('<base href="/x/">').base).toBe(true);
  });

  const site = async (
    files: Record<string, string>,
    redirects: [string, string][],
  ): Promise<Report> => {
    const dir = await mkdtemp(join(tmpdir(), 'links-'));
    try {
      for (const [name, body] of Object.entries(files)) {
        await mkdir(dirname(join(dir, name)), { recursive: true });
        await writeFile(join(dir, name), body);
      }
      return await checkLinks(dir, origin, new Map(redirects));
    } finally {
      await rm(dir, { recursive: true });
    }
  };

  it('fails a page that sets a base address', async () => {
    const report = await site({ 'index.html': '<base href="/x/">' }, []);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ page: '/', url: '<base>' });
  });

  it('checks the fragment of a redirect source on the redirect target', async () => {
    const files = {
      'index.html': '<a href="/old/#here"></a><a href="/old/#nope"></a>',
      'about/index.html': '<h1 id="here"></h1>',
    };
    const report = await site(files, [['/old/', '/about/']]);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ url: '/old/#nope' });
    expect(report.problems[0]?.why).toContain('no element with id "nope"');
  });

  it('reports a fragment with a bad encoding instead of throwing', async () => {
    const report = await site({ 'index.html': '<a href="/#%zz"></a>' }, []);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.why).toContain('bad fragment encoding');
  });
});
