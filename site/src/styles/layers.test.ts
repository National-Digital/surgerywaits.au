import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('.', import.meta.url).pathname;
const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.css'))
  .map((f) => ({ f, css: readFileSync(join(root, f), 'utf8') }));
const partials = files.filter(({ f }) => f.includes('/'));

describe('CSS layers', () => {
  it('declares the layer order once, in layers.css', () => {
    const order = files.filter(({ css }) => /^@layer [\w-]+(?:, [\w-]+)+;/m.test(css));
    expect(order.map(({ f }) => f)).toEqual(['layers.css']);
    expect(files.find(({ f }) => f === 'layers.css')?.css).toContain(
      '@layer print, settings, generic, elements, objects, components, utilities;',
    );
  });

  it('puts each partial inside the layer named for its folder', () => {
    const wrong = partials.filter(
      ({ f, css }) => !css.includes(`@layer ${basename(dirname(f))} {`),
    );
    expect(wrong.map(({ f }) => f)).toEqual([]);
  });

  it('keeps every partial imported by global.css', () => {
    const entry = files.find(({ f }) => f === 'global.css')?.css ?? '';
    expect(partials.filter(({ f }) => !entry.includes(`./${f}'`)).map(({ f }) => f)).toEqual([]);
  });

  it('imports the global sheet before any component in the layout', () => {
    const layout = readFileSync(new URL('../layouts/Base.astro', import.meta.url), 'utf8');
    const imports = [...layout.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports[0]).toBe("import '../styles/global.css';");
  });
});
