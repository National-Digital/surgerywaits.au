import { describe, expect, it } from 'vitest';
import { label } from '../lib/content';
import { render, text, textsOf, withoutJsonLd } from '../lib/test-render';
import Breadcrumbs from './Breadcrumbs.astro';

const items = [
  { label: 'Home', href: '/' },
  { label: 'Hospitals', href: '/hospitals/' },
  { label: 'Royal Test Hospital' },
];

describe('Breadcrumbs', () => {
  it('is a labelled nav holding an ordered list', async () => {
    const html = await render(Breadcrumbs, { items });
    expect(html).toContain(`<nav class="c-breadcrumbs" aria-label="${label('nav_breadcrumb')}"`);
    expect(html).toContain('<ol class="c-breadcrumbs__list"');
    expect(textsOf(html, 'c-breadcrumbs__item')).toEqual(items.map((i) => i.label));
  });

  it('marks only the last item as the current page, and does not link it', async () => {
    const html = await render(Breadcrumbs, { items });
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<span aria-current="page"[^>]*>Royal Test Hospital<\/span>/);
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).toContain('href="/hospitals/"');
  });

  it('marks the current page only on the last item when a middle item is unlinked', async () => {
    const middle = [{ label: 'Home', href: '/' }, { label: 'Hospitals' }, { label: 'Royal Test' }];
    const html = await render(Breadcrumbs, { items: middle });
    expect(html.match(/aria-current/g)).toHaveLength(1);
    expect(html).toMatch(/<span[^>]*>Hospitals<\/span>/);
    expect(html).toMatch(/<span aria-current="page"[^>]*>Royal Test<\/span>/);
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it('renders nothing for a single item', async () => {
    expect(text(await render(Breadcrumbs, { items: [{ label: 'Home' }] }))).toBe('');
  });

  it('holds no script but its JSON-LD, and no copy of its own', async () => {
    const html = await render(Breadcrumbs, { items });
    expect(withoutJsonLd(html)).not.toContain('<script');
    expect(text(html)).toBe('Home Hospitals Royal Test Hospital');
  });

  it('describes the same trail in JSON-LD, with the current page at its own address', async () => {
    const html = await render(Breadcrumbs, { items });
    const [, body = ''] = /<script type="application\/ld\+json">(.*?)<\/script>/su.exec(html) ?? [];
    const { '@graph': graph } = JSON.parse(body) as { '@graph': { itemListElement: unknown[] }[] };
    expect(graph[0]?.itemListElement).toEqual(
      items.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.label,
        item: `https://surgerywaits.au${item.href ?? '/'}`,
      })),
    );
  });
});
