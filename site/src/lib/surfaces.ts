import { dataApiPaths } from './data-api';
import { contractSchemas } from './dist';
import { stateChartFiles } from './state-chart';

export interface Surface {
  id: string;
  // Matches the site path of each file the surface serves.
  pattern: RegExp;
  mediaType: string;
  purpose: string;
  // The paths the build must write for this surface, where the sources name them.
  expected?: () => string[];
}

// Every machine-readable file the site serves; a new surface is added here with its own entry.
export const SURFACES: readonly Surface[] = [
  {
    id: 'data-files',
    pattern: /^\/data-api\/.+\.json$/u,
    mediaType: 'application/json',
    purpose: 'The dist files the pages are built from, each valid against its published schema.',
    expected: () => dataApiPaths().map((path) => `/data-api/${path}`),
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
    expected: () => ['/tool/figures.json', '/tool/index.json', '/tool/places.json'],
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
  },
];

// The surface that serves a path, if one does.
export const surfaceOf = (path: string): Surface | undefined =>
  SURFACES.find((surface) => surface.pattern.test(path));

const TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  txt: 'text/plain',
};

// The type a static host gives a file from its extension.
export const mediaTypeOf = (path: string): string | undefined =>
  TYPES[path.slice(path.lastIndexOf('.') + 1)];
