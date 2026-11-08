import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { redirectFor } from '../../../worker/redirects';
import { handle } from '../../../worker/index';
import {
  ALLOW_ANY_ORIGIN,
  CATALOG_MEDIA_TYPE,
  CATALOG_PATHS,
  withHeaders,
} from '../../../worker/headers';
import { MODERN_VERSION, serverCard, TOOLS } from '../../../worker/mcp';
import { SPECS } from '../../../worker/mcp-tools';
import { termsSchema } from '../lib/content-schema';
import { readContent, replacedTerms } from '../lib/content-files';
import { getMethodology, label } from '../lib/content';
import { readDist, readSurgery } from '../lib/dist';
import { formatLicence, formatList } from '../lib/format';
import { agentFacts } from '../lib/llms';
import { CONTENT_SIGNALS } from '../lib/robots';
import { surgeryRefs } from '../lib/surgery-page';
import { textsOf } from '../lib/test-render';
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
  html: 'text/html',
  json: 'application/json',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  txt: 'text/plain',
  md: 'text/markdown',
};
const env = {
  ASSETS: {
    fetch: (request: Request): Promise<Response> => {
      const { pathname: asked } = new URL(request.url);
      const pathname = asked.endsWith('/') ? `${asked}index.html` : asked;
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
    for (const surface of SURFACES.filter((s) => s.id !== 'sitemaps' && s.expected !== undefined)) {
      const expected = surface.expected?.().sort();
      expect(
        built.filter((path) => surfaceOf(path)?.id === surface.id),
        surface.id,
      ).toEqual(expected);
    }
  });

  it('builds a chart for each procedure that has a state figure, and a procedure for each chart', () => {
    const withStates = surgeryRefs()
      .filter((ref) => ref.kind === 'procedure')
      .filter((ref) => readSurgery('procedure', ref.slug).benchmarks.states.length > 0)
      .map((ref) => `/charts/${ref.urlSlug}.svg`)
      .sort();
    const charts = built.filter((path) => path.startsWith('/charts/'));
    expect(withStates.length).toBeGreaterThan(0);
    expect(charts).toEqual(withStates);
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

const ORIGIN = 'https://surgerywaits.au';
// The Worker serves these two addresses, so the build writes no file for them.
const WORKER_ADDRESSES = ['/mcp', '/mcp/', '/mcp/server-card', '/index.html.md'];
// A page address is a folder with an index file; any other address is a file.
const exists = (path: string): boolean =>
  existsSync(new URL(`.${path.endsWith('/') ? `${path}index.html` : path}`, dist));
const linkLine = /^- \[[^\]]+\]\((https:\/\/surgerywaits\.au\/\S*)\)(: .+)?$/u;
const terms = termsSchema.parse(readContent().find(({ path }) => path === 'terms.yaml')?.data);

describe('llms.txt and llms-full.txt', () => {
  const llms = read('/llms.txt');
  const full = read('/llms-full.txt');
  const lines = llms.split('\n');

  it('follow the llms.txt format: an H1, a blockquote, then H2 sections of links', () => {
    expect(lines[0]).toBe('# Surgery Waits');
    expect(lines[2]).toMatch(/^> \S/u);
    expect(lines.filter((line) => line.startsWith('# '))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('## ')).length).toBeGreaterThanOrEqual(5);
    for (const line of lines.filter((l) => l.startsWith('- '))) {
      expect(line).toMatch(linkLine);
    }
    expect(llms).toMatch(/[^\n]\n$/u);
    expect(full).toMatch(/[^\n]\n$/u);
    expect(full.split('\n').filter((line) => line.startsWith('# '))).toEqual(['# Surgery Waits']);
  });

  it('link only to pages and files that the build wrote', () => {
    const urls = [...llms.matchAll(/\]\((\S+?)\)/gu)].map((m) => m[1] ?? '');
    expect(urls.length).toBeGreaterThan(20);
    for (const url of urls) {
      const parsed = new URL(url);
      expect(parsed.origin, url).toBe(ORIGIN);
      const path = parsed.pathname;
      expect(WORKER_ADDRESSES.includes(path) || exists(path), url).toBe(true);
    }
    for (const [, url = ''] of full.matchAll(/\]\((https:\/\/\S+?)\)/gu)) {
      const parsed = new URL(url);
      if (parsed.origin === ORIGIN) {
        expect(exists(parsed.pathname), url).toBe(true);
      }
    }
  });

  it('list the key pages, the data files, the schemas and each other', () => {
    for (const path of ['/', '/guides/', '/methodology/', '/data/', '/compare/', '/agents/']) {
      expect(llms, path).toContain(`](${ORIGIN}${path})`);
    }
    for (const surface of SURFACES.filter((s) => s.listed !== undefined)) {
      for (const { path } of surface.listed?.() ?? []) {
        expect(llms, path).toContain(`](${ORIGIN}${path})`);
      }
    }
    expect(llms).toContain(`](${ORIGIN}/llms-full.txt)`);
  });

  it('say every credited dataset once, with its licence', () => {
    const { sources } = readDist('credits.json') as {
      sources: { title: string; licence: string; dataset_url: string }[];
    };
    for (const source of sources) {
      expect(full, source.title).toContain(source.title);
      expect(full, source.dataset_url).toContain(source.dataset_url);
      expect(full, source.licence).toContain(formatLicence(source.licence));
    }
  });

  it('use no term the terms file replaces, apart from the quotes listed for llms-full', () => {
    expect(replacedTerms('llms', [llms], terms)).toEqual([]);
    expect(replacedTerms('llms-full', [full], terms)).toEqual([]);
    expect(replacedTerms('llms', [full], terms).length).toBeGreaterThan(0);
  });

  it('keep the word elective to the methodology section and the credit lines', () => {
    const credits = full.indexOf(`### ${label('passport_heading')}`);
    const methodology = full.indexOf(`## ${getMethodology().heading}\n`);
    const nextSection = full.indexOf('\n## ', methodology + 1);
    expect(credits).toBeGreaterThan(0);
    expect(methodology).toBeGreaterThan(0);
    expect(nextSection).toBeGreaterThan(methodology);
    const outside = full.slice(0, methodology) + full.slice(nextSection, credits);
    expect(outside).not.toMatch(/elective/iu);
    expect(full.slice(methodology, nextSection)).toMatch(/elective/iu);
    for (const line of full.slice(credits).split('\n').slice(1)) {
      expect(line === '' || /^( {2})?- /u.test(line), line).toBe(true);
    }
  });

  it('stay within a size an agent can fetch in one read', () => {
    expect(Buffer.byteLength(llms)).toBeLessThan(10_000);
    expect(Buffer.byteLength(full)).toBeLessThan(60_000);
  });
});

