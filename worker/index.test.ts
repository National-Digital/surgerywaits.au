import { describe, expect, it } from 'vitest';

import { cacheControl, SECURITY_HEADERS, withHeaders } from './headers';
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
        pathname === '/missing/' || pathname.endsWith('missing.json') || pathname.includes('%2f')
          ? new Response('gone', { status: 404 })
          : new Response(request.method === 'HEAD' ? null : '<p>page</p>', {
              status: 200,
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            }),
      );
    },
  },
} as unknown as Env;
let failAssets = false;
const assetsFetch = env.ASSETS.fetch.bind(env.ASSETS);
env.ASSETS.fetch = (request: Request): Promise<Response> =>
  failAssets ? Promise.reject(new Error('binding down at /secret/stack')) : assetsFetch(request);
const send = (path: string, method: string): Promise<Response> =>
  handle(new Request(`https://example.test${path}`, { method }), env, table);
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

describe('cookies', () => {
  const cookies = { 'Set-Cookie': 'id=1; Path=/', 'Content-Type': 'text/html' };
  // An assets binding that tries to set a cookie on every answer, by status and method.
  const bait = (status = 200): Env =>
    ({
      ASSETS: {
        fetch: (request: Request): Promise<Response> =>
          Promise.resolve(
            new Response(request.method === 'HEAD' ? null : 'x', { status, headers: cookies }),
          ),
      },
    }) as unknown as Env;
  const request = (path: string, method = 'GET'): Request =>
    new Request(`https://example.test${path}`, { method });
  const down = { ASSETS: { fetch: () => Promise.reject(new Error('down')) } } as unknown as Env;

  it('sends no Set-Cookie on a page, an asset, a data file, a HEAD, a redirect, a 404, a refused method, a preflight or an error', async () => {
    const answers: [string, number, Response][] = [
      ['page', 200, await handle(request('/state/nsw/'), bait(), table)],
      ['asset', 200, await handle(request('/_astro/a.css'), bait(), table)],
      ['asset 404', 404, await handle(request('/missing/'), bait(404), table)],
      ['data file', 200, await handle(request('/data-api/x.json'), bait(), table)],
      ['data file 404', 404, await handle(request('/data-api/x.json'), bait(404), table)],
      ['head', 200, await handle(request('/state/nsw/', 'HEAD'), bait(), table)],
      ['redirect', 301, await handle(request('/old/'), bait(), table)],
      ['refused method', 405, await handle(request('/state/nsw/', 'POST'), bait(), table)],
      ['preflight', 204, await handle(request('/data-api/x.json', 'OPTIONS'), bait(), table)],
      ['error', 500, await handle(request('/x/'), down, table)],
    ];
    for (const [name, status, response] of answers) {
      expect([name, response.status], name).toEqual([name, status]);
      expect([name, response.headers.has('Set-Cookie')], name).toEqual([name, false]);
      expect(response.headers.getSetCookie(), name).toEqual([]);
    }
  });

  it('drops a Set-Cookie that arrives on a redirect, a 405 or a preflight answer', () => {
    const arriving: [string, number][] = [
      ['/old/', 301],
      ['/state/nsw/', 405],
      ['/data-api/x.json', 204],
    ];
    for (const [path, status] of arriving) {
      const headers = new Headers({ Location: '/new/', Allow: 'GET, HEAD' });
      headers.append('Set-Cookie', 'a=1');
      headers.append('Set-Cookie', 'b=2');
      const response = withHeaders(new Response(null, { status, headers }), path);
      expect([path, response.headers.getSetCookie()]).toEqual([path, []]);
      expect(response.status).toBe(status);
    }
  });
});

