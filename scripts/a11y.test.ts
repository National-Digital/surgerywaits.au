import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import {
  CLEAN_FIXTURE,
  PROOF,
  SCHEMES,
  VIEWPORTS,
  auditPage,
  launch,
  serve,
} from './a11y-audit.ts';
import type { Served } from './a11y-audit.ts';
import {
  HOUSE,
  TEXT_SPACING,
  exceptionsFor,
  house,
  paintedContrast,
  unusedExceptions,
} from './a11y-checks.ts';
import type { Found, Mode } from './a11y-checks.ts';

// Each check is proven on a page built to fail it, and the house rules are proven quiet on pages
// without the defect. The browser is Playwright's Chromium, installed with `npx playwright install chromium`.
const root = resolve(import.meta.dirname, 'a11y-fixtures');
const T = 120000;
// Locally the proofs skip without the browser; in CI a missing browser fails them.
const skip = !existsSync(chromium.executablePath()) && process.env['CI'] === undefined;
const browsers = describe.skipIf(skip);

let browser: Browser | undefined;
let server: Served | undefined;
const up = <T>(v: T | undefined): T => {
  if (v === undefined) {
    throw new Error('the browser did not start');
  }
  return v;
};
beforeAll(async () => {
  if (skip) {
    return;
  }
  server = await serve(root);
  browser = await launch();
}, T);
afterAll(async () => {
  if (skip) {
    return;
  }
  await browser?.close();
  server?.close();
});

browsers('each check fires on the fixture built to fail it', () => {
  it(
    'each accessibility check is proven to fire on a page built to fail it',
    async () => {
      const silent: string[] = [];
      for (const p of PROOF) {
        const seen: string[] = [];
        for (const scheme of p.schemes ?? SCHEMES) {
          for (const viewport of VIEWPORTS) {
            const findings = await auditPage({
              browser: up(browser),
              base: up(server).base,
              path: `/${p.fixture}`,
              scheme,
              viewport,
              exceptions: [],
              used: new Set(),
            });
            seen.push(...findings.map((f) => f.rule));
          }
        }
        if (!seen.includes(p.rule)) {
          silent.push(`${p.check} on ${p.fixture}`);
        }
      }
      expect(silent).toEqual([]);
    },
    T * PROOF.length,
  );

  it(
    'measures SVG text at its painted size',
    async () => {
      const findings = await auditPage({
        browser: up(browser),
        base: up(server).base,
        path: '/fail/type-floor-svg.html',
        scheme: 'light',
        viewport: { name: 'desktop', width: 1280, height: 900 },
        exceptions: [],
        used: new Set(),
      });
      const found = findings.find((f) => f.rule === 'type-floor');
      expect(found?.lines.join(' ')).toMatch(/6\.\d+px/);
    },
    T,
  );

  it('names a fixture file for every check, and one rule for each fixture', () => {
    for (const p of PROOF) {
      expect(existsSync(resolve(root, p.fixture)), p.fixture).toBe(true);
    }
    expect(new Set(PROOF.map((p) => p.fixture)).size).toBe(PROOF.length);
  });

  for (const scheme of SCHEMES) {
    for (const viewport of VIEWPORTS) {
      it(
        `the passing fixture is clean in ${scheme} at ${viewport.name} width`,
        async () => {
          const findings = await auditPage({
            browser: up(browser),
            base: up(server).base,
            path: `/${CLEAN_FIXTURE}`,
            scheme,
            viewport,
            exceptions: [],
            used: new Set(),
          });
          expect(findings).toEqual([]);
        },
        T,
      );
    }
  }
});

const BASE = `<!doctype html><html lang="en-AU"><meta charset="utf-8"><title>t</title><style>
html{font-size:clamp(100%,.75rem + .35vw,125%)}body{margin:0;font:1rem/1.55 Arial,sans-serif}button{font:inherit}
.site{max-width:70rem;padding:1rem}p{max-width:65ch}:focus-visible{outline:2px solid #00f;outline-offset:2px}
a.big,button{display:inline-flex;min-height:2.75rem;min-width:2.75rem;align-items:center;padding:0 1rem}
</style><body><div class="site"><main>`;
const END = `</main></div>`;
const LONG = 'Waiting '.repeat(60).trim();

interface Opts {
  width?: number;
  nojs?: boolean;
  keys?: string[];
}

