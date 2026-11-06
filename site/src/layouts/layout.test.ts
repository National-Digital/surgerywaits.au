import { describe, expect, it } from 'vitest';
import CompareBar from '../components/CompareBar.astro';
import Footer from '../components/Footer.astro';
import { navigationSchema } from '../lib/content-schema';
import { existing, routesOf } from '../lib/links';
import { render, text, textsOf } from '../lib/test-render';

describe('Footer links', () => {
  it('leave out a page that is not built and keep one that is', () => {
    const routes = routesOf(['../pages/index.astro', '../pages/about/index.astro']);
    const links = [
      { label: 'Home', href: '/' },
      { label: 'About', href: '/about/' },
      { label: 'Privacy', href: '/privacy/' },
    ];
    expect(existing(links, routes).map((l) => l.href)).toEqual(['/', '/about/']);
  });

  it('read a route from a page file and skip the 404 page and dynamic routes', () => {
    const routes = routesOf([
      '../pages/404.astro',
      '../pages/state.astro',
      '../pages/hospital/[slug].astro',
    ]);
    expect([...routes]).toEqual(['/state/']);
  });

  it('must name a path inside the site that ends in a slash', () => {
    const base = { site: [{ label: 'Home', href: '/' }], compare: { label: 'Compare', href: '/' } };
    for (const href of ['https://example.com/', '/about', 'about/']) {
      const bad = navigationSchema.safeParse({ ...base, about: [{ label: 'About', href }] });
      expect(bad.success).toBe(false);
    }
  });
});

describe('Footer', () => {
  it('carries the full safety text, the exclusion and the operator line', async () => {
    const html = await render(Footer, {});
    const page = text(html);
    expect(page).toContain('It does not recommend any hospital, doctor or treatment.');
    expect(page).toContain('Private hospitals are not included.');
    expect(page).toContain('Built and operated by National Digital , Burleigh Heads, Queensland');
    expect(html).not.toContain('aria-label="Site"');
  });

  it('links back to the top of the page', async () => {
    const html = await render(Footer, {});
    expect(html).toMatch(/<a class="c-footer__top-link" href="#top"[^>]*>\s*Back to top\s*<\/a>/);
  });

  it('shrinks the safety text but keeps the exclusion and the emergency line when compact', async () => {
    const html = await render(Footer, { compact: true });
    const page = text(html);
    expect(page).not.toContain('It does not recommend');
    expect(page).toContain('Private hospitals are not included.');
    expect(page).toContain('In an emergency, call 000.');
    expect(page).toContain('Built and operated by National Digital');
    expect(textsOf(html, 'c-footer__safety')[0]?.length).toBeLessThan(
      textsOf(await render(Footer, {}), 'c-footer__safety')[0]?.length ?? 0,
    );
  });
});

describe('Compare bar', () => {
  it('stays out of the page while its target page is not built', async () => {
    expect(await render(CompareBar, {})).not.toContain('c-compare-bar');
  });
});