describe('caching', () => {
  it('revalidates pages, caches hashed files for a year and crawler files for an hour', () => {
    expect(cacheControl('/hospital/x/', 200)).toBe('public, max-age=0, must-revalidate');
    expect(cacheControl('/_astro/style.abc.css', 200)).toBe('public, max-age=31536000, immutable');
    expect(cacheControl('/fonts/a.woff2', 304)).toBe('public, max-age=31536000, immutable');
    expect(cacheControl('/sitemap.xml', 200)).toBe('public, max-age=0, must-revalidate');
    expect(cacheControl('/sitemap-pairs-1.xml', 200)).toBe('public, max-age=0, must-revalidate');
    expect(cacheControl('/robots.txt', 200)).toBe('public, max-age=14400');
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

  it('keeps the fragment of a target and the query of the request', async () => {
    const withFragment = new Map([['/old/', '/new/#part']]);
    const response = await handle(new Request('https://example.test/old/?a=1'), env, withFragment);
    expect(response.headers.get('Location')).toBe('https://example.test/new/?a=1#part');
  });

  it('finds a listed path given without its slash, in one hop', async () => {
    expect(redirectFor('/old', table)).toBe('/new/');
    expect((await get('/old')).headers.get('Location')).toBe('https://example.test/new/');
  });

  it('finds a path in another case, with escaped letters, or without its slash', async () => {
    const wanted = 'https://example.test/new/';
    for (const path of ['/OLD/', '/Old', '/%6Fld/', '/%4fld', '/o%6c%64']) {
      const response = await get(path);
      expect(response.status, path).toBe(301);
      expect(response.headers.get('Location'), path).toBe(wanted);
    }
  });

  it('leaves reserved escapes and foreign hosts out of the lookup', async () => {
    const slashed = new Map([['/a/b/', '/c/']]);
    expect(redirectFor('/a%2Fb/', slashed)).toBeUndefined();
    expect(redirectFor('//a/b/', slashed)).toBeUndefined();
    expect(redirectFor('/a/b/%2e%2e/', slashed)).toBeUndefined();
    const response = await get('/old/?next=https://elsewhere.test/');
    expect(new URL(response.headers.get('Location') ?? '').origin).toBe('https://example.test');
  });

  it('serves every other path from the assets', async () => {
    seen.length = 0;
    expect((await get('/new/')).status).toBe(200);
    expect(seen).toEqual(['/new/']);
  });
});

describe('methods and failures', () => {
  it('refuses a method other than GET and HEAD on a redirect source and on a page', async () => {
    for (const path of ['/old/', '/state/nsw/']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const response = await send(path, method);
        expect(response.status, `${method} ${path}`).toBe(405);
        expect(response.headers.get('Allow')).toBe('GET, HEAD');
        expect(response.headers.get('Location')).toBeNull();
        expect(response.headers.get('Content-Security-Policy')).toBe(
          SECURITY_HEADERS['Content-Security-Policy'],
        );
      }
    }
  });

  it('does not ask the assets for a refused method', async () => {
    seen.length = 0;
    await send('/state/nsw/', 'POST');
    expect(seen).toEqual([]);
  });

  it('answers HEAD on a redirect with the 301, its Location and no body', async () => {
    const response = await send('/old/?a=1', 'HEAD');
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('https://example.test/new/?a=1');
    expect(response.body).toBeNull();
  });

  it('answers HEAD on a page from the assets', async () => {
    const response = await send('/state/nsw/', 'HEAD');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('');
  });

  it('returns a plain 500 with the security headers when the assets fail', async () => {
    failAssets = true;
    try {
      const response = await get('/state/nsw/');
      expect(response.status).toBe(500);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Content-Type')).toContain('text/plain');
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers.get(name)).toBe(value);
      }
      const body = await response.text();
      expect(body).toBe('Internal server error');
      expect(body).not.toContain('secret');
    } finally {
      failAssets = false;
    }
  });
});

