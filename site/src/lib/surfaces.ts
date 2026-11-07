import { readdirSync } from 'node:fs';

import { dataApiPaths } from './data-api';
import { contractSchemas } from './dist';
import { OPENAPI_PATH } from './openapi';
import { SECURITY_TXT_PATH } from './security-txt';
import { stateChartFiles } from './state-chart';

export interface Surface {
  id: string;
  // Matches the site path of each file the surface serves.
  pattern: RegExp;
  mediaType: string;
  purpose: string;
  // The paths the build must write for this surface, where the sources name them.
  expected?: () => string[];
  // Why a body is not what this surface promises, beyond what its media type needs.
  check?: (body: string) => string | undefined;
}

const robotsProblem = (body: string): string | undefined => {
  if (!/^User-agent: \S/mu.test(body)) {
    return 'no User-agent line';
  }
  if (!/^Content-Signal: \S/mu.test(body)) {
    return 'no Content-Signal line';
  }
  return /^Sitemap: https?:\/\/\S+$/mu.test(body) ? undefined : 'no Sitemap line';
};

// RFC 9116: Contact and Expires are required; the others are present on this site.
const securityProblem = (body: string): string | undefined => {
  for (const field of ['Contact', 'Expires', 'Preferred-Languages', 'Canonical', 'Policy']) {
    if (!new RegExp(`^${field}: \\S`, 'mu').test(body)) {
      return `no ${field} field`;
    }
  }
  return Number.isNaN(Date.parse(/^Expires: (\S+)$/mu.exec(body)?.[1] ?? ''))
    ? 'bad Expires'
    : undefined;
};

const openApiProblem = (body: string): string | undefined => {
  const document = JSON.parse(body) as { openapi?: unknown };
  return typeof document.openapi === 'string' && document.openapi.startsWith('3.1.')
    ? undefined
    : 'not an OpenAPI 3.1 document';
};

// Every machine-readable file the site serves.
// A new surface is added here with its own entry.
export const SURFACES: readonly Surface[] = [
  {
    id: 'data-files',
    pattern: /^\/data-api\/(?!openapi\.json$).+\.json$/u,
    mediaType: 'application/json',
    purpose: 'The dist files the pages are built from, each valid against its published schema.',
    expected: () => dataApiPaths().map((path) => `/data-api/${path}`),
  },
  {
    id: 'openapi',
    pattern: /^\/data-api\/openapi\.json$/u,
    mediaType: 'application/json',
    purpose: 'The OpenAPI 3.1 description of the data files, generated from the schemas.',
    expected: () => [OPENAPI_PATH],
    check: openApiProblem,
  },
  {
    id: 'schemas',
    pattern: /^\/contract\/[a-z0-9-]+\.schema\.json$/u,
    mediaType: 'application/json',
    purpose: 'The JSON Schema for each family of data file.',
    expected: () => contractSchemas().map(([name]) => `/contract/${name}.schema.json`),
  },
  {
    id: 'charts',
    pattern: /^\/charts\/[a-z0-9-]+\.svg$/u,
    mediaType: 'image/svg+xml',
    purpose: 'One median-wait chart for each procedure, as a standalone SVG.',
    expected: () => stateChartFiles().map(({ slug }) => `/charts/${slug}.svg`),
  },
  {
    id: 'tool-files',
    pattern: /^\/tool\/(figures|index|places)\.json$/u,
    mediaType: 'application/json',
    purpose: 'The three files the compare tool fetches.',
    expected: () =>
      readdirSync(new URL('../pages/tool/', import.meta.url))
        .filter((file) => file.endsWith('.json.ts'))
        .map((file) => `/tool/${file.slice(0, -'.ts'.length)}`),
  },
  {
    id: 'sitemaps',
    pattern: /^\/sitemap(-[a-z0-9-]+)?\.xml$/u,
    mediaType: 'application/xml',
    purpose: 'The sitemap index and one file for each family of indexable pages.',
    expected: () => ['/sitemap.xml'],
  },
  {
    id: 'robots',
    pattern: /^\/robots\.txt$/u,
    mediaType: 'text/plain',
    purpose: 'The crawl rules and the content signals for search and AI use.',
    expected: () => ['/robots.txt'],
    check: robotsProblem,
  },
  {
    id: 'security',
    pattern: /^\/\.well-known\/security\.txt$/u,
    mediaType: 'text/plain',
    purpose: 'The security contact, policy and expiry that RFC 9116 asks for.',
    expected: () => [SECURITY_TXT_PATH],
    check: securityProblem,
  },
  {
    id: 'mcp-server-card',
    pattern: /^\/mcp\/server-card$/u,
    mediaType: 'application/json',
    purpose: 'The MCP server card, served by the Worker, so no build file carries it.',
    expected: () => [],
  },
];

