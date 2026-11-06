import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
});
