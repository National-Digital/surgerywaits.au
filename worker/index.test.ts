import { describe, expect, it } from 'vitest';

import { cacheControl, SECURITY_HEADERS } from './headers';
import { handle } from './index';
import { redirectFor } from './redirects';

const table = new Map([['/old/', '/new/']]);
const seen: string[] = [];
const env = {
  ASSETS: {
    fetch: (request: Request): Promise<Response> => {
      seen.push(new URL(request.url).pathname);
      const { pathname } = new URL(request.url);
      return Promise.resolve(
        pathname === '/missing/'
          ? new Response('gone', { status: 404 })
          : new Response('<p>page</p>', {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            }),
      );
    },
  },
} as unknown as Env;
const get = (path: string): Promise<Response> =>
  handle(new Request(`https://example.test${path}`), env, table);

describe('worker responses', () => {
  it('sets every security header on a served page', async () => {
    const response = await get('/state/nsw/');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(await response.text()).toBe('<p>page</p>');
  });

  it('sets them on a 404 and on a redirect', async () => {
    for (const response of [await get('/missing/'), await get('/old/')]) {
      expect(response.headers.get('Content-Security-Policy')).toBe(
        SECURITY_HEADERS['Content-Security-Policy'],
      );
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });

  it('keeps the policy to what a script-free static page needs', () => {
    const policy = SECURITY_HEADERS['Content-Security-Policy'] ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain('unsafe');
    expect(policy).not.toContain('*');
    const hosts = policy.match(/https:\/\/[^\s;]+/gu) ?? [];
    expect(hosts.sort()).toEqual([
      'https://cloudflareinsights.com',
      'https://static.cloudflareinsights.com',
    ]);
  });

  it('turns framing, sniffing, referrers and powerful features off', () => {
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
    expect(SECURITY_HEADERS['Strict-Transport-Security']).toMatch(/^max-age=31536000;/u);
    expect(SECURITY_HEADERS['Permissions-Policy']).toContain('geolocation=()');
  });
});

describe('caching', () => {
  it('revalidates pages, caches hashed files for a year and crawler files for an hour', () => {
    expect(cacheControl('/hospital/x/', 200)).toBe('public, max-age=0, must-revalidate');
    expect(cacheControl('/_astro/style.abc.css', 200)).toBe('public, max-age=31536000, immutable');
    expect(cacheControl('/fonts/a.woff2', 304)).toBe('public, max-age=31536000, immutable');
    expect(cacheControl('/sitemap.xml', 200)).toBe('public, max-age=3600');
    expect(cacheControl('/sitemap-pairs-1.xml', 200)).toBe('public, max-age=3600');
    expect(cacheControl('/robots.txt', 200)).toBe('public, max-age=3600');
  });

  it('never stores a 404 and leaves other statuses to the assets binding', () => {
    expect(cacheControl('/_astro/gone.css', 404)).toBe('no-store');
    expect(cacheControl('/state/nsw', 308)).toBeUndefined();
  });

  it('applies the rule to the response', async () => {
    expect((await get('/_astro/a.css')).headers.get('Cache-Control')).toContain('immutable');
    expect((await get('/missing/')).headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('redirects', () => {
  it('answers a listed path with a 301 to the target, keeping the query', async () => {
    const response = await get('/old/?a=1');
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('https://example.test/new/?a=1');
    expect(response.body).toBeNull();
  });

  it('finds a listed path given without its slash, in one hop', async () => {
    expect(redirectFor('/old', table)).toBe('/new/');
    expect((await get('/old')).headers.get('Location')).toBe('https://example.test/new/');
  });

  it('serves every other path from the assets', async () => {
    seen.length = 0;
    expect((await get('/new/')).status).toBe(200);
    expect(seen).toEqual(['/new/']);
  });
});
