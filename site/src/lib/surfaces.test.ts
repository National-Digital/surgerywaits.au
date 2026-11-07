import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { mediaTypeOf, SURFACES, surfaceOf } from './surfaces';

const redirects = (
  JSON.parse(readFileSync(new URL('../../../data/redirects.json', import.meta.url), 'utf8')) as {
    redirects: { from: string }[];
  }
).redirects.map(({ from }) => from);

describe('the surfaces registry', () => {
  it('gives each surface its own id, a purpose and a media type', () => {
    expect(new Set(SURFACES.map((s) => s.id)).size).toBe(SURFACES.length);
    for (const surface of SURFACES) {
      expect(surface.purpose, surface.id).toMatch(/^[A-Z].*\.$/u);
      expect(surface.mediaType, surface.id).toMatch(/^[a-z]+\/[a-z+.-]+$/u);
    }
  });

  it('names each expected path once, under the surface whose pattern claims it and no other', () => {
    const seen = new Set<string>();
    for (const surface of SURFACES) {
      for (const path of surface.expected?.() ?? []) {
        expect(seen.has(path), path).toBe(false);
        seen.add(path);
        expect(path.startsWith('/'), path).toBe(true);
        expect(surfaceOf(path)?.id, path).toBe(surface.id);
        expect(SURFACES.filter((s) => s.pattern.test(path)).length, path).toBe(1);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('gives each path the media type its extension serves', () => {
    for (const surface of SURFACES) {
      for (const path of surface.expected?.() ?? []) {
        expect(mediaTypeOf(path), path).toBe(surface.mediaType);
      }
    }
  });

  it('leaves each surface address clear of the Worker redirect table', () => {
    for (const surface of SURFACES) {
      for (const path of surface.expected?.() ?? []) {
        expect(redirects, path).not.toContain(path);
        expect(redirects, path).not.toContain(`${path}/`);
      }
    }
  });

  it('claims no page address', () => {
    for (const path of ['/', '/hospital/x/', '/data-api/', '/sitemap/', '/robots.txt/']) {
      expect(surfaceOf(path), path).toBeUndefined();
    }
  });
});
