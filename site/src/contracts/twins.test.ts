import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it } from 'vitest';

import { handle } from '../../../worker/index';
import { twinPathOf } from '../../../worker/twins';
import { getHomeTemplate } from '../lib/content';
import { addressOf, pageFiles } from '../lib/twins';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

const dist = new URL('../../dist/', import.meta.url);
if (!existsSync(dist)) {
  throw new Error('site/dist is missing: run `npm run build` before BUILT_PAGES=1 npm test');
}
const root = dist.pathname;
const ORIGIN = 'https://surgerywaits.au';
const read = (path: string): string => readFileSync(new URL(`.${path}`, dist), 'utf8');
const files = pageFiles(root);
const twinOf = (file: string): string => twinPathOf(addressOf(file)) ?? '?';

const isElement = (node: Node): node is Element => 'tagName' in node;
const children = (node: Node): Node[] => ('childNodes' in node ? node.childNodes : []);
const find = (node: Node, tag: string): Element | undefined => {
  for (const child of children(node)) {
    if (isElement(child) && child.tagName === tag) {
      return child;
    }
    const inside = find(child, tag);
    if (inside !== undefined) {
      return inside;
    }
  }
  return undefined;
};

// What a reader of the page sees in main: no script, chart drawing or part that needs a browser to show.
const NOT_READ = new Set(['script', 'style', 'svg', 'template', 'noscript']);
interface Seen {
  text: string;
  headings: number;
  links: string[];
}
function seen(node: Node, into: Seen, base: string): Seen {
  if (node.nodeName === '#text' && 'value' in node) {
    into.text += ` ${node.value}`;
  }
  if (isElement(node)) {
    if (
      NOT_READ.has(node.tagName) ||
      node.attrs.some((a) => a.name === 'hidden' || a.name === 'data-twin-skip')
    ) {
      return into;
    }
    if (/^h[1-6]$/u.test(node.tagName)) {
      into.headings += 1;
    }
    const href = node.attrs.find((a) => a.name === 'href')?.value;
    if (node.tagName === 'a' && href !== undefined) {
      into.links.push(new URL(href, base).href);
    }
  }
  for (const child of children(node)) {
    seen(child, into, base);
  }
  return into;
}

// Letters and digits only, so the check reads the words and their order, and not the Markdown marks.
const words = (text: string): string => text.replace(/[^\p{L}\p{N}]+/gu, '');
// A list item starts with its marker, which the page draws with CSS.
const LIST_MARKER = /^ *(?:-|\d+\.) /gmu;
const TABLE_ROW = /^\|.*\|$/u;
const LINK_TARGET = /(?<!\\)\]\(([^)\s]*)\)/gu;

