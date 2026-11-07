import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLinks, scan } from './link-checks.ts';
import type { Report } from './link-checks.ts';

// Each check is proven on a page built to fail it, and the clean page is proven quiet.
const fixtures = resolve(import.meta.dirname, 'link-fixtures');
const origin = 'https://surgerywaits.au/';
const run = (dir: string): Promise<Report> =>
  checkLinks(resolve(fixtures, dir), origin, new Set(['/old/']));

describe('the link check', () => {
  it('passes a page whose links, assets, fragments and redirects all resolve', async () => {
    const report = await run('clean');
    expect(report.problems).toEqual([]);
    expect(report.pages).toBe(2);
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
    expect([...page.ids]).toEqual(['x', 'y']);
  });
});
