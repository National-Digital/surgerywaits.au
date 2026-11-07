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
// SVG references and the social image metas carry an address in an attribute no other element uses.
const SVG_REF_TAGS = new Set(['use', 'image']);
const META_IMAGE = new Set(['og:image', 'twitter:image']);
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
    if (SVG_REF_TAGS.has(el.tagName)) {
      for (const a of ['href', 'xlink:href']) {
        const v = attr(a);
        if (v !== undefined) {
          urls.push(v.trim());
        }
      }
    }
    if (el.tagName === 'meta') {
      const key = attr('property') ?? attr('name');
      const content = attr('content');
      if (key !== undefined && META_IMAGE.has(key) && content !== undefined) {
        urls.push(content.trim());
      }
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

// Every url(...) reference in a stylesheet, other than data: URIs and fragments inside the sheet.
export function cssUrls(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi)) {
    const u = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (u !== '' && !u.startsWith('#')) {
      out.push(u);
    }
  }
  return out;
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
  redirects: Map<string, string>,
): Promise<Report> {
  const files = await fileSet(dist);
  const pages = await htmlFiles(dist);
  const scanned = new Map<string, Page>();
  for (const file of pages) {
    scanned.set(`/${file}`, scan(await readFile(join(dist, file), 'utf8')));
  }
  // A stylesheet's addresses are relative to the stylesheet, so each one is checked from its own path.
  const sheets = new Map<string, string[]>();
  for (const f of files) {
    if (f.endsWith('.css')) {
      sheets.set(f, cssUrls(await readFile(join(dist, f), 'utf8')));
    }
  }
  const host = new URL(origin).host;
  const report: Report = { pages: pages.length, internal: 0, problems: [], external: new Map() };
  const bad = (page: string, url: string, why: string): void => {
    report.problems.push({ page, url, why });
  };

  const sources: [string, string[]][] = [
    ...[...scanned].map(([file, { urls }]): [string, string[]] => [pagePath(file.slice(1)), urls]),
    ...sheets,
  ];
  const builtPage = (path: string): boolean =>
    files.has(path.endsWith('/') ? `${path}index.html` : path);
  for (const [here, urls] of sources) {
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
      const redirect = redirects.get(path);
      if (redirect !== undefined) {
        if (!builtPage(redirect)) {
          bad(here, raw, `is a redirect to ${redirect}, which is not a built page`);
        }
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