describe('the compare tool files', () => {
  it('allows the tool to run and fetch from the site, and serves its files revalidated, closed to other sites and kept out of search', async () => {
    const policy = SECURITY_HEADERS['Content-Security-Policy'] ?? '';
    expect(policy).toMatch(/script-src 'self'/u);
    expect(policy).toMatch(/connect-src 'self'/u);
    for (const path of ['/tool/index.json', '/tool/places.json', '/tool/figures.json']) {
      const response = await get(path);
      expect(response.headers.get('Content-Security-Policy'), path).toBe(policy);
      expect(response.headers.get('Cache-Control'), path).toBe(
        'public, max-age=0, must-revalidate',
      );
      expect(response.headers.get('Access-Control-Allow-Origin'), path).toBeNull();
      expect(response.headers.get('X-Robots-Tag'), path).toBe('noindex');
    }
    expect((await get('/compare/')).headers.get('X-Robots-Tag')).toBeNull();
  });
});

describe('the data files', () => {
  it('lets any site read them and keeps them out of search', async () => {
    for (const path of [
      '/data-api/index.json',
      '/data-api/hospitals/x.json',
      '/data-api/missing.json',
    ]) {
      const response = await get(path);
      expect(response.headers.get('Access-Control-Allow-Origin'), path).toBe('*');
      expect(response.headers.get('X-Robots-Tag'), path).toBe('noindex');
      expect(response.headers.get('Content-Security-Policy'), path).toBe(
        SECURITY_HEADERS['Content-Security-Policy'],
      );
    }
  });

  it('names JSON as the type and caches a found file for an hour', async () => {
    const response = await get('/data-api/index.json');
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(cacheControl('/data-api/index.json', 200)).toBe('public, max-age=3600');
    expect(cacheControl('/data-api/gone.json', 404)).toBe('no-store');
    const page = await get('/state/nsw/');
    expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(page.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('answers a preflight under /data-api/ with the methods and no body', async () => {
    seen.length = 0;
    const response = await send('/data-api/trends/x.json', 'OPTIONS');
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(response.headers.get('Content-Security-Policy')).toBe(
      SECURITY_HEADERS['Content-Security-Policy'],
    );
    expect(seen).toEqual([]);
  });

  it('refuses a write under /data-api/ and still refuses OPTIONS elsewhere', async () => {
    const write = await send('/data-api/index.json', 'POST');
    expect(write.status).toBe(405);
    expect(write.headers.get('Allow')).toBe('GET, HEAD, OPTIONS');
    expect(write.headers.get('Access-Control-Allow-Origin')).toBe('*');
    for (const path of ['/', '/data/', '/data-api', '/charts/x.svg']) {
      const response = await send(path, 'OPTIONS');
      expect(response.status, path).toBe(405);
      expect(response.headers.get('Allow'), path).toBe('GET, HEAD');
    }
  });

  it.each([
    ['GET', '/data-api/missing.json'],
    ['HEAD', '/data-api/missing.json'],
    ['GET', '/data-api/%2f..'],
    ['GET', '/data-api/a%2fmissing.json'],
  ])('answers %s %s with a small JSON 404 that any site may read', async (method, path) => {
    const response = await send(path, method);
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await response.text()).toBe(method === 'HEAD' ? '' : '{"error":"not found"}');
  });

  it('leaves the HTML 404 for a page', async () => {
    const response = await get('/missing/');
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('gone');
  });

  it('answers HEAD on a data file with its headers and no body', async () => {
    const response = await send('/data-api/index.json', 'HEAD');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(await response.text()).toBe('');
  });

  it('passes an encoded path to the assets as sent', async () => {
    seen.length = 0;
    await get('/data-api/%2f..');
    expect(seen).toEqual(['/data-api/%2f..']);
  });

  it('gives the path without its slash no data headers and refuses its preflight', async () => {
    const response = await get('/data-api');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await send('/data-api', 'OPTIONS')).status).toBe(405);
  });

  it.each(['/data-api/missing.json', '/data-api/%2f..'])(
    'answers a preflight on the missing path %s like any other',
    async (path) => {
      const response = await send(path, 'OPTIONS');
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
    },
  );
});
