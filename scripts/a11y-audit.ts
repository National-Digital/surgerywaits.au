// Serves a directory of built HTML and audits one page: axe at WCAG 2.2 AAA, then the house checks.
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import type { AxeResults, RunOptions } from 'axe-core';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { HOUSE, TEXT_SPACING, exceptionsFor, house, paintedContrast } from './a11y-checks.ts';
import type { Exception, Found, Mode } from './a11y-checks.ts';

const require = createRequire(import.meta.url);
const TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag2aaa',
  'wcag21a',
  'wcag21aa',
  'wcag21aaa',
  'wcag22aa',
  'best-practice',
  'experimental',
];
// hidden-content only asks a person to look at what is hidden, so it can never pass.
const RULES = { 'hidden-content': { enabled: false } };
const CONTRAST = new Set(['color-contrast', 'color-contrast-enhanced']);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export type Scheme = 'light' | 'dark';
export interface Viewport {
  name: string;
  width: number;
  height: number;
}
export const VIEWPORTS: Viewport[] = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
export const SCHEMES: Scheme[] = ['light', 'dark'];

export interface Finding {
  rule: string;
  lines: string[];
}

export interface Proof {
  check: string;
  rule: string;
  fixture: string;
  schemes?: Scheme[];
}

// Each check and the fixture page built to fail it. The rule is what the finding is named.
export const PROOF: Proof[] = [
  {
    check: 'axe',
    rule: 'axe:color-contrast-enhanced',
    fixture: 'fail/axe.html',
    schemes: ['light', 'dark'],
  },
  { check: 'painted contrast', rule: 'painted-contrast', fixture: 'fail/painted-contrast.html' },
  { check: 'root scale', rule: 'root-scale', fixture: 'fail/root-scale.html' },
  { check: 'type size', rule: 'type-floor', fixture: 'fail/type-floor.html' },
  { check: 'line length', rule: 'measure', fixture: 'fail/measure.html' },
  { check: 'target size', rule: 'target-size', fixture: 'fail/target-size.html' },
  {
    check: 'link names, generic',
    rule: 'link-name-generic',
    fixture: 'fail/link-name-generic.html',
  },
  {
    check: 'link names, missing',
    rule: 'link-name-missing',
    fixture: 'fail/link-name-missing.html',
  },
  { check: 'focus visible', rule: 'focus-visible', fixture: 'fail/focus-visible.html' },
  { check: 'reflow', rule: 'reflow', fixture: 'fail/reflow.html' },
  { check: 'text spacing cut off', rule: 'text-spacing-cut', fixture: 'fail/text-spacing.html' },
  {
    check: 'text spacing scroll',
    rule: 'text-spacing-scroll',
    fixture: 'fail/text-spacing-scroll.html',
  },
  { check: 'menu state', rule: 'menu-expanded', fixture: 'fail/menu-expanded.html' },
  { check: 'menu opens', rule: 'menu-shows', fixture: 'fail/menu-shows.html' },
  { check: 'menu closes on Escape', rule: 'menu-escape', fixture: 'fail/menu-escape.html' },
  {
    check: 'menu hides on Escape',
    rule: 'menu-escape-visible',
    fixture: 'fail/menu-escape-visible.html',
  },
  {
    check: 'menu returns focus',
    rule: 'menu-focus-return',
    fixture: 'fail/menu-focus-return.html',
  },
  { check: 'menu without script', rule: 'menu-nojs', fixture: 'fail/menu-nojs.html' },
  {
    check: 'target size in the open menu',
    rule: 'target-size',
    fixture: 'fail/menu-target-size.html',
  },
];
export const CLEAN_FIXTURE = 'pass/clean.html';

export interface Served {
  base: string;
  close: () => void;
}

export async function serve(root: string): Promise<Served> {
  const base = normalize(root);
  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      let p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      if (p.endsWith('/')) {
        p += 'index.html';
      }
      const file = normalize(join(base, p));
      try {
        if (!file.startsWith(base)) {
          throw new Error('outside');
        }
        if ((await stat(file)).isDirectory()) {
          res.writeHead(301, { location: p + '/' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(await readFile(file));
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    })();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: (): void => {
      server.close();
    },
  };
}

export const launch = (): Promise<Browser> => chromium.launch();

const settle = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((r) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            r();
          });
        });
      }),
  );

const run = (page: Page, mode: Mode): Promise<Found[]> =>
  page.evaluate(house, { cfg: HOUSE, mode });

const MENU = 'header button[aria-controls][aria-expanded]';

async function menuRuns(page: Page): Promise<Found[][]> {
  const toggle = await page.$$eval(MENU, (bs) =>
    bs.findIndex((b) => b.getBoundingClientRect().width > 0),
  );
  if (toggle < 0) {
    return [];
  }
  const runs: Found[][] = [];
  await page.locator(MENU).nth(toggle).focus();
  await page.keyboard.press('Enter');
  await settle(page);
  runs.push(await run(page, 'menu-open'));
  await page.evaluate((s) => {
    const b = [...document.querySelectorAll<HTMLElement>(s)].find(
      (x) => x.getBoundingClientRect().width > 0,
    );
    if (!b) {
      return;
    }
    const first = document
      .getElementById(b.getAttribute('aria-controls') ?? '')
      ?.querySelector<HTMLElement>('a[href], button');
    (first ?? b).focus();
  }, MENU);
  await page.keyboard.press('Escape');
  await settle(page);
  runs.push(await run(page, 'menu-closed'));
  return runs;
}

