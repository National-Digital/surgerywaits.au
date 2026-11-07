import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launch, serve } from './a11y-audit.ts';
import type { Served } from './a11y-audit.ts';

// Drives the built site in Chromium. It needs `npm run build` first, so the Accessibility job runs it.
const T = 120_000;
const skip = !existsSync(chromium.executablePath()) && process.env['CI'] === undefined;
const browsers = describe.skipIf(skip);
const INPUT = '.js-combo-input';
const OPTION = '[role="option"]';

let browser: Browser | undefined;
let site: Served | undefined;
let fixtures: Served | undefined;
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
  site = await serve(resolve(import.meta.dirname, '../site/dist'));
  fixtures = await serve(resolve(import.meta.dirname, 'privacy-fixtures'));
  browser = await launch();
}, T);
afterAll(async () => {
  await browser?.close();
  site?.close();
  fixtures?.close();
});

// The page list the Accessibility job audits, read from the workflow so the two cannot drift.
function auditedPaths(): string[] {
  const workflow = readFileSync(
    resolve(import.meta.dirname, '../.github/workflows/ci.yml'),
    'utf8',
  );
  const line = /npm run a11y -- site\/dist (\/[^\n]*)/u.exec(workflow)?.[1];
  return (line ?? '').split(/\s+/u).filter((p) => p.startsWith('/'));
}

// Records what the page does to history and what it writes to storage, before any page script runs.
const RECORDER = `(() => {
  const log = (window.__privacy = []);
  for (const name of ['pushState', 'replaceState']) {
    const original = History.prototype[name];
    History.prototype[name] = function (...args) {
      log.push(name);
      return original.apply(this, args);
    };
  }
  for (const name of ['hashchange', 'popstate']) {
    addEventListener(name, () => log.push(name));
  }
})();`;

interface Seen {
  cookies: string[];
  documentCookie: string;
  local: number;
  session: number;
  databases: string[];
  caches: string[];
  workers: number;
  moved: string[];
  historyGrew: number;
  calls: string[];
}

async function watch(
  context: BrowserContext,
  address: string,
  flow: (page: Page) => Promise<void>,
): Promise<Seen> {
  await context.addInitScript(RECORDER);
  const page = await context.newPage();
  await page.goto(address);
  await page.waitForLoadState('load');
  const start = await page.evaluate(() => history.length);
  await flow(page);
  const seen = await page.evaluate(async (length) => {
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    return {
      documentCookie: document.cookie,
      local: localStorage.length,
      session: sessionStorage.length,
      databases: databases.map((d) => d.name ?? ''),
      caches: await caches.keys(),
      workers: (await navigator.serviceWorker.getRegistrations()).length,
      historyGrew: history.length - length,
      href: location.href,
      calls: (window as unknown as { __privacy: string[] }).__privacy,
    };
  }, start);
  const { href, ...rest } = seen;
  return {
    ...rest,
    cookies: (await context.cookies()).map((c) => c.name),
    moved: href === address ? [] : [href],
  };
}

const clean: Seen = {
  cookies: [],
  documentCookie: '',
  local: 0,
  session: 0,
  databases: [],
  caches: [],
  workers: 0,
  moved: [],
  historyGrew: 0,
  calls: [],
};

const none = (): Promise<void> => Promise.resolve();

async function run(
  address: string,
  flow: (page: Page) => Promise<void> = none,
  setUp: (context: BrowserContext) => Promise<void> = none,
): Promise<Seen> {
  const context = await up(browser).newContext();
  try {
    await setUp(context);
    return await watch(context, address, flow);
  } finally {
    await context.close();
  }
}

async function choose(page: Page, field: number, text: string): Promise<void> {
  const input = page.locator(INPUT).nth(field);
  await input.fill(text);
  await page.locator('.js-tool-field').nth(field).locator(OPTION).first().waitFor();
  await input.press('ArrowDown');
  await input.press('Enter');
}

// Fills both fields, compares, then searches again with other words and clears the form.
async function fullFlow(page: Page): Promise<void> {
  await page.locator('.js-tool-form').waitFor();
  await choose(page, 0, 'cataracts');
  await choose(page, 1, 'Armidale');
  await page.locator('button[type="submit"]').click();
  await page.locator('.js-tool-results li').first().waitFor();
  await choose(page, 0, 'knee');
  await page.locator('button[type="submit"]').click();
  await page.locator('.js-tool-results h2', { hasText: /knee/i }).waitFor();
  await page.keyboard.press('Escape');
}

browsers('Privacy in the browser', () => {
  it(
    'sets no cookie and keeps nothing in storage on any audited page or through a full compare flow',
    { timeout: T },
    async () => {
      const list = auditedPaths();
      expect(list).toContain('/');
      expect(list).toContain('/compare/');
      for (const path of list) {
        const address = `${up(site).base}${path}`;
        expect(await run(address), path).toEqual(clean);
      }
      expect(await run(`${up(site).base}/compare/`, fullFlow)).toEqual(clean);
    },
  );

  it(
    'leaves the address and history alone and calls no history method through a full compare flow',
    { timeout: T },
    async () => {
      const address = `${up(site).base}/compare/`;
      const seen = await run(address, fullFlow);
      expect([seen.moved, seen.historyGrew, seen.calls]).toEqual([[], 0, []]);
    },
  );

  it(
    'catches a cookie, a storage write, a database, a cache, a service worker, a history call and an address change',
    { timeout: T },
    async () => {
      const base = up(fixtures).base;
      expect(await run(`${base}/clean.html`)).toEqual(clean);
      const header = async (context: BrowserContext): Promise<void> => {
        await context.route('**/cookie-header.html', (route) =>
          route.fulfill({
            contentType: 'text/html',
            headers: { 'Set-Cookie': 'seen=1; Path=/' },
            body: '<!doctype html><title>x</title>',
          }),
        );
      };
      expect((await run(`${base}/cookie-header.html`, undefined, header)).cookies).toEqual([
        'seen',
      ]);
      expect((await run(`${base}/cookie.html`)).cookies).toEqual(['seen']);
      expect((await run(`${base}/local-storage.html`)).local).toBe(1);
      expect((await run(`${base}/session-storage.html`)).session).toBe(1);
      expect((await run(`${base}/indexed-db.html`)).databases).toEqual(['a']);
      const wait =
        (condition: () => Promise<boolean>) =>
        async (page: Page): Promise<void> => {
          await page.waitForFunction(condition, undefined, { timeout: 10_000 });
        };
      const cached = await run(
        `${base}/cache-api.html`,
        wait(async () => (await caches.keys()).length > 0),
      );
      expect(cached.caches).toEqual(['a']);
      const script = async (context: BrowserContext): Promise<void> => {
        await context.route('**/sw.js', (route) =>
          route.fulfill({ contentType: 'text/javascript', body: 'self.oninstall = () => {};' }),
        );
      };
      const worker = await run(
        `${base}/service-worker.html`,
        wait(async () => (await navigator.serviceWorker.getRegistrations()).length > 0),
        script,
      );
      expect(worker.workers).toBe(1);
      expect((await run(`${base}/push-state.html`)).calls).toEqual(['pushState']);
      expect((await run(`${base}/replace-state.html`)).calls).toEqual(['replaceState']);
      expect((await run(`${base}/hash.html`)).calls).toContain('hashchange');
      expect((await run(`${base}/hash.html`)).moved).toHaveLength(1);
      expect((await run(`${base}/push-state.html`)).moved).toHaveLength(1);
      expect((await run(`${base}/assign.html`)).moved).toHaveLength(1);
    },
  );
});