// The folders the agents page names; the copy calls each one a folder, and none has a page.
const NAMED_FOLDERS = ['/data-api/', '/contract/', '/charts/'];
const textOf = (html: string): string => textsOf(html, 'main')[0] ?? '';
// Every address inside the site that a text names, with the sentence's closing stop left off.
const addressesIn = (text: string): string[] =>
  [...text.matchAll(/(?<![\w:/.-])\/[A-Za-z0-9][A-Za-z0-9._/-]*/gu)].map((m) =>
    m[0].replace(/[.,;:]+$/u, ''),
  );
const sentencesWith = (text: string, phrase: string): string[] =>
  text.split(/(?<=\.)\s+(?=[A-Z])/u).filter((sentence) => sentence.includes(phrase));

describe('the agents page', () => {
  const html = read('/agents/index.html');
  const text = textOf(html);

  it('names the signal robots.txt carries and the headers the Worker sets', () => {
    expect(html).toContain(/^Content-Signal: .+$/mu.exec(read('/robots.txt'))?.[0] ?? '?');
    expect(html).toContain('public, max-age=3600');
  });

  it('names exactly the headings that the built llms.txt has', () => {
    const headings = [...read('/llms.txt').matchAll(/^## (.+)$/gmu)].map((m) => m[1] ?? '');
    expect(headings.length).toBeGreaterThan(0);
    expect(text).toContain(
      `Read /llms.txt first. It groups its links under these headings: ${formatList(headings.map((heading) => `“${heading}”`))}.`,
    );
  });

  it('states each value of the content signal that robots.txt carries', () => {
    const line = /^Content-Signal: (.+)$/mu.exec(read('/robots.txt'))?.[1] ?? '?';
    const sentence = sentencesWith(text, 'It sets ')[0] ?? '';
    for (const [name, value] of Object.entries(CONTENT_SIGNALS)) {
      expect(line, name).toContain(`${name}=${value}`);
      expect(sentence, name).toContain(`${name} to ${value}`);
    }
  });

  it('gives only example addresses that the build wrote', () => {
    const examples = [
      ...html.matchAll(/<a class=\x22c-index-list__name\x22 href=\x22([^\x22]+)\x22/gu),
    ].map((m) => m[1] ?? '');
    expect(examples.length).toBeGreaterThanOrEqual(5);
    for (const path of examples) {
      expect(exists(path), path).toBe(true);
    }
  });

  it('names each protocol revision and tool that the Worker gives', async () => {
    const remotes = serverCard()['remotes'] as { supportedProtocolVersions: string[] }[];
    for (const version of remotes[0]?.supportedProtocolVersions ?? ['?']) {
      expect(text, version).toContain(version);
    }
    const meta = {
      'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const response = await handle(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': MODERN_VERSION,
          'Mcp-Method': 'tools/list',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: meta },
        }),
      }),
      {},
    );
    const { result } = (await response.json()) as { result: { tools: { name: string }[] } };
    const served = result.tools.map(({ name }) => name).sort();
    expect(served).toEqual(Object.keys(SPECS).sort());
    for (const name of served) {
      expect(text, name).toContain(name);
    }
    expect(text).toContain('/mcp/server-card');
  });

  it('names an address only when it is a built file or page or a folder the copy calls a folder', async () => {
    const named = addressesIn(text);
    expect(named.length).toBeGreaterThan(15);
    for (const address of new Set(named)) {
      if (WORKER_ADDRESSES.includes(address)) {
        const answer = await handle(new Request(`${ORIGIN}${address}`), env);
        expect(answer.status, address).not.toBe(404);
      } else if (NAMED_FOLDERS.includes(address)) {
        expect(text, address).toContain(`folder ${address}`);
        expect(exists(address), `${address} has a page`).toBe(false);
        expect(
          built.some((path) => path.startsWith(address)),
          `${address} holds no file`,
        ).toBe(true);
      } else {
        expect(exists(address), address).toBe(true);
      }
    }
  });
});

