import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { mediaTypeOf, SURFACES, surfaceOf } from '../lib/surfaces';

const dist = new URL('../../dist/', import.meta.url);
if (!existsSync(dist)) {
  throw new Error('site/dist is missing: run `npm run build` before BUILT_PAGES=1 npm test');
}
const read = (path: string): string => readFileSync(new URL(`.${path}`, dist), 'utf8');

// The build's own page files and assets are not surfaces.
const NOT_A_SURFACE = /(\.html$|^\/_astro\/|^\/fonts\/)/u;
const built = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  .filter((file) => statSync(new URL(file, dist)).isFile())
  .map((file) => `/${file}`)
  .filter((path) => !NOT_A_SURFACE.test(path))
  .sort();

describe('the built surfaces', () => {
  it('builds every expected path of every surface', () => {
    for (const surface of SURFACES) {
      for (const path of surface.expected?.() ?? []) {
        expect(built, `${surface.id}: ${path}`).toContain(path);
      }
    }
  });

  it('builds no machine-readable file that no surface lists', () => {
    expect(built.filter((path) => surfaceOf(path) === undefined)).toEqual([]);
  });

  it('builds exactly the files a surface with a full list names', () => {
    for (const surface of SURFACES.filter((s) => s.id !== 'sitemaps')) {
      const expected = surface.expected?.().sort();
      expect(
        built.filter((path) => surfaceOf(path)?.id === surface.id),
        surface.id,
      ).toEqual(expected);
    }
  });

  it('serves each file with the media type of its surface and a body that parses as it', () => {
    for (const path of built) {
      const surface = surfaceOf(path);
      expect(mediaTypeOf(path), path).toBe(surface?.mediaType);
      const body = read(path);
      expect(body.length, path).toBeGreaterThan(0);
      if (surface?.mediaType === 'application/json') {
        expect(() => JSON.parse(body) as unknown, path).not.toThrow();
      } else if (surface?.mediaType === 'image/svg+xml') {
        expect(body, path).toMatch(/^<svg[ >]/u);
      } else if (surface?.mediaType === 'application/xml') {
        expect(body, path).toMatch(
          /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<(urlset|sitemapindex) /u,
        );
      }
    }
  });
});
