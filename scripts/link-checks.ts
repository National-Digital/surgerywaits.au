// Finds every internal link, asset and fragment on built pages and says which ones do not resolve.
import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

interface Problem {
  page: string;
  url: string;
  why: string;
}
export interface Report {
  pages: number;
  internal: number;
  problems: Problem[];
  // Each external address with the number of pages that carry it. These are never fetched.
  external: Map<string, number>;
}

const URL_ATTRS: Record<string, string[]> = {
  a: ['href'],
  area: ['href'],
  link: ['href', 'imagesrcset'],
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  script: ['src'],
  iframe: ['src'],
  audio: ['src'],
  video: ['src', 'poster'],
  track: ['src'],
  embed: ['src'],
  object: ['data'],
  form: ['action'],
};
const OPAQUE = /^(mailto|tel|sms|data|javascript|blob):/i;

function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter((u) => u !== '');
}

function walk(node: Node, visit: (el: Element) => void): void {
  if ('tagName' in node) {
    visit(node);
  }
  const children = 'content' in node ? [node.content] : 'childNodes' in node ? node.childNodes : [];
  for (const c of children) {
    walk(c, visit);
  }
}

interface Page {
  urls: string[];
  ids: Set<string>;
}

export function scan(html: string): Page {
  const urls: string[] = [];
  const ids = new Set<string>();
  walk(parse(html), (el) => {
    const attr = (name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;
    const id = attr('id');
    if (id !== undefined) {
      ids.add(id);
    }
    // An anchor's name is a target too, as the HTML standard says.
    const name = attr('name');
    if (el.tagName === 'a' && name !== undefined) {
      ids.add(name);
    }
    for (const a of URL_ATTRS[el.tagName] ?? []) {
      const v = attr(a);
      if (v === undefined) {
        continue;
      }
      urls.push(...(a.endsWith('srcset') ? srcsetUrls(v) : [v.trim()]));
    }
  });
  return { urls, ids };
}

async function htmlFiles(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, base), { withFileTypes: true })) {
    const rel = posix.join(base, e.name);
    if (e.isDirectory()) {
      out.push(...(await htmlFiles(dir, rel)));
    } else if (e.name.endsWith('.html')) {
      out.push(rel);
    }
  }
  return out;
}

async function fileSet(dir: string, base = ''): Promise<Set<string>> {
  const out = new Set<string>();
  for (const e of await readdir(join(dir, base), { withFileTypes: true })) {
    const rel = posix.join(base, e.name);
    if (e.isDirectory()) {
      for (const f of await fileSet(dir, rel)) {
        out.add(f);
      }
    } else {
      out.add(`/${rel}`);
    }
  }
  return out;
}

const pagePath = (file: string): string => `/${file}`.replace(/index\.html$/, '');

export async function checkLinks(
  dist: string,
  origin: string,
  redirects: Set<string>,
): Promise<Report> {
  const files = await fileSet(dist);
  const pages = await htmlFiles(dist);
  const scanned = new Map<string, Page>();
  for (const file of pages) {
    scanned.set(`/${file}`, scan(await readFile(join(dist, file), 'utf8')));
  }
  const host = new URL(origin).host;
  const report: Report = { pages: pages.length, internal: 0, problems: [], external: new Map() };
  const bad = (page: string, url: string, why: string): void => {
    report.problems.push({ page, url, why });
  };

  for (const [file, { urls }] of scanned) {
    const here = pagePath(file.slice(1));
    for (const raw of urls) {
      if (raw === '' || OPAQUE.test(raw)) {
        continue;
      }
      let url: URL;
      try {
        url = new URL(raw, new URL(here, origin));
      } catch {
        bad(here, raw, 'is not a valid address');
        continue;
      }
      if (url.host !== host) {
        if (url.protocol !== 'https:') {
          bad(here, raw, 'is an external address that is not https');
        } else {
          report.external.set(raw, (report.external.get(raw) ?? 0) + 1);
        }
        continue;
      }
      if (url.protocol !== 'https:') {
        bad(here, raw, 'links to this site over http');
        continue;
      }
      report.internal++;
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        bad(here, raw, 'has a malformed percent escape');
        continue;
      }
      if (redirects.has(path)) {
        continue;
      }
      const target = path.endsWith('/') ? `${path}index.html` : path;
      if (!files.has(target)) {
        bad(here, raw, 'does not resolve to a built file or a redirect');
        continue;
      }
      // An empty fragment and #top always resolve, as the HTML standard says.
      const frag = decodeURIComponent(url.hash.slice(1));
      if (frag === '' || frag === 'top') {
        continue;
      }
      const targetPage = scanned.get(target);
      if (targetPage && !targetPage.ids.has(frag)) {
        bad(here, raw, `has no element with id "${frag}" on the target page`);
      }
    }
  }
  return report;
}