async function check(html: string, mode: Mode, opts: Opts = {}): Promise<Found[]> {
  const context = await up(browser).newContext({
    viewport: { width: opts.width ?? 1280, height: 900 },
    javaScriptEnabled: opts.nojs !== true,
  });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    if (mode === 'spacing') {
      await page.addStyleTag({ content: TEXT_SPACING });
    }
    if (mode === 'menu-open' || mode === 'menu-closed') {
      await page.focus('header button');
      await page.keyboard.press('Enter');
    }
    if (mode === 'menu-closed') {
      await page.focus('nav a');
      await page.keyboard.press('Escape');
    }
    return await page.evaluate(house, { cfg: HOUSE, mode });
  } finally {
    await context.close();
  }
}
const rules = (found: Found[]): string[] => [...new Set(found.map((f) => f.rule))].sort();

browsers('the house checks', () => {
  it('raise nothing on a clean page at any width', { timeout: T }, async () => {
    const html = `${BASE}<h1>Title</h1><p>${LONG}</p><p><a href="/x">Where this goes</a> in a sentence.</p><a class="big" href="/y">A big enough link</a><button type="button">Act</button>${END}`;
    expect(await check(html, 'all')).toEqual([]);
    expect(await check(html, 'type', { width: HOUSE.wideWidth })).toEqual([]);
    expect(await check(html, 'reflow', { width: HOUSE.reflowWidth })).toEqual([]);
    expect(await check(html, 'spacing')).toEqual([]);
  });

  it(
    'type under the floor finds exactly two nodes, and a data region is held to the AA floor',
    { timeout: T },
    async () => {
      const bad = await check(
        `${BASE}<p style="font-size:.8rem">${LONG}</p><span style="font-size:.7rem">tiny label</span>${END}`,
        'all',
      );
      expect(rules(bad)).toEqual(['type-floor']);
      expect(bad).toHaveLength(2);
      const aa = await check(
        `${BASE}<div data-conformance="aa"><table><tr><td style="font-size:.8rem">cell</td></tr></table></div>${END}`,
        'all',
      );
      expect(aa).toEqual([]);
    },
  );

  it('flag type that does not grow with the screen', { timeout: T }, async () => {
    const fixed = `${BASE.replace('html{font-size:clamp(100%,.75rem + .35vw,125%)}', 'html{font-size:16px}')}<p>${LONG}</p>${END}`;
    expect(rules(await check(fixed, 'type', { width: HOUSE.wideWidth }))).toEqual(['root-scale']);
  });

  it('flag a line over 80 characters', { timeout: T }, async () => {
    const found = await check(`${BASE}<p style="max-width:none">${LONG}</p>${END}`, 'all');
    expect(rules(found)).toEqual(['measure']);
  });

  it(
    'hold targets to 44px, to 24px in a data region, and exempt links inside text',
    { timeout: T },
    async () => {
      const found = await check(
        `${BASE}<div><a href="/a" style="display:inline-block;padding:2px">Pill</a><a href="/b" style="display:inline-block;padding:2px">Pill</a></div>
     <div data-conformance="aa"><div><a href="/c" style="display:inline-block;padding:0;line-height:1">Tiny</a><a href="/d" style="display:inline-block;padding:4px 8px;line-height:1.2">Fine</a></div></div>
     <p>A sentence with <a href="/e">an inline link</a> in it.</p>${END}`,
        'all',
      );
      const targets = found.filter((f) => f.rule === 'target-size');
      expect(targets, JSON.stringify(found)).toHaveLength(3);
      expect(targets.some((f) => f.detail.includes('(AA region)'))).toBe(true);
    },
  );

  it('measure a checkbox by its label', { timeout: T }, async () => {
    const ok = await check(
      `${BASE}<label style="display:inline-flex;min-height:2.75rem;min-width:8rem;align-items:center"><input type="checkbox"> Only public hospitals</label>${END}`,
      'all',
    );
    expect(ok).toEqual([]);
    const bad = await check(
      `${BASE}<input type="checkbox" id="c"><label for="c" style="display:inline-block;line-height:1">Open</label>${END}`,
      'all',
    );
    expect(rules(bad)).toEqual(['target-size']);
  });

  it(
    'fail a link whose name says nothing and pass an aria-label that names the target',
    { timeout: T },
    async () => {
      const bad = await check(
        `${BASE}<a class="big" href="/x">Details</a><a class="big" href="/y">Download</a><a class="big" href="/z"><img src="" alt=""></a>${END}`,
        'all',
      );
      expect(rules(bad)).toEqual(['link-name-generic', 'link-name-missing']);
      expect(bad).toHaveLength(3);
      const ok = await check(
        `${BASE}<a class="big" href="/x" aria-label="Details, Royal Hospital">Details</a>${END}`,
        'all',
      );
      expect(ok).toEqual([]);
    },
  );

  it('fail a focus style that is removed', { timeout: T }, async () => {
    const found = await check(
      `${BASE}<button type="button" style="outline:none">Act</button>${END}`,
      'all',
    );
    expect(rules(found)).toEqual(['focus-visible']);
  });

  it('fail content wider than 320px', { timeout: T }, async () => {
    const found = await check(
      `${BASE}<div style="width:600px;height:10px;background:#ccc"></div>${END}`,
      'reflow',
      { width: HOUSE.reflowWidth },
    );
    expect(rules(found)).toEqual(['reflow']);
  });

  it(
    'fail text cut off by the spacing override, but not a data region',
    { timeout: T },
    async () => {
      const cut = `<div style="width:8rem;height:1.2rem;overflow:hidden;white-space:nowrap">${LONG}</div>`;
      expect(rules(await check(`${BASE}${cut}${END}`, 'spacing'))).toEqual(['text-spacing-cut']);
      expect(
        await check(`${BASE}<div data-conformance="aa">${cut}</div>${END}`, 'spacing'),
      ).toEqual([]);
    },
  );

  it('exempt a line clamp from the spacing check', { timeout: T }, async () => {
    const clamp = `<div style="width:8rem;height:2.4rem;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${LONG}</div>`;
    expect(await check(`${BASE}${clamp}${END}`, 'spacing')).toEqual([]);
  });
});

