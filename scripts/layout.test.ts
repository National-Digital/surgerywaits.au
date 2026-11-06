import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { launch, serve } from './a11y-audit.ts';
import type { Served } from './a11y-audit.ts';

// Needs `npm run build` first. Locally the proof skips without the browser; in CI a missing one fails it.
const dist = resolve(import.meta.dirname, '../site/dist');
const skip = !existsSync(chromium.executablePath()) && process.env['CI'] === undefined;
const T = 120000;

let browser: Browser | undefined;
let server: Served | undefined;
beforeAll(async () => {
  if (skip) {
    return;
  }
  server = await serve(dist);
  browser = await launch();
}, T);
afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe.skipIf(skip)('the header', () => {
  it('shows every site link inline with no toggle, with scripts off', { timeout: T }, async () => {
    for (const width of [390, 1280]) {
      const context = await browser?.newContext({
        javaScriptEnabled: false,
        viewport: { width, height: 800 },
      });
      const page = await context?.newPage();
      if (!page || !server) {
        throw new Error('the browser did not start');
      }
      await page.goto(`${server.base}/`);
      expect(await page.locator('header button').count()).toBe(0);
      const links = page.locator('header nav[aria-label="Site"] a[href]');
      expect(await links.count()).toBeGreaterThan(0);
      for (const link of await links.all()) {
        expect(await link.isVisible()).toBe(true);
        const box = await link.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
        expect(box?.width).toBeGreaterThanOrEqual(44);
        expect(box && box.y >= 0 && box.y < 800).toBe(true);
      }
      await links.first().click();
      expect(new URL(page.url()).pathname).toBe('/');
      await context?.close();
    }
  });
});
