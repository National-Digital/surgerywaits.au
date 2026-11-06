import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeHTML } from 'entities';
import { parse as parseHtml } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { parse } from 'yaml';

const contentDir = new URL('../../content/', import.meta.url).pathname;

export interface ContentFile {
  path: string;
  raw: string;
  data: unknown;
}

export function readContent(): ContentFile[] {
  return readdirSync(contentDir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((path) => {
      const raw = readFileSync(join(contentDir, path), 'utf8');
      return { path, raw, data: parse(raw) as unknown };
    });
}

// Every string value in a content tree, which is all the text a person can read.
export function strings(node: unknown): string[] {
  if (typeof node === 'string') {
    return [node];
  }
  if (Array.isArray(node)) {
    return node.flatMap(strings);
  }
  if (typeof node === 'object' && node !== null) {
    return Object.values(node).flatMap(strings);
  }
  return [];
}

// A term matches as whole words, and its spaces match any run of whitespace.
function termPattern(term: string): RegExp {
  const escaped = term
    .replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`)
    .replaceAll(' ', String.raw`\s+`);
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
}

// Whitespace entities decode to non-breaking and other spaces, which \s matches.
export const entityPattern = /\b(?:ACN|ABN)\b|\bPty\.?\s*Ltd\b/i;

export function decode(text: string): string {
  return decodeHTML(text).replaceAll(/\s+/g, ' ');
}

export function contentSlug(path: string): string {
  return path.replace(/^pages\//, '').replace(/\.yaml$/, '');
}

export function distSlug(path: string): string {
  const slug = path.replace(/(?:^|\/)index\.html$/, '').replace(/\.html$/, '');
  return slug === '' ? 'home' : slug;
}

interface Terms {
  terms: { preferred: string; replaces: string[] }[];
  quotes: { page: string; term: string }[];
}

// A quote entry in terms.yaml excuses one replaced term on one page.
export function replacedTerms(slug: string, texts: string[], { terms, quotes }: Terms): string[] {
  const excused = new Set(quotes.filter((q) => q.page === slug).map((q) => q.term));
  const decoded = texts.map(decode);
  return terms
    .flatMap((t) => t.replaces.map((term) => ({ term, preferred: t.preferred })))
    .filter(({ term }) => !excused.has(term) && decoded.some((t) => termPattern(term).test(t)))
    .map(({ term, preferred }) => `${slug}: "${term}" should be "${preferred}"`);
}

// Text nodes and attribute values, as a parser reads them, so entities arrive decoded.
function isPassport(node: DefaultTreeAdapterTypes.Element): boolean {
  const attr = (name: string): string | undefined => node.attrs.find((a) => a.name === name)?.value;
  return (
    node.tagName === 'section' &&
    attr('class') === 'c-passport' &&
    attr('aria-labelledby') === 'passport-heading'
  );
}

// The data passport quotes source titles verbatim, so `skipPassport` drops that one section.
export function pageStrings(html: string, skipPassport = false): string[] {
  const out: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ('tagName' in node) {
      if (node.tagName === 'script' || node.tagName === 'style') {
        return;
      }
      if (skipPassport && isPassport(node)) {
        return;
      }
      out.push(
        ...node.attrs.filter((a) => a.name !== 'href' && a.name !== 'src').map((a) => a.value),
      );
    }
    if (node.nodeName === '#text') {
      out.push((node as DefaultTreeAdapterTypes.TextNode).value);
    }
    const children = 'childNodes' in node ? node.childNodes : [];
    const inner = 'content' in node ? node.content.childNodes : [];
    [...children, ...inner].forEach(visit);
  };
  visit(parseHtml(html));
  return out.map((t) => t.replaceAll(/\s+/g, ' ')).filter((t) => t.trim() !== '');
}