const menuPage = (o: { escape: boolean; links: string; nojs: boolean }): string =>
  `${BASE.replace('</style>', `nav{display:none}header.open nav{display:flex;flex-direction:column}nav a{${o.links}}${o.nojs ? '@media (scripting:none){nav{display:flex}}' : ''}</style>`)}
<header><button type="button" aria-expanded="false" aria-controls="n">Menu</button><nav id="n" aria-label="Site"><a href="/a">Waiting times</a><a href="/b">About</a></nav></header>
<script>var b=document.querySelector("header button"),h=b.parentElement;b.onclick=function(){var on=b.getAttribute("aria-expanded")!=="true";b.setAttribute("aria-expanded",on);h.classList.toggle("open",on)};
${o.escape ? 'h.onkeydown=function(e){if(e.key==="Escape"){b.setAttribute("aria-expanded","false");h.classList.remove("open");b.focus()}};' : ''}</script>${END}`;

browsers('the header menu', () => {
  const narrow = { width: HOUSE.reflowWidth };
  it(
    'passes when it opens to full-size links, closes on Escape and shows its links without script',
    { timeout: T },
    async () => {
      const html = menuPage({
        escape: true,
        links: 'min-height:2.75rem;display:flex;align-items:center',
        nojs: true,
      });
      expect(await check(html, 'menu-open', narrow)).toEqual([]);
      expect(await check(html, 'menu-closed', narrow)).toEqual([]);
      expect(await check(html, 'menu-nojs', { ...narrow, nojs: true })).toEqual([]);
    },
  );

  it(
    'fails with small links, no Escape and nothing without script, each in its own rule',
    { timeout: T },
    async () => {
      const html = menuPage({ escape: false, links: 'display:block;line-height:1', nojs: false });
      expect(rules(await check(html, 'menu-open', narrow))).toEqual(['target-size']);
      const closed = await check(html, 'menu-closed', narrow);
      expect(rules(closed)).toContain('menu-escape');
      expect(closed.some((f) => f.detail.includes('Escape does not close'))).toBe(true);
      expect(rules(await check(html, 'menu-nojs', { ...narrow, nojs: true }))).toEqual([
        'menu-nojs',
      ]);
    },
  );
});

