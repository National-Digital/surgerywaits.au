import { readContent } from './content-files';

// Stands in for astro:content under Vitest, where Astro's content layer is not populated.
// It serves the same YAML files, so content.ts still parses them through the real schemas.
const COLLECTIONS = new Map([
  ['site.yaml', 'site'],
  ['labels.yaml', 'labels'],
  ['navigation.yaml', 'navigation'],
  ['terms.yaml', 'terms'],
]);

function entries(collection: string): { id: string; data: unknown }[] {
  return readContent().flatMap(({ path, data }) => {
    if (collection === 'pages' && path.startsWith('pages/')) {
      return [{ id: path.slice('pages/'.length).replace(/\.yaml$/, ''), data }];
    }
    return COLLECTIONS.get(path) === collection ? [{ id: collection, data }] : [];
  });
}

export function getEntry(collection: string, id: string): Promise<unknown> {
  return Promise.resolve(entries(collection).find((e) => e.id === id));
}

export function getCollection(collection: string): Promise<unknown[]> {
  return Promise.resolve(entries(collection));
}
