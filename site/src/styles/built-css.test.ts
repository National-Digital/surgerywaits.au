import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const assets = new URL('../../dist/_astro/', import.meta.url);
const ORDER = ['print', 'settings', 'generic', 'elements', 'objects', 'components', 'utilities'];

// Needs `npm run build` first, so only the build job runs it, with BUILT_CSS=1.
describe('Built CSS', () => {
  // cssCodeSplit: false keeps one sheet, so the layer order cannot differ between pages.
  it('opens its layers in the declared order, in a single sheet', () => {
    const sheets = readdirSync(assets).filter((f) => f.endsWith('.css'));
    expect(sheets).toHaveLength(1);
    const css = sheets.map((f) => readFileSync(new URL(f, assets), 'utf8')).join('\n');
    // The bundler drops the order statement, so first appearance fixes the order.
    const seen = [...new Set([...css.matchAll(/@layer\s+([\w-]+)\s*\{/g)].map((m) => m[1] ?? ''))];
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toEqual(ORDER.filter((l) => seen.includes(l)));
  });
});
