// Page files give the routes, so a link to a page that is not built yet is left out.
const files = import.meta.glob('../pages/**/*.astro');

export interface NavLink {
  label: string;
  href: string;
}

export function routesOf(paths: string[]): Set<string> {
  return new Set(
    paths
      .map((p) => p.replace(/^\.\.\/pages\//, '').replace(/\.astro$/, ''))
      .filter((p) => !p.includes('[') && p !== '404')
      .map((p) => `/${p.replace(/(?:^|\/)index$/, '')}/`.replace('//', '/')),
  );
}

export function existing(links: NavLink[], routes: Set<string>): NavLink[] {
  return links.filter(({ href }) => routes.has(href));
}

const built = routesOf(Object.keys(files));

export const builtLinks = (links: NavLink[]): NavLink[] => existing(links, built);
export const isBuilt = (href: string): boolean => built.has(href);
