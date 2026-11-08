import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

const isElement = (node: Node): node is Element => 'tagName' in node;
const attr = (el: Element, name: string): string | undefined =>
  el.attrs.find((a) => a.name === name)?.value;
const childrenOf = (node: Node): Node[] => ('childNodes' in node ? node.childNodes : []);
const elementsIn = (node: Node, ...tags: string[]): Element[] =>
  childrenOf(node).filter((c): c is Element => isElement(c) && tags.includes(c.tagName));

// Charts are drawn in SVG and their figures sit in the table beside them; scripts and hidden parts need a browser.
const SKIPPED = new Set(['script', 'style', 'svg', 'template', 'noscript']);
const skipped = (el: Element): boolean =>
  SKIPPED.has(el.tagName) || attr(el, 'hidden') !== undefined;

const BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'caption',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'ul',
]);

interface Piece {
  md: string;
  raw: string;
  element: boolean;
}

const BREAK = ' ';
const CLOSES = /^[.,;:!?)\]}'’”]/u;
const OPENS = /[([{“‘/-]$/u;
const ESCAPED = /[\\`*_[\]<>|]/gu;
// A named or numbered character reference in the text would read as the character it names.
const REFERENCE = /&(?=[#\w]+;)/gu;
const escape = (text: string): string =>
  text.replace(ESCAPED, (c) => `\\${c}`).replace(REFERENCE, '\\&');
// Code marks its pipes with this until the line knows whether it sits in a table cell.
const PIPE = '\uE000';

// A fence one backtick longer than any run in the text, so the text cannot close it.
function fenceFor(text: string, least: number): string {
  const longest = Math.max(0, ...(text.match(/`+/gu) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(least, longest + 1));
}
function codeSpan(text: string): string {
  const fence = fenceFor(text, 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text.replaceAll('|', PIPE)}${pad}${fence}`;
}

// Elements that touch with no space between them are separate words, as the page's styles show.
function join(pieces: readonly Piece[]): Piece {
  let md = '';
  let raw = '';
  let last: Piece | undefined;
  for (const piece of pieces) {
    if (piece.raw === '' && piece.md === '') {
      continue;
    }
    const gap =
      last !== undefined &&
      (last.element || piece.element) &&
      /\S$/u.test(last.raw) &&
      /^\S/u.test(piece.raw) &&
      !CLOSES.test(piece.raw) &&
      !OPENS.test(last.raw);
    md += `${gap ? ' ' : ''}${piece.md}`;
    raw += `${gap ? ' ' : ''}${piece.raw}`;
    last = piece;
  }
  return { md, raw, element: pieces.some((p) => p.element) };
}

function wrap(inner: Piece, mark: string): Piece {
  const core = inner.md.trim();
  if (core === '') {
    return inner;
  }
  const lead = inner.md.slice(0, inner.md.length - inner.md.trimStart().length);
  const trail = inner.md.slice(inner.md.trimEnd().length);
  return { ...inner, md: `${lead}${mark}${core}${mark}${trail}` };
}

function inline(node: Node, origin: URL): Piece {
  if (node.nodeName === '#text' && 'value' in node) {
    const text = node.value.replaceAll(PIPE, '').replace(/\s+/gu, ' ');
    return { md: escape(text), raw: text, element: false };
  }
  if (!isElement(node) || skipped(node)) {
    return { md: '', raw: '', element: false };
  }
  if (node.tagName === 'br') {
    return { md: BREAK, raw: ' ', element: true };
  }
  const inner = join(childrenOf(node).map((c) => inline(c, origin)));
  const apart = BLOCKS.has(node.tagName) ? ' ' : '';
  const out: Piece = {
    md: `${apart}${inner.md}${apart}`,
    raw: `${apart}${inner.raw}${apart}`,
    element: true,
  };
  switch (node.tagName) {
    case 'strong':
    case 'b':
      return { ...wrap(out, '**'), raw: out.raw };
    case 'em':
    case 'i':
      return { ...wrap(out, '*'), raw: out.raw };
    case 'code':
      return out.raw.trim() === ''
        ? out
        : { md: codeSpan(out.raw.trim()), raw: out.raw, element: true };
    case 'a': {
      const href = link(attr(node, 'href'), origin);
      const label = out.md.trim();
      if (href === undefined || label === '') {
        return out;
      }
      const lead = out.md.slice(0, out.md.length - out.md.trimStart().length);
      const trail = out.md.slice(out.md.trimEnd().length);
      return { ...out, md: `${lead}[${label}](${href})${trail}` };
    }
    default:
      return out;
  }
}

// encodeURIComponent leaves brackets as they are, and a bracket in an address would end the link.
const PERCENT: Record<string, string> = { '(': '%28', ')': '%29' };

// A link names its target in full, so a twin read on its own still leads to the right page.
function link(href: string | undefined, origin: URL): string | undefined {
  if (href === undefined || href.trim() === '') {
    return undefined;
  }
  const target = new URL(href, origin);
  return ['http:', 'https:', 'mailto:', 'tel:'].includes(target.protocol)
    ? target.href.replace(/[()\s]/gu, (c) => PERCENT[c] ?? encodeURIComponent(c))
    : undefined;
}

// A line that would start a heading, list or quote in Markdown is escaped so it stays a sentence.
const LEADING = /^(#{1,6}(?=\s)|[-+](?=\s)|~{3,}|(?:={3,}|-{3,})$)/gmu;

function paragraph(nodes: readonly Node[], origin: URL, cell = false): string {
  const text = join(nodes.map((n) => inline(n, origin)))
    .md.replace(/[ \t\n]+/gu, ' ')
    .replace(new RegExp(` *${BREAK} *`, 'gu'), '  \n')
    .trim();
  return text
    .replace(LEADING, (lead) => `\\${lead}`)
    .replace(/^(\d+)([.)])(?=\s)/gmu, '$1\\$2')
    .replaceAll(PIPE, cell ? '\\|' : '|');
}

function cells(row: Element, origin: URL): string[] {
  return elementsIn(row, 'td', 'th').flatMap((cell) => {
    const span = Number(attr(cell, 'colspan') ?? '1');
    const text = paragraph(childrenOf(cell), origin, true).replace(/\s*\n\s*/gu, ' ');
    return [text, ...Array.from<string>({ length: Math.max(span, 1) - 1 }).fill('')];
  });
}

function table(el: Element, origin: URL): string[] {
  const caption = elementsIn(el, 'caption')[0];
  const sections = elementsIn(el, 'thead', 'tbody', 'tfoot');
  const head = sections.filter((s) => s.tagName === 'thead').flatMap((s) => elementsIn(s, 'tr'));
  const bodyRows = [
    ...elementsIn(el, 'tr'),
    ...sections.filter((s) => s.tagName !== 'thead').flatMap((s) => elementsIn(s, 'tr')),
  ];
  // Without a thead, a first row of only th cells is the header.
  const firstCells = bodyRows[0] === undefined ? [] : elementsIn(bodyRows[0], 'td', 'th');
  const headerFirst =
    head.length === 0 && firstCells.length > 0 && firstCells.every((c) => c.tagName === 'th');
  const headRows = headerFirst && bodyRows[0] !== undefined ? [bodyRows[0]] : head;
  const rows = (headerFirst ? bodyRows.slice(1) : bodyRows).map((row) => cells(row, origin));
  const header = headRows.map((row) => cells(row, origin));
  const all = [...header, ...rows];
  const width = Math.max(0, ...all.map((row) => row.length));
  const line = (row: readonly string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
  const out: string[] = [];
  if (caption !== undefined) {
    const text = paragraph(childrenOf(caption), origin);
    if (text !== '') {
      out.push(`**${text}**`);
    }
  }
  if (width === 0) {
    return out;
  }
  const first = header[0] ?? Array.from<string>({ length: width }).fill('');
  const body = header.length > 0 ? [...header.slice(1), ...rows] : all;
  out.push(
    [line(first), line(Array.from<string>({ length: width }).fill('---')), ...body.map(line)].join(
      '\n',
    ),
  );
  return out;
}

const indent = (text: string, pad: string): string =>
  text
    .split('\n')
    .map((line, i) => (i === 0 || line === '' ? line : `${pad}${line}`))
    .join('\n');

function list(el: Element, origin: URL): string[] {
  const ordered = el.tagName === 'ol';
  const start = Number(attr(el, 'start') ?? '1');
  const items = elementsIn(el, 'li').map((li, i) => {
    const marker = ordered ? `${String(start + i)}. ` : '- ';
    const body = flow(childrenOf(li), origin).join('\n\n');
    return `${marker}${indent(body, ' '.repeat(marker.length))}`;
  });
  return items.length === 0 ? [] : [items.join('\n')];
}

function block(el: Element, origin: URL): string[] {
  const tag = el.tagName;
  if (skipped(el)) {
    return [];
  }
  if (/^h[1-6]$/u.test(tag)) {
    const text = paragraph(childrenOf(el), origin).replace(/\s*\n\s*/gu, ' ');
    return text === '' ? [] : [`${'#'.repeat(Number(tag.slice(1)))} ${text}`];
  }
  switch (tag) {
    case 'table':
      return table(el, origin);
    case 'ul':
    case 'ol':
      return list(el, origin);
    case 'hr':
      return ['---'];
    case 'pre': {
      const text = childrenOf(el)
        .map((c) => rawText(c))
        .join('')
        .replace(/\n$/u, '');
      const fence = fenceFor(text, 3);
      return text === '' ? [] : [`${fence}\n${text}\n${fence}`];
    }
    case 'blockquote':
      return flow(childrenOf(el), origin).map((b) =>
        b
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
      );
    case 'dt': {
      const text = paragraph(childrenOf(el), origin);
      return text === '' ? [] : [`**${text}**`];
    }
    case 'p':
    case 'summary':
    case 'figcaption':
    case 'caption': {
      const text = paragraph(childrenOf(el), origin);
      return text === '' ? [] : [text];
    }
    default:
      return flow(childrenOf(el), origin);
  }
}

function rawText(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) {
    return node.value;
  }
  return isElement(node) && !skipped(node) ? childrenOf(node).map(rawText).join('') : '';
}

// Inline content between blocks makes a paragraph of its own.
function flow(nodes: readonly Node[], origin: URL): string[] {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = (): void => {
    const text = paragraph(run, origin);
    if (text !== '') {
      out.push(text);
    }
    run = [];
  };
  for (const node of nodes) {
    if (isElement(node) && BLOCKS.has(node.tagName)) {
      flush();
      out.push(...block(node, origin));
    } else {
      run.push(node);
    }
  }
  flush();
  return out;
}

function find(node: Node, tag: string): Element | undefined {
  for (const child of childrenOf(node)) {
    if (isElement(child)) {
      if (child.tagName === tag) {
        return child;
      }
      const inside = find(child, tag);
      if (inside !== undefined) {
        return inside;
      }
    }
  }
  return undefined;
}

// The address the page names for itself, or the one it is served at.
function canonicalOf(document: Node, page: URL): string {
  const head = find(document, 'head');
  const link =
    head === undefined
      ? undefined
      : elementsIn(head, 'link').find((l) => attr(l, 'rel') === 'canonical');
  const href = link === undefined ? undefined : attr(link, 'href');
  return new URL(href ?? page.href, page).href;
}

// The twin of a page: its canonical address, then the content of its main element as Markdown.
export function markdownTwin(html: string, page: URL): string {
  const document = parse(html);
  const main = find(document, 'main');
  if (main === undefined) {
    throw new Error(`${page.pathname} has no main element`);
  }
  const body = flow(childrenOf(main), page).join('\n\n');
  return `Canonical URL: <${canonicalOf(document, page)}>\n\n${body}\n`;
}
