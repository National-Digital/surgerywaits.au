import data from '../data/redirects.json';

export type RedirectTable = ReadonlyMap<string, string>;

export const redirects: RedirectTable = new Map(data.redirects.map((r) => [r.from, r.to]));

// Unreserved characters carry no meaning as escapes, so %74 and t are the same letter.
const ESCAPE = /%([0-9a-f]{2})/giu;
const UNRESERVED = /^[a-z0-9._~-]$/iu;
const unescape = (text: string): string =>
  text.replace(ESCAPE, (escape, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : escape;
  });

// The key a request path looks up: lowercase, unreserved escapes decoded, a trailing slash.
function lookupKey(pathname: string): string {
  const path = unescape(pathname).toLowerCase();
  return path.endsWith('/') ? path : `${path}/`;
}

// The target comes only from the table, so no request path can name where it leads.
export function redirectFor(
  pathname: string,
  table: RedirectTable = redirects,
): string | undefined {
  return table.get(lookupKey(pathname));
}
