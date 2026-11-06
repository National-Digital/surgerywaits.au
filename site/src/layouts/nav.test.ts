import { beforeEach, describe, expect, it, vi } from 'vitest';
import CompareBar from '../components/CompareBar.astro';
import Masthead from '../components/Masthead.astro';
import { getNavigation } from '../lib/content';
import { render } from '../lib/test-render';

const state = vi.hoisted(() => ({ built: true, links: [] as { label: string; href: string }[] }));

vi.mock('../lib/links', () => ({
  builtLinks: (): { label: string; href: string }[] => state.links,
  isBuilt: (): boolean => state.built,
}));

beforeEach(() => {
  state.built = true;
  state.links = getNavigation().site;
});

function hrefsIn(html: string, open: string): string[] {
  const start = html.indexOf(open);
  const block = html.slice(start, html.indexOf('</nav>', start));
  return block
    .split('href=' + String.fromCharCode(34))
    .slice(1)
    .map((part) => part.slice(0, part.indexOf(String.fromCharCode(34))));
}

describe('Header navigation', () => {
  it('holds every site link inline, with no toggle and no menu link', async () => {
    const html = await render(Masthead, {});
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('aria-controls');
    expect(html).not.toContain('#site-menu');
    expect(hrefsIn(html, '<nav class="c-masthead__nav" aria-label="Site"')).toEqual(
      getNavigation().site.map((l) => l.href),
    );
  });

  it('fails the build when no site link points at a built page', async () => {
    state.links = [];
    await expect(render(Masthead, {})).rejects.toThrow('no built page');
  });
});

describe('Compare bar', () => {
  it('shows a link to the compare page once that page is built', async () => {
    const html = await render(CompareBar, {});
    expect(html).toContain('aria-label="Compare"');
    expect(hrefsIn(html, 'aria-label="Compare"')).toEqual(['/compare/']);
  });

  it('stays out when the compare page is not built', async () => {
    state.built = false;
    expect(await render(CompareBar, {})).not.toContain('c-compare-bar');
  });
});