describe('the Worker behaviour the agents page describes', () => {
  const call = (path: string, method: string, origin?: string): Promise<Response> =>
    handle(
      new Request(`${ORIGIN}${path}`, {
        method,
        ...(origin === undefined ? {} : { headers: { Origin: origin } }),
        ...(method === 'POST' ? { body: '{}' } : {}),
      }),
      env,
    );
  const FOREIGN = 'https://evil.example';

  it('refuses a foreign Origin at /mcp with 403 for any method', async () => {
    for (const method of ['POST', 'GET', 'OPTIONS']) {
      expect((await call('/mcp', method, FOREIGN)).status, method).toBe(403);
    }
  });

  it('answers another method at /mcp with 405 when the Origin is absent or accepted', async () => {
    for (const origin of [undefined, ORIGIN]) {
      const response = await call('/mcp', 'GET', origin);
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST, OPTIONS');
    }
  });

  it('accepts a POST at /mcp with no Origin', async () => {
    const response = await call('/mcp', 'POST');
    expect([403, 405]).not.toContain(response.status);
  });

  it('answers OPTIONS at /mcp with 204, and at the card with 204', async () => {
    expect((await call('/mcp', 'OPTIONS')).status).toBe(204);
    expect((await call('/mcp/server-card', 'OPTIONS')).status).toBe(204);
  });

  it('answers a method other than GET and HEAD on a page with 405', async () => {
    expect((await call('/', 'DELETE')).status).toBe(405);
  });

  it('answers HEAD on a page and refuses PUT with 405', async () => {
    const head = await call('/', 'HEAD');
    expect(head.status).toBe(200);
    expect((await call('/', 'PUT')).status).toBe(405);
  });

  it('answers /mcp/ as the MCP route', async () => {
    expect((await call('/mcp/', 'GET')).status).toBe(405);
    expect((await call('/mcp/', 'OPTIONS')).status).toBe(204);
  });

  it('answers OPTIONS under /data-api/ with 204', async () => {
    expect((await call('/data-api/index.json', 'OPTIONS')).status).toBe(204);
  });

  it('answers a missing data file with 404 and a JSON body', async () => {
    const response = await call('/data-api/missing.json', 'GET');
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    const body = await response.text();
    expect(() => {
      JSON.parse(body);
    }).not.toThrow();
  });

  it('gives a data file the CORS header that the copy states', async () => {
    const response = await call('/data-api/index.json', 'GET');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      ALLOW_ANY_ORIGIN['Access-Control-Allow-Origin'],
    );
    expect(textOf(read('/agents/index.html'))).toContain(
      `Access-Control-Allow-Origin: ${agentFacts()['cors_origin'] ?? '?'}`,
    );
  });

  it('gives the Markdown version the headers and the status that the copy states', async () => {
    const facts = agentFacts();
    const text = textOf(read('/agents/index.html'));
    const asked = await handle(
      new Request(`${ORIGIN}/hospitals/`, { headers: { Accept: 'text/markdown' } }),
      env,
    );
    expect(asked.headers.get('Content-Type')).toBe(facts['twin_type']);
    expect(text).toContain(`Content-Type: ${facts['twin_type'] ?? '?'}, Vary: Accept`);
    expect(asked.headers.get('Vary')).toBe('Accept');
    expect(asked.headers.get('Content-Location')).toBe(facts['twin_example']);
    expect(asked.headers.get('Link')).toBe(`<${ORIGIN}/hospitals/>; rel="canonical"`);
    expect(new URL(ORIGIN).host).toBe(facts['twin_canonical_host']);
    expect(text).toContain(
      `the full address of its page on ${facts['twin_canonical_host'] ?? '?'}`,
    );
    const moved = await call('/hospitals/index.md', 'GET');
    expect(String(moved.status)).toBe(facts['twin_redirect']);
    expect(text).toContain(`receives status ${facts['twin_redirect'] ?? '?'}`);
    expect(text).toContain(`the version ${facts['twin_home'] ?? '?'}`);
    expect(text).toContain('a page address other than / followed by index.md');
    const homeMoved = await call('/index.html.md', 'GET');
    expect(String(homeMoved.status)).toBe(facts['twin_redirect']);
    expect(text).toContain('A request for /index.html.md receives the same status');
    const home = await call('/index.md', 'GET');
    expect(home.status).toBe(200);
    expect(text).toContain('a request for /index.md returns the home version');
    const missing = await call('/hospitals/none.md', 'GET');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Content-Type')).toBe(facts['twin_type']);
    const dataMissing = await call('/data-api/none.md', 'GET');
    expect(dataMissing.status).toBe(404);
    expect(dataMissing.headers.get('Content-Type')).toContain('application/json');
    expect(text).toContain(
      'A version that does not exist at an address outside /data-api/ returns status 404 with a Markdown body',
    );
    const page = await call('/hospitals/', 'GET');
    expect(page.headers.get('Link')).toBe(
      `<${facts['twin_example'] ?? '?'}>; rel="alternate"; type="text/markdown"`,
    );
  });

  it('gives the cache headers that the copy states', async () => {
    const facts = agentFacts();
    const pairs = [
      ['/', 'page_cache'],
      ['/robots.txt', 'robots_cache'],
      ['/data-api/index.json', 'data_cache'],
    ] as const;
    for (const [path, key] of pairs) {
      const response = await call(path, 'GET');
      expect(response.headers.get('Cache-Control'), path).toBe(facts[key]);
    }
  });
});