// The surface that serves a path, if one does.
export const surfaceOf = (path: string): Surface | undefined =>
  SURFACES.find((surface) => surface.pattern.test(path));

// The build's own pages and hashed script, style and font files are not surfaces.
const BUILD_ASSET =
  /^(\/.+\.html|\/_astro\/[^/]+\.[A-Za-z0-9_-]{8}\.(js|css)|\/fonts\/[^/]+\.woff2?|\/fonts\/OFL\.txt)$/u;
export const isBuildAsset = (path: string): boolean => BUILD_ASSET.test(path);

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)(?:\s[^<>]*?)?(\/?)>/gu;
const ROOTS: Readonly<Record<string, RegExp>> = {
  'application/xml': /^(urlset|sitemapindex)$/u,
  'image/svg+xml': /^svg$/u,
};

// One pass from left to right, so a removal never joins text into a new opener.
function withoutMarkup(body: string): string | undefined {
  const pairs: readonly (readonly [string, string])[] = [
    ['<!--', '-->'],
    ['<?', '?>'],
    ['<![CDATA[', ']]>'],
  ];
  let out = '';
  let at = 0;
  for (;;) {
    const next = pairs
      .map(([open, close]) => ({ open, close, index: body.indexOf(open, at) }))
      .filter((p) => p.index >= 0)
      .sort((a, b) => a.index - b.index)[0];
    if (next === undefined) {
      return (out + body.slice(at)).trim();
    }
    const stop = body.indexOf(next.close, next.index + next.open.length);
    if (stop < 0) {
      return undefined;
    }
    out += body.slice(at, next.index);
    at = stop + next.close.length;
  }
}

// A tag stack: one root of the expected name and every tag closed in order.
function xmlProblem(body: string, root: RegExp): string | undefined {
  const bare = withoutMarkup(body);
  if (bare === undefined) {
    return 'unclosed comment, instruction or CDATA';
  }
  const stack: string[] = [];
  let rootName: string | undefined;
  for (const [, closing, name = '', selfClosing] of bare.matchAll(TAG)) {
    if (closing === '/') {
      if (stack.pop() !== name) {
        return `unmatched </${name}>`;
      }
    } else {
      if (stack.length === 0) {
        if (rootName !== undefined) {
          return 'second root';
        }
        rootName = name;
      }
      if (selfClosing !== '/') {
        stack.push(name);
      }
    }
  }
  if (rootName === undefined || !root.test(rootName)) {
    return 'wrong or missing root';
  }
  if (stack.length > 0) {
    return 'unclosed tag';
  }
  if (!bare.startsWith('<') || !bare.endsWith('>') || bare.replace(TAG, '').includes('<')) {
    return 'content outside the root or a broken tag';
  }
  return undefined;
}

// Why a body is not what its media type promises, if it is not.
export function bodyProblem(mediaType: string, body: string): string | undefined {
  if (body.trim() === '') {
    return 'empty';
  }
  const root = ROOTS[mediaType];
  if (root !== undefined) {
    return xmlProblem(body, root);
  }
  if (mediaType === 'application/json') {
    try {
      JSON.parse(body);
    } catch {
      return 'invalid JSON';
    }
  }
  return undefined;
}

// The media-type check, then the check of the surface that serves the path.
export const surfaceBodyProblem = (path: string, body: string): string | undefined => {
  const surface = surfaceOf(path);
  return surface === undefined
    ? 'no surface'
    : (bodyProblem(surface.mediaType, body) ?? surface.check?.(body));
};
