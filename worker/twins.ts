// A Markdown twin of each page sits beside it as a file: /x/ has /x.md, and / has /index.md.
export const TWIN_TYPE = 'text/markdown; charset=utf-8';
export const TWIN_EXTENSION = '.md';
export const TWIN_REDIRECT_STATUS = 308;
const HOME_TWIN = '/index.md';
const CANONICAL_ORIGIN = 'https://surgerywaits.au';

// A pathname is set on a copy of the URL, so a leading double slash is never read as a host.
export function withPathname(base: URL | string, pathname: string): URL {
  const url = new URL(base);
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url;
}

// The canonical address of the page that a twin stands for, on the production origin.
export function canonicalOfTwin(twin: string): string {
  const page = twin === HOME_TWIN ? '/' : `${twin.slice(0, -TWIN_EXTENSION.length)}/`;
  return withPathname(CANONICAL_ORIGIN, page).href;
}

// The twin of a page address, or nothing when the path is not a page address or holds an empty segment.
export function twinPathOf(pathname: string): string | undefined {
  if (!pathname.endsWith('/') || pathname.includes('//')) {
    return undefined;
  }
  return pathname === '/' ? HOME_TWIN : `${pathname.slice(0, -1)}${TWIN_EXTENSION}`;
}

export const isTwinPath = (pathname: string): boolean => pathname.endsWith(TWIN_EXTENSION);

// The twin keeps one address, so the folder forms of it lead there.
const FOLDER_FORM = /^(\/.+)\/index(?:\.html)?\.md$/u;
export function twinAddressFor(pathname: string): string | undefined {
  if (pathname.includes('//')) {
    return undefined;
  }
  if (pathname === '/index.html.md') {
    return HOME_TWIN;
  }
  const folder = FOLDER_FORM.exec(pathname)?.[1];
  return folder === undefined ? undefined : `${folder}${TWIN_EXTENSION}`;
}

interface Range {
  type: string;
  q: number;
  order: number;
}

function ranges(accept: string): Range[] {
  return accept.split(',').flatMap((part, order) => {
    const [type = '', ...params] = part.split(';').map((p) => p.trim().toLowerCase());
    if (!/^[a-z*]+\/[a-z0-9*.+-]+$/u.test(type)) {
      return [];
    }
    const weight = params.find((p) => p.startsWith('q='))?.slice(2) ?? '1';
    const q = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(weight) ? Number(weight) : 0;
    return [{ type, q, order }];
  });
}

// The range that names the type most closely decides its weight.
function weightOf(list: readonly Range[], type: string): { q: number; order: number } {
  const [group = ''] = type.split('/');
  const best =
    list.find((r) => r.type === type) ??
    list.find((r) => r.type === `${group}/*`) ??
    list.find((r) => r.type === '*/*');
  return { q: best?.q ?? 0, order: best?.type === type ? best.order : Number.POSITIVE_INFINITY };
}

// Markdown wins on a higher weight, or on an equal weight when the request names it before HTML.
export function prefersMarkdown(accept: string | null): boolean {
  if (accept === null) {
    return false;
  }
  const list = ranges(accept);
  const markdown = weightOf(list, 'text/markdown');
  const html = weightOf(list, 'text/html');
  if (markdown.q === 0) {
    return false;
  }
  return markdown.q > html.q || (markdown.q === html.q && markdown.order < html.order);
}
