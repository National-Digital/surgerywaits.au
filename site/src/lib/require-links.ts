// A header with no link would leave a dead end, so the build stops instead.
export function requireLinks<T>(links: T[]): T[] {
  if (links.length === 0) {
    throw new Error('The site navigation has no built page to link to');
  }
  return links;
}