describe('the sentences about the data files', () => {
  const dataFiles = built.filter((path) => path.startsWith('/data-api/') && path.endsWith('.json'));
  // The files that carry no sources entry, read from the build so the sentence cannot go stale.
  const withoutSources = dataFiles
    .filter((path) => {
      const document = JSON.parse(read(path)) as Record<string, unknown>;
      return !('sources' in document);
    })
    .sort();

  it('say which files have no sources entry, and name exactly those', () => {
    expect(withoutSources).toContain('/data-api/rules.json');
    expect(withoutSources).toContain('/data-api/openapi.json');
    for (const page of ['/agents/index.html', '/data/index.html']) {
      const sentences = sentencesWith(textOf(read(page)), 'sources entry');
      expect(sentences, page).toHaveLength(1);
      const named = addressesIn(sentences[0] ?? '')
        .filter((address) => address.endsWith('.json'))
        .sort();
      expect(named, page).toEqual(withoutSources);
    }
  });

  it('tell the withheld states apart on the agents and data pages', () => {
    for (const page of ['/agents/index.html', '/data/index.html']) {
      const text = textOf(read(page));
      expect(text, page).toContain(
        'the state not_published when the publisher gives a code or a withheld mark instead of a number',
      );
      expect(text, page).toContain('the state not_reported when the source leaves it empty');
    }
  });
});

