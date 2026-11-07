import data from '../data/redirects.json';

export type RedirectTable = ReadonlyMap<string, string>;

export const redirects: RedirectTable = new Map(data.redirects.map((r) => [r.from, r.to]));

// A path without its trailing slash finds the same entry, so it needs no second hop.
export function redirectFor(
  pathname: string,
  table: RedirectTable = redirects,
): string | undefined {
  return table.get(pathname.endsWith('/') ? pathname : `${pathname}/`);
}
