import { describe, expect, it } from 'vitest';
import { render, text, textsOf } from '../lib/test-render';
import primitives from './primitives.astro';

describe('the primitives preview page', () => {
  it('is marked noindex', async () => {
    const html = await render(primitives, {});
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it('shows every state with a stamp beside each figure', async () => {
    const html = await render(primitives, {});
    const values = textsOf(html, 'c-figure__value');
    const stamps = textsOf(html, 'c-stamp');
    expect(values.length).toBeGreaterThan(15);
    expect(stamps).toHaveLength(values.length);
    for (const stamp of stamps) {
      expect(stamp).toMatch(/^.+, released \d{1,2} [A-Z][a-z]+ \d{4}$/);
    }
    const page = text(html);
    for (const words of [
      'not published: too few patients',
      'not published: no patients reported',
      'not published: AIHW did not publish a figure',
      'not published: no peer group comparison',
      'not published: Queensland Health gave no figure',
      'not reported',
      'This hospital last reported this figure in an earlier period.',
    ]) {
      expect(page).toContain(words);
    }
    expect(values).toContain('0.0%');
  });

  it('shows the data table with one stamp, a stale row and a withheld cell', async () => {
    const html = await render(primitives, {});
    expect(textsOf(html, 'c-table__stamp')).toHaveLength(1);
    expect(textsOf(html, 'c-table__marker').length).toBeGreaterThan(0);
    expect(textsOf(html, 'c-table__rank').length).toBeGreaterThan(0);
    expect(textsOf(html, 'c-table__value').join(' ')).toContain('not published');
  });
});