describe('the agent catalog', () => {
  interface Entry {
    identifier: string;
    displayName: string;
    description: string;
    type: string;
    url: string;
    representativeQueries: string[];
  }
  const parse = (path: string): { host: Record<string, string>; entries: Entry[] } =>
    JSON.parse(read(path)) as { host: Record<string, string>; entries: Entry[] };
  const { entries, host } = parse(CATALOG_PATHS[0] ?? '?');
  const cataloged = SURFACES.filter((s) => s.catalog !== undefined);

  it('is built at both addresses with one body', () => {
    expect(CATALOG_PATHS).toHaveLength(2);
    for (const path of CATALOG_PATHS) {
      expect(built, path).toContain(path);
    }
    expect(read(CATALOG_PATHS[0] ?? '?')).toBe(read(CATALOG_PATHS[1] ?? '?'));
  });

  it('serves both addresses through the Worker with one media type, one body and open CORS', async () => {
    const answers = await Promise.all(
      CATALOG_PATHS.map((path) => handle(new Request(`${ORIGIN}${path}`), env)),
    );
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(answer.headers.get('Content-Type')).toBe(`${CATALOG_MEDIA_TYPE}; charset=utf-8`);
      expect(answer.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(answer.headers.get('Cache-Control')).toBe('public, max-age=3600');
    }
    const [first, second] = await Promise.all(answers.map((answer) => answer.text()));
    expect(first).toBe(second);
  });

  it('answers HEAD with 200 and the catalog media type, and OPTIONS with 405 and the same headers', async () => {
    for (const path of CATALOG_PATHS) {
      const head = await handle(new Request(`${ORIGIN}${path}`, { method: 'HEAD' }), env);
      expect(head.status, path).toBe(200);
      expect(head.headers.get('Content-Type'), path).toBe(`${CATALOG_MEDIA_TYPE}; charset=utf-8`);
      const options = await handle(new Request(`${ORIGIN}${path}`, { method: 'OPTIONS' }), env);
      expect(options.status, path).toBe(405);
      expect(options.headers.get('Allow'), path).toBe('GET, HEAD');
      expect(options.headers.get('Content-Type'), path).toBe(
        `${CATALOG_MEDIA_TYPE}; charset=utf-8`,
      );
      expect(options.headers.get('Cache-Control'), path).toBe('public, max-age=3600');
    }
  });

  it('leaves the catalog headers off a 404 on a catalog path', () => {
    for (const path of CATALOG_PATHS) {
      const missing = withHeaders(
        new Response('<p>missing</p>', {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
        path,
      );
      expect(missing.headers.get('Content-Type'), path).toBe('text/html; charset=utf-8');
      expect(missing.headers.get('Access-Control-Allow-Origin'), path).toBeNull();
    }
  });

  it('has one entry for each surface that names one, each with a unique id', () => {
    expect(cataloged.length).toBeGreaterThan(0);
    expect(entries).toHaveLength(cataloged.length);
    const ids = entries.map((e) => e.identifier);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^urn:air:surgerywaits\.au:[a-z-]+:[a-z-]+$/u);
    }
    expect(new Set(entries.map((e) => e.displayName)).size).toBe(entries.length);
  });

  it('resolves every entry to a built file or a Worker route that answers 200', async () => {
    for (const entry of entries) {
      const url = new URL(entry.url);
      expect(url.origin, entry.url).toBe(ORIGIN);
      if (WORKER_ADDRESSES.includes(url.pathname)) {
        const answer = await handle(new Request(entry.url), env);
        expect(answer.status, entry.url).toBe(200);
      } else {
        expect(exists(url.pathname), entry.url).toBe(true);
      }
    }
  });

  it('names an address that its surface serves, with the type the surface gives', () => {
    for (const surface of cataloged) {
      const found = entries.find((e) => new URL(e.url).pathname === surface.catalog?.path);
      expect(found?.type, surface.id).toBe(surface.catalog?.type);
      expect(surfaceOf(surface.catalog?.path ?? '?')?.id, surface.id).toBeDefined();
    }
  });

  it('gives each entry words and at least one question', () => {
    for (const entry of entries) {
      expect(entry.displayName.length, entry.identifier).toBeGreaterThan(0);
      expect(entry.description, entry.identifier).toMatch(/\.$/u);
      expect(entry.representativeQueries.length, entry.identifier).toBeGreaterThan(0);
      expect(entry.description + entry.displayName, entry.identifier).not.toMatch(/[{}]/u);
    }
  });

  it('names the site, its did and its agents page as the host, and the page exists', () => {
    expect(host['identifier']).toBe('did:web:surgerywaits.au');
    expect(host['displayName']).toBe('Surgery Waits');
    expect(new URL(host['documentationUrl'] ?? '?').origin).toBe(ORIGIN);
    expect(exists(new URL(host['documentationUrl'] ?? '?').pathname)).toBe(true);
  });

  it('says the MCP tools are read-only only when each tool declares it', () => {
    const mcp = entries.find((e) => e.identifier.endsWith(':mcp:server'));
    expect(mcp?.description).toContain('read-only');
    expect(TOOLS.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
  });

  it('is listed by llms.txt and named on the agents page with both addresses', () => {
    expect(read('/llms.txt')).toContain(`](${ORIGIN}${CATALOG_PATHS[1] ?? '?'})`);
    const text = textOf(read('/agents/index.html'));
    for (const path of CATALOG_PATHS) {
      expect(text, path).toContain(path);
    }
    for (const entry of entries) {
      expect(text, entry.displayName).toContain(entry.displayName);
    }
  });
});

describe('the read-only claim on the agents page', () => {
  it('appears as the page says it, from tools that all declare the hint', () => {
    expect(TOOLS.length).toBe(Object.keys(SPECS).length);
    expect(agentFacts()['mcp_access']).toBe('read-only');
    expect(textOf(read('/agents/index.html'))).toContain(
      `The server has these read-only tools: ${agentFacts()['mcp_tools'] ?? '?'}.`,
    );
  });
});
