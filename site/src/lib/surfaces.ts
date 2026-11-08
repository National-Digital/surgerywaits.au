import { readdirSync } from 'node:fs';

import { CATALOG_MEDIA_TYPE, CATALOG_PATH, CATALOG_PATHS } from '../../../worker/headers';
import { MCP_CARD_PATH } from '../../../worker/mcp';
import { dataApiPaths } from './data-api';
import { contractSchemas } from './dist';
import { OPENAPI_PATH } from './openapi';
import { SECURITY_TXT_PATH } from './security-txt';
import { stateChartFiles } from './state-chart';

// A file that llms.txt lists, with its address inside the site.
export interface Listed {
  // Keys the line about the file in site/content/pages/agents.yaml.
  id: string;
  label: string;
  path: string;
  // Given when the file carries its own note; otherwise agents.yaml holds it under the id.
  note?: string;
}

export type ListGroup = 'data' | 'schemas' | 'site';

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
  // The files /llms.txt lists for this surface, and the section they go under.
  group?: ListGroup;
  listed?: () => Listed[];
  // Set when the agent catalog lists the surface: its id in the catalog, its type and its address.
  catalog?: { urn: string; type: string; path: string };
}

// The data files that name the others; each is listed only when the build writes it.
const DATA_ENTRIES: readonly Listed[] = [
  {
    label: 'Counts and scope',
    path: '/data-api/index.json',
    id: 'data-files.index',
  },
  {
    label: 'Credits',
    path: '/data-api/credits.json',
    id: 'data-files.credits',
  },
  {
    label: 'Rules',
    path: '/data-api/rules.json',
    id: 'data-files.rules',
  },
  { label: 'Surgeries', path: '/data-api/surgeries.json', id: 'data-files.surgeries' },
  { label: 'Hospitals', path: '/data-api/hospitals.json', id: 'data-files.hospitals' },
  {
    label: 'Health services',
    path: '/data-api/health-services.json',
    id: 'data-files.health-services',
  },
];

// Each schema says in its own description what it covers, so the router repeats that text.
export const schemaNote = (name: string, schema: unknown): string => {
  const { description } = schema as { description?: unknown };
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error(`${name}.schema.json has no description`);
  }
  // A leading file name becomes the subject, and a placeholder in a path stays literal in Markdown.
  const [, file, rest] = /^(\S+\.json): (.+)$/su.exec(description) ?? [];
  const text =
    file === undefined || rest === undefined ? description : `The file ${file} holds ${rest}`;
  return text.replace(/\S*<[a-z]+>\S*?\.json/gu, (path) => `\`${path}\``);
};

// llms.txt format: an H1, a blockquote, then H2 sections of links, each with an absolute address.
const llmsProblem = (body: string): string | undefined => {
  const lines = body.trimEnd().split('\n');
  if (!/^# \S/u.test(lines[0] ?? '')) {
    return 'no H1 on the first line';
  }
  if (!lines.some((line) => line.startsWith('> '))) {
    return 'no blockquote summary';
  }
  if (!lines.some((line) => line.startsWith('## '))) {
    return 'no H2 section';
  }
  return undefined;
};

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

