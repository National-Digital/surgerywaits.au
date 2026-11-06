import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it } from 'vitest';

import {
  distSlug,
  entityPattern,
  pageStrings,
  readContent,
  replacedTerms,
} from '../lib/content-files';
import { termsSchema } from '../lib/content-schema';

const dist = new URL('../../dist/', import.meta.url);
if (!existsSync(dist)) {
  throw new Error('site/dist is missing: run `npm run build` before BUILT_PAGES=1 npm test');
}
const pages = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.html'))
  .sort()
  .map((path) => ({ path, html: readFileSync(new URL(path, dist), 'utf8') }));

// Needs `npm run build` first, so only the build job runs it, with BUILT_PAGES=1.
describe('Built pages', () => {
  it('print no ACN, ABN or company suffix', () => {
    expect(pages.length).toBeGreaterThan(0);
    expect(
      pages
        .filter(({ html }) => pageStrings(html).some((t) => entityPattern.test(t)))
        .map(({ path }) => path),
    ).toEqual([]);
  });

  it('use no term the terms file replaces', () => {
    const terms = termsSchema.parse(readContent().find(({ path }) => path === 'terms.yaml')?.data);
    expect(
      pages.flatMap(({ path, html }) => replacedTerms(distSlug(path), pageStrings(html), terms)),
    ).toEqual([]);
  });

  it('hold no development preview route', () => {
    expect(pages.filter(({ path }) => path.startsWith('dev/')).map(({ path }) => path)).toEqual([]);
    expect(pages.filter(({ html }) => html.includes('noindex')).map(({ path }) => path)).toEqual(
      [],
    );
  });

  it('carry the operator line in the footer', () => {
    for (const { html } of pages) {
      expect(pageStrings(html).join('')).toContain(
        'Built and operated by National Digital, Burleigh Heads, Queensland',
      );
    }
  });

  it('hold a banner, a labelled site navigation, one main landmark and a footer', () => {
    for (const { path, html } of pages) {
      const tags = elements(html);
      const count = (name: string): number => tags.filter((t) => t.tagName === name).length;
      expect([path, count('header'), count('main'), count('footer')]).toEqual([path, 1, 1, 1]);
      const labels = tags
        .filter((t) => t.tagName === 'nav')
        .map((t) => t.attrs.find((a) => a.name === 'aria-label')?.value);
      expect(labels).toContain('Site');
      expect(labels.every((l) => l !== undefined && l !== '')).toBe(true);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('print no ACN, ABN or company suffix in the footer', () => {
    for (const { html } of pages) {
      const footer = elements(html).find((t) => t.tagName === 'footer');
      expect(footer && textOf(footer)).toMatch(/Built and operated by\s+National Digital/);
      expect(entityPattern.test(footer ? textOf(footer) : '')).toBe(false);
    }
  });

  it('link every footer entry to a page that is built', () => {
    const built = new Set(pages.map(({ path }) => path));
    for (const { path, html } of pages) {
      const footer = elements(html).find((t) => t.tagName === 'footer');
      const hrefs = footer ? anchors(footer) : [];
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs.filter((h) => h.startsWith('/'))) {
        expect([path, href, built.has(`${href.slice(1)}index.html`)]).toEqual([path, href, true]);
      }
    }
  });

  it('show the compare bar only when its page is built', () => {
    const target = pages.some(({ path }) => path === 'compare/index.html');
    for (const { html } of pages) {
      expect(html.includes('c-compare-bar')).toBe(target);
    }
  });

  it('ship zero JavaScript on every static page', () => {
    for (const { path, html } of pages) {
      const tags = elements(html);
      expect([path, tags.filter((t) => t.tagName === 'script').length]).toEqual([path, 0]);
      const handlers = tags.flatMap((t) => t.attrs).filter((a) => /^on/i.test(a.name));
      expect([path, handlers.length]).toEqual([path, 0]);
      expect(html).not.toMatch(/href="javascript:/i);
    }
  });
});

function elements(html: string): DefaultTreeAdapterTypes.Element[] {
  const out: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ('tagName' in node) {
      out.push(node);
    }
    if ('childNodes' in node) {
      node.childNodes.forEach(visit);
    }
  };
  visit(parse(html));
  return out;
}

function textOf(node: DefaultTreeAdapterTypes.Node): string {
  if ('value' in node) {
    return node.value;
  }
  return 'childNodes' in node ? node.childNodes.map(textOf).join(' ') : '';
}

function anchors(root: DefaultTreeAdapterTypes.Element): string[] {
  const out: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ('tagName' in node && node.tagName === 'a') {
      out.push(node.attrs.find((a) => a.name === 'href')?.value ?? '');
    }
    if ('childNodes' in node) {
      node.childNodes.forEach(visit);
    }
  };
  visit(root);
  return out;
}
