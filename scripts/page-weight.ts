// Measures what a page sends: its document plus every local file it loads, compressed as served.
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, posix } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parse } from 'parse5';
import { cssUrls, srcsetUrls, walk } from './link-checks.ts';

export interface Budget {
  documentBytes: number;
  pageBytes: number;
  scriptBytes: number;
}
export interface PageWeight {
  page: string;
  documentBytes: number;
  pageBytes: number;
}

// Text compresses on the wire; fonts and images already are, so they count as they sit on disk.
const TEXT = new Set(['.html', '.css', '.js', '.mjs', '.svg', '.json', '.txt', '.xml']);
const LOADED_LINK = /\b(stylesheet|icon|preload|modulepreload|apple-touch-icon)\b/i;
const LOADED_ATTRS: Record<string, string[]> = {
  link: ['href'],
  script: ['src'],
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  audio: ['src'],
  iframe: ['src'],
  embed: ['src'],
  object: ['data'],
};

// The earlier site's tool weighed 44.9 KB, and the script budget may never rise past it.
export const CEILING_BYTES = 44_900;

const size = (name: string, bytes: Buffer): number =>
  TEXT.has(extname(name)) ? gzipSync(bytes, { level: 9 }).length : bytes.length;

function loaded(html: string): string[] {
  const urls: string[] = [];
  walk(parse(html, { scriptingEnabled: false }), (el) => {
    const attr = (n: string): string | undefined => el.attrs.find((a) => a.name === n)?.value;
    if (el.tagName === 'link' && !LOADED_LINK.test(attr('rel') ?? '')) {
      return;
    }
    for (const a of LOADED_ATTRS[el.tagName] ?? []) {
      const v = attr(a);
      if (v !== undefined) {
        urls.push(...(a.endsWith('srcset') ? srcsetUrls(v) : [v.trim()]));
      }
    }
  });
  return urls;
}

// An internal address as a path under the dist, or null for an external or inline one.
function local(url: string, from: string): string | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
    return null;
  }
  const path = url.split(/[?#]/)[0] ?? '';
  return path === '' ? null : posix.resolve(posix.dirname(from), path).slice(1);
}

async function read(dist: string, rel: string): Promise<Buffer | null> {
  try {
    return await readFile(join(dist, rel));
  } catch {
    return null;
  }
}

export async function measurePages(dist: string): Promise<PageWeight[]> {
  const files = (await readdir(dist, { recursive: true }))
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.split('\\').join('/'))
    .sort();
  const sheets = new Map<string, number>();
  const sheetWeight = async (rel: string): Promise<number> => {
    const cached = sheets.get(rel);
    if (cached !== undefined) {
      return cached;
    }
    const bytes = await read(dist, rel);
    let total = bytes === null ? 0 : size(rel, bytes);
    if (bytes !== null && rel.endsWith('.css')) {
      for (const u of new Set(cssUrls(bytes.toString('utf8')))) {
        const inner = local(u, `/${rel}`);
        const innerBytes = inner === null ? null : await read(dist, inner);
        total += innerBytes === null || inner === null ? 0 : size(inner, innerBytes);
      }
    }
    sheets.set(rel, total);
    return total;
  };
  const weights: PageWeight[] = [];
  for (const file of files) {
    const html = (await read(dist, file)) ?? Buffer.alloc(0);
    const documentBytes = size(file, html);
    let pageBytes = documentBytes;
    for (const rel of new Set(loaded(html.toString('utf8')).map((u) => local(u, `/${file}`)))) {
      pageBytes += rel === null ? 0 : await sheetWeight(rel);
    }
    weights.push({ page: `/${file}`.replace(/index\.html$/, ''), documentBytes, pageBytes });
  }
  return weights;
}

export function overBudget(weights: PageWeight[], budget: Budget): string[] {
  return weights.flatMap((w) => [
    ...(w.documentBytes > budget.documentBytes
      ? [
          `${w.page} document ${String(w.documentBytes)} B, budget ${String(budget.documentBytes)} B`,
        ]
      : []),
    ...(w.pageBytes > budget.pageBytes
      ? [`${w.page} page ${String(w.pageBytes)} B, budget ${String(budget.pageBytes)} B`]
      : []),
  ]);
}

// A module's static imports and re-exports, never a dynamic import.
const STATIC_IMPORT = /\b(?:import|export)\s*(?:[^'"();]*?\bfrom\s*)?(["'])([^"']+)\1/g;

// The local file a built page loads as its first script with a source, or null when it loads none.
async function scriptOf(dist: string, page: string): Promise<string | null> {
  const html = await readFile(join(dist, page, 'index.html'), 'utf8');
  let src: string | undefined;
  walk(parse(html, { scriptingEnabled: false }), (el) => {
    src ??= el.tagName === 'script' ? el.attrs.find((a) => a.name === 'src')?.value : undefined;
  });
  return src === undefined ? null : local(src, `/${page}/index.html`);
}

// The home page runs the same search, so it must load the very file the compare page does.
export async function homeScriptProblems(dist: string): Promise<string[]> {
  const home = await scriptOf(dist, '').catch(() => undefined);
  if (home === undefined) {
    return ['the build has no home page at its root'];
  }
  const compare = await scriptOf(dist, 'compare');
  if (home === null || compare === null) {
    return [
      `the home page loads ${home ?? 'no script'} and the compare page loads ${compare ?? 'no script'}`,
    ];
  }
  return home === compare
    ? []
    : [`the home page loads ${home} and the compare page loads ${compare}`];
}

// The compare page's module script and the local chunks it imports, as they sit in the dist, with
// the JSON it fetches later left out. The home page loads the same file, which homeScriptProblems checks.
export async function scriptWeight(dist: string): Promise<{ file: string; bytes: number }> {
  const file = await scriptOf(dist, 'compare');
  if (file === null) {
    throw new Error('the compare page loads no local script');
  }
  const seen = new Set<string>();
  let bytes = 0;
  const pending = [file];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    const source = await readFile(join(dist, next));
    bytes += source.byteLength;
    for (const match of source.toString('utf8').matchAll(STATIC_IMPORT)) {
      const inner = local(match[2] ?? '', `/${next}`);
      if (inner !== null) {
        pending.push(inner);
      }
    }
  }
  return { file: `/${file}`, bytes };
}

export function overScript(bytes: number, budget: Budget): string[] {
  if (budget.scriptBytes > CEILING_BYTES) {
    return [
      `the script budget of ${String(budget.scriptBytes)} B is above the ${String(CEILING_BYTES)} B ceiling`,
    ];
  }
  return bytes > budget.scriptBytes
    ? [`the tool script is ${String(bytes)} B, budget ${String(budget.scriptBytes)} B`]
    : [];
}
