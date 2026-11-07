// Measures what a page sends: its document plus every local file it loads, compressed as served.
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, posix } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parse } from 'parse5';
import { cssUrls, srcsetUrls, walk } from './link-checks.ts';

export interface Budget {
  documentBytes: number;
  pageBytes: number;
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
