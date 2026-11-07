import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { redirectFor } from '../../../worker/redirects';
import { handle } from '../../../worker/index';
import { readDist } from '../lib/dist';
import { EXPIRES } from '../lib/security-txt';
import { isBuildAsset, SURFACES, surfaceBodyProblem, surfaceOf } from '../lib/surfaces';

const dist = new URL('../../dist/', import.meta.url);
if (!existsSync(dist)) {
  throw new Error('site/dist is missing: run `npm run build` before BUILT_PAGES=1 npm test');
}
const read = (path: string): string => readFileSync(new URL(`.${path}`, dist), 'utf8');

const built = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  .filter((file) => statSync(new URL(file, dist)).isFile())
  .map((file) => `/${file}`)
  .filter((path) => !isBuildAsset(path))
  .sort();

// The type the static assets binding gives a file from its extension.
const PLATFORM_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  txt: 'text/plain',
};
const env = {
  ASSETS: {
    fetch: (request: Request): Promise<Response> => {
      const { pathname } = new URL(request.url);
      const type = PLATFORM_TYPES[pathname.slice(pathname.lastIndexOf('.') + 1)];
      return Promise.resolve(
        type === undefined || !existsSync(new URL(`.${pathname}`, dist))
          ? new Response('missing', { status: 404 })
          : new Response(read(pathname), {
              headers: {
                'Content-Type': `${type}${type === 'application/json' ? '' : '; charset=utf-8'}`,
              },
            }),
      );
    },
  },
} as never;

describe('the built surfaces', () => {
  // Measured against the data, not the clock, so a build gives the same answer on any day.
  it('keeps security.txt valid for 90 days past the newest data release', () => {
    const credits = readDist('credits.json') as { sources: { as_at: string | null }[] };
    const releases = credits.sources.flatMap((s) =>
      s.as_at === null ? [] : [Date.parse(s.as_at)],
    );
    const newest = Math.max(...releases);
    expect(releases.length).toBeGreaterThan(0);
    expect(Number.isNaN(newest)).toBe(false);
    expect(Date.parse(EXPIRES) - newest).toBeGreaterThan(90 * 86_400_000);
  });

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

  it('leaves each built surface address clear of the Worker redirect table', () => {
    for (const path of built) {
      expect(redirectFor(path), path).toBeUndefined();
    }
  });

  it('serves each file through the Worker with the media type of its surface and a whole body', async () => {
    for (const path of built) {
      const surface = surfaceOf(path);
      const response = await handle(new Request(`https://example.test${path}`), env);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('Content-Type')?.split(';')[0], path).toBe(surface?.mediaType);
      expect(surfaceBodyProblem(path, await response.text()), path).toBeUndefined();
    }
  });
});
