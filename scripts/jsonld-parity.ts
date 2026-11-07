// Proves a build's JSON-LD @id and type set covers a baseline taken from the earlier site, with additions only.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

export interface Node {
  id: string;
  type: string;
}
interface Family {
  family: string;
  types: string[];
  count: number;
}
export interface Baseline {
  origin: string;
  // Every node whose @id is not a page's own.
  nodes: Node[];
  // A small family lists its page nodes by path, and a large one by count.
  pages: { path: string; type: string }[];
  families: Family[];
}
export interface Report {
  missing: Node[];
  retired: Node[];
  added: Node[];
  shortfalls: string[];
}

const BLOCK = /<script type="application\/ld\+json">(.*?)<\/script>/gsu;
const PAGE_SUFFIX = '#webpage';
const isPageId = (id: string): boolean => id.endsWith(PAGE_SUFFIX);
const LIST_LIMIT = 40;

function nodesIn(value: unknown, found: Node[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => {
      nodesIn(item, found);
    });
  } else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const { '@id': id, '@type': type } = record;
    if (typeof id === 'string' && typeof type === 'string') {
      found.push({ id, type });
    }
    Object.values(record).forEach((item) => {
      nodesIn(item, found);
    });
  }
}

// Every node with both an @id and a type in a page's JSON-LD blocks.
export function extractNodes(html: string): Node[] {
  const found: Node[] = [];
  for (const [, body = ''] of html.matchAll(BLOCK)) {
    nodesIn(JSON.parse(body) as unknown, found);
  }
  return found;
}

// The address a built file answers at.
export const addressOf = (file: string): string => `/${file.replace(/(^|\/)index\.html$/u, '$1')}`;

export function collect(root: string): Map<string, Set<string>> {
  const nodes = new Map<string, Set<string>>();
  for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (file.endsWith('.html')) {
      for (const { id, type } of extractNodes(readFileSync(join(root, file), 'utf8'))) {
        nodes.set(id, (nodes.get(id) ?? new Set()).add(type));
      }
    }
  }
  return nodes;
}

// A page's family is its first segment and its depth, so every hospital pair shares one.
export const familyOf = (path: string): string => {
  const parts = path.split('/').filter(Boolean);
  return [parts[0] ?? '', ...parts.slice(1).map(() => '*')].join('/');
};

const byKey = (a: Node, b: Node): number => (a.id + a.type < b.id + b.type ? -1 : 1);

interface PageNode {
  path: string;
  type: string;
}

// The page nodes among a build's nodes, by the address each describes.
function pageNodes(nodes: Map<string, Set<string>>, origin: string): PageNode[] {
  return [...nodes].flatMap(([id, types]) =>
    isPageId(id)
      ? [...types].map((type) => ({ path: id.slice(origin.length, -PAGE_SUFFIX.length), type }))
      : [],
  );
}

const byPath = (a: PageNode, b: PageNode): number => (a.path < b.path ? -1 : 1);

export function baselineOf(
  nodes: Map<string, Set<string>>,
  origin: string,
  listAll = false,
): Baseline {
  const rest = [...nodes]
    .filter(([id]) => !isPageId(id))
    .flatMap(([id, types]) => [...types].map((type) => ({ id, type })));
  const families = new Map<string, PageNode[]>();
  for (const page of pageNodes(nodes, origin)) {
    families.set(familyOf(page.path), [...(families.get(familyOf(page.path)) ?? []), page]);
  }
  const listed = (pages: PageNode[]): boolean => listAll || pages.length <= LIST_LIMIT;
  return {
    origin,
    nodes: rest.sort(byKey),
    pages: [...families.values()].filter(listed).flat().sort(byPath),
    families: [...families]
      .filter(([, pages]) => !listed(pages))
      .map(([family, pages]) => ({
        family,
        types: [...new Set(pages.map((p) => p.type))].sort(),
        count: pages.length,
      }))
      .sort((a, b) => (a.family < b.family ? -1 : 1)),
  };
}

export function compare(
  baseline: Baseline,
  built: Map<string, Set<string>>,
  // Addresses that answer with a redirect, which have no page of their own.
  redirected: ReadonlySet<string>,
): Report {
  const has = (id: string, type: string): boolean => built.get(id)?.has(type) === true;
  const missing: Node[] = [];
  const retired: Node[] = [];
  for (const node of baseline.nodes) {
    if (!has(node.id, node.type)) {
      missing.push(node);
    }
  }
  for (const { path, type } of baseline.pages) {
    const node = { id: `${baseline.origin}${path}${PAGE_SUFFIX}`, type };
    if (!has(node.id, type)) {
      (redirected.has(path) ? retired : missing).push(node);
    }
  }
  const shortfalls: string[] = [];
  for (const { family, types, count } of baseline.families) {
    const own = (path: string): boolean => familyOf(path) === family;
    const present = [...built].filter(
      ([id, found]) =>
        isPageId(id) &&
        id.startsWith(baseline.origin) &&
        own(id.slice(baseline.origin.length, -PAGE_SUFFIX.length)) &&
        types.some((t) => found.has(t)),
    ).length;
    const moved = [...redirected].filter(own).length;
    if (present + moved < count) {
      shortfalls.push(
        `${family}: ${String(count)} before, ${String(present)} pages and ${String(moved)} redirects now`,
      );
    }
  }
  const known = new Set([
    ...baseline.nodes.map((n) => n.id + n.type),
    ...baseline.pages.map((p) => `${baseline.origin}${p.path}#webpage${p.type}`),
  ]);
  const added: Node[] = [...built].flatMap(([id, types]) =>
    [...types].filter((type) => !known.has(id + type)).map((type) => ({ id, type })),
  );
  return { missing, retired, added: added.sort(byKey), shortfalls };
}

const redirectSources = (): Set<string> => {
  const file = new URL('../data/redirects.json', import.meta.url);
  const { redirects } = JSON.parse(readFileSync(file, 'utf8')) as { redirects: { from: string }[] };
  return new Set(redirects.map((r) => r.from));
};

const BASELINE = new URL('jsonld-baseline.json', import.meta.url);

if (import.meta.main) {
  const [command, dir, archive] = process.argv.slice(2);
  if (dir === undefined || (command !== 'extract' && command !== 'check')) {
    out(
      'usage: jsonld-parity.ts extract <earlier-site-output>\n       jsonld-parity.ts check <dist> [earlier-site-output]',
    );
    process.exit(2);
  }
  if (command === 'extract') {
    const baseline = baselineOf(collect(dir), 'https://surgerywaits.au');
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 1)}\n`);
    out(
      `${String(baseline.nodes.length)} nodes, ${String(baseline.pages.length)} listed pages, ${String(baseline.families.length)} families`,
    );
  } else {
    // With the earlier output at hand, every page's node is compared on its own.
    const baseline =
      archive === undefined
        ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline)
        : baselineOf(collect(archive), 'https://surgerywaits.au', true);
    const report = compare(baseline, collect(dir), redirectSources());
    const line = (n: Node): string => `  ${n.id} ${n.type}`;
    out(
      `missing ${String(report.missing.length)}, retired (address redirects) ${String(report.retired.length)}, added ${String(report.added.length)}`,
    );
    out(report.missing.slice(0, 40).map(line).join('\n'));
    out(report.shortfalls.join('\n'));
    process.exit(report.missing.length + report.shortfalls.length === 0 ? 0 : 1);
  }
}