browsers('painted contrast', () => {
  async function painted(html: string, targets: string[]): Promise<{ target: string }[]> {
    const context = await up(browser).newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      return await paintedContrast(page, targets);
    } finally {
      await context.close();
    }
  }

  it(
    "fails where a gradient's worst stop is too light and passes where every stop clears 7:1",
    { timeout: T },
    async () => {
      const html = `${BASE}<div style="padding:1rem;background:linear-gradient(90deg,#000,#000 50%,#888)"><p id="bad" style="color:#fff;max-width:none">${LONG}</p></div>
    <div style="padding:1rem;background:linear-gradient(90deg,#000,#1a1a1a)"><p id="good" style="color:#fff;max-width:none">${LONG}</p></div>${END}`;
      const found = await painted(html, ['#bad', '#good']);
      expect(found.map((f) => f.target)).toEqual(['#bad']);
    },
  );

  it("counts a halo drawn as the text's own stroke as its background", { timeout: T }, async () => {
    const svg = (halo: boolean): string =>
      `<svg width="300" height="60"><rect width="300" height="60" fill="#777"/><text id="t" x="10" y="40" font-size="20" fill="#fff" ${halo ? 'stroke="#000" stroke-width="6" paint-order="stroke"' : ''}>Cairns harbour</text></svg>`;
    expect(await painted(`${BASE}${svg(true)}${END}`, ['#t'])).toEqual([]);
    expect(await painted(`${BASE}${svg(false)}${END}`, ['#t'])).toHaveLength(1);
  });
});

describe('the house settings', () => {
  it('force the WCAG 1.4.12 text spacing and name the generic link words', () => {
    // Line height 1.5, letter spacing 0.12em, word spacing 0.16em and paragraph spacing 2em.
    expect(TEXT_SPACING).toContain('line-height:1.5!important');
    expect(TEXT_SPACING).toContain('letter-spacing:.12em!important');
    expect(TEXT_SPACING).toContain('word-spacing:.16em!important');
    expect(TEXT_SPACING).toContain('p{margin-bottom:2em!important}');
    expect(HOUSE.generic).toEqual(
      expect.arrayContaining(['click here', 'here', 'more', 'read more']),
    );
    expect(HOUSE.maxCharsPerLine).toBe(80);
    expect(HOUSE.reflowWidth).toBe(320);
  });
});

describe('exceptions', () => {
  const ex = [
    {
      pages: '/hospitals/*/',
      rule: 'painted-contrast',
      within: '#chart',
      reason: 'r',
      reviewed: '2026-11-06',
    },
  ];
  it('cover their rule on the pages their pattern names and nowhere else', () => {
    expect(exceptionsFor(ex, '/hospitals/royal/', 'painted-contrast')).toHaveLength(1);
    expect(exceptionsFor(ex, '/hospitals/', 'painted-contrast')).toHaveLength(0);
    expect(exceptionsFor(ex, '/hospitals/a/b/', 'painted-contrast')).toHaveLength(0);
    expect(exceptionsFor(ex, '/hospitals/royal/', 'color-contrast')).toHaveLength(0);
  });
  it('fail when unused', () => {
    expect(unusedExceptions(ex, new Set())).toEqual(ex);
    expect(unusedExceptions(ex, new Set(ex))).toEqual([]);
  });
});

browsers('the runner', () => {
  it(
    'an accessibility exception that no longer matches anything fails the check',
    () => {
      const dir = mkdtempSync(resolve(tmpdir(), 'a11y-dist-'));
      try {
        copyFileSync(resolve(root, CLEAN_FIXTURE), resolve(dir, 'index.html'));
        const file = resolve(dir, 'exceptions.json');
        const run = (entries: unknown[]): ReturnType<typeof spawnSync> => {
          writeFileSync(file, JSON.stringify(entries));
          return spawnSync(process.execPath, [resolve(import.meta.dirname, 'a11y.ts'), dir], {
            env: { ...process.env, A11Y_EXCEPTIONS: file, A11Y_TEST: '1' },
            encoding: 'utf8',
            timeout: T,
          });
        };
        const unused = run([
          {
            pages: '/gone/',
            rule: 'painted-contrast',
            within: '#nothing',
            reason: 'r',
            reviewed: '2026-11-06',
          },
        ]);
        expect(String(unused.stdout)).toContain('matched nothing');
        expect(unused.status).toBe(1);
        expect(run([]).status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    2 * T,
  );
});
