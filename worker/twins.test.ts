import { describe, expect, it } from 'vitest';

import { handle } from './index';
import { prefersMarkdown, twinAddressFor, twinPathOf } from './twins';

const ORIGIN = 'https://surgerywaits.au';
const TWIN = '# Page\n';
const HTML = '<p>page</p>';
const twins = new Set(['/index.md', '/state/nsw.md', '/hospital/a/b.md']);
const asked: Request[] = [];
const env = {
  ASSETS: {
    fetch: (request: Request): Promise<Response> => {
      asked.push(request);
      const { pathname } = new URL(request.url);
      const head = request.method === 'HEAD';
      if (pathname.endsWith('.md')) {
        return Promise.resolve(
          twins.has(pathname)
            ? new Response(head ? null : TWIN, { headers: { 'Content-Type': 'text/plain' } })
            : new Response('<p>missing</p>', { status: 404 }),
        );
      }
      return Promise.resolve(
        pathname.endsWith('/') && !pathname.includes('missing')
          ? new Response(head ? null : HTML, { headers: { 'Content-Type': 'text/html' } })
          : new Response('<p>missing</p>', { status: 404 }),
      );
    },
  },
} as unknown as Env;
const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  handle(new Request(`${ORIGIN}${path}`, init), env);
const ask = (accept: string, path = '/state/nsw/', method = 'GET'): Promise<Response> =>
  call(path, { method, headers: { Accept: accept } });

describe('the twin address of a page', () => {
  it('replaces the closing slash with .md and gives the home page /index.md', () => {
    expect(twinPathOf('/state/nsw/')).toBe('/state/nsw.md');
    expect(twinPathOf('/')).toBe('/index.md');
    expect(twinPathOf('/robots.txt')).toBeUndefined();
    expect(twinPathOf('/state/nsw.md')).toBeUndefined();
    expect(twinPathOf('//evil.example/')).toBeUndefined();
    expect(twinPathOf('//')).toBeUndefined();
    expect(twinAddressFor('//evil.example/index.md')).toBeUndefined();
  });

  it('names the twin for its two folder forms and for no other address', () => {
    expect(twinAddressFor('/state/nsw/index.md')).toBe('/state/nsw.md');
    expect(twinAddressFor('/state/nsw/index.html.md')).toBe('/state/nsw.md');
    expect(twinAddressFor('/hospital/a/b/index.md')).toBe('/hospital/a/b.md');
    expect(twinAddressFor('/index.html.md')).toBe('/index.md');
    expect(twinAddressFor('/index.md')).toBeUndefined();
    expect(twinAddressFor('/state/nsw.md')).toBeUndefined();
    expect(twinAddressFor('/state/nsw/index.html')).toBeUndefined();
  });
});

describe('the Accept header', () => {
  it('prefers Markdown on a higher weight, or on a tie when it is named before HTML', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
    expect(prefersMarkdown('text/markdown, text/html;q=0.9')).toBe(true);
    expect(prefersMarkdown('text/html;q=0.5, text/markdown')).toBe(true);
    expect(prefersMarkdown('text/markdown, text/html')).toBe(true);
    expect(prefersMarkdown('TEXT/MARKDOWN;Q=1')).toBe(true);
    expect(prefersMarkdown('text/markdown;q=0.5, text/*;q=0.1')).toBe(true);
  });

  it('keeps HTML when the weights say so, or when the request names neither', () => {
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown('')).toBe(false);
    expect(prefersMarkdown('*/*')).toBe(false);
    expect(prefersMarkdown('text/*')).toBe(false);
    expect(prefersMarkdown('text/html')).toBe(false);
    expect(prefersMarkdown('text/html, text/markdown')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=0.5, text/html')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=2, text/html;q=0.1')).toBe(false);
    expect(prefersMarkdown('application/json, text/markdown;q=0.8, */*;q=0.9')).toBe(false);
    expect(prefersMarkdown('not a type')).toBe(false);
  });
});