describe('the Markdown twins', () => {
  it('give every page one twin and have no twin without a page', () => {
    const built = readdirSync(dist, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.md'))
      .map((file) => `/${file}`)
      .sort();
    expect(files.length).toBeGreaterThan(100);
    expect(built).toEqual(files.map(twinOf).sort());
  });

  it('carry the home page parts every reader sees and leave out only the scripts-off fallback', () => {
    const t = getHomeTemplate();
    const twin = read('/index.md');
    for (const text of [t.heading, t.lede, t.band_privacy, t.band_details, t.about_heading]) {
      expect(twin, text).toContain(text);
    }
    expect(twin).toContain('](https://surgerywaits.au/compare/)');
    for (const text of [t.band_fallback, t.band_fallback_label]) {
      expect(twin, text).not.toContain(text);
    }
  });

  it('give the page address first and the same words as main, in the same order', () => {
    for (const file of files) {
      const html = read(`/${file}`);
      const document = parse(html);
      const main = find(document, 'main');
      if (main === undefined) {
        throw new Error(`${file} has no main element`);
      }
      const page = seen(main, { text: '', headings: 0, links: [] }, `${ORIGIN}${addressOf(file)}`);
      const twin = read(twinOf(file));

      const canonical = find(document, 'head')
        ?.childNodes.filter(isElement)
        .find((n) => n.tagName === 'link' && n.attrs.some((a) => a.value === 'canonical'))
        ?.attrs.find((a) => a.name === 'href')?.value;
      expect(canonical, file).toBe(`${ORIGIN}${addressOf(file)}`);
      const [first = '', blank = '?', ...rest] = twin.split('\n');
      expect(first, file).toBe(`Canonical URL: <${canonical ?? '?'}>`);
      expect(blank, file).toBe('');

      const body = rest.join('\n');
      expect(words(body.replace(LIST_MARKER, '').replace(LINK_TARGET, ']')), file).toBe(
        words(page.text),
      );
      expect(
        body.split('\n').filter((line) => /^#{1,6} /u.test(line)),
        file,
      ).toHaveLength(page.headings);
      const targets = [...body.matchAll(LINK_TARGET)].map((m) => m[1] ?? '');
      expect(targets, file).toEqual(
        page.links.filter((l) => /^(https?|mailto|tel):/u.test(l)).map((l) => encodeAddress(l)),
      );
      expect(twin.endsWith('\n') && !twin.endsWith('\n\n'), file).toBe(true);
    }
  });

  it('hold tables whose rows all have the same number of cells', () => {
    let tables = 0;
    for (const file of files) {
      const lines = read(twinOf(file)).split('\n');
      let block: string[] = [];
      for (const line of [...lines, '']) {
        if (TABLE_ROW.test(line)) {
          block.push(line);
          continue;
        }
        if (block.length > 0) {
          tables += 1;
          const counts = block.map((row) => row.split(/(?<!\\)\|/u).length - 2);
          expect(new Set(counts).size, `${file}: ${block[0] ?? ''}`).toBe(1);
          block = [];
        }
      }
    }
    expect(tables).toBeGreaterThan(50);
  });

  it('hold no HTML tag and no script', () => {
    for (const file of files) {
      const [, , ...rest] = read(twinOf(file)).split('\n');
      expect(rest.join('\n'), file).not.toMatch(/(?<!\\)<\/?[a-z!]/u);
    }
  });
});

// The twin writes a space or a bracket in an address as a percent escape.
const encodeAddress = (url: string): string =>
  url.replace(/[()\s]/gu, (c) => ({ '(': '%28', ')': '%29' })[c] ?? encodeURIComponent(c));

const env = {
  ASSETS: {
    fetch: (request: Request): Promise<Response> => {
      const { pathname: asked } = new URL(request.url);
      const pathname = asked.endsWith('/') ? `${asked}index.html` : asked;
      return Promise.resolve(
        existsSync(new URL(`.${pathname}`, dist))
          ? new Response(read(pathname), { headers: { 'Content-Type': 'text/plain' } })
          : new Response('missing', { status: 404 }),
      );
    },
  },
} as never;

describe('the Worker and the built twins', () => {
  it('serves each twin at its address and sends its two folder forms there with a 308', async () => {
    for (const file of files) {
      const address = addressOf(file);
      const twin = twinOf(file);
      const direct = await handle(new Request(`${ORIGIN}${twin}`), env);
      expect(direct.status, twin).toBe(200);
      expect(direct.headers.get('Content-Type'), twin).toBe('text/markdown; charset=utf-8');
      expect(direct.headers.get('X-Robots-Tag'), twin).toBeNull();
      expect(direct.headers.get('Link'), twin).toBe(`<${ORIGIN}${address}>; rel="canonical"`);
      for (const form of address === '/'
        ? ['/index.html.md']
        : [`${address}index.md`, `${address}index.html.md`]) {
        const moved = await handle(new Request(`${ORIGIN}${form}`), env);
        expect(moved.status, form).toBe(308);
        expect(moved.headers.get('Location'), form).toBe(`${ORIGIN}${twin}`);
      }
    }
  });

  it('returns the twin at the page address to a request that prefers Markdown, and the page to any other', async () => {
    for (const file of files.filter((_, i) => i % 7 === 0)) {
      const address = addressOf(file);
      const twin = twinOf(file);
      const asked = await handle(
        new Request(`${ORIGIN}${address}`, {
          headers: { Accept: 'text/markdown, text/html;q=0.5' },
        }),
        env,
      );
      expect(asked.status, address).toBe(200);
      expect(await asked.text(), address).toBe(read(twin));
      expect(asked.headers.get('Content-Location'), address).toBe(twin);
      expect(asked.headers.get('Vary'), address).toBe('Accept');
      const page = await handle(new Request(`${ORIGIN}${address}`), env);
      expect(await page.text(), address).toBe(read(`/${file}`));
      expect(page.headers.get('Link'), address).toBe(
        `<${twin}>; rel="alternate"; type="text/markdown"`,
      );
      expect(page.headers.get('Vary'), address).toBe('Accept');
    }
  });
});