// The catalog follows the AI Catalog shape: a version, a host and entries that each name an address.
const catalogProblem = (body: string): string | undefined => {
  const document = JSON.parse(body) as { specVersion?: unknown; host?: unknown; entries?: unknown };
  if (typeof document.specVersion !== 'string') {
    return 'no specVersion';
  }
  if (typeof document.host !== 'object' || document.host === null) {
    return 'no host';
  }
  if (!Array.isArray(document.entries) || document.entries.length === 0) {
    return 'no entries';
  }
  for (const entry of document.entries as Record<string, unknown>[]) {
    for (const field of ['identifier', 'url', 'type']) {
      if (typeof entry[field] !== 'string') {
        return `an entry has no ${field}`;
      }
    }
    const queries = entry['representativeQueries'];
    if (!Array.isArray(queries) || queries.length === 0) {
      return 'an entry has no representativeQueries';
    }
  }
  return undefined;
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
    group: 'data',
    listed: (): Listed[] => {
      const built = new Set(dataApiPaths().map((path) => `/data-api/${path}`));
      return DATA_ENTRIES.filter((entry) => built.has(entry.path));
    },
  },
  {
    id: 'openapi',
    pattern: /^\/data-api\/openapi\.json$/u,
    mediaType: 'application/json',
    purpose: 'The OpenAPI 3.1 description of the data files, generated from the schemas.',
    catalog: {
      urn: 'openapi:data-api',
      type: 'application/vnd.oai.openapi+json',
      path: OPENAPI_PATH,
    },
    expected: () => [OPENAPI_PATH],
    check: openApiProblem,
    group: 'data',
    listed: () => [{ id: 'openapi', label: 'OpenAPI description', path: OPENAPI_PATH }],
  },
  {
    id: 'schemas',
    pattern: /^\/contract\/[a-z0-9-]+\.schema\.json$/u,
    mediaType: 'application/json',
    purpose: 'The JSON Schema for each family of data file.',
    expected: () => contractSchemas().map(([name]) => `/contract/${name}.schema.json`),
    group: 'schemas',
    listed: () =>
      contractSchemas().map(([name, schema]) => ({
        id: `schemas.${name}`,
        label: `${name}.schema.json`,
        path: `/contract/${name}.schema.json`,
        note: schemaNote(name, schema),
      })),
  },
  {
    id: 'charts',
    pattern: /^\/charts\/[a-z0-9-]+\.svg$/u,
    mediaType: 'image/svg+xml',
    purpose:
      'A chart of the median wait in each state for each procedure that has a state figure, as a standalone SVG.',
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
    group: 'site',
    listed: () => [{ id: 'sitemaps', label: 'Sitemap', path: '/sitemap.xml' }],
  },
  {
    id: 'robots',
    pattern: /^\/robots\.txt$/u,
    mediaType: 'text/plain',
    purpose: 'The crawl rules and the content signals for search and AI use.',
    expected: () => ['/robots.txt'],
    check: robotsProblem,
    group: 'site',
    listed: () => [{ id: 'robots', label: 'robots.txt', path: '/robots.txt' }],
  },
  {
    id: 'llms',
    pattern: /^\/llms\.txt$/u,
    mediaType: 'text/plain',
    purpose:
      'The router that links to the pages and files an agent reads first, grouped by heading.',
    expected: () => ['/llms.txt'],
    check: llmsProblem,
    catalog: { urn: 'llms:index', type: 'text/plain', path: '/llms.txt' },
  },
  {
    id: 'llms-full',
    pattern: /^\/llms-full\.txt$/u,
    mediaType: 'text/plain',
    purpose: 'The about, methodology and data pages and the credits as one plain-text file.',
    expected: () => ['/llms-full.txt'],
    check: llmsProblem,
    group: 'site',
    listed: () => [{ id: 'llms-full', label: 'llms-full.txt', path: '/llms-full.txt' }],
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
    id: 'agent-catalog',
    pattern: /^\/\.well-known\/(ard|ai-catalog)\.json$/u,
    mediaType: CATALOG_MEDIA_TYPE,
    purpose:
      'The catalog of the files and the server an agent can read, at two addresses with one body.',
    expected: () => [...CATALOG_PATHS],
    check: catalogProblem,
    group: 'site',
    listed: () => [{ id: 'agent-catalog', label: 'Agent catalog', path: CATALOG_PATH }],
  },
  {
    id: 'mcp-server-card',
    pattern: /^\/mcp\/server-card$/u,
    mediaType: 'application/json',
    purpose: 'The MCP server card, served by the Worker, so no build file carries it.',
    expected: () => [],
    catalog: {
      urn: 'mcp:server',
      type: 'application/mcp-server-card+json',
      path: MCP_CARD_PATH,
    },
    group: 'site',
    listed: () => [{ id: 'mcp-server-card', label: 'MCP server card', path: MCP_CARD_PATH }],
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
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
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