describe('content negotiation', () => {
  it('returns the twin at the page address when the request prefers Markdown', async () => {
    const response = await ask('text/markdown');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(TWIN);
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('Vary')).toBe('Accept');
    expect(response.headers.get('Content-Location')).toBe('/state/nsw.md');
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    expect(response.headers.get('Link')).toBe(`<${ORIGIN}/state/nsw/>; rel="canonical"`);
    expect(response.headers.get('Content-Security-Policy')).not.toBeNull();
  });

  it('returns the home twin at /', async () => {
    const response = await ask('text/markdown', '/');
    expect(await response.text()).toBe(TWIN);
    expect(response.headers.get('Content-Location')).toBe('/index.md');
  });

  it('returns the twin of a pair page', async () => {
    const response = await ask('text/markdown, text/html;q=0.8', '/hospital/a/b/');
    expect(response.headers.get('Content-Location')).toBe('/hospital/a/b.md');
  });

  it('answers HEAD with the twin headers and no body', async () => {
    const response = await ask('text/markdown', '/state/nsw/', 'HEAD');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('Vary')).toBe('Accept');
    expect(response.headers.get('Content-Location')).toBe('/state/nsw.md');
  });

  it('serves the page, with the twin named in a Link header and Vary, otherwise', async () => {
    for (const accept of ['text/html', '*/*', 'text/html, text/markdown']) {
      const response = await ask(accept);
      expect(await response.text(), accept).toBe(HTML);
      expect(response.headers.get('Content-Type'), accept).toBe('text/html');
      expect(response.headers.get('Link'), accept).toBe(
        '</state/nsw.md>; rel="alternate"; type="text/markdown"',
      );
      expect(response.headers.get('Vary'), accept).toBe('Accept');
      expect(response.headers.get('Content-Location'), accept).toBeNull();
    }
    const bare = await call('/');
    expect(bare.headers.get('Link')).toBe('</index.md>; rel="alternate"; type="text/markdown"');
    const head = await call('/state/nsw/', { method: 'HEAD' });
    expect(head.headers.get('Link')).toContain('</state/nsw.md>');
  });

  it('serves the page when its twin is missing, and the 404 when the page is', async () => {
    const page = await ask('text/markdown', '/state/other/');
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(HTML);
    const gone = await ask('text/markdown', '/missing/');
    expect(gone.status).toBe(404);
    expect(gone.headers.get('Link')).toBeNull();
  });

  it('never reads a path with an empty segment as a host', async () => {
    for (const path of ['//evil.example/', '//', '/state//nsw/']) {
      asked.length = 0;
      const response = await ask('text/markdown', path);
      expect(response.headers.get('Content-Location'), path).toBeNull();
      expect(
        asked.map((r) => new URL(r.url).host),
        path,
      ).toEqual(['surgerywaits.au']);
      expect(await response.text(), path).toBe(HTML);
    }
    const folder = await call('//evil.example/index.md');
    expect(folder.status).toBe(404);
    expect(folder.headers.get('Location')).toBeNull();
  });

  it('negotiates only on a page address', async () => {
    asked.length = 0;
    const response = await ask('text/markdown', '/robots.txt');
    expect(response.headers.get('Content-Location')).toBeNull();
    expect(response.headers.get('Vary')).toBeNull();
    expect(asked.map((r) => new URL(r.url).pathname)).toEqual(['/robots.txt']);
  });
});

describe('the twin files', () => {
  it('serves a twin as Markdown, kept out of search, with no Vary', async () => {
    const response = await call('/state/nsw.md');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(TWIN);
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    expect(response.headers.get('Link')).toBe(`<${ORIGIN}/state/nsw/>; rel="canonical"`);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('Vary')).toBeNull();
  });

  it('answers HEAD on a twin with its headers and no body', async () => {
    const response = await call('/index.md', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
  });

  it('answers a missing twin with a 404 in Markdown', async () => {
    for (const method of ['GET', 'HEAD']) {
      const response = await call('/state/none.md', { method });
      expect(response.status).toBe(404);
      expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text()).toBe(method === 'HEAD' ? '' : '# Not found\n');
    }
  });

  it('sends all three addresses of a page to its twin with a 308', async () => {
    const cases: [string, string][] = [
      ['/state/nsw/index.md', `${ORIGIN}/state/nsw.md`],
      ['/state/nsw/index.html.md', `${ORIGIN}/state/nsw.md`],
      ['/index.html.md', `${ORIGIN}/index.md`],
      ['/hospital/a/b/index.md', `${ORIGIN}/hospital/a/b.md`],
      ['/hospital/a/b/index.html.md', `${ORIGIN}/hospital/a/b.md`],
    ];
    for (const [path, location] of cases) {
      for (const method of ['GET', 'HEAD']) {
        const response = await call(path, { method });
        expect(response.status, `${method} ${path}`).toBe(308);
        expect(response.headers.get('Location'), path).toBe(location);
      }
    }
    const kept = await call('/state/nsw/index.md?a=1');
    expect(kept.headers.get('Location')).toBe(`${ORIGIN}/state/nsw.md?a=1`);
    expect((await call('/state/nsw.md')).status).toBe(200);
    expect((await call('/index.md')).status).toBe(200);
  });

  it('refuses a method other than GET and HEAD on a twin', async () => {
    expect((await call('/state/nsw.md', { method: 'POST', body: '{}' })).status).toBe(405);
  });
});

describe('twins on another host', () => {
  it('keeps the noindex the Worker sends from a host that is not the site, and the production canonical', async () => {
    const response = await handle(new Request('https://preview.example/state/nsw.md'), env);
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.get('Link')).toBe(`<${ORIGIN}/state/nsw/>; rel="canonical"`);
  });
});
