import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('..', import.meta.url)), ignore: false });

async function problems(file: string): Promise<{ line: number; ruleId: string | null }[]> {
  const [result] = await eslint.lintFiles([`eslint/fixtures/${file}`]);
  // A fixture outside every tsconfig gets a TypeScript parse message with no rule; skip it.
  return (result?.messages ?? [])
    .filter((m) => m.ruleId !== null)
    .map(({ line, ruleId }) => ({ line, ruleId }));
}

describe('bem-class-name', () => {
  it('rejects a class outside the BEM scheme in a stylesheet', async () => {
    expect(await problems('bad-classes.css')).toEqual([
      { line: 2, ruleId: 'site/bem-class-name' },
      { line: 6, ruleId: 'site/bem-class-name' },
    ]);
  }, 60_000);

  it('rejects a class outside the BEM scheme in an Astro style block', async () => {
    expect(await problems('bad-classes.astro')).toEqual([
      { line: 8, ruleId: 'site/bem-class-name' },
    ]);
  }, 60_000);
});

describe('bem-class-name selectors', () => {
  it('rejects :global classes and [class] selectors in a stylesheet', async () => {
    expect(await problems('bad-selectors.css')).toEqual([
      { line: 2, ruleId: 'site/bem-class-name' },
      { line: 6, ruleId: 'site/bem-class-name' },
      { line: 10, ruleId: 'site/bem-class-name' },
    ]);
  }, 60_000);

  it('rejects :global classes and [class] selectors in an Astro style block', async () => {
    expect(await problems('bad-selectors.astro')).toEqual([
      { line: 8, ruleId: 'site/bem-class-name' },
      { line: 12, ruleId: 'site/bem-class-name' },
    ]);
  }, 60_000);
});

describe('layer-declared', () => {
  it('rejects an unlayered rule, an unknown layer and a wrong order in a stylesheet', async () => {
    expect(await problems('bad-layers.css')).toEqual([
      { line: 1, ruleId: 'site/layer-declared' },
      { line: 3, ruleId: 'site/layer-declared' },
      { line: 7, ruleId: 'site/layer-declared' },
    ]);
  }, 60_000);

  it('rejects an unlayered rule and an unknown layer in an Astro style block', async () => {
    expect(await problems('bad-layers.astro')).toEqual([
      { line: 7, ruleId: 'site/layer-declared' },
      { line: 11, ruleId: 'site/layer-declared' },
    ]);
  }, 60_000);
});

describe('token-values and breakpoint-scale', () => {
  it('rejects raw values and an off-scale breakpoint in a stylesheet', async () => {
    expect(await problems('bad-values.css')).toEqual([
      { line: 3, ruleId: 'site/token-values' },
      { line: 4, ruleId: 'site/token-values' },
      { line: 5, ruleId: 'site/token-values' },
      { line: 6, ruleId: 'site/token-values' },
      { line: 12, ruleId: 'site/breakpoint-scale' },
    ]);
  }, 60_000);

  it('rejects raw values and an off-scale breakpoint in an Astro style block', async () => {
    expect(await problems('bad-values.astro')).toEqual([
      { line: 9, ruleId: 'site/token-values' },
      { line: 10, ruleId: 'site/token-values' },
      { line: 11, ruleId: 'site/token-values' },
      { line: 15, ruleId: 'site/breakpoint-scale' },
    ]);
  }, 60_000);
});

describe('token-values colours', () => {
  it('rejects named colours and scheme functions outside settings in a stylesheet', async () => {
    expect(await problems('bad-colors.css')).toEqual([
      { line: 3, ruleId: 'site/token-values' },
      { line: 4, ruleId: 'site/token-values' },
      { line: 7, ruleId: 'site/token-values' },
      { line: 7, ruleId: 'css/use-baseline' },
      { line: 8, ruleId: 'site/token-values' },
      { line: 9, ruleId: 'site/token-values' },
    ]);
  }, 60_000);

  it('rejects named colours and scheme functions outside settings in an Astro block', async () => {
    expect(await problems('bad-colors.astro')).toEqual([
      { line: 9, ruleId: 'site/token-values' },
      { line: 11, ruleId: 'site/token-values' },
      { line: 11, ruleId: 'css/use-baseline' },
    ]);
  }, 60_000);
});

describe('layer-declared statements', () => {
  it('rejects an order statement outside layers.css and an unknown import layer', async () => {
    expect(await problems('stray-order.css')).toEqual([
      { line: 1, ruleId: 'site/layer-declared' },
      { line: 2, ruleId: 'site/layer-declared' },
      { line: 4, ruleId: 'site/layer-declared' },
    ]);
  }, 60_000);

  it('rejects an order statement and an unknown import layer in an Astro block', async () => {
    expect(await problems('stray-order.astro')).toEqual([
      { line: 7, ruleId: 'site/layer-declared' },
      { line: 8, ruleId: 'site/layer-declared' },
    ]);
  }, 60_000);

  it('accepts the order statement in layers.css', async () => {
    expect(await problems('../../site/src/styles/layers.css')).toEqual([]);
  }, 60_000);
});

describe('good code', () => {
  it('accepts a conforming stylesheet and Astro block', async () => {
    expect(await problems('good.css')).toEqual([]);
    expect(await problems('good.astro')).toEqual([]);
  }, 60_000);

  it('accepts every stylesheet and component the site ships', async () => {
    expect(await problems('../../site/src/styles/settings/colors.css')).toEqual([]);
    expect(await problems('../../site/src/components/SkipLink.astro')).toEqual([]);
  }, 60_000);
});

describe('no-literal-text', () => {
  it('rejects literal text, attributes, string expressions, set:html and frontmatter strings', async () => {
    expect(await problems('text-bad.astro')).toEqual([
      { line: 2, ruleId: 'site/no-literal-text' },
      { line: 3, ruleId: 'site/no-literal-text' },
      { line: 8, ruleId: 'site/no-literal-text' },
      { line: 13, ruleId: 'site/no-literal-text' },
      { line: 14, ruleId: 'site/no-literal-text' },
      { line: 15, ruleId: 'site/no-literal-text' },
      { line: 17, ruleId: 'site/no-literal-text' },
      { line: 18, ruleId: 'site/no-literal-text' },
      { line: 19, ruleId: 'site/no-literal-text' },
      { line: 20, ruleId: 'site/no-literal-text' },
      { line: 21, ruleId: 'site/no-literal-text' },
      { line: 22, ruleId: 'site/no-literal-text' },
      { line: 23, ruleId: 'site/no-literal-text' },
      { line: 26, ruleId: 'site/no-literal-text' },
      { line: 30, ruleId: 'site/no-literal-text' },
      { line: 30, ruleId: 'site/no-literal-text' },
      { line: 31, ruleId: 'site/no-literal-text' },
      { line: 32, ruleId: 'site/no-literal-text' },
      { line: 33, ruleId: 'site/no-literal-text' },
      { line: 34, ruleId: 'site/no-literal-text' },
    ]);
  }, 60_000);

  it('accepts scope only with its four values', async () => {
    expect(await problems('text-scope-bad.astro')).toEqual([
      { line: 9, ruleId: 'site/no-literal-text' },
    ]);
  }, 60_000);

  it('accepts keys, non-copy attributes, comparisons, punctuation and style blocks', async () => {
    expect(await problems('text-good.astro')).toEqual([]);
  }, 60_000);
});
