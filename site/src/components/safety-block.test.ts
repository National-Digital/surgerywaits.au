import { describe, expect, it } from 'vitest';
import { label } from '../lib/content';
import { render, text, textsOf } from '../lib/test-render';
import SafetyBlock from './SafetyBlock.astro';

describe('SafetyBlock', () => {
  it('is a labelled complementary landmark with the footer wording', async () => {
    const html = await render(SafetyBlock, { id: 'safety-heading' });
    expect(html).toContain('<aside class="c-safety" aria-labelledby="safety-heading"');
    expect(html).toContain('id="safety-heading"');
    const page = text(html);
    expect(page).toContain(label('footer_safety_heading'));
    expect(page).toContain(label('footer_safety_compact'));
    expect(page).toContain(label('footer_emergency'));
    expect(textsOf(html, 'c-safety__heading')).toEqual([label('footer_safety_heading')]);
  });

  it('takes its heading id from the id prop so two blocks can share a page', async () => {
    const html = await render(SafetyBlock, { id: 'second-safety' });
    expect(html).toContain('aria-labelledby="second-safety"');
    expect(html).toContain('id="second-safety"');
    expect(html).not.toContain('id="safety-heading"');
  });

  it('takes the full footer wording on request', async () => {
    expect(text(await render(SafetyBlock, { id: 'safety-heading', full: true }))).toContain(
      label('footer_safety_full'),
    );
  });

  it('holds no script and no copy of its own', async () => {
    const html = await render(SafetyBlock, { id: 'safety-heading' });
    expect(html).not.toContain('<script');
    expect(text(html)).toBe(
      `${label('footer_safety_heading')} ${label('footer_safety_compact')} ${label('footer_emergency')}`,
    );
  });
});