async function noScriptRun(
  browser: Browser,
  url: string,
  scheme: Scheme,
  vp: Viewport,
): Promise<Found[]> {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    colorScheme: scheme,
    viewport: vp,
  });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    return await run(page, 'menu-nojs');
  } finally {
    await context.close();
  }
}

export interface AuditArgs {
  browser: Browser;
  base: string;
  path: string;
  scheme: Scheme;
  viewport: Viewport;
  exceptions: Exception[];
  used: Set<Exception>;
}

interface AxeGlobal {
  axe: { run: (ctx: Document, opts: RunOptions) => Promise<AxeResults> };
}

// Returns the findings for one page at one viewport in one colour scheme. The house checks run
// at the working width, at 2560px (the type must grow) and, on the narrow viewport, at 320px.
// `used` collects the exceptions that matched.
export async function auditPage(a: AuditArgs): Promise<Finding[]> {
  const { browser, base, path, scheme, viewport, exceptions, used } = a;
  const context = await browser.newContext({ colorScheme: scheme, viewport });
  const findings: Finding[] = [];
  try {
    const page = await context.newPage();
    const resp = await page.goto(base + path, { waitUntil: 'networkidle', timeout: 60000 });
    if (resp?.status() !== 200) {
      return [{ rule: 'http', lines: [`HTTP ${String(resp?.status() ?? 'none')}`] }];
    }
    await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
    const result = await page.evaluate(
      ({ tags, rules }) =>
        (globalThis as unknown as AxeGlobal).axe.run(document, {
          runOnly: { type: 'tag', values: tags },
          rules,
        }),
      { tags: TAGS, rules: RULES },
    );
    for (const v of result.violations) {
      const lines = [`[${v.impact ?? 'unknown'}] ${v.help}`];
      for (const n of v.nodes.slice(0, 5)) {
        lines.push(
          `${n.target.join(' ')}: ${(n.failureSummary ?? '').split('\n').join(' ').slice(0, 300)}`,
        );
      }
      findings.push({ rule: `axe:${v.id}`, lines });
    }
    // A result axe leaves for review fails unless a painted measurement settles it or an exception covers it.
    const contrast = new Set<string>();
    const reviews: { rule: string; target: string; detail: string }[] = [];
    for (const v of result.incomplete) {
      for (const n of v.nodes) {
        if (CONTRAST.has(v.id)) {
          contrast.add(n.target.join(' '));
        } else {
          const check = n.any[0] ?? n.all[0] ?? n.none[0];
          reviews.push({
            rule: v.id,
            target: n.target.join(' '),
            detail: check?.message ?? v.help,
          });
        }
      }
    }
    for (const f of await paintedContrast(page, [...contrast])) {
      reviews.push({
        rule: 'painted-contrast',
        target: f.target,
        detail:
          f.ratio === null
            ? 'no glyph could be measured'
            : `${f.ratio.toFixed(2)}:1 against the background painted behind it, needs ${String(f.need)}:1`,
      });
    }
    for (const r of reviews) {
      let covered: Exception | null = null;
      for (const e of exceptionsFor(exceptions, path, r.rule)) {
        const within = await page.evaluate(({ t, w }) => !!document.querySelector(t)?.closest(w), {
          t: r.target,
          w: e.within,
        });
        if (within) {
          covered = e;
        }
      }
      if (covered) {
        used.add(covered);
      } else {
        findings.push({ rule: r.rule, lines: [`${r.target}: ${r.detail}`] });
      }
    }

    const runs: Found[][] = [await run(page, 'all'), await run(page, 'reflow')];
    await page.setViewportSize({ width: HOUSE.wideWidth, height: 1440 });
    await settle(page);
    runs.push(await run(page, 'type'));
    if (viewport.width < 600) {
      await page.setViewportSize({ width: HOUSE.reflowWidth, height: viewport.height });
      await settle(page);
      runs.push(await run(page, 'reflow'), await run(page, 'all'));
    }
    await page.setViewportSize(viewport);
    await settle(page);
    runs.push(...(await menuRuns(page)));
    await page.addStyleTag({ content: TEXT_SPACING });
    await settle(page);
    runs.push(
      await run(page, 'spacing'),
      await noScriptRun(browser, base + path, scheme, viewport),
    );
    const byRule = new Map<string, Found[]>();
    for (const f of runs.flat()) {
      byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
    }
    for (const [rule, fs] of byRule) {
      findings.push({ rule, lines: fs.slice(0, 8).map((f) => `${f.target}: ${f.detail}`) });
    }
    return findings;
  } finally {
    await context.close();
  }
}
