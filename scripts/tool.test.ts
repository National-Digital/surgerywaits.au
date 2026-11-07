import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { launch, serve } from './a11y-audit.ts';
import type { Served } from './a11y-audit.ts';

// Drives the built compare tool in Chromium. It needs `npm run build` first, so only the
// Accessibility job runs it, with TOOL_TEST=1.
const T = 120_000;
const skip = !existsSync(chromium.executablePath()) && process.env['CI'] === undefined;
const browsers = describe.skipIf(skip);
const INPUT = '.js-combo-input';
const OPTION = '[role="option"]';
const RESULTS = '.js-tool-results';

let browser: Browser | undefined;
let server: Served | undefined;
const up = <V>(value: V | undefined): V => {
  if (value === undefined) {
    throw new Error('the browser did not start');
  }
  return value;
};

beforeAll(async () => {
  if (skip) {
    return;
  }
  server = await serve(resolve(import.meta.dirname, '../site/dist'));
  browser = await launch();
}, T);
afterAll(async () => {
  await browser?.close();
  server?.close();
});

async function choose(page: Page, field: number, text: string): Promise<void> {
  const input = page.locator(INPUT).nth(field);
  await input.fill(text);
  await page.locator('.js-tool-field').nth(field).locator(OPTION).first().waitFor();
  await input.press('ArrowDown');
  await input.press('Enter');
}

async function open(page: Page): Promise<void> {
  await page.goto(`${up(server).base}/compare/`);
  await page.locator('.js-tool-form').waitFor();
}

async function compare(page: Page, surgery: string, place: string): Promise<void> {
  await open(page);
  await choose(page, 0, surgery);
  await choose(page, 1, place);
  await page.locator('button[type="submit"]').click();
  await page.locator(`${RESULTS} li`).first().waitFor();
}

browsers('The compare tool', () => {
  it(
    'finds a surgery by an everyday word and lists the nearest hospitals first',
    { timeout: T },
    async () => {
      const page = await up(browser).newPage();
      await compare(page, 'cataracts', 'Armidale');
      const heading = await page.locator(`${RESULTS} h2`).innerText();
      expect(heading).toBe('Cataract surgery near Armidale');
      const names = await page.locator(`${RESULTS} h3`).allInnerTexts();
      expect(names[0]).toContain('Armidale Hospital');
      expect(names.length).toBeLessThanOrEqual(8);
      const text = await page.locator(RESULTS).innerText();
      expect(text).toMatch(/\d+ days?/);
      expect(text).toMatch(/released \d{1,2} \w+ \d{4}/);
      expect(await page.locator('.js-tool-message').innerText()).toContain('are listed below');
      await page.close();
    },
  );

  it(
    'shows a withheld figure as not published and never as 0 or a rank',
    { timeout: T },
    async () => {
      const page = await up(browser).newPage();
      await compare(page, 'acl', 'Armidale');
      const card = page.locator(`${RESULTS} li`, { hasText: 'Armidale Hospital' }).first();
      const text = await card.innerText();
      expect(text).toContain(
        'not published: the Australian Institute of Health and Welfare did not publish a figure',
      );
      expect(text).not.toMatch(/\b0 days\b/);
      expect(text).not.toMatch(/Ranked/);
      await page.close();
    },
  );

  it('gives a figure from an earlier period its period and no rank', { timeout: T }, async () => {
    const page = await up(browser).newPage();
    await page.route('**/tool/data.json', async (route) => {
      const response = await route.fetch();
      const data = (await response.json()) as {
        stamps: [string, string][];
        figures: Record<string, (number | null | number[])[][]>;
        procedures: { slug: string; name: string }[];
      };
      data.stamps.push(['2019–20', '2020-08-19']);
      const slug = data.procedures.find((p) => p.name === 'Knee replacement')?.slug ?? '';
      for (const row of data.figures[slug] ?? []) {
        row[1] = data.stamps.length - 1;
        row[4] = null;
      }
      await route.fulfill({ response, json: data });
    });
    await compare(page, 'knee', 'Armidale');
    const text = await page.locator(RESULTS).innerText();
    expect(text).toContain('2019–20, released 19 August 2020');
    expect(text).toContain('from an earlier period');
    expect(text).not.toMatch(/Ranked/);
    await page.close();
  });

  it('keeps nothing and sends nothing but the one data file', { timeout: T }, async () => {
    const context = await up(browser).newContext();
    const page = await context.newPage();
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await open(page);
    const before = await page.evaluate(() => history.length);
    await choose(page, 0, 'knee');
    await choose(page, 1, 'Armidale');
    await page.locator('button[type="submit"]').click();
    await page.locator(`${RESULTS} li`).first().waitFor();
    const kept = await page.evaluate(
      (length) => ({
        url: location.href,
        history: history.length - length,
        local: localStorage.length,
        session: sessionStorage.length,
        cookie: document.cookie,
      }),
      before,
    );
    expect(kept).toEqual({
      url: `${up(server).base}/compare/`,
      history: 0,
      local: 0,
      session: 0,
      cookie: '',
    });
    expect(await context.cookies()).toEqual([]);
    const other = requests.filter((url) => !url.startsWith(up(server).base));
    expect(other).toEqual([]);
    expect(requests.filter((url) => url.endsWith('.json'))).toEqual([
      `${up(server).base}/tool/data.json`,
    ]);
    expect(requests.filter((url) => /armidale|knee/i.test(url))).toEqual([]);
    await context.close();
  });

  it('shows the static pages and no form with scripts off', { timeout: T }, async () => {
    const context = await up(browser).newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`${up(server).base}/compare/`);
    expect(await page.locator('.js-tool-form').isVisible()).toBe(false);
    const links = await page
      .locator('.js-tool-fallback a')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
    expect(links).toEqual(['/surgery/', '/hospitals/', '/state/']);
    await context.close();
  });

  it('prints one sheet with the tool hidden', { timeout: T }, async () => {
    const page = await up(browser).newPage();
    await compare(page, 'cataract', 'Armidale');
    await page.emulateMedia({ media: 'print' });
    expect(await page.locator('.js-tool-form').isVisible()).toBe(false);
    expect(await page.locator('.js-tool-print').isVisible()).toBe(false);
    expect(await page.locator('.c-masthead').isVisible()).toBe(false);
    expect(await page.locator(`${RESULTS} li`).first().isVisible()).toBe(true);
    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '1.5cm', bottom: '1.5cm', left: '1cm', right: '1cm' },
    });
    const sheets = pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? [];
    expect(sheets).toHaveLength(1);
    await page.close();
  });
});
